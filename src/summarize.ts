// Origin: forked from the Mai Group's predecessor memory server (private).
import { getPool, getProjectId } from "./db.js";
import type { ParsedSession } from "./ingest.js";
import { getLLMProvider, type JSONSchema, type LLMProvider } from "./llm/provider.js";

/**
 * LLM session summarizer + decision extractor.
 *
 * Provider-agnostic: the model call goes through LLMProvider (anthropic / openai /
 * openai-compatible), selected by env — see src/llm/provider.ts. Enabled only when
 * MAI_LLM_SUMMARY=1 AND a provider resolves; otherwise these functions no-op
 * (null / []) so a missing key never breaks ingest.
 */
export function llmSummaryEnabled(): boolean {
  return getLLMProvider() !== null;
}

/** Trim to `max` items keeping head AND tail — truncation must never silently
 * drop the tail again (the root cause plan 12 exists to fix). */
export function middleTrim<T>(arr: T[], max: number): T[] {
  if (arr.length <= max) return arr;
  const head = Math.ceil(max / 2);
  return [...arr.slice(0, head), ...arr.slice(arr.length - (max - head))];
}

const SUMMARY_SCHEMA: JSONSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['summary', 'objectives', 'outcomes'],
  properties: {
    summary: { type: 'string' },
    objectives: { type: 'array', items: { type: 'string' } },
    outcomes: { type: 'array', items: { type: 'string' } },
  },
};

const DECISIONS_SCHEMA: JSONSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['decisions'],
  properties: {
    decisions: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['description', 'reasoning', 'type', 'keywords', 'confidence', 'files_affected'],
        properties: {
          description: { type: 'string' },
          reasoning: { type: 'string' },
          type: { type: 'string' },
          keywords: { type: 'array', items: { type: 'string' } },
          confidence: { type: 'number' },
          files_affected: { type: 'array', items: { type: 'string' } },
        },
      },
    },
  },
};

// ---------- Session-level summary ----------

export interface SessionSummary {
  summary: string;
  objectives: string[];
  outcomes: string[];
}

export async function summarizeSession(args: { parsed: ParsedSession; provider?: LLMProvider }): Promise<SessionSummary | null> {
  const provider = args.provider ?? getLLMProvider();
  if (!provider) return null;

  const p = args.parsed;
  const commits = p.commits.map((c) => ({ hash: c.hash, message: c.message }));
  const fileEventsSample = p.fileEvents.map((f) => ({ action: f.action, filePath: f.filePath }));
  const bashSample = p.bashEvents.map((b) => b.command);
  const thinkingSample = p.thinkingBlocks.map((t) => t.text);

  const parts: string[] = [
    `You are summarizing a Claude Code development session for the project's code brain (code memory).`,
    ``,
    `Session ${p.sessionId ?? "unknown"}`,
    `Scale: ${p.messageCount} msgs, ${p.toolCalls} tool calls, ${commits.length} commits.`,
    ``,
  ];

  // Caps cover a FULL segment (spec §3.5) — a segment is at most one summarizer
  // window of work, so nothing is sampled away any more.
  if (commits.length > 0) {
    parts.push(`Commits:`);
    for (const c of commits.slice(0, 100)) parts.push(`- ${c.hash}: ${c.message}`);
    parts.push("");
  }
  if (fileEventsSample.length > 0) {
    const set = new Set<string>();
    for (const f of fileEventsSample) {
      set.add(`${f.action} ${f.filePath}`);
      if (set.size >= 100) break;
    }
    parts.push(`File events (sample):`);
    for (const s of set) parts.push(`- ${s}`);
    parts.push("");
  }
  if (bashSample.length > 0) {
    parts.push(`Bash commands (sample):`);
    for (const b of bashSample.slice(0, 60)) parts.push(`- ${b.slice(0, 200)}`);
    parts.push("");
  }
  if (thinkingSample.length > 0) {
    parts.push(`Assistant reasoning (sample):`);
    for (const t of middleTrim(thinkingSample, 150)) parts.push(`- ${t.slice(0, 400)}`);
    parts.push("");
  }

  parts.push(
    `Return STRICT JSON (no prose outside the JSON):`,
    `{`,
    `  "summary": "one or two sentences",`,
    `  "objectives": ["...", "..."],`,
    `  "outcomes": ["...", "..."]`,
    `}`,
    ``,
    `3-5 objectives, 3-5 outcomes, each 6-20 words, concrete nouns + verbs.`
  );

  const result = await provider.completeJSON({
    prompt: parts.join("\n"),
    schema: SUMMARY_SCHEMA,
    schemaName: "session_summary",
    maxTokens: 1024,
  });
  if (!result || typeof result !== "object") return null;
  const parsed = result as Record<string, unknown>;

  return {
    summary: String(parsed.summary ?? "").trim(),
    objectives: Array.isArray(parsed.objectives)
      ? parsed.objectives.map((s: unknown) => String(s).trim()).filter(Boolean)
      : [],
    outcomes: Array.isArray(parsed.outcomes)
      ? parsed.outcomes.map((s: unknown) => String(s).trim()).filter(Boolean)
      : [],
  };
}

