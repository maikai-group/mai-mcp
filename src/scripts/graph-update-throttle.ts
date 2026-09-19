// Throttled graph refresh for turn-based triggers (Codex notify chain,
// 2026-07-14). Codex sessions have no end event, so the graph went stale until
// a manual `mai graph update`; now every turn OFFERS a refresh and at most one
// per interval per project actually runs. Advisory throttle (mtime marker): a
// racing pair of turns can both claim in the same instant — worst case is one
// redundant incremental update, same philosophy as the claims layer.
// Runs detached from the notify hook; must never fail the turn.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

export const GRAPH_UPDATE_INTERVAL_MS = 3_600_000;

export function throttleStatePath(slug: string, baseDir: string = os.tmpdir()): string {
  const safe = slug.replace(/[^\w-]/g, '_').slice(0, 128) || 'unknown';
  return path.join(baseDir, `mai-graph-update-${safe}`);
}

/** True when this project is due an update (and re-marks it); false while the
 * marker is fresh. Marker trouble (unwritable tmp) → false: stay silent, the
 * SessionEnd/manual paths still exist. */
export function claimGraphUpdate(
  slug: string,
  intervalMs: number = GRAPH_UPDATE_INTERVAL_MS,
  baseDir: string = os.tmpdir()
): boolean {
  const marker = throttleStatePath(slug, baseDir);
  try {
    const age = Date.now() - fs.statSync(marker).mtimeMs;
    if (age < intervalMs) return false;
  } catch {
    /* no marker yet → due */
  }
  try {
    fs.writeFileSync(marker, new Date().toISOString());
    return true;
  } catch {
    return false;
  }
}

async function main(): Promise<void> {
  const slug = process.env.MAI_PROJECT_SLUG ?? '';
  if (!slug.trim()) return;
  if (!claimGraphUpdate(slug)) return;
  const { main: runUpdate } = await import('./graph-update.js');
  await runUpdate();
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  main()
    .then(() => process.exit(0))
    .catch((err) => {
      console.error(
        `graph-update-throttle failed: ${err instanceof Error ? err.message : String(err)}`
      );
      process.exit(1);
    });
}
