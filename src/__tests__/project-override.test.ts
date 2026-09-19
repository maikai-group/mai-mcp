/**
 * Surfaces project-override (Plan 3 R1): read/curation functions accept an
 * explicit projectId; with none, they stay pinned. The MCP tool layer never
 * passes the override (tool schemas are slug-free) — this proves the surfaces
 * path works AND the no-arg default is unchanged (the pinning regression).
 *
 * Requires: docker compose up -d && npm run db:init.
 */
import { beforeAll, afterAll, describe, expect, it } from 'vitest';
import { Pool } from 'pg';

process.env.MAI_PROJECT_SLUG = 'ovr-a';
process.env.MAI_DB_URL =
  process.env.MAI_DB_URL ?? 'postgresql://postgres:postgres@127.0.0.1:54334/mai_brain';

const admin = new Pool({ connectionString: process.env.MAI_DB_URL });
let projectB = '';
let retractTargetB = '';

async function cleanup() {
  await admin.query(`DELETE FROM projects WHERE slug IN ('ovr-a','ovr-b')`); // cascades decisions
}

beforeAll(async () => {
  await cleanup();
  const a = await admin.query<{ id: string }>(
    `INSERT INTO projects (slug, name) VALUES ('ovr-a','Override A') RETURNING id`);
  const b = await admin.query<{ id: string }>(
    `INSERT INTO projects (slug, name) VALUES ('ovr-b','Override B') RETURNING id`);
  projectB = b.rows[0].id;
  await admin.query(
    `INSERT INTO code_decisions (project_id, decision_type, description, keywords, source)
     VALUES ($1,'architecture','OVRA decision about the caching layer','{cache}','user-approved')`,
    [a.rows[0].id]);
  await admin.query(
    `INSERT INTO code_decisions (project_id, decision_type, description, keywords, source)
     VALUES ($1,'architecture','OVRB decision about the caching layer','{cache}','user-approved')`,
    [projectB]);
  const rt = await admin.query<{ id: string }>(
    `INSERT INTO code_decisions (project_id, decision_type, description, keywords, source)
     VALUES ($1,'architecture','OVRB retract target decision','{retract}','user-approved')
     RETURNING id`, [projectB]);
  retractTargetB = rt.rows[0].id;
});

afterAll(async () => {
  await cleanup();
  await admin.end();
  const { getPool } = await import('../db.js');
  await getPool().end();
});

describe('project override (pinned ovr-a)', () => {
  it('no override → only the pinned project (ovr-a)', async () => {
    const { unifiedSearch } = await import('../decisions.js');
    const out = await unifiedSearch({ query: 'caching layer', kind: 'all', limit: 50 });
    expect(out).toContain('OVRA');
    expect(out).not.toContain('OVRB');
  });

  it('explicit projectId override → the other project (ovr-b)', async () => {
    const { unifiedSearch } = await import('../decisions.js');
    const out = await unifiedSearch({ query: 'caching layer', kind: 'all', limit: 50, projectId: projectB });
    expect(out).toContain('OVRB');
    expect(out).not.toContain('OVRA');
  });

  it('decisionRetract honors the override (retracts the ovr-b row)', async () => {
    const { decisionRetract } = await import('../decisions.js');
    const out = await decisionRetract({ decisionId: retractTargetB, reason: 'override retract test', projectId: projectB });
    expect(out).toContain('Retracted decision');
    const check = await admin.query(`SELECT still_valid FROM code_decisions WHERE id = $1`, [retractTargetB]);
    expect(check.rows[0].still_valid).toBe(false);
  });
});
