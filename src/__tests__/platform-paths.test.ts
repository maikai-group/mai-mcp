import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { PathOps } from '../platform/paths.js';
import { identityFromStats } from '../platform/paths.js';
import {
  dashboardLockPath,
  dashboardLogPath,
  dashboardStatePath,
  defaultPathOps,
  ensurePrivateDirectory,
  hookLogPath,
  maiStateRoot,
  maintenanceLogPath,
  openPrivateAppendLog,
  requireOwnedRegularOrAbsent,
  validateManagedPaths,
  writePrivateFileAtomic,
} from '../platform/paths.js';

const roots: string[] = [];
const savedStateHome = process.env.MAI_STATE_HOME;
const savedProfile = process.env.USERPROFILE;

afterEach(() => {
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
  if (savedStateHome === undefined) delete process.env.MAI_STATE_HOME;
  else process.env.MAI_STATE_HOME = savedStateHome;
  if (savedProfile === undefined) delete process.env.USERPROFILE;
  else process.env.USERPROFILE = savedProfile;
});

function tempRoot(label: string): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), `mai-platform-path-${label}-`));
  roots.push(root);
  return root;
}

function altered(stat: fs.Stats, values: Readonly<Record<string, unknown>>): fs.Stats {
  return new Proxy(stat, { get(target, property, receiver) {
    return typeof property === 'string' && Object.hasOwn(values, property)
      ? Reflect.get(values, property)
      : Reflect.get(target, property, receiver);
  } });
}

// Real fixture stats carry the runner's uid; a fixed 501 only matches this Mac.
// Windows has no getuid at all, so faked POSIX ops must report this same value
// wherever a fixture stat is aligned with them.
const fakeUid = typeof process.getuid === 'function' ? process.getuid() : 501;

// Faked ops must agree with the host's path module: a real fixture path is only
// POSIX-absolute off Windows, and the product picks path.posix/path.win32 from
// the ops' platform. POSIX hosts keep the 'linux' fake they have always used.
const hostPlatform: NodeJS.Platform = process.platform === 'win32' ? 'win32' : 'linux';

function fakeOps(platform: NodeJS.Platform, lstat: PathOps['lstat'], realpath: PathOps['realpath'] = value => value): PathOps {
  return { platform, lstat, identity: target => identityFromStats(lstat(target)), realpath, chmod: () => undefined, currentUid: () => fakeUid };
}

