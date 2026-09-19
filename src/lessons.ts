// Origin: forked from the Mai Group's predecessor memory server (private).
import { getPool, getProjectId } from './db.js';
import { embed, embedQuery, embeddingsEnabled, cosineSim, currentEmbeddingModelId, dedupCosineThreshold } from './embeddings.js';
import { recordReadResults, verifyCatA, enforceCharLimits, recordWriteSuccess, type CitationKind } from './write-gate.js';
import type { SqlRunner } from './curation.js';
import {
  budgetSections, headlineField, MCP_READ_NARROWING, type ReadSection,
} from './read-budget.js';

const SIMILARITY_THRESHOLD_TRGM = 0.50;     // First-pass pg_trgm filter
export const REINFORCEMENT_BUMP = 0.05;     // Confidence increment per reinforcement
export const MAX_CONFIDENCE = 1.0;
const MIN_CONFIDENCE = 0.0;
const MAX_DEDUP_CANDIDATES = 5;

interface LessonRow {
  id: string;
  rule: string;
  confidence_score: number;
  reinforcement_count: number;
  embedding: number[] | null;
  embedding_model: string | null;
}

export interface LessonAddArgs {
  rule: string;
  citation: CitationKind;
  context?: string;
  why?: string;
  howToApply?: string;
  expectedOutcome?: string;
  actualOutcome?: string;
  tags?: string[];
  initialConfidence?: number;
}

/** High-confidence lexical dedup for rows cosine cannot compare. */
async function trgmCandidateMatch(rule: string, candidate: LessonRow): Promise<LessonRow | null> {
  const pool = getPool();
  const trgmSim = await pool.query<{ sim: number }>(
    `SELECT similarity(rule, $1) as sim FROM lessons WHERE id = $2`,
    [rule, candidate.id]
  );
  return trgmSim.rows[0].sim >= 0.80 ? candidate : null;
}

/**
 * Find a safe dedup match among the five strongest pg_trgm candidates.
 *
 * State matrix:
 * 1. Provider/query unavailable: high-confidence trigram over all candidates.
 * 2. Provider/query available: current-model rows may match only by cosine at
 *    dedupCosineThreshold(); stale/untagged rows may match by high trigram.
 * 3. A current-model row rejected by cosine is never re-accepted by trigram.
 *
 * Globals remain eligible so a project lesson cannot duplicate a global rule.
 */
async function findSimilarLesson(projectId: string, rule: string): Promise<LessonRow | null> {
  const pool = getPool();

  const candidates = await pool.query<LessonRow>(
    `SELECT id, rule, confidence_score, reinforcement_count, embedding, embedding_model
     FROM lessons
     WHERE (project_id = $1 OR project_id IS NULL)
       AND superseded_by IS NULL
       AND retired_at IS NULL
       AND similarity(rule, $2) >= $3
     ORDER BY similarity(rule, $2) DESC
     LIMIT $4`,
    [projectId, rule, SIMILARITY_THRESHOLD_TRGM, MAX_DEDUP_CANDIDATES]
  );

  if (candidates.rows.length === 0) return null;

  // With no usable semantic comparison, preserve today's conservative
  // high-threshold trigram dedup over all candidates.
  if (!embeddingsEnabled()) return trgmCandidateMatch(rule, candidates.rows[0]);
  const newEmbedding = await embed(rule);
  if (!newEmbedding) return trgmCandidateMatch(rule, candidates.rows[0]);

  const current = currentEmbeddingModelId();
  if (!current) return trgmCandidateMatch(rule, candidates.rows[0]);

  let bestSim = 0;
  let best: LessonRow | null = null;
  for (const cand of candidates.rows) {
    if (!cand.embedding || cand.embedding.length === 0 || cand.embedding_model !== current) continue;
    const sim = cosineSim(newEmbedding, cand.embedding);
    if (sim > bestSim && sim >= dedupCosineThreshold()) {
      bestSim = sim;
      best = cand;
    }
  }
  if (best) return best;

  // Cosine has authoritatively rejected every CURRENT-tag candidate. Never
  // re-accept one through trigram: that would bypass the calibrated threshold
  // and can silently reinforce the wrong rule. The lexical fallback now covers
  // only rows cosine could not compare.
  const staleTop = candidates.rows.find((cand) => cand.embedding_model !== current);
  return staleTop ? trgmCandidateMatch(rule, staleTop) : null;
}

