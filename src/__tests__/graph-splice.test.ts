/**
 * Incremental splice: node ids stay stable across re-extraction (upsert), so
 * incoming edges from UNCHANGED files survive; vanished nodes + deleted files
 * are removed; shared-kind nodes survive full splices and orphans get swept.
 */
import { beforeAll, afterAll, describe, expect, it } from 'vitest';
import { Pool } from 'pg';
import type { ExtractedEdge, ExtractedNode, GraphExtractor } from '../graph/types.js';

process.env.MAI_PROJECT_SLUG = 'splice-test';
process.env.MAI_DB_URL =
  process.env.MAI_DB_URL ?? 'postgresql://postgres:postgres@127.0.0.1:54334/mai_brain';

const admin = new Pool({ connectionString: process.env.MAI_DB_URL });
let projectA = '';

const A = '/tmp/splice-repo/src/a.ts';
const B = '/tmp/splice-repo/src/b.ts';

function nodesFor(version: 1 | 2): ExtractedNode[] {
  const base: ExtractedNode[] = [
    { kind: 'file', name: 'a.ts', qualifiedName: 'repo/src/a.ts', filePath: A },
    { kind: 'file', name: 'b.ts', qualifiedName: 'repo/src/b.ts', filePath: B },
  ];
  base.push(
    version === 1
      ? { kind: 'function', name: 'oldFn', qualifiedName: 'repo/src/b.ts#oldFn', filePath: B }
      : { kind: 'function', name: 'newFn', qualifiedName: 'repo/src/b.ts#newFn', filePath: B }
  );
  return base;
}

function edgesFor(version: 1 | 2): ExtractedEdge[] {
  return [
    { from: { kind: 'file', qualifiedName: 'repo/src/a.ts' }, to: { kind: 'file', qualifiedName: 'repo/src/b.ts' }, relation: 'imports' },
    {
      from: { kind: 'file', qualifiedName: 'repo/src/b.ts' },
      to: { kind: 'function', qualifiedName: version === 1 ? 'repo/src/b.ts#oldFn' : 'repo/src/b.ts#newFn' },
      relation: 'defines',
    },
  ];
}

function fakeTs(version: 1 | 2, filterChanged: boolean): GraphExtractor {
  return {
    name: 'fake-splice',
    vocabulary: { kinds: ['file', 'function', 'command'], relations: ['imports', 'defines', 'invokes'] },
    extract: async (input) => {
      let nodes = nodesFor(version);
      let edges = edgesFor(version);
      if (filterChanged && input.changedFiles) {
        const changed = new Set(input.changedFiles);
        nodes = nodes.filter((n) => n.filePath !== undefined && changed.has(n.filePath));
        const kept = new Set(nodes.map((n) => n.qualifiedName));
        edges = edges.filter((e) => kept.has(e.from.qualifiedName));
      }
      return { nodes, edges };
    },
  };
}

beforeAll(async () => {
  await admin.query(`DELETE FROM projects WHERE slug = 'splice-test'`);
  const a = await admin.query<{ id: string }>(
    `INSERT INTO projects (slug, name) VALUES ('splice-test','Splice') RETURNING id`
  );
  projectA = a.rows[0].id;
});

afterAll(async () => {
  await admin.query(`DELETE FROM projects WHERE slug = 'splice-test'`);
  await admin.end();
  const { getPool } = await import('../db.js');
  await getPool().end();
});

