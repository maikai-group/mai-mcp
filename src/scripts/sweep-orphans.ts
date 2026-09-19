#!/usr/bin/env node
// SessionEnd orphan sweep (plan 27 Part A, decision 7090f49f). A session that
// crashes never runs its own SessionEnd hook, so its transcript is durable on
// disk but UNINGESTED; the earliest recovery is the NEXT session's end — this
// script, in the detached chain. Bounded (7 days AND max 5 ingests), advisory-
// locked per transcript with a post-lock recheck, empty files skipped. It only
// READS transcript_watermarks — ingestTranscriptSegmented remains that table's
// only writer, and does all the actual work: a swept session is
// indistinguishable from a normally-ingested one.
import '../env.js';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { getPool, getProjectId } from '../db.js';
import { requirePinnedSlug } from '../env.js';
import { ClaudeCodeAdapter } from '../capture/claude-code.js';
import { CodexAdapter } from '../capture/codex.js';
import { ingestTranscriptSegmented, type TranscriptRef } from '../capture/segment-ingest.js';
import {
  discoverProjectTranscripts,
  type DiscoveryRoots,
} from './discover-transcripts.js';
import { scanRoots } from './ingest-codex.js';
import { finishAndExit } from '../exit.js';

/** Constants, not env vars — the CURATION_WINDOW_DAYS reasoning: a tunable
 * bound is a mute button that looks like a preference. 7 days keeps the sweep
 * O(recent); `mai reingest` remains the unbounded path (spec §2.3). */
export const SWEEP_WINDOW_DAYS = 7;
export const SWEEP_MAX_INGESTS = 5;
/** AMENDMENT A17 (plan 27, finding 3660501b, operator-approved 2026-08-15).
 * Discovery cannot tell "crashed" from "still running": a LIVE sibling session
 * has no watermark yet, so it reads as an orphan at every other session's end
 * and its open trailing segment is re-persisted and re-summarized — twice per
 * segment on the interactive subscription window, unattended, for as long as
 * that session stays open. Parallel sessions in one repo are the documented
 * working pattern here, so that is N-squared spend, not an edge case. A
 * quiescence floor is the cheapest sound filter: a genuinely crashed
 * transcript stops changing, so it simply lands in the NEXT sweep. */
export const SWEEP_MIN_QUIET_MS = 5 * 60_000;

export interface SweepReport {
  scanned: number;
  orphans: number;
  /** Number of ingest calls actually started. The hard cap applies to work
   * attempted, not successes; failures must consume budget too. */
  attempted: number;
  recovered: string[];
  failed: string[];
  backlog: number;
  skippedEmpty: number;
  skippedLocked: number;
  /** A17: still-live transcripts held back for the next sweep. */
  skippedLive: number;
  /** A14: releases that themselves failed. Distinct from `failed`, which means
   * the INGEST failed — collapsing the two mislabels a lock fault. */
  lockErrors: string[];
}

/** Orphan = no watermark row, or the file grew past the watermark's mtime.
 * EXISTENCE against watermarks, never a row-count against code_sessions — one
 * segmented transcript is many session rows (124→294 on this brain, spec §5). */
async function isOrphan(projectId: string, ref: TranscriptRef, mtimeMs: number): Promise<boolean> {
  const wm = await getPool().query<{ ingested_mtime_ms: string }>(
    `SELECT ingested_mtime_ms FROM transcript_watermarks
      WHERE project_id = $1 AND transcript_path = $2`,
    [projectId, ref.path]
  );
  return wm.rows.length === 0 || Number(wm.rows[0].ingested_mtime_ms) < mtimeMs;
}

