/**
 * mai-graph engine: vocabulary validation, idempotent splice, cross-extractor
 * edge resolution, unresolved-edge dropping. (Linker tests appended in Task 7.)
 * Requires: docker compose up -d && npm run db:init + the graph migration.
 */
import { beforeAll, afterAll, describe, expect, it } from 'vitest';
import { Pool } from 'pg';
import type { ExtractedEdge, ExtractedNode, GraphExtractor } from '../graph/types.js';

process.env.MAI_PROJECT_SLUG = 'graph-test-a';
process.env.MAI_DB_URL =
  process.env.MAI_DB_URL ?? 'postgresql://postgres:postgres@127.0.0.1:54334/mai_brain';

const admin = new Pool({ connectionString: process.env.MAI_DB_URL });
let projectA = '';

async function cleanup(): Promise<void> {
  await admin.query(`DELETE FROM projects WHERE slug = 'graph-test-a'`); // cascades graph + decisions
}

beforeAll(async () => {
  await cleanup();
  const a = await admin.query<{ id: string }>(
    `INSERT INTO projects (slug, name) VALUES ('graph-test-a','Graph A') RETURNING id`
  );
  projectA = a.rows[0].id;
});

afterAll(async () => {
  await cleanup();
  await admin.end();
  const { getPool } = await import('../db.js');
  await getPool().end();
});

function fake(name: string, nodes: ExtractedNode[], edges: ExtractedEdge[]): GraphExtractor {
  return {
    name,
    vocabulary: { kinds: ['file', 'function', 'table'], relations: ['defines', 'references_table'] },
    extract: async () => ({ nodes, edges }),
  };
}

const fileNode: ExtractedNode = {
  kind: 'file',
  name: 'save.ts',
  qualifiedName: 'repo/src/save.ts',
  filePath: '/tmp/fake-repo/src/save.ts',
  lang: 'typescript',
};
const fnNode: ExtractedNode = {
  kind: 'function',
  name: 'saveWorkout',
  qualifiedName: 'repo/src/save.ts#saveWorkout',
  filePath: '/tmp/fake-repo/src/save.ts',
  line: 10,
};
const definesEdge: ExtractedEdge = {
  from: { kind: 'file', qualifiedName: 'repo/src/save.ts' },
  to: { kind: 'function', qualifiedName: 'repo/src/save.ts#saveWorkout' },
  relation: 'defines',
};

describe('graph engine', () => {
  it('inserts nodes and edges, and re-runs are idempotent (splice)', async () => {
    const { runExtractor } = await import('../graph/engine.js');
    const input = { projectId: projectA, repoPaths: [] };
    const s1 = await runExtractor(fake('fake', [fileNode, fnNode], [definesEdge]), input);
    expect(s1).toMatchObject({ nodes: 2, edges: 1, droppedEdges: 0 });
    const s2 = await runExtractor(fake('fake', [fileNode, fnNode], [definesEdge]), input);
    expect(s2).toMatchObject({ nodes: 2, edges: 1 });
    const n = await admin.query(`SELECT COUNT(*)::int AS c FROM graph_nodes WHERE project_id = $1`, [projectA]);
    const e = await admin.query(`SELECT COUNT(*)::int AS c FROM graph_edges WHERE project_id = $1`, [projectA]);
    expect(n.rows[0].c).toBe(2);
    expect(e.rows[0].c).toBe(1);
  });

  it('drops edges whose target does not exist — never invents nodes', async () => {
    const { runExtractor } = await import('../graph/engine.js');
    const dangling: ExtractedEdge = {
      from: { kind: 'file', qualifiedName: 'repo/src/save.ts' },
      to: { kind: 'table', qualifiedName: 'public.does_not_exist' },
      relation: 'references_table',
    };
    const s = await runExtractor(fake('fake', [fileNode, fnNode], [definesEdge, dangling]), {
      projectId: projectA,
      repoPaths: [],
    });
    expect(s.droppedEdges).toBe(1);
    expect(s.edges).toBe(1);
  });

  it('resolves cross-extractor edges against earlier extractors output', async () => {
    const { runExtractor } = await import('../graph/engine.js');
    const tableNode: ExtractedNode = { kind: 'table', name: 'workouts', qualifiedName: 'public.workouts', lang: 'sql' };
    await runExtractor(fake('fake-db', [tableNode], []), { projectId: projectA, repoPaths: [] });
    const ref: ExtractedEdge = {
      from: { kind: 'file', qualifiedName: 'repo/src/save.ts' },
      to: { kind: 'table', qualifiedName: 'public.workouts' },
      relation: 'references_table',
      confidence: 'extracted',
    };
    const s = await runExtractor(fake('fake', [fileNode, fnNode], [definesEdge, ref]), {
      projectId: projectA,
      repoPaths: [],
    });
    expect(s.droppedEdges).toBe(0);
    expect(s.edges).toBe(2);
  });

  it('rejects unregistered kinds and relations', async () => {
    const { runExtractor } = await import('../graph/engine.js');
    const bad: GraphExtractor = {
      name: 'bad',
      vocabulary: { kinds: ['file'], relations: ['defines'] },
      extract: async () => ({ nodes: [fnNode], edges: [] }), // 'function' not in vocabulary
    };
    await expect(runExtractor(bad, { projectId: projectA, repoPaths: [] })).rejects.toThrow(/unregistered node kind/);
  });

  it('rejects empty qualifiedName', async () => {
    const { runExtractor } = await import('../graph/engine.js');
    const empty: ExtractedNode = { kind: 'file', name: 'x.ts', qualifiedName: '  ' };
    await expect(
      runExtractor(fake('fake-e', [empty], []), { projectId: projectA, repoPaths: [] })
    ).rejects.toThrow(/empty name\/qualifiedName/);
  });
});