/**
 * Compute initial confidence. Explicit initialConfidence (clamped) when provided,
 * else a flat 0.50 base — the source thought/task bumps referenced dropped columns.
 */
function computeInitialConfidence(args: LessonAddArgs): number {
  if (args.initialConfidence !== undefined) {
    return Math.max(MIN_CONFIDENCE, Math.min(args.initialConfidence, MAX_CONFIDENCE));
  }
  return 0.50;
}

/**
 * THE one lesson-reinforcement implementation (plan 22). Both callers use it:
 * `lessonAdd`'s near-duplicate branch (wired in Task 3) and citation
 * reinforcement (spec §6 — "citation reinforcement extends that path; it does
 * not invent a second one").
 *
 * The arithmetic is done in SQL, not JS, and that is LOAD-BEARING: node-postgres
 * returns numeric/DECIMAL columns as STRINGS (probed live on the 54334 PG 17.9:
 * typeof row.confidence_score === 'string'). The previous JS form,
 * Math.min(similar.confidence_score + REINFORCEMENT_BUMP, MAX_CONFIDENCE),
 * evaluates to Math.min("0.500.05", 1) => NaN. It had never fired in the live
 * brain (0 of 528 lessons had reinforcement_count > 0), but citation
 * reinforcement fires it on every cited lesson, so the trap is closed here once.
 *
 * `exec` is the pool for the dedup path and the citing write's TRANSACTION
 * CLIENT for the citation path — one implementation, both call sites.
 */
/**
 * `opts.relearned` (plan 27 §3.1): ONLY the dedup caller passes true — an agent
 * tried to add this lesson again and dedup caught it. The citation path
 * (bumpCited) must never set it: relearned_count is the graduation signal, and
 * merging it with citation is exactly the reinforcement_count mistake this
 * column exists to undo (decision 04c4848b).
 */
export async function reinforceLesson(
  exec: SqlRunner,
  lessonId: string,
  opts: { relearned?: boolean } = {}
): Promise<{ confidenceScore: number; reinforcementCount: number; relearnedCount: number } | null> {
  const r = await exec.query<{
    confidence_score: string; reinforcement_count: number; relearned_count: number;
  }>(
    `UPDATE lessons
        SET reinforcement_count = reinforcement_count + 1,
            relearned_count = relearned_count + (CASE WHEN $4::boolean THEN 1 ELSE 0 END),
            confidence_score = LEAST(confidence_score + $2::numeric, $3::numeric),
            updated_at = NOW()
      WHERE id = $1
      RETURNING confidence_score, reinforcement_count, relearned_count`,
    [lessonId, REINFORCEMENT_BUMP, MAX_CONFIDENCE, opts.relearned === true]
  );
  const row = r.rows[0];
  if (!row) return null;
  return {
    confidenceScore: Number(row.confidence_score),
    reinforcementCount: Number(row.reinforcement_count),
    relearnedCount: Number(row.relearned_count),
  };
}

/**
 * Operator-only lesson retirement (plan 22 ambiguity 3). Lessons had no
 * retirement path — only `superseded_by`, which needs a replacement — and spec
 * §5.1's retire action plus §10.3's every-project consequence require one.
 * NO AGENT VERB REACHES THIS: its only callers are `curationRetire` /
 * `curationApply`, which are only reachable from the /api/curation/* routes.
 *
 * `exec` lets the verdict routes run this INSIDE the transaction that also
 * closes the proposal, so the retire and its bookkeeping land together or not
 * at all (plan 22 ambiguity 7). It defaults to the pool for any direct caller.
 */
