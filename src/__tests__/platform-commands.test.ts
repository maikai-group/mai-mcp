import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  executableExtensions,
  findExecutable,
  spawnArgv,
  spawnArgvSync,
} from '../platform/commands.js';

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

function tempRoot(label: string): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), `mai-platform-command-${label}-`));
  roots.push(root);
  return root;
}

// Executability is a POSIX mode bit and a Windows file extension: Node never
// reports an execute bit on Windows, so a test that must resolve through the
// HOST's own rules needs the host's platform spec and the host's file shape.
// POSIX hosts keep the exact 'linux' fixture they have always used.
const hostPlatform: NodeJS.Platform = process.platform === 'win32' ? 'win32' : 'linux';
const hostExecutableName = (base: string): string => (hostPlatform === 'win32' ? `${base}.EXE` : base);

function executable(root: string, name: string, mode = 0o755): string {
  const file = path.join(root, name);
  fs.writeFileSync(file, '#!/bin/sh\nexit 0\n', { mode });
  fs.chmodSync(file, mode);
  return file;
}

function nodeArgv(args: readonly string[], env: NodeJS.ProcessEnv = process.env) {
  return spawnArgvSync(process.execPath, ['-e', 'process.stdout.write(JSON.stringify({argv:process.argv.slice(1),env:process.env.MAI_ONLY_ENV??null}))', ...args], {
    env,
    timeout: 2_000,
  });
}