describe('decisions→file linker', () => {
  it('materializes inferred memory edges from files_affected, idempotently', async () => {
    const { runExtractor } = await import('../graph/engine.js');
    const { linkDecisionsToFiles } = await import('../graph/linker.js');
    const linkedFile: ExtractedNode = {
      kind: 'file',
      name: 'linker-target.ts',
      qualifiedName: 'repo/src/linker-target.ts',
      filePath: '/tmp/fake-repo/src/linker-target.ts',
    };
    await runExtractor(fake('fake-linker', [linkedFile], []), { projectId: projectA, repoPaths: [] });
    const d = await admin.query<{ id: string }>(
      `INSERT INTO code_decisions (project_id, decision_type, description, files_affected, source)
       VALUES ($1, 'architecture', 'linker test decision', ARRAY['src/linker-target.ts'], 'user-approved')
       RETURNING id`,
      [projectA]
    );
    const first = await linkDecisionsToFiles(projectA);
    expect(first).toBe(1);
    const edge = await admin.query(
      `SELECT relation, confidence FROM memory_edges
       WHERE from_kind = 'decision' AND from_id = $1 AND to_kind = 'graph_node'`,
      [d.rows[0].id]
    );
    expect(edge.rows[0]).toMatchObject({ relation: 'affects', confidence: 'inferred' });
    const second = await linkDecisionsToFiles(projectA);
    expect(second).toBe(0);
  });
});

