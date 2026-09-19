import { Pool, type PoolConfig } from 'pg';
import path from 'node:path';
import { AsyncLocalStorage } from 'node:async_hooks';
import { DB_URL, PROJECT_SLUG } from './env.js';
import {
  canonicalPhysicalPath, canonicalRegisteredRoots, physicalPathAliases,
  type PhysicalPathAliases,
} from './graph/roots.js';

/**
 * Every wait is bounded (2026-07-14 mai_prime freeze fix — a wedged Docker
 * port-forward or a foreign lock must fail fast, never hang an agent for
 * minutes). statement_timeout is the server-side working bound; query_timeout
 * is the CLIENT-side backstop for the dead-connection case where the server
 * never gets to enforce anything — it must outlast statement_timeout. Bulk
 * paths (graph splice/update) relax the server bounds per-transaction via
 * beginBulkTransaction; the client backstop still applies per statement.
 */
export function poolConfig(overrides: Partial<PoolConfig> = {}): PoolConfig {
  return {
    connectionString: DB_URL,
    connectionTimeoutMillis: 5_000,
    keepAlive: true,
    statement_timeout: 60_000,
    query_timeout: 300_000,
    idle_in_transaction_session_timeout: 120_000,
    ...overrides,
  };
}

const scopedPool = new AsyncLocalStorage<Pool>();

/** Bind existing DB callers to an owned pool for this async operation only. */
export function withDatabasePool<T>(pool: Pool, work: () => Promise<T>): Promise<T> {
  return scopedPool.run(pool, work);
}

let _pool: Pool | null = null;

/** Operation-scoped pool when present; otherwise the lazy shared singleton. */
export function getPool(): Pool {
  const scoped = scopedPool.getStore();
  if (scoped) return scoped;
  if (_pool) return _pool;
  _pool = new Pool(poolConfig());
  _pool.on('error', (err) => {
    console.error('[mai-db] idle client error:', err.message);
  });
  return _pool;
}

/**
 * Close the shared pool if one was opened. Null the singleton FIRST so a
 * concurrent getPool() mints a fresh pool rather than receiving one that is
 * mid-shutdown. Idempotent: safe to call when no pool was ever created.
 * Errors are swallowed — teardown must never turn a successful command into
 * a failure.
 */
export async function closePool(): Promise<void> {
  const p = _pool;
  if (!p) return;
  _pool = null;
  await p.end().catch(() => {});
}

/** Narrow structural slice of pg's PoolClient — lets tests verify the exact
 * statement sequence without a live database. */
export interface QueryRunner {
  query(text: string): Promise<unknown>;
}

/**
 * BEGIN + relax the server-side timeouts for THIS transaction only. For bulk
 * work (graph build/update) whose transactions legitimately outlive the pool's
 * 60s statement bound. SET LOCAL dies with the transaction, so the client
 * returns to the pool with the bounded defaults intact.
 */
export async function beginBulkTransaction(client: QueryRunner): Promise<void> {
  await client.query('BEGIN');
  await client.query('SET LOCAL statement_timeout = 0');
  await client.query('SET LOCAL idle_in_transaction_session_timeout = 0');
}

const DB_STALL_PATTERN =
  /timeout exceeded when trying to connect|Connection terminated|ECONNREFUSED|ETIMEDOUT|Query read timeout|statement timeout/i;

/**
 * Actionable hint for DB-unreachable/stalled errors, null for everything else.
 * Surfaced by the tool-call handler so an agent gets "check the container" in
 * seconds instead of a silent multi-minute freeze.
 */
export function dbErrorHint(err: unknown): string | null {
  const msg = err instanceof Error ? err.message : String(err);
  if (!DB_STALL_PATTERN.test(msg)) return null;
  return (
    'brain DB (mai_brain @ 127.0.0.1:54334) unreachable or stalled — ' +
    'check the mai-brain-pg Docker container, then retry.'
  );
}

let _projectId: string | null = null;

/**
 * The pinned project's id. Memoized for the server lifetime. The MCP tool layer
 * takes no slug parameter — the pin is the whole point. (Surfaces — CLI/web — may
 * select another project explicitly via resolveProjectId below; that path is never
 * reachable from tool input.)
 * Does NOT auto-create: unknown slug is a hard error pointing at create-project.
 */
export async function getProjectId(): Promise<string> {
  if (_projectId) return _projectId;
  const result = await getPool().query<{ id: string }>(
    'SELECT id FROM projects WHERE slug = $1',
    [PROJECT_SLUG]
  );
  if (result.rows.length === 0) {
    throw new Error(
      `Project not found for pinned slug '${PROJECT_SLUG}'. ` +
        `Seed it first: npm run create-project -- ${PROJECT_SLUG} "<name>" <repo-path>`
    );
  }
  _projectId = result.rows[0].id;
  return _projectId;
}

/** Test-only: reset memoization between vitest cases. */
export function __resetProjectIdCacheForTests(): void {
  _projectId = null;
}

const _slugCache = new Map<string, string>();

/**
 * Resolve ANY project slug to its id — surfaces-only (CLI/web), where the
 * operator selects the project. The MCP tool layer never calls this with user input:
 * tools have no slug parameter (the pinning guarantee lives there).
 */
