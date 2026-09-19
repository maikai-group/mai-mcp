import { describe, expect, it } from 'vitest';
import path from 'node:path';
import {
  DatabaseSetupError, ensureDatabase, forwardMigrations, parseDatabaseUrl,
} from '../scripts/database-setup.js';
import type { DatabaseSetupIO, SetupCommandResult } from '../scripts/database-setup.js';

const ROOT = '/checkout';
const URL = 'postgresql://postgres:secret@127.0.0.1:54334/mai_brain';

interface Call { command: string; args: readonly string[]; stdin?: string; }

function fake(input: {
  host?: boolean; databaseExists?: boolean; schemaExists?: boolean;
  migrations?: readonly string[]; missing?: readonly string[]; failContains?: string;
} = {}) {
  let databaseExists = input.databaseExists ?? true;
  let schemaExists = input.schemaExists ?? true;
  const calls: Call[] = [];
  const reads: string[] = [];
  const files = new Map<string, string>([
    [path.join(ROOT, 'db', 'schema.sql'), '-- schema'],
    [path.join(ROOT, 'db', 'migrations', '001.sql'), '-- 001'],
    [path.join(ROOT, 'db', 'migrations', '002.sql'), '-- 002'],
  ]);
  for (const name of input.missing ?? []) files.delete(path.join(ROOT, 'db', name));
  const io: DatabaseSetupIO = {
    whichCommand: name => name === 'psql' ? (input.host === false ? null : '/tools/psql.exe')
      : name === 'docker' ? '/tools/docker.exe' : null,
    runCommand: (command, args, options): SetupCommandResult => {
      calls.push({ command, args: [...args], stdin: options.stdin });
      const sql = options.stdin ?? '';
      if (input.failContains && sql.includes(input.failContains)) return { status: 1, stdout: '', stderr: `secret ${URL}` };
      if (sql.includes('pg_database')) return { status: 0, stdout: databaseExists ? '1\n' : '', stderr: '' };
      if (sql.includes('CREATE DATABASE')) { databaseExists = true; return { status: 0, stdout: '', stderr: '' }; }
      if (sql.includes('information_schema')) return { status: 0, stdout: schemaExists ? '1\n' : '', stderr: '' };
      if (sql === '-- schema') schemaExists = true;
      return { status: 0, stdout: '', stderr: '' };
    },
    readFile: file => { reads.push(file); return files.get(file) ?? null; },
    readdir: () => [...(input.migrations ?? ['002.sql', '001.sql', '001.rollback.sql'])],
  };
  return { io, calls, reads };
}

describe('portable database setup', () => {
  it('creates a fresh database and applies its schema', async () => {
    const state = fake({ databaseExists: false, schemaExists: false, migrations: [] });
    expect(await ensureDatabase({ checkoutRoot: ROOT, dbUrl: URL }, state.io)).toEqual({
      databaseCreated: true, schemaApplied: true, migrationsApplied: 0, mode: 'host',
    });
    expect(state.calls.some(call => call.stdin?.includes('CREATE DATABASE'))).toBe(true);
  });

  it('keeps an existing database and schema current', async () => {
    const state = fake({ migrations: [] });
    expect(await ensureDatabase({ checkoutRoot: ROOT, dbUrl: URL }, state.io)).toMatchObject({
      databaseCreated: false, schemaApplied: false,
    });
  });

  it('does not read schema bytes when the projects table is present', async () => {
    const state = fake({ migrations: [] });
    await ensureDatabase({ checkoutRoot: ROOT, dbUrl: URL }, state.io);
    expect(state.reads).not.toContain(path.join(ROOT, 'db', 'schema.sql'));
  });

  it('orders forward migrations and excludes rollback files', async () => {
    const state = fake();
    await ensureDatabase({ checkoutRoot: ROOT, dbUrl: URL }, state.io);
    expect(state.calls.map(call => call.stdin).filter(sql => sql?.startsWith('-- 0'))).toEqual(['-- 001', '-- 002']);
    expect(forwardMigrations(['b.sql', 'a.rollback.sql', 'a.sql'])).toEqual(['a.sql', 'b.sql']);
  });

  it('is safe to apply the same idempotent migration set twice', async () => {
    const state = fake();
    await ensureDatabase({ checkoutRoot: ROOT, dbUrl: URL }, state.io);
    await ensureDatabase({ checkoutRoot: ROOT, dbUrl: URL }, state.io);
    expect(state.calls.filter(call => call.stdin === '-- 001')).toHaveLength(2);
  });

  it('uses the resolved host psql executable', async () => {
    const state = fake({ migrations: [] });
    expect((await ensureDatabase({ checkoutRoot: ROOT, dbUrl: URL }, state.io)).mode).toBe('host');
    expect(state.calls.every(call => call.command === '/tools/psql.exe')).toBe(true);
  });

  it('uses Docker without forwarding host credentials', async () => {
    const state = fake({ host: false, migrations: [] });
    expect((await ensureDatabase({ checkoutRoot: ROOT, dbUrl: URL }, state.io)).mode).toBe('docker');
    expect(state.calls.every(call => call.command === '/tools/docker.exe')).toBe(true);
    expect(state.calls.map(call => call.args.join(' ')).join('\n')).not.toContain('secret');
  });

  it('redacts command failures from the shared error', async () => {
    const state = fake({ failContains: 'pg_database', migrations: [] });
    await expect(ensureDatabase({ checkoutRoot: ROOT, dbUrl: URL }, state.io)).rejects.toMatchObject({
      causeText: 'cannot query postgres', stage: 'Schema',
    });
    try { await ensureDatabase({ checkoutRoot: ROOT, dbUrl: URL }, state.io); } catch (error) {
      expect(String(error)).not.toContain('secret');
      expect(String(error)).not.toContain(URL);
    }
    expect(() => parseDatabaseUrl('not a URL')).toThrow(DatabaseSetupError);
  });

  it('refuses missing schema bytes without applying an empty substitute', async () => {
    const state = fake({ schemaExists: false, migrations: [], missing: ['schema.sql'] });
    await expect(ensureDatabase({ checkoutRoot: ROOT, dbUrl: URL }, state.io)).rejects.toMatchObject({
      stage: 'Schema',
      causeText: `db/schema.sql is missing from ${ROOT}`,
      recovery: 'Restore the checkout, then rerun',
      message: `db/schema.sql is missing from ${ROOT}. Restore the checkout, then rerun`,
    });
    expect(state.calls.some(call => call.stdin === '')).toBe(false);
  });

  it('stops at a missing migration after retaining an earlier application', async () => {
    const state = fake({ missing: [path.join('migrations', '002.sql')] });
    await expect(ensureDatabase({ checkoutRoot: ROOT, dbUrl: URL }, state.io)).rejects.toMatchObject({
      stage: 'Schema',
      causeText: 'cannot read migration 002.sql',
      recovery: 'Restore the checkout, then rerun',
      message: 'cannot read migration 002.sql. Restore the checkout, then rerun',
    });
    expect(state.calls.filter(call => call.stdin === '-- 001')).toHaveLength(1);
    expect(state.calls.some(call => call.stdin === '-- 002')).toBe(false);
  });
});
