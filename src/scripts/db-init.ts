#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { finishAndExit } from '../exit.js';
import {
  DatabaseSetupError, defaultDatabaseSetupIO, ensureDatabase,
} from './database-setup.js';
import type { DatabaseSetupIO, DbInitResult } from './database-setup.js';

export type { DbInitResult } from './database-setup.js';
export interface DbInitArgs { root: string; dbUrl: string; }

const DB_INIT_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
export const DB_INIT_USAGE = 'usage: npm run db:init -- --help';

export async function runDbInit(args: DbInitArgs, io: DatabaseSetupIO): Promise<DbInitResult> {
  return ensureDatabase({ checkoutRoot: args.root, dbUrl: args.dbUrl }, io);
}

export async function dbInitMain(
  argv: readonly string[] = process.argv.slice(2), io?: DatabaseSetupIO,
): Promise<number> {
  if (argv.length === 1 && argv[0] === '--help') {
    console.log(DB_INIT_USAGE);
    return 0;
  }
  if (argv.length !== 0) {
    console.error(DB_INIT_USAGE);
    return 2;
  }
  const dbUrl = process.env.MAI_TEST_DB_URL
    ?? process.env.MAI_DB_URL
    ?? 'postgresql://postgres:postgres@127.0.0.1:54334/mai_brain';
  try {
    const result = await runDbInit({ root: DB_INIT_ROOT, dbUrl }, io ?? defaultDatabaseSetupIO());
    console.log(`database ${result.databaseCreated ? 'created' : 'present'}; schema ${result.schemaApplied ? 'applied' : 'present'}; ${result.migrationsApplied} migration(s) via ${result.mode}`);
    return 0;
  } catch (error) {
    if (error instanceof DatabaseSetupError) console.error(error.message);
    else console.error(error instanceof Error ? error.message : String(error));
    return 1;
  }
}

const invoked = process.argv[1];
if (invoked) {
  let direct = import.meta.url === pathToFileURL(invoked).href;
  if (!direct) {
    try { direct = import.meta.url === pathToFileURL(fs.realpathSync(invoked)).href; } catch { /* not direct */ }
  }
  if (direct) await finishAndExit(await dbInitMain());
}
