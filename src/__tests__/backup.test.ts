import {
  existsSync,
  fstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
  writeSync,
  renameSync,
} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { backupMain, runBackup, landDump } from '../scripts/backup.js';
import type { BackupCommandResult, BackupIO } from '../scripts/backup.js';

const COMPOSE_URL = 'postgresql://postgres:postgres@127.0.0.1:54334/mai_brain';
const CUSTOM_URL = 'postgresql://brainuser:s3cret-pass@db.example.invalid:5432/brain';
const DATE = '2026-09-13';
const BODY = [
  'CREATE TABLE public.decisions (id uuid);',
  'COPY public.decisions (id) FROM stdin;',
  '11111111-1111-1111-1111-111111111111',
  '\\.',
].join('\n');
const BANNER_A = '-- PostgreSQL database dump\n\\restrict aaaa\n';
const BANNER_B = '-- PostgreSQL database dump (client 17.6)\n\\restrict bbbb\n';
const DUMP_A = `${BANNER_A}${BODY}\n\\unrestrict aaaa\n`;
const DUMP_B = `${BANNER_B}${BODY}\n\\unrestrict bbbb\n`;
const MAINTENANCE = path.resolve('scripts/windows/install-maintenance.ps1');
const roots: string[] = [];

interface Call { command: string; args: readonly string[]; env: Record<string, string | undefined>; }

interface FakeOptions {
  docker?: boolean;
  pgDump?: boolean;
  pgIsReady?: boolean;
  probeStatus?: number;
  dumpStatus?: number;
  dumpText?: string;
  dumpStderr?: string;
  duringDump?: (fd: number) => void;
}

function fakeIO(options: FakeOptions = {}): { io: BackupIO; calls: Call[] } {
  const calls: Call[] = [];
  const which = (name: string): string | null => {
    if (name === 'docker') return options.docker === false ? null : '/fake/bin/docker';
    if (name === 'pg_dump') return options.pgDump === false ? null : '/fake/bin/pg_dump';
    if (name === 'pg_isready') return options.pgIsReady === false ? null : '/fake/bin/pg_isready';
    return null;
  };
  const io: BackupIO = {
    whichCommand: which,
    runCommand: (command, args, env): BackupCommandResult => {
      calls.push({ command, args, env });
      return { status: options.probeStatus ?? 0, stderr: '' };
    },
    dumpToFd: (command, args, env, fd): BackupCommandResult => {
      calls.push({ command, args, env });
      options.duringDump?.(fd);
      const status = options.dumpStatus ?? 0;
      if (status === 0) writeSync(fd, options.dumpText ?? DUMP_A);
      return { status, stderr: options.dumpStderr ?? '' };
    },
    rename: (from, to) => renameSync(from, to),
  };
  return { io, calls };
}

function checkout(): string {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'mai-backup-test-'));
  roots.push(dir);
  return dir;
}

function backups(root: string): string {
  return path.join(root, 'db', 'backups');
}

function seedPrior(root: string, name: string, text: string): string {
  mkdirSync(backups(root), { recursive: true });
  const file = path.join(backups(root), name);
  writeFileSync(file, text);
  return file;
}

function sqlFiles(root: string): string[] {
  return existsSync(backups(root)) ? readdirSync(backups(root)).sort() : [];
}