export async function lessonRetire(
  lessonId: string,
  reason: string,
  projectIdOverride?: string,
  exec?: SqlRunner
): Promise<string> {
  await enforceCharLimits({ fields: { reason }, toolName: 'mai_curation_retire' });
  const trimmed = reason.trim();
  if (!trimmed) throw new Error('reason is required — retiring without a stated reason is not allowed');
  const projectId = projectIdOverride ?? (await getProjectId());
  const runner: SqlRunner = exec ?? getPool();
  const r = await runner.query<{ id: string; rule: string; project_id: string | null }>(
    `UPDATE lessons
        SET retired_at = NOW(), retirement_reason = $2, updated_at = NOW()
      WHERE id = $1 AND (project_id = $3 OR project_id IS NULL) AND retired_at IS NULL
      RETURNING id, rule, project_id`,
    [lessonId, trimmed, projectId]
  );
  if (r.rows.length === 0) return `No live lesson with id ${lessonId} reachable from this project.`;
  const row = r.rows[0];
  const scope = row.project_id === null ? ' (GLOBAL — removed from every project)' : '';
  return `Retired lesson ${row.id.slice(0, 8)}${scope}: "${row.rule}" — reason: ${trimmed}`;
}

export async function lessonUnretire(
  lessonId: string,
  projectIdOverride?: string,
  exec?: SqlRunner
): Promise<string> {
  const projectId = projectIdOverride ?? (await getProjectId());
  const runner: SqlRunner = exec ?? getPool();
  const r = await runner.query<{ id: string; rule: string }>(
    `UPDATE lessons
        SET retired_at = NULL, retirement_reason = NULL, updated_at = NOW()
      WHERE id = $1 AND (project_id = $2 OR project_id IS NULL)
      RETURNING id, rule`,
    [lessonId, projectId]
  );
  if (r.rows.length === 0) return `No lesson with id ${lessonId} reachable from this project.`;
  return `Restored lesson ${r.rows[0].id.slice(0, 8)}: "${r.rows[0].rule}"`;
}

export async function lessonAdd(args: LessonAddArgs): Promise<string> {
  await enforceCharLimits({
    fields: {
      rule: args.rule,
      context: args.context ?? '',
      why: args.why ?? '',
      howToApply: args.howToApply ?? '',
      expectedOutcome: args.expectedOutcome ?? '',
      actualOutcome: args.actualOutcome ?? '',
    },
    toolName: 'mai_lesson_add',
  });

  const cited = await verifyCatA({
    bucket: 'lessons',
    citation: args.citation,
    payloadFingerprint: args.rule,
    toolName: 'mai_lesson_add',
  });

  const pool = getPool();
  const projectId = await getProjectId();

  // Step 1: Check for similar existing lesson
  const similar = await findSimilarLesson(projectId, args.rule);

  if (similar) {
    // A validated relation to the row dedup selected would be a self-edge.
    // Reject it explicitly: silently dropping it loses a load-bearing signal,
    // while recording self-extends/self-supersedes lies about the graph.
    if (cited?.citedId === similar.id) {
      throw new Error(
        `Citation target ${cited.citedId} is the same near-duplicate lesson this write would reinforce. ` +
        `Use a novel citation to reinforce that rule, or cite a different lesson.`
      );
    }
    // The dedup reinforcement and any validated citation are ONE transaction.
    // Pass-5 finding 9e3c019c proved the old early return discarded `cited`
    // entirely; a NUL-reason discriminator now proves neither target moves if
    // recordCitation fails after BEGIN.
    const { recordCitation } = await import('./curation.js');
    const client = await pool.connect();
    let conf = Number(similar.confidence_score);
    let count = Number(similar.reinforcement_count);
    try {
      await client.query('BEGIN');
      if (cited) {
        await recordCitation(client, projectId, {
          citingKind: 'lesson',
          citingId: similar.id,
          citedKind: cited.citedKind,
          citedId: cited.citedId,
          relation: cited.relation,
          reason: cited.reason,
          sessionTokenId: cited.sessionTokenId,
          source: 'agent-inferred',
        });
      }
      const bumped = await reinforceLesson(client, similar.id, { relearned: true });
      if (!bumped) throw new Error(`Near-duplicate lesson ${similar.id} disappeared before reinforcement.`);
      conf = bumped.confidenceScore;
      count = bumped.reinforcementCount;
      await client.query('COMMIT');
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }
    await recordWriteSuccess();
    return `Reinforced existing lesson (id=${similar.id.slice(0, 8)}): "${similar.rule}" — count=${count}, confidence=${conf.toFixed(2)}`;
  }

  // Step 2: Insert new lesson — vector + tag land ATOMICALLY in the INSERT
  // (plan 14: replaces the old INSERT + untagged post-INSERT UPDATE). The
  // EMBEDDING is computed BEFORE BEGIN (the reviewPost ordering rule): a cold
  // local model costs up to 20s and must never sit inside a transaction.
  const initialConf = computeInitialConfidence(args);
  const newVec = embeddingsEnabled() ? await embed(args.rule) : null;
  const { recordCitation } = await import('./curation.js');
  const client = await pool.connect();
  let newId = '';
  try {
    await client.query('BEGIN');
    const newRow = await client.query<{ id: string }>(
      `INSERT INTO lessons
         (project_id, rule, context, why, how_to_apply,
          expected_outcome, actual_outcome, tags, confidence_score,
          embedding, embedding_model)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8::text[], $9, $10, $11)
       RETURNING id`,
      [
        projectId,
        args.rule,
        args.context ?? null,
        args.why ?? null,
        args.howToApply ?? null,
        args.expectedOutcome ?? null,
        args.actualOutcome ?? null,
        args.tags ?? [],
        initialConf,
        newVec,
        newVec ? currentEmbeddingModelId() : null,
      ]
    );
    newId = newRow.rows[0].id;
    // The citation the gate validated and used to discard (spec §2.2). SAME
    // transaction as the insert: a write that fails after gate approval must
    // not manufacture a load-bearing signal (spec §2.3). A lesson write is
    // always agent-sourced, so a supersedes citation here files as 'proposed'.
    if (cited) {
      await recordCitation(client, projectId, {
        citingKind: 'lesson',
        citingId: newId,
        citedKind: cited.citedKind,
        citedId: cited.citedId,
        relation: cited.relation,
        reason: cited.reason,
        sessionTokenId: cited.sessionTokenId,
        source: 'agent-inferred',
      });
    }
    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }

  await recordWriteSuccess();
  return `Added lesson (id=${newId.slice(0, 8)}): "${args.rule}" — confidence=${initialConf.toFixed(2)}`;
}