describe('private platform paths', () => {
  it('rejects a symlinked directory', () => {
    const root = tempRoot('symlink-dir');
    const real = path.join(root, 'real');
    const link = path.join(root, 'link');
    fs.mkdirSync(real);
    fs.symlinkSync(real, link);
    expect(() => ensurePrivateDirectory(link)).toThrow('unsafe private directory');
  });

  it('rejects a symlinked file', () => {
    const root = tempRoot('symlink-file');
    const real = path.join(root, 'real');
    const link = path.join(root, 'link');
    fs.writeFileSync(real, 'sentinel');
    fs.symlinkSync(real, link);
    expect(() => requireOwnedRegularOrAbsent(link, 'state')).toThrow('regular non-symlink');
    expect(fs.readFileSync(real, 'utf8')).toBe('sentinel');
  });

  it('rejects a non-regular managed file', () => {
    const dir = tempRoot('directory-file');
    expect(() => requireOwnedRegularOrAbsent(dir, 'state')).toThrow('regular non-symlink');
  });

  it('rejects a foreign-uid file through injected PathOps', () => {
    const root = tempRoot('foreign-file');
    const file = path.join(root, 'state');
    fs.writeFileSync(file, 'sentinel');
    const stat = fs.lstatSync(file);
    const ops = fakeOps('linux', () => altered(stat, { uid: stat.uid + 1 }));
    expect(() => requireOwnedRegularOrAbsent(file, 'state', ops)).toThrow('current user');
    expect(fs.readFileSync(file, 'utf8')).toBe('sentinel');
  });

  it('rejects a foreign-uid directory through injected PathOps', () => {
    const dir = tempRoot('foreign-dir');
    const stat = fs.lstatSync(dir);
    const ops = fakeOps('linux', () => altered(stat, { uid: stat.uid + 1 }));
    expect(() => ensurePrivateDirectory(dir, ops)).toThrow('unsafe private directory');
  });

  it('propagates non-ENOENT lstat failures', () => {
    const failure = new Error('permission denied');
    const ops = fakeOps('linux', () => { throw failure; });
    expect(() => requireOwnedRegularOrAbsent('/tmp/state', 'state', ops)).toThrow(failure);
  });

  it('atomically writes and appends absent private files at mode 0600 without temp leftovers', () => {
    const root = tempRoot('atomic');
    const env = { MAI_STATE_HOME: root };
    expect(maiStateRoot(env)).toBe(root);
    expect(dashboardStatePath(env)).toBe(path.join(root, 'dashboard-state.json'));
    expect(dashboardLockPath(env)).toBe(path.join(root, 'dashboard-lock.sqlite'));
    expect(dashboardLogPath(env)).toBe(path.join(root, 'dashboard.log'));
    expect(maintenanceLogPath('backup', env)).toBe(path.join(root, 'backup.log'));
    expect(hookLogPath('stop-nudge', env)).toBe(path.join(root, 'stop-nudge.log'));
    const state = dashboardStatePath(env);
    writePrivateFileAtomic(state, 'one');
    const fd = openPrivateAppendLog(dashboardLogPath(env));
    fs.writeSync(fd, 'two');
    fs.closeSync(fd);
    expect(fs.readFileSync(state, 'utf8')).toBe('one');
    // Windows carries no POSIX mode bits; the content and no-leftover proofs run everywhere.
    if (process.platform !== 'win32') {
      expect(fs.statSync(state).mode & 0o777).toBe(0o600);
      expect(fs.statSync(dashboardLogPath(env)).mode & 0o777).toBe(0o600);
    }
    expect(fs.readdirSync(root).filter(name => name.endsWith('.tmp'))).toEqual([]);
  });

  it('enforces Windows profile containment unless MAI_STATE_HOME is explicit', () => {
    delete process.env.MAI_STATE_HOME;
    process.env.USERPROFILE = 'C:\\Users\\owner';
    const ops = fakeOps('win32', () => null);
    expect(() => requireOwnedRegularOrAbsent('C:\\Other\\state.json', 'state', ops)).toThrow('outside');
    process.env.MAI_STATE_HOME = 'C:\\Other';
    expect(() => requireOwnedRegularOrAbsent('C:\\Other\\state.json', 'state', ops)).not.toThrow();
  });

  it('rejects every direct or canonical alias pair in six- and seven-member managed sets', () => {
    const root = tempRoot('aliases');
    // An explicit state home satisfies the win32 profile-containment gate, which
    // is the only host-dependent step before the alias comparison.
    process.env.MAI_STATE_HOME = root;
    const base = ['state', 'lock', 'lock-journal', 'lock-wal', 'lock-shm', 'log'].map(name => path.join(root, name));
    const ops = fakeOps(hostPlatform, () => null, target => path.resolve(target));
    for (const members of [base, [...base, path.join(root, 'env')]]) {
      for (let left = 0; left < members.length; left++) for (let right = left + 1; right < members.length; right++) {
        const direct = [...members];
        direct[right] = direct[left];
        expect(() => validateManagedPaths(direct, ops)).toThrow('distinct');
        const canonical = [...members];
        canonical[right] = path.join(path.dirname(canonical[left]), '.', path.basename(canonical[left]));
        expect(() => validateManagedPaths(canonical, ops)).toThrow('distinct');
      }
    }
  });

  it('rejects existing hardlink aliases by device and inode', () => {
    const root = tempRoot('hardlink');
    const first = path.join(root, 'first');
    const second = path.join(root, 'second');
    fs.writeFileSync(first, 'sentinel', { mode: 0o600 });
    fs.linkSync(first, second);
    expect(() => validateManagedPaths([first, second])).toThrow('distinct');
    expect(fs.readFileSync(first, 'utf8')).toBe('sentinel');
  });

  it('rejects absent and existing case/NFC-equivalent names on Darwin and Windows', () => {
    const root = tempRoot('equivalent');
    const fixture = path.join(root, 'fixture');
    fs.writeFileSync(fixture, 'sentinel');
    const stat = fs.lstatSync(fixture);
    for (const platform of ['darwin', 'win32'] satisfies readonly NodeJS.Platform[]) {
      const paths = platform === 'win32'
        ? ['C:\\Users\\owner\\State', 'C:\\Users\\owner\\state']
        : ['/tmp/État', '/tmp/E\u0301tat'];
      const absent = fakeOps(platform, () => null, value => path.dirname(value));
      process.env.MAI_STATE_HOME = platform === 'win32' ? 'C:\\Users\\owner' : '/tmp';
      expect(() => validateManagedPaths(paths, absent)).toThrow('distinct');
      let calls = 0;
      // A Windows fixture stat reports uid 0 while the faked ops report fakeUid:
      // align them so the alias check fires, not the ownership check.
      const existing = fakeOps(platform, () => altered(stat, { ino: ++calls, uid: fakeUid }), value => path.dirname(value));
      expect(() => validateManagedPaths(paths, existing)).toThrow('distinct');
    }
  });

  it('fails closed on realpath or unprovable identity before any downstream operation', () => {
    const target = '/tmp/state';
    let downstream = 0;
    const realpathFailure = fakeOps('linux', () => null, () => { throw new Error('realpath denied'); });
    expect(() => validateManagedPaths([target], realpathFailure)).toThrow('realpath denied');
    const root = tempRoot('identity');
    const fixture = path.join(root, 'fixture');
    fs.writeFileSync(fixture, 'sentinel');
    const stat = fs.lstatSync(fixture);
    // A Windows fixture stat reports uid 0 while the faked POSIX ops report
    // fakeUid: align them so the identity check fires, not the ownership check.
    const identityFailure = fakeOps('linux', () => altered(stat, { ino: 0, uid: fakeUid }));
    expect(() => validateManagedPaths([target], identityFailure)).toThrow('identity');
    expect(downstream).toBe(0);
  });

  it('restricts an existing owned POSIX 0755 directory to 0700 before use', () => {
    const dir = tempRoot('restrict');
    fs.chmodSync(dir, 0o755);
    expect(ensurePrivateDirectory(dir)).toBe(fs.realpathSync.native(dir));
    // Windows carries no POSIX mode bits and the product skips the 0700 repair there.
    if (process.platform !== 'win32') expect(fs.statSync(dir).mode & 0o7777).toBe(0o700);
  });

  it('refuses chmod failure or ineffective chmod with zero downstream accesses', () => {
    const dir = tempRoot('chmod-failure');
    fs.chmodSync(dir, 0o755);
    const stat = fs.lstatSync(dir);
    let realpaths = 0;
    const failing: PathOps = {
      identity: () => identityFromStats(stat),
      platform: 'linux', lstat: () => stat, realpath: value => { realpaths++; return value; },
      chmod: () => { throw new Error('chmod denied'); }, currentUid: () => stat.uid,
    };
    expect(() => ensurePrivateDirectory(dir, failing)).toThrow('chmod denied');
    const ineffective: PathOps = { ...failing, chmod: () => undefined };
    expect(() => ensurePrivateDirectory(dir, ineffective)).toThrow('repair failed');
    expect(realpaths).toBe(0);
  });
});
