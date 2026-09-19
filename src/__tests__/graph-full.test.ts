/**
 * Plan 47 — the capped whole-graph payload (src/graph/full.ts).
 *
 * Disposable-DB pattern per graph-freshness.test.ts: a throwaway project per
 * case, seeded rows, cleanup in afterEach. The cap cases drive graphFull's
 * injectable `limits` seam with tiny values — never 25,000 rows — and a
 * separate case pins the production defaults to the exported constants so the
 * seam cannot silently change what production uses.
 *
 * IMPORT DISCIPLINE — full.ts imports ../db.js, whose env.js reads process.env
 * at evaluation, so the producer is pulled with `await import` inside each case
 * AFTER the env assignments below (same as graph-freshness.test.ts).
 */
import { afterAll, afterEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Pool } from 'pg';
import { requireDisposableTestDbUrl } from './test-db-url.js';

const TEST_DB = requireDisposableTestDbUrl();
process.env.MAI_PROJECT_SLUG = 'graph-full-test';
process.env.MAI_DB_URL = TEST_DB;

/** readEdgeStrengths (metrics.ts:168) sets an entry for EVERY edge row, so the
 * "no entry" fallback in graphFull is unreachable through the database. The
 * reader is mocked behind a switch so exactly one case can observe it. */
const strengthMode = vi.hoisted(() => ({ empty: false }));
vi.mock('../graph/metrics.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../graph/metrics.js')>();
  return {
    ...actual,
    readEdgeStrengths: async (projectId: string): Promise<Map<string, number>> =>
      strengthMode.empty ? new Map<string, number>() : actual.readEdgeStrengths(projectId),
  };
});

const admin = new Pool({ connectionString: TEST_DB });
const cleanup: { projectIds: string[]; dirs: string[] } = { projectIds: [], dirs: [] };

afterEach(async () => {
  strengthMode.empty = false;
  for (const id of cleanup.projectIds.splice(0)) await admin.query(`DELETE FROM projects WHERE id = $1`, [id]);
  for (const dir of cleanup.dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

afterAll(async () => {
  await admin.end();
});

async function insertProject(): Promise<{ projectId: string; dir: string }> {
  const dir = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'mai-graph-full-')));
  cleanup.dirs.push(dir);
  const r = await admin.query<{ id: string }>(
    `INSERT INTO projects (slug, name, path, metadata)
     VALUES ('graph-full-' || substr(md5(random()::text), 1, 8), 'Graph Full', $1,
             jsonb_build_object('repos', jsonb_build_array($1::text)))
     RETURNING id`,
    [dir],
  );
  cleanup.projectIds.push(r.rows[0].id);
  return { projectId: r.rows[0].id, dir };
}

async function insertNode(projectId: string, dir: string, name: string): Promise<string> {
  const r = await admin.query<{ id: string }>(
    `INSERT INTO graph_nodes (project_id, kind, name, qualified_name, file_path, line, extracted_by)
     VALUES ($1, 'function', $2, 'svc/' || $2, $3, 1, 'ts') RETURNING id`,
    [projectId, name, path.join(dir, `${name}.ts`)],
  );
  return r.rows[0].id;
}

async function insertEdge(projectId: string, from: string, to: string, relation = 'calls', id?: string): Promise<string> {
  const r = await admin.query<{ id: string }>(
    `INSERT INTO graph_edges (id, project_id, from_node, to_node, relation, confidence)
     VALUES (COALESCE($5::uuid, gen_random_uuid()), $1, $2, $3, $4, 'extracted') RETURNING id`,
    [projectId, from, to, relation, id ?? null],
  );
  return r.rows[0].id;
}

/** Edge ids chosen so that INSERTION order is the reverse of id order: heap
 * order (what a query with no ORDER BY returns) then disagrees with `ORDER BY
 * id`, which is what makes the determinism pin falsifiable (finding 6918d694). */
const EDGE_IDS = [
  'ffffffff-0000-4000-8000-000000000003',
  '88888888-0000-4000-8000-000000000002',
  '11111111-0000-4000-8000-000000000001',
];

