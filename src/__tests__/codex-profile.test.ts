import { access, chmod, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { constants } from 'node:fs';
import { execFile } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { afterEach, describe, expect, it } from 'vitest';
import { runCodexProfile } from '../scripts/codex-profile.js';

const roots: string[] = [];
const run = promisify(execFile);

async function tempRoot(): Promise<string> {
  const root = await mkdtemp(path.join(os.tmpdir(), 'mai-codex-profile-'));
  roots.push(root);
  return root;
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe('Codex account profiles', () => {
  it('creates a private registry and executable launcher that injects identity at MCP startup', async () => {
    const home = await tempRoot();
    const bin = path.join(home, 'bin');
    // The shim under test is the POSIX one (the launcher is named exactly after
    // the profile; on Windows it gains .cmd, which its own test covers): pin the
    // platform so this shape is asserted identically on every host.
    const out = await runCodexProfile({
      action: 'add', name: 'codex-cli', codexHome: '~/.codex-business', agentId: 'business@codex', launcherDir: bin,
    }, { homeDir: home, cwd: home, pathValue: bin, platform: 'linux' });

    const launcher = path.join(bin, 'codex-cli');
    const shim = await readFile(launcher, 'utf8');
    const body = await readFile(path.join(bin, 'codex-cli.cjs'), 'utf8');
    expect(shim).toContain('managed-by: mai codex profile');
    expect(shim).toContain('codex-cli.cjs');
    expect(body).toContain(`CODEX_HOME: ${JSON.stringify(path.join(home, '.codex-business'))}`);
    expect(body).toContain(`MAI_AGENT_ID: "business@codex"`);
    expect(body).toContain('mcp_servers.mai-mcp.env.MAI_AGENT_ID=\\"business@codex\\"');
    expect(body).toContain('mcp_servers.mai-mcp.env.MAI_CODEX_PROFILE=\\"codex-cli\\"');
    await expect(run(process.execPath, ['--check', path.join(bin, 'codex-cli.cjs')])).resolves.toBeDefined();
    await expect(access(launcher, constants.X_OK)).resolves.toBeUndefined();
    expect(out).toContain('Run: codex-cli');
    expect(out).toContain('does not copy, inspect, or modify Codex authentication');

    const registryFile = path.join(home, '.config', 'mai-mcp', 'codex-profiles.json');
    const registry = await readFile(registryFile, 'utf8');
    expect(registry).toContain('"codex-cli"');
    expect(registry).toContain('"agentId": "business@codex"');
    // The registry is JSON: a Windows path's separators are escaped inside it.
    expect(registry).toContain(`"codexHome": ${JSON.stringify(path.join(home, '.codex-business'))}`);
  });

  it.skipIf(process.platform === 'win32')('passes profile identity and overrides to the real codex child process', async () => {
    const home = await tempRoot();
    const launcherDir = path.join(home, 'launchers');
    const fakeBin = path.join(home, 'fake-bin');
    const capture = path.join(home, 'captured.json');
    const receipt = path.join(home, 'shared-spawn.receipt');
    await mkdir(fakeBin, { recursive: true });
    await writeFile(path.join(fakeBin, 'codex.cjs'), [
      `const fs = require('node:fs');`,
      `fs.writeFileSync(process.env.MAI_PROFILE_CAPTURE, JSON.stringify({ argv: process.argv.slice(2), env: { CODEX_HOME: process.env.CODEX_HOME, MAI_AGENT_ID: process.env.MAI_AGENT_ID, MAI_CODEX_PROFILE: process.env.MAI_CODEX_PROFILE } }));`,
      '',
    ].join('\n'));
    await writeFile(path.join(fakeBin, 'codex'), '#!/bin/sh\nexec node "$(dirname "$0")/codex.cjs" "$@"\n');
    await chmod(path.join(fakeBin, 'codex'), 0o755);
    await runCodexProfile({
      action: 'add', name: 'business', codexHome: '~/.codex-business', agentId: 'business@codex', launcherDir,
    }, { homeDir: home });

    // Instrument a scratch shared-command facade. This is execution proof that
    // the generated launcher actually traverses spawnArgv, not a text-only
    // assertion that could stay green after restoring direct native spawn.
    const facade = path.join(home, 'commands-facade.mjs');
    await writeFile(facade, [
      `import fs from 'node:fs';`,
      `import * as commands from ${JSON.stringify(new URL('../../build/platform/commands.js', import.meta.url).href)};`,
      `export const findExecutable = commands.findExecutable;`,
      `export const spawnArgv = (...args) => { fs.writeFileSync(process.env.MAI_PROFILE_RECEIPT, 'shared-spawn'); return commands.spawnArgv(...args); };`,
      '',
    ].join('\n'));
    const support = path.join(launcherDir, 'business.cjs');
    await writeFile(support, (await readFile(support, 'utf8')).replace(
      /import\("[^"]*\/build\/platform\/commands\.js"\)/,
      `import(${JSON.stringify(new URL(`file://${facade}`).href)})`,
    ));

    await run(path.join(launcherDir, 'business'), ['one & two', '(three)'], {
      env: {
        ...process.env,
        PATH: `${fakeBin}${path.delimiter}${process.env.PATH ?? ''}`,
        MAI_PROFILE_CAPTURE: capture,
        MAI_PROFILE_RECEIPT: receipt,
      },
    });
    const captured = await readFile(capture, 'utf8');
    expect(captured).toContain('mcp_servers.mai-mcp.env.MAI_AGENT_ID=\\"business@codex\\"');
    expect(captured).toContain('mcp_servers.mai-mcp.env.MAI_CODEX_PROFILE=\\"business\\"');
    expect(captured).toContain('"one & two"');
    expect(captured).toContain('"(three)"');
    expect(captured).toContain(`"CODEX_HOME":"${path.join(home, '.codex-business')}"`);
    expect(captured).toContain('"MAI_AGENT_ID":"business@codex"');
    expect(captured).toContain('"MAI_CODEX_PROFILE":"business"');
    expect(await readFile(receipt, 'utf8')).toBe('shared-spawn');
  });

  it('reports a missing Codex executable through the generated support launcher', async () => {
    const home = await tempRoot();
    const launcherDir = path.join(home, 'launchers');
    await runCodexProfile({
      action: 'add', name: 'missing', codexHome: '~/.codex-missing', launcherDir,
    }, { homeDir: home });
    await expect(run(process.execPath, [path.join(launcherDir, 'missing.cjs')], {
      env: { ...process.env, PATH: path.join(home, 'empty-bin') },
    })).rejects.toMatchObject({ stderr: expect.stringContaining('codex executable unavailable') });
  });

  it('reports a removed shared command runtime without touching this checkout', async () => {
    const home = await tempRoot();
    const launcherDir = path.join(home, 'launchers');
    await runCodexProfile({
      action: 'add', name: 'removed-runtime', codexHome: '~/.codex-removed', launcherDir,
    }, { homeDir: home });
    const support = path.join(launcherDir, 'removed-runtime.cjs');
    const body = await readFile(support, 'utf8');
    await writeFile(support, body.replace(
      /import\("[^"]*\/build\/platform\/commands\.js"\)/,
      'import("file:///definitely-missing-mai-runtime/commands.js")',
    ));
    await expect(run(process.execPath, [support])).rejects.toMatchObject({
      stderr: expect.stringContaining('Unable to load or launch codex'),
    });
  });

  it.skipIf(process.platform !== 'win32')('launches an actual cmd fixture with opaque Windows arguments', async () => {
    const home = await tempRoot();
    const launcherDir = path.join(home, 'launchers');
    const fakeBin = path.join(home, 'fake bin & tools');
    const capture = path.join(home, 'windows-capture.json');
    await mkdir(fakeBin, { recursive: true });
    await writeFile(path.join(fakeBin, 'codex-fixture.cjs'), [
      `require('node:fs').writeFileSync(process.env.MAI_PROFILE_CAPTURE, JSON.stringify(process.argv.slice(2)));`,
      '',
    ].join('\n'));
    await writeFile(path.join(fakeBin, 'codex.cmd'), '@echo off\r\nnode "%~dp0codex-fixture.cjs" %*\r\n');
    await runCodexProfile({
      action: 'add', name: 'windows', codexHome: '~/.codex-windows', launcherDir,
    }, { homeDir: home, platform: 'win32' });
    await run(process.execPath, [path.join(launcherDir, 'windows.cjs'), 'space & value', '(opaque)'], {
      env: { ...process.env, PATH: `${fakeBin}${path.delimiter}${process.env.PATH ?? ''}`, MAI_PROFILE_CAPTURE: capture },
    });
    expect(await readFile(capture, 'utf8')).toContain('space & value');
  });

  it('lists profiles, updates its own launcher, and removes no authentication data', async () => {
    const home = await tempRoot();
    const codexHome = path.join(home, '.codex-two');
    await runCodexProfile({ action: 'add', name: 'work', codexHome }, { homeDir: home });
    await writeFile(path.join(codexHome, 'auth.json'), 'keep-me');
    await runCodexProfile({ action: 'add', name: 'work', codexHome, agentId: 'work-two' }, { homeDir: home });

    const listed = await runCodexProfile({ action: 'list' }, { homeDir: home });
    expect(listed).toContain('work: identity="work-two"');
    const removed = await runCodexProfile({ action: 'remove', name: 'work' }, { homeDir: home });
    expect(removed).toContain('Authentication');
    expect(await readFile(path.join(codexHome, 'auth.json'), 'utf8')).toBe('keep-me');
    expect(await runCodexProfile({ action: 'list' }, { homeDir: home })).toBe('No Codex profiles configured.');
  });

  it('refuses to overwrite a foreign launcher or accept shell-hostile identity fields', async () => {
    const home = await tempRoot();
    const bin = path.join(home, 'bin');
    await mkdir(bin, { recursive: true });
    // The managed launcher is `${name}.cmd` on Windows and `${name}` on POSIX:
    // plant the foreign file at the name this host's product would overwrite.
    await writeFile(path.join(bin, process.platform === 'win32' ? 'codex-cli.cmd' : 'codex-cli'), '#!/bin/sh\necho foreign\n');
    await expect(runCodexProfile({
      action: 'add', name: 'codex-cli', codexHome: '~/.codex-business', launcherDir: bin,
    }, { homeDir: home })).rejects.toThrow('not managed by mai');
    await expect(runCodexProfile({
      action: 'add', name: 'safe', codexHome: '~/.codex-business', agentId: 'bad\nidentity', launcherDir: bin,
    }, { homeDir: home })).rejects.toThrow('no control characters');
    await expect(runCodexProfile({
      action: 'add', name: 'CoDeX', codexHome: '~/.codex-business', launcherDir: bin,
    }, { homeDir: home })).rejects.toThrow("profile name 'codex' is reserved");
  });

  it('encodes punctuation in paths and agent aliases as inert Node string data', async () => {
    const home = await tempRoot();
    await runCodexProfile({
      action: 'add', name: 'quoted', codexHome: path.join(home, "codex'home"), agentId: "agent's-cli",
    }, { homeDir: home });
    const body = await readFile(path.join(home, '.local', 'bin', 'quoted.cjs'), 'utf8');
    // The product joins the Codex home with the host separator; build the expected
    // literal the same way so Windows backslashes (JSON-escaped) still match.
    expect(body).toContain(`CODEX_HOME: ${JSON.stringify(path.join(home, "codex'home"))}`);
    expect(body).toContain(`MAI_AGENT_ID: "agent's-cli"`);
  });

  it('creates a Windows cmd shim backed by the same injection-safe Node launcher', async () => {
    const home = await tempRoot();
    await runCodexProfile({
      action: 'add', name: 'codex-work', codexHome: '~/.codex-work', agentId: 'work@codex',
    }, { homeDir: home, platform: 'win32' });
    const bin = path.join(home, '.local', 'bin');
    const shim = await readFile(path.join(bin, 'codex-work.cmd'), 'utf8');
    const support = await readFile(path.join(bin, 'codex-work.cjs'), 'utf8');
    expect(shim).toContain('node "%~dp0codex-work.cjs" %*');
    expect(support).toContain('MAI_AGENT_ID: "work@codex"');

    await runCodexProfile({ action: 'remove', name: 'codex-work' }, { homeDir: home, platform: 'win32' });
    await expect(access(path.join(bin, 'codex-work.cmd'))).rejects.toThrow();
    await expect(access(path.join(bin, 'codex-work.cjs'))).rejects.toThrow();
  });

  it('keeps every managed launcher/support path disjoint across profiles', async () => {
    // Cross-profile aliasing is POSIX-shaped: only there can one profile's
    // launcher be named exactly like another's `${name}.cjs` support file (on
    // Windows every managed name carries .cmd or .cjs). Pin the platform so the
    // alias under test exists on every host.
    const home = await tempRoot();
    await runCodexProfile({ action: 'add', name: 'work', codexHome: '~/.codex-work' }, { homeDir: home, platform: 'linux' });
    await expect(runCodexProfile({
      action: 'add', name: 'work.cjs', codexHome: '~/.codex-other',
    }, { homeDir: home, platform: 'linux' })).rejects.toThrow("would overwrite files managed by profile 'work'");
  });

  it('rejects launcher aliases with the registry or selected Codex home before writing', async () => {
    // Both aliases are POSIX-shaped: the launcher is named exactly after the
    // profile there, while on Windows it always gains a .cmd suffix. Pin the
    // platform so the shape under test is the same on every host.
    const registryHome = await tempRoot();
    const registryDir = path.join(registryHome, '.config', 'mai-mcp');
    await expect(runCodexProfile({
      action: 'add', name: 'codex-profiles.json', codexHome: '~/.codex-account', launcherDir: registryDir,
    }, { homeDir: registryHome, platform: 'linux' })).rejects.toThrow('colliding managed paths');
    await expect(access(path.join(registryDir, 'codex-profiles.json'))).rejects.toThrow();

    const codexHome = await tempRoot();
    const launcherDir = path.join(codexHome, 'bin');
    await expect(runCodexProfile({
      action: 'add', name: 'account', codexHome: path.join(launcherDir, 'account'), launcherDir,
    }, { homeDir: codexHome, platform: 'linux' })).rejects.toThrow('colliding managed paths');
    await expect(access(path.join(codexHome, '.config', 'mai-mcp', 'codex-profiles.json'))).rejects.toThrow();
  });
});