describe('platform commands', () => {
  it('C01 — finds a POSIX executable', () => {
    const root = tempRoot('c01');
    const file = executable(root, hostExecutableName('tool'));
    // PATHEXT is inert on a POSIX spec and is what makes 'tool' resolvable on win32.
    expect(findExecutable('tool', { platform: hostPlatform, env: { PATH: root, PATHEXT: '.EXE' } })).toBe(file);
  });

  it('C02 — refuses a POSIX non-executable', () => {
    const root = tempRoot('c02');
    executable(root, 'tool', 0o644);
    expect(findExecutable('tool', { platform: 'linux', env: { PATH: root } })).toBeNull();
  });

  it('C03 — refuses an explicit relative path even when it exists', () => {
    const root = tempRoot('c03');
    executable(root, 'tool');
    const original = process.cwd();
    process.chdir(root);
    try {
      expect(findExecutable('./tool', { platform: 'linux', env: { PATH: root } })).toBeNull();
    } finally {
      process.chdir(original);
    }
  });

  it('C04 — accepts an explicit absolute executable path', () => {
    const file = executable(tempRoot('c04'), hostExecutableName('tool'));
    expect(findExecutable(file, { platform: hostPlatform, env: {} })).toBe(file);
  });

  it('C05 — ignores an empty PATH segment instead of searching cwd', () => {
    const root = tempRoot('c05');
    executable(root, 'local-tool');
    const original = process.cwd();
    process.chdir(root);
    try {
      expect(findExecutable('local-tool', { platform: 'linux', env: { PATH: `${path.delimiter}/missing` } })).toBeNull();
    } finally {
      process.chdir(original);
    }
  });

  it('C06 — finds a Windows .EXE', () => {
    const root = tempRoot('c06');
    const file = executable(root, 'tool.EXE', 0o644);
    expect(findExecutable('tool', { platform: 'win32', env: { PATH: root, PATHEXT: '.EXE' } }))
      .toBe(file);
  });

  it('C07 — finds a Windows .CMD', () => {
    const root = tempRoot('c07');
    const file = executable(root, 'tool.CMD', 0o644);
    expect(findExecutable('tool', { platform: 'win32', env: { PATH: root, PATHEXT: '.CMD' } }))
      .toBe(file);
  });

  it('C08 — finds a Windows .BAT', () => {
    const root = tempRoot('c08');
    const file = executable(root, 'tool.BAT', 0o644);
    expect(findExecutable('tool', { platform: 'win32', env: { PATH: root, PATHEXT: '.BAT' } }))
      .toBe(file);
  });

  it('C09 — folds PATHEXT case when validating an explicit extension', () => {
    const root = tempRoot('c09');
    const file = executable(root, 'tool.EXE', 0o644);
    expect(findExecutable(file, { platform: 'win32', env: { PATHEXT: '.exe' } })).toBe(file);
  });

  it('C10 — uses the default Windows PATHEXT when absent', () => {
    const root = tempRoot('c10');
    const file = executable(root, 'tool.CMD', 0o644);
    expect(findExecutable('tool', { platform: 'win32', env: { PATH: root } }))
      .toBe(file);
  });

  it('C11 — de-duplicates PATHEXT case-insensitively', () => {
    expect(executableExtensions({ platform: 'win32', env: { PATHEXT: '.EXE;.exe;.CMD;.cmd' } }))
      .toEqual(['.EXE', '.CMD']);
  });

  it('C12 — preserves an executable path containing spaces', () => {
    const root = tempRoot('space root');
    const file = executable(root, hostExecutableName('space tool'));
    expect(findExecutable(file, { platform: hostPlatform, env: {} })).toBe(file);
  });

  it('C13 — preserves ampersands as argv data', () => {
    expect(JSON.parse(nodeArgv(['a&b']).stdout.toString('utf8')).argv).toEqual(['a&b']);
  });

  it('C14 — preserves parentheses as argv data', () => {
    expect(JSON.parse(nodeArgv(['a(b)c']).stdout.toString('utf8')).argv).toEqual(['a(b)c']);
  });

  it('C15 — preserves percent signs as argv data', () => {
    expect(JSON.parse(nodeArgv(['%PATH%']).stdout.toString('utf8')).argv).toEqual(['%PATH%']);
  });

  it('C16 — preserves Unicode as argv data', () => {
    expect(JSON.parse(nodeArgv(['雪-λ-🚀']).stdout.toString('utf8')).argv).toEqual(['雪-λ-🚀']);
  });

  it('C17 — preserves quote-containing argv and a POSIX executable path containing quotes', () => {
    // A quote is legal in a POSIX file name and illegal in a Windows one, so the
    // quoted-executable half is POSIX-only; the quoted argv half runs everywhere.
    let executablePath = process.execPath;
    if (process.platform !== 'win32') {
      executablePath = path.join(tempRoot('c17'), 'node-"quoted"');
      fs.symlinkSync(process.execPath, executablePath);
    }
    const result = spawnArgvSync(executablePath, ['-e', 'process.stdout.write(process.argv[1])', `a"b'c`]);
    expect(result.stdout.toString('utf8')).toBe(`a"b'c`);
  });

  it('C18 — preserves argv end to end and forces Buffer output despite an encoding input', () => {
    const args = ['', 'two words', 'a&b', '雪', '"quoted"'];
    const result = nodeArgv(args);
    expect(Buffer.isBuffer(result.stdout)).toBe(true);
    expect(Buffer.isBuffer(result.stderr)).toBe(true);
    expect(JSON.parse(result.stdout.toString('utf8')).argv).toEqual(args);
    const forced = spawnArgvSync(process.execPath, ['-e', 'process.stdout.write("ok")'], { encoding: 'utf8' });
    expect(Buffer.isBuffer(forced.stdout)).toBe(true);
  });

  it('C19 — never invokes a shell', () => {
    const marker = path.join(tempRoot('c19'), 'marker');
    const result = nodeArgv([`x;touch ${marker}`]);
    expect(result.status).toBe(0);
    expect(fs.existsSync(marker)).toBe(false);
  });

  it('C20 — preserves the complete scrubbed environment without widening it', () => {
    const result = nodeArgv([], { MAI_ONLY_ENV: 'kept' });
    expect(JSON.parse(result.stdout.toString('utf8'))).toEqual({ argv: [], env: 'kept' });
  });

  it('C21 — propagates sync and async timeout options', async () => {
    const sync = spawnArgvSync(process.execPath, ['-e', 'setTimeout(()=>{}, 5000)'], { timeout: 25 });
    expect(sync.error).toBeInstanceOf(Error);
    const child = spawnArgv(process.execPath, ['-e', 'setTimeout(()=>{}, 5000)'], { timeout: 25 });
    const closed = new Promise<number | null>(resolve => child.once('close', code => resolve(code)));
    expect(await closed).not.toBe(0);
  });
});
