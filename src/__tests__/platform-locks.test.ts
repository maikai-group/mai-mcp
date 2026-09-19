import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { once } from 'node:events';
import { setTimeout as delay } from 'node:timers/promises';
import { afterEach, describe, expect, it } from 'vitest';
import type { LockConnection, LockOps } from '../platform/locks.js';
import {
  acquireStateLock,
  defaultLockOps,
  LockReleaseError,
  withStateLock,
} from '../platform/locks.js';
import type { PathOps } from '../platform/paths.js';
import { defaultPathOps } from '../platform/paths.js';

const roots: string[] = [];
const children = new Set<number>();

afterEach(() => {
  for (const pid of children) {
    try { process.kill(pid, 'SIGKILL'); } catch { /* already gone */ }
  }
  children.clear();
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

function tempRoot(label: string): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), `mai-platform-lock-${label}-`));
  fs.chmodSync(root, 0o700);
  roots.push(root);
  return root;
}

function lockPath(label: string): string {
  return path.join(tempRoot(label), 'dashboard-lock.sqlite');
}

function busyError(): Error {
  const error = new Error('busy');
  Reflect.set(error, 'errcode', 5);
  return error;
}

function fakeLockOps(connection: LockConnection, pathOps: PathOps = defaultPathOps()): LockOps {
  return {
    pathOps,
    now: () => performance.now(),
    sleep: delay,
    openDatabase: () => connection,
  };
}

async function firstOutput(child: ReturnType<typeof spawn>): Promise<string> {
  const stdout = child.stdout;
  if (!stdout) throw new Error('fixture stdout unavailable');
  const values = await once(stdout, 'data');
  const value = values[0];
  return Buffer.isBuffer(value) ? value.toString('utf8').trim() : String(value).trim();
}