/** hub ↔ three leaves: hub degree 3, each leaf degree 1, nothing else. */
async function seedStar(): Promise<{ projectId: string; hub: string; leaves: string[]; edgeIds: string[]; edgeTargets: Map<string, string> }> {
  const { projectId, dir } = await insertProject();
  const hub = await insertNode(projectId, dir, 'hub');
  const leaves: string[] = [];
  const edgeIds: string[] = [];
  const edgeTargets = new Map<string, string>();
  for (const [i, name] of ['leafA', 'leafB', 'leafC'].entries()) {
    const leaf = await insertNode(projectId, dir, name);
    leaves.push(leaf);
    const edgeId = await insertEdge(projectId, hub, leaf, 'calls', EDGE_IDS[i]);
    edgeIds.push(edgeId);
    edgeTargets.set(edgeId, leaf);
  }
  return { projectId, hub, leaves, edgeIds, edgeTargets };
}

describe('graphFull — cap and truncation (R1)', () => {
  it('returns every node and edge of a small graph with nothing truncated', async () => {
    const { graphFull } = await import('../graph/full.js');
    const { projectId, hub, leaves } = await seedStar();
    const full = await graphFull(projectId);
    expect(full.nodes.map((n) => n.id).sort()).toEqual([hub, ...leaves].sort());
    expect(full.edges).toHaveLength(3);
    expect(full.truncated).toEqual({ nodes: false, edges: false, nodeTotal: 4, edgeTotal: 3 });
  });

  it('holds exactly the node cap, flags truncation, and reports the real pre-cap total', async () => {
    const { graphFull } = await import('../graph/full.js');
    const { projectId, dir } = await insertProject();
    for (const name of ['n1', 'n2', 'n3', 'n4', 'n5']) await insertNode(projectId, dir, name);
    const full = await graphFull(projectId, { nodes: 3, edges: 3 });
    expect(full.nodes).toHaveLength(3);
    expect(full.truncated.nodes).toBe(true);
    expect(full.truncated.nodeTotal).toBe(5);
  });

  it('production defaults are the exported constants and leave a small graph untruncated', async () => {
    const { graphFull, MAX_HERO_NODES, MAX_HERO_EDGES } = await import('../graph/full.js');
    expect(MAX_HERO_NODES).toBe(25_000);
    expect(MAX_HERO_EDGES).toBe(60_000);
    const { projectId, dir } = await insertProject();
    for (const name of ['n1', 'n2', 'n3', 'n4', 'n5']) await insertNode(projectId, dir, name);
    const full = await graphFull(projectId);
    expect(full.nodes).toHaveLength(5);
    expect(full.truncated.nodes).toBe(false);
    expect(full.truncated.edges).toBe(false);
  });

  it('orders nodes by descending degree so the cap keeps hubs', async () => {
    const { graphFull } = await import('../graph/full.js');
    const { projectId, dir } = await insertProject();
    // Insert the hub LAST so id order and degree order disagree.
    const leaves = [];
    for (const name of ['leafA', 'leafB', 'leafC']) leaves.push(await insertNode(projectId, dir, name));
    const mid = await insertNode(projectId, dir, 'mid');
    const hub = await insertNode(projectId, dir, 'hub');
    for (const leaf of leaves) await insertEdge(projectId, hub, leaf);
    await insertEdge(projectId, mid, leaves[0], 'imports');
    const full = await graphFull(projectId);
    expect(full.nodes[0].id).toBe(hub);
    expect(full.nodes[0].degree).toBe(3);
    const degrees = full.nodes.map((n) => n.degree);
    for (let i = 1; i < degrees.length; i++) expect(degrees[i]).toBeLessThanOrEqual(degrees[i - 1]);
    const capped = await graphFull(projectId, { nodes: 1, edges: 50 });
    expect(capped.nodes.map((n) => n.id)).toEqual([hub]);
  });

  it('marks exactly HERO_LANDING_COUNT top-degree nodes as landing, deterministically', async () => {
    const { graphFull, HERO_LANDING_COUNT } = await import('../graph/full.js');
    expect(HERO_LANDING_COUNT).toBe(64);
    const { projectId, dir } = await insertProject();
    const ids: string[] = [];
    for (let i = 0; i < 70; i++) ids.push(await insertNode(projectId, dir, `n${i}`));
    const full = await graphFull(projectId);
    expect(full.nodes).toHaveLength(70);
    const landing = full.nodes.filter((n) => n.isLanding === 1).map((n) => n.id);
    expect(landing).toHaveLength(HERO_LANDING_COUNT);
    // All degrees tie at 0, so the top-degree slice is decided by the
    // `ORDER BY degree DESC, n.id` tiebreak: the 64 smallest ids, in order.
    const smallest = [...ids].sort().slice(0, HERO_LANDING_COUNT);
    expect(landing).toEqual(smallest);
    expect(full.nodes.slice(0, HERO_LANDING_COUNT).every((n) => n.isLanding === 1)).toBe(true);
    expect(full.nodes.slice(HERO_LANDING_COUNT).every((n) => n.isLanding === 0)).toBe(true);
  });
});

