// Optional finite automation commands. Human onboarding remains in cli.ts.
import { readFile, readdir, realpath, stat } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { format } from 'node:util';
import { Pool } from 'pg';
import { parseAutomationCommand, type AutomationCommand } from './automation-command.js';
import { finishAndExit } from './exit.js';
import { readBuildInfo, type BuildInfo } from './build-info.js';
import { CONTRACT_VERSION } from './read-call.js';
import { forwardMigrations } from './scripts/database-setup.js';
import { withDatabasePool } from './db.js';
import { CodexAdapter, readRolloutMeta } from './capture/codex.js';
import { ingestTranscriptSegmented } from './capture/segment-ingest.js';
import { SessionProjectMismatchError } from './ingest.js';

export const AUTOMATION_CONTRACT = 'mai-automation-contract/1';
export const MAX_AUTOMATION_OUTPUT = 16 * 1024;
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const CONTROL = /[\u0000-\u001f\u007f]/;
export class AutomationError extends Error {
  constructor(readonly exitCode: 2 | 3 | 4 | 5, message: string) { super(message); }
}
export interface DatabaseEnsureResult {
  ok: true; contract: typeof AUTOMATION_CONTRACT; changed: boolean; schemaVersion: string;
}
export interface ProjectEnsureResult {
  ok: true; projectId: string; slug: string; root: string; changed: boolean; graph: 'deferred';
}
export interface TargetedIngestResult {
  ok: true; status: 'ingested' | 'unchanged'; transcriptId: string;
  segmentsPersisted: number; fullReingest: boolean;
}
export interface AutomationCapabilities {
  ok: true; contract: typeof AUTOMATION_CONTRACT; readContract: typeof CONTRACT_VERSION;
  build: BuildInfo;
  operations: readonly ['database_ensure', 'project_ensure', 'targeted_ingest'];
}
export type AutomationResult = AutomationCapabilities | DatabaseEnsureResult | ProjectEnsureResult | TargetedIngestResult;
export interface AutomationRuntime {
  execute(command: AutomationCommand): Promise<AutomationResult>;
  close(): Promise<void>;
  timeoutMs: number;
}
export interface SchemaSource { name: string; sql: string }
export function transactionalSql(sql: string): string {
  const trimmed = sql.trim();
  const body = trimmed.startsWith('BEGIN;') && trimmed.endsWith('COMMIT;')
    ? trimmed.slice(6, -7) : trimmed;
  if (/^\s*(?:BEGIN|COMMIT|ROLLBACK|START\s+TRANSACTION)\s*;/im.test(body)) {
    throw new AutomationError(5, 'Unsupported migration transaction boundary');
  }
  return body;
}
export function schemaIdentity(sources: readonly SchemaSource[]): string {
  return 'sha256:' + createHash('sha256').update('mai-schema-source/1\n')
    .update(JSON.stringify(sources.map(source => [source.name, source.sql]))).digest('hex');
}
async function loadSchemaSources(): Promise<SchemaSource[]> {
  const migrations = forwardMigrations(await readdir(path.join(ROOT, 'db', 'migrations')));
  if (migrations.length > 512) throw new AutomationError(5, 'Schema source limit exceeded');
  const names = ['db/schema.sql', ...migrations.map(name => `db/migrations/${name}`)];
  const sources: SchemaSource[] = [];
  for (const name of names) {
    const file = path.join(ROOT, name);
    if ((await stat(file)).size > 4 * 1024 * 1024) throw new AutomationError(5, 'Schema source limit exceeded');
    const sql = await readFile(file, 'utf8');
    transactionalSql(sql);
    sources.push({ name, sql });
  }
  return sources;
}
function requireDatabaseUrl(): string {
  const raw = process.env.MAI_DB_URL;
  if (!raw || Buffer.byteLength(raw) > 4096 || CONTROL.test(raw)) {
    throw new AutomationError(2, 'Explicit MAI_DB_URL is required');
  }
  try {
    const parsed = new URL(raw);
    if (!['postgres:', 'postgresql:'].includes(parsed.protocol) || !parsed.hostname
      || parsed.pathname.length <= 1 || !decodeURIComponent(parsed.pathname.slice(1)).trim()) throw new Error();
  } catch { throw new AutomationError(2, 'Invalid MAI_DB_URL'); }
  return raw;
}
function ownedPool(): Pool {
  const pool = new Pool({ connectionString: requireDatabaseUrl(), max: 2,
    connectionTimeoutMillis: 5000, statement_timeout: 60000, query_timeout: 65000,
    idle_in_transaction_session_timeout: 60000 });
  pool.on('error', () => console.error('Automation database connection failed'));
  return pool;
}

