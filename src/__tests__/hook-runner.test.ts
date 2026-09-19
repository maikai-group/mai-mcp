import { afterEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildCodexBlock } from '../capture/codex.js';
import type { HookChildOptions, HookRunnerIO } from '../scripts/hook-runner.js';
import { parseHookArgs, runHook } from '../scripts/hook-runner.js';
import { workerCommands } from '../scripts/hook-worker.js';
import { canonicalMaiHooks } from '../hook-wiring.js';

interface RecordedCall {
  kind: 'detached' | 'node' | 'external';
  target: string;
  args: readonly string[];
  options: HookChildOptions;
}

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

function fixtureRoot(name = 'checkout'): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'mai-hook-runner-'));
  roots.push(root);
  const checkout = path.join(root, name);
  fs.mkdirSync(path.join(checkout, '.codex'), { recursive: true });
  fs.writeFileSync(path.join(checkout, '.codex', 'config.toml'), buildCodexBlock(checkout, 'demo', 'agent@test'));
  return checkout;
}

function fakeIO(env: NodeJS.ProcessEnv = {}): {
  io: HookRunnerIO; calls: RecordedCall[]; stdout: string[]; stderr: string[];
} {
  const calls: RecordedCall[] = [];
  const stdout: string[] = [];
  const stderr: string[] = [];
  return {
    calls, stdout, stderr,
    io: {
      env,
      stdin: async () => '{"session_id":"s"}',
      spawnDetached(target, args, options) { calls.push({ kind: 'detached', target, args, options }); },
      async runNode(target, args, options) {
        calls.push({ kind: 'node', target, args, options });
        return { status: 0, stdout: 'ok\n', stderr: '' };
      },
      runExternal(target, args, options) { calls.push({ kind: 'external', target, args, options }); },
      writeStdout(value) { stdout.push(value); },
      writeStderr(value) { stderr.push(value); },
    },
  };
}

