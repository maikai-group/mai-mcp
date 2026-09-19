/** trace / impact / stale / mermaid over a seeded mini-graph. */
import { beforeAll, afterAll, describe, expect, it } from 'vitest';
import { Pool } from 'pg';
import path from 'node:path';
import fs from 'node:fs';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import type { GraphExtractor } from '../graph/types.js';
import { requireDisposableTestDbUrl } from './test-db-url.js';

process.env.MAI_PROJECT_SLUG = 'query2-test';
const DB_URL = requireDisposableTestDbUrl();
process.env.MAI_TEST_DB_URL = DB_URL;
process.env.MAI_DB_URL = DB_URL;

const admin = new Pool({ connectionString: process.env.MAI_DB_URL });
let projectA = '';
let cardId = '';
let tableId = '';

// THIS repo is a real git repo — graphStale computes HEAD against it.
const THIS_REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

const seed: GraphExtractor = {
  name: 'seed',
  vocabulary: {
    kinds: ['component', 'file', 'endpoint', 'table'],
    relations: ['defines', 'serves_route', 'references_table'],
  },
  extract: async () => ({
    nodes: [
      { kind: 'component', name: 'SaveCard', qualifiedName: 'repo/src/SaveCard.tsx#SaveCard', filePath: `${THIS_REPO}/src/SaveCard.tsx` },
      { kind: 'file', name: 'SaveCard.tsx', qualifiedName: 'repo/src/SaveCard.tsx', filePath: `${THIS_REPO}/src/SaveCard.tsx` },
      { kind: 'endpoint', name: 'POST /save', qualifiedName: 'route:POST /save', filePath: `${THIS_REPO}/src/server.ts` },
      { kind: 'table', name: 'workouts', qualifiedName: 'public.workouts' },
    ],
    edges: [
      { from: { kind: 'file', qualifiedName: 'repo/src/SaveCard.tsx' }, to: { kind: 'component', qualifiedName: 'repo/src/SaveCard.tsx#SaveCard' }, relation: 'defines' },
      { from: { kind: 'file', qualifiedName: 'repo/src/SaveCard.tsx' }, to: { kind: 'endpoint', qualifiedName: 'route:POST /save' }, relation: 'serves_route' },
      { from: { kind: 'file', qualifiedName: 'repo/src/SaveCard.tsx' }, to: { kind: 'table', qualifiedName: 'public.workouts' }, relation: 'references_table' },
    ],
  }),
};

beforeAll(async () => {
  await admin.query(`DELETE FROM projects WHERE slug = 'query2-test'`);
  const a = await admin.query<{ id: string }>(
    `INSERT INTO projects (slug, name, path, metadata) VALUES ('query2-test','Q2', $1, jsonb_build_object('repos', jsonb_build_array($1::text))) RETURNING id`,
    [THIS_REPO]
  );
  projectA = a.rows[0].id;
  const { runExtractor } = await import('../graph/engine.js');
  await runExtractor(seed, { projectId: projectA, repoPaths: [THIS_REPO] });
  const card = await admin.query<{ id: string }>(
    `SELECT id FROM graph_nodes WHERE project_id = $1 AND qualified_name = 'repo/src/SaveCard.tsx#SaveCard'`, [projectA]);
  cardId = card.rows[0].id;
  const tbl = await admin.query<{ id: string }>(
    `SELECT id FROM graph_nodes WHERE project_id = $1 AND qualified_name = 'public.workouts'`, [projectA]);
  tableId = tbl.rows[0].id;
  // A decision linked to the table node (the impact join).
  const d = await admin.query<{ id: string }>(
    `INSERT INTO code_decisions (project_id, decision_type, description, source)
     VALUES ($1, 'data-model', 'workouts table holds one row per completed workout', 'user-approved') RETURNING id`,
    [projectA]
  );
  await admin.query(
    `INSERT INTO memory_edges (project_id, from_kind, from_id, to_kind, to_id, relation, confidence)
     VALUES ($1, 'decision', $2, 'graph_node', $3, 'affects', 'inferred')`,
    [projectA, d.rows[0].id, tableId]
  );
});

