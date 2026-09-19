import { createHash, randomUUID } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import readline from 'node:readline';
import { findExecutable, spawnArgvSync } from '../platform/commands.js';
import { ensurePrivateDirectory, openPrivateAppendLog } from '../platform/paths.js';
import { DatabaseSetupError, parseDatabaseUrl } from './database-setup.js';
import type { ParsedDatabaseUrl } from './database-setup.js';

/** Portable atomic brain backup (Plan 32b Task 6, spec §9).
 *
 * Backups are local-only and never committed or pushed (decision 2cc63fc1):
 * this module contains no git invocation and no field that could carry one.
 * The deprecated --commit/--push aliases are consumed at the argv boundary in
 * backupMain and never reach the controller. */

export interface BackupArgs {
  checkoutRoot: string;
  dbUrl: string;
  date: string;
}

export interface BackupResult {
  status: 'written' | 'unchanged' | 'unreachable';
  outputPath?: string;
  bytes?: number;
  dataStatements?: number;
  dumpMode: 'docker' | 'host';
}

export interface BackupCommandResult { status: number; stderr: string; }

/** Child operations are injected so tests use fakes and never a live brain. */
export interface BackupIO {
  whichCommand(name: string): string | null;
  /** Runs a probe; stdout is discarded. */
  runCommand(command: string, args: readonly string[], env: Record<string, string | undefined>): BackupCommandResult;
  /** Runs the dump with its stdout streamed straight to `fd` — never a shell redirection. */
  dumpToFd(command: string, args: readonly string[], env: Record<string, string | undefined>, fd: number): BackupCommandResult;
  /** Lands the finished dump: one atomic rename (fs.renameSync in production). */
  rename(from: string, to: string): void;
}

export class BackupError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'BackupError';
  }
}

const CHILD_TIMEOUT = 30 * 60_000;
const COMPOSE_CONTAINER = 'mai-brain-pg';
const DUMP_ARGS = ['--no-owner', '--clean', '--if-exists'] as const;
const NOISE_LINE = /^(--|\\restrict |\\unrestrict )/;
const DATA_STATEMENT = /^(INSERT INTO |COPY )/;
const KNOWN_STATEMENT = /^(CREATE |ALTER |DROP |SET |SELECT |COPY |INSERT INTO )/;
const DURABLE_DUMP = /^[^.].*\.sql$/;

export function defaultBackupIO(): BackupIO {
  const run = (command: string, args: readonly string[], env: Record<string, string | undefined>, stdout: 'ignore' | number) => {
    const result = spawnArgvSync(command, [...args], {
      timeout: CHILD_TIMEOUT, maxBuffer: 16 * 1024 * 1024, env: { ...env }, shell: false,
      stdio: ['ignore', stdout, 'pipe'],
    });
    return {
      status: typeof result.status === 'number' ? result.status : 1,
      stderr: result.stderr?.toString() ?? '',
    };
  };
  return {
    whichCommand: name => findExecutable(name),
    runCommand: (command, args, env) => run(command, args, env, 'ignore'),
    dumpToFd: (command, args, env, fd) => run(command, args, env, fd),
    rename: (from, to) => fs.renameSync(from, to),
  };
}

/** Normalizes only the known nondeterministic pg_dump noise — banner comments
 * and the pg 17+ \restrict/\unrestrict guards — never data, order or content. */
export function normalizeDumpForComparison(sql: string): string {
  return sql.split(/\r?\n/).filter(line => !NOISE_LINE.test(line)).join('\n');
}

export function isComposeManaged(db: ParsedDatabaseUrl): boolean {
  return (db.host === '127.0.0.1' || db.host === 'localhost')
    && db.port === '54334' && db.user === 'postgres' && db.database === 'mai_brain';
}

