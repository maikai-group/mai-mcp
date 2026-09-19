import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { Pool } from 'pg';
import { createReviewPostHandlers, ReviewClientError } from '../web-review-handlers.js';

const DB = process.env.MAI_DB_URL ?? 'postgresql://postgres:postgres@127.0.0.1:54334/mai_brain';
const admin = new Pool({ connectionString: DB });
let projectId = '';
let otherId = '';
const url = new URL('http://127.0.0.1/api/test?project=plan22-http');

const handlers = createReviewPostHandlers(async () => projectId);
const call = (path: string, body: Record<string, unknown>) => {
  const handler = handlers[path];
  if (!handler) throw new Error(`missing handler ${path}`);
  return handler(body, url);
};
const seedDecision = async (project: string, description: string) =>
  (await admin.query<{ id: string }>(
    `INSERT INTO code_decisions(project_id,decision_type,description)
     VALUES ($1,'arch',$2) RETURNING id`, [project, description])).rows[0].id;

beforeAll(async () => {
  await admin.query(`DELETE FROM projects WHERE slug IN ('plan22-http','plan22-http-other')`);
  projectId = (await admin.query<{ id: string }>(
    `INSERT INTO projects(slug,name) VALUES ('plan22-http','HTTP') RETURNING id`)).rows[0].id;
  otherId = (await admin.query<{ id: string }>(
    `INSERT INTO projects(slug,name) VALUES ('plan22-http-other','HTTP Other') RETURNING id`)).rows[0].id;
});
beforeEach(async () => {
  await admin.query(`DELETE FROM memory_citations WHERE project_id=ANY($1::uuid[])`, [[projectId, otherId]]);
  await admin.query(`DELETE FROM curation_candidates WHERE project_id=ANY($1::uuid[])`, [[projectId, otherId]]);
  await admin.query(`DELETE FROM code_decisions WHERE project_id=ANY($1::uuid[])`, [[projectId, otherId]]);
});
afterAll(async () => {
  await admin.query(`DELETE FROM projects WHERE id=ANY($1::uuid[])`, [[projectId, otherId]]);
  await admin.end();
  const { getPool } = await import('../db.js');
  await getPool().end();
});

describe('import-safe review POST handlers', () => {
  it('keep, retire and unretire map to their exact curation effects', async () => {
    const kept = await seedDecision(projectId, 'keep target');
    await call('/api/curation/keep', {
      target_kind: 'decision', target_id: kept, basis: 'never-surfaced', note: 'needed',
    });
    expect((await admin.query(
      `SELECT id FROM curation_candidates WHERE target_id=$1 AND status='kept'`, [kept])).rows
    ).toHaveLength(1);
    const retired = await seedDecision(projectId, 'retire target');
    await call('/api/curation/retire', {
      target_kind: 'decision', target_id: retired, reason: 'operator reason',
    });
    expect((await admin.query<{ still_valid: boolean }>(
      `SELECT still_valid FROM code_decisions WHERE id=$1`, [retired])).rows[0].still_valid).toBe(false);
    await call('/api/curation/unretire', { target_kind: 'decision', target_id: retired });
    expect((await admin.query<{ still_valid: boolean }>(
      `SELECT still_valid FROM code_decisions WHERE id=$1`, [retired])).rows[0].still_valid).toBe(true);
  });

  it('apply and dismiss cannot be swapped: apply retires old, dismiss leaves old live', async () => {
    const oldA = await seedDecision(projectId, 'old A');
    const newA = await seedDecision(projectId, 'new A');
    const applyId = (await admin.query<{ id: string }>(
      `INSERT INTO memory_citations
         (project_id,citing_kind,citing_id,cited_kind,cited_id,relation,reason,status)
       VALUES ($1,'decision',$2,'decision',$3,'supersedes','measured','proposed') RETURNING id`,
      [projectId, newA, oldA])).rows[0].id;
    await call('/api/curation/apply', { citation_id: applyId });
    expect((await admin.query<{ still_valid: boolean }>(
      `SELECT still_valid FROM code_decisions WHERE id=$1`, [oldA])).rows[0].still_valid).toBe(false);

    const oldB = await seedDecision(projectId, 'old B');
    const newB = await seedDecision(projectId, 'new B');
    const dismissId = (await admin.query<{ id: string }>(
      `INSERT INTO memory_citations
         (project_id,citing_kind,citing_id,cited_kind,cited_id,relation,reason,status)
       VALUES ($1,'decision',$2,'decision',$3,'supersedes','thought wrong','proposed') RETURNING id`,
      [projectId, newB, oldB])).rows[0].id;
    await call('/api/curation/dismiss', { citation_id: dismissId, note: 'original wins' });
    expect((await admin.query<{ still_valid: boolean }>(
      `SELECT still_valid FROM code_decisions WHERE id=$1`, [oldB])).rows[0].still_valid).toBe(true);
  });

  it('validates payloads and never crosses the factory-resolved project', async () => {
    await expect(call('/api/curation/retire', {
      target_kind: 'fact', target_id: 'x', reason: 'bad',
    })).rejects.toBeInstanceOf(ReviewClientError);
    const foreign = await seedDecision(otherId, 'foreign target');
    await call('/api/curation/retire', {
      target_kind: 'decision', target_id: foreign, reason: 'wrong project',
    });
    expect((await admin.query<{ still_valid: boolean }>(
      `SELECT still_valid FROM code_decisions WHERE id=$1`, [foreign])).rows[0].still_valid).toBe(true);
  });

  it('preserves the three legacy decision routes behaviorally', async () => {
    const id = await seedDecision(projectId, 'legacy route target');
    await call('/api/promote', { decision_id: id, kind: 'decision' });
    expect((await admin.query<{ source: string }>(
      `SELECT source FROM code_decisions WHERE id=$1`, [id])).rows[0].source).toBe('user-approved');
    await call('/api/retract', { decision_id: id, kind: 'decision', reason: 'operator' });
    expect((await admin.query<{ still_valid: boolean }>(
      `SELECT still_valid FROM code_decisions WHERE id=$1`, [id])).rows[0].still_valid).toBe(false);
    await call('/api/unretract', { decision_id: id, kind: 'decision' });
    expect((await admin.query<{ still_valid: boolean }>(
      `SELECT still_valid FROM code_decisions WHERE id=$1`, [id])).rows[0].still_valid).toBe(true);
  });
});