afterAll(async () => {
  await admin.query(`DELETE FROM projects WHERE slug = 'query2-test'`);
  await admin.end();
  const { getPool } = await import('../db.js');
  await getPool().end();
});

describe('graphTrace', () => {
  it('finds the component → table path through the shared file', async () => {
    const { graphTrace } = await import('../graph/query.js');
    const out = await graphTrace({ fromId: cardId, toId: tableId });
    expect(out).toContain('# Trace (2 hops)');
    expect(out).toContain('SaveCard');
    expect(out).toContain('public.workouts');
    expect(out).toContain('references_table');
  });

  it('reports no path beyond hop limit / disconnected nodes', async () => {
    const { graphTrace } = await import('../graph/query.js');
    const lonely = await admin.query<{ id: string }>(
      `INSERT INTO graph_nodes (project_id, kind, name, qualified_name, extracted_by)
       VALUES ($1, 'table', 'lonely', 'public.lonely', 'seed') RETURNING id`, [projectA]);
    const out = await graphTrace({ fromId: cardId, toId: lonely.rows[0].id });
    expect(out).toContain('No path');
  });
});

describe('graphImpact', () => {
  it('lists reverse deps AND the joined decision', async () => {
    const { graphImpact } = await import('../graph/query.js');
    const out = await graphImpact({ nodeId: tableId, depth: 2 });
    expect(out).toContain('references_table');
    expect(out).toContain('workouts table holds one row per completed workout');
  });
});

describe('graphStale', () => {
  it('unverifiable source counts conservatively in graphStale output', async () => {
    await admin.query(
      `UPDATE graph_nodes SET commit_sha = 'deadbeefdeadbeefdeadbeefdeadbeefdeadbeef'
       WHERE project_id = $1 AND qualified_name = 'repo/src/SaveCard.tsx'`,
      [projectA]
    );
    const { graphStale } = await import('../graph/query.js');
    const out = await graphStale({ projectId: projectA });
    expect(out).toContain('stale');
    expect(out).toMatch(/[1-9]\d*\/\d+ stale/);
  });
});

describe('graphNeighborsMermaid', () => {
  it('renders a mermaid fence with sanitized labels + id list', async () => {
    const { graphNeighborsMermaid } = await import('../graph/query.js');
    const out = await graphNeighborsMermaid({ nodeId: cardId, depth: 1 });
    expect(out).toContain('```mermaid');
    expect(out).toContain('flowchart LR');
    expect(out).toContain('component: SaveCard');
    expect(out).toContain(`id: ${cardId}`);
  });
});

