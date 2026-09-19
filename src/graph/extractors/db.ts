// mai-graph schema-introspection extractor (spec §3.5 + plan 34) — dialect-routed
// over a caller-supplied dev-DB URL. The URL is NEVER stored in the brain
// (locked decision 2026-06-11): it arrives per invocation (--db-url / --postgres)
// or via MAI_GRAPH_DB_URL. Read-only against the target DB; its own pool per
// invocation, closed on exit.
//
// Two dialects, one output shape. Both alias their information_schema columns to
// the shared row interfaces below and feed one emitter, so table/column/defines/
// fk_to cannot drift between dialects. PostgreSQL additionally emits RLS policy
// nodes; MySQL has no RLS, so the MySQL path emits none — a dialect property,
// asserted (not assumed) by the acceptance gate.
//
// PG FK introspection reads pg_catalog (pg_constraint), NOT information_schema's
// constraint_column_usage: that view only returns constraints on tables the
// connecting role OWNS, so a dedicated read-only role (the recommended setup)
// sees zero FKs through it. pg_catalog is world-readable, so FKs resolve for
// any role. (a consumer project's dev DB, 2026-06-16: 226 real FKs, 0 seen via constraint_column_usage.)
// MySQL has no such ownership gotcha: KEY_COLUMN_USAGE shows referenced columns
// to any role with SELECT on the table, so plain information_schema suffices.
import { Pool } from 'pg';
import mysql from 'mysql2/promise';
import type { RowDataPacket } from 'mysql2/promise';
import { poolConfig } from '../../db.js';
import type { ExtractedEdge, ExtractedNode, ExtractorOutput, GraphExtractor } from '../types.js';

interface TableRow {
  table_schema: string;
  table_name: string;
}
interface ColumnRow {
  table_schema: string;
  table_name: string;
  column_name: string;
  data_type: string;
  is_nullable: string;
}
interface FkRow {
  table_schema: string;
  table_name: string;
  column_name: string;
  foreign_table_schema: string;
  foreign_table_name: string;
  foreign_column_name: string;
}
interface PolicyRow {
  schemaname: string;
  tablename: string;
  policyname: string;
  permissive: string; // 'PERMISSIVE' | 'RESTRICTIVE'
  roles: string[];
  cmd: string; // 'ALL' | 'SELECT' | 'INSERT' | 'UPDATE' | 'DELETE'
  qual: string | null; // USING expression
  with_check: string | null; // WITH CHECK expression
}

export type DbDialect = 'postgres' | 'mysql';

/** Scheme → dialect. Fails CLOSED on anything unrecognized: a typo'd scheme must
 * surface as a named error, never as a silently-skipped schema layer. */
export function dialectOf(dbUrl: string): DbDialect {
  let protocol: string;
  try {
    protocol = new URL(dbUrl).protocol;
  } catch {
    throw new Error('graph dev-DB URL is not a parseable URL (a scheme like postgresql:// or mysql:// is required)');
  }
  if (protocol === 'postgresql:' || protocol === 'postgres:') return 'postgres';
  if (protocol === 'mysql:' || protocol === 'mysql2:') return 'mysql';
  throw new Error(
    `unsupported graph dev-DB scheme '${protocol}' — accepted: postgresql://, postgres://, mysql://, mysql2://`
  );
}

/** Shared emitter: tables + columns + FK edges, identical for both dialects.
 * Column rows for non-base tables (views) are skipped, as the pg path always
 * has ("views etc. — not in 4a"). */