/** The same producer SQL, one transaction and one applied-source identity. */
export async function applySchema(pool: Pool, sources: readonly SchemaSource[]): Promise<DatabaseEnsureResult> {
  if (sources.length === 0 || sources[0].name !== 'db/schema.sql') {
    throw new AutomationError(5, 'Missing schema source');
  }
  const statements = sources.map(source => transactionalSql(source.sql));
  const schemaVersion = schemaIdentity(sources);
  const client = await pool.connect();
  let failed = false;
  try {
    await client.query('BEGIN');
    await client.query("SET LOCAL lock_timeout = '5s'");
    await client.query('SET LOCAL search_path = public');
    await client.query('SELECT pg_advisory_xact_lock(31032, 1)');
    await client.query(`CREATE TABLE IF NOT EXISTS public.mai_automation_schema (
      singleton boolean PRIMARY KEY CHECK (singleton), version text NOT NULL)`);
    const current = await client.query<{ version: string }>('SELECT version FROM public.mai_automation_schema WHERE singleton');
    const existing = await client.query<{ present: boolean }>("SELECT to_regclass('public.projects') IS NOT NULL AS present");
    const fresh = !existing.rows[0].present;
    const changed = fresh || current.rows[0]?.version !== schemaVersion;
    if (changed) {
      for (let i = fresh ? 0 : 1; i < statements.length; i++) await client.query(statements[i]);
      await client.query(`INSERT INTO public.mai_automation_schema (singleton, version) VALUES (true, $1)
        ON CONFLICT (singleton) DO UPDATE SET version = EXCLUDED.version`, [schemaVersion]);
    }
    await client.query('COMMIT');
    return { ok: true, contract: AUTOMATION_CONTRACT, changed, schemaVersion };
  } catch (error) {
    failed = true;
    await client.query('ROLLBACK').catch(() => undefined);
    throw error;
  } finally { client.release(failed); }
}
async function databaseEnsure(pool: Pool): Promise<DatabaseEnsureResult> {
  return applySchema(pool, await loadSchemaSources());
}
function requireSlug(slug: string | undefined): string {
  if (!slug || slug.length > 255 || !/^[a-z0-9][a-z0-9-]*$/.test(slug)) {
    throw new AutomationError(2, 'Valid project slug is required');
  }
  return slug;
}
function requirePath(value: string): void {
  if (!value || Buffer.byteLength(value) > 4096 || CONTROL.test(value) || !path.isAbsolute(value)) {
    throw new AutomationError(2, 'An absolute bounded path is required');
  }
}
async function canonicalDirectory(value: string): Promise<string> {
  requirePath(value);
  const physical = await realpath(value);
  if (!(await stat(physical)).isDirectory()) throw new AutomationError(2, 'Project root must be a directory');
  return physical;
}
function registeredRepos(metadata: Record<string, unknown> | null): string[] {
  const repos = metadata?.repos;
  if (repos === undefined) return [];
  if (!Array.isArray(repos) || !repos.every((root): root is string => typeof root === 'string')) {
    throw new AutomationError(2, 'Invalid registered project roots');
  }
  return repos;
}
interface ProjectRow { id: string; path: string | null; metadata: Record<string, unknown> | null }
async function projectEnsure(pool: Pool, slug: string, root: string): Promise<ProjectEnsureResult> {
  requireSlug(slug);
  if (await canonicalDirectory(root) !== root) throw new AutomationError(2, 'Project root must be canonical');
  const client = await pool.connect();
  let failed = false;
  try {
    await client.query('BEGIN');
    await client.query("SET LOCAL lock_timeout = '5s'");
    await client.query('SELECT pg_advisory_xact_lock(31031, hashtext($1))', [slug]);
    const current = await client.query<ProjectRow>('SELECT id, path, metadata FROM public.projects WHERE slug = $1 FOR UPDATE', [slug]);
    const row = current.rows[0];
    let projectId: string;
    let changed = false;
    if (!row) {
      const inserted = await client.query<{ id: string }>(`INSERT INTO public.projects (slug, name, path, metadata)
        VALUES ($1, $1, $2, $3::jsonb) RETURNING id`, [slug, root, JSON.stringify({ repos: [root] })]);
      projectId = inserted.rows[0].id;
      changed = true;
    } else {
      projectId = row.id;
      if (row.path !== null && row.path !== root) throw new AutomationError(4, 'Project is registered at another root');
      const repos = registeredRepos(row.metadata);
      changed = row.path === null || repos.length === 0;
      if (changed) {
        const metadata = repos.length === 0 ? { ...row.metadata, repos: [root] } : row.metadata;
        await client.query('UPDATE public.projects SET path = $2, metadata = $3::jsonb WHERE id = $1',
          [projectId, root, JSON.stringify(metadata)]);
      }
    }
    await client.query('COMMIT');
    return { ok: true, projectId, slug, root, changed, graph: 'deferred' };
  } catch (error) {
    failed = true;
    await client.query('ROLLBACK').catch(() => undefined);
    throw error;
  } finally { client.release(failed); }
}
async function targetedIngest(pool: Pool, transcript: string): Promise<TargetedIngestResult> {
  const slug = requireSlug(process.env.MAI_PROJECT_SLUG);
  requirePath(transcript);
  const physical = await realpath(transcript);
  if (!(await stat(physical)).isFile()) throw new AutomationError(2, 'Transcript must be a regular file');
  const meta = await readRolloutMeta(physical);
  if (!meta || meta.sessionId.length > 200 || CONTROL.test(meta.sessionId) || !path.isAbsolute(meta.cwd)) {
    throw new AutomationError(2, 'Valid Codex session metadata is required');
  }
  const project = (await pool.query<ProjectRow>('SELECT id, path, metadata FROM public.projects WHERE slug = $1', [slug])).rows[0];
  if (!project) throw new AutomationError(3, 'Project not found');
  if (!project.path) throw new AutomationError(2, 'Project has no registered root');
  let cwd: string;
  const roots: string[] = [];
  try {
    cwd = await canonicalDirectory(meta.cwd);
    for (const root of [project.path, ...registeredRepos(project.metadata)]) roots.push(await canonicalDirectory(root));
  } catch { throw new AutomationError(2, 'Invalid registered project roots or transcript directory'); }
  if (!roots.some(root => {
    const relative = path.relative(root, cwd);
    return relative === '' || (!path.isAbsolute(relative) && relative !== '..' && !relative.startsWith(`..${path.sep}`));
  })) throw new AutomationError(4, 'Transcript belongs to another project root');
  const report = await withDatabasePool(pool, () => ingestTranscriptSegmented(new CodexAdapter(), {
    path: physical, transcriptId: meta.sessionId, harness: 'codex', cwd: meta.cwd,
  }));
  return { ok: true, status: report.status === 'ingested' ? 'ingested' : 'unchanged',
    transcriptId: meta.sessionId, segmentsPersisted: report.segmentsPersisted, fullReingest: report.fullReingest };
}
function productionRuntime(): AutomationRuntime {
  let pool: Pool | undefined;
  return {
    timeoutMs: 900000,
    close: async () => { if (pool) await pool.end(); },
    execute: async command => {
      if (command.operation === 'capabilities') {
        const build = await readBuildInfo();
        if (!build) throw new AutomationError(5, 'Build identity unavailable');
        return { ok: true, contract: AUTOMATION_CONTRACT, readContract: CONTRACT_VERSION, build,
          operations: ['database_ensure', 'project_ensure', 'targeted_ingest'] };
      }
      pool = ownedPool();
      switch (command.operation) {
        case 'database_ensure': return databaseEnsure(pool);
        case 'project_ensure': return projectEnsure(pool, command.slug, command.root);
        case 'targeted_ingest': return targetedIngest(pool, command.transcript);
      }
    },
  };
}
function normalizedError(error: unknown): AutomationError {
  if (error instanceof AutomationError) return error;
  if (error instanceof SessionProjectMismatchError) return new AutomationError(4, 'Session belongs to another project');
  if (error instanceof Error && 'code' in error) {
    if (error.code === 'ENOENT') return new AutomationError(3, 'Requested file or directory not found');
    if (['EACCES', 'EPERM', 'ENOTDIR', 'EISDIR', 'EINVAL', 'ELOOP'].includes(String(error.code))) {
      return new AutomationError(2, 'Invalid or inaccessible path');
    }
  }
  return new AutomationError(5, 'Automation infrastructure failure');
}
export async function automationMain(argv: readonly string[], runtime: AutomationRuntime): Promise<number> {
  let timer: NodeJS.Timeout | undefined;
  try {
    let command: AutomationCommand;
    try { command = parseAutomationCommand(argv); }
    catch { throw new AutomationError(2, 'Invalid automation arguments'); }
    const result = await Promise.race([
      runtime.execute(command),
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new AutomationError(5, 'Automation deadline exceeded')), runtime.timeoutMs);
      }),
    ]);
    const json = JSON.stringify(result) + '\n';
    if (Buffer.byteLength(json) > MAX_AUTOMATION_OUTPUT) throw new AutomationError(5, 'Automation result exceeds output limit');
    process.stdout.write(json);
    return 0;
  } catch (error) {
    const failure = normalizedError(error);
    const labels = { 2: 'validation', 3: 'not_found', 4: 'project_mismatch', 5: 'infrastructure' };
    process.stdout.write(JSON.stringify({ ok: false, contract: AUTOMATION_CONTRACT,
      error: labels[failure.exitCode], message: failure.message }) + '\n');
    return failure.exitCode;
  } finally { if (timer) clearTimeout(timer); }
}
export async function runAutomation(argv: readonly string[], runtime: AutomationRuntime = productionRuntime()): Promise<void> {
  const previous = console.error;
  let remaining = MAX_AUTOMATION_OUTPUT;
  console.error = (...args: unknown[]) => {
    const bytes = Buffer.from(format(...args) + '\n');
    if (remaining > 0) process.stderr.write(bytes.subarray(0, remaining));
    remaining = Math.max(0, remaining - bytes.length);
  };
  try {
    const code = await automationMain(argv, runtime);
    await finishAndExit(code, runtime.close);
  } finally { console.error = previous; }
}
