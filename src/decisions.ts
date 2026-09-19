// Origin: forked from the Mai Group's predecessor memory server (private).
import { getPool, getProjectId, projectSlugById } from "./db.js";
import { PROJECT_SLUG } from "./env.js";
import { recordReadResults, verifyCatA, enforceCharLimits, recordWriteSuccess, type CitationKind } from "./write-gate.js";
import { factsList } from "./facts.js";
import { curationCards, type CurationCard } from "./curation.js";
import type { SqlRunner } from "./curation.js";
import {
  budgetRows, budgetSections, headlineField, MCP_READ_NARROWING,
  type ReadBudget, type ReadSection,
} from "./read-budget.js";
import { demandCapPrimeMinimum, type PreparedPrimeText } from "./prime-budget.js";

/**
 * Format a timestamp as `YYYY-MM-DD HH:MM` (compact, ~16 chars vs ~60 chars
 * for the default JS Date string). Drops seconds + timezone noise — the brain
 * doesn't care about millisecond precision, and timezone is implicit.
 */
function fmtTs(ts: Date | string | null | undefined): string {
  if (!ts) return "?";
  const d = ts instanceof Date ? ts : new Date(ts);
  if (isNaN(d.getTime())) return String(ts);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

/**
 * Coerce a (possibly-untrusted) numeric param to an integer within [min,max],
 * falling back to `def`. Used everywhere a number is interpolated into SQL
 * (INTERVAL clauses) since the MCP SDK does not validate inputSchema at runtime.
 */
function boundedInt(value: unknown, def: number, min: number, max: number): number {
  const n = Math.floor(Number(value));
  if (!Number.isFinite(n)) return def;
  return Math.max(min, Math.min(max, n));
}

// ---------- Recall: project context ----------

export async function projectRecall(
  projectIdOverride?: string, budget?: ReadBudget,
): Promise<string> {
  const db = getPool();
  const projectId = projectIdOverride ?? (await getProjectId());

  const projectResult = await db.query("SELECT * FROM projects WHERE id = $1", [projectId]);
  if (projectResult.rows.length === 0) {
    return `No context for project '${PROJECT_SLUG}' yet. This is the first session against this project — new decisions and commits will be captured from here forward.`;
  }
  const project = projectResult.rows[0];

  const [sessions, decisions, recentCommits] = await Promise.all([
    db.query(
      `SELECT id, summary, objectives, outcomes, commits, duration_minutes, started_at
       FROM code_sessions
       WHERE project_id = $1
         -- superseded_by_segmentation rows are provenance, not history (plan 12)
         AND (metadata->>'superseded_by_segmentation') IS DISTINCT FROM 'true'
       ORDER BY started_at DESC NULLS LAST
       LIMIT 5`,
      [projectId]
    ),
    db.query(
      `SELECT id, decision_type, description, reasoning, alternatives_considered,
              confidence, files_affected, tags
       FROM code_decisions
       WHERE project_id = $1 AND still_valid = true
       ORDER BY confidence DESC, timestamp DESC
       LIMIT 30`,
      [projectId]
    ),
    db.query(
      `SELECT commit_hash, message, commit_type, scope, author
       FROM code_commits
       WHERE project_id = $1
       ORDER BY timestamp DESC LIMIT 20`,
      [projectId]
    ),
  ]);

  const decisionIds = decisions.rows.map((d: Record<string, unknown>) => String(d.id ?? '')).filter(Boolean);
  await recordReadResults('decisions', decisionIds);

  const header = `=== Brain — ${project.name || project.slug} ===`;

  const projectSummary = [
    `Project: ${project.name || project.slug}`,
    `Path: ${project.path || "unknown"}`,
    `Tech: ${(project.tech_stack || []).join(", ") || "unknown"}`,
    `Sessions: ${project.total_sessions}`,
    `Commits: ${project.total_commits}`,
    `Last active: ${project.last_active_at ? fmtTs(project.last_active_at) : "unknown"}`,
  ].join("\n");

  const sessionsStr =
    sessions.rows.length > 0
      ? sessions.rows
          .map((s: Record<string, unknown>) => {
            const parts: string[] = [`- ${s.summary || "(no summary)"}`];
            if (s.commits) parts.push(`${s.commits} commits`);
            if (s.duration_minutes) parts.push(`${s.duration_minutes}min`);
            return parts.join(" | ");
          })
          .join("\n")
      : "No sessions recorded yet.";

  const decisionsStr =
    decisions.rows.length > 0
      ? decisions.rows
          .map((d: Record<string, unknown>) => {
            let line = `- [${d.decision_type}] ${d.description}`;
            if (d.reasoning)
              line += `\n  Why: ${String(d.reasoning).slice(0, 200)}`;
            return line;
          })
          .join("\n")
      : "No decisions recorded yet.";

  const commitsStr =
    recentCommits.rows.length > 0
      ? recentCommits.rows
          .map(
            (c: Record<string, unknown>) =>
              `- [${c.commit_type || "?"}] ${String(c.message).split("\n")[0]} (${
                c.author || "unknown"
              })`
          )
          .join("\n")
      : "No commits recorded yet.";

  const complete = [
    header,
    "",
    "--- Project ---",
    projectSummary,
    "",
    "--- Recent Sessions ---",
    sessionsStr,
    "",
    "--- Key Decisions (still valid) ---",
    decisionsStr,
    "",
    "--- Recent Commits ---",
    commitsStr,
    "",
    "=== END Brain ===",
  ].join("\n");

  // Headline shape (plan 23): every session summary, decision description and
  // commit subject survives; only the decision `Why:` bodies are omitted. The
  // section labels ride on the first row of their group so one flat row list
  // still renders the familiar layout.
  type RecallRow = { headline: string };
  const rows: RecallRow[] = [
    ...sessions.rows.map((s: Record<string, unknown>, i: number) => ({
      headline: `${i === 0 ? "\n--- Recent Sessions ---\n" : ""}- ${s.summary || "(no summary)"}`,
    })),
    ...decisions.rows.map((d: Record<string, unknown>, i: number) => ({
      headline: `${i === 0 ? "\n--- Key Decisions (still valid) ---\n" : ""}- [${d.decision_type}] ${d.description}`,
    })),
    ...recentCommits.rows.map((c: Record<string, unknown>, i: number) => ({
      headline: `${i === 0 ? "\n--- Recent Commits ---\n" : ""}- [${c.commit_type || "?"}] ${String(c.message).split("\n")[0]} (${c.author || "unknown"})`,
    })),
  ];
  return budgetRows(
    budget, rows, () => complete, (r) => r.headline,
    `${header}\n\n--- Project ---\n${projectSummary}`,
    'recall row', MCP_READ_NARROWING.mai_recall,
  );
}

// ---------- Remember: log a decision ----------

export async function decisionAdd(args: {
  citation: CitationKind;
  decisionType: string;
  description: string;
  reasoning?: string;
  alternativesConsidered?: string[];
  filesAffected?: string[];
  tags?: string[];
  keywords?: string[];
  confidence?: number;
  // 'matt-approved' is still accepted as input for one release (aliased to
  // 'user-approved' at the write below); new writes should use 'user-approved'.
  source?: "user-approved" | "matt-approved" | "agent-inferred" | "user-selected";
}): Promise<string> {
  await enforceCharLimits({
    fields: {
      description: args.description,
      reasoning: args.reasoning ?? '',
    },
    toolName: 'mai_remember',
  });

  const cited = await verifyCatA({
    bucket: 'decisions',
    citation: args.citation,
    payloadFingerprint: args.description,
    toolName: 'mai_remember',
  });

  const db = getPool();
  const projectId = await getProjectId();

  const keywords =
    args.keywords?.map((k) => k.toLowerCase().trim()).filter(Boolean) ?? [];

  const { embed, currentEmbeddingModelId } = await import("./embeddings.js");
  const embedSource = [args.description, args.reasoning ?? "", ...(keywords ?? [])]
    .filter(Boolean)
    .join(" | ");
  const vec = await embed(embedSource);

  let source = args.source ?? "agent-inferred";
  if (source === "matt-approved") source = "user-approved"; // one-release alias, remove after v0.2

  // The insert and the citation share ONE transaction (spec §2.3): if the
  // insert fails, the citation rolls back with it — a rejected write must never
  // manufacture a load-bearing signal. The embedding is computed above, OUTSIDE
  // the transaction (the reviewPost ordering rule).
  const { recordCitation } = await import("./curation.js");
  const client = await db.connect();
  let newId = "";
  let stamp: Date | string = "";
  try {
    await client.query("BEGIN");
    const result = await client.query<{ id: string; timestamp: Date }>(
      `INSERT INTO code_decisions
         (session_id, project_id, decision_type, description, reasoning,
          alternatives_considered, confidence, files_affected, tags, keywords,
          source, embedding, embedding_model)
       VALUES (NULL,$1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)
       RETURNING id, timestamp`,
      [
        projectId,
        args.decisionType,
        args.description,
        args.reasoning ?? null,
        args.alternativesConsidered ?? [],
        args.confidence ?? 0.8,
        args.filesAffected ?? [],
        args.tags ?? [],
        keywords,
        source,
        vec,
        vec ? currentEmbeddingModelId() : null,
      ]
    );
    newId = result.rows[0].id;
    stamp = result.rows[0].timestamp;
    if (cited) {
      await recordCitation(client, projectId, {
        citingKind: "decision",
        citingId: newId,
        citedKind: cited.citedKind,
        citedId: cited.citedId,
        relation: cited.relation,
        reason: cited.reason,
        sessionTokenId: cited.sessionTokenId,
        source,
      });
    }
    await client.query("COMMIT");
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
  }

  await recordWriteSuccess();
  return `Decision logged [source=${source}]: id=${newId} timestamp=${String(stamp)}${vec ? " (embedded)" : ""}`;
}

// ---------- Semantic similarity search ----------

interface DecisionSemanticHit {
  id: string;
  decision_type: string;
  description: string;
  reasoning: string | null;
  keywords: string[] | null;
  tags: string[];
  source: string;
  confidence: number;
  timestamp: Date | string;
  score: number;
}

type DecisionSemanticAttempt =
  | { kind: 'hits'; modelId: string; hits: DecisionSemanticHit[] }
  | { kind: 'unavailable'; reason: 'disabled' | 'embed-failed' | 'no-current-rows' | 'below-threshold'; message: string };

/** Decision rows are separated by a BLANK line. budgetSections joins rows with
 * a single '\n', so every row after the first carries a leading newline — that
 * is what keeps the unbudgeted/CLI bytes identical to the pre-plan-23 render. */
function spacedRows(rows: readonly string[]): string[] {
  return rows.map((r, i) => (i === 0 ? r : `\n${r}`));
}

function semanticDecisionFullRows(hits: DecisionSemanticHit[]): string[] {
  return hits.map((d) => {
    const kw = (d.keywords ?? []).slice(0, 6).join(', ');
    return [
      `- \`${d.id}\` [${d.decision_type}] (sim ${d.score.toFixed(3)}, conf ${d.confidence}, ${d.source})`,
      `  ${d.description}`,
      d.reasoning ? `  why: ${d.reasoning.slice(0, 250)}` : null,
      kw ? `  keywords: ${kw}` : null,
    ].filter(Boolean).join('\n');
  });
}

/** id/type/source/confidence/description — no why, no keywords. */
function semanticDecisionHeadlineRows(hits: DecisionSemanticHit[]): string[] {
  return hits.map((d) =>
    `- \`${d.id}\` [${d.decision_type}] (sim ${d.score.toFixed(3)}, conf ${d.confidence}, ${d.source}) ` +
    headlineField(d.description));
}

function formatSemanticDecisionHits(hits: DecisionSemanticHit[]): string {
  return spacedRows(semanticDecisionFullRows(hits)).join('\n');
}

async function decisionSemanticAttempt(args: {
  query: string; limit: number; minScore: number; projectId: string;
}): Promise<DecisionSemanticAttempt> {
  const { embedQuery, embeddingsEnabled, embeddingsStatus, cosineSim, currentEmbeddingModelId } =
    await import('./embeddings.js');
  if (!embeddingsEnabled()) {
    return { kind: 'unavailable', reason: 'disabled', message: `Semantic search unavailable — embeddings ${embeddingsStatus()}. Use mai_search instead.` };
  }
  const modelId = currentEmbeddingModelId();
  if (!modelId) {
    return { kind: 'unavailable', reason: 'disabled', message: `Semantic search unavailable — embeddings ${embeddingsStatus()}. Use mai_search instead.` };
  }
  const queryVec = await embedQuery(args.query);
  if (!queryVec) {
    return { kind: 'unavailable', reason: 'embed-failed', message: `Failed to embed query — embeddings ${embeddingsStatus()}` };
  }
  const result = await getPool().query<{
    id: string; decision_type: string; description: string; reasoning: string | null;
    keywords: string[] | null; tags: string[]; source: string; confidence: number;
    timestamp: Date | string; embedding: number[];
  }>(
    `SELECT id, decision_type, description, reasoning, keywords, tags,
            source, confidence, timestamp, embedding
       FROM code_decisions
      WHERE project_id = $1 AND embedding IS NOT NULL AND embedding_model = $2`,
    [args.projectId, modelId]
  );
  if (result.rows.length === 0) {
    return { kind: 'unavailable', reason: 'no-current-rows', message: `No decisions embedded with the current model (${modelId}). Populate/refresh with \`mai embed --rebuild\`.` };
  }
  const hits = result.rows
    .map((d) => ({ ...d, score: cosineSim(queryVec, d.embedding) }))
    .filter((d) => d.score >= args.minScore)
    .sort((a, b) => b.score - a.score)
    .slice(0, args.limit);
  if (hits.length === 0) {
    return { kind: 'unavailable', reason: 'below-threshold', message: `No decisions above similarity threshold ${args.minScore} for query '${args.query}'.` };
  }
  return { kind: 'hits', modelId, hits };
}

export async function decisionsSimilar(args: {
  query: string; limit?: number; minScore?: number; projectId?: string;
}): Promise<string> {
  const projectId = args.projectId ?? (await getProjectId());
  const attempt = await decisionSemanticAttempt({
    query: args.query,
    limit: args.limit ?? 10,
    minScore: args.minScore ?? 0.25,
    projectId,
  });
  if (attempt.kind === 'unavailable') return attempt.message;
  await recordReadResults('decisions', attempt.hits.map((h) => h.id));
  return formatSemanticDecisionHits(attempt.hits); // existing output shape, extracted verbatim
}

// ---------- Retract (APPROVAL-GATED) ----------

export async function decisionRetract(args: {
  decisionId: string;
  reason: string;
  projectId?: string;
  /** Run on the caller's transaction client instead of the pool. The curation
   * verdict routes retire an entry and close its proposal in ONE transaction
   * (plan 22 ambiguity 7); every other caller — the CLI, /api/retract, the
   * review triage — omits it and keeps today's pool behaviour exactly. */
  exec?: SqlRunner;
}): Promise<string> {
  await enforceCharLimits({
    fields: { reason: args.reason },
    toolName: 'mai_retract',
  });

  const db: SqlRunner = args.exec ?? getPool();

  const trimmedReason = args.reason.trim();
  if (!trimmedReason) {
    throw new Error(
      "retraction_reason is required — retraction without stated reason is not allowed"
    );
  }

  const result = await db.query(
    `UPDATE code_decisions
     SET still_valid = false,
         retracted_at = NOW(),
         retraction_reason = $2
     WHERE id = $1 AND project_id = $3
     RETURNING id, decision_type, description, retracted_at`,
    [args.decisionId, trimmedReason, args.projectId ?? (await getProjectId())]
  );

  if (result.rows.length === 0) {
    return `No decision with id ${args.decisionId} found.`;
  }
  const r = result.rows[0];
  return [
    `Retracted decision ${r.id}:`,
    `  [${r.decision_type}] ${r.description}`,
    `  reason: ${trimmedReason}`,
    `  at: ${r.retracted_at}`,
  ].join("\n");
}

export async function decisionUnretract(
  decisionId: string,
  projectIdOverride?: string,
  exec?: SqlRunner
): Promise<string> {
  const db: SqlRunner = exec ?? getPool();
  const result = await db.query(
    `UPDATE code_decisions
     SET still_valid = true,
         retracted_at = NULL,
         retraction_reason = NULL
     WHERE id = $1 AND project_id = $2
     RETURNING id, decision_type, description`,
    [decisionId, projectIdOverride ?? (await getProjectId())]
  );
  if (result.rows.length === 0) return `No decision with id ${decisionId}.`;
  const r = result.rows[0];
  return `Unretracted decision ${r.id}: [${r.decision_type}] ${r.description}`;
}

// ---------- Daily report ----------

export async function dailyReport(
  days = 1, projectIdOverride?: string, budget?: ReadBudget,
): Promise<string> {
  const db = getPool();
  const projectId = projectIdOverride ?? (await getProjectId());

  const d = boundedInt(days, 1, 1, 36500);
  const sinceInterval = `${d} days`;

  const [added, retracted, needsReview, oldLowConf] = await Promise.all([
    db.query(
      `SELECT id, decision_type, description, source, confidence,
              keywords, timestamp
       FROM code_decisions
       WHERE project_id = $1
         AND timestamp > NOW() - INTERVAL '${sinceInterval}'
         AND still_valid = true
       ORDER BY timestamp DESC`,
      [projectId]
    ),
    db.query(
      `SELECT id, decision_type, description, retracted_at, retraction_reason
       FROM code_decisions
       WHERE project_id = $1
         AND retracted_at > NOW() - INTERVAL '${sinceInterval}'
       ORDER BY retracted_at DESC`,
      [projectId]
    ),
    db.query(
      `SELECT id, decision_type, description, confidence, keywords, timestamp
       FROM code_decisions
       WHERE project_id = $1
         AND still_valid = true
         AND source = 'agent-inferred'
         AND timestamp < NOW() - INTERVAL '2 days'
       ORDER BY timestamp ASC
       LIMIT 20`,
      [projectId]
    ),
    db.query(
      `SELECT id, decision_type, description, confidence, source, timestamp
       FROM code_decisions
       WHERE project_id = $1
         AND still_valid = true
         AND confidence < 0.7
         AND timestamp < NOW() - INTERVAL '30 days'
       ORDER BY timestamp ASC
       LIMIT 20`,
      [projectId]
    ),
  ]);

  const lines: string[] = [];
  const reportTitle =
    `# Brain daily report — ${await projectSlugById(projectId)} (last ${d} day${d === 1 ? "" : "s"})`;
  lines.push(reportTitle);
  lines.push("");

  // Added
  const bySource: Record<string, Record<string, unknown>[]> = {};
  for (const r of added.rows) {
    const s = String(r.source ?? "unknown");
    (bySource[s] ??= []).push(r);
  }
  lines.push(`## Added (${added.rows.length})`);
  if (added.rows.length === 0) {
    lines.push("_nothing new_");
    lines.push("");
  } else {
    for (const [src, rows] of Object.entries(bySource)) {
      lines.push(`### source: ${src} (${rows.length})`);
      for (const r of rows) {
        const kw = Array.isArray(r.keywords)
          ? (r.keywords as string[]).slice(0, 6).join(", ")
          : "";
        lines.push(
          `- \`${String(r.id).slice(0, 8)}\` [${r.decision_type}] ${r.description} (conf ${r.confidence})`
        );
        if (kw) lines.push(`  keywords: ${kw}`);
      }
      lines.push("");
    }
  }

  // Retracted
  lines.push(`## Retracted (${retracted.rows.length})`);
  if (retracted.rows.length === 0) {
    lines.push("_none_");
  } else {
    for (const r of retracted.rows) {
      lines.push(`- \`${String(r.id).slice(0, 8)}\` [${r.decision_type}] ${r.description}`);
      lines.push(`  reason: ${r.retraction_reason}`);
    }
  }
  lines.push("");

  // Needs review
  lines.push(`## Needs review (agent-inferred, > 48h old, ${needsReview.rows.length})`);
  if (needsReview.rows.length === 0) {
    lines.push("_none pending_");
  } else {
    for (const r of needsReview.rows) {
      lines.push(`- \`${String(r.id).slice(0, 8)}\` [${r.decision_type}] ${r.description} (conf ${r.confidence})`);
    }
  }
  lines.push("");

  // Old + low-confidence
  lines.push(`## Old + low-confidence (${oldLowConf.rows.length})`);
  if (oldLowConf.rows.length === 0) {
    lines.push("_none_");
  } else {
    for (const r of oldLowConf.rows) {
      lines.push(
        `- \`${String(r.id).slice(0, 8)}\` [${r.decision_type}] ${r.description} (conf ${r.confidence}, source ${r.source})`
      );
    }
  }

  // Headline shape (plan 23): the section counts and one id/type/description
  // line per decision survive; the `keywords:`/`reason:` detail lines are the
  // omitted body. Section labels ride on the first row of each group.
  type ReportRow = { headline: string };
  const group = (label: string, rows: Record<string, unknown>[], line: (r: Record<string, unknown>) => string): ReportRow[] =>
    rows.map((r, i) => ({ headline: `${i === 0 ? `\n${label}\n` : ""}${line(r)}` }));
  const reportRows: ReportRow[] = [
    ...group(`## Added (${added.rows.length})`, added.rows, (r) =>
      `- \`${String(r.id).slice(0, 8)}\` [${r.decision_type}] ${r.description} (conf ${r.confidence})`),
    ...group(`## Retracted (${retracted.rows.length})`, retracted.rows, (r) =>
      `- \`${String(r.id).slice(0, 8)}\` [${r.decision_type}] ${r.description}`),
    ...group(`## Needs review (agent-inferred, > 48h old, ${needsReview.rows.length})`, needsReview.rows, (r) =>
      `- \`${String(r.id).slice(0, 8)}\` [${r.decision_type}] ${r.description} (conf ${r.confidence})`),
    ...group(`## Old + low-confidence (${oldLowConf.rows.length})`, oldLowConf.rows, (r) =>
      `- \`${String(r.id).slice(0, 8)}\` [${r.decision_type}] ${r.description} (conf ${r.confidence}, source ${r.source})`),
  ];
  return budgetRows(
    budget, reportRows, () => lines.join("\n"), (r) => r.headline,
    reportTitle, 'report row', MCP_READ_NARROWING.mai_report,
  );
}

// ---------- Review ----------

export interface ReviewRowBase {
  id: string; decision_type: string; description: string; reasoning: string | null;
  confidence: number; source: string; keywords: string[]; timestamp: string;
}
export interface DecisionReviewRow extends ReviewRowBase { kind: 'decision' }
export interface FactReviewRow extends ReviewRowBase { kind: 'fact' }
/** The curation kind (plan 22, spec §5.1). It carries the WHOLE card —
 * including the server-authoritative approve/deny labels, because approve/deny
 * INVERT between kinds: `a` on a decision means "this is good", `a` on a prune
 * candidate means "keep it", `a` on a supersede proposal means "apply it".
 * Deriving those words in the view is how an operator's muscle memory retires
 * good memory, so the view never derives them. */
export interface CurationReviewRow extends ReviewRowBase {
  kind: 'curation';
  curation: CurationCard;
}
export type ReviewRow = DecisionReviewRow | FactReviewRow | CurationReviewRow;

/** The review queue as rows (JSON surface): agent-inferred + session-extract +
 * low-confidence still-valid decisions, ranked review-first. reviewQueue renders
 * markdown from these — one query, two surfaces. */
export async function reviewQueueRows(limit = 30, projectIdOverride?: string): Promise<ReviewRow[]> {
  const db = getPool();
  const projectId = projectIdOverride ?? (await getProjectId());

  const result = await db.query<{
    id: string; decision_type: string; description: string; reasoning: string | null;
    confidence: number; source: string; keywords: string[] | null; timestamp: Date;
  }>(
    `SELECT id, decision_type, description, reasoning, confidence, source,
            keywords, timestamp
     FROM code_decisions
     WHERE project_id = $1
       AND still_valid = true
       AND (source = 'agent-inferred' OR source = 'session-extract' OR confidence < 0.5)
     ORDER BY
       CASE WHEN source = 'agent-inferred' THEN 0 ELSE 1 END,
       confidence ASC,
       timestamp ASC
     LIMIT $2`,
    [projectId, limit]
  );

  const decisionRows: ReviewRow[] = result.rows.map((r) => ({
    kind: 'decision' as const,
    id: r.id,
    decision_type: r.decision_type,
    description: r.description,
    reasoning: r.reasoning,
    confidence: r.confidence,
    source: r.source,
    keywords: Array.isArray(r.keywords) ? r.keywords : [],
    timestamp: new Date(r.timestamp).toISOString(),
  }));

  // Facts are GLOBAL — their candidates appear in every project's queue, and
  // approving one clears it everywhere (spec R4).
  const factCandidates: FactReviewRow[] = (await factsList({ source: 'agent-inferred' })).map((f) => ({
    kind: 'fact' as const,
    id: f.id,
    decision_type: f.category,
    description: f.fact,
    reasoning: f.detail ? `${f.detail}\n(evidence: ${f.evidence})` : `evidence: ${f.evidence}`,
    confidence: 0.5, // facts carry no confidence column — constant for display
    source: f.source,
    keywords: [f.category, 'user-fact'],
    timestamp: f.created_at,
  }));

  // Curation rows get a RESERVED slice (the budgetHybridHits idiom): appended
  // LAST so the existing triage order is unchanged, but never starved by a long
  // decision queue. `limit` is still respected exactly.
  //
  // R7 says curation cannot starve for ANY positive limit. At limit=1 that
  // policy necessarily gives the sole slot to curation when one exists; if no
  // curation row exists, the head below receives the slot. mai_review exposes
  // `limit` directly, so this is a shipped path, not a theoretical floor.
  const curationBudget = limit > 0 ? Math.max(1, Math.floor(limit / 3)) : 0;
  const curationRows: CurationReviewRow[] = (await curationCards(projectId, curationBudget)).map((c) => ({
    kind: 'curation' as const,
    // Stable per subject: the proposal's own id when there is one, else a
    // kind:id pair — the dashboard uses this as a React key and as the
    // selection identity, so it must not change between polls.
    // Graduate cards keep their own id namespace. Precedence now prevents
    // simultaneous cards for one target, while the explicit namespace keeps
    // React/selection identity stable across future queue kinds.
    id: c.basis === 'graduate'
      ? `graduate:${c.targetId}`
      : (c.citationId ?? c.candidateId ?? `${c.targetKind}:${c.targetId}`),
    decision_type: c.basis,
    description: c.targetSummary,
    reasoning: curationReasoning(c),
    confidence: 0,
    source: c.proposedBy ?? 'usage-telemetry',
    keywords: c.isGlobal ? ['curation', c.basis, 'GLOBAL'] : ['curation', c.basis],
    timestamp: new Date().toISOString(),
    curation: c,
  }));

  const head: ReviewRow[] = [...decisionRows, ...factCandidates].slice(
    0,
    Math.max(0, limit - curationRows.length)
  );
  return [...head, ...curationRows];
}

/** The card's explanatory body: telemetry for candidates, the agent's verbatim
 * evidence plus what replaces it for proposals, and — for a global lesson — the
 * every-project consequence spelled out (spec §5.1 / §10.3). */
function curationReasoning(c: CurationCard): string {
  // NOTE: globalNote is deliberately NOT pushed here. `reasoning` is rendered
  // by Card.tsx's pre-existing `{row.reasoning && <p …>}`, and the curation card
  // already renders the consequence in its own `global-consequence` paragraph —
  // pushing it here too printed the same sentence twice on a global-lesson card
  // (pass-2 finding 18429b17). The MARKDOWN renderer pushes it separately and is
  // unaffected; `row.curation.globalNote` remains the JSON carrier.
  const lines: string[] = [];
  if (c.basis === 'agent-evidence') {
    lines.push(`proposed by ${c.proposedBy ?? 'an agent'}: ${c.evidence ?? '(no evidence given)'}`);
    if (c.replacementSummary) lines.push(`replacement: ${c.replacementSummary}`);
  } else if (c.basis === 'graduate') {
    lines.push(
      `relearned ×${c.relearnedCount ?? 0} — independently rediscovered; ` +
        `promoting renders it into the repo's GRADUATED RULES block`
    );
  } else {
    lines.push(
      `surfaced ×${c.surfacedCount} / cited ×${c.citedCount}` +
        ` · last surfaced ${c.lastSurfacedAt ? fmtTs(c.lastSurfacedAt) : 'never'}`
    );
  }
  return lines.join('\n');
}

export async function reviewQueue(limit = 30, projectIdOverride?: string): Promise<string> {
  const projectId = projectIdOverride ?? (await getProjectId());
  const rows = await reviewQueueRows(limit, projectId);

  if (rows.length === 0) {
    return "No decisions need review — brain is clean.";
  }

  const lines: string[] = [
    `# Brain review queue — ${await projectSlugById(projectId)} (${rows.length} items)`,
    "",
    "Agent-inferred + low-confidence entries, plus curation candidates and proposals. Promote with mai_promote. " +
      "Retiring anything is the operator's — mai_retract is propose-only for agents (propose: true).",
    "",
  ];
  for (const r of rows) {
    if (r.kind === 'curation') {
      // Labelled per kind, NEVER with the promote/retract wording: on a prune
      // candidate "approve" means KEEP, and reusing the old vocabulary here is
      // exactly how an operator retires good memory (spec §5.1).
      const c = r.curation;
      lines.push(`- \`${r.id}\` [curation/${c.basis}]${c.isGlobal ? ' **GLOBAL**' : ''} ${c.targetSummary}`);
      lines.push(`  target: ${c.targetKind} ${c.targetId}`);
      if (c.globalNote) lines.push(`  ${c.globalNote}`);
      if (c.basis === 'agent-evidence') {
        lines.push(`  proposed by: ${c.proposedBy ?? 'an agent'}`);
        lines.push(`  evidence: ${String(c.evidence ?? '').slice(0, 400)}`);
        if (c.replacementSummary) lines.push(`  replacement: ${c.replacementSummary}`);
      } else if (c.basis === 'graduate') {
        lines.push(
          `  relearned ×${c.relearnedCount ?? 0} — promoting renders it into the repo's GRADUATED RULES block`
        );
      } else {
        lines.push(
          `  surfaced ×${c.surfacedCount} / cited ×${c.citedCount}` +
            ` · last surfaced ${c.lastSurfacedAt ? fmtTs(c.lastSurfacedAt) : 'never'}`
        );
      }
      lines.push(`  actions: [${c.approveLabel}] or [${c.denyLabel}] — operator only, in the dashboard.`);
      lines.push("");
      continue;
    }
    const kw = r.keywords.slice(0, 6).join(", ");
    const label = r.kind === 'fact' ? `[fact/${r.decision_type}]` : `[${r.decision_type}]`;
    lines.push(`- \`${r.id}\` ${label} ${r.description}`);
    lines.push(`  source: ${r.source}, confidence: ${r.confidence}`);
    if (r.reasoning) lines.push(`  why: ${String(r.reasoning).slice(0, 200)}`);
    if (kw) lines.push(`  keywords: ${kw}`);
    lines.push(`  ts: ${fmtTs(r.timestamp)}`);
    lines.push("");
  }
  return lines.join("\n");
}

// ---------- Promote (agent-inferred -> user-approved) ----------

export async function decisionPromote(
  decisionId: string,
  confidence?: number,
  projectIdOverride?: string
): Promise<string> {
  const db = getPool();
  const result = await db.query(
    `UPDATE code_decisions
     SET source = 'user-approved',
         confidence = COALESCE($2, GREATEST(confidence, 0.85))
     WHERE id = $1 AND project_id = $3
     RETURNING id, decision_type, description, source, confidence`,
    [decisionId, confidence ?? null, projectIdOverride ?? (await getProjectId())]
  );
  if (result.rows.length === 0) return `No decision with id ${decisionId}.`;
  const r = result.rows[0];
  return `Promoted ${r.id} to '${r.source}' (confidence ${r.confidence}): [${r.decision_type}] ${r.description}`;
}

// ---------- Keyword search ----------

async function decisionKeywordSection(args: {
  keywords: string[];
  matchAll?: boolean;
  limit?: number;
  projectId?: string;
}, heading: string): Promise<ReadSection> {
  const db = getPool();
  const projectId = args.projectId ?? (await getProjectId());

  const normalized = args.keywords
    .map((k) => k.toLowerCase().trim())
    .filter(Boolean);
  if (normalized.length === 0) {
    return { heading, fullRows: ["No keywords provided."], headlineRows: ["No keywords provided."] };
  }

  const conditions: string[] = ["project_id = $1"];
  const params: unknown[] = [projectId];

  params.push(normalized);
  conditions.push(
    args.matchAll
      ? `keywords @> $${params.length}::text[]` // all keywords must be present
      : `keywords && $${params.length}::text[]` // any overlap
  );

  params.push(args.limit ?? 20);

  const result = await db.query(
    `SELECT id, decision_type, description, reasoning, keywords, tags,
            source, confidence, timestamp
     FROM code_decisions
     WHERE ${conditions.join(" AND ")}
     ORDER BY confidence DESC, timestamp DESC
     LIMIT $${params.length}`,
    params
  );

  const kwIds = result.rows.map((d: Record<string, unknown>) => String(d.id ?? '')).filter(Boolean);
  await recordReadResults('decisions', kwIds);

  if (result.rows.length === 0) {
    return { heading, fullRows: [`No decisions matching keywords [${normalized.join(", ")}].`],
             headlineRows: [`No decisions matching keywords [${normalized.join(", ")}].`] };
  }

  const fullRows = result.rows.map((d: Record<string, unknown>) => {
    const kw = Array.isArray(d.keywords) ? (d.keywords as string[]).join(", ") : "";
    return [
      `- \`${String(d.id)}\` [${d.decision_type}] (${d.source}, conf ${d.confidence})`,
      `  ${d.description}`,
      d.reasoning ? `  why: ${String(d.reasoning).slice(0, 250)}` : null,
      kw ? `  keywords: ${kw}` : null,
      `  ts: ${fmtTs(d.timestamp as string | Date | null | undefined)}`,
    ]
      .filter(Boolean)
      .join("\n");
  });
  const headlineRows = result.rows.map((d: Record<string, unknown>) =>
    `- \`${String(d.id)}\` [${d.decision_type}] (${d.source}, conf ${d.confidence}) ` +
    headlineField(String(d.description ?? '')));
  return { heading, fullRows: spacedRows(fullRows), headlineRows };
}

/** The unbudgeted string surface — byte-identical to the pre-plan-23 render. */
export async function decisionsByKeywords(args: {
  keywords: string[];
  matchAll?: boolean;
  limit?: number;
  projectId?: string;
}): Promise<string> {
  return budgetSections(
    undefined, [await decisionKeywordSection(args, '')], 'result', MCP_READ_NARROWING.mai_search);
}

// ---------- Decisions query ----------

/**
 * Trim a `why:` reasoning string to its first sentence (up to ~200 chars), with
 * an ellipsis marker when truncated. Preserves the full text behind a
 * `verbose=true` flag at the call site.
 */
function trimReasoning(text: string, verbose: boolean): string {
  if (verbose) return text;
  // Find the first sentence terminator within reasonable range.
  const slice = text.slice(0, 240);
  const match = slice.match(/^.+?[.!?](?:\s|$)/);
  if (match && match[0].length >= 30) return match[0].trim() + (text.length > match[0].length ? " …" : "");
  // No clean sentence break — hard cap at 200 chars with ellipsis.
  if (text.length > 200) return text.slice(0, 200).trimEnd() + " …";
  return text;
}

export async function decisionsQuery(args: {
  type?: string;
  tags?: string[];
  limit?: number;
  verbose?: boolean;
  projectId?: string;
}): Promise<string> {
  const db = getPool();
  const projectId = args.projectId ?? (await getProjectId());

  const conditions: string[] = ["project_id = $1", "still_valid = true"];
  const params: unknown[] = [projectId];
  if (args.type) {
    params.push(args.type);
    conditions.push(`decision_type = $${params.length}`);
  }
  if (args.tags && args.tags.length > 0) {
    params.push(args.tags);
    conditions.push(`tags && $${params.length}`);
  }
  params.push(args.limit ?? 20);

  const result = await db.query(
    `SELECT id, decision_type, description, reasoning, alternatives_considered,
            confidence, files_affected, tags, timestamp
     FROM code_decisions
     WHERE ${conditions.join(" AND ")}
     ORDER BY confidence DESC, timestamp DESC
     LIMIT $${params.length}`,
    params
  );

  const decIds = result.rows.map((d: Record<string, unknown>) => String(d.id ?? '')).filter(Boolean);
  await recordReadResults('decisions', decIds);

  if (result.rows.length === 0) {
    return "No matching decisions.";
  }

  return result.rows
    .map((d: Record<string, unknown>) => {
      const lines: string[] = [
        `- [${d.decision_type}] ${d.description}`,
      ];
      if (d.reasoning) lines.push(`  why: ${trimReasoning(String(d.reasoning), args.verbose ?? false)}`);
      if (Array.isArray(d.tags) && d.tags.length > 0)
        lines.push(`  tags: ${(d.tags as string[]).join(", ")}`);
      lines.push(`  ts: ${fmtTs(d.timestamp as string | Date | null | undefined)}`);
      return lines.join("\n");
    })
    .join("\n\n");
}

// ---------- Timeline (chronological) ----------

export interface ActivityRow { kind: 'session' | 'decision' | 'commit'; ts: string; id: string; detail: string | null }

interface ActivityQueryRow { kind: 'session' | 'decision' | 'commit'; ts: Date; id: string | null; detail: string | null }

/** Merged chronological activity as rows (JSON surface): sessions + decisions +
 * commits within the window, sorted newest-first and capped. timeline renders
 * markdown from these — one set of queries, two surfaces. */
export async function activityRows(days = 7, limit = 30, projectIdOverride?: string): Promise<ActivityRow[]> {
  // Coerce to bounded integers before interpolating into INTERVAL — never trust
  // the raw param (the MCP SDK does not enforce inputSchema types at runtime).
  const d = boundedInt(days, 7, 1, 36500);
  const lim = boundedInt(limit, 30, 1, 1000);
  const db = getPool();
  const projectId = projectIdOverride ?? (await getProjectId());

  const [sessions, decisions, commits] = await Promise.all([
    db.query<ActivityQueryRow>(
      `SELECT 'session' AS kind, started_at AS ts, original_session_id AS id,
              summary AS detail
       FROM code_sessions
       WHERE project_id = $1 AND started_at > NOW() - INTERVAL '${d} days'
         -- superseded_by_segmentation rows are provenance, not history (plan 12)
         AND (metadata->>'superseded_by_segmentation') IS DISTINCT FROM 'true'
       ORDER BY ts DESC`,
      [projectId]
    ),
    db.query<ActivityQueryRow>(
      // Unreviewed session-extract candidates are labeled so agents reading the
      // timeline (incl. mai_prime's Recent activity) can't mistake speculative
      // extraction for reviewed decision history — the quarantine boundary
      // (Sol's B2 finding). Retracted decisions never surface here.
      `SELECT 'decision' AS kind, timestamp AS ts, decision_type AS id,
              CASE WHEN source = 'session-extract'
                   THEN '[candidate — unreviewed] ' || description
                   ELSE description END AS detail
       FROM code_decisions
       WHERE project_id = $1 AND timestamp > NOW() - INTERVAL '${d} days'
         AND retracted_at IS NULL
       ORDER BY ts DESC`,
      [projectId]
    ),
    db.query<ActivityQueryRow>(
      // Commits linked to decisions carry the lineage inline — the cheap half
      // of the git evidence layer's prime enrichment (plan 7d).
      `SELECT 'commit' AS kind, c.timestamp AS ts, c.commit_hash AS id,
              c.message || COALESCE(
                ' ← implements decision ' || (
                  SELECT string_agg(substr(e.from_id::text, 1, 8), ', ')
                  FROM memory_edges e
                  WHERE e.to_kind = 'commit' AND e.to_id = c.id
                    AND e.relation = 'implemented_by' AND e.from_kind = 'decision'
                ), '') AS detail
       FROM code_commits c
       WHERE c.project_id = $1 AND c.timestamp > NOW() - INTERVAL '${d} days'
       ORDER BY ts DESC`,
      [projectId]
    ),
  ]);

  const all = [...sessions.rows, ...decisions.rows, ...commits.rows];
  all.sort((a, b) => new Date(b.ts).getTime() - new Date(a.ts).getTime());
  return all.slice(0, lim).map((r) => ({
    kind: r.kind,
    ts: new Date(r.ts).toISOString(),
    id: r.id ?? '',
    detail: r.detail,
  }));
}

const TIMELINE_RECOVERY_MINIMUM = '_mai_timeline for recent activity._';

const timelineRow = (r: ActivityRow): string => {
  const ts = fmtTs(r.ts);
  const detail = String(r.detail ?? "").split("\n")[0].slice(0, 120);
  return `- **${ts}** ${r.kind} — ${detail}`;
};

/**
 * Pure timeline renderer over ALREADY-FETCHED rows. The one-line row shape is
 * unchanged; an omitted-rows render names `mai_timeline` itself, and a budget
 * at or above complete demand returns the same bytes as the unbudgeted read.
 */
export function renderTimelineRows(
  rows: readonly ActivityRow[], days: number, projectSlug: string, charBudget?: number,
): string {
  const renderFull = (items: readonly ActivityRow[]): string =>
    items.length === 0
      ? `No events for '${projectSlug}' in last ${days} days.`
      : items.map(timelineRow).join("\n");
  const full = renderFull(rows);
  const minimum = demandCapPrimeMinimum(full, TIMELINE_RECOVERY_MINIMUM);
  if (charBudget === undefined || charBudget >= full.length) return full;
  // The no-event sentence is one indivisible row: a budget under it degrades to
  // the recovery pointer rather than overflowing the source's share.
  if (rows.length === 0) return minimum;
  return budgetRows(
    { fullRows: rows.length, charBudget },
    rows, renderFull, timelineRow, '', 'event', MCP_READ_NARROWING.mai_timeline, minimum,
  );
}

/** One project resolution and ONE `activityRows` query per prepared timeline. */
export async function prepareTimeline(
  days = 30, limit = 40, projectIdOverride?: string,
): Promise<PreparedPrimeText> {
  const projectId = projectIdOverride ?? (await getProjectId());
  const d = boundedInt(days, 30, 1, 36500);
  const rows = await activityRows(d, boundedInt(limit, 40, 1, 1000), projectId);
  const slug = await projectSlugById(projectId);
  const full = renderTimelineRows(rows, d, slug);
  const minimum = demandCapPrimeMinimum(full, TIMELINE_RECOVERY_MINIMUM);
  return {
    minimum,
    full,
    render: (charBudget?: number) => renderTimelineRows(rows, d, slug, charBudget),
  };
}

export async function timeline(days = 30, limit = 40, projectIdOverride?: string): Promise<string> {
  return (await prepareTimeline(days, limit, projectIdOverride)).full;
}

// ---------- Recent sessions ----------

export async function recentSessions(limit = 10, projectIdOverride?: string): Promise<string> {
  const db = getPool();
  const projectId = projectIdOverride ?? (await getProjectId());

  const result = await db.query(
    `SELECT original_session_id, started_at, ended_at, summary,
            commits, duration_minutes
     FROM code_sessions
     WHERE project_id = $1
       -- superseded_by_segmentation rows are provenance, not history (plan 12)
       AND (metadata->>'superseded_by_segmentation') IS DISTINCT FROM 'true'
     ORDER BY started_at DESC NULLS LAST
     LIMIT $2`,
    [projectId, limit]
  );

  if (result.rows.length === 0) {
    return "No sessions recorded.";
  }

  return result.rows
    .map((s: Record<string, unknown>) => {
      const parts: string[] = [
        `- ${s.original_session_id}`,
        `  started: ${s.started_at ? fmtTs(s.started_at as string | Date) : "?"}`,
      ];
      if (s.summary) parts.push(`  summary: ${String(s.summary).slice(0, 300)}`);
      if (s.commits) parts.push(`  commits: ${s.commits}`);
      if (s.duration_minutes) parts.push(`  duration: ${s.duration_minutes}min`);
      return parts.join("\n");
    })
    .join("\n\n");
}

// ---------- Unified search (mai_search backend) ----------

/**
 * Unified search over decisions + lessons. THE token-minting read: agents must
 * call this (or the other read tools) before any Cat A write.
 */
export async function unifiedSearch(args: {
  query: string;
  keywords?: string[];
  kind?: 'decisions' | 'lessons' | 'all';
  limit?: number;
  projectId?: string;
  budget?: ReadBudget;
  includeShares?: boolean;
}): Promise<string> {
  const sections = await unifiedSearchSections(args);
  return budgetSections(args.budget, sections, 'result', MCP_READ_NARROWING.mai_search);
}

/**
 * The preparation half of the token-minting read: every query, read-token
 * record, doc pointer and share lane happens HERE, exactly once. Rendering the
 * returned sections — at any budget, any number of times — repeats none of it
 * (plan 38 R5/R8).
 */
export async function unifiedSearchSections(args: {
  query: string;
  keywords?: string[];
  kind?: 'decisions' | 'lessons' | 'all';
  limit?: number;
  projectId?: string;
  includeShares?: boolean;
}): Promise<ReadSection[]> {
  const kind = args.kind ?? 'all';
  const limit = args.limit ?? 15;
  const sections: ReadSection[] = [];
  // Each lane contributes SECTIONS. The '\n' prefix on every block after the
  // first reproduces the previous `sections.join('\n\n')` byte-for-byte, and
  // the single budgetSections call below makes ONE global row decision across
  // decisions, lessons and doc pointers — never per-subsection.
  const nextPrefix = (): string => (sections.length === 0 ? '' : '\n');
  if (kind === 'decisions' || kind === 'all') {
    const heading = `${nextPrefix()}## Decisions\n`;
    sections.push(...(args.keywords?.length
      ? [await decisionKeywordSection(
          { keywords: args.keywords, limit, projectId: args.projectId }, heading)]
      : await decisionSearchSections(args.query, limit, args.projectId, heading)));
  }
  if (kind === 'lessons' || kind === 'all') {
    const { lessonSearchSections } = await import('./lessons.js');
    const prefix = nextPrefix();
    const lessonSections = await lessonSearchSections(
      { query: args.query, limit, projectId: args.projectId }, prefix);
    // The lessons block always carries its own `## Lessons` label. An empty
    // result has no inner heading, so the label alone supplies the blank line.
    sections.push(...lessonSections.map((s, i) => {
      if (i !== 0) return s;
      const inner = s.heading.replace(/^\n/, '');
      return { ...s, heading: inner ? `${prefix}## Lessons\n\n${inner}` : `${prefix}## Lessons\n` };
    }));
  }
  if (kind === 'all') {
    // Doc-chunk pointer lane (plan 20, spec §6): folded into the search every
    // agent already calls — deliberately NOT a new tool (tool-defs budget; a
    // separate tool only helps agents who remember it exists). Hard cap of 3
    // pointers regardless of `limit`; the section is omitted entirely when
    // nothing matches. mai_prime inherits this section through its own
    // unifiedSearch({ kind: 'all' }) call — one implementation, both surfaces.
    const { docChunksReadSection } = await import('./doc-chunks.js');
    const docs = await docChunksReadSection(args.query, args.projectId ?? (await getProjectId()));
    if (docs) sections.push({ ...docs, heading: `${nextPrefix()}${docs.heading}` });
  }

  if (kind === 'all' && args.includeShares !== false) {
    // Foreign-references lane (plan 31): a separate labelled section, never
    // mixed into the decisions/lessons lanes, and it mints NO read tokens —
    // foreign ids must stay uncitable (spec §7.4). Omitted entirely when no
    // links resolve, so unlinked projects render byte-identically. prime()
    // passes includeShares:false — it renders its own capped shared section
    // and must not pay the resolver twice per prime.
    const { sharesReadSection } = await import('./shares.js');
    const shared = await sharesReadSection(args.query, args.projectId ?? (await getProjectId()));
    if (shared) sections.push({ ...shared, heading: `${nextPrefix()}${shared.heading}` });
  }
  return sections;
}

interface DecisionTrgmHit {
  id: string;
  description: string;
  decision_type: string;
  source: string;
}

async function trgmDecisionHits(
  query: string,
  limit: number,
  projectId: string,
  staleForModel: string | null
): Promise<DecisionTrgmHit[]> {
  const result = await getPool().query<DecisionTrgmHit>(
    `SELECT id, description, decision_type, source
       FROM code_decisions
      WHERE project_id = $1 AND still_valid = true
        AND ($4::text IS NULL OR embedding_model IS DISTINCT FROM $4)
        AND similarity(description, $2) >= 0.15
      ORDER BY similarity(description, $2) DESC
      LIMIT $3`,
    [projectId, query, limit, staleForModel]
  );
  return result.rows;
}

function formatTrgmDecisionHits(hits: DecisionTrgmHit[]): string {
  return hits.map((r) => `- \`${r.id}\` (${r.decision_type}, ${r.source}) ${r.description}`).join('\n');
}

/**
 * Agent-facing decisions search. ONE closed state model (plan 14 R4):
 * semantic unavailable → trigram over all eligible rows; semantic available →
 * current-tag cosine hits PLUS a separate trigram pass over stale/untagged
 * rows, merged under one global result budget.
 */
/**
 * Decision search as SECTIONS (plan 23). `heading` is the caller's first-block
 * label (e.g. `## Decisions\n`); a later block gets a leading '\n' so the
 * composed bytes match the previous `sections.join('\n\n')` exactly.
 */
async function decisionSearchSections(
  query: string, limit: number, projectIdOverride: string | undefined, heading: string,
): Promise<ReadSection[]> {
  const projectId = projectIdOverride ?? (await getProjectId());
  const attempt = await decisionSemanticAttempt({ query, limit, minScore: 0.25, projectId });
  if (attempt.kind === 'unavailable') {
    const fallback = await trgmDecisionHits(query, limit, projectId, null);
    await recordReadResults('decisions', fallback.map((h) => h.id));
    // A trigram row has no body to omit: full and headline are identical.
    const rows = fallback.length > 0
      ? fallback.map((r) => `- \`${r.id}\` (${r.decision_type}, ${r.source}) ${r.description}`)
      : [`No decisions match "${query}".`];
    return [{ heading, fullRows: rows, headlineRows: [...rows] }];
  }

  const { budgetHybridHits } = await import('./embeddings.js');
  const staleCandidates = await trgmDecisionHits(query, limit, projectId, attempt.modelId);
  const selected = budgetHybridHits(attempt.hits, staleCandidates, limit);
  await recordReadResults('decisions', [...selected.semantic, ...selected.stale].map((h) => h.id));
  const sections: ReadSection[] = [];
  if (selected.semantic.length > 0) {
    sections.push({
      heading,
      fullRows: spacedRows(semanticDecisionFullRows(selected.semantic)),
      headlineRows: semanticDecisionHeadlineRows(selected.semantic),
    });
  }
  if (selected.stale.length > 0) {
    const staleRows = selected.stale.map(
      (r) => `- \`${r.id}\` (${r.decision_type}, ${r.source}) ${r.description}`);
    sections.push({
      // With zero semantic rows the stale block IS the first block, so it must
      // carry the caller's heading as well as its own label.
      heading: sections.length === 0
        ? `${heading}\n_Also matched by text — not yet re-embedded with the current model (\`mai embed --rebuild\`):_`
        : '\n_Also matched by text — not yet re-embedded with the current model (`mai embed --rebuild`):_',
      fullRows: staleRows,
      headlineRows: [...staleRows],
    });
  }
  return sections;
}
