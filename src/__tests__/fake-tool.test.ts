// SPDX-License-Identifier: MIT — Copyright © 2026 Maikai Group Inc.
// Part of mai-mcp (MIT — the whole project; see LICENSE). Copy freely.
//
// The discriminator for the fake-tool layer itself: a fake installed by
// support/fake-tool.ts must be found through PATH, spawn without a shell by
// both spawn paths the product uses (cross-spawn via platform/commands and a
// bare child_process spawn), receive its argv byte-for-byte, and return its
// exit code — on every OS the portable matrix runs.
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { findExecutable, spawnArgvSync } from '../platform/commands.js';
import { fakeToolShim, installFakeTool } from './support/fake-tool.js';

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true }); });
function tempDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mai-fake-tool-'));
  roots.push(dir);
  return dir;
}

const ARGV = ['plain', 'has space', 'q"uote', 'amp&ers', 'p%percent%', 'ünï-cödé', '/Query', '--flag=x y', ''];

describe('fake tools', () => {
  it('a bash fake receives its argv exactly and returns its exit code through both spawn paths', () => {
    const dir = tempDir();
    const tool = installFakeTool(dir, 'fakectl', 'printf \'%s\\n\' "$@"\nexit 3');
    const viaCrossSpawn = spawnArgvSync(tool, ARGV, { encoding: 'utf8' });
    expect(viaCrossSpawn.status).toBe(3);
    expect(viaCrossSpawn.stdout.toString('utf8').split('\n').slice(0, ARGV.length)).toEqual(ARGV);
    const viaChildProcess = spawnSync(tool, ARGV, { encoding: 'utf8' });
    expect(viaChildProcess.status).toBe(3);
    expect(viaChildProcess.stdout.split('\n').slice(0, ARGV.length)).toEqual(ARGV);
  });

  it('a node fake receives its argv exactly, reads stdin, and returns its exit code', () => {
    const dir = tempDir();
    const tool = installFakeTool(
      dir,
      'fakenode',
      "const input = require('node:fs').readFileSync(0, 'utf8');\nprocess.stdout.write(JSON.stringify({ argv: process.argv.slice(2), input }));\nprocess.exit(5);",
      { kind: 'node' },
    );
    const result = spawnArgvSync(tool, ARGV, { encoding: 'utf8', input: 'from stdin' });
    expect(result.status).toBe(5);
    expect(JSON.parse(result.stdout.toString('utf8'))).toEqual({ argv: ARGV, input: 'from stdin' });
  });

  it('is found by name through PATH, and a Windows-style .exe name still installs a runnable tool', () => {
    const dir = tempDir();
    const tool = installFakeTool(dir, 'fakectl', 'echo found');
    const env = { ...process.env, PATH: dir, Path: dir };
    const resolved = findExecutable('fakectl', { env });
    // PATHEXT resolves `.EXE`; compare on-disk identity, not the spelling.
    expect(fs.realpathSync.native(resolved ?? '')).toBe(fs.realpathSync.native(tool));
    expect(spawnArgvSync(resolved ?? '', [], { encoding: 'utf8' }).stdout.toString('utf8').trim()).toBe('found');
    // Callers name Windows tools with their extension (schtasks.exe); the
    // returned path is what the product must spawn on this platform.
    const named = installFakeTool(dir, 'schtasks.exe', 'echo named');
    expect(path.basename(named)).toBe('schtasks.exe');
    expect(spawnSync(named, [], { encoding: 'utf8' }).stdout.trim()).toBe('named');
  });

  // Finding 125dcebd: the shim used to be cached at <tmp>/mai-fake-tool-shim
  // under a name derived from the SOURCE, and any file already sitting there
  // was copied over every fake tool and executed unverified. The replacement is
  // a directory this process creates and removes, which cannot be pre-created.
  it.skipIf(process.platform !== 'win32')('compiles the shim into a private per-run directory, not a derivable shared path', () => {
    const shim = fakeToolShim();
    const dir = path.dirname(shim);
    expect(fs.existsSync(shim)).toBe(true);
    expect(dir).not.toBe(path.join(os.tmpdir(), 'mai-fake-tool-shim'));
    // mkdtemp's random suffix is the property that makes it un-pre-creatable.
    expect(path.basename(dir)).toMatch(/^mai-fake-tool-shim-.{6,}$/);
  });
});
