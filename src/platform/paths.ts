import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export interface PathOps {
  platform: NodeJS.Platform;
  lstat(target: string): fs.Stats | null;
  /** Exact device and inode of an existing path, or null when absent. NTFS
   * file ids are 64-bit and overflow a double, so identity is read as bigint
   * rather than from the lossy numbers on fs.Stats. */
  identity(target: string): PathIdentity | null;
  realpath(target: string): string;
  chmod(target: string, mode: number): void;
  currentUid(): number | null;
}

export interface PathIdentity {
  dev: bigint;
  ino: bigint;
}

/** Identity derived from a (possibly faked) lstat — tests inject stats. */
export function identityFromStats(stat: fs.Stats | null): PathIdentity | null {
  return stat === null ? null : { dev: BigInt(stat.dev), ino: BigInt(stat.ino) };
}

function errorCode(error: unknown): unknown {
  return typeof error === 'object' && error !== null ? Reflect.get(error, 'code') : undefined;
}

export function defaultPathOps(): PathOps {
  return {
    platform: process.platform,
    lstat(target) {
      try {
        return fs.lstatSync(target);
      } catch (error) {
        if (errorCode(error) === 'ENOENT') return null;
        throw error;
      }
    },
    identity(target) {
      try {
        const stat = fs.lstatSync(target, { bigint: true });
        return { dev: stat.dev, ino: stat.ino };
      } catch (error) {
        if (errorCode(error) === 'ENOENT') return null;
        throw error;
      }
    },
    realpath: target => fs.realpathSync.native(target),
    chmod: (target, mode) => fs.chmodSync(target, mode),
    currentUid: () => typeof process.getuid === 'function' ? process.getuid() : null,
  };
}

export function maiStateRoot(env: NodeJS.ProcessEnv = process.env): string {
  if (env.MAI_STATE_HOME) return path.resolve(env.MAI_STATE_HOME);
  if (process.platform === 'win32') {
    const localAppData = env.LOCALAPPDATA;
    if (!localAppData) throw new Error('LOCALAPPDATA is required for dashboard state');
    return path.join(localAppData, 'mai-mcp');
  }
  return path.join(os.homedir(), '.mai-mcp');
}

function containedByProfile(target: string): boolean {
  if (process.env.MAI_STATE_HOME) return true;
  const profile = process.env.USERPROFILE ?? process.env.LOCALAPPDATA;
  if (!profile) return false;
  const relative = path.win32.relative(path.win32.resolve(profile), path.win32.resolve(target));
  return relative === '' || (!relative.startsWith('..') && !path.win32.isAbsolute(relative));
}

export function restrictPosixDirectory(dir: string, ops: PathOps): void {
  if (ops.platform === 'win32') return;
  const uid = ops.currentUid();
  const before = ops.lstat(dir);
  if (uid === null || !before || before.isSymbolicLink() || !before.isDirectory()
      || before.uid !== uid) throw new Error('unsafe private directory');
  ops.chmod(dir, 0o700);
  const after = ops.lstat(dir);
  if (!after || after.isSymbolicLink() || !after.isDirectory() || after.uid !== uid
      || after.dev !== before.dev || after.ino !== before.ino
      || (after.mode & 0o7777) !== 0o700) throw new Error('private directory repair failed');
}

export function ensurePrivateDirectory(dir: string, ops: PathOps = defaultPathOps()): string {
  let stat = ops.lstat(dir);
  if (stat === null) {
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    stat = ops.lstat(dir);
  }
  if (!stat || stat.isSymbolicLink() || !stat.isDirectory()) throw new Error('unsafe private directory');
  if (ops.platform === 'win32') {
    if (!containedByProfile(dir)) throw new Error('private directory is outside the user profile');
  } else {
    restrictPosixDirectory(dir, ops);
  }
  return ops.realpath(dir);
}

