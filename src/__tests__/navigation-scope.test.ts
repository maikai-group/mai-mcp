import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Pool } from 'pg';
import { requireDisposableTestDbUrl } from './test-db-url.js';
import { withDatabasePool } from '../db.js';
import { createPorts } from '../navigation/retrieval.js';
const pool = new Pool({ connectionString: requireDisposableTestDbUrl() });
const a = '00000000-0000-4000-8000-00000000a001';
const b = '00000000-0000-4000-8000-00000000b001';
const na = '00000000-0000-4000-8000-00000000a002';
const nb = '00000000-0000-4000-8000-00000000b002';
beforeAll(async () => {
  await pool.query(`INSERT INTO projects(id,slug,name,path,metadata)
    VALUES($1,$2,$2,$5,jsonb_build_object('repos',jsonb_build_array($5::text))),
          ($3,$4,$4,$5,jsonb_build_object('repos',jsonb_build_array($5::text)))`,
    [a, 'navigation-scope-a', b, 'navigation-scope-b', process.cwd()]);
  await pool.query(`INSERT INTO graph_nodes(id,project_id,kind,name,qualified_name,extracted_by)
    VALUES($1,$2,'table','local','public.local','navigation-test'),
          ($3,$4,'table','FOREIGN_SECRET','public.foreign','navigation-test')`, [na,a,nb,b]);
  await pool.query(`INSERT INTO graph_edges(project_id,from_node,to_node,relation)
    VALUES($1,$2,$3,'calls')`, [a,na,nb]);
});
afterAll(async () => {
  try { await pool.query('DELETE FROM projects WHERE id=ANY($1::uuid[])', [[a,b]]); }
  finally { await pool.end(); }
});
describe('navigation scope against actual storage', () => {
  it('rejects a foreign explicit seed', async () => {
    const result = await withDatabasePool(pool, () => createPorts(a).seed(nb));
    expect(result.evidence).toEqual([]);
    expect(JSON.stringify(result)).not.toContain('FOREIGN_SECRET');
  });
  it('rejects cross-project edge endpoints', async () => {
    const result = await withDatabasePool(pool, () => createPorts(a).expand(na));
    expect(result.evidence.some(item => item.nodeId === na)).toBe(true);
    expect(JSON.stringify(result)).not.toContain('FOREIGN_SECRET');
    expect(result.evidence.some(item => item.nodeId === nb)).toBe(false);
  });
});