function emitSchema(tables: TableRow[], columns: ColumnRow[], fks: FkRow[]): { nodes: ExtractedNode[]; edges: ExtractedEdge[]; baseTables: Set<string> } {
  const nodes: ExtractedNode[] = [];
  const edges: ExtractedEdge[] = [];
  const tq = (schema: string, table: string): string => `${schema}.${table}`;
  const baseTables = new Set(tables.map((t) => tq(t.table_schema, t.table_name)));

  for (const t of tables) {
    nodes.push({
      kind: 'table',
      name: t.table_name,
      qualifiedName: tq(t.table_schema, t.table_name),
      lang: 'sql',
      metadata: { schema: t.table_schema },
    });
  }
  for (const c of columns) {
    const tableQn = tq(c.table_schema, c.table_name);
    if (!baseTables.has(tableQn)) continue; // views etc. — not in 4a
    const colQn = `${tableQn}.${c.column_name}`;
    nodes.push({
      kind: 'column',
      name: c.column_name,
      qualifiedName: colQn,
      lang: 'sql',
      metadata: { data_type: c.data_type, nullable: c.is_nullable === 'YES' },
    });
    edges.push({ from: { kind: 'table', qualifiedName: tableQn }, to: { kind: 'column', qualifiedName: colQn }, relation: 'defines' });
  }
  for (const f of fks) {
    const fromTable = tq(f.table_schema, f.table_name);
    const toTable = tq(f.foreign_table_schema, f.foreign_table_name);
    edges.push({
      from: { kind: 'column', qualifiedName: `${fromTable}.${f.column_name}` },
      to: { kind: 'column', qualifiedName: `${toTable}.${f.foreign_column_name}` },
      relation: 'fk_to',
    });
    edges.push({
      from: { kind: 'table', qualifiedName: fromTable },
      to: { kind: 'table', qualifiedName: toTable },
      relation: 'fk_to',
    });
  }
  return { nodes, edges, baseTables };
}

async function introspectPostgres(dbUrl: string): Promise<ExtractorOutput> {
  // Remote consumer DB (e.g. Supabase pooler) — the most network-fragile
  // connection in the codebase, reachable from the SessionEnd hook: the
  // shared bounds apply here too.
  const pool = new Pool(poolConfig({ connectionString: dbUrl, max: 2 }));
  try {
    const tables = await pool.query<TableRow>(
      `SELECT table_schema, table_name
       FROM information_schema.tables
       WHERE table_type = 'BASE TABLE' AND table_schema NOT IN ('pg_catalog', 'information_schema')
       ORDER BY table_schema, table_name`
    );
    const columns = await pool.query<ColumnRow>(
      `SELECT table_schema, table_name, column_name, data_type, is_nullable
       FROM information_schema.columns
       WHERE table_schema NOT IN ('pg_catalog', 'information_schema')
       ORDER BY table_schema, table_name, ordinal_position`
    );
    const fks = await pool.query<FkRow>(
      `SELECT ns.nspname   AS table_schema,
              cl.relname   AS table_name,
              att.attname  AS column_name,
              fns.nspname  AS foreign_table_schema,
              fcl.relname  AS foreign_table_name,
              fatt.attname AS foreign_column_name
       FROM pg_constraint c
       JOIN pg_class cl       ON cl.oid = c.conrelid
       JOIN pg_namespace ns   ON ns.oid = cl.relnamespace
       JOIN pg_class fcl      ON fcl.oid = c.confrelid
       JOIN pg_namespace fns  ON fns.oid = fcl.relnamespace
       JOIN LATERAL unnest(c.conkey, c.confkey) WITH ORDINALITY AS k(local_attnum, foreign_attnum, ord) ON true
       JOIN pg_attribute att  ON att.attrelid = c.conrelid  AND att.attnum = k.local_attnum   AND NOT att.attisdropped
       JOIN pg_attribute fatt ON fatt.attrelid = c.confrelid AND fatt.attnum = k.foreign_attnum AND NOT fatt.attisdropped
       WHERE c.contype = 'f'
         AND ns.nspname NOT IN ('pg_catalog', 'information_schema')
       ORDER BY ns.nspname, cl.relname, k.ord`
    );
    // RLS policies: the policy SQL text (USING/WITH CHECK) is the one schema
    // fact the graph otherwise loses. pg_policies decompiles the expressions
    // via pg_get_expr and is readable by a non-owner read-only role (verified
    // on a consumer project's dev DB: 346 policies, bodies visible to the RO role — unlike the FK
    // gotcha, no pg_catalog workaround needed).
    const policies = await pool.query<PolicyRow>(
      `SELECT schemaname, tablename, policyname, permissive, roles, cmd, qual, with_check
       FROM pg_policies
       WHERE schemaname NOT IN ('pg_catalog', 'information_schema')
       ORDER BY schemaname, tablename, policyname`
    );

    const { nodes, edges, baseTables } = emitSchema(tables.rows, columns.rows, fks.rows);
    for (const p of policies.rows) {
      const tableQn = `${p.schemaname}.${p.tablename}`;
      if (!baseTables.has(tableQn)) continue; // policy on a view/excluded table
      const policyQn = `${tableQn}.${p.policyname}`;
      nodes.push({
        kind: 'policy',
        name: p.policyname,
        qualifiedName: policyQn,
        lang: 'sql',
        metadata: {
          schema: p.schemaname,
          table: p.tablename,
          cmd: p.cmd,
          permissive: p.permissive === 'PERMISSIVE',
          roles: p.roles,
          using: p.qual, // USING body (null when the policy has none)
          check: p.with_check, // WITH CHECK body (null when the policy has none)
        },
      });
      edges.push({
        from: { kind: 'table', qualifiedName: tableQn },
        to: { kind: 'policy', qualifiedName: policyQn },
        relation: 'secured_by',
      });
    }
    return { nodes, edges };
  } finally {
    await pool.end();
  }
}