export async function runSweep(opts: {
  refs?: TranscriptRef[];
  ingest?: typeof ingestTranscriptSegmented;
  /** Test-only filesystem roots; omission is the real home-directory path. */
  discoveryRoots?: DiscoveryRoots;
  /** Test seam for A17's quiescence floor — a SEAM, not a tunable: production
   * never passes it, so there is no env var and no mute button. Cases that are
   * not about liveness pass 0 to sweep their just-written fixtures. */
  minQuietMs?: number;
  /** Test seam (A13): runs after this transcript is judged an orphan and
   * BEFORE the lock is taken — the exact window the post-lock recheck defends.
   * A rival finishing there is otherwise impossible to stage deterministically,
   * and an untestable guard is one nobody can prove still works. */
  beforeLock?: () => Promise<void>;
} = {}): Promise<SweepReport> {
  requirePinnedSlug();
  const pool = getPool();
  const projectId = await getProjectId();
  const report: SweepReport = {
    scanned: 0, orphans: 0, attempted: 0, recovered: [], failed: [],
    backlog: 0, skippedEmpty: 0, skippedLocked: 0, skippedLive: 0, lockErrors: [],
  };
  let refs = opts.refs;
  if (!refs) {
    const projRes = await pool.query<{ path: string | null; metadata: { repos?: string[] } | null }>(
      `SELECT path, metadata FROM projects WHERE id = $1`,
      [projectId]
    );
    if (projRes.rows.length === 0) throw new Error('Pinned project not found.');
    const repos = scanRoots(projRes.rows[0].path, projRes.rows[0].metadata);
    if (repos.length === 0) return report;
    const cutoffMs = Date.now() - SWEEP_WINDOW_DAYS * 86_400_000;
    refs = await discoverProjectTranscripts(repos, cutoffMs, opts.discoveryRoots);
  }
  report.scanned = refs.length;
  const claude = new ClaudeCodeAdapter();
  const codex = new CodexAdapter();
  for (const ref of refs) {
    let st;
    try {
      st = await fsp.stat(ref.path);
    } catch {
      continue; // raced deletion
    }
    if (st.size === 0) {
      report.skippedEmpty++; // empty-file handling (decision 7090f49f)
      continue;
    }
    const mtimeMs = Math.ceil(st.mtimeMs); // ceil — segment-ingest.ts:41 parity
    // A17: a transcript still being written is a live session, not an orphan.
    // `> 0` mirrors discovery's cutoffMs guard: the floor is opt-out-able for
    // tests, and a zero floor must disable the check outright — Math.ceil can
    // put a just-written file a fraction of a millisecond in the "future",
    // which would otherwise read as infinitely live.
    const minQuietMs = opts.minQuietMs ?? SWEEP_MIN_QUIET_MS;
    if (minQuietMs > 0 && Date.now() - mtimeMs < minQuietMs) {
      report.skippedLive++;
      continue;
    }
    if (!(await isOrphan(projectId, ref, mtimeMs))) continue;
    report.orphans++;
    if (report.attempted >= SWEEP_MAX_INGESTS) {
      report.backlog++;
      continue;
    }
    // Project+path advisory lock + RECHECK (decision 7090f49f): two sessions
    // ending together run two sweeps; the lock serializes them per transcript
    // and the recheck makes the loser a no-op instead of a double ingest.
    // Session-level lock, so acquire/release MUST share one client.
    await opts.beforeLock?.();
    const lockKey = `${projectId}:${ref.path}`;
    const client = await pool.connect();
    // AMENDMENT A14 (plan 27, finding 5cbae6ab, operator-approved 2026-08-15).
    // This is the codebase's only pg_try_advisory_lock and its only MANUALLY
    // released one — every other advisory lock here is xact-scoped and cannot
    // leak. A throwing unlock previously did two wrong things at once: it
    // escaped into the outer catch and was recorded as an ingest failure, and
    // the outer finally then handed a connection still holding a session-scoped
    // lock back to the pool, where it silently no-ops every future sweep of
    // that key. Release faults are now their own category, and a client whose
    // unlock failed is destroyed rather than reused.
    let unlockFailed = false;
    try {
      const lock = await client.query<{ locked: boolean }>(
        `SELECT pg_try_advisory_lock(hashtextextended($1, 0)) AS locked`,
        [lockKey]
      );
      if (!lock.rows[0].locked) {
        report.skippedLocked++;
        continue;
      }
      try {
        if (!(await isOrphan(projectId, ref, mtimeMs))) continue; // lost the race — done by the winner
        const adapter = ref.harness === 'codex' ? codex : claude;
        report.attempted++;
        const ingest = opts.ingest ?? ingestTranscriptSegmented;
        const r = await ingest(adapter, ref);
        if (r.status === 'ingested') report.recovered.push(path.basename(ref.path));
      } finally {
        await client
          .query(`SELECT pg_advisory_unlock(hashtextextended($1, 0))`, [lockKey])
          .catch((e: unknown) => {
            unlockFailed = true;
            report.lockErrors.push(
              `${path.basename(ref.path)}: ${e instanceof Error ? e.message : String(e)}`
            );
          });
      }
    } catch (err) {
      report.failed.push(`${path.basename(ref.path)}: ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      // release(err) marks the connection for removal, so a possibly-locked
      // one never re-enters the pool.
      if (unlockFailed) client.release(new Error(`advisory unlock failed for ${lockKey}`));
      else client.release();
    }
  }
  return report;
}

/** Every sweep note starts with this, so successive runs can find and supersede
 * each other without a persisted thread root. */
const SWEEP_NOTE_PREFIX = 'Orphan sweep';

/** AMENDMENT A15 (plan 27, finding 6c32d934, operator-approved 2026-08-15).
 * The board's only duplicate suppression is ON CONFLICT (author_session,
 * md5(body)), and this script is a fresh short-lived process per SessionEnd —
 * a new randomUUID() INSTANCE_SESSION every run — so that conflict can never
 * fire across runs. board.ts documents this exact hazard for the structurally
 * identical sync-commits bridge: "a naive bridge would repost forever". A
 * standing backlog or a transcript that fails every time would therefore post a
 * byte-identical open note at every session end in all ~16 registered projects,
 * accumulating in the board agents read at startup. Resolve the previous open
 * sweep note as superseded so the board holds exactly ONE live sweep note.
 * (The tracker bridges use postThreadNoteSuperseding; that path needs a
 * persisted thread root, which the sweep — owning no plan row — has nowhere to
 * keep, so the prefix-matched supersede is the same discipline without one.) */
async function defaultSweepPost(body: string): Promise<void> {
  const { postMessage, SERVER_AGENT } = await import('../coordination/board.js');
  const projectId = await getProjectId();
  const prior = await getPool().query<{ id: string; body: string }>(
    `SELECT id, body FROM agent_messages
      WHERE project_id = $1 AND author_agent = $2 AND status = 'open'
        AND type = 'note' AND body LIKE $3
      ORDER BY created_at DESC LIMIT 1`,
    [projectId, SERVER_AGENT, `${SWEEP_NOTE_PREFIX}%`]
  );
  // Nothing has changed since the last sweep — leave that note standing rather
  // than restating it. This also sidesteps the board's SESSION arm: two runs in
  // ONE process with a byte-identical body hit ON CONFLICT (author_session,
  // md5(body)), which returns the EXISTING row's id without inserting while the
  // resolve still fires — superseding the only open note into silence, a worse
  // failure than the reposting this amendment set out to fix.
  if (prior.rows[0]?.body === body) return;
  await postMessage({
    type: 'note',
    body,
    author: SERVER_AGENT,
    ...(prior.rows[0] ? { resolves: prior.rows[0].id, resolution: 'superseded' } : {}),
  });
}

/** Observable entry seam. Every run logs. Recovery/failure/backlog posts; a
 * top-level discovery/DB failure is itself a failure and must post best-effort.
 * Board failure never changes the hook-safe zero exit contract. */
export async function runSweepEntry(opts: {
  run?: typeof runSweep;
  post?: (body: string) => Promise<void>;
} = {}): Promise<void> {
  const run = opts.run ?? runSweep;
  const post = opts.post ?? defaultSweepPost;
  try {
    const r = await run();
    const summary =
      `${r.scanned} transcript(s) in window, ${r.orphans} orphan(s), attempted ${r.attempted}, recovered ${r.recovered.length}` +
      `${r.backlog ? `, backlog ${r.backlog}` : ''}${r.failed.length ? `, failed ${r.failed.length}` : ''}` +
      `${r.skippedEmpty ? `, empty ${r.skippedEmpty}` : ''}${r.skippedLocked ? `, locked ${r.skippedLocked}` : ''}` +
      `${r.skippedLive ? `, live ${r.skippedLive}` : ''}${r.lockErrors.length ? `, lock-errors ${r.lockErrors.length}` : ''}`;
    // EVERY run logs (spec §2.3: a silent sweep is indistinguishable from a
    // broken one) — the chain appends this to /tmp/mai-ingest.log.
    console.error(`mai-sweep: ${summary}`);
    if (r.recovered.length > 0 || r.failed.length > 0 || r.backlog > 0 || r.lockErrors.length > 0) {
      // Board post ONLY on recovery / failure / backlog (decision 7090f49f).
      const body = [
        `Orphan sweep (${SWEEP_WINDOW_DAYS}d window): ${summary}`,
        ...(r.recovered.length ? [`recovered: ${r.recovered.join(', ')}`] : []),
        ...(r.failed.length ? [`failed: ${r.failed.join('; ')}`] : []),
        ...(r.lockErrors.length ? [`lock release failed: ${r.lockErrors.join('; ')}`] : []),
        ...(r.backlog
          ? [`backlog: ${r.backlog} orphan(s) beyond the ${SWEEP_MAX_INGESTS}-per-run cap — the next sweep continues; mai reingest is the unbounded path`]
          : []),
      ].join('\n');
      await post(body);
    }
  } catch (err) {
    const body = `Orphan sweep FAILED (session continues unaffected): ${err instanceof Error ? err.message : String(err)}`;
    console.error(`mai-sweep: ${body}`);
    try { await post(body); } catch { /* best-effort board visibility */ }
  }
}

// Direct invocation (the SessionEnd chain runs this built file).
if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  try { await runSweepEntry(); }
  finally { await finishAndExit(0); }
}