describe('extracted source evidence', () => {
  for (const mode of ['full', 'splice'] as const) {
    async function writeEvidence(name: string, nodes: ExtractedNode[]): Promise<void> {
      const { runExtractor, spliceExtractor } = await import('../graph/engine.js');
      const extractor = fake(name, nodes, []);
      const input = { projectId: projectA, repoPaths: [] };
      if (mode === 'full') await runExtractor(extractor, input);
      else await spliceExtractor(extractor, {
        ...input, changedFiles: [...new Set(nodes.flatMap(n => n.filePath ? [n.filePath] : []))],
        deletedFiles: [],
      });
    }

    it(`${mode}: inherits parsed file evidence, preserves explicit evidence and does not mutate output`, async () => {
      const { hashContent } = await import('../graph/engine.js');
      const hash = hashContent('the text actually parsed');
      const otherHash = hashContent('another defining file');
      const name = `evidence-${mode}`;
      const qn = `evidence/${mode}`;
      const nodes: ExtractedNode[] = [
        { ...fnNode, qualifiedName: `${qn}#inherited` },
        { ...fileNode, qualifiedName: qn, contentHash: hash },
        { ...fnNode, qualifiedName: `${qn}#explicit`, contentHash: hash },
        { ...fnNode, qualifiedName: `${qn}#alias`, filePath: '/tmp/fake-repo/src/../src/save.ts' },
        { ...fnNode, qualifiedName: `${qn}#no-anchor`, filePath: '/tmp/fake-repo/src/missing.ts' },
        { ...fnNode, qualifiedName: `${qn}#own`, filePath: '/tmp/fake-repo/src/own.ts', contentHash: otherHash },
        { kind: 'table', name: 'external', qualifiedName: `${qn}#fileless` },
      ];
      const before = structuredClone(nodes);
      await writeEvidence(name, nodes);
      const saved = await admin.query<{ qualified_name: string; content_hash: string | null; commit_sha: string | null }>(
        `SELECT qualified_name, content_hash, commit_sha FROM graph_nodes
         WHERE project_id = $1 AND extracted_by = $2`, [projectA, name]);
      expect(new Map(saved.rows.map(row => [row.qualified_name, row.content_hash]))).toEqual(new Map<string, string | null>([
        [`${qn}#inherited`, hash], [qn, hash], [`${qn}#explicit`, hash], [`${qn}#alias`, hash],
        [`${qn}#no-anchor`, null], [`${qn}#own`, otherHash], [`${qn}#fileless`, null],
      ]));
      expect(saved.rows.every(row => row.commit_sha === null)).toBe(true);
      expect(nodes).toEqual(before);
    });

    it(`${mode}: rejects conflicts before dedupe or persistence and preserves prior rows`, async () => {
      const { hashContent } = await import('../graph/engine.js');
      const name = `conflict-${mode}`;
      const base = { ...fileNode, qualifiedName: name, contentHash: hashContent('old') };
      await writeEvidence(name, [base]);
      const before = await admin.query<{ id: string; content_hash: string }>(
        `SELECT id, content_hash FROM graph_nodes WHERE project_id = $1 AND extracted_by = $2`, [projectA, name]);
      const conflicts: ExtractedNode[][] = [
        [base, { ...base, contentHash: hashContent('different duplicate') }],
        [base, { ...fnNode, qualifiedName: `${name}#explicit`, contentHash: hashContent('different symbol') }],
        [base, { ...base, qualifiedName: `${name}/alias`, filePath: '/tmp/fake-repo/src/../src/save.ts', contentHash: hashContent('alias conflict') }],
      ];
      for (const nodes of conflicts) {
        await expect(writeEvidence(name, nodes)).rejects.toThrow('conflicting defining-source hashes');
        const after = await admin.query<{ id: string; content_hash: string }>(
          `SELECT id, content_hash FROM graph_nodes WHERE project_id = $1 AND extracted_by = $2`, [projectA, name]);
        expect(after.rows).toEqual(before.rows);
      }
    });

    it(`${mode}: rejects malformed explicit evidence without deleting valid rows`, async () => {
      const { hashContent } = await import('../graph/engine.js');
      const name = `invalid-${mode}`;
      const base = { ...fileNode, qualifiedName: name, contentHash: hashContent('valid') };
      await writeEvidence(name, [base]);
      for (const invalid of ['', 'not-a-hash', 'A'.repeat(64), 'a'.repeat(63)]) {
        await expect(writeEvidence(name, [{ ...base, contentHash: invalid }])).rejects.toThrow('invalid defining-source hash');
      }
      const saved = await admin.query<{ content_hash: string }>(
        `SELECT content_hash FROM graph_nodes WHERE project_id = $1 AND extracted_by = $2`, [projectA, name]);
      expect(saved.rows).toEqual([{ content_hash: base.contentHash }]);
    });

    it(`${mode}: cannot inherit old evidence or evidence from another extractor`, async () => {
      const { hashContent, runExtractor } = await import('../graph/engine.js');
      const name = `isolated-${mode}`;
      const qn = `${name}/save.ts`;
      await writeEvidence(name, [{ ...fileNode, qualifiedName: qn, contentHash: hashContent('old') }]);
      await runExtractor(fake(`foreign-${mode}`, [
        { ...fileNode, qualifiedName: `foreign/${mode}`, contentHash: hashContent('foreign') },
      ], []), { projectId: projectA, repoPaths: [] });
      await writeEvidence(name, [{ ...fnNode, qualifiedName: `${qn}#without-evidence` }]);
      const saved = await admin.query<{ content_hash: string | null }>(
        `SELECT content_hash FROM graph_nodes WHERE project_id = $1 AND extracted_by = $2`, [projectA, name]);
      expect(saved.rows).toEqual([{ content_hash: null }]);
    });
  }

  it('keeps source evidence project-scoped for identical graph identities', async () => {
    const { hashContent, runExtractor, spliceExtractor } = await import('../graph/engine.js');
    const slug = 'graph-evidence-private';
    await admin.query('DELETE FROM projects WHERE slug = $1', [slug]);
    const created = await admin.query<{ id: string }>(
      'INSERT INTO projects (slug, name) VALUES ($1, $1) RETURNING id', [slug]);
    const otherProject = created.rows[0].id;
    try {
      const name = 'project-evidence';
      const qn = 'project-evidence/save.ts';
      const hash = hashContent('private source');
      await runExtractor(fake(name, [{ ...fileNode, qualifiedName: qn, contentHash: hash }], []),
        { projectId: otherProject, repoPaths: [] });
      await spliceExtractor(fake(name, [{ ...fileNode, qualifiedName: qn }], []),
        { projectId: projectA, repoPaths: [], changedFiles: [], deletedFiles: [] });
      const saved = await admin.query<{ project_id: string; content_hash: string | null }>(
        `SELECT project_id, content_hash FROM graph_nodes
         WHERE project_id = ANY($1) AND extracted_by = $2`, [[projectA, otherProject], name]);
      expect(new Map(saved.rows.map(row => [row.project_id, row.content_hash]))).toEqual(
        new Map<string, string | null>([[projectA, null], [otherProject, hash]]));
    } finally {
      await admin.query('DELETE FROM projects WHERE id = $1', [otherProject]);
    }
  });
});
