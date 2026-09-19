/** JSON API layer (plan 10 Task 1): graphNeighborsRows, graphOverview,
 * reviewQueueRows, activityRows — the row-returning functions the dashboard
 * consumes. Seeded mini-graph + decisions; timestamps are RELATIVE to now
 * (lesson d892295c — hardcoded dates age out of recency windows). */
import { beforeAll, afterAll, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Pool } from 'pg';
import { requireDisposableTestDbUrl } from './test-db-url.js';

process.env.MAI_PROJECT_SLUG = 'webjson-test';
const testDbUrl = requireDisposableTestDbUrl();
process.env.MAI_TEST_DB_URL = testDbUrl;
process.env.MAI_DB_URL = testDbUrl;

const admin = new Pool({ connectionString: process.env.MAI_DB_URL });

// Real repo roots — loadProjectGraphRoots (0d4ea74 hardening) canonicalizes and
// stats every registered root, so the fixture dirs must exist on disk.
// realpathSync keeps the stored strings physical, so moduleLabel's string math
// (startsWith / path.relative / path.basename) still matches seeded file_paths.
const PRODUCT_ROOT = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'webjson-')));
const REPO_A = path.join(PRODUCT_ROOT, 'webjson-repoA');
const REPO_B = path.join(PRODUCT_ROOT, 'webjson-repoB');
fs.mkdirSync(REPO_A);
fs.mkdirSync(REPO_B);

const FACT_MARKER = 'webjson-test-fixture';

let projectId = '';
const nodeIds: Record<string, string> = {};

async function seedNode(kind: string, name: string, qname: string, filePath: string | null, line: number | null): Promise<string> {
  const r = await admin.query<{ id: string }>(
    `INSERT INTO graph_nodes (project_id, kind, name, qualified_name, file_path, line, extracted_by)
     VALUES ($1, $2, $3, $4, $5, $6, 'seed') RETURNING id`,
    [projectId, kind, name, qname, filePath, line]
  );
  nodeIds[qname] = r.rows[0].id;
  return r.rows[0].id;
}

async function seedEdge(fromQ: string, toQ: string, relation: string): Promise<void> {
  await admin.query(
    `INSERT INTO graph_edges (project_id, from_node, to_node, relation)
     VALUES ($1, $2, $3, $4)`,
    [projectId, nodeIds[fromQ], nodeIds[toQ], relation]
  );
}

beforeAll(async () => {
  await admin.query(`DELETE FROM projects WHERE slug = 'webjson-test'`);
  const p = await admin.query<{ id: string }>(
    `INSERT INTO projects (slug, name, path, metadata)
     VALUES ('webjson-test', 'WebJSON', $3, jsonb_build_object('repos', jsonb_build_array($1::text, $2::text)))
     RETURNING id`,
    [REPO_A, REPO_B, PRODUCT_ROOT]
  );
  projectId = p.rows[0].id;

  // Module repoA/src — 9 function nodes (exceeds the per-module top-N cap of 8).
  for (let i = 0; i < 9; i++) {
    await seedNode('function', `fnA${i}`, `repoA/src/mod.ts#fnA${i}`, `${REPO_A}/src/mod.ts`, 10 + i);
  }
  // Module repoB/lib — one node.
  await seedNode('function', 'fnB', 'repoB/lib/util.ts#fnB', `${REPO_B}/lib/util.ts`, 3);
  // db schema — one table with NULL file_path (groups under 'db schema').
  await seedNode('table', 'workouts', 'public.workouts', null, null);

  // Edges: fnA0 anchors both cross-module links; fnA1→fnB gives that link weight 2.
  await seedEdge('repoA/src/mod.ts#fnA0', 'repoA/src/mod.ts#fnA1', 'calls'); // intra-module: no link
  await seedEdge('repoA/src/mod.ts#fnA0', 'repoB/lib/util.ts#fnB', 'calls'); // repoA/src ↔ repoB/lib
  await seedEdge('repoA/src/mod.ts#fnA1', 'repoB/lib/util.ts#fnB', 'calls'); // + weight
  await seedEdge('repoA/src/mod.ts#fnA0', 'public.workouts', 'reads_table'); // repoA/src ↔ db schema

  // Review-queue + activity fixtures — timestamps relative to now.
  await admin.query(
    `INSERT INTO code_decisions (project_id, decision_type, description, reasoning, confidence, source, keywords, timestamp)
     VALUES ($1, 'arch', 'older inferred decision', 'because reasons', 0.6, 'agent-inferred', ARRAY['alpha','beta'], NOW() - INTERVAL '2 hours')`,
    [projectId]
  );
  await admin.query(
    `INSERT INTO code_decisions (project_id, decision_type, description, reasoning, confidence, source, keywords, timestamp)
     VALUES ($1, 'arch', 'newer inferred decision', NULL, 0.55, 'agent-inferred', ARRAY['gamma'], NOW() - INTERVAL '10 minutes')`,
    [projectId]
  );
  // A high-confidence user-approved decision must NOT appear in the review queue.
  await admin.query(
    `INSERT INTO code_decisions (project_id, decision_type, description, confidence, source, timestamp)
     VALUES ($1, 'arch', 'settled decision', 0.95, 'user-selected', NOW() - INTERVAL '1 hour')`,
    [projectId]
  );

  // Ideas + facts fixtures for the plan-11 JSON routes.
  await admin.query(`DELETE FROM user_facts WHERE evidence = $1`, [FACT_MARKER]);
  await admin.query(
    `INSERT INTO ideas (project_id, title, status, priority, sort_order, source)
     VALUES ($1, 'webjson parked', 'idea', 'someday', 1000, 'user'),
            ($1, 'webjson p42 someday', 'idea', 'someday', 100, 'user'),
            ($1, 'webjson p42 now', 'idea', 'now', 9000, 'user'),
            ($1, 'webjson p42 later', 'idea', 'later', 10, 'user'),
            ($1, 'webjson p42 next', 'idea', 'next', 500, 'user'),
            ($1, 'webjson shipped', 'shipped', 'now', 1000, 'user')`,
    [projectId]
  );
  await admin.query(
    `INSERT INTO user_facts (category, fact, evidence, source)
     VALUES ('tooling', 'webjson approved fact', $1, 'user-approved')`,
    [FACT_MARKER]
  );
});