describe('graphFull — field completeness (R3)', () => {
  it('every node carries lastTouched and confidence keys, null when unknown', async () => {
    const { graphFull } = await import('../graph/full.js');
    const { projectId } = await seedStar();
    const full = await graphFull(projectId);
    for (const n of full.nodes) {
      expect(Object.hasOwn(n, 'lastTouched')).toBe(true);
      expect(Object.hasOwn(n, 'confidence')).toBe(true);
      expect(n.lastTouched).toBeNull();
      expect(n.confidence).toBeNull();
    }
  });

  it('returns only edges whose BOTH endpoints survived the node cap', async () => {
    const { graphFull } = await import('../graph/full.js');
    const { projectId, hub, leaves } = await seedStar();
    // Hub (degree 3) outranks every leaf (degree 1); the leaves tie and the
    // lowest id wins the second slot. The other two leaves are dropped WITH
    // their hub edges dangling.
    const full = await graphFull(projectId, { nodes: 2, edges: 50 });
    const keptLeaf = [...leaves].sort()[0];
    expect(full.nodes.map((n) => n.id).sort()).toEqual([hub, keptLeaf].sort());
    expect(full.edges).toHaveLength(1);
    const kept = new Set(full.nodes.map((n) => n.id));
    for (const e of full.edges) {
      expect(kept.has(e.source)).toBe(true);
      expect(kept.has(e.target)).toBe(true);
    }
    expect(full.truncated.edges).toBe(true);
    expect(full.truncated.edgeTotal).toBe(3);
  });

  it('edge strength is a finite number from the reader, and falls back to 1 when the reader has no entry', async () => {
    const { graphFull } = await import('../graph/full.js');
    const { projectId } = await seedStar();
    const real = await graphFull(projectId);
    for (const e of real.edges) expect(Number.isFinite(e.strength)).toBe(true);
    strengthMode.empty = true;
    const bare = await graphFull(projectId);
    expect(bare.edges).toHaveLength(3);
    for (const e of bare.edges) expect(e.strength).toBe(1);
  });

  it('edgeTotal counts the project\'s edges before filtering, and the edge cap flags truncation', async () => {
    const { graphFull } = await import('../graph/full.js');
    const { projectId, hub, edgeIds, edgeTargets } = await seedStar();
    const full = await graphFull(projectId, { nodes: 50, edges: 1 });
    expect(full.nodes).toHaveLength(4);
    expect(full.edges).toHaveLength(1);
    expect(full.truncated.edgeTotal).toBe(3);
    expect(full.truncated.edges).toBe(true);
    expect(full.truncated.nodes).toBe(false);
    // Determinism under the cap (ORDER BY id): the survivor is the SMALLEST id,
    // which was inserted LAST — heap order would return the largest.
    const smallest = [...edgeIds].sort()[0];
    expect(full.edges[0]).toMatchObject({ source: hub, target: edgeTargets.get(smallest) });
    expect(edgeTargets.get(smallest)).not.toBe(edgeTargets.get(edgeIds[0]));
  });

  it('a project with no graph returns empty arrays and all-false truncation', async () => {
    const { graphFull } = await import('../graph/full.js');
    const { projectId } = await insertProject();
    const full = await graphFull(projectId);
    expect(full).toEqual({ nodes: [], edges: [], truncated: { nodes: false, edges: false, nodeTotal: 0, edgeTotal: 0 } });
  });
});