export function requireOwnedRegularOrAbsent(
  target: string,
  label: string,
  ops: PathOps = defaultPathOps(),
): void {
  const stat = ops.lstat(target);
  if (stat === null) {
    if (ops.platform === 'win32' && !containedByProfile(target)) {
      throw new Error(`${label} is outside the user profile`);
    }
    return;
  }
  if (stat.isSymbolicLink() || !stat.isFile()) throw new Error(`${label} must be a regular non-symlink file`);
  if (ops.platform === 'win32') {
    if (!containedByProfile(target)) throw new Error(`${label} is outside the user profile`);
    return;
  }
  const uid = ops.currentUid();
  if (uid === null || stat.uid !== uid) throw new Error(`${label} must be owned by the current user`);
}

export function writePrivateFileAtomic(
  target: string,
  content: string,
  ops: PathOps = defaultPathOps(),
): void {
  ensurePrivateDirectory(path.dirname(target), ops);
  requireOwnedRegularOrAbsent(target, 'private state file', ops);
  const temp = path.join(path.dirname(target), `.${path.basename(target)}.${process.pid}.${randomUUID()}.tmp`);
  let fd: number | undefined;
  try {
    fd = fs.openSync(temp, fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_WRONLY, 0o600);
    fs.writeFileSync(fd, content, 'utf8');
    fs.fsyncSync(fd);
    fs.closeSync(fd);
    fd = undefined;
    fs.renameSync(temp, target);
  } finally {
    if (fd !== undefined) fs.closeSync(fd);
    try { fs.unlinkSync(temp); } catch (error) { if (errorCode(error) !== 'ENOENT') throw error; }
  }
}

export function openPrivateAppendLog(target: string, ops: PathOps = defaultPathOps()): number {
  ensurePrivateDirectory(path.dirname(target), ops);
  requireOwnedRegularOrAbsent(target, 'private log file', ops);
  const noFollow = typeof fs.constants.O_NOFOLLOW === 'number' ? fs.constants.O_NOFOLLOW : 0;
  return fs.openSync(
    target,
    fs.constants.O_WRONLY | fs.constants.O_APPEND | fs.constants.O_CREAT | noFollow,
    0o600,
  );
}

export function dashboardStatePath(env: NodeJS.ProcessEnv = process.env): string {
  return path.join(maiStateRoot(env), 'dashboard-state.json');
}

export function dashboardLockPath(env: NodeJS.ProcessEnv = process.env): string {
  return path.join(maiStateRoot(env), 'dashboard-lock.sqlite');
}

export function dashboardLogPath(env: NodeJS.ProcessEnv = process.env): string {
  return path.join(maiStateRoot(env), 'dashboard.log');
}

export function maintenanceLogPath(
  job: 'review-cleanup' | 'backup',
  env: NodeJS.ProcessEnv = process.env,
): string {
  return path.join(maiStateRoot(env), `${job}.log`);
}

export function hookLogPath(
  kind: 'session-end' | 'codex-notify' | 'claim-warn' | 'stop-nudge',
  env: NodeJS.ProcessEnv = process.env,
): string {
  return path.join(maiStateRoot(env), `${kind}.log`);
}

export function validateManagedPaths(targets: readonly string[], ops: PathOps = defaultPathOps()): void {
  const paths = ops.platform === 'win32' ? path.win32 : path.posix;
  const names = new Set<string>();
  const identities = new Set<string>();
  for (const target of targets) {
    if (!paths.isAbsolute(target) || !paths.basename(target)) throw new Error('invalid managed path');
    requireOwnedRegularOrAbsent(target, 'dashboard managed path', ops);
    const parent = ops.realpath(paths.dirname(target));
    const canonical = paths.join(parent, paths.basename(target));
    const key = ops.platform === 'win32' || ops.platform === 'darwin'
      ? canonical.normalize('NFC').toLowerCase() : canonical;
    if (names.has(key)) throw new Error('dashboard managed paths must be distinct');
    names.add(key);
    const found = ops.identity(target);
    if (found !== null) {
      if (found.ino <= 0n) throw new Error('could not prove dashboard managed path identity');
      const identity = `${found.dev}:${found.ino}`;
      if (identities.has(identity)) throw new Error('dashboard managed paths must be distinct');
      identities.add(identity);
    }
  }
}
