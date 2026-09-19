import { randomUUID } from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { tomlString } from '../command-encoding.js';
import { MAI_ROOT } from '../paths.js';

const REGISTRY_VERSION = 1;
const LAUNCHER_MARKER = 'managed-by: mai codex profile';

interface CodexProfileRecord {
  agentId: string;
  codexHome: string;
  launcherPath: string;
  supportPath?: string;
}

interface CodexProfileRegistry {
  version: 1;
  profiles: Record<string, CodexProfileRecord>;
}

export interface CodexProfileRequest {
  action: 'add' | 'list' | 'remove';
  name?: string;
  codexHome?: string;
  agentId?: string;
  launcherDir?: string;
}

export interface CodexProfileIO {
  homeDir?: string;
  cwd?: string;
  pathValue?: string;
  platform?: NodeJS.Platform;
}

function emptyRegistry(): CodexProfileRegistry {
  return { version: REGISTRY_VERSION, profiles: {} };
}

function registryPath(homeDir: string): string {
  return path.join(homeDir, '.config', 'mai-mcp', 'codex-profiles.json');
}

function expandPath(value: string, homeDir: string, cwd: string): string {
  if (/[\0\r\n]/.test(value)) throw new Error('paths must not contain NUL or newline');
  if (value === '~') return homeDir;
  if (value.startsWith('~/')) return path.join(homeDir, value.slice(2));
  if (value.startsWith('~')) {
    throw new Error(`unsupported home path '${value}' — use ~ or an absolute path`);
  }
  return path.resolve(cwd, value);
}

function validateProfileName(name: string): void {
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(name)) {
    throw new Error('profile name must be 1-64 characters using letters, numbers, dot, underscore, or hyphen');
  }
  if (name.toLowerCase() === 'codex') {
    throw new Error("profile name 'codex' is reserved because it would shadow the Codex executable");
  }
}

function validateAgentId(agentId: string): void {
  if (agentId.length === 0 || agentId.length > 120 || /[\u0000-\u001f\u007f-\u009f]/.test(agentId)) {
    throw new Error('agent id must be 1-120 characters with no control characters');
  }
}

function errorCode(error: unknown): unknown {
  return typeof error === 'object' && error !== null ? Reflect.get(error, 'code') : undefined;
}

function isProfileRecord(value: unknown): value is CodexProfileRecord {
  if (typeof value !== 'object' || value === null) return false;
  return typeof Reflect.get(value, 'agentId') === 'string'
    && typeof Reflect.get(value, 'codexHome') === 'string'
    && typeof Reflect.get(value, 'launcherPath') === 'string'
    && (Reflect.get(value, 'supportPath') === undefined || typeof Reflect.get(value, 'supportPath') === 'string');
}

async function readRegistry(file: string): Promise<CodexProfileRegistry> {
  let raw: string;
  try {
    raw = await fs.readFile(file, 'utf8');
  } catch (error) {
    if (errorCode(error) === 'ENOENT') return emptyRegistry();
    throw error;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error(`invalid Codex profile registry: ${file}`);
  }
  if (typeof parsed !== 'object' || parsed === null) {
    throw new Error(`invalid Codex profile registry: ${file}`);
  }
  const version = Reflect.get(parsed, 'version');
  const rawProfiles = Reflect.get(parsed, 'profiles');
  if (version !== REGISTRY_VERSION || typeof rawProfiles !== 'object' || rawProfiles === null) {
    throw new Error(`unsupported or invalid Codex profile registry: ${file}`);
  }
  const entries: Array<[string, CodexProfileRecord]> = [];
  for (const [name, profile] of Object.entries(rawProfiles)) {
    if (!isProfileRecord(profile)) {
      throw new Error(`unsupported or invalid Codex profile registry: ${file}`);
    }
    try {
      validateProfileName(name);
      validateAgentId(profile.agentId);
    } catch {
      throw new Error(`unsupported or invalid Codex profile registry: ${file}`);
    }
    if (!path.isAbsolute(profile.codexHome)
        || !path.isAbsolute(profile.launcherPath)
        || (profile.supportPath !== undefined && !path.isAbsolute(profile.supportPath))) {
      throw new Error(`unsupported or invalid Codex profile registry: ${file}`);
    }
    entries.push([name, profile]);
  }
  return { version: REGISTRY_VERSION, profiles: Object.fromEntries(entries) };
}

async function atomicWrite(file: string, content: string, mode: number): Promise<void> {
  await fs.mkdir(path.dirname(file), { recursive: true });
  const temp = path.join(path.dirname(file), `.${path.basename(file)}.${process.pid}.${randomUUID()}.tmp`);
  try {
    await fs.writeFile(temp, content, { encoding: 'utf8', mode, flag: 'wx' });
    await fs.rename(temp, file);
    await fs.chmod(file, mode);
  } finally {
    await fs.rm(temp, { force: true });
  }
}