export interface LessonSearchArgs {
  query?: string;
  tags?: string[];
  limit?: number;
  minConfidenceScore?: number;
  /** Show metadata (confidence label/score, reinforcement count, tags). Default false. */
  verbose?: boolean;
  /** Surfaces-only explicit project override (CLI/web). Tools never pass this. */
  projectId?: string;
}

/**
 * Lesson search. Three modes:
 *   1. With query + embeddings enabled → semantic ranking via cosine.
 *   2. With query + embeddings disabled → pg_trgm similarity ranking.
 *   3. Without query → most-confident first.
 *
 * Always includes globals (project_id IS NULL) alongside this project's lessons.
 * Filters: tags, min_confidence_score.
 */
/** The empty-result message is a section with NO heading, so the rendered
 * bytes are exactly the message the string callers already return. */
function lessonMessageSection(message: string): ReadSection {
  return { heading: '', fullRows: [message], headlineRows: [message] };
}

/**
 * Lesson search as SECTIONS (plan 23). unifiedSearch collects these and makes
 * ONE global row decision across decisions + lessons + doc pointers; the string
 * wrapper below preserves today's CLI/direct bytes exactly.
 * `headingPrefix` is '' standalone and '\n' when composed after another block.
 */
export async function lessonSearchSections(
  args: LessonSearchArgs, headingPrefix = '',
): Promise<ReadSection[]> {
  const pool = getPool();
  const projectId = args.projectId ?? (await getProjectId());
  const limit = args.limit ?? 20;
  const minConf = args.minConfidenceScore ?? 0.20;

  const conditions: string[] = [
    '(project_id = $1 OR project_id IS NULL)',
    'superseded_by IS NULL',
    // A retired lesson is gone from every read AND from dedup (plan 22): it
    // must stop being returned, stop being a reinforcement target, and stop
    // being re-asked in candidacy.
    'retired_at IS NULL',
    'confidence_score >= $2',
  ];
  const params: unknown[] = [projectId, minConf];
  let p = 3;

  if (args.tags && args.tags.length > 0) {
    conditions.push(`tags && $${p}::text[]`);
    params.push(args.tags);
    p++;
  }

  // No query → straight ranking by confidence
  if (!args.query) {
    params.push(limit);
    const result = await pool.query<{
      id: string;
      rule: string;
      project_id: string | null;
      confidence_label: string;
      confidence_score: number;
      reinforcement_count: number;
      tags: string[];
    }>(
      `SELECT id, rule, project_id, confidence_label, confidence_score, reinforcement_count, tags
       FROM lessons
       WHERE ${conditions.join(' AND ')}
       ORDER BY confidence_score DESC, reinforcement_count DESC, updated_at DESC
       LIMIT $${p}`,
      params
    );
    await recordReadResults('lessons', result.rows.map((r) => r.id));
    if (result.rows.length === 0) return [lessonMessageSection('No lessons found.')];
    return [lessonResultSection(result.rows, args.query, args.verbose, undefined, headingPrefix)];
  }

  // Query + embeddings → semantic ranking
  if (embeddingsEnabled()) {
    const queryEmbedding = await embedQuery(args.query);
    const current = currentEmbeddingModelId();
    if (queryEmbedding && current) {
      const widePool = Math.max(limit * 5, 50);
      type SearchRow = {
        id: string;
        rule: string;
        project_id: string | null;
        confidence_label: string;
        confidence_score: number;
        reinforcement_count: number;
        tags: string[];
        embedding: number[] | null;
        embedding_model: string | null;
      };
      // IMPORTANT: no trigram predicate/order here. A lexical prefilter would
      // remove low-overlap semantic matches before cosine sees them.
      const candidates = await pool.query<SearchRow>(
        `SELECT id, rule, project_id, confidence_label, confidence_score, reinforcement_count, tags,
                embedding, embedding_model
         FROM lessons
         WHERE ${conditions.join(' AND ')} AND embedding IS NOT NULL AND embedding_model = $${p}
         ORDER BY confidence_score DESC
         LIMIT $${p + 1}`,
        [...params, current, widePool]
      );
      const scored = candidates.rows
        .map((r) => ({
          row: r,
          sim: r.embedding && r.embedding.length > 0 ? cosineSim(queryEmbedding, r.embedding) : 0,
        }))
        .filter((s) => s.sim > 0)
        .sort((a, b) => b.sim - a.sim)
        .slice(0, limit)
        .map((s) => s.row);
      if (scored.length > 0) {
        const stale = await pool.query<SearchRow>(
          `SELECT id, rule, project_id, confidence_label, confidence_score, reinforcement_count, tags,
                  embedding, embedding_model
             FROM lessons
            WHERE ${conditions.join(' AND ')}
              AND embedding_model IS DISTINCT FROM $${p}
              AND similarity(rule, $${p + 1}) >= 0.20
            ORDER BY similarity(rule, $${p + 1}) DESC, confidence_score DESC
            LIMIT $${p + 2}`,
          [...params, current, args.query, limit]
        );
        const { budgetHybridHits } = await import('./embeddings.js');
        const selected = budgetHybridHits(scored, stale.rows, limit);
        await recordReadResults('lessons', [...selected.semantic, ...selected.stale].map((r) => r.id));
        const sections: ReadSection[] = [];
        if (selected.semantic.length > 0) {
          sections.push(lessonResultSection(
            selected.semantic, args.query, args.verbose, undefined, headingPrefix));
        }
        if (selected.stale.length > 0) {
          sections.push(lessonResultSection(
            selected.stale,
            args.query,
            args.verbose,
            '_Also matched by text — not yet re-embedded with the current model (`mai embed --rebuild`):_',
            sections.length === 0 ? headingPrefix : '\n',
          ));
        }
        return sections;
      }
      // No semantic hit → unrestricted trigram branch below.
    }
  }

  // Query + no embeddings → pg_trgm similarity
  conditions.push(`similarity(rule, $${p}) >= 0.20`);
  params.push(args.query);
  p++;
  params.push(args.query);
  const trgmSimParam = p++;
  params.push(limit);
  const result = await pool.query<{
    id: string;
    rule: string;
    project_id: string | null;
    confidence_label: string;
    confidence_score: number;
    reinforcement_count: number;
    tags: string[];
  }>(
    `SELECT id, rule, project_id, confidence_label, confidence_score, reinforcement_count, tags
     FROM lessons
     WHERE ${conditions.join(' AND ')}
     ORDER BY similarity(rule, $${trgmSimParam}) DESC, confidence_score DESC
     LIMIT $${p}`,
    params
  );
  await recordReadResults('lessons', result.rows.map((r) => r.id));
  if (result.rows.length === 0) {
    return [lessonMessageSection(
      args.query ? `No lessons match query: "${args.query}"` : 'No lessons found.')];
  }
  return [lessonResultSection(result.rows, args.query, args.verbose, undefined, headingPrefix)];
}