describe('spliceExtractor', () => {
  it('keeps unchanged ids + incoming edges; removes vanished nodes; rebuilds outgoing edges', async () => {
    const { runExtractor, spliceExtractor } = await import('../graph/engine.js');
    await runExtractor(fakeTs(1, false), { projectId: projectA, repoPaths: [] });

    const before = await admin.query<{ id: string; qualified_name: string }>(
      `SELECT id, qualified_name FROM graph_nodes WHERE project_id = $1`, [projectA]);
    const idOf = (qn: string): string => {
      const row = before.rows.find((r) => r.qualified_name === qn);
      if (!row) throw new Error(`missing ${qn}`);
      return row.id;
    };
    const aId = idOf('repo/src/a.ts');
    const bId = idOf('repo/src/b.ts');

    const s = await spliceExtractor(fakeTs(2, true), {
      projectId: projectA, repoPaths: [], changedFiles: [B], deletedFiles: [],
    });
    expect(s.removedNodes).toBe(1); // oldFn vanished

    const after = await admin.query<{ id: string; qualified_name: string }>(
      `SELECT id, qualified_name FROM graph_nodes WHERE project_id = $1`, [projectA]);
    const qnames = after.rows.map((r) => r.qualified_name);
    expect(qnames).toContain('repo/src/b.ts#newFn');
    expect(qnames).not.toContain('repo/src/b.ts#oldFn');
    expect(after.rows.find((r) => r.qualified_name === 'repo/src/a.ts')?.id).toBe(aId);
    expect(after.rows.find((r) => r.qualified_name === 'repo/src/b.ts')?.id).toBe(bId);

    // THE invariant: a.ts —imports→ b.ts came from the UNCHANGED file and must survive.
    const imp = await admin.query(
      `SELECT 1 FROM graph_edges WHERE project_id = $1 AND from_node = $2 AND to_node = $3 AND relation = 'imports'`,
      [projectA, aId, bId]
    );
    expect(imp.rows.length).toBe(1);
  });

  it('deletedFiles removes the file subgraph entirely', async () => {
    const { spliceExtractor } = await import('../graph/engine.js');
    await spliceExtractor(fakeTs(2, true), {
      projectId: projectA, repoPaths: [], changedFiles: [], deletedFiles: [B],
    });
    const left = await admin.query(`SELECT qualified_name FROM graph_nodes WHERE project_id = $1`, [projectA]);
    expect(left.rows.map((r: { qualified_name: string }) => r.qualified_name)).toEqual(['repo/src/a.ts']);
  });
});

describe('shared kinds', () => {
  it('full splice never deletes command nodes; the orphan sweep does', async () => {
    const { runExtractor, sweepOrphanSharedNodes } = await import('../graph/engine.js');
    const withCmd: GraphExtractor = {
      name: 'fake-sh',
      vocabulary: { kinds: ['script', 'command'], relations: ['invokes'] },
      extract: async () => ({
        nodes: [
          { kind: 'script', name: 'x.sh', qualifiedName: 'repo/x.sh', filePath: '/tmp/splice-repo/x.sh' },
          { kind: 'command', name: 'pg_dump', qualifiedName: 'cmd:pg_dump' },
        ],
        edges: [
          { from: { kind: 'script', qualifiedName: 'repo/x.sh' }, to: { kind: 'command', qualifiedName: 'cmd:pg_dump' }, relation: 'invokes' },
        ],
      }),
    };
    await runExtractor(withCmd, { projectId: projectA, repoPaths: [] });
    const cmd = await admin.query<{ id: string }>(
      `SELECT id FROM graph_nodes WHERE project_id = $1 AND qualified_name = 'cmd:pg_dump'`, [projectA]);
    const cmdId = cmd.rows[0].id;

    // Re-run (full splice): the command node must survive WITH THE SAME ID.
    await runExtractor(withCmd, { projectId: projectA, repoPaths: [] });
    const cmd2 = await admin.query<{ id: string }>(
      `SELECT id FROM graph_nodes WHERE project_id = $1 AND qualified_name = 'cmd:pg_dump'`, [projectA]);
    expect(cmd2.rows[0].id).toBe(cmdId);

    // Orphan it (re-run emitting nothing) → sweep removes it.
    const empty: GraphExtractor = { ...withCmd, extract: async () => ({ nodes: [], edges: [] }) };
    await runExtractor(empty, { projectId: projectA, repoPaths: [] });
    const swept = await sweepOrphanSharedNodes(projectA);
    expect(swept).toBe(1);
  });
});
