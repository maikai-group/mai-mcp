import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { findExecutable, spawnArgvSync } from '../platform/commands.js';

export interface DatabaseCommandOptions {
  cwd?: string;
  timeoutMs: number;
  env?: Record<string, string | undefined>;
  stdin?: string;
}

export interface SetupCommandResult { status: number; stdout: string; stderr: string; }

export interface DatabaseSetupIO {
  whichCommand(name: string): string | null;
  runCommand(command: string, args: readonly string[], options: DatabaseCommandOptions): SetupCommandResult;
  readFile(path: string): string | null;
  readdir(path: string): readonly string[];
}

export interface DbInitResult {
  databaseCreated: boolean;
  schemaApplied: boolean;
  migrationsApplied: number;
  mode: 'host' | 'docker';
}

export interface DatabaseSetupRequest { checkoutRoot: string; dbUrl: string; }

export interface ParsedDatabaseUrl {
  raw: string;
  host: string;
  port: string;
  user: string;
  password: string;
  database: string;
}

export class DatabaseSetupError extends Error {
  constructor(
    readonly stage: 'Preflight' | 'Schema',
    readonly causeText: string,
    readonly recovery: string,
  ) {
    super(`${causeText}. ${recovery}`);
    this.name = 'DatabaseSetupError';
  }
}

export function parseDatabaseUrl(raw: string): ParsedDatabaseUrl {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new DatabaseSetupError('Preflight', 'MAI_DB_URL is not a valid URL',
      'Fix MAI_DB_URL in the checkout .env, then rerun');
  }
  const port = url.port === '' ? '5432' : url.port;
  if (port === '54333') {
    throw new DatabaseSetupError(
      'Preflight',
      'MAI_DB_URL points at port 54333 — the predecessor memory system (iron rule 1)',
      'Use the mai-brain database on 54334 (or unset MAI_DB_URL), then rerun',
    );
  }
  const database = decodeURIComponent(url.pathname.replace(/^\//, ''));
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(database)) {
    throw new DatabaseSetupError('Preflight', 'MAI_DB_URL has no valid database identifier',
      'Fix MAI_DB_URL, then rerun');
  }
  return {
    raw, host: url.hostname, port,
    user: decodeURIComponent(url.username || 'postgres'),
    password: decodeURIComponent(url.password || ''), database,
  };
}

export function forwardMigrations(entries: readonly string[]): readonly string[] {
  const forward = entries.filter(file => file.endsWith('.sql') && !file.endsWith('.rollback.sql')).sort();
  const seen = new Set<string>();
  for (const file of forward) {
    if (seen.has(file)) {
      throw new DatabaseSetupError('Schema', `duplicate migration basename: ${file}`,
        'Remove the duplicate migration file, then rerun');
    }
    seen.add(file);
  }
  return forward;
}

export function defaultDatabaseSetupIO(): DatabaseSetupIO {
  return {
    whichCommand: name => findExecutable(name),
    runCommand: (command, args, options) => {
      const result = spawnArgvSync(command, [...args], {
        cwd: options.cwd, timeout: options.timeoutMs, maxBuffer: 16 * 1024 * 1024,
        env: options.env === undefined ? process.env : { ...options.env },
        input: options.stdin, shell: false,
      });
      return {
        status: typeof result.status === 'number' ? result.status : 1,
        stdout: result.stdout?.toString() ?? '', stderr: result.stderr?.toString() ?? '',
      };
    },
    readFile: file => {
      try { return readFileSync(file, 'utf8'); } catch { return null; }
    },
    readdir: directory => readdirSync(directory),
  };
}

const CHILD_TIMEOUT = 120_000;

interface PsqlRunner {
  mode: 'host' | 'docker';
  admin(input: { stdin: string }): SetupCommandResult;
  target(input: { stdin: string }): SetupCommandResult;
}

