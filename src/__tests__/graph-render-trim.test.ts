/**
 * Plan 28 B1/B2/B3 — the agent-facing graph renders.
 *
 * Recorded baselines, computed during plan authoring from THIS fixture (node ids
 * are always 36 chars, so both numbers are deterministic):
 *   old two-line form : 2,676 chars over 44 lines
 *   new one-line form : 2,242 chars over 24 lines   (-434, -16.2%)
 * The live check on this project's real graph agreed: 3,590 -> 3,038 for 20 hits.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Pool } from 'pg';
import { requireDisposableTestDbUrl } from './test-db-url.js';

const TEST_DB = requireDisposableTestDbUrl();
process.env.MAI_PROJECT_SLUG = 'render-trim-test';
process.env.MAI_DB_URL = TEST_DB;

const admin = new Pool({ connectionString: TEST_DB });
let projectId = '';
let emptyProjectId = '';
const ids: string[] = [];

const CODE_NODES = 16;
const TABLE_NODES = 4;
const OLD_FORM_CHARS = 2_676;
const NEW_FORM_CHARS = 2_242;

beforeAll(async () => {
  // loadProjectGraphRoots (0d4ea74 hardening) requires a real, existing
  // product root on every project row the graph readers touch.
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'render-trim-')));
  await admin.query(`DELETE FROM projects WHERE slug IN ('render-trim-test', 'render-trim-empty')`);
  const p = await admin.query<{ id: string }>(
    `INSERT INTO projects (slug, name, path) VALUES ('render-trim-test', 'Render Trim', $1) RETURNING id`,
    [root]
  );
  projectId = p.rows[0].id;
  const e = await admin.query<{ id: string }>(
    `INSERT INTO projects (slug, name, path) VALUES ('render-trim-empty', 'Render Trim Empty', $1) RETURNING id`,
    [root]
  );
  emptyProjectId = e.rows[0].id;

  for (let i = 0; i < CODE_NODES; i++) {
    const r = await admin.query<{ id: string }>(
      `INSERT INTO graph_nodes (project_id, kind, name, qualified_name, file_path, line, extracted_by)
       VALUES ($1, 'function', $2, $3, $4, $5, 'ts') RETURNING id`,
      [projectId, `fixtureFn${i}`, `trimrepo/src/mod${i}.ts#fixtureFn${i}`, `/tmp/trimrepo/src/mod${i}.ts`, 100 + i]
    );
    ids.push(r.rows[0].id);
  }
  for (let j = 0; j < TABLE_NODES; j++) {
    const r = await admin.query<{ id: string }>(
      `INSERT INTO graph_nodes (project_id, kind, name, qualified_name, extracted_by)
       VALUES ($1, 'table', $2, $3, 'db') RETURNING id`,
      [projectId, `fixture_tbl${j}`, `public.fixture_tbl${j}`]
    );
    ids.push(r.rows[0].id);
  }
  // One edge so the neighborhood renders.
  await admin.query(
    `INSERT INTO graph_edges (project_id, from_node, to_node, relation, confidence)
     VALUES ($1, $2, $3, 'references_table', 'extracted')`,
    [projectId, ids[0], ids[CODE_NODES]]
  );
});

afterAll(async () => {
  await admin.query(`DELETE FROM projects WHERE slug IN ('render-trim-test', 'render-trim-empty')`);
  await admin.end();
  const { getPool } = await import('../db.js');
  await getPool().end();
});

describe('B1 — one line per mai_graph_find hit', () => {
  it('emits exactly one line per hit and keeps every id verbatim', async () => {
    const { graphFind } = await import('../graph/query.js');
    const out = await graphFind({ query: 'fixture', limit: 20, projectId });
    const hitLines = out.split('\n').filter((l) => l.startsWith('- ['));
    expect(hitLines).toHaveLength(CODE_NODES + TABLE_NODES);
    for (const id of ids) expect(out).toContain(id);
    expect(out).not.toContain('\n  id: '); // the second line is gone
  });

  it('keeps file:line on every located hit', async () => {
    const { graphFind } = await import('../graph/query.js');
    const out = await graphFind({ query: 'fixture', limit: 20, projectId });
    for (let i = 0; i < CODE_NODES; i++) {
      expect(out).toContain(`/tmp/trimrepo/src/mod${i}.ts:${100 + i}`);
    }
  });

  it('length regression against the recorded baseline', async () => {
    const { graphFind } = await import('../graph/query.js');
    const out = await graphFind({ query: 'fixture', limit: 20, projectId });
    expect(out.split('\n')).toHaveLength(24);
    expect(out.length).toBe(NEW_FORM_CHARS);
    expect(out.length).toBeLessThan(OLD_FORM_CHARS);
  });
});

describe('B3 — honest empty result', () => {
  it('a project with a built graph is told the graph is built', async () => {
    const { graphFind } = await import('../graph/query.js');
    const out = await graphFind({ query: 'zzzznotathing', projectId });
    expect(out).toContain(`${CODE_NODES + TABLE_NODES} nodes in the graph, none match`);
    expect(out).not.toContain('never been built');
  });

  it('a project with no graph is told to build it, with a VALID command', async () => {
    const { graphFind } = await import('../graph/query.js');
    const out = await graphFind({ query: 'zzzznotathing', projectId: emptyProjectId });
    expect(out).toContain('never been built');
    expect(out).toContain('mai graph build --project <slug>');
  });

  it('names the kind filter as a thing to drop', async () => {
    const { graphFind } = await import('../graph/query.js');
    const out = await graphFind({ query: 'fixture', kind: 'endpoint', projectId });
    expect(out).toContain('(kind=endpoint)');
    expect(out).toContain('drop kind=endpoint');
  });
});

describe('B2 — file:line in neighbors and impact, one source of node rows', () => {
  it('neighbors renders one line per node carrying file:line and the id', async () => {
    const { graphNeighbors } = await import('../graph/query.js');
    const out = await graphNeighbors({ nodeId: ids[0], depth: 1, projectId });
    expect(out).toContain('/tmp/trimrepo/src/mod0.ts:100');
    expect(out).toContain(ids[0]);
    expect(out).not.toContain('\n  id: ');
  });

  it('impact names where each dependent lives', async () => {
    const { graphImpact } = await import('../graph/query.js');
    const out = await graphImpact({ nodeId: ids[CODE_NODES], depth: 1, projectId });
    expect(out).toContain('references_table');
    expect(out).toContain('/tmp/trimrepo/src/mod0.ts:100');
  });

  it('graphNeighborsRows hydrates file_path/line from the single node query', async () => {
    const { graphNeighborsRows } = await import('../graph/query.js');
    const json = await graphNeighborsRows({ nodeId: ids[0], depth: 1, projectId });
    expect(json).not.toBeNull();
    const fn = json?.nodes.find((n) => n.id === ids[0]);
    expect(fn?.file_path).toBe('/tmp/trimrepo/src/mod0.ts');
    expect(fn?.line).toBe(100);
    const tbl = json?.nodes.find((n) => n.id === ids[CODE_NODES]);
    expect(tbl?.file_path).toBeNull();
    expect(tbl?.line).toBeNull();
  });
});
