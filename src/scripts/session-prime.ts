// SessionStart auto-prime: emits the startup briefing (primeStartup) to stdout,
// which Claude Code injects as session context. Run by hooks/session-start-prime.sh
// with MAI_PROJECT_SLUG set. On ANY failure (no slug, DB down, etc.) it prints
// nothing and exits non-zero, so the shell wrapper falls back to the static
// nudge — a startup hook must never break or hang a session.
import { pathToFileURL } from 'node:url';
import { primeStartup } from '../prime.js';
import { finishAndExit } from '../exit.js';

export async function main(): Promise<void> {
  // pre-flight: no pool, no pipeline — bare exit is safe
  if (!process.env.MAI_PROJECT_SLUG) process.exit(1); // no pinned slug → shell prints fallback
  try {
    const out = await primeStartup(); // build fully before writing — no partial output on error
    process.stdout.write(out + '\n');
    await finishAndExit(0);
  } catch {
    await finishAndExit(1); // fall back to the static nudge
  }
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  await main();
}
