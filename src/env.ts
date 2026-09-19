import { config } from 'dotenv';
import { realpathSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { PreFileLlmAuthority } from './scripts/init.js';

/** Plan 15: the LLM authority the PROCESS carried before any file load —
 * captured before dotenv merges the checkout .env below, so consent can tell
 * inherited configuration apart from file configuration. Non-setup CLI/init
 * commands use this snapshot; setup captures its own immediately before its
 * visible Preflight load. */
export const PRE_FILE_LLM_AUTHORITY: Readonly<PreFileLlmAuthority> = Object.freeze({
  provider: process.env.MAI_LLM_PROVIDER,
  summary: process.env.MAI_LLM_SUMMARY,
});

// Resolve .env relative to this module, so the loader works from any cwd.
const here = path.dirname(fileURLToPath(import.meta.url));
export function shouldLoadCheckoutEnv(argv: readonly string[], moduleDir: string): boolean {
  const entry = argv[1];
  if (!entry) return true;
  const canonical = (value: string): string => {
    try { return realpathSync.native(value); } catch { return path.resolve(value); }
  };
  const entryPath = canonical(entry);
  const isCli = ['entry.js', 'cli.js'].some(name => entryPath === canonical(path.resolve(moduleDir, name)));
  const privateRun = isCli && argv[2] === 'dashboard' && argv[3] === 'run'
    && argv.slice(4).includes('--env-file');
  const privateServer = entryPath === canonical(path.resolve(moduleDir, 'web-server.js'))
    && argv.slice(2).includes('--mai-private-environment');
  return !privateRun && !privateServer;
}
if (shouldLoadCheckoutEnv(process.argv, here)) {
  config({ path: path.resolve(here, '..', '.env') });
}

/**
 * PROJECT_SLUG — the ONE project this server instance serves. Set per consumer
 * project via .mcp.json env. There is deliberately NO default: a fallback
 * literal is how cross-project pollution happens (predecessor-system lesson).
 *
 * Empty string when unset — callers must use requirePinnedSlug().
 */
export const PROJECT_SLUG = process.env.MAI_PROJECT_SLUG ?? '';

/** Consumer project root (diagnostics only — mai-mcp never writes there). */
export const PROJECT_ROOT = process.env.MAI_PROJECT_ROOT ?? '';

/** MAI_LINKED_PROJECTS (plan 31) is read by src/shares.ts:linkedSlugsFromEnv()
 * — the cross-project runtime key, operator-written by `mai link` beside
 * MAI_PROJECT_SLUG. It is deliberately NOT exported from here: reading it
 * has one owner, which memoizes the validated value on first use for the
 * process lifetime; only the explicit test seam resets it. */

export const DB_URL =
  process.env.MAI_DB_URL ?? 'postgresql://postgres:postgres@127.0.0.1:54334/mai_brain';

/**
 * Hard gate for the MCP server entrypoint. Scripts that legitimately run
 * without a pinned project (create-project, backups) skip this.
 */
export function requirePinnedSlug(): string {
  if (!PROJECT_SLUG.trim()) {
    console.error(
      'FATAL: MAI_PROJECT_SLUG is not set. mai-mcp refuses to run unpinned — ' +
        'set it in the consumer project .mcp.json env block.'
    );
    process.exit(1);
  }
  if (!/^[a-z0-9][a-z0-9-]*$/.test(PROJECT_SLUG)) {
    console.error(`FATAL: MAI_PROJECT_SLUG '${PROJECT_SLUG}' is not lowercase kebab-case.`);
    process.exit(1);
  }
  return PROJECT_SLUG;
}

/**
 * MAI_PLAN_AUTOADVANCE (plan 21 §5) — the ONE switch on the lifecycle bridge,
 * following the MAI_PRIME_STARTUP precedent (src/prime.ts:117).
 *
 *   auto (default, unset) — flip approved → executing on the first matching
 *                           plan-task commit and post the note.
 *   suggest               — no status write; propose the move instead.
 *   off                   — bridge silent: no flip, no board note, no prime line.
 *
 * An empty/whitespace value counts as UNSET. That is deliberate: lesson
 * 57ac4b5a forbids `delete process.env.X` in this repo's tests (the dotenv load
 * above repopulates a missing key), so '' is how a caller expresses "unset".
 * An unrecognized value warns once per process and falls back to auto — NEVER a throw:
 * this resolves inside a hook that must exit 0.
 *
 * Bridge A (verdict notifications) is deliberately NOT gated: a note is inert,
 * and decision f2f18031 asked for no switch on it.
 */
export type PlanAutoAdvance = 'auto' | 'suggest' | 'off';

let warnedInvalidPlanAutoAdvance = false;

/** Test-only: make the once-per-process warning contract falsifiable. */
export function _resetPlanAutoAdvanceWarningForTests(): void {
  warnedInvalidPlanAutoAdvance = false;
}

export function planAutoAdvanceMode(): PlanAutoAdvance {
  const raw = (process.env.MAI_PLAN_AUTOADVANCE ?? '').trim().toLowerCase();
  if (raw === '') return 'auto';
  if (raw === 'auto' || raw === 'suggest' || raw === 'off') return raw;
  if (!warnedInvalidPlanAutoAdvance) {
    warnedInvalidPlanAutoAdvance = true;
    console.warn(
      `[mai] MAI_PLAN_AUTOADVANCE='${process.env.MAI_PLAN_AUTOADVANCE}' is not one of ` +
        `auto|suggest|off — using 'auto'.`
    );
  }
  return 'auto';
}