describe('portable hook runner', () => {
  it('dispatches session-start', async () => {
    const state = fakeIO();
    expect(await runHook(['session-start', '--project', 'demo'], state.io)).toBe(0);
    expect(state.calls[0].target).toMatch(/session-prime\.js$/);
  });
  it('supplies native Claude chat identity even when startup priming is unavailable', async () => {
    const state = fakeIO({ MAI_CLIENT_ID: 'claude-desktop', MAI_CHAT_NAME: 'Fable' });
    state.io.stdin = async () => JSON.stringify({ session_id: 'native-claude-session' });
    state.io.runNode = async () => { throw new Error('database unavailable'); };
    expect(await runHook(['session-start'], state.io)).toBe(0);
    expect(state.stdout.join('')).toContain('"id":"native-claude-session"');
    expect(state.stdout.join('')).toContain('"client":"claude-desktop"');
    expect(state.stdout.join('')).toContain('"name":"Fable"');
    expect(state.stdout.join('')).toContain('mai-mcp is active');
  });
  it('keeps ordinary startup available for absent or malformed native session IDs', async () => {
    const state = fakeIO();
    state.io.stdin = async () => '{';
    expect(await runHook(['session-start'], state.io)).toBe(0);
    expect(state.stdout.join('')).toBe('ok\n');
  });
  it.each(['resume', 'clear', 'compact'])('refreshes %s identity without another DB briefing', async source => {
    const state = fakeIO();
    state.io.stdin = async () => JSON.stringify({ session_id: 'native-resumed-chat', source });
    expect(await runHook(['session-start'], state.io)).toBe(0);
    expect(state.stdout.join('')).toContain('native-resumed-chat');
    expect(state.calls).toEqual([]);
    const matcher = canonicalMaiHooks('demo').find(hook => hook.event === 'SessionStart')?.entry.matcher;
    expect(matcher).toBe('startup|resume|clear|compact');
  });
  it('dispatches session-end', async () => {
    const state = fakeIO();
    state.io.spawnDetached = () => { throw new Error('detached launch failed'); };
    expect(await runHook(['session-end', '--project', 'demo'], state.io)).toBe(0);
  });
  it('dispatches session-stop', async () => {
    const state = fakeIO();
    state.io.runNode = async (target, args, options) => {
      state.calls.push({ kind: 'node', target, args, options });
      throw new Error('node launch failed');
    };
    expect(await runHook(['session-stop'], state.io)).toBe(0);
    expect(state.calls[0].target).toMatch(/stop-nudge\.js$/);
  });
  it('dispatches pre-edit', async () => {
    const state = fakeIO();
    state.io.runNode = async (target, args, options) => {
      state.calls.push({ kind: 'node', target, args, options });
      throw new Error('node launch failed');
    };
    expect(await runHook(['pre-edit', '--project', 'demo'], state.io)).toBe(0);
    expect(state.calls[0].target).toMatch(/claim-warn\.js$/);
  });
  it('dispatches codex-notify', async () => {
    const state = fakeIO();
    const cwd = fixtureRoot();
    state.io.spawnDetached = () => { throw new Error('detached launch failed'); };
    expect(await runHook(['codex-notify', JSON.stringify({ cwd })], state.io)).toBe(0);
  });
  it('dispatches codex-notify-chain', async () => {
    const state = fakeIO();
    const cwd = fixtureRoot();
    await runHook(['codex-notify-chain', JSON.stringify({ cwd })], state.io);
    expect(state.calls.some(call => call.kind === 'detached')).toBe(true);
  });
  it('uses the static startup fallback on any startup failure', async () => {
    const state = fakeIO();
    state.io.runNode = async () => { throw new Error('launch failed'); };
    expect(await runHook(['session-start'], state.io)).toBe(0);
    expect(state.stdout.join('')).toContain('mai-mcp is active');
  });
  it('preserves SessionEnd worker order', () => {
    expect(workerCommands('session-end').map(command => command.name)).toEqual([
      'ingest-session', 'sync-commits', 'docs-sweep', 'sweep-orphans', 'graph-update',
    ]);
  });
  it('preserves Codex worker order', () => {
    expect(workerCommands('codex-notify').map(command => command.name)).toEqual([
      'ingest-codex', 'sync-commits', 'docs-sweep', 'graph-update-throttle',
    ]);
  });
  it('keeps inherited environment authority over project loading', async () => {
    const state = fakeIO({ MAI_PROJECT_SLUG: 'inherited', KEEP: 'yes' });
    await runHook(['session-end'], state.io);
    expect(state.calls[0].options.env).toMatchObject({ MAI_PROJECT_SLUG: 'inherited', KEEP: 'yes' });
  });
  it('tolerates a missing checkout .env', async () => {
    const state = fakeIO({});
    expect(await runHook(['session-start'], state.io)).toBe(0);
  });
  it('ignores malformed Codex JSON', async () => {
    const state = fakeIO();
    expect(await runHook(['codex-notify', '{'], state.io)).toBe(0);
    expect(state.calls).toEqual([]);
  });
  it('preserves paths with spaces and metacharacters as opaque cwd data', async () => {
    const state = fakeIO();
    const cwd = fixtureRoot('space & (checkout)');
    await runHook(['codex-notify', JSON.stringify({ cwd })], state.io);
    expect(state.calls[0].options.cwd).toBe(cwd);
  });
  it('passes detached input, argv, env, and private log path', async () => {
    const state = fakeIO({ MAI_STATE_HOME: path.join(os.tmpdir(), 'state & space') });
    await runHook(['session-end', '--project', 'demo'], state.io);
    expect(state.calls[0].args).toEqual(['session-end']);
    expect(state.calls[0].options.input).toBe('{"session_id":"s"}');
    expect(state.calls[0].options.env.MAI_PROJECT_SLUG).toBe('demo');
    expect(state.calls[0].options.logPath).toMatch(/session-end\.log$/);
  });
  it('chains a present executable before brain ingest', async () => {
    const state = fakeIO({ MAI_CODEX_NOTIFY_CLIENT: process.execPath, PATH: process.env.PATH });
    const cwd = fixtureRoot();
    const payload = JSON.stringify({ cwd });
    await runHook(['codex-notify-chain', payload], state.io);
    expect(state.calls[0]).toMatchObject({ kind: 'external', target: process.execPath, args: ['turn-ended', payload] });
  });
  it('skips an absent chain client but still ingests', async () => {
    const state = fakeIO();
    await runHook(['codex-notify-chain', JSON.stringify({ cwd: fixtureRoot() })], state.io);
    expect(state.calls.map(call => call.kind)).toEqual(['detached']);
  });
  it('keeps chain launch failure advisory', async () => {
    const state = fakeIO({ MAI_CODEX_NOTIFY_CLIENT: process.execPath, PATH: process.env.PATH });
    state.io.runExternal = () => { throw new Error('chain failed'); };
    await runHook(['codex-notify-chain', JSON.stringify({ cwd: fixtureRoot() })], state.io);
    expect(state.calls.some(call => call.kind === 'detached')).toBe(true);
  });
  it('contains no shell command runner or shell-enabled spawn', () => {
    const root = fileURLToPath(new URL('../..', import.meta.url));
    const source = fs.readFileSync(path.join(root, 'src', 'scripts', 'hook-runner.ts'), 'utf8');
    expect(source).not.toMatch(/execFile|execSync|shell:\s*true|cmd\s*\/c|powershell/i);
    expect(() => parseHookArgs(['unknown'])).toThrow('unknown hook mode');
  });
});
