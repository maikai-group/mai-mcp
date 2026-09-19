#!/usr/bin/env node
// Authoritative commit capture — façade over the git evidence module
// (src/git/sync.ts). The name, CLI contract (never exits non-zero), and
// callers (SessionEnd hook, codex notify hook, README instructions) are
// unchanged; the implementation now also indexes per-file stats and runs the
// decision auto-linker (plan 7d). Kept as the stable entry so nothing breaks.
import '../env.js';
import { pathToFileURL } from 'node:url';
import { getPool } from '../db.js';
import { requirePinnedSlug } from '../env.js';
import { syncGit } from '../git/sync.js';

/** Back-compat export: same name/signature as the pre-7d implementation. */
export async function syncCommits(): Promise<string> {
  return syncGit();
}

async function runCli(): Promise<void> {
  try {
    requirePinnedSlug();
    const summary = await syncCommits();
    console.error(`mai-sync-commits:\n${summary}`);
  } catch (err) {
    console.error(`mai-sync-commits: FAILED (non-fatal): ${(err as Error).message}`);
  } finally {
    await getPool().end().catch(() => {});
    process.exit(0);
  }
}

const isMain = import.meta.url === pathToFileURL(process.argv[1] ?? '').href;
if (isMain) await runCli();