describe('SQLite dashboard state lock', () => {
  it('L01 — acquires a free path and retains the private permanent file after release', async () => {
    const file = lockPath('l01');
    const lock = await acquireStateLock(file, 0);
    const before = fs.lstatSync(file);
    lock.release();
    const after = fs.lstatSync(file);
    expect(after.ino).toBe(before.ino);
    // Windows carries no POSIX mode bits; retention of the same file still proves out.
    if (process.platform !== 'win32') expect(after.mode & 0o777).toBe(0o600);
  });

  it('L02 — retries a live owner to the exact injected deadline while yielding', async () => {
    const file = lockPath('l02');
    let now = 0;
    const sleeps: number[] = [];
    let begins = 0;
    const connection: LockConnection = {
      begin() { begins++; throw busyError(); }, rollback() {}, close() {},
    };
    const ops: LockOps = {
      pathOps: defaultPathOps(), now: () => now,
      async sleep(ms) { sleeps.push(ms); await Promise.resolve(); now += ms; },
      openDatabase: () => connection,
    };
    await expect(acquireStateLock(file, 250, ops)).rejects.toThrow('could not lock');
    expect(sleeps).toEqual([100, 100, 50]);
    expect(begins).toBe(3);
  });

  it('L03 — releases a dead owner through OS locking without deleting the file', async () => {
    const file = lockPath('l03');
    fs.writeFileSync(file, '', { mode: 0o600 });
    const script = `const{DatabaseSync}=require('node:sqlite');const d=new DatabaseSync(process.argv[1]);d.exec('PRAGMA journal_mode=delete');d.exec('BEGIN IMMEDIATE');console.log('ready');setInterval(()=>{},1000)`;
    const holder = spawn(process.execPath, ['-e', script, file], { stdio: ['ignore', 'pipe', 'inherit'] });
    if (holder.pid === undefined) throw new Error('holder has no pid');
    children.add(holder.pid);
    expect(await firstOutput(holder)).toBe('ready');
    const inode = fs.lstatSync(file).ino;
    await expect(acquireStateLock(file, 0)).rejects.toThrow('could not lock');
    holder.kill('SIGKILL');
    await once(holder, 'close');
    children.delete(holder.pid);
    const acquired = await acquireStateLock(file, 500);
    acquired.release();
    expect(fs.lstatSync(file).ino).toBe(inode);
  });

  it('L04 — serializes three contenders after owner death without replacing the lock file', async () => {
    const file = lockPath('l04');
    const owner = await acquireStateLock(file, 0);
    const inode = fs.lstatSync(file).ino;
    const bytes = fs.readFileSync(file);
    const entered: string[] = [];
    const contender = (name: string) => acquireStateLock(file, 2_000).then(lock => {
      entered.push(name);
      return lock;
    });
    const b = contender('b');
    const c = contender('c');
    await delay(25);
    owner.release();
    const winner = await Promise.race([b, c]);
    await delay(40);
    expect(entered).toHaveLength(1);
    winner.release();
    const both = await Promise.all([b, c]);
    for (const lock of both) {
      if (lock !== winner) lock.release();
    }
    expect(new Set(entered)).toEqual(new Set(['b', 'c']));
    expect(fs.lstatSync(file).ino).toBe(inode);
    expect(fs.readFileSync(file)).toEqual(bytes);
  });

  it('L05 — excludes a live owner without consulting PID or birth probes', async () => {
    const file = lockPath('l05');
    const owner = await acquireStateLock(file, 0);
    await expect(acquireStateLock(file, 0)).rejects.toThrow('could not lock');
    owner.release();
    const next = await acquireStateLock(file, 0);
    next.release();
  });

  it('L06 — reports rollback and close failures and rejects a second release', async () => {
    const file = lockPath('l06');
    const rollbackFailure = new Error('rollback failed');
    const closeFailure = new Error('close failed');
    const lock = await acquireStateLock(file, 0, fakeLockOps({
      begin() {}, rollback() { throw rollbackFailure; }, close() { throw closeFailure; },
    }));
    expect(() => lock.release()).toThrow(LockReleaseError);
    expect(() => lock.release()).toThrow('already released');
  });

  it('L07 — refuses a symlinked lock before opening SQLite', async () => {
    const root = tempRoot('l07');
    const target = path.join(root, 'target');
    const link = path.join(root, 'lock');
    fs.writeFileSync(target, 'sentinel');
    fs.symlinkSync(target, link);
    let opens = 0;
    const ops = fakeLockOps({ begin() {}, rollback() {}, close() {} });
    ops.openDatabase = () => { opens++; return { begin() {}, rollback() {}, close() {} }; };
    await expect(acquireStateLock(link, 0, ops)).rejects.toThrow('could not lock');
    expect(opens).toBe(0);
    expect(fs.readFileSync(target, 'utf8')).toBe('sentinel');
  });

  it('L08 — releases after a throwing callback and preserves dual failures', async () => {
    const file = lockPath('l08');
    const callbackFailure = new Error('callback failed');
    await expect(withStateLock(file, 0, async () => { throw callbackFailure; })).rejects.toBe(callbackFailure);
    const reacquired = await acquireStateLock(file, 0);
    reacquired.release();
    const ops = fakeLockOps({ begin() {}, rollback() { throw new Error('release failed'); }, close() {} });
    await expect(withStateLock(path.join(tempRoot('l08-dual'), 'lock'), 0, async () => {
      throw callbackFailure;
    }, ops)).rejects.toBeInstanceOf(AggregateError);
  });

  it('L09 — refuses an injected foreign-owned lock path', async () => {
    const file = lockPath('l09');
    fs.writeFileSync(file, '', { mode: 0o600 });
    const defaults = defaultPathOps();
    const stat = fs.lstatSync(file);
    const pathOps: PathOps = {
      ...defaults,
      lstat: target => target === file
        ? new Proxy(stat, { get(value, property, receiver) {
          return property === 'uid' ? stat.uid + 1 : Reflect.get(value, property, receiver);
        } })
        : defaults.lstat(target),
    };
    let opens = 0;
    const ops = fakeLockOps({ begin() {}, rollback() {}, close() {} }, pathOps);
    ops.openDatabase = () => { opens++; return { begin() {}, rollback() {}, close() {} }; };
    // Windows files carry no uid, so the product proves ownership there by
    // user-profile containment: inject the foreign owner by moving the profile
    // off the lock path instead of faking a foreign uid.
    const savedProfile = process.env.USERPROFILE;
    const savedStateHome = process.env.MAI_STATE_HOME;
    if (process.platform === 'win32') {
      process.env.USERPROFILE = path.join(path.parse(file).root, 'Users', 'another-account');
      delete process.env.MAI_STATE_HOME;
    }
    try {
      await expect(acquireStateLock(file, 0, ops)).rejects.toThrow('could not lock');
      expect(opens).toBe(0);
    } finally {
      if (process.platform === 'win32') {
        if (savedProfile === undefined) delete process.env.USERPROFILE;
        else process.env.USERPROFILE = savedProfile;
        if (savedStateHome === undefined) delete process.env.MAI_STATE_HOME;
        else process.env.MAI_STATE_HOME = savedStateHome;
      }
    }
  });

  it('L10 — fails closed when the lock directory cannot be prepared', async () => {
    const root = tempRoot('l10');
    const parent = path.join(root, 'not-directory');
    fs.writeFileSync(parent, 'sentinel');
    await expect(acquireStateLock(path.join(parent, 'lock'), 0)).rejects.toThrow('could not lock');
    expect(fs.readFileSync(parent, 'utf8')).toBe('sentinel');
  });

  it('L11 — refuses a non-regular lock path', async () => {
    const root = tempRoot('l11');
    const file = path.join(root, 'lock');
    fs.mkdirSync(file);
    await expect(acquireStateLock(file, 0)).rejects.toThrow('could not lock');
    expect(fs.statSync(file).isDirectory()).toBe(true);
  });

  it('L12 — refuses corrupt SQLite input without replacing or truncating it', async () => {
    const file = lockPath('l12');
    const sentinel = Buffer.from('not a sqlite database');
    fs.writeFileSync(file, sentinel, { mode: 0o600 });
    const inode = fs.lstatSync(file).ino;
    await expect(acquireStateLock(file, 0)).rejects.toThrow('could not lock');
    expect(fs.lstatSync(file).ino).toBe(inode);
    expect(fs.readFileSync(file)).toEqual(sentinel);
  });

  it('L13 — refuses unsafe mode, hardlink, unsafe journal, and WAL sidecars before database open', async () => {
    const cases: Array<{ posixOnly?: string; create: () => string }> = [
      {
        // Group/other mode bits exist only on POSIX; the product skips the mode check on win32.
        posixOnly: 'unsafe POSIX mode',
        create: () => {
          const file = lockPath('l13-mode'); fs.writeFileSync(file, '', { mode: 0o644 }); return file;
        },
      },
      { create: () => {
        const file = lockPath('l13-link'); fs.writeFileSync(file, '', { mode: 0o600 }); fs.linkSync(file, `${file}.alias`); return file;
      } },
      { create: () => {
        const file = lockPath('l13-journal'); fs.writeFileSync(file, '', { mode: 0o600 });
        const target = `${file}.target`; fs.writeFileSync(target, 'sentinel'); fs.symlinkSync(target, `${file}-journal`); return file;
      } },
      { create: () => {
        const file = lockPath('l13-wal'); fs.writeFileSync(file, '', { mode: 0o600 }); fs.writeFileSync(`${file}-wal`, '', { mode: 0o600 }); return file;
      } },
    ];
    for (const { posixOnly, create } of cases) {
      if (posixOnly && process.platform === 'win32') continue;
      let opens = 0;
      const ops = fakeLockOps({ begin() {}, rollback() {}, close() {} });
      ops.openDatabase = () => { opens++; return { begin() {}, rollback() {}, close() {} }; };
      await expect(acquireStateLock(create(), 0, ops)).rejects.toThrow('could not lock');
      expect(opens).toBe(0);
    }
  });

  it('L14 — closes on non-BUSY SQLite failure without retrying', async () => {
    const file = lockPath('l14');
    let begins = 0;
    let closes = 0;
    const ops = fakeLockOps({
      begin() { begins++; throw new Error('corrupt'); }, rollback() {}, close() { closes++; },
    });
    await expect(acquireStateLock(file, 5_000, ops)).rejects.toThrow('could not lock');
    expect({ begins, closes }).toEqual({ begins: 1, closes: 1 });
  });

  it('L15 — same-process contention yields until the owner releases', async () => {
    const file = lockPath('l15');
    const owner = await acquireStateLock(file, 0);
    let entered = false;
    const contender = acquireStateLock(file, 1_000).then(lock => { entered = true; return lock; });
    await delay(25);
    expect(entered).toBe(false);
    owner.release();
    const next = await contender;
    expect(entered).toBe(true);
    next.release();
  });

  it('L16 — a spawned fixture child retains no lock after its abrupt owner exits', async () => {
    const file = lockPath('l16');
    fs.writeFileSync(file, '', { mode: 0o600 });
    // The descendant must outlive its owner's abrupt exit for the probe below to
    // discriminate: detached gives it its own console/process group, which is what
    // Windows needs to survive an orphaning parent (a no-op difference on POSIX).
    const script = `const{spawn}=require('node:child_process');const{DatabaseSync}=require('node:sqlite');const d=new DatabaseSync(process.argv[1]);d.exec('PRAGMA journal_mode=delete');d.exec('BEGIN IMMEDIATE');const c=spawn(process.execPath,['-e','setTimeout(()=>{},10000)'],{stdio:'ignore',detached:true});c.unref();console.log(c.pid);process.exit(0)`;
    const owner = spawn(process.execPath, ['-e', script, file], { stdio: ['ignore', 'pipe', 'inherit'] });
    const grandchild = Number(await firstOutput(owner));
    if (!Number.isSafeInteger(grandchild) || grandchild <= 0) throw new Error('invalid grandchild pid');
    children.add(grandchild);
    await once(owner, 'close');
    const lock = await acquireStateLock(file, 500);
    lock.release();
    expect(() => process.kill(grandchild, 0)).not.toThrow();
  });
});
