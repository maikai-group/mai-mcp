import { afterEach, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { lstatSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  candidateBashResponse, cleanupShadowReceipts, evaluateClaudeTestHook,
  readShadowReceipt, storeShadowReceipt,
} from '../token-test-shadow.js';

const verbose = 'test case passed\n'.repeat(300);
const vitestTail = 'Test Files  2 passed (2)\nTests  8 passed (8)\n';
const pytestTail = '================ 8 passed in 1.20s ================\n';
const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });

function tempRoot(): string {
  const root = mkdtempSync(join(tmpdir(), 'mai-token-shadow-test-'));
  dirs.push(root);
  return root;
}

function hook(command: string, stdout: string) {
  return {
    hook_event_name: 'PostToolUse', tool_name: 'Bash', tool_input: { command },
    tool_response: { stdout, stderr: '', interrupted: false, isImage: false, exitCode: 0, extra: 'keep' },
  };
}

describe('Claude passing-test candidate', () => {
  it('recognizes a direct verbose Vitest or pytest success and preserves response shape', () => {
    const input = hook('npx vitest run src/__tests__/thing.test.ts', verbose + vitestTail);
    const before = JSON.stringify(input);
    const decision = evaluateClaudeTestHook(input);
    expect(decision).toMatchObject({ kind: 'candidate', summary: 'Vitest: 2 files, 8 tests passed' });
    expect(candidateBashResponse(input.tool_response, 'short')).toEqual({
      stdout: 'short', stderr: '', interrupted: false, isImage: false, exitCode: 0, extra: 'keep',
    });
    expect(JSON.stringify(input)).toBe(before);
    expect(evaluateClaudeTestHook(hook('pytest tests/test_thing.py', verbose + pytestTail)))
      .toMatchObject({ kind: 'candidate', summary: 'pytest: 8 tests passed' });
  });

  it.each([
    ['shell operator', 'npx vitest run; echo hi', verbose + vitestTail, 'command'],
    ['npm composite', 'npm test', verbose + vitestTail + 'Test Files  2 passed (2)\nTests  8 passed (8)\n', 'command'],
    ['npm script', 'npm run test', verbose + vitestTail, 'command'],
    ['flag', 'pytest --quiet', verbose + pytestTail, 'command'],
    ['earlier failure', 'npx vitest run', `failed\n${verbose}${vitestTail}`, 'failure'],
    ['embedded marker', 'npx vitest run', `${verbose}${vitestTail}more output\n`, 'summary'],
    ['missing marker', 'npx vitest run', verbose, 'summary'],
    ['small', 'pytest', pytestTail, 'small'],
    ['large', 'pytest', 'x'.repeat(262145) + pytestTail, 'large'],
    ['NUL', 'pytest', `${verbose}\u0000${pytestTail}`, 'failure'],
    ['control', 'pytest', `${verbose}\u0001${pytestTail}`, 'failure'],
    ['ESC', 'pytest', `${verbose}\u001b[32m${pytestTail}`, 'failure'],
    ['replacement', 'pytest', `${verbose}\uFFFD${pytestTail}`, 'failure'],
    ['surrogate', 'pytest', `${verbose}\uD800${pytestTail}`, 'failure'],
  ])('skips %s', (_label, command, stdout, reason) => {
    expect(evaluateClaudeTestHook(hook(command, stdout))).toEqual({ kind: 'skip', reason });
  });

  it('skips malformed and failed structured results', () => {
    const good = hook('pytest', verbose + pytestTail);
    expect(evaluateClaudeTestHook({ ...good, tool_response: { stdout: verbose + pytestTail } }))
      .toMatchObject({ kind: 'skip', reason: 'shape' });
    expect(candidateBashResponse({ stdout: 'x' }, 'short')).toBeNull();
    for (const change of [
      { stderr: 'warning' }, { interrupted: true }, { isImage: true }, { exitCode: 1 },
    ]) {
      expect(evaluateClaudeTestHook({ ...good, tool_response: { ...good.tool_response, ...change } }))
        .toMatchObject({ kind: 'skip', reason: 'failure' });
    }
  });
});