afterEach(() => {
  for (const dir of roots.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe('portable atomic backup', () => {
  it('dumps the compose-managed brain through docker exec', async () => {
    const root = checkout();
    const { io, calls } = fakeIO();
    const result = await runBackup({ checkoutRoot: root, dbUrl: COMPOSE_URL, date: DATE }, io);
    expect(result.status).toBe('written');
    expect(result.dumpMode).toBe('docker');
    expect(calls).toHaveLength(2);
    expect(calls[0].command).toBe('/fake/bin/docker');
    expect(calls[0].args).toEqual(['exec', 'mai-brain-pg', 'pg_isready', '--username', 'postgres', '--dbname', 'mai_brain']);
    expect(calls[1].args).toEqual(['exec', 'mai-brain-pg', 'pg_dump', '--no-owner', '--clean', '--if-exists', '--username', 'postgres', 'mai_brain']);
    expect(sqlFiles(root)).toEqual([`${DATE}.sql`]);
    expect(readFileSync(path.join(backups(root), `${DATE}.sql`), 'utf8')).toBe(DUMP_A);
    expect(result.dataStatements).toBe(1);
  });

  it('dumps a custom database with the host pg_dump and env credentials, never the URL in argv', async () => {
    const root = checkout();
    const { io, calls } = fakeIO();
    const result = await runBackup({ checkoutRoot: root, dbUrl: CUSTOM_URL, date: DATE }, io);
    expect(result.status).toBe('written');
    expect(result.dumpMode).toBe('host');
    expect(calls[0].command).toBe('/fake/bin/pg_isready');
    expect(calls[1].command).toBe('/fake/bin/pg_dump');
    expect(calls[1].args).toEqual(['--no-owner', '--clean', '--if-exists']);
    expect(calls[1].env.PGPASSWORD).toBe('s3cret-pass');
    expect(calls[1].env.PGDATABASE).toBe('brain');
    for (const call of calls) expect(JSON.stringify(call.args)).not.toContain('postgresql://');
  });

  it('skips the round when the database is unreachable', async () => {
    const root = checkout();
    const { io, calls } = fakeIO({ probeStatus: 2 });
    const result = await runBackup({ checkoutRoot: root, dbUrl: COMPOSE_URL, date: DATE }, io);
    expect(result.status).toBe('unreachable');
    expect(calls).toHaveLength(1);
    expect(sqlFiles(root)).toEqual([]);
  });

  it('a nonzero pg_dump retains the durable dump and leaves no temp behind', async () => {
    const root = checkout();
    const prior = seedPrior(root, '2026-09-12.sql', DUMP_A);
    const { io } = fakeIO({ dumpStatus: 1, dumpStderr: 'pg_dump: error: connection refused' });
    await expect(runBackup({ checkoutRoot: root, dbUrl: COMPOSE_URL, date: DATE }, io))
      .rejects.toThrow(/pg_dump failed \(status 1\): pg_dump: error: connection refused/);
    expect(readFileSync(prior, 'utf8')).toBe(DUMP_A);
    expect(sqlFiles(root)).toEqual(['2026-09-12.sql']);
  });

  it('an empty dump is refused and replaces nothing', async () => {
    const root = checkout();
    const prior = seedPrior(root, '2026-09-12.sql', DUMP_A);
    const { io } = fakeIO({ dumpText: '' });
    await expect(runBackup({ checkoutRoot: root, dbUrl: COMPOSE_URL, date: DATE }, io))
      .rejects.toThrow(/dump is empty/);
    expect(readFileSync(prior, 'utf8')).toBe(DUMP_A);
    expect(sqlFiles(root)).toEqual(['2026-09-12.sql']);
  });

  it('streams into a private dot-prefixed temp file and lands the dump by rename', async () => {
    const root = checkout();
    seedPrior(root, `${DATE}.sql`, 'stale content that must survive until the rename');
    const observed: { value: { entries: string[]; sameInode: boolean } | null } = { value: null };
    const { io } = fakeIO({
      dumpText: DUMP_B,
      duringDump: (fd) => {
        const entries = readdirSync(backups(root)).sort();
        const temp = entries.find((name) => name.startsWith(`.${DATE}.sql.`));
        const sameInode = temp !== undefined && statSync(path.join(backups(root), temp)).ino === fstatSync(fd).ino;
        observed.value = { entries, sameInode };
        expect(readFileSync(path.join(backups(root), `${DATE}.sql`), 'utf8')).toContain('stale content');
      },
    });
    const result = await runBackup({ checkoutRoot: root, dbUrl: COMPOSE_URL, date: DATE }, io);
    expect(result.status).toBe('written');
    expect(observed.value).not.toBeNull();
    expect(observed.value?.sameInode).toBe(true);
    expect(observed.value?.entries.filter((name) => name.startsWith('.'))).toHaveLength(1);
    expect(sqlFiles(root)).toEqual([`${DATE}.sql`]);
    expect(readFileSync(path.join(backups(root), `${DATE}.sql`), 'utf8')).toBe(DUMP_B);
  });

  it('an unchanged dump under a different banner and restrict token is skipped', async () => {
    const root = checkout();
    const prior = seedPrior(root, '2026-09-12.sql', DUMP_A);
    const { io } = fakeIO({ dumpText: DUMP_B });
    const result = await runBackup({ checkoutRoot: root, dbUrl: COMPOSE_URL, date: DATE }, io);
    expect(result.status).toBe('unchanged');
    expect(result.outputPath).toBe(realpathSync(prior));
    expect(sqlFiles(root)).toEqual(['2026-09-12.sql']);
  });

  it('a meaningful data change writes a new dump', async () => {
    const root = checkout();
    seedPrior(root, '2026-09-12.sql', DUMP_A);
    const changed = DUMP_B.replace('11111111-1111-1111-1111-111111111111', '22222222-2222-2222-2222-222222222222');
    const { io } = fakeIO({ dumpText: changed });
    const result = await runBackup({ checkoutRoot: root, dbUrl: COMPOSE_URL, date: DATE }, io);
    expect(result.status).toBe('written');
    expect(sqlFiles(root)).toEqual(['2026-09-12.sql', `${DATE}.sql`]);
  });

  it('redacts the URL, password and home path from a failing dump error', async () => {
    const root = checkout();
    const home = os.homedir();
    const { io } = fakeIO({
      dumpStatus: 2,
      dumpStderr: `pg_dump: error: could not connect to ${CUSTOM_URL} as brainuser with s3cret-pass from ${home}/.pgpass`,
    });
    let message = '';
    try {
      await runBackup({ checkoutRoot: root, dbUrl: CUSTOM_URL, date: DATE }, io);
    } catch (error) {
      message = error instanceof Error ? error.message : String(error);
    }
    expect(message).toContain('pg_dump failed (status 2)');
    expect(message).toContain('[redacted]');
    expect(message).not.toContain(CUSTOM_URL);
    expect(message).not.toContain('s3cret-pass');
    expect(message).not.toContain(home);
  });

  it('--commit warns and stays local-only', async () => {
    const root = checkout();
    const { io, calls } = fakeIO();
    const result = await backupMain(['--commit'], { io, checkoutRoot: root, dbUrl: COMPOSE_URL });
    expect(result.code).toBe(0);
    expect(result.stderr).toEqual(['[backup] WARNING: --commit is deprecated and ignored; database backups are local-only']);
    expect(result.stdout[0]).toMatch(/^\[backup\] wrote \d{4}-\d{2}-\d{2}\.sql \(\d+ bytes, 1 data statements, docker pg_dump\)$/);
    expect(sqlFiles(root)).toHaveLength(1);
    expect(calls.map((call) => call.command)).not.toContain('git');
  });

  it('--push warns and stays local-only', async () => {
    const root = checkout();
    const { io, calls } = fakeIO();
    const result = await backupMain(['--push'], { io, checkoutRoot: root, dbUrl: COMPOSE_URL });
    expect(result.code).toBe(0);
    expect(result.stderr).toEqual(['[backup] WARNING: --push is deprecated and ignored; database backups are local-only']);
    expect(sqlFiles(root)).toHaveLength(1);
    expect(calls.map((call) => call.command)).not.toContain('git');
  });

  it('an unsupported option is fatal before any dump is attempted', async () => {
    const root = checkout();
    const { io, calls } = fakeIO();
    const result = await backupMain(['--upload'], { io, checkoutRoot: root, dbUrl: COMPOSE_URL });
    expect(result.code).toBe(2);
    expect(result.stderr).toEqual(["[backup] FATAL: unsupported option '--upload'; database backups are local-only"]);
    expect(calls).toHaveLength(0);
    expect(sqlFiles(root)).toEqual([]);
  });

  it('the log line never carries a URL or credential even when the failing stderr does', async () => {
    const root = checkout();
    const log = path.join(root, 'state', 'logs', 'backup.log');
    const { io } = fakeIO({ dumpStatus: 3, dumpStderr: `fatal: ${CUSTOM_URL} password=s3cret-pass` });
    const result = await backupMain(['--log-file', log], { io, checkoutRoot: root, dbUrl: CUSTOM_URL });
    expect(result.code).toBe(1);
    const line = readFileSync(log, 'utf8');
    expect(line).toMatch(/^\d{4}-\d{2}-\d{2}T[^ ]+ failed - 0\n$/);
    expect(line).not.toContain('postgresql://');
    expect(line).not.toContain('s3cret-pass');
    expect(result.stderr.join('\n')).not.toContain(CUSTOM_URL);
    expect(result.stderr.join('\n')).not.toContain('s3cret-pass');

    const ok = await backupMain(['--log-file', log], { io: fakeIO().io, checkoutRoot: root, dbUrl: COMPOSE_URL });
    expect(ok.code).toBe(0);
    const lines = readFileSync(log, 'utf8').trim().split('\n');
    expect(lines).toHaveLength(2);
    expect(lines[1]).toMatch(/ written \d{4}-\d{2}-\d{2}\.sql \d+$/);
  });

  it('a symlinked log directory is refused', async () => {
    const root = checkout();
    const real = path.join(root, 'elsewhere');
    mkdirSync(real);
    const link = path.join(root, 'logs');
    try {
      symlinkSync(real, link, 'dir');
    } catch {
      return; // no symlink privilege on this host
    }
    const { io } = fakeIO();
    const result = await backupMain(['--log-file', path.join(link, 'backup.log')], { io, checkoutRoot: root, dbUrl: COMPOSE_URL });
    expect(result.code).toBe(1);
    expect(result.stderr.join('\n')).toContain('not a symlink or reparse point');
    expect(readdirSync(real)).toEqual([]);
  });

  it('the Windows scheduled backup action is absolute node plus entry.js backup --log-file under LOCALAPPDATA at 04:30', () => {
    const source = readFileSync(MAINTENANCE, 'utf8');
    expect(source).toContain("$entry = Join-Path $Root 'build\\entry.js'");
    expect(source).toContain("$logFile = Join-Path (Join-Path (Join-Path $env:LOCALAPPDATA 'mai-mcp') 'logs') 'backup.log'");
    expect(source).toContain("Arguments  = @($entry, 'backup', '--log-file', $logFile)");
    expect(source).toContain("Triggers   = @('Daily 04:30')");
    expect(source).not.toMatch(/backup-brain\.sh/);
    expect(source).not.toMatch(/bash/i);
    expect(source).not.toMatch(/--commit|--push/);
  });
});

describe('landDump — the bounded Windows rename retry', () => {
  const failing = (codes: readonly string[]) => {
    const calls: Array<[string, string]> = [];
    const io = { rename: (from: string, to: string): void => {
      calls.push([from, to]);
      const code = codes[calls.length - 1];
      if (code !== undefined) throw Object.assign(new Error(code), { code });
    } };
    return { io, calls };
  };
  const noWait = { wait: () => undefined };

  it('retries a transient Windows refusal and lands on the first success', () => {
    const { io, calls } = failing(['EPERM', 'EBUSY']);
    landDump(io, 'a', 'b', { platform: 'win32', ...noWait });
    expect(calls).toEqual([['a', 'b'], ['a', 'b'], ['a', 'b']]);
  });

  it('gives up after six attempts and rethrows the original error', () => {
    const { io, calls } = failing(['EPERM', 'EPERM', 'EPERM', 'EPERM', 'EPERM', 'EPERM', 'EPERM']);
    expect(() => landDump(io, 'a', 'b', { platform: 'win32', ...noWait })).toThrow('EPERM');
    expect(calls).toHaveLength(6);
  });

  it('never retries a non-transient code on Windows or any code elsewhere', () => {
    const cross = failing(['EXDEV']);
    expect(() => landDump(cross.io, 'a', 'b', { platform: 'win32', ...noWait })).toThrow('EXDEV');
    expect(cross.calls).toHaveLength(1);
    const posix = failing(['EPERM']);
    expect(() => landDump(posix.io, 'a', 'b', { platform: 'linux', ...noWait })).toThrow('EPERM');
    expect(posix.calls).toHaveLength(1);
  });
});