function buildPsqlRunner(io: DatabaseSetupIO, db: ParsedDatabaseUrl): PsqlRunner {
  const hostPsql = io.whichCommand('psql');
  if (hostPsql !== null) {
    const env: Record<string, string | undefined> = {
      PATH: process.env.PATH, PGHOST: db.host, PGPORT: db.port,
      PGUSER: db.user, PGPASSWORD: db.password,
    };
    const argv = ['--no-psqlrc', '--set', 'ON_ERROR_STOP=1'];
    return {
      mode: 'host',
      admin: ({ stdin }) => io.runCommand(hostPsql, [...argv, '--dbname', 'postgres'],
        { timeoutMs: CHILD_TIMEOUT, env, stdin }),
      target: ({ stdin }) => io.runCommand(hostPsql, [...argv, '--dbname', db.database],
        { timeoutMs: CHILD_TIMEOUT, env, stdin }),
    };
  }
  const supported = (db.host === '127.0.0.1' || db.host === 'localhost')
    && db.port === '54334' && db.user === 'postgres' && db.database === 'mai_brain';
  if (!supported) {
    throw new DatabaseSetupError('Schema',
      `no host psql, and MAI_DB_URL (${db.host}:${db.port}/${db.database} as ${db.user}) is not the compose-managed database`,
      'Install psql or use the compose-managed MAI_DB_URL (127.0.0.1:54334/mai_brain as postgres), then rerun');
  }
  const docker = io.whichCommand('docker');
  if (docker === null) {
    throw new DatabaseSetupError('Schema', 'no host psql and Docker is unavailable',
      'Install psql or Docker Desktop, then rerun');
  }
  const base = ['exec', '-i', 'mai-brain-pg', 'psql', '--no-psqlrc', '--username', 'postgres', '--set', 'ON_ERROR_STOP=1'];
  return {
    mode: 'docker',
    admin: ({ stdin }) => io.runCommand(docker, [...base, '--dbname', 'postgres'],
      { timeoutMs: CHILD_TIMEOUT, env: { PATH: process.env.PATH }, stdin }),
    target: ({ stdin }) => io.runCommand(docker, [...base, '--dbname', 'mai_brain'],
      { timeoutMs: CHILD_TIMEOUT, env: { PATH: process.env.PATH }, stdin }),
  };
}

export function requireDatabaseFile(io: DatabaseSetupIO, file: string, missingCause: string): string {
  const text = io.readFile(file);
  if (text === null) {
    throw new DatabaseSetupError('Schema', missingCause, 'Restore the checkout, then rerun');
  }
  return text;
}

export async function ensureDatabase(
  request: DatabaseSetupRequest, io: DatabaseSetupIO,
): Promise<DbInitResult> {
  const db = parseDatabaseUrl(request.dbUrl);
  const psql = buildPsqlRunner(io, db);
  const dbExists = psql.admin({ stdin: `SELECT 1 FROM pg_database WHERE datname = '${db.database}';\n` });
  if (dbExists.status !== 0) {
    throw new DatabaseSetupError('Schema', 'cannot query postgres',
      'Check database credentials/MAI_DB_URL, then rerun');
  }
  let databaseCreated = false;
  if (!dbExists.stdout.includes('1')) {
    const created = psql.admin({ stdin: `CREATE DATABASE "${db.database}";\n` });
    if (created.status !== 0) {
      throw new DatabaseSetupError('Schema', 'CREATE DATABASE failed',
        'Fix the database error, then rerun');
    }
    databaseCreated = true;
  }
  const hasProjects = psql.target({ stdin: `SELECT 1 FROM information_schema.tables WHERE table_name = 'projects';\n` });
  if (hasProjects.status !== 0) {
    throw new DatabaseSetupError('Schema', 'cannot inspect the target database',
      'Check MAI_DB_URL, then rerun');
  }
  let schemaApplied = false;
  if (!hasProjects.stdout.includes('1')) {
    const schema = requireDatabaseFile(io, path.join(request.checkoutRoot, 'db', 'schema.sql'),
      `db/schema.sql is missing from ${request.checkoutRoot}`);
    const applied = psql.target({ stdin: schema });
    if (applied.status !== 0) {
      throw new DatabaseSetupError('Schema', 'schema apply failed',
        'Fix the schema error, then rerun');
    }
    schemaApplied = true;
  }
  const migrations = forwardMigrations(io.readdir(path.join(request.checkoutRoot, 'db', 'migrations')));
  for (const file of migrations) {
    const sql = requireDatabaseFile(io, path.join(request.checkoutRoot, 'db', 'migrations', file),
      `cannot read migration ${file}`);
    const result = psql.target({ stdin: sql });
    if (result.status !== 0) {
      throw new DatabaseSetupError('Schema', `migration ${file} failed`, `Fix ${file}, then rerun`);
    }
  }
  return { databaseCreated, schemaApplied, migrationsApplied: migrations.length, mode: psql.mode };
}
