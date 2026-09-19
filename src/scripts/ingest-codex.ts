#!/usr/bin/env node
// Codex rollout scan for the PINNED project (env-only, iron rule 2): walk
// ~/.codex/sessions (CODEX_HOME-overridable), read ONLY line 1 of each rollout
// (session_meta.cwd — decision 56a56090), prefix-match against the project's
// registered repos, and ingest matches through the shared pipeline. Idempotent:
// writeSession upserts ON CONFLICT (original_session_id), so re-scanning a
// still-live session just refreshes its row. Triggered manually via
// `mai ingest --scan` or automatically by hooks/codex-notify-ingest.sh
// (decision ea7c429d).
import '../env.js';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { getPool, getProjectId } from '../db.js';
import { requirePinnedSlug } from '../env.js';
import { codexHome, readRolloutMeta, CodexAdapter } from '../capture/codex.js';
import { finishAndExit } from '../exit.js';
import { ingestTranscriptSegmented } from '../capture/segment-ingest.js';

interface RepoMeta {
  repos?: string[];
}

/**
 * True when cwd is the repo root or inside it (path-segment safe).
 * macOS's default filesystem is case-insensitive — this very machine has both
 * `Developer/` and `developer/` spellings in live paths — so compare
 * case-insensitively on darwin.
 */
export function cwdMatchesRepo(
  cwd: string, repos: string[], platform: NodeJS.Platform = process.platform,
): boolean {
  const api = platform === 'win32' ? path.win32 : path.posix;
  const fold = (p: string): string =>
    platform === 'darwin' || platform === 'win32' ? api.resolve(p).toLowerCase() : api.resolve(p);
  const c = fold(cwd);
  return repos.some((r) => {
    const root = fold(r);
    return c === root || c.startsWith(root + api.sep);
  });
}

/**
 * Candidate roots for rollout cwd-matching: every registered repo PLUS the
 * product root. Umbrella projects (multi-repo umbrella class) launch agents
 * from the root, which is inside NO sub-repo — with metadata.repos populated,
 * the old repos-only list silently skipped every umbrella-root session.
 * Graph extraction is unaffected: it reads metadata.repos only, so the
 * non-git umbrella root never gets fs-walked (decision f2c6146e intact).
 */
export function scanRoots(
  rootPath: string | null,
  meta: { repos?: string[] } | null
): string[] {
  const repos = meta?.repos ?? [];
  if (rootPath === null || repos.includes(rootPath)) return [...repos];
  return [...repos, rootPath];
}

interface RolloutFile {
  file: string;
  mtimeMs: number;
}

export async function collectRollouts(dir: string, cutoffMs: number): Promise<RolloutFile[]> {
  const out: RolloutFile[] = [];
  let entries;
  try {
    entries = await fsp.readdir(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const e of entries) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) {
      out.push(...(await collectRollouts(p, cutoffMs)));
    } else if (e.isFile() && e.name.startsWith('rollout-') && e.name.endsWith('.jsonl')) {
      try {
        const st = await fsp.stat(p);
        if (st.mtimeMs >= cutoffMs) out.push({ file: p, mtimeMs: st.mtimeMs });
      } catch {
        // raced deletion — skip
      }
    }
  }
  return out;
}

export async function runCodexScan(opts: { sinceDays: number }): Promise<string> {
  requirePinnedSlug();
  const pool = getPool();
  const projectId = await getProjectId();
  const projRes = await pool.query<{ path: string | null; metadata: RepoMeta | null }>(
    `SELECT path, metadata FROM projects WHERE id = $1`,
    [projectId]
  );
  if (projRes.rows.length === 0) throw new Error('Pinned project not found.');
  const repos = scanRoots(projRes.rows[0].path, projRes.rows[0].metadata);
  if (repos.length === 0) return 'No repos recorded for this project — nothing to scan.';

  const cutoffMs = Date.now() - opts.sinceDays * 86_400_000;
  const rollouts = await collectRollouts(path.join(codexHome(), 'sessions'), cutoffMs);

  let matched = 0;
  let ingested = 0;
  let unchanged = 0;
  let failed = 0;
  const codexAdapter = new CodexAdapter();
  for (const { file } of rollouts) {
    const rolloutMeta = await readRolloutMeta(file);
    if (!rolloutMeta || !cwdMatchesRepo(rolloutMeta.cwd, repos)) continue;
    matched++;
    try {
      // The watermark table owns the skip/incremental decision now (plan 12) —
      // the pipeline stats the file itself and reads only new content.
      const report = await ingestTranscriptSegmented(codexAdapter, {
        path: file,
        transcriptId: rolloutMeta.sessionId,
        harness: 'codex',
        cwd: rolloutMeta.cwd,
      });
      if (report.status === 'unchanged') unchanged++;
      else ingested++;
    } catch (err) {
      failed++;
      console.error(`mai-codex-scan: FAILED ${file}: ${(err as Error).message}`);
    }
  }
  return `codex scan: ${rollouts.length} rollout(s) in window, ${matched} matched, ${ingested} ingested, ${unchanged} unchanged, ${failed} failed`;
}

// Direct-invocation entry (the notify hook runs `node build/scripts/ingest-codex.js --scan`).
if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  if (!process.argv.includes('--scan')) {
    console.error('Usage: ingest-codex.js --scan [--since-days N] (MAI_PROJECT_SLUG required in env)');
    // hook-safe: never non-zero. No pool exists here, so closePool is a no-op.
    await finishAndExit(0);
  } else {
    const sinceFlag = process.argv.indexOf('--since-days');
    const sinceDays =
      sinceFlag !== -1 && process.argv[sinceFlag + 1] ? Number(process.argv[sinceFlag + 1]) : 7;
    try {
      const summary = await runCodexScan({ sinceDays: Number.isFinite(sinceDays) ? sinceDays : 7 });
      console.error(summary);
    } catch (err) {
      console.error(`mai-codex-scan: FAILED (session continues unaffected): ${(err as Error).message}`);
    } finally {
      await finishAndExit(0); // hook-safe: always zero
    }
  }
}