/** Everything that may appear in a child's stderr and must never reach output. */
export function redact(text: string, secrets: readonly string[]): string {
  let out = text.replace(/postgres(?:ql)?:\/\/[^\s'"]+/g, 'postgresql://[redacted]');
  for (const secret of secrets) {
    if (secret.length > 0) out = out.split(secret).join('[redacted]');
  }
  const home = os.homedir();
  if (home) out = out.split(home).join('~');
  return out;
}

interface DumpPlan {
  mode: 'docker' | 'host';
  probe: { command: string; args: string[] } | null;
  dump: { command: string; args: string[] };
  env: Record<string, string | undefined>;
}

function planDump(io: BackupIO, db: ParsedDatabaseUrl): DumpPlan {
  if (isComposeManaged(db)) {
    const docker = io.whichCommand('docker');
    if (docker === null) throw new BackupError('docker not found on PATH; the compose-managed brain is dumped through Docker');
    const base = ['exec', COMPOSE_CONTAINER];
    return {
      mode: 'docker',
      probe: { command: docker, args: [...base, 'pg_isready', '--username', 'postgres', '--dbname', 'mai_brain'] },
      dump: { command: docker, args: [...base, 'pg_dump', ...DUMP_ARGS, '--username', 'postgres', 'mai_brain'] },
      env: { PATH: process.env.PATH },
    };
  }
  const pgDump = io.whichCommand('pg_dump');
  if (pgDump === null) throw new BackupError('pg_dump not found on PATH');
  const pgIsReady = io.whichCommand('pg_isready');
  const env: Record<string, string | undefined> = {
    PATH: process.env.PATH, PGHOST: db.host, PGPORT: db.port,
    PGUSER: db.user, PGPASSWORD: db.password, PGDATABASE: db.database,
  };
  return {
    mode: 'host',
    probe: pgIsReady === null ? null : { command: pgIsReady, args: [] },
    dump: { command: pgDump, args: [...DUMP_ARGS] },
    env,
  };
}

interface Digest { digest: string; bytes: number; dataStatements: number; knownStatements: number; }

/** Streams a dump once: normalized-content hash plus statement counts, so a
 * multi-gigabyte dump is never held in memory. */
async function digestDump(file: string): Promise<Digest> {
  const hash = createHash('sha256');
  let dataStatements = 0;
  let knownStatements = 0;
  const stream = fs.createReadStream(file, { encoding: 'utf8' });
  const lines = readline.createInterface({ input: stream, crlfDelay: Number.POSITIVE_INFINITY });
  for await (const line of lines) {
    if (NOISE_LINE.test(line)) continue;
    hash.update(line);
    hash.update('\n');
    if (DATA_STATEMENT.test(line)) dataStatements += 1;
    if (KNOWN_STATEMENT.test(line)) knownStatements += 1;
  }
  return { digest: hash.digest('hex'), bytes: fs.statSync(file).size, dataStatements, knownStatements };
}

function latestDurableDump(backupDir: string): string | null {
  let latest: { file: string; mtimeMs: number } | null = null;
  for (const name of fs.readdirSync(backupDir)) {
    if (!DURABLE_DUMP.test(name)) continue;
    const file = path.join(backupDir, name);
    const stat = fs.lstatSync(file);
    if (!stat.isFile() || stat.size === 0) continue;
    if (latest === null || stat.mtimeMs > latest.mtimeMs) latest = { file, mtimeMs: stat.mtimeMs };
  }
  return latest === null ? null : latest.file;
}

function containedBackupDir(checkoutRoot: string): string {
  const root = fs.realpathSync.native(checkoutRoot);
  const dir = path.join(root, 'db', 'backups');
  fs.mkdirSync(dir, { recursive: true });
  const real = fs.realpathSync.native(dir);
  const relative = path.relative(root, real);
  if (relative.startsWith('..') || path.isAbsolute(relative)) throw new BackupError('backup directory escapes the checkout');
  return real;
}

/** Rename the finished dump into place. Windows can refuse a rename of a
 * freshly written file with a transient EPERM/EBUSY/EACCES while Defender or
 * the indexer holds it open; a short bounded retry (the same shape as
 * fs.rmSync's maxRetries) rides that out without changing the atomic step.
 * Exported for its unit tests; `platform` and `wait` are injectable so the
 * bound, the code filter and the platform gate are pinned without a Windows host. */
export function landDump(
  io: Pick<BackupIO, 'rename'>,
  temp: string,
  output: string,
  { platform = process.platform, wait = sleepSync }: { platform?: NodeJS.Platform; wait?: (ms: number) => void } = {},
): void {
  const transient = new Set(['EPERM', 'EBUSY', 'EACCES']);
  for (let attempt = 0; ; attempt++) {
    try {
      io.rename(temp, output);
      return;
    } catch (error) {
      const code = typeof error === 'object' && error !== null ? Reflect.get(error, 'code') : undefined;
      if (platform !== 'win32' || attempt >= 5 || typeof code !== 'string' || !transient.has(code)) throw error;
      wait(100);
    }
  }
}

function sleepSync(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

/** Durability of the rename itself; Windows cannot open a directory fd. */
function syncDirectory(dir: string): void {
  if (process.platform === 'win32') return;
  const dirFd = fs.openSync(dir, fs.constants.O_RDONLY);
  try {
    fs.fsyncSync(dirFd);
  } finally {
    fs.closeSync(dirFd);
  }
}

function removeQuietly(file: string): void {
  try {
    fs.unlinkSync(file);
  } catch {
    // already gone
  }
}

export async function runBackup(args: BackupArgs, io: BackupIO = defaultBackupIO()): Promise<BackupResult> {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(args.date)) throw new BackupError('date must be YYYY-MM-DD');
  let db: ParsedDatabaseUrl;
  try {
    db = parseDatabaseUrl(args.dbUrl);
  } catch (error) {
    throw new BackupError(error instanceof DatabaseSetupError ? error.causeText : 'MAI_DB_URL is not a valid URL');
  }
  const secrets = [args.dbUrl, db.password];
  const backupDir = containedBackupDir(args.checkoutRoot);
  const plan = planDump(io, db);

  if (plan.probe !== null) {
    const probe = io.runCommand(plan.probe.command, plan.probe.args, plan.env);
    if (probe.status !== 0) return { status: 'unreachable', dumpMode: plan.mode };
  }

  const output = path.join(backupDir, `${args.date}.sql`);
  const temp = path.join(backupDir, `.${args.date}.sql.${randomUUID()}`);
  const fd = fs.openSync(temp, fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_WRONLY, 0o600);
  let dumped: BackupCommandResult;
  try {
    dumped = io.dumpToFd(plan.dump.command, plan.dump.args, plan.env, fd);
    if (dumped.status === 0) fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
  if (dumped.status !== 0) {
    removeQuietly(temp);
    const detail = redact(dumped.stderr, secrets).split(/\r?\n/).find(line => line.trim().length > 0);
    throw new BackupError(`pg_dump failed (status ${dumped.status})${detail ? `: ${detail}` : ''}`);
  }

  const fresh = await digestDump(temp);
  if (fresh.bytes === 0 || fresh.knownStatements === 0) {
    removeQuietly(temp);
    throw new BackupError('dump is empty — refusing to replace a durable backup');
  }

  const latest = latestDurableDump(backupDir);
  if (latest !== null) {
    const previous = await digestDump(latest);
    if (previous.digest === fresh.digest) {
      removeQuietly(temp);
      return { status: 'unchanged', outputPath: latest, dumpMode: plan.mode };
    }
  }

  landDump(io, temp, output);
  syncDirectory(backupDir);
  return {
    status: 'written', outputPath: output, bytes: fresh.bytes,
    dataStatements: fresh.dataStatements, dumpMode: plan.mode,
  };
}

/** One redacted, timestamped line per run: outcome, dump basename, byte count. */
export function appendBackupLog(logFile: string, outcome: string, basename: string | null, bytes: number): void {
  if (!path.isAbsolute(logFile)) throw new BackupError('--log-file must be an absolute path');
  const dir = path.dirname(logFile);
  const existing = (() => { try { return fs.lstatSync(dir); } catch { return null; } })();
  if (existing !== null && (existing.isSymbolicLink() || !existing.isDirectory())) {
    throw new BackupError('log directory must be a real directory, not a symlink or reparse point');
  }
  ensurePrivateDirectory(dir);
  const fd = openPrivateAppendLog(logFile);
  try {
    fs.writeSync(fd, `${new Date().toISOString()} ${outcome} ${basename ?? '-'} ${bytes}\n`);
  } finally {
    fs.closeSync(fd);
  }
}

export interface BackupMainDeps {
  io: BackupIO;
  checkoutRoot: string;
  dbUrl: string;
  now?: Date;
}

export interface BackupMainResult { code: number; stdout: string[]; stderr: string[]; }

function localDate(now: Date): string {
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
}

/** The argv boundary: deprecated aliases warn and are dropped here; any other
 * option is fatal before a dump is attempted. */
export async function backupMain(argv: readonly string[], deps: BackupMainDeps): Promise<BackupMainResult> {
  const stdout: string[] = [];
  const stderr: string[] = [];
  let logFile: string | undefined;
  for (let index = 0; index < argv.length; index += 1) {
    const option = argv[index];
    if (option === '--commit' || option === '--push') {
      stderr.push(`[backup] WARNING: ${option} is deprecated and ignored; database backups are local-only`);
    } else if (option === '--log-file') {
      const value = argv[index + 1];
      if (value === undefined || value.startsWith('--') || !path.isAbsolute(value) || logFile !== undefined) {
        stderr.push('[backup] FATAL: --log-file needs one absolute path');
        return { code: 2, stdout, stderr };
      }
      logFile = value;
      index += 1;
    } else {
      stderr.push(`[backup] FATAL: unsupported option '${option}'; database backups are local-only`);
      return { code: 2, stdout, stderr };
    }
  }

  const date = localDate(deps.now ?? new Date());
  let outcome = 'failed';
  let basename: string | null = null;
  let bytes = 0;
  let code = 1;
  try {
    const result = await runBackup({ checkoutRoot: deps.checkoutRoot, dbUrl: deps.dbUrl, date }, deps.io);
    outcome = result.status;
    basename = result.outputPath === undefined ? null : path.basename(result.outputPath);
    bytes = result.bytes ?? 0;
    if (result.status === 'unreachable') {
      stdout.push('[backup] brain DB unreachable — skipping this round (laptop/container off)');
    } else if (result.status === 'unchanged') {
      stdout.push(`[backup] no changes since ${basename} — skipping this round`);
    } else {
      stdout.push(`[backup] wrote ${basename} (${bytes} bytes, ${result.dataStatements ?? 0} data statements, ${result.dumpMode} pg_dump)`);
    }
    code = 0;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    stderr.push(`[backup] FATAL: ${redact(message, [deps.dbUrl])}`);
    code = 1;
  }
  if (logFile !== undefined) {
    try {
      appendBackupLog(logFile, outcome, basename, bytes);
    } catch (error) {
      stderr.push(`[backup] FATAL: ${redact(error instanceof Error ? error.message : String(error), [deps.dbUrl])}`);
      code = 1;
    }
  }
  return { code, stdout, stderr };
}