export async function applySummary(
  codeSessionId: string,
  summary: SessionSummary
): Promise<void> {
  const pool = getPool();
  await pool.query(
    `UPDATE code_sessions
     SET summary = $1, objectives = $2, outcomes = $3
     WHERE id = $4`,
    [summary.summary, summary.objectives, summary.outcomes, codeSessionId]
  );
}

// ---------- Decision extraction with keywords ----------

export interface ExtractedDecision {
  description: string;
  reasoning: string;
  type: string;
  keywords: string[];
  confidence: number;
  files_affected?: string[];
}

/**
 * Given the parsed session's thinking blocks, batch-extract durable candidate
 * decisions. One model call reads many blocks and returns structured decisions.
 * Deduplicates reasoning; emphasizes keywords for searchability.
 */
export async function extractDecisions(args: { parsed: ParsedSession; provider?: LLMProvider }): Promise<ExtractedDecision[]> {
  const provider = args.provider ?? getLLMProvider();
  if (!provider) return [];
  const thinkingBlocks = args.parsed.thinkingBlocks.map((t) => t.text);
  if (thinkingBlocks.length === 0) return [];

  // Cap per-call content to keep input tokens bounded — full-segment coverage
  // with middle-trim: head and tail always survive (spec §3.5).
  const MAX_BLOCKS = 150;
  const MAX_CHARS_PER_BLOCK = 1500;
  const CHAR_BUDGET = 240_000; // BACKSTOP (review N1): structurally unreachable today
  // (150 × 1500 = 225k) — it exists so a future cap raise cannot silently
  // reintroduce tail-dropping. Not dead code; insurance with a comment.
  const trimmed = middleTrim(thinkingBlocks, MAX_BLOCKS).map((t) => t.slice(0, MAX_CHARS_PER_BLOCK));
  while (trimmed.length > 2 && trimmed.reduce((n, b) => n + b.length, 0) > CHAR_BUDGET) {
    trimmed.splice(Math.floor(trimmed.length / 2), 1); // drop from the middle; head+tail survive
  }
  const blocks = trimmed.map((t, i) => `[T${i + 1}] ${t}`);

  const commits = args.parsed.commits.map((c) => ({ hash: c.hash, message: c.message }));
  const commitLines =
    commits.length > 0
      ? commits.slice(0, 20).map((c) => `${c.hash}: ${c.message}`)
      : [];

  const parts: string[] = [
    `You extract durable DECISIONS from a coding session's thinking blocks.`,
    `Session ID: ${args.parsed.sessionId ?? "unknown"}.`,
    ``,
    `A "decision" is a durable architectural, scope, tradeoff, library, security, or pattern choice MADE IN THIS SESSION FOR THIS PROJECT that should be remembered across sessions. Ephemeral reasoning ("let me check X first") is NOT a decision. Repeated reasoning across blocks becomes one decision.`,
    ``,
    `NOT extractable (these are the common false positives):`,
    `- The agent's own execution tactics: how it used tools, parallel calls, search strategy, session workflow. Tactics are not project architecture.`,
    `- One-off lookups or investigations that produced information, not a choice.`,
    `- General engineering advice or best practices discussed without being adopted for this project.`,
    `- Choices the user merely DESCRIBED or DISCUSSED (an existing license, a past design) — describing an existing choice is not making one. Only extract it if this session actually made or changed the choice.`,
    `- Anything without concrete implementation consequences for this project's code, data, or product.`,
    ``,
    `Sessions that primarily test, explore, or evaluate tooling — including this memory system itself — almost never contain project decisions. If the blocks read as an agent exercising tools, reviewing outputs, or reflecting on its own process, return []. When unsure whether something was decided FOR THE PROJECT, leave it out.`,
    ``,
    `Decision types (pick one): architecture, library_choice, pattern, security, performance, refactor, naming, scope, api, data-model, testing, tooling, ux, workflow.`,
    ``,
    `Thinking blocks follow. Consolidate repeated/related reasoning into single decisions.`,
    ``,
    ...blocks,
    ``,
  ];

  if (commitLines.length > 0) {
    parts.push(`Commits from this session (for grounding):`);
    for (const c of commitLines) parts.push(`- ${c}`);
    parts.push("");
  }

  parts.push(
    `Return STRICT JSON array (no prose outside):`,
    `[`,
    `  {`,
    `    "description": "one-sentence summary of the decision (concrete, durable)",`,
    `    "reasoning": "one-paragraph why — what led to this call",`,
    `    "type": "architecture|library_choice|pattern|security|performance|refactor|naming|scope|api|data-model|testing|tooling|ux|workflow",`,
    `    "keywords": ["specific", "searchable", "terms"],`,
    `    "confidence": 0.0-1.0,`,
    `    "files_affected": ["optional array of file paths if clear from context"]`,
    `  }`,
    `]`,
    ``,
    `Constraints:`,
    `- Return 0-10 decisions. An EMPTY array is the normal result for most sessions — extract nothing rather than stretch. Never pad to reach a count.`,
    `- Keywords: 3-8 per decision, lowercase, kebab-case when multi-word (e.g. "on-demand-context"). Prefer domain-specific terms (not "good", "bad").`,
    `- Confidence: 0.9+ only if decision is explicit + committed. 0.7-0.8 if inferred from reasoning. 0.5-0.6 if speculative.`,
    `- description + reasoning: factual, no hedging, no "we might" — if it wasn't decided, don't include it.`
  );

  const result = await provider.completeJSON({
    prompt: parts.join("\n"),
    schema: DECISIONS_SCHEMA,
    schemaName: "session_decisions",
    maxTokens: 4096,
  });
  // Accept both the schema-enforced { decisions: [...] } object and a bare array
  // (some prompt-JSON fallbacks return the array directly).
  const raw =
    result && typeof result === "object" && !Array.isArray(result) && "decisions" in result
      ? (result as { decisions: unknown }).decisions
      : result;
  const parsed: unknown[] = Array.isArray(raw) ? raw : [];
  return parsed
    .map((item) => {
      const d = (item ?? {}) as Record<string, unknown>;
      return {
        description: String(d.description ?? "").trim(),
        reasoning: String(d.reasoning ?? "").trim(),
        type: String(d.type ?? "architecture").trim(),
        keywords: Array.isArray(d.keywords)
          ? (d.keywords as unknown[]).map((s) => String(s).trim().toLowerCase()).filter(Boolean)
          : [],
        confidence: Number(d.confidence ?? 0.7),
        files_affected: Array.isArray(d.files_affected)
          ? (d.files_affected as unknown[]).map((s) => String(s).trim()).filter(Boolean)
          : undefined,
      };
    })
    .filter((d) => d.description && d.reasoning);
}

