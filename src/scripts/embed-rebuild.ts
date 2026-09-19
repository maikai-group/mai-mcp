// Re-embed decisions + lessons with the CURRENT provider (plan 14 spec §4).
// Fixes historic gaps: provider switches (mismatched tags) and lessons rows
// embedded before tagging existed.
import { getPool, resolveProjectId } from '../db.js';
import { embed, embeddingsEnabled, embeddingsStatus, currentEmbeddingModelId } from '../embeddings.js';

const BATCH = 25;

export interface RebuildReport {
  decisionsRebuilt: number;
  lessonsRebuilt: number;
  findingsRebuilt: number;
  chunksRebuilt: number;
  codeFindingsRebuilt: number;
  skippedCurrent: number;
  unembeddable: number;
  modelId: string;
  /** Human-readable decisions scope — the default is the WIDEST possible
   * action (every project), so it is stated in the report rather than assumed
   * (pass-5 W5). */
  scope: string;
}

export interface RebuildOpts {
  projectSlug?: string;
  /** TEST SEAM (review B2 — the plan-13 UpgradeArgs.consentEnvFile precedent):
   * lessons are GLOBAL, so an unscoped test run against the shared brain would
   * rewrite EVERY real lesson's vector with the injected fake and tag it
   * current. Tests pass a LIKE pattern to confine the lessons half;
   * production callers never set it. */
  lessonRuleLike?: string;
  /** Per-batch progress sink (pass-6 W8). Injected, not console.log, so tests
   * stay silent and the CLI owns its own stdout. */
  onProgress?: (line: string) => void;
}

