/**
 * THE isolation guarantee (spec §3): a server pinned to project A can never
 * read or write project B rows. These tests seed two projects directly via SQL,
 * pin the process to one, and assert every read path returns only pinned(+global) data.
 *
 * Requires: docker compose up -d && npm run db:init. Uses throwaway slugs;
 * cleans up after itself.
 */
import { beforeAll, afterAll, describe, expect, it } from 'vitest';
import { Pool } from 'pg';
import { requireDisposableTestDbUrl } from './test-db-url.js';

const savedIsoEnv = { MAI_PROJECT_SLUG: process.env.MAI_PROJECT_SLUG, MAI_DB_URL: process.env.MAI_DB_URL };
process.env.MAI_PROJECT_SLUG = 'iso-test-a';
// The dedicated MAI_TEST_DB_URL is the authority, never an inherited
// MAI_DB_URL (pass-6 B5): this suite's cleanup DELETEs fixture rows. The
// validated database name must start `mai_plan23_` and can never be
// `mai_brain`; the host must be local.
process.env.MAI_DB_URL = requireDisposableTestDbUrl();

const admin = new Pool({ connectionString: process.env.MAI_DB_URL });
let projectA = '';
let projectB = '';
let decisionB = '';
let lessonB = '';
let lessonGlobal = '';
let graphNodeB = '';
let findingB = '';

beforeAll(async () => {
  await cleanup();
  const a = await admin.query<{ id: string }>(
    `INSERT INTO projects (slug, name) VALUES ('iso-test-a','Iso A') RETURNING id`);
  const b = await admin.query<{ id: string }>(
    `INSERT INTO projects (slug, name) VALUES ('iso-test-b','Iso B') RETURNING id`);
  projectA = a.rows[0].id;
  projectB = b.rows[0].id;
  const db = await admin.query<{ id: string }>(
    `INSERT INTO code_decisions (project_id, decision_type, description, keywords, source)
     VALUES ($1,'architecture','SECRET-B decision about widget saving', '{widget,save}', 'user-approved')
     RETURNING id`, [projectB]);
  decisionB = db.rows[0].id;
  const lb = await admin.query<{ id: string }>(
    `INSERT INTO lessons (project_id, rule) VALUES ($1,'SECRET-B lesson: always frobnicate') RETURNING id`,
    [projectB]);
  lessonB = lb.rows[0].id;
  const lg = await admin.query<{ id: string }>(
    `INSERT INTO lessons (project_id, rule) VALUES (NULL,'GLOBAL lesson: pin npm versions') RETURNING id`);
  lessonGlobal = lg.rows[0].id;
  await admin.query(
    `INSERT INTO code_decisions (project_id, decision_type, description, keywords, source)
     VALUES ($1,'architecture','Project-A decision about widget saving', '{widget,save}', 'user-approved')`,
    [projectA]);
  await admin.query(`INSERT INTO lessons (project_id, rule) VALUES ($1,'Project-A lesson about saving')`, [projectA]);
  const gb = await admin.query<{ id: string }>(
    `INSERT INTO graph_nodes (project_id, kind, name, qualified_name, file_path, extracted_by)
     VALUES ($1, 'file', 'secret-b-widget.ts', 'secret-b/src/secret-b-widget.ts', '/tmp/secret-b/src/secret-b-widget.ts', 'ts')
     RETURNING id`,
    [projectB]
  );
  graphNodeB = gb.rows[0].id;
  await admin.query(
    `INSERT INTO graph_nodes (project_id, kind, name, qualified_name, extracted_by)
     VALUES ($1, 'file', 'project-a-widget.ts', 'project-a/src/project-a-widget.ts', 'ts')`,
    [projectA]
  );
  const pb = await admin.query<{ id: string }>(
    `INSERT INTO plans (project_id, slug, path, title) VALUES ($1,'secret-plan','docs/secret.md','Secret B plan') RETURNING id`,
    [projectB]);
  const rb = await admin.query<{ id: string }>(
    `INSERT INTO plan_reviews (plan_id, pass, kind, reviewer_agent, verdict, synthesis) VALUES ($1,1,'author','iso-test','blocked','s') RETURNING id`,
    [pb.rows[0].id]); // synthesis NOT NULL (pass-4 B2)
  const fb = await admin.query<{ id: string }>(
    `INSERT INTO plan_findings (review_id, plan_id, project_id, severity, title, location, issue, evidence, fix)
     VALUES ($1,$2,$3,'blocker','SECRET-B finding: frobnicate the widget','l','i','e','f') RETURNING id`,
    [rb.rows[0].id, pb.rows[0].id, projectB]);
  findingB = fb.rows[0].id;
});

async function cleanup() {
  await admin.query(`DELETE FROM lessons WHERE rule LIKE 'SECRET-B%' OR rule LIKE 'Project-A%' OR rule LIKE 'GLOBAL lesson:%'`);
  await admin.query(`DELETE FROM projects WHERE slug IN ('iso-test-a','iso-test-b')`); // cascades decisions/edges/tokens
}