afterAll(async () => {
  // user_facts is GLOBAL — remove only this suite's marker rows (ideas cascade
  // with the project).
  await admin.query(`DELETE FROM user_facts WHERE evidence = $1`, [FACT_MARKER]);
  await admin.query(`DELETE FROM projects WHERE slug = 'webjson-test'`);
  await admin.end();
  const { getPool } = await import('../db.js');
  await getPool().end();
});

describe('graphNeighborsRows', () => {
  it('returns center + nodes/edges with file_path hydrated', async () => {
    const { graphNeighborsRows } = await import('../graph/query.js');
    const out = await graphNeighborsRows({ nodeId: nodeIds['repoA/src/mod.ts#fnA0'], depth: 1, projectId });
    expect(out).not.toBeNull();
    expect(out!.center).toBe(nodeIds['repoA/src/mod.ts#fnA0']);
    const center = out!.nodes.find((n) => n.id === out!.center);
    expect(center?.file_path).toBe(`${REPO_A}/src/mod.ts`);
    expect(center?.line).toBe(10);
    // edges use source/target/relation shape
    expect(out!.edges.every((e) => e.source && e.target && e.relation)).toBe(true);
    expect(out!.nodes.some((n) => n.id === nodeIds['repoB/lib/util.ts#fnB'])).toBe(true);
  });

  it('returns null for a non-UUID node id', async () => {
    const { graphNeighborsRows } = await import('../graph/query.js');
    expect(await graphNeighborsRows({ nodeId: 'not-a-uuid', projectId })).toBeNull();
  });
});

describe('graphOverview', () => {
  it('groups nodes into modules with correct counts, caps top-N, weights links', async () => {
    const { graphOverview } = await import('../graph/overview.js');
    const o = await graphOverview(projectId);

    const byLabel = new Map(o.modules.map((m) => [m.label, m]));
    expect(byLabel.get('webjson-repoA/src')?.nodeCount).toBe(9);
    expect(byLabel.get('webjson-repoB/lib')?.nodeCount).toBe(1);
    expect(byLabel.get('db schema')?.nodeCount).toBe(1);
    expect(byLabel.get('webjson-repoA/src')?.kinds.function).toBe(9);
    expect(byLabel.get('db schema')?.kinds.table).toBe(1);

    // Per-module top-N cap = 8 (webjson-repoA/src has 9 nodes).
    const topA = o.topNodes.filter((n) => n.module === 'webjson-repoA/src');
    expect(topA).toHaveLength(8);

    // Link weights: webjson-repoA/src ↔ webjson-repoB/lib = 2; ↔ db schema = 1.
    const link = (x: string, y: string) =>
      o.links.find((l) => (l.a === x && l.b === y) || (l.a === y && l.b === x));
    expect(link('webjson-repoA/src', 'webjson-repoB/lib')?.weight).toBe(2);
    // The 'db schema' label contains a space — proves the pair is not corrupted by splitting.
    const dbLink = link('db schema', 'webjson-repoA/src');
    expect(dbLink?.weight).toBe(1);
    expect([dbLink?.a, dbLink?.b]).toContain('db schema');
  });
});

