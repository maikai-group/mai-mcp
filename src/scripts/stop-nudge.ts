// mai-mcp Stop-hook nudge (spec §3a): fires when the agent finishes a turn,
// reminds it once per session to log decisions/lessons future agents need.
// Throttled via a per-session_id state file (Stop fires every turn). Pure
// helpers are exported for tests; main() reads the hook JSON on stdin and emits
// the nudge as additionalContext. Never throws — a hook must not break a session.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

// Agents see this prefixed by the harness as "Stop hook feedback:" — wording
// that reads like the session is over. The text must therefore open by
// disarming that: it is a routine auto-hook checkpoint, NOT an end-of-chat
// signal, and the agent should continue working after acting on it.
const NUDGE_TEXT =
  '[mai auto-hook — routine once-per-session reminder. This is NOT a signal that the chat is ending; ' +
  'do not wrap up. Continue your task after this checkpoint.] Memory checkpoint: has this session ' +
  'produced decisions or lessons future agents will need? If yes, record them now — mai_remember for ' +
  'decisions (search first; put the chosen option in the description and the options you did not pick in ' +
  'alternatives_considered), mai_lesson_add for reusable lessons. Log only what is relevant to future ' +
  'agents — skip trivia, tool/permission approvals, and anything already in the brain. Keep each entry ' +
  'a short brief — aim for ~750 characters per field; brevity is what makes them reusable. ' +
  // The second question (plan 22, spec §4.4). No new hook, no new trigger, no
  // daemon — the same once-per-session, substantiality-gated checkpoint gains a
  // clause. The nudge is an injected string; no budget test pins it.
  'And did this session prove an existing entry WRONG, STALE, or TOO BROAD? If so, propose it: record ' +
  'the replacement with a supersedes citation, or call mai_retract with propose: true and the evidence. ' +
  'Proposals go to the operator’s review queue — nothing is applied automatically.';

export function nudgeStatePath(sessionId: string, baseDir: string = os.tmpdir()): string {
  const safe = sessionId.replace(/[^\w-]/g, '_').slice(0, 128) || 'unknown';
  return path.join(baseDir, `mai-stop-nudge-${safe}`);
}

/** True the FIRST time for a session (and atomically marks it); false thereafter. */
export function claimNudge(sessionId: string, baseDir: string = os.tmpdir()): boolean {
  try {
    fs.writeFileSync(nudgeStatePath(sessionId, baseDir), 'nudged', { flag: 'wx' });
    return true;
  } catch {
    return false; // file already exists (already nudged) or unwritable → stay silent
  }
}

/** A session is worth nudging only once it's substantial — Stop fires after
 * EVERY turn, and an unconditional first-fire claim would land the "wrap-up"
 * nudge at the end of turn 1. We gate on transcript EVENT COUNT (JSONL lines),
 * NOT byte size: a heavy SessionStart injection (prime + skills + project docs)
 * is a few VERY large lines, so a byte threshold trips after ~2 messages
 * (observed live: 64KB ≈ 2 messages). Event count is immune — injection adds
 * a handful of lines; real work adds dozens. The bar is high (100 events ≈
 * 20-30 tool-using exchanges): a session's opening is mostly search/plan/read
 * churn that inflates the line count before any decision lands, so nudging
 * earlier just interrupts. Tune on evidence. */
export function transcriptIsSubstantial(transcriptPath: string | undefined, minEvents = 100): boolean {
  if (!transcriptPath) return false;
  try {
    const raw = fs.readFileSync(transcriptPath, 'utf8');
    let events = 0;
    for (let i = 0; i < raw.length; i++) {
      if (raw.charCodeAt(i) === 10 /* \n */) {
        events++;
        if (events >= minEvents) return true;
      }
    }
    return events >= minEvents;
  } catch {
    return false;
  }
}

export function nudgeOutput(): string {
  return JSON.stringify({
    hookSpecificOutput: { hookEventName: 'Stop', additionalContext: NUDGE_TEXT },
  });
}

function readStdin(): Promise<string> {
  return new Promise((resolve) => {
    let data = '';
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', (c) => (data += c));
    process.stdin.on('end', () => resolve(data));
    process.stdin.on('error', () => resolve(data));
  });
}

async function main(): Promise<void> {
  try {
    const raw = await readStdin();
    let sessionId = 'unknown';
    let transcriptPath: string | undefined;
    try {
      const parsed = JSON.parse(raw) as { session_id?: string; transcript_path?: string };
      if (parsed.session_id) sessionId = parsed.session_id;
      transcriptPath = parsed.transcript_path;
    } catch {
      /* no/invalid stdin → still throttle under 'unknown' */
    }
    // Already nudged? Cheap existence check first — avoids re-reading a large
    // transcript on every subsequent turn once the claim is spent. Substantiality
    // is then checked BEFORE the claim, so an early Stop never consumes it.
    if (
      !fs.existsSync(nudgeStatePath(sessionId)) &&
      transcriptIsSubstantial(transcriptPath) &&
      claimNudge(sessionId)
    ) {
      process.stdout.write(nudgeOutput());
    }
  } catch {
    /* never break the session */
  }
  process.exit(0);
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  await main();
}