/** The unbudgeted string surface: byte-identical to the pre-plan-23 render. */
export async function lessonSearch(args: LessonSearchArgs): Promise<string> {
  return budgetSections(
    undefined, await lessonSearchSections(args), 'lesson', MCP_READ_NARROWING.mai_search);
}

export type LessonResultRow = {
  id: string;
  rule: string;
  project_id: string | null;
  confidence_label: string;
  confidence_score: number;
  reinforcement_count: number;
  tags: string[];
};

/**
 * The section shape behind every lesson render (plan 23). `headingPrefix` is
 * '' for the first block and '\n' for a later one, which reproduces the
 * `sections.join('\n\n')` bytes the string callers have always emitted.
 * The headline drops verbose metadata and one-lines the rule; the id and scope
 * are identity and are never truncated.
 */
function lessonResultSection(
  rows: LessonResultRow[],
  query?: string,
  verbose?: boolean,
  heading?: string,
  headingPrefix = '',
): ReadSection {
  const header = heading ?? (query ? `# Lessons matching "${query}"` : '# Lessons');
  const fullRows: string[] = [];
  const headlineRows: string[] = [];
  for (const r of rows) {
    const scope = r.project_id === null ? '(global)' : '';
    const suffix = scope ? ` ${scope}` : '';
    if (verbose) {
      const tagsStr = r.tags && r.tags.length > 0 ? ` _[${r.tags.join(', ')}]_` : '';
      fullRows.push(
        `- \`${r.id}\` **${r.rule}**${suffix} — ${r.confidence_label} ${r.confidence_score}, reinforced ×${r.reinforcement_count}${tagsStr}`
      );
    } else {
      fullRows.push(`- \`${r.id}\` **${r.rule}**${suffix}`);
    }
    headlineRows.push(`- \`${r.id}\` **${headlineField(r.rule)}**${suffix}`);
  }
  // heading carries a trailing newline so the first row renders after a blank
  // line, exactly as the previous `[header, '', ...rows]` shape did.
  return { heading: `${headingPrefix}${header}\n`, fullRows, headlineRows };
}