describe('reviewQueueRows', () => {
  it('exposes all ReviewRow fields; excludes settled high-confidence decisions', async () => {
    const { reviewQueueRows } = await import('../decisions.js');
    const all = await reviewQueueRows(30, projectId);
    // Facts union into the queue (plan 11) and are GLOBAL — filter to this
    // project's decision rows so a parallel suite's fact fixture can't skew the count.
    const rows = all.filter((x) => x.kind === 'decision');
    expect(rows.length).toBe(2); // two agent-inferred; the user-selected 0.95 is excluded
    const r = rows[0];
    expect(r.kind).toBe('decision');
    expect(typeof r.id).toBe('string');
    expect(r.decision_type).toBe('arch');
    expect(typeof r.description).toBe('string');
    expect(r.source).toBe('agent-inferred');
    expect(Array.isArray(r.keywords)).toBe(true);
    expect(typeof r.timestamp).toBe('string');
    expect(rows.every((x) => x.description !== 'settled decision')).toBe(true);
  });
});

describe('ideasBoard (GET /api/ideas rows)', () => {
  it('honours the selected project, the scope switch and the closed filter', async () => {
    const { ideasBoard } = await import('../ideas.js');

    const open = await ideasBoard({ scope: 'project', projectIdOverride: projectId });
    expect(open.map((r) => r.title)).toContain('webjson parked');
    expect(open.map((r) => r.title)).not.toContain('webjson shipped');
    const row = open[0];
    expect(row.project_id).toBe(projectId);
    expect(typeof row.sort_order).toBe('number');
    expect(typeof row.created_at).toBe('string');
    expect(row.status).toBe('idea');
    expect(open.map((r) => r.title).filter((title) => title.startsWith('webjson p42'))).toEqual([
      'webjson p42 now',
      'webjson p42 next',
      'webjson p42 later',
      'webjson p42 someday',
    ]);
    expect(Object.keys(row).sort()).toEqual([
      'created_at', 'detail', 'evidence', 'id', 'priority', 'project_id',
      'sort_order', 'source', 'status', 'title', 'updated_at',
    ]);

    const closed = await ideasBoard({ scope: 'project', includeClosed: true, projectIdOverride: projectId });
    expect(closed.map((r) => r.title)).toContain('webjson shipped');

    const globalOnly = await ideasBoard({ scope: 'global', projectIdOverride: projectId });
    expect(globalOnly.every((r) => r.project_id === null)).toBe(true);
  });
});

describe('factsList (GET /api/facts rows)', () => {
  it('returns global facts with the full row shape', async () => {
    const { factsList } = await import('../facts.js');
    const rows = await factsList();
    const fact = rows.find((f) => f.evidence === FACT_MARKER);
    expect(fact).toBeDefined();
    expect(fact!.category).toBe('tooling');
    expect(fact!.source).toBe('user-approved');
    expect(fact!.retracted_at).toBeNull();
    expect(typeof fact!.created_at).toBe('string');
  });
});

describe('activityRows', () => {
  it('merges + sorts newest-first, capped', async () => {
    const { activityRows } = await import('../decisions.js');
    const rows = await activityRows(7, 30, projectId);
    expect(rows.length).toBeGreaterThanOrEqual(2);
    const ts = rows.map((r) => new Date(r.ts).getTime());
    for (let i = 1; i < ts.length; i++) expect(ts[i - 1]).toBeGreaterThanOrEqual(ts[i]);
    // newest decision surfaces first among our fixtures
    const firstDecision = rows.find((r) => r.kind === 'decision');
    expect(firstDecision?.detail).toBe('newer inferred decision');
  });
});