function launcherBody(name: string, codexHome: string, agentId: string): string {
  const agentOverride = `mcp_servers.mai-mcp.env.MAI_AGENT_ID=${tomlString(agentId)}`;
  const profileOverride = `mcp_servers.mai-mcp.env.MAI_CODEX_PROFILE=${tomlString(name)}`;
  const runtime = pathToFileURL(path.join(MAI_ROOT, 'build', 'platform', 'commands.js')).href;
  return [
    '#!/usr/bin/env node',
    `'use strict';`,
    `// ${LAUNCHER_MARKER}`,
    `// profile: ${name}`,
    `const env = { ...process.env, CODEX_HOME: ${JSON.stringify(codexHome)}, MAI_AGENT_ID: ${JSON.stringify(agentId)}, MAI_CODEX_PROFILE: ${JSON.stringify(name)} };`,
    `const args = ['-c', ${JSON.stringify(agentOverride)}, '-c', ${JSON.stringify(profileOverride)}, ...process.argv.slice(2)];`,
    `import(${JSON.stringify(runtime)}).then(({ findExecutable, spawnArgv }) => {`,
    `  const executable = findExecutable('codex', { env });`,
    `  if (!executable) throw new Error('codex executable unavailable');`,
    `  const child = spawnArgv(executable, args, { stdio: 'inherit', env, shell: false });`,
    `  child.on('error', (error) => { console.error('Unable to launch codex: ' + error.message); process.exitCode = 1; });`,
    `  child.on('exit', (code, signal) => {`,
    `    if (signal) process.kill(process.pid, signal);`,
    `    else process.exitCode = code ?? 1;`,
    `  });`,
    `}).catch((error) => { console.error('Unable to load or launch codex: ' + error.message); process.exitCode = 1; });`,
    '',
  ].join('\n');
}

function windowsShimBody(name: string): string {
  return [
    '@echo off',
    `rem ${LAUNCHER_MARKER}`,
    `rem profile: ${name}`,
    `node "%~dp0${name}.cjs" %*`,
    '',
  ].join('\r\n');
}

function posixShimBody(name: string): string {
  return [
    '#!/bin/sh',
    `# ${LAUNCHER_MARKER}`,
    `# profile: ${name}`,
    `exec node "$(dirname "$0")/${name}.cjs" "$@"`,
    '',
  ].join('\n');
}

type ManagedPathRole = 'registry' | 'codex home' | 'launcher' | 'support file';

interface ManagedPath {
  file: string;
  role: ManagedPathRole;
}

async function canonicalManagedPath(file: string, platform: NodeJS.Platform): Promise<string> {
  const suffix: string[] = [];
  let probe = path.resolve(file);
  while (true) {
    try {
      const physical = path.join(await fs.realpath(probe), ...suffix.reverse());
      return platform === 'win32' ? physical.toLowerCase() : physical;
    } catch (error) {
      if (errorCode(error) !== 'ENOENT') throw error;
      const parent = path.dirname(probe);
      if (parent === probe) throw error;
      suffix.push(path.basename(probe));
      probe = parent;
    }
  }
}

async function assertNoProfilePathCollision(
  registry: CodexProfileRegistry,
  name: string,
  managed: Readonly<Record<'registryPath' | 'codexHome' | 'launcherPath' | 'supportPath', string>>,
  platform: NodeJS.Platform,
): Promise<void> {
  const next: ManagedPath[] = [
    { role: 'registry', file: managed.registryPath },
    { role: 'codex home', file: managed.codexHome },
    { role: 'launcher', file: managed.launcherPath },
    { role: 'support file', file: managed.supportPath },
  ];
  const canonicalNext = await Promise.all(next.map(async (entry) => ({
    ...entry,
    canonical: await canonicalManagedPath(entry.file, platform),
  })));
  for (let left = 0; left < canonicalNext.length; left += 1) {
    for (let right = left + 1; right < canonicalNext.length; right += 1) {
      if (canonicalNext[left].canonical === canonicalNext[right].canonical) {
        throw new Error(
          `profile '${name}' has colliding managed paths: ${canonicalNext[left].role} and ${canonicalNext[right].role}`,
        );
      }
    }
  }
  for (const [otherName, profile] of Object.entries(registry.profiles)) {
    const previous: ManagedPath[] = [
      { role: 'codex home', file: profile.codexHome },
      { role: 'launcher', file: profile.launcherPath },
      ...(profile.supportPath ? [{ role: 'support file' as const, file: profile.supportPath }] : []),
    ];
    const canonicalPrevious = await Promise.all(previous.map(async (entry) => ({
      ...entry,
      canonical: await canonicalManagedPath(entry.file, platform),
    })));
    for (const candidate of canonicalNext) {
      for (const prior of canonicalPrevious) {
        if (candidate.canonical !== prior.canonical) continue;
        if (otherName === name && candidate.role === prior.role) continue;
        if (otherName !== name) {
          throw new Error(`profile '${name}' would overwrite files managed by profile '${otherName}'`);
        }
        throw new Error(`profile '${name}' has colliding managed paths: ${candidate.role} and previous ${prior.role}`);
      }
    }
  }
}

