/** Stop-hook throttle + output — pure functions, no DB. */
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { claimNudge, nudgeStatePath, nudgeOutput, transcriptIsSubstantial } from '../scripts/stop-nudge.js';

describe('stop-nudge', () => {
  it('transcriptIsSubstantial gates on EVENT COUNT not bytes (heavy SessionStart must not trip it)', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mai-nudge-test-'));
    // The bug: a few HUGE lines (SessionStart prime/skills injection) — ~210KB but
    // only 3 events. A byte threshold said "substantial"; event count must not.
    const fewBigLines = path.join(dir, 'few.jsonl');
    fs.writeFileSync(fewBigLines, (Buffer.alloc(70 * 1024, 'x').toString() + '\n').repeat(3));
    expect(transcriptIsSubstantial(fewBigLines)).toBe(false);
    // Real work: well past the 100-event bar.
    const manyLines = path.join(dir, 'many.jsonl');
    fs.writeFileSync(manyLines, Array.from({ length: 120 }, (_, i) => `{"type":"x","i":${i}}`).join('\n') + '\n');
    expect(transcriptIsSubstantial(manyLines)).toBe(true);
    // The opening churn (search/plan/read) — dozens of events but under the bar — must NOT nudge.
    const opening = path.join(dir, 'opening.jsonl');
    fs.writeFileSync(opening, Array.from({ length: 45 }, (_, i) => `{"type":"x","i":${i}}`).join('\n') + '\n');
    expect(transcriptIsSubstantial(opening)).toBe(false);
    // A barely-started session.
    const fewSmall = path.join(dir, 'small.jsonl');
    fs.writeFileSync(fewSmall, Array.from({ length: 6 }, (_, i) => `{"i":${i}}`).join('\n') + '\n');
    expect(transcriptIsSubstantial(fewSmall)).toBe(false);
    expect(transcriptIsSubstantial(undefined)).toBe(false);
    expect(transcriptIsSubstantial(path.join(dir, 'missing.jsonl'))).toBe(false);
  });

  it('claimNudge returns true once per session id, false thereafter', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mai-nudge-test-'));
    const sid = 'sess-abc-123';
    expect(claimNudge(sid, dir)).toBe(true);
    expect(claimNudge(sid, dir)).toBe(false);
    expect(fs.existsSync(nudgeStatePath(sid, dir))).toBe(true);
  });

  it('nudgeStatePath sanitizes the session id (no path traversal)', () => {
    const p = nudgeStatePath('../../etc/passwd', '/tmp/base');
    expect(p.startsWith('/tmp/base/')).toBe(true);
    expect(p).not.toContain('..');
  });

  it('nudgeOutput is valid Stop-hook JSON carrying the selectivity rule', () => {
    const o = JSON.parse(nudgeOutput()) as {
      hookSpecificOutput: { hookEventName: string; additionalContext: string };
    };
    expect(o.hookSpecificOutput.hookEventName).toBe('Stop');
    expect(o.hookSpecificOutput.additionalContext).toMatch(/mai_remember/);
    expect(o.hookSpecificOutput.additionalContext).toMatch(/[Ss]kip/);
  });

  it('nudge text opens by disarming the "Stop hook" framing — agents must not read it as end-of-chat', () => {
    const o = JSON.parse(nudgeOutput()) as {
      hookSpecificOutput: { additionalContext: string };
    };
    const text = o.hookSpecificOutput.additionalContext;
    // The disclaimer must come FIRST — the harness prefixes "Stop hook feedback:",
    // so the very next words the agent reads have to cancel the ending implication.
    expect(text.startsWith('[mai auto-hook')).toBe(true);
    expect(text).toMatch(/NOT a signal that the chat is ending/);
    expect(text).not.toMatch(/[Bb]efore you wrap up/);
  });

  it('the nudge asks the SUPERSEDE question and points at propose-only retraction (spec §4.4)', () => {
    const o = JSON.parse(nudgeOutput()) as {
      hookSpecificOutput: { additionalContext: string };
    };
    const text = o.hookSpecificOutput.additionalContext;
    // Case-INSENSITIVE: the nudge writes these three words in capitals for
    // emphasis (WRONG, STALE, or TOO BROAD), matching the sibling assertion
    // two lines below (pass-2 finding 6da477cb).
    expect(text).toMatch(/wrong, stale, or too broad/i);
    expect(text).toMatch(/supersedes/);
    expect(text).toMatch(/propose: true/);
    expect(text).toMatch(/nothing is applied automatically/i);
    // The original capture question must survive — this is an ADDITION.
    expect(text).toMatch(/mai_remember/);
  });
});