function formatLessonResults(
  rows: LessonResultRow[],
  query?: string,
  verbose?: boolean,
  heading?: string
): string {
  if (rows.length === 0) {
    return query ? `No lessons match query: "${query}"` : 'No lessons found.';
  }
  return budgetSections(undefined, [lessonResultSection(rows, query, verbose, heading)], 'lesson',
    MCP_READ_NARROWING.mai_search);
}

export async function lessonSupersede(args: {
  oldId: string;
  newId: string;
  reason: string;
  projectId?: string;
}): Promise<string> {
  await enforceCharLimits({
    fields: { reason: args.reason },
    toolName: 'mai_lesson_supersede',
  });

  const pool = getPool();
  const projectId = args.projectId ?? (await getProjectId());

  const exists = await pool.query<{ id: string }>(
    `SELECT id FROM lessons WHERE id IN ($1, $2) AND (project_id = $3 OR project_id IS NULL)`,
    [args.oldId, args.newId, projectId]
  );
  if (exists.rows.length < 2) {
    return `One or both lessons not found (oldId=${args.oldId.slice(0, 8)}, newId=${args.newId.slice(0, 8)}).`;
  }

  await pool.query(
    `UPDATE lessons
     SET superseded_by = $1,
         updated_at = NOW(),
         context = COALESCE(context, '') || E'\n\n[superseded ' || NOW()::text || ']: ' || $2
     WHERE id = $3 AND (project_id = $4 OR project_id IS NULL)`,
    [args.newId, args.reason, args.oldId, projectId]
  );

  return `Superseded ${args.oldId.slice(0, 8)} → ${args.newId.slice(0, 8)}: ${args.reason}`;
}