async function assertLauncherMayBeManaged(file: string, name: string): Promise<void> {
  let stat;
  try {
    stat = await fs.lstat(file);
  } catch (error) {
    if (errorCode(error) === 'ENOENT') return;
    throw error;
  }
  if (!stat.isFile() || stat.isSymbolicLink()) {
    throw new Error(`refusing to replace non-regular launcher: ${file}`);
  }
  const content = await fs.readFile(file, 'utf8');
  if (!content.includes(LAUNCHER_MARKER) || !content.includes(`profile: ${name}`)) {
    throw new Error(`refusing to replace launcher not managed by mai: ${file}`);
  }
}

async function writeRegistry(file: string, registry: CodexProfileRegistry): Promise<void> {
  const sorted = Object.fromEntries(Object.entries(registry.profiles).sort(([a], [b]) => a.localeCompare(b)));
  await atomicWrite(file, `${JSON.stringify({ version: REGISTRY_VERSION, profiles: sorted }, null, 2)}\n`, 0o600);
}

function requireName(request: CodexProfileRequest): string {
  if (!request.name) throw new Error('missing required argument: <profile-name>');
  validateProfileName(request.name);
  return request.name;
}

export async function runCodexProfile(
  request: CodexProfileRequest,
  io: CodexProfileIO = {},
): Promise<string> {
  const homeDir = io.homeDir ?? os.homedir();
  const cwd = io.cwd ?? process.cwd();
  const platform = io.platform ?? process.platform;
  const file = registryPath(homeDir);
  const registry = await readRegistry(file);

  if (request.action === 'list') {
    const entries = Object.entries(registry.profiles).sort(([a], [b]) => a.localeCompare(b));
    if (entries.length === 0) return 'No Codex profiles configured.';
    return [
      'Codex profiles:',
      ...entries.map(([name, profile]) =>
        `- ${name}: identity=${JSON.stringify(profile.agentId)} CODEX_HOME=${profile.codexHome} launcher=${profile.launcherPath}`),
    ].join('\n');
  }

  const name = requireName(request);
  if (request.action === 'remove') {
    const existing = registry.profiles[name];
    if (!existing) throw new Error(`Codex profile '${name}' does not exist`);
    await assertLauncherMayBeManaged(existing.launcherPath, name);
    if (existing.supportPath) await assertLauncherMayBeManaged(existing.supportPath, name);
    await fs.rm(existing.launcherPath, { force: true });
    if (existing.supportPath) await fs.rm(existing.supportPath, { force: true });
    delete registry.profiles[name];
    await writeRegistry(file, registry);
    return `Removed Codex profile '${name}' and launcher ${existing.launcherPath}. Authentication in ${existing.codexHome} was not changed.`;
  }

  if (!request.codexHome) throw new Error('missing required flag: --codex-home');
  const agentId = request.agentId ?? name;
  validateAgentId(agentId);
  const codexHome = expandPath(request.codexHome, homeDir, cwd);
  const launcherDir = expandPath(request.launcherDir ?? path.join(homeDir, '.local', 'bin'), homeDir, cwd);
  const launcherPath = path.join(launcherDir, platform === 'win32' ? `${name}.cmd` : name);
  const supportPath = path.join(launcherDir, `${name}.cjs`);
  await assertNoProfilePathCollision(registry, name, {
    registryPath: file, codexHome, launcherPath, supportPath,
  }, platform);
  const existing = registry.profiles[name];
  if (existing && existing.launcherPath !== launcherPath) {
    await assertLauncherMayBeManaged(existing.launcherPath, name);
    if (existing.supportPath) await assertLauncherMayBeManaged(existing.supportPath, name);
  }
  await assertLauncherMayBeManaged(launcherPath, name);
  await assertLauncherMayBeManaged(supportPath, name);
  await fs.mkdir(codexHome, { recursive: true });
  await atomicWrite(supportPath, launcherBody(name, codexHome, agentId), 0o644);
  await atomicWrite(
    launcherPath,
    platform === 'win32' ? windowsShimBody(name) : posixShimBody(name),
    platform === 'win32' ? 0o644 : 0o755,
  );
  if (existing && existing.launcherPath !== launcherPath) {
    await fs.rm(existing.launcherPath, { force: true });
    if (existing.supportPath) await fs.rm(existing.supportPath, { force: true });
  }
  registry.profiles[name] = { agentId, codexHome, launcherPath, supportPath };
  await writeRegistry(file, registry);

  const pathEntries = (io.pathValue ?? process.env.PATH ?? '').split(path.delimiter);
  const invocation = pathEntries.includes(launcherDir) ? name : launcherPath;
  return [
    `Configured Codex profile '${name}'.`,
    `Identity alias: ${agentId}`,
    `CODEX_HOME: ${codexHome}`,
    `Launcher: ${launcherPath}`,
    `Run: ${invocation}`,
    'This does not copy, inspect, or modify Codex authentication; log in separately in that CODEX_HOME if needed.',
  ].join('\n');
}