export async function resolveProjectId(slug: string): Promise<string> {
  const cached = _slugCache.get(slug);
  if (cached) return cached;
  const result = await getPool().query<{ id: string }>(
    'SELECT id FROM projects WHERE slug = $1',
    [slug]
  );
  if (result.rows.length === 0) throw new Error(`Project not found: ${slug}`);
  _slugCache.set(slug, result.rows[0].id);
  return result.rows[0].id;
}

const _idToSlugCache = new Map<string, string>();

/**
 * Reverse of resolveProjectId — the display slug for a project id. Used by
 * surfaces so report/review/timeline headers name the project they're actually
 * showing (not the env-pinned slug, which may differ or be empty under --project).
 */
export async function projectSlugById(id: string): Promise<string> {
  const cached = _idToSlugCache.get(id);
  if (cached) return cached;
  const r = await getPool().query<{ slug: string }>('SELECT slug FROM projects WHERE id = $1', [id]);
  const slug = r.rows[0]?.slug ?? id.slice(0, 8);
  _idToSlugCache.set(id, slug);
  return slug;
}

export interface ProjectRow {
  id: string;
  slug: string;
  name: string | null;
  last_active_at: Date;
}

/** All projects, most recently active first (surfaces: selector + `mai projects`). */
export async function listProjects(): Promise<ProjectRow[]> {
  const result = await getPool().query<ProjectRow>(
    `SELECT id, slug, name, last_active_at FROM projects ORDER BY last_active_at DESC`
  );
  return result.rows;
}

export interface ProjectGraphRoots {
  productRoot: string;
  repos: string[];
  excludes: string[];
  aliases: PhysicalPathAliases;
}

interface ProjectGraphRootRow {
  slug: string;
  path: string | null;
  metadata: Record<string, unknown> | null;
}

function stringArrayField(metadata: Record<string, unknown>, key: string): string[] {
  const value = metadata[key];
  if (value === undefined) return [];
  if (!Array.isArray(value) || !value.every((entry) => typeof entry === 'string')) {
    throw new Error(`Project metadata.${key} must be a string array`);
  }
  return value;
}

function rootRepairError(slug: string, productRoot: string, offending: string, detail: string): Error {
  const root = path.isAbsolute(productRoot) ? productRoot : '<absolute-product-root>';
  return new Error([
    `Invalid registered graph path '${offending}': ${detail}.`,
    `Repair with: mai init ${slug} --root ${root} --replace-repos --repo <absolute-repo> --repo-map '${offending}' <absolute-root>`,
  ].join(' '));
}

function canonicalStoredDirectory(slug: string, productRoot: string, raw: string): string {
  if (!path.isAbsolute(raw)) throw rootRepairError(slug, productRoot, raw, 'stored path is relative');
  try {
    return canonicalRegisteredRoots([raw], { baseDir: productRoot, rejectRelative: true })[0];
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw rootRepairError(slug, productRoot, raw, detail);
  }
}

/** One physical path domain shared by every graph and Git reader/writer. */
export async function loadProjectGraphRoots(projectId: string, executor: Pick<Pool, 'query'> = getPool()): Promise<ProjectGraphRoots> {
  const rowResult = await executor.query<ProjectGraphRootRow>(
    `SELECT slug, path, metadata FROM projects WHERE id = $1`,
    [projectId],
  );
  const row = rowResult.rows[0];
  if (!row) throw new Error(`Project not found: ${projectId}`);
  if (row.path === null) throw rootRepairError(row.slug, '<absolute-product-root>', '(null)', 'product root is missing');
  const productRoot = canonicalStoredDirectory(row.slug, row.path, row.path);
  const metadata = row.metadata ?? {};
  const rawRepos = stringArrayField(metadata, 'repos');
  const repos = [...new Set((rawRepos.length > 0 ? rawRepos : [row.path])
    .map((raw) => canonicalStoredDirectory(row.slug, productRoot, raw)))].sort();
  const rawExcludes = stringArrayField(metadata, 'graph_excludes');
  const excludes = [...new Set(rawExcludes.map((raw) => {
    if (!path.isAbsolute(raw)) throw rootRepairError(row.slug, productRoot, raw, 'stored exclude is relative');
    return canonicalPhysicalPath(raw, productRoot);
  }))].sort();
  const evidence = await executor.query<{ repo_path: string }>(
    `SELECT DISTINCT repo_path FROM code_commits WHERE project_id = $1 AND repo_path IS NOT NULL`,
    [projectId],
  );
  const rawAliases = [...new Set([row.path, ...rawRepos, ...evidence.rows.map((entry) => entry.repo_path)])];
  for (const raw of rawAliases) canonicalStoredDirectory(row.slug, productRoot, raw);
  const aliases = physicalPathAliases(rawAliases, { baseDir: productRoot, rejectRelative: true });
  return { productRoot, repos, excludes, aliases };
}

/** Compatibility view: existing capture/Git callers inherit the physical repo union. */
export async function getProjectRepos(projectId: string): Promise<string[]> {
  return (await loadProjectGraphRoots(projectId)).repos;
}