/**
 * Adjust a lesson's confidence by a delta, with an audit trail in metadata.
 * (Renamed from kai's lessonPromote — distinct from decision promotion.)
 */
export async function lessonConfidence(args: {
  lessonId: string;
  deltaScore: number;
  reason: string;
  projectId?: string;
}): Promise<string> {
  await enforceCharLimits({
    fields: { reason: args.reason },
    toolName: 'mai_lesson_confidence',
  });

  const pool = getPool();
  const projectId = args.projectId ?? (await getProjectId());

  const current = await pool.query<{ confidence_score: number; metadata: Record<string, unknown> | null }>(
    `SELECT confidence_score, metadata FROM lessons WHERE id = $1 AND (project_id = $2 OR project_id IS NULL)`,
    [args.lessonId, projectId]
  );
  if (current.rows.length === 0) {
    return `Lesson not found: ${args.lessonId}`;
  }

  const oldScore = Number(current.rows[0].confidence_score);
  const newScore = Math.max(MIN_CONFIDENCE, Math.min(oldScore + args.deltaScore, MAX_CONFIDENCE));

  // Audit trail in metadata
  const auditEntry = {
    at: new Date().toISOString(),
    delta: args.deltaScore,
    reason: args.reason,
    from: oldScore,
    to: newScore,
  };

  await pool.query(
    `UPDATE lessons
     SET confidence_score = $1,
         metadata = COALESCE(metadata, '{}'::jsonb) || jsonb_build_object('promotions', COALESCE(metadata->'promotions', '[]'::jsonb) || $2::jsonb),
         updated_at = NOW()
     WHERE id = $3 AND (project_id = $4 OR project_id IS NULL)`,
    [newScore, JSON.stringify([auditEntry]), args.lessonId, projectId]
  );

  return `Adjusted ${args.lessonId.slice(0, 8)}: ${oldScore.toFixed(2)} → ${newScore.toFixed(2)} (Δ${args.deltaScore >= 0 ? '+' : ''}${args.deltaScore}). Reason: ${args.reason}`;
}

/**
 * Move a project lesson to the global layer (project_id = NULL).
 * APPROVAL-GATED at the tool layer: only call after the user explicitly approves.
 * Keeps reinforcement history; stamps an audit entry in metadata.
 */
export async function lessonGlobalize(lessonId: string, reason: string, projectIdOverride?: string): Promise<string> {
  await enforceCharLimits({ fields: { reason }, toolName: 'mai_globalize' });
  const pool = getPool();
  const projectId = projectIdOverride ?? (await getProjectId());
  const row = await pool.query<{ id: string; rule: string; project_id: string | null }>(
    `SELECT id, rule, project_id FROM lessons WHERE id = $1`,
    [lessonId]
  );
  if (row.rows.length === 0) return `Lesson not found: ${lessonId}`;
  if (row.rows[0].project_id === null) return `Lesson ${lessonId.slice(0, 8)} is already global.`;
  if (row.rows[0].project_id !== projectId) {
    return `Lesson ${lessonId.slice(0, 8)} belongs to a different project — cannot globalize from here.`;
  }
  const audit = { at: new Date().toISOString(), from_project: projectId, reason };
  await pool.query(
    `UPDATE lessons
     SET project_id = NULL,
         metadata = COALESCE(metadata, '{}'::jsonb) || jsonb_build_object('globalized', $1::jsonb),
         updated_at = NOW()
     WHERE id = $2`,
    [JSON.stringify(audit), lessonId]
  );
  // A promoted project lesson ceases to qualify when it becomes global.
  // Refresh the ORIGIN project after the committed update so stale rule text
  // cannot outlive the DB projection. Best-effort, like every other writer;
  // init/upgrade remains the healing path.
  try {
    const { writeGraduatedRulesBlocks } = await import('./rules-render.js');
    await writeGraduatedRulesBlocks(projectId);
  } catch {
    // best-effort; the next render catches up
  }
  return `Globalized lesson ${lessonId.slice(0, 8)}: "${row.rows[0].rule}" — now readable by all projects.`;
}