afterAll(async () => {
  for (const [k, v] of Object.entries(savedIsoEnv)) {
    if (v === undefined) delete process.env[k]; else process.env[k] = v;
  }
  await cleanup();
  await admin.end();
  const { getPool } = await import('../db.js');
  await getPool().end();
});

describe('project isolation (pinned to iso-test-a)', () => {
  it('unifiedSearch never returns project B decisions or lessons', async () => {
    const { unifiedSearch } = await import('../decisions.js');
    const out = await unifiedSearch({ query: 'widget saving frobnicate', kind: 'all', limit: 50 });
    expect(out).not.toContain('SECRET-B');
    expect(out).toContain('Project-A');
  });

  it('global lessons ARE visible from project A', async () => {
    const { lessonSearch } = await import('../lessons.js');
    const out = await lessonSearch({ query: 'pin npm versions', limit: 50 });
    expect(out).toContain('GLOBAL lesson');
    // Search output must surface a full, citable UUID (else extends/supersedes is impossible).
    expect(out).toMatch(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/);
  });

  it('keyword search never returns project B decisions', async () => {
    const { decisionsByKeywords } = await import('../decisions.js');
    const out = await decisionsByKeywords({ keywords: ['widget', 'save'], limit: 50 });
    expect(out).not.toContain('SECRET-B');
    // Citable full UUID present in decision search output too.
    expect(out).toMatch(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/);
  });

  it('timeline and recall contain no project B content', async () => {
    const { timeline, projectRecall } = await import('../decisions.js');
    expect(await timeline(365, 200)).not.toContain('SECRET-B');
    expect(await projectRecall()).not.toContain('SECRET-B');
  });

  it('edges cannot link to project B rows invisibly: edgesOf scoped to A', async () => {
    const { edgesOf } = await import('../edges.js');
    const out = await edgesOf({ kind: 'decision', id: decisionB });
    expect(out).toContain('No edges');
  });

  it('reviewQueue and dailyReport exclude project B', async () => {
    const { reviewQueue, dailyReport } = await import('../decisions.js');
    expect(await reviewQueue(100)).not.toContain('SECRET-B');
    expect(await dailyReport(365)).not.toContain('SECRET-B');
  });

  it('globalize refuses a lesson belonging to another project', async () => {
    const { lessonGlobalize } = await import('../lessons.js');
    const out = await lessonGlobalize(lessonB, 'attempting cross-project globalize must fail');
    expect(out).toContain('different project');
    const check = await admin.query(`SELECT project_id FROM lessons WHERE id = $1`, [lessonB]);
    expect(check.rows[0].project_id).toBe(projectB);
  });

  it('graphFind never returns another project graph nodes', async () => {
    const { graphFind } = await import('../graph/query.js');
    const out = await graphFind({ query: 'widget' });
    expect(out).not.toContain('secret-b/src/');
    expect(out).toContain('project-a/src/');
  });

  it('graphNeighbors refuses a node id from another project', async () => {
    const { graphNeighbors } = await import('../graph/query.js');
    const out = await graphNeighbors({ nodeId: graphNodeB });
    expect(out).toContain('not found in this project');
  });

  it('graphTrace and graphImpact refuse node ids from another project', async () => {
    const { graphTrace, graphImpact } = await import('../graph/query.js');
    const t = await graphTrace({ fromId: graphNodeB, toId: graphNodeB });
    expect(t).toContain('not found in this project');
    const i = await graphImpact({ nodeId: graphNodeB });
    expect(i).toContain('not found in this project');
  });

  it('findings layer: project B findings are invisible and untouchable from A', async () => {
    const prev = process.env.MAI_EMBEDDINGS;
    process.env.MAI_EMBEDDINGS = '0'; // trigram path — this file injects no fake embedder, and the standing suite must never load a model
    try {
      const { findingsQuery, findingUpdate } = await import('../plans.js');
      const out = await findingsQuery({ similar_to: 'SECRET-B finding frobnicate widget' });
      expect(out).not.toContain('SECRET-B');
      await expect(findingUpdate({ finding_id: findingB, status: 'fixed', note: 'cross-project attempt' }))
        .rejects.toThrow(/No finding/);
    } finally {
      if (prev === undefined) delete process.env.MAI_EMBEDDINGS; else process.env.MAI_EMBEDDINGS = prev;
    }
  });

  it('a declared link WITHOUT grants leaks nothing (plan 31 two-key control)', async () => {
    const prev = process.env.MAI_LINKED_PROJECTS;
    const { __resetLinkedProjectsForTests } = await import('../shares.js');
    process.env.MAI_LINKED_PROJECTS = 'iso-test-b';
    __resetLinkedProjectsForTests();
    try {
      const { unifiedSearch } = await import('../decisions.js');
      const out = await unifiedSearch({ query: 'widget saving frobnicate', kind: 'all', limit: 50 });
      expect(out).not.toContain('SECRET-B');
    } finally {
      if (prev === undefined) delete process.env.MAI_LINKED_PROJECTS; else process.env.MAI_LINKED_PROJECTS = prev;
      __resetLinkedProjectsForTests();
    }
  });
});
