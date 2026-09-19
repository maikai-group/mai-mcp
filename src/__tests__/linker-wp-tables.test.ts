/** wp_table→table prefix linker — DB-backed, run via scripts/run-with-disposable-db.sh. */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { getPool, closePool } from '../db.js';
import { linkWpTablesToSchema } from '../graph/linker.js';
import { requireDisposableTestDbUrl } from './test-db-url.js';

// The shared helper, not an inline re-check: it also refuses non-disposable
// database names and non-local hosts — guards an inline copy silently drops.
requireDisposableTestDbUrl();

let projectId = '';
let customProjectId = '';

async function insertNode(project: string, kind: string, name: string, qn: string): Promise<void> {
  await getPool().query(
    `INSERT INTO graph_nodes (project_id, kind, name, qualified_name, extracted_by)
     VALUES ($1, $2, $3, $4, $5)`,
    [project, kind, name, qn, kind === 'table' ? 'db' : 'php']
  );
}

beforeAll(async () => {
  const p1 = await getPool().query<{ id: string }>(
    `INSERT INTO projects (slug, name, path) VALUES ('plan34-linker-a', 'plan34-linker-a', '/tmp/plan34-a') RETURNING id`
  );
  projectId = p1.rows[0].id;
  const p2 = await getPool().query<{ id: string }>(
    `INSERT INTO projects (slug, name, path, metadata)
     VALUES ('plan34-linker-b', 'plan34-linker-b', '/tmp/plan34-b', '{"wp_table_prefix": "acme_"}'::jsonb) RETURNING id`
  );
  customProjectId = p2.rows[0].id;

  // Default-prefix project: one matching pair, one wrong-prefix decoy, one
  // suffix with no physical table at all.
  await insertNode(projectId, 'wp_table', 'acme_tips', 'wptable:acme_tips');
  await insertNode(projectId, 'wp_table', 'acme_orphan', 'wptable:acme_orphan');
  await insertNode(projectId, 'table', 'wp_acme_tips', 'acmewp.wp_acme_tips');
  await insertNode(projectId, 'table', 'wpx_acme_tips', 'acmewp.wpx_acme_tips');

  // Custom-prefix project: matches only under 'acme_'.
  await insertNode(customProjectId, 'wp_table', 'tips', 'wptable:tips');
  await insertNode(customProjectId, 'table', 'acme_tips', 'acmewp.acme_tips');
  await insertNode(customProjectId, 'table', 'wp_tips', 'acmewp.wp_tips');
});

afterAll(async () => {
  await getPool().query(`DELETE FROM projects WHERE slug IN ('plan34-linker-a', 'plan34-linker-b')`);
  await closePool();
});

describe('wp_table→table linker', () => {
  it('links on default wp_ prefix, ignores wrong-prefix and orphan suffixes', async () => {
    const n = await linkWpTablesToSchema(projectId);
    expect(n).toBe(1);
    const edges = await getPool().query(
      `SELECT f.qualified_name AS from_qn, t.qualified_name AS to_qn, e.relation, e.confidence
       FROM graph_edges e
       JOIN graph_nodes f ON f.id = e.from_node
       JOIN graph_nodes t ON t.id = e.to_node
       WHERE e.project_id = $1`,
      [projectId]
    );
    expect(edges.rows).toHaveLength(1);
    expect(edges.rows[0]).toMatchObject({
      from_qn: 'wptable:acme_tips',
      to_qn: 'acmewp.wp_acme_tips',
      relation: 'references_table',
      confidence: 'inferred',
    });
  });

  it('is idempotent — a second run inserts nothing', async () => {
    expect(await linkWpTablesToSchema(projectId)).toBe(0);
  });

  it('honors a custom wp_table_prefix from project metadata', async () => {
    const n = await linkWpTablesToSchema(customProjectId);
    expect(n).toBe(1);
    const edge = await getPool().query(
      `SELECT t.qualified_name AS to_qn FROM graph_edges e
       JOIN graph_nodes t ON t.id = e.to_node WHERE e.project_id = $1`,
      [customProjectId]
    );
    expect(edge.rows[0].to_qn).toBe('acmewp.acme_tips'); // acme_ prefix, NOT wp_
  });
});