describe('private shadow receipts', () => {
  it('recovers exact stdout without a trailing newline and keeps owner-only modes', async () => {
    const root = tempRoot();
    const id = randomUUID();
    const original = `${verbose}${vitestTail}last line`;
    await storeShadowReceipt(root, id, original, 'Vitest: 2 files, 8 tests passed', 80, 1000);
    expect(await readShadowReceipt(root, id, 1001)).toBe(original);
    const file = join(root, `${id}.json`);
    if (typeof process.getuid === 'function') {
      expect(lstatSync(root).mode & 0o077).toBe(0);
      expect(lstatSync(file).mode & 0o077).toBe(0);
    }
    const stored = JSON.parse(readFileSync(file, 'utf8'));
    expect(stored).toMatchObject({ schemaVersion: 1, sourceCategory: 'claude-passing-test',
      originalStdout: original, byteCount: Buffer.byteLength(original), originalChars: original.length,
      candidateChars: 80, createdAt: 1000, expiresAt: 1000 + 7 * 24 * 60 * 60 * 1000 });
    expect(Object.keys(stored)).not.toContain('command');
    await expect(storeShadowReceipt(root, id, original, 'summary', 80)).rejects.toThrow();
  });

  it('rejects expired and altered receipts without partial recovery', async () => {
    const root = tempRoot();
    const id = randomUUID();
    const original = `${verbose}${pytestTail}`;
    await storeShadowReceipt(root, id, original, 'pytest: 8 tests passed', 40, 1000);
    await expect(readShadowReceipt(root, id, 1000 + 7 * 24 * 60 * 60 * 1000)).rejects.toThrow('expired');
    const file = join(root, `${id}.json`);
    const tampered = JSON.parse(readFileSync(file, 'utf8'));
    tampered.originalStdout += 'tampered';
    writeFileSync(file, JSON.stringify(tampered));
    await expect(readShadowReceipt(root, id, 1001)).rejects.toThrow('integrity');
  });

  it('rejects symlinked roots and receipt files', async () => {
    const parent = tempRoot();
    const root = join(parent, 'receipts');
    const linkedRoot = join(parent, 'linked-root');
    const id = randomUUID();
    await storeShadowReceipt(root, id, `${verbose}${pytestTail}`, 'pytest: 8 tests passed', 40, 1000);
    symlinkSync(root, linkedRoot);
    await expect(readShadowReceipt(linkedRoot, id, 1001)).rejects.toThrow();
    const linkId = randomUUID();
    symlinkSync(join(root, `${id}.json`), join(root, `${linkId}.json`));
    await expect(readShadowReceipt(root, linkId, 1001)).rejects.toThrow();
  });

  it('cleans only expired valid owned receipts', async () => {
    const root = tempRoot();
    const expired = randomUUID();
    const active = randomUUID();
    const malformed = randomUUID();
    await storeShadowReceipt(root, expired, `${verbose}${pytestTail}`, 'pytest: 8 tests passed', 40, 1000);
    await storeShadowReceipt(root, active, `${verbose}${pytestTail}`, 'pytest: 8 tests passed', 40, 2000);
    writeFileSync(join(root, `${malformed}.json`), '{bad');
    writeFileSync(join(root, 'unrelated.json'), 'leave');
    const now = 1000 + 7 * 24 * 60 * 60 * 1000;
    expect(await cleanupShadowReceipts(root, now)).toBe(1);
    await expect(readShadowReceipt(root, expired, now)).rejects.toThrow();
    expect(await readShadowReceipt(root, active, now)).toBe(`${verbose}${pytestTail}`);
    expect(readFileSync(join(root, `${malformed}.json`), 'utf8')).toBe('{bad');
    expect(readFileSync(join(root, 'unrelated.json'), 'utf8')).toBe('leave');
  });
});

describe('built CLI shadow hook', () => {
  function cli(root: string, args: string[], input?: string) {
    return spawnSync(process.execPath, ['build/cli.js', 'tokens', ...args], {
      cwd: process.cwd(), encoding: 'utf8', input,
      env: { ...process.env, MAI_TOKEN_RECEIPTS_DIR: root },
    });
  }

  it('keeps hook stdout empty, reports aggregate metadata manually, and recovers exact bytes', () => {
    const root = tempRoot();
    const original = `${verbose}${vitestTail}`;
    const payload = JSON.stringify(hook('npx vitest run', original));
    const silent = cli(root, ['shadow-test'], payload);
    expect(silent.status).toBe(0);
    expect(silent.stdout).toBe('');
    expect(silent.stderr).toBe('');
    expect(readdirSync(root).filter(name => name.endsWith('.json'))).toHaveLength(1);

    const manual = cli(root, ['shadow-test', '--json'], payload);
    expect(manual.status).toBe(0);
    const aggregate = JSON.parse(manual.stdout);
    expect(aggregate).toMatchObject({ schemaVersion: 1, kind: 'candidate', originalChars: original.length });
    expect(aggregate.candidateChars).toBeLessThan(original.length);
    expect(JSON.stringify(aggregate)).not.toContain('test case passed');
    const shown = cli(root, ['show', aggregate.receiptId]);
    expect(shown.status).toBe(0);
    expect(shown.stdout).toBe(original);

    const skipped = cli(root, ['shadow-test', '--json'], JSON.stringify(hook('npm test', original)));
    expect(JSON.parse(skipped.stdout)).toEqual({ schemaVersion: 1, kind: 'skip', reason: 'command' });
    const malformed = cli(root, ['shadow-test'], '{bad');
    expect(malformed.status).toBe(0);
    expect(malformed.stdout).toBe('');
    expect(cli(root, ['shadow-test'], 'x'.repeat(1_048_577)).stdout).toBe('');
  });

  it('removes only expired valid receipts through CLI cleanup', async () => {
    const root = tempRoot();
    const expired = randomUUID();
    const active = randomUUID();
    const content = `${verbose}${pytestTail}`;
    await storeShadowReceipt(root, expired, content, 'pytest: 8 tests passed', 40,
      Date.now() - 8 * 24 * 60 * 60 * 1000);
    await storeShadowReceipt(root, active, content, 'pytest: 8 tests passed', 40);
    const cleaned = cli(root, ['cleanup']);
    expect(cleaned.status).toBe(0);
    expect(cleaned.stdout).toBe('1\n');
    expect(readdirSync(root).filter(name => name.endsWith('.json'))).toHaveLength(1);
    expect(cli(root, ['show', active]).stdout).toBe(content);
  });

  it('stays silent and successful when the shadow module cannot load', () => {
    const root = tempRoot();
    const loader = join(root, 'reject-shadow-loader.mjs');
    writeFileSync(loader, `export async function resolve(specifier, context, nextResolve) {
      if (specifier.endsWith('token-test-shadow.js')) throw new Error('shadow module blocked');
      return nextResolve(specifier, context);
    }`);
    const blocked = spawnSync(process.execPath, [
      '--no-warnings', '--experimental-loader', loader, 'build/cli.js', 'tokens', 'shadow-test',
    ], {
      cwd: process.cwd(), encoding: 'utf8', input: JSON.stringify(hook('pytest', verbose + pytestTail)),
      env: { ...process.env, MAI_TOKEN_RECEIPTS_DIR: root },
    });
    expect(blocked.status).toBe(0);
    expect(blocked.stdout).toBe('');
    expect(blocked.stderr).toBe('');
  });
});
