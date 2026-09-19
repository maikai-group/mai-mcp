import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  MAI_HOOK_MODES, MAI_HOOKS, MAI_HOOK_DELEGATES, canonicalMaiHooks,
  canonicalHookCommand, canonicalCodexNotify, buildCodexNotifyLine,
  readManagedHookCommand, isMaiHookCommand, readCodexNotify,
} from '../hook-wiring.js';
import { shellQuote } from '../command-encoding.js';

const pairs = [
  ['session-start', 'session-start-prime.sh'], ['session-end', 'session-end-ingest.sh'],
  ['session-stop', 'session-stop-nudge.sh'], ['pre-edit', 'pre-edit-claim-warn.sh'],
  ['codex-notify', 'codex-notify-ingest.sh'], ['codex-notify-chain', 'codex-notify-chain.sh'],
];
describe('authoritative hook wiring', () => {
  it('contains each shipped mode/delegate exactly once', () => {
    expect(MAI_HOOK_MODES.map(e => [e.mode, e.delegate])).toEqual(pairs);
    expect(new Set(MAI_HOOK_DELEGATES).size).toBe(6);
    const root = fileURLToPath(new URL('../..', import.meta.url));
    for (const [, delegate] of pairs) expect(fs.statSync(path.join(root, 'hooks', delegate)).isFile()).toBe(true);
  });
  it('renders only four Claude events with the existing matchers and project scopes', () => {
    // path.resolve keeps the checkout host-absolute: a bare '/tmp/checkout' is
    // drive-relative on Windows, which readManagedHookCommand rightly rejects.
    const entries = canonicalMaiHooks('safe-slug', path.resolve('/tmp/checkout'));
    expect(entries.map(e => e.event)).toEqual(['SessionStart', 'SessionEnd', 'Stop', 'PreToolUse']);
    expect(entries.map(e => e.entry.matcher)).toEqual(['startup|resume|clear|compact', undefined, undefined, 'Edit|Write|MultiEdit|NotebookEdit']);
    expect(entries.map(e => readManagedHookCommand(e.entry.hooks[0].command)?.project)).toEqual(['safe-slug', 'safe-slug', undefined, 'safe-slug']);
    expect(MAI_HOOKS.map(e => e.mode)).toEqual(['session-start', 'session-end', 'session-stop', 'pre-edit']);
  });
  it('round-trips every mode through the command encoder without shell evaluation', () => {
    // The POSIX-shaped root is resolved for the host (drive-relative on Windows
    // otherwise); the Windows-shaped one is a literal both platforms must accept.
    for (const root of [path.resolve("/tmp/checkout ' $(not-executed) &"), 'C:\\Users\\Test User\\mai & brain']) {
      for (const { mode } of MAI_HOOK_MODES) {
        const command = canonicalHookCommand(mode, "slug ' value", root);
        expect(readManagedHookCommand(command)).toEqual({ mode, project: "slug ' value", legacy: false });
      }
    }
  });
  it('recognizes all six exact legacy delegates, including a moved checkout', () => {
    for (const { mode, delegate } of MAI_HOOK_MODES) {
      expect(readManagedHookCommand(`MAI_PROJECT_SLUG=demo bash ${shellQuote(`/old arbitrary/hooks/${delegate}`)}`)).toEqual({ mode, legacy: true });
    }
  });
  it('rejects foreign mentions, operators, unknown modes and duplicate project flags', () => {
    for (const command of [
      'echo mai-mcp/hooks/session-end-ingest.sh', 'bash /tmp/session-end-ingest.sh',
      `${canonicalHookCommand('session-end')} && echo foreign`,
      "node '/x/build/scripts/hook-runner.js' 'unknown'",
      `${canonicalHookCommand('session-end', 'one')} '--project' 'two'`,
    ]) expect(isMaiHookCommand(command)).toBe(false);
  });
  it('renders and recognizes the two Codex arrays, preserving chain mode', () => {
    for (const chain of [false, true]) {
      const root = 'C:\\Users\\Test User\\mai & brain';
      const argv = canonicalCodexNotify(root, chain);
      expect(argv).toEqual(['node', path.join(root, 'build', 'scripts', 'hook-runner.js'), chain ? 'codex-notify-chain' : 'codex-notify']);
      const line = buildCodexNotifyLine(root, chain);
      expect(JSON.parse(line.slice('notify = '.length))).toEqual(argv);
      expect(readCodexNotify(line)).toMatchObject({ kind: 'managed', mode: argv[2], legacy: false });
    }
  });
  it('recognizes legacy Codex notify and preserves the exact replacement span', () => {
    const line = 'notify = ["bash", "/old/hooks/codex-notify-chain.sh"]';
    const raw = `# keep\n${line}\n[tui]\nnotify = ["foreign"]\n`;
    const setting = readCodexNotify(raw);
    expect(setting).toMatchObject({ kind: 'managed', mode: 'codex-notify-chain', legacy: true });
    if (setting.kind !== 'managed') throw new Error('expected managed setting');
    expect(raw.slice(setting.start, setting.end)).toBe(line);
    expect(raw.slice(setting.end)).toBe('\n[tui]\nnotify = ["foreign"]\n');
  });
  it('preserves foreign, malformed and duplicate root notify settings', () => {
    for (const raw of [
      'notify = ["foreign", "codex-notify-ingest.sh"]', 'notify = [',
      `${buildCodexNotifyLine()}\n${buildCodexNotifyLine()}`,
      `notify = ["node", "/x/build/scripts/hook-runner.js", "session-start"]`,
    ]) expect(readCodexNotify(raw).kind).toBe('foreign');
    expect(readCodexNotify('# codex-notify-ingest.sh\n[tui]\nnotify = ["foreign"]')).toEqual({ kind: 'absent' });
  });
});
