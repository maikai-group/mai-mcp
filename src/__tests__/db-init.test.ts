import { afterEach, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { DatabaseSetupError } from '../scripts/database-setup.js';
import type { DatabaseSetupIO } from '../scripts/database-setup.js';
import { dbInitMain, runDbInit } from '../scripts/db-init.js';

const ROOT = fileURLToPath(new URL('../..', import.meta.url));
const DB_URL = 'postgresql://postgres:secret@127.0.0.1:54334/mai_brain';

function successfulIO(log: string[]): DatabaseSetupIO {
  return {
    whichCommand: name => { log.push(`which:${name}`); return name === 'psql' ? '/psql' : null; },
    runCommand: (_command, _args, options) => {
      const sql = options.stdin ?? '';
      log.push(`run:${sql.split('\n')[0]}`);
      if (sql.includes('pg_database') || sql.includes('information_schema')) {
        return { status: 0, stdout: '1\n', stderr: '' };
      }
      return { status: 0, stdout: '', stderr: '' };
    },
    readFile: file => { log.push(`read:${file}`); return '-- migration'; },
    readdir: directory => { log.push(`readdir:${directory}`); return []; },
  };
}

afterEach(() => vi.restoreAllMocks());

describe('portable db:init entry', () => {
  it('prints help without constructing or mutating through IO', async () => {
    const log: string[] = [];
    const stdout = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    expect(await dbInitMain(['--help'], successfulIO(log))).toBe(0);
    expect(log).toEqual([]);
    expect(stdout).toHaveBeenCalledWith('usage: npm run db:init -- --help');
  });

  it('formats success from the supplied hermetic IO', async () => {
    const log: string[] = [];
    const stdout = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    expect(await dbInitMain([], successfulIO(log))).toBe(0);
    const selectedUrl = process.env.MAI_TEST_DB_URL ?? process.env.MAI_DB_URL
      ?? 'postgresql://postgres:postgres@127.0.0.1:54334/mai_brain';
    const selectedDatabase = decodeURIComponent(new URL(selectedUrl).pathname.slice(1));
    expect(log).toEqual([
      `which:psql`, `run:SELECT 1 FROM pg_database WHERE datname = '${selectedDatabase}';`,
      "run:SELECT 1 FROM information_schema.tables WHERE table_name = 'projects';",
      `readdir:${path.join(ROOT, 'db', 'migrations')}`,
    ]);
    expect(stdout.mock.calls.flat().join(' ')).toContain('database present; schema present; 0 migration(s) via host');
  });

  it('returns a drained-boundary failure with the redacted shared message and supplied IO', async () => {
    const log: string[] = [];
    const stderr = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const io = successfulIO(log);
    io.runCommand = () => {
      log.push('run:failure');
      throw new DatabaseSetupError('Schema', 'cannot query postgres', 'Check credentials, then rerun');
    };
    expect(await dbInitMain([], io)).toBe(1);
    expect(log).toEqual(['which:psql', 'run:failure']);
    const rendered = stderr.mock.calls.flat().join(' ');
    expect(rendered).toContain('cannot query postgres. Check credentials, then rerun');
    expect(rendered).not.toContain('secret');
    expect(rendered).not.toContain(DB_URL);
    const source = readFileSync(path.join(ROOT, 'src', 'scripts', 'db-init.ts'), 'utf8');
    expect(source).toContain('await finishAndExit(await dbInitMain())');
    expect(source).not.toMatch(/process\.exit\s*\(/u);
  });

  it('pins package db:init to the compiled Node entry with no Bash dependency', () => {
    const pkg = JSON.parse(readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
    expect(pkg.scripts['db:init']).toBe('node build/scripts/db-init.js');
    expect(pkg.scripts['db:init']).not.toMatch(/bash|\.sh/);
  });
});