describe('graphFindForTask (prime structure matching)', () => {
  it('tokenizes a task: drops stopwords + short words, dedupes', async () => {
    const { tokenizeTask } = await import('../graph/query.js');
    expect(tokenizeTask('Save the workout card and the workout flow')).toEqual(['save', 'workout', 'card']);
  });

  it('surfaces nodes by token where feeding the raw sentence finds nothing', async () => {
    const { graphFindForTask, graphFindRows } = await import('../graph/query.js');
    const sentence = 'save the workout card';
    // The bug: the whole sentence as one ILIKE/trigram term matches no node name.
    expect(await graphFindRows({ query: sentence, projectId: projectA })).toHaveLength(0);
    // The fix: tokenized → SaveCard (matches 'save' + 'card') surfaces.
    const hits = await graphFindForTask({ task: sentence, limit: 5, projectId: projectA });
    expect(hits.length).toBeGreaterThan(0);
    expect(hits.some((h) => h.qualified_name === 'repo/src/SaveCard.tsx#SaveCard')).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Plan 39 Task 4: risk-classified impact over real evidence. The classifier is
// unit-tested in graph-query-wave2.test.ts; these cases prove the EVIDENCE fed
// to it comes from the returned nodes and the frozen reasoning predicates.
// ---------------------------------------------------------------------------

describe('impact risk classification (plan 39)', () => {
  let riskId = '';
  const nodes = new Map<string, string>();

  const addNode = async (key: string, args: {
    kind: string; file?: string | null; commit?: string | null; repo?: string;
  }): Promise<string> => {
    const row = await admin.query<{ id: string }>(
      `INSERT INTO graph_nodes (project_id, kind, name, qualified_name, file_path, line,
         extracted_by, extracted_at, commit_sha, content_hash)
       VALUES ($1,$2,$3,$3,$4,1,'seed', now(), $5, $6) RETURNING id`,
      [riskId, args.kind, key,
       args.file === undefined ? `${args.repo ?? THIS_REPO}/src/graph/query.ts` : args.file,
       args.commit === undefined ? HEAD_SHA : args.commit,
       args.commit === undefined ? crypto.createHash('sha256').update(fs.readFileSync(path.join(THIS_REPO, 'src/graph/query.ts'), 'utf8')).digest('hex') : '0'.repeat(64)]);
    nodes.set(key, row.rows[0].id);
    return row.rows[0].id;
  };
  const addEdge = async (from: string, to: string, relation: string, confidence = 'extracted') => {
    await admin.query(
      `INSERT INTO graph_edges (project_id, from_node, to_node, relation, confidence)
       VALUES ($1,$2,$3,$4,$5) ON CONFLICT DO NOTHING`,
      [riskId, nodes.get(from), nodes.get(to), relation, confidence]);
  };
  const impact = async (key: string, depth = 1): Promise<string> => {
    const { graphImpact } = await import('../graph/query.js');
    return graphImpact({ nodeId: nodes.get(key) ?? '', depth, projectId: riskId });
  };

  let HEAD_SHA = '';

  beforeAll(async () => {
    const { execFileSync } = await import('node:child_process');
    HEAD_SHA = execFileSync('git', ['rev-parse', 'HEAD'],
      { cwd: THIS_REPO, encoding: 'utf8' }).trim();
    await admin.query(`DELETE FROM projects WHERE slug = 'risk-test'`);
    riskId = (await admin.query<{ id: string }>(
      `INSERT INTO projects (slug, name, path, metadata) VALUES ('risk-test','Risk',$1,
         jsonb_build_object('repos', jsonb_build_array($1::text))) RETURNING id`,
      [THIS_REPO])).rows[0].id;

    await addNode('clean', { kind: 'function' });
    await addNode('cleanDep', { kind: 'function' });
    await addEdge('cleanDep', 'clean', 'calls');

    await addNode('boundary', { kind: 'table', file: null, commit: null });
    await addNode('boundaryDep', { kind: 'function' });
    await addEdge('boundaryDep', 'boundary', 'references_table');

    await addNode('inferred', { kind: 'function' });
    await addNode('inferredDep', { kind: 'function' });
    await addEdge('inferredDep', 'inferred', 'calls', 'inferred');

    await addNode('stale', { kind: 'function', commit: 'deadbeefdeadbeefdeadbeefdeadbeefdeadbeef' });
    await addNode('staleDep', { kind: 'function' });
    await addEdge('staleDep', 'stale', 'calls');

    await addNode('unrelatedStale', { kind: 'function' });
    await addNode('unrelatedStaleDep', { kind: 'function' });
    await addEdge('unrelatedStaleDep', 'unrelatedStale', 'calls');
    // A stale node NOBODY returns must not change the assessment.
    await addNode('farStale', { kind: 'function', commit: 'f'.repeat(40) });

    await addNode('reasoned', { kind: 'function' });
    await addNode('reasonedDep', { kind: 'function' });
    await addEdge('reasonedDep', 'reasoned', 'calls');
    await addNode('invalidReasoned', { kind: 'function' });
    await addNode('invalidReasonedDep', { kind: 'function' });
    await addEdge('invalidReasonedDep', 'invalidReasoned', 'calls');

    const valid = await admin.query<{ id: string }>(
      `INSERT INTO code_decisions (project_id, decision_type, description, source, still_valid, timestamp)
       VALUES ($1,'architecture','VALID risk reasoning row','user-approved',true, now()) RETURNING id`,
      [riskId]);
    await admin.query(
      `INSERT INTO memory_edges (project_id, from_kind, from_id, to_kind, to_id, relation)
       VALUES ($1,'decision',$2,'graph_node',$3,'implemented_by')`,
      [riskId, valid.rows[0].id, nodes.get('reasoned')]);
    const retracted = await admin.query<{ id: string }>(
      `INSERT INTO code_decisions (project_id, decision_type, description, source, still_valid,
         retracted_at, timestamp)
       VALUES ($1,'architecture','RETRACTED risk reasoning row','user-approved',true, now(), now())
       RETURNING id`, [riskId]);
    await admin.query(
      `INSERT INTO memory_edges (project_id, from_kind, from_id, to_kind, to_id, relation)
       VALUES ($1,'decision',$2,'graph_node',$3,'implemented_by')`,
      [riskId, retracted.rows[0].id, nodes.get('invalidReasoned')]);
    const retired = await admin.query<{ id: string }>(
      `INSERT INTO lessons (project_id, rule, confidence_score, reinforcement_count, tags, retired_at)
       VALUES ($1,'RETIRED risk lesson',0.9,1,'{}', now()) RETURNING id`, [riskId]);
    await admin.query(
      `INSERT INTO memory_edges (project_id, from_kind, from_id, to_kind, to_id, relation)
       VALUES ($1,'lesson',$2,'graph_node',$3,'implemented_by')`,
      [riskId, retired.rows[0].id, nodes.get('invalidReasoned')]);
  });

  afterAll(async () => {
    await admin.query(`DELETE FROM projects WHERE slug = 'risk-test'`);
  });

  it('returns LOW with SUFFICIENT confidence for a small clean neighbourhood', async () => {
    const out = await impact('clean');
    expect(out).toContain('Risk: LOW · assessment confidence: SUFFICIENT');
    expect(out).toContain('Why: no boundary, cap, reasoning or staleness signal');
    expect(out).toContain('## Dependents');
  });

  it('escalates to HIGH on a boundary kind and relation', async () => {
    const out = await impact('boundary');
    expect(out).toContain('Risk: HIGH');
    expect(out).toContain('public boundary affected: table');
    expect(out).toContain('boundary relation traversed: references_table');
  });

  it('escalates to MEDIUM on inferred edge confidence and on valid reasoning', async () => {
    const inferred = await impact('inferred');
    expect(inferred).toContain('Risk: MEDIUM');
    expect(inferred).toContain('non-extracted edge confidence: inferred');
    const reasoned = await impact('reasoned');
    expect(reasoned).toContain('Risk: MEDIUM');
    expect(reasoned).toContain('1 linked decisions/lessons');
    expect(reasoned).toContain('VALID risk reasoning row');    // legacy text preserved
  });

  it('drops retracted decisions and retired lessons from reasoning and from risk', async () => {
    const out = await impact('invalidReasoned');
    expect(out).not.toContain('RETRACTED risk reasoning row');
    expect(out).not.toContain('RETIRED risk lesson');
    expect(out).toContain('None linked yet');
    expect(out).toContain('Risk: LOW');
  });

  it('degrades to LIMITED for a RETURNED stale node and ignores unrelated staleness', async () => {
    const stale = await impact('stale');
    expect(stale).toContain('assessment confidence: LIMITED');
    expect(stale).toContain('a returned code node is stale or unattributed');
    expect(stale).not.toContain('Risk: LOW');

    const unrelated = await impact('unrelatedStale');
    expect(unrelated).toContain('assessment confidence: SUFFICIENT');
    expect(unrelated).toContain('Risk: LOW');
  });

  it('keeps the returned-node freshness disclosure on every impact answer', async () => {
    const out = await impact('clean');
    expect(out).toContain('_Returned-node freshness:');
    expect(out).toContain('code nodes source verified');
  });
});
