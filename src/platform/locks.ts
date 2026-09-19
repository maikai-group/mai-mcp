import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { setTimeout as delay } from 'node:timers/promises';
import type { PathOps } from './paths.js';
import { defaultPathOps, ensurePrivateDirectory, requireOwnedRegularOrAbsent } from './paths.js';

export interface StateLock { readonly path: string; release(): void; }
export interface LockConnection { begin(): void; rollback(): void; close(): void; }
export interface LockOps {
  pathOps: PathOps;
  now(): number;
  sleep(ms: number): Promise<void>;
  openDatabase(file: string): LockConnection;
}
export class LockReleaseError extends Error {}

function hasCode(error: unknown, code: string): boolean {
  return error instanceof Error && 'code' in error && error.code === code;
}

function busy(error: unknown): boolean {
  return error instanceof Error && 'errcode' in error && typeof error.errcode === 'number'
    && (error.errcode & 255) === 5;
}

function journalMode(value: unknown): unknown {
  return typeof value === 'object' && value !== null ? Reflect.get(value, 'journal_mode') : undefined;
}

export function defaultLockOps(): LockOps {
  return {
    pathOps: defaultPathOps(),
    now: () => performance.now(),
    sleep: delay,
    openDatabase(file) {
      const db = new DatabaseSync(file);
      try {
        db.exec('PRAGMA busy_timeout=0');
        const mode = db.prepare('PRAGMA journal_mode').get();
        if (journalMode(mode) !== 'delete') throw new Error('unsupported dashboard lock journal mode');
        return {
          begin: () => db.exec('BEGIN IMMEDIATE'),
          rollback: () => db.exec('ROLLBACK'),
          close: () => db.close(),
        };
      } catch (error) {
        db.close();
        throw error;
      }
    },
  };
}

export async function acquireStateLock(
  lockPath: string,
  waitMs: number,
  ops: LockOps = defaultLockOps(),
): Promise<StateLock> {
  if (!Number.isFinite(waitMs) || waitMs < 0) throw new Error('invalid dashboard lock wait');
  const deadline = ops.now() + waitMs;
  let db: LockConnection | undefined;
  try {
    ensurePrivateDirectory(path.dirname(lockPath), ops.pathOps);
    requireOwnedRegularOrAbsent(lockPath, 'dashboard state lock', ops.pathOps);
    try {
      const fd = fs.openSync(
        lockPath,
        fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_WRONLY,
        0o600,
      );
      fs.closeSync(fd);
    } catch (error) {
      if (!hasCode(error, 'EEXIST')) throw error;
    }
    requireOwnedRegularOrAbsent(lockPath, 'dashboard state lock', ops.pathOps);
    const stat = fs.lstatSync(lockPath);
    if (stat.nlink !== 1 || (ops.pathOps.platform !== 'win32' && (stat.mode & 0o077) !== 0)) {
      throw new Error('dashboard state lock must be private and unaliased');
    }
    requireOwnedRegularOrAbsent(lockPath + '-journal', 'dashboard lock journal', ops.pathOps);
    try {
      const journal = fs.lstatSync(lockPath + '-journal');
      if (journal.nlink !== 1 || (ops.pathOps.platform !== 'win32' && (journal.mode & 0o077) !== 0)) {
        throw new Error('dashboard lock journal must be private and unaliased');
      }
    } catch (error) {
      if (!hasCode(error, 'ENOENT')) throw error;
    }
    for (const suffix of ['-wal', '-shm']) {
      try {
        fs.lstatSync(lockPath + suffix);
      } catch (error) {
        if (hasCode(error, 'ENOENT')) continue;
        throw error;
      }
      throw new Error('unexpected dashboard lock sidecar');
    }
    for (;;) {
      try {
        db ??= ops.openDatabase(lockPath);
        db.begin();
        break;
      } catch (error) {
        if (!busy(error) || ops.now() >= deadline) throw error;
        await ops.sleep(Math.min(100, Math.max(0, deadline - ops.now())));
        if (ops.now() >= deadline) throw new Error('dashboard state lock timed out');
      }
    }
    const connection = db;
    let released = false;
    return {
      path: lockPath,
      release() {
        if (released) throw new LockReleaseError('dashboard state lock already released');
        released = true;
        const errors: unknown[] = [];
        try { connection.rollback(); } catch (error) { errors.push(error); }
        try { connection.close(); } catch (error) { errors.push(error); }
        if (errors.length) {
          throw new LockReleaseError('could not release dashboard state lock', {
            cause: new AggregateError(errors),
          });
        }
      },
    };
  } catch (error) {
    try {
      db?.close();
    } catch (closeError) {
      throw new AggregateError([error, closeError], 'could not lock dashboard state');
    }
    throw new Error('could not lock dashboard state', { cause: error });
  }
}

export async function withStateLock<T>(
  lockPath: string,
  waitMs: number,
  fn: () => Promise<T>,
  ops?: LockOps,
): Promise<T> {
  const lock = await acquireStateLock(lockPath, waitMs, ops);
  let result: T;
  try {
    result = await fn();
  } catch (error) {
    try {
      lock.release();
    } catch (releaseError) {
      throw new AggregateError([error, releaseError], 'dashboard state callback and release failed');
    }
    throw error;
  }
  lock.release();
  return result;
}
