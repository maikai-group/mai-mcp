import crossSpawn from 'cross-spawn';
import fs from 'node:fs';
import path from 'node:path';
import type { ChildProcess, SpawnOptions, SpawnSyncOptions, SpawnSyncReturns } from 'node:child_process';

export interface PlatformSpec {
  platform: NodeJS.Platform;
  env: NodeJS.ProcessEnv;
}

function platformSpec(spec?: Partial<PlatformSpec>): PlatformSpec {
  return {
    platform: spec?.platform ?? process.platform,
    env: spec?.env ?? process.env,
  };
}

function windowsExtensions(name: string, env: NodeJS.ProcessEnv): readonly string[] {
  const configured = env.PATHEXT ?? env.Pathext ?? env.pathext ?? '.COM;.EXE;.BAT;.CMD';
  const extensions: string[] = [];
  const seen = new Set<string>();
  const explicit = path.extname(name);
  for (const extension of [explicit, ...configured.split(';')]) {
    if (!extension) continue;
    const normalized = extension.startsWith('.') ? extension : `.${extension}`;
    const key = normalized.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    extensions.push(normalized);
  }
  return extensions;
}

export function executableExtensions(spec: PlatformSpec): readonly string[] {
  return spec.platform === 'win32' ? windowsExtensions('', spec.env) : [''];
}

function isExecutable(candidate: string, platform: NodeJS.Platform, allowedExtensions: readonly string[]): boolean {
  let stat: fs.Stats;
  try {
    stat = fs.statSync(candidate);
  } catch {
    return false;
  }
  if (!stat.isFile()) return false;
  if (platform === 'win32') {
    const extension = path.extname(candidate).toLowerCase();
    return allowedExtensions.some(value => value.toLowerCase() === extension);
  }
  return (stat.mode & 0o111) !== 0;
}

function candidateNames(name: string, spec: PlatformSpec): readonly string[] {
  if (spec.platform !== 'win32') return [name];
  const extensions = windowsExtensions(name, spec.env);
  const explicit = path.extname(name);
  if (explicit) return [name];
  return extensions.map(extension => `${name}${extension}`);
}

export function findExecutable(name: string, partial?: Partial<PlatformSpec>): string | null {
  if (!name || name.includes('\0')) return null;
  const spec = platformSpec(partial);
  const allowedExtensions = spec.platform === 'win32' ? windowsExtensions(name, spec.env) : [''];
  const explicitPath = name.includes('/') || name.includes('\\');
  const absoluteForPlatform = path.isAbsolute(name)
    || (spec.platform === 'win32' && path.win32.isAbsolute(name));
  if (explicitPath && !absoluteForPlatform) return null;
  const roots = explicitPath
    ? ['']
    : (spec.env.PATH ?? spec.env.Path ?? spec.env.path ?? '').split(path.delimiter).filter(Boolean);
  for (const root of roots) {
    for (const candidateName of candidateNames(name, spec)) {
      const candidate = root ? path.join(root, candidateName) : candidateName;
      if (isExecutable(candidate, spec.platform, allowedExtensions)) return path.resolve(candidate);
    }
  }
  return null;
}

export function spawnArgv(command: string, args: readonly string[], options: SpawnOptions = {}): ChildProcess {
  return crossSpawn(command, [...args], { ...options, shell: false });
}

export function spawnArgvSync(
  command: string,
  args: readonly string[],
  options: SpawnSyncOptions = {},
): SpawnSyncReturns<Buffer> {
  const { encoding: _ignoredEncoding, ...bufferOptions } = options;
  return crossSpawn.sync(command, [...args], { ...bufferOptions, shell: false });
}