export async function runEmbedRebuild(opts: RebuildOpts): Promise<string> {
  const onProgress = opts.onProgress;
  if (!embeddingsEnabled()) {
    return `Cannot rebuild — embeddings ${embeddingsStatus()}`;
  }
  const modelId = currentEmbeddingModelId();
  if (!modelId) return 'Cannot rebuild — no embedding provider resolved.';
  const pool = getPool();
  const projectId = opts.projectSlug ? await resolveProjectId(opts.projectSlug) : null;
  const lessonLike = opts.lessonRuleLike ?? null;

  // Assign this command its TIMEOUT TIER on purpose (pass-6 B1). embed() routes
  // to the 20s LAZY bound; a bulk rebuild on a machine that never fetched the
  // model would blow it on row 1, arm the 60s cooldown, null every remaining
  // row, and abort with "provider appears down" — blaming the provider for a
  // cold cache. That state is not hypothetical: downloadNow() creates it on any
  // failed init-time fetch, and `mai embed --rebuild` is the ONLY surface that
  // can then populate the corpus. downloadLocalModel() uses the 180s bound and
  // zeroes the cooldown, so one prefetch makes every subsequent embed() instant.
  if (modelId.startsWith('local:')) {
    const { downloadLocalModel } = await import('../embeddings.js');
    if (!(await downloadLocalModel())) {
      return `Cannot rebuild — ${embeddingsStatus()}`;
    }
  }

  const report: RebuildReport = {
    decisionsRebuilt: 0, lessonsRebuilt: 0, findingsRebuilt: 0, chunksRebuilt: 0, codeFindingsRebuilt: 0, skippedCurrent: 0, unembeddable: 0, modelId,
    scope: opts.projectSlug ? `project: ${opts.projectSlug}` : 'ALL projects',
  };
  // Un-embeddable rows are EXCLUDED from later batches, not retried (review
  // W1: aborting re-selects the same poison row at the same batch position
  // forever — the old "re-run to continue" claim was false). In-memory only:
  // a fresh run retries them. Total-outage still aborts fast (see below).
  // SEPARATE per-table lists (pass-6 W3): one shared array fed decision ids
  // into the lessons query's `NOT (id = ANY(...))` and vice versa — harmless
  // (uuid collision is not a real risk) but semantically wrong and unbounded
  // across both halves.
  const failedDecisions: string[] = [];
  const failedLessons: string[] = [];
  const failedFindings: string[] = [];
  const failedChunks: string[] = [];
  const failedCodeFindings: string[] = [];

  // Decisions (project-scoped when --project given; else ALL projects).
  for (;;) {
    const rows = await pool.query<{ id: string; description: string; reasoning: string | null; keywords: string[] | null }>(
      `SELECT id, description, reasoning, keywords FROM code_decisions
        WHERE embedding_model IS DISTINCT FROM $1
          AND ($2::uuid IS NULL OR project_id = $2)
          AND NOT (id = ANY($3::uuid[]))
        ORDER BY timestamp LIMIT ${BATCH}`,
      [modelId, projectId, failedDecisions]
    );
    if (rows.rows.length === 0) break;
    for (const r of rows.rows) {
      const src = [r.description, r.reasoning ?? '', ...(r.keywords ?? [])].filter(Boolean).join(' | ');
      const vec = await embed(src);
      if (!vec) { failedDecisions.push(r.id); report.unembeddable++; continue; }
      await pool.query(`UPDATE code_decisions SET embedding = $1, embedding_model = $2 WHERE id = $3`, [vec, modelId, r.id]);
      report.decisionsRebuilt++;
    }
    // On-CPU embedding of a fleet-wide corpus is minutes of silence otherwise
    // (pass-6 W8) — one line per batch so the operator can see it moving.
    onProgress?.(`  … ${report.decisionsRebuilt} decision(s) re-embedded`);
    // Provider fully down ≠ a poison row: zero successes after a whole batch
    // of attempts means every remaining row would burn a doomed call — abort.
    if (report.decisionsRebuilt + report.lessonsRebuilt + report.findingsRebuilt + report.chunksRebuilt + report.codeFindingsRebuilt === 0 && report.unembeddable >= BATCH) {
      return `${format(report)}\nABORTED: provider appears down (${embeddingsStatus()}) — nothing embedded after ${report.unembeddable} attempts.`;
    }
  }
  // Lessons (global — not project-scoped; the test seam may confine).
  for (;;) {
    const rows = await pool.query<{ id: string; rule: string }>(
      `SELECT id, rule FROM lessons
        WHERE embedding_model IS DISTINCT FROM $1
          AND ($2::text IS NULL OR rule LIKE $2)
          AND NOT (id = ANY($3::uuid[]))
        ORDER BY created_at LIMIT ${BATCH}`,
      [modelId, lessonLike, failedLessons]
    );
    if (rows.rows.length === 0) break;
    for (const r of rows.rows) {
      const vec = await embed(r.rule);
      if (!vec) { failedLessons.push(r.id); report.unembeddable++; continue; }
      await pool.query(`UPDATE lessons SET embedding = $1, embedding_model = $2 WHERE id = $3`, [vec, modelId, r.id]);
      report.lessonsRebuilt++;
    }
    onProgress?.(`  … ${report.lessonsRebuilt} lesson(s) re-embedded`);
    if (report.decisionsRebuilt + report.lessonsRebuilt + report.findingsRebuilt + report.chunksRebuilt + report.codeFindingsRebuilt === 0 && report.unembeddable >= BATCH) {
      return `${format(report)}\nABORTED: provider appears down (${embeddingsStatus()}) — nothing embedded after ${report.unembeddable} attempts.`;
    }
  }
  // Plan findings (project-scoped like decisions). Passage shape MUST match
  // what reviewPost embeds — `${title}. ${issue}` — or rebuilt vectors would
  // score differently from freshly-stored ones.
  for (;;) {
    const rows = await pool.query<{ id: string; title: string; issue: string }>(
      `SELECT id, title, issue FROM plan_findings
        WHERE embedding_model IS DISTINCT FROM $1
          AND ($2::uuid IS NULL OR project_id = $2)
          AND NOT (id = ANY($3::uuid[]))
        ORDER BY created_at LIMIT ${BATCH}`,
      [modelId, projectId, failedFindings]
    );
    if (rows.rows.length === 0) break;
    for (const r of rows.rows) {
      const vec = await embed(`${r.title}. ${r.issue}`);
      if (!vec) { failedFindings.push(r.id); report.unembeddable++; continue; }
      await pool.query(`UPDATE plan_findings SET embedding = $1, embedding_model = $2 WHERE id = $3`, [vec, modelId, r.id]);
      report.findingsRebuilt++;
    }
    onProgress?.(`  … ${report.findingsRebuilt} finding(s) re-embedded`);
    if (report.decisionsRebuilt + report.lessonsRebuilt + report.findingsRebuilt + report.chunksRebuilt + report.codeFindingsRebuilt === 0 && report.unembeddable >= BATCH) {
      return `${format(report)}\nABORTED: provider appears down (${embeddingsStatus()}) — nothing embedded after ${report.unembeddable} attempts.`;
    }
  }
  // Code findings (project-scoped like plan findings). Passage shape MUST match
  // what codeFindingAdd embeds — `${title}. ${issue}` — or rebuilt vectors would
  // score differently from freshly-stored ones at findingsQuery's semantic site.
  for (;;) {
    const rows = await pool.query<{ id: string; title: string; issue: string }>(
      `SELECT id, title, issue FROM code_findings
        WHERE embedding_model IS DISTINCT FROM $1
          AND ($2::uuid IS NULL OR project_id = $2)
          AND NOT (id = ANY($3::uuid[]))
        ORDER BY created_at LIMIT ${BATCH}`,
      [modelId, projectId, failedCodeFindings]
    );
    if (rows.rows.length === 0) break;
    for (const r of rows.rows) {
      const vec = await embed(`${r.title}. ${r.issue}`);
      if (!vec) { failedCodeFindings.push(r.id); report.unembeddable++; continue; }
      await pool.query(`UPDATE code_findings SET embedding = $1, embedding_model = $2 WHERE id = $3`, [vec, modelId, r.id]);
      report.codeFindingsRebuilt++;
    }
    onProgress?.(`  … ${report.codeFindingsRebuilt} code finding(s) re-embedded`);
    if (report.decisionsRebuilt + report.lessonsRebuilt + report.findingsRebuilt + report.chunksRebuilt + report.codeFindingsRebuilt === 0 && report.unembeddable >= BATCH) {
      return `${format(report)}\nABORTED: provider appears down (${embeddingsStatus()}) — nothing embedded after ${report.unembeddable} attempts.`;
    }
  }
  // Doc chunks (project-scoped like decisions/findings). Passage shape MUST
  // match what rechunkDoc embeds — chunkPassage() is the ONE shared definition
  // (plan 20 R7) — or rebuilt vectors would score differently from fresh ones.
  const { chunkPassage } = await import('../doc-chunks.js');
  for (;;) {
    const rows = await pool.query<{ id: string; heading_trail: string; content: string }>(
      `SELECT id, heading_trail, content FROM doc_chunks
        WHERE embedding_model IS DISTINCT FROM $1
          AND ($2::uuid IS NULL OR project_id = $2)
          AND NOT (id = ANY($3::uuid[]))
        ORDER BY created_at LIMIT ${BATCH}`,
      [modelId, projectId, failedChunks]
    );
    if (rows.rows.length === 0) break;
    for (const r of rows.rows) {
      const vec = await embed(chunkPassage(r.heading_trail, r.content));
      if (!vec) { failedChunks.push(r.id); report.unembeddable++; continue; }
      await pool.query(`UPDATE doc_chunks SET embedding = $1, embedding_model = $2 WHERE id = $3`, [vec, modelId, r.id]);
      report.chunksRebuilt++;
    }
    onProgress?.(`  … ${report.chunksRebuilt} chunk(s) re-embedded`);
    if (report.decisionsRebuilt + report.lessonsRebuilt + report.findingsRebuilt + report.chunksRebuilt + report.codeFindingsRebuilt === 0 && report.unembeddable >= BATCH) {
      return `${format(report)}\nABORTED: provider appears down (${embeddingsStatus()}) — nothing embedded after ${report.unembeddable} attempts.`;
    }
  }
  // Same scoping as the loops (review W2: the old unscoped count made
  // skippedCurrent wrong whenever --project was used).
  const cur = await pool.query<{ n: string }>(
    `SELECT (SELECT count(*) FROM code_decisions
              WHERE embedding_model = $1 AND ($2::uuid IS NULL OR project_id = $2))
          + (SELECT count(*) FROM lessons
              WHERE embedding_model = $1 AND ($3::text IS NULL OR rule LIKE $3))
          + (SELECT count(*) FROM plan_findings
              WHERE embedding_model = $1 AND ($2::uuid IS NULL OR project_id = $2))
          + (SELECT count(*) FROM doc_chunks
              WHERE embedding_model = $1 AND ($2::uuid IS NULL OR project_id = $2))
          + (SELECT count(*) FROM code_findings
              WHERE embedding_model = $1 AND ($2::uuid IS NULL OR project_id = $2)) AS n`,
    [modelId, projectId, lessonLike]);
  report.skippedCurrent = Number(cur.rows[0].n) - report.decisionsRebuilt - report.lessonsRebuilt - report.findingsRebuilt - report.chunksRebuilt - report.codeFindingsRebuilt;
  return format(report);
}

function format(r: RebuildReport): string {
  const skipped = r.unembeddable > 0 ? `; ${r.unembeddable} unembeddable (skipped — a fresh run retries them)` : '';
  return `embed rebuild [${r.modelId}] (decisions+findings+chunks+code findings: ${r.scope}; lessons: global): ${r.decisionsRebuilt} decision(s) + ${r.lessonsRebuilt} lesson(s) + ${r.findingsRebuilt} finding(s) re-embedded + ${r.chunksRebuilt} chunk(s) re-embedded + ${r.codeFindingsRebuilt} code finding(s) re-embedded; ${r.skippedCurrent} already current${skipped}.`;
}
