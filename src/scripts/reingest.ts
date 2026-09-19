// One-off migration (spec §4): re-ingest history under segmentation,
// NON-DESTRUCTIVELY. Old collapsed rows are superseded in place — never
// deleted — because code_decisions.session_id is ON DELETE SET NULL and
// promoted/retracted rows must keep their provenance chain. Pinned-project
// only (like ingest --scan): run as MAI_PROJECT_SLUG=<slug> mai reingest.
import path from 'node:path';
import { getPool, getProjectId } from '../db.js';
import { requirePinnedSlug } from '../env.js';
import { ClaudeCodeAdapter } from '../capture/claude-code.js';
import { CodexAdapter } from '../capture/codex.js';
import { discoverClaude, discoverCodex } from './discover-transcripts.js';
import { scanRoots } from './ingest-codex.js';
import { ingestTranscriptSegmented, type TranscriptRef } from '../capture/segment-ingest.js';
import { llmSummaryEnabled } from '../summarize.js';
import type { CaptureAdapter } from '../capture/adapter.js';
import type { LLMProviderId } from '../llm/provider.js';

export interface ReingestOpts {
  harness: 'codex' | 'claude-code' | 'all';
  dryRun: boolean;
}
export interface ReingestReport {
  scanned: number;
  segmentsPlanned: number;
  segmentsPersisted: number;
  supersededRows: number;
  curatedPreserved: number;
  /** Spec §4 step 5: LLM calls made (summary + extraction per persisted segment). */
  llmCalls: number;
  skippedMigrated: number;
  lines: string[];
}

/** Spec §5 reingest guardrail, generalized to every subscription provider
 * (plan 13's claude-code + plan 19's codex-cli): bulk work shares the user's
 * interactive rate window, so warn BEFORE the burst and point at API-key
 * providers. Pure + exported so the guard is unit-testable without a DB. */
export function subscriptionBurstWarning(ids: readonly LLMProviderId[], transcripts: number): string | null {
  const subscriptions = ids.filter((id) => id === 'claude-code' || id === 'codex-cli');
  if (subscriptions.length === 0) return null;
  if (transcripts <= 10) return null;
  const label = subscriptions
    .map((id) => id === 'claude-code' ? 'Claude Code' : 'ChatGPT (Codex)')
    .join(' or ');
  return (
    `WARNING: reingest will summarize ${transcripts} transcript(s) over your ${label} subscription ` +
    `(2 calls per segment). Run --dry-run first for segment counts, or set an API-key provider for ` +
    `bulk work — your interactive ${label} sessions share this rate window.`
  );
}