async function introspectMysql(dbUrl: string): Promise<ExtractorOutput> {
  // Same fragility posture as the pg path: bounded connect, tiny pool, per-query
  // timeout matching poolConfig's query_timeout, pool closed in finally.
  const pool = mysql.createPool({ uri: dbUrl, connectionLimit: 2, connectTimeout: 5_000 });
  try {
    const [tables] = await pool.query<(TableRow & RowDataPacket)[]>({
      // TABLE_SCHEMA = DATABASE() — MySQL's information_schema is SERVER-wide,
      // unlike a pg database's. Without this scope a shared local server (a
      // Local/MAMP host with many sites) floods the graph with every site's
      // tables and the prefix linker binds against the wrong install. DATABASE()
      // is the database named in the connection URL, so the URL stays the single
      // source of scope. System schemas are excluded by construction: DATABASE()
      // can never be one the URL did not name.
      sql: `SELECT TABLE_SCHEMA AS table_schema, TABLE_NAME AS table_name
            FROM information_schema.TABLES
            WHERE TABLE_TYPE = 'BASE TABLE' AND TABLE_SCHEMA = DATABASE()
            ORDER BY TABLE_NAME`,
      timeout: 300_000,
    });
    const [columns] = await pool.query<(ColumnRow & RowDataPacket)[]>({
      sql: `SELECT TABLE_SCHEMA AS table_schema, TABLE_NAME AS table_name,
                   COLUMN_NAME AS column_name, DATA_TYPE AS data_type, IS_NULLABLE AS is_nullable
            FROM information_schema.COLUMNS
            WHERE TABLE_SCHEMA = DATABASE()
            ORDER BY TABLE_NAME, ORDINAL_POSITION`,
      timeout: 300_000,
    });
    const [fks] = await pool.query<(FkRow & RowDataPacket)[]>({
      sql: `SELECT TABLE_SCHEMA AS table_schema, TABLE_NAME AS table_name,
                   COLUMN_NAME AS column_name,
                   REFERENCED_TABLE_SCHEMA AS foreign_table_schema,
                   REFERENCED_TABLE_NAME AS foreign_table_name,
                   REFERENCED_COLUMN_NAME AS foreign_column_name
            FROM information_schema.KEY_COLUMN_USAGE
            WHERE REFERENCED_TABLE_NAME IS NOT NULL
              AND TABLE_SCHEMA = DATABASE()
            ORDER BY TABLE_NAME, ORDINAL_POSITION`,
      timeout: 300_000,
    });
    const { nodes, edges } = emitSchema(tables, columns, fks);
    // No policy pass: MySQL has no row-level security. Deliberate, documented,
    // and asserted by the acceptance gate — never a silent omission.
    return { nodes, edges };
  } finally {
    await pool.end();
  }
}

export const dbExtractor: GraphExtractor = {
  name: 'db',
  vocabulary: { kinds: ['table', 'column', 'policy'], relations: ['defines', 'fk_to', 'secured_by'] },
  async extract({ dbUrl }): Promise<ExtractorOutput> {
    if (!dbUrl) return { nodes: [], edges: [] };
    return dialectOf(dbUrl) === 'mysql' ? introspectMysql(dbUrl) : introspectPostgres(dbUrl);
  },
};