export async function persistExtractedDecisions(
  sessionId: string,
  decisions: ExtractedDecision[]
): Promise<number> {
  const { embed, currentEmbeddingModelId } = await import("./embeddings.js");
  const pool = getPool();
  const projectId = await getProjectId();

  // Re-extraction replaces this session's prior extraction — without this,
  // every re-ingest (resumed Claude Code sessions, per-turn codex re-scans)
  // duplicates the review queue. Promoted decisions changed source
  // ('user-approved') and survive; retracted ones are kept so they cannot be
  // resurrected, and their descriptions are excluded from re-insertion below.
  await pool.query(
    `DELETE FROM code_decisions
      WHERE session_id = $1 AND source = 'session-extract' AND retracted_at IS NULL`,
    [sessionId]
  );
  const surviving = await pool.query<{ description: string }>(
    `SELECT description FROM code_decisions WHERE session_id = $1`,
    [sessionId]
  );
  const alreadyPresent = new Set(surviving.rows.map((r) => r.description));

  let written = 0;
  for (const d of decisions) {
    if (alreadyPresent.has(d.description)) continue;
    const embedSource = [d.description, d.reasoning, ...d.keywords]
      .filter(Boolean)
      .join(" | ");
    const vec = await embed(embedSource);

    await pool.query(
      `INSERT INTO code_decisions
         (session_id, project_id, decision_type, description, reasoning,
          confidence, files_affected, tags, keywords, source, embedding, embedding_model)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,'session-extract',$10,$11)`,
      [
        sessionId,
        projectId,
        d.type,
        d.description,
        d.reasoning,
        d.confidence,
        d.files_affected ?? [],
        [],
        d.keywords,
        vec,
        vec ? currentEmbeddingModelId() : null,
      ]
    );
    written++;
  }
  return written;
}