export async function runReingest(opts: ReingestOpts): Promise<ReingestReport> {
  requirePinnedSlug();
  const pool = getPool();
  const projectId = await getProjectId();
  const projRes = await pool.query<{ path: string | null; metadata: { repos?: string[] } | null }>(
    `SELECT path, metadata FROM projects WHERE id = $1`,
    [projectId]
  );
  if (projRes.rows.length === 0) throw new Error('Pinned project not found.');
  // AMENDMENT A16 (plan 27, finding 7b0a7ef7, operator-approved 2026-08-15).
  // Task 8 unified DISCOVERY but left the callers computing different repo
  // lists to feed it. The old repos-only rule here dropped the project's
  // product root whenever metadata.repos was populated — exactly the umbrella
  // case scanRoots() was introduced to fix, where agents launch from a root
  // that lives inside no sub-repo. The sweep already uses scanRoots, so
  // umbrella-root orphans it backlogs were unreachable by `mai reingest` —
  // the very command the sweep's cap message advertises as the unbounded
  // escape hatch. All three transcript-discovery consumers now scope alike.
  const repos = scanRoots(projRes.rows[0].path, projRes.rows[0].metadata);
  if (repos.length === 0) throw new Error('No repos recorded for this project — nothing to reingest.');

  const refs: TranscriptRef[] = [];
  if (opts.harness !== 'claude-code') refs.push(...(await discoverCodex(repos)));
  if (opts.harness !== 'codex') refs.push(...(await discoverClaude(repos)));

  {
    const { detectLLMProviderIds } = await import('../llm/provider.js');
    // STDERR, BEFORE any subscription call — a post-run warning cannot
    // prevent what it warns about. Segment counts are unknown up front;
    // transcript count is the available proxy.
    const warning = subscriptionBurstWarning(detectLLMProviderIds(), refs.length);
    if (warning && !opts.dryRun) console.error(warning);
  }

  const report: ReingestReport = {
    scanned: refs.length, segmentsPlanned: 0, segmentsPersisted: 0,
    supersededRows: 0, curatedPreserved: 0, llmCalls: 0, skippedMigrated: 0, lines: [],
  };
  const claude: CaptureAdapter = new ClaudeCodeAdapter();
  const codex: CaptureAdapter = new CodexAdapter();
  const llmOn = llmSummaryEnabled();

  for (const ref of refs) {
    // 1+2. Supersede the old collapsed row (if any) — delete ONLY its uncurated
    // extraction; promoted + retracted rows keep session_id (spec §4, the
    // load-bearing preservation). Rows whose transcript vanished are never
    // reached here — discovery only yields existing files (user-decided; plan 12).
    const old = await pool.query<{ id: string; migrated: boolean }>(
      `SELECT id, (metadata->>'superseded_by_segmentation') = 'true' AS migrated
         FROM code_sessions WHERE project_id = $1 AND original_session_id = $2`,
      [projectId, ref.transcriptId]
    );
    // Skip-already-migrated guard (review W2): old row superseded + watermark
    // present → this transcript is done; skip so re-runs are cheap (new turns
    // still flow through the normal hooks incrementally).
    if (old.rows[0]?.migrated) {
      const hasWm = await pool.query(
        `SELECT 1 FROM transcript_watermarks WHERE project_id = $1 AND transcript_path = $2`,
        [projectId, ref.path]
      );
      if (hasWm.rows.length > 0) {
        report.skippedMigrated++;
        report.lines.push(`${ref.harness} ${path.basename(ref.path)}: already migrated — skipped`);
        continue;
      }
    }
    if (old.rows.length > 0) {
      const oldId = old.rows[0].id;
      const curated = await pool.query<{ n: string }>(
        `SELECT count(*) AS n FROM code_decisions
          WHERE session_id = $1 AND (source = 'user-approved' OR retracted_at IS NOT NULL)`,
        [oldId]
      );
      report.curatedPreserved += Number(curated.rows[0].n);
      if (!opts.dryRun) {
        await pool.query(
          `DELETE FROM code_decisions
            WHERE session_id = $1 AND source = 'session-extract' AND retracted_at IS NULL`,
          [oldId]
        );
        await pool.query(
          `UPDATE code_sessions
              SET metadata = metadata || '{"superseded_by_segmentation": true}'::jsonb
            WHERE id = $1`,
          [oldId]
        );
        // 3. Reset the watermark so the re-ingest is full.
        await pool.query(
          `DELETE FROM transcript_watermarks WHERE project_id = $1 AND transcript_path = $2`,
          [projectId, ref.path]
        );
      }
      report.supersededRows++;
    }
    // 4. Re-ingest under segmentation. forceFull in BOTH modes (review W1):
    // hooks may have already written a watermark; the migration must plan and
    // run from offset 0 regardless.
    const adapter = ref.harness === 'codex' ? codex : claude;
    const r = await ingestTranscriptSegmented(adapter, ref, { dryRun: opts.dryRun, forceFull: true });
    report.segmentsPlanned += r.segmentsPlanned;
    report.segmentsPersisted += r.segmentsPersisted;
    if (llmOn) report.llmCalls += r.segmentsPersisted * 2; // summary + extraction per segment
    report.lines.push(
      `${ref.harness} ${path.basename(ref.path)}: ${opts.dryRun ? `${r.segmentsPlanned} segment(s) planned` : `${r.segmentsPersisted} segment(s) (${r.status})`}`
    );
  }
  // planned increments on EVERY segment, persisted additionally on wet runs —
  // summing double-counts (review B2). Max is the true segment count.
  const totalSegments = Math.max(report.segmentsPlanned, report.segmentsPersisted);
  if (totalSegments > 20) {
    const { detectLLMProviderIds } = await import('../llm/provider.js');
    const ids = detectLLMProviderIds();
    const subscriptions = ids.filter((id) => id === 'claude-code' || id === 'codex-cli');
    if (subscriptions.length > 0) {
      const providerText = ids.length === 1
        ? `ran on the ${ids[0]} provider`
        : `used the ${ids.join(' -> ')} provider chain and may have reached its subscription fallback`;
      report.lines.push(`note: ${totalSegments} segment(s) x 2 calls each ${providerText}.`);
    }
  }
  return report;
}
