import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { Pool } from 'pg';
import { afterAll, expect, it } from 'vitest';
import { requireDisposableTestDbUrl } from './test-db-url.js';

const pool = new Pool({ connectionString: requireDisposableTestDbUrl() });
const migration = await readFile(new URL('../../db/migrations/2026-09-08-semantic-code-search.sql', import.meta.url), 'utf8');
afterAll(() => pool.end());

it('replays the semantic migration after the current fresh-install schema', async () => {
  // The disposable wrapper has already installed db/schema.sql, as setup does.
  const client = await pool.connect();
  try {
    for (let attempt = 0; attempt < 2; attempt++) await client.query(migration);
    const tables = await client.query<{ name: string }>(`
      SELECT tablename AS name FROM pg_tables WHERE schemaname = 'public'
      AND tablename IN ('graph_code_policy', 'graph_code_embeddings', 'graph_code_jobs')
      ORDER BY tablename
    `);
    expect(tables.rows.map(row => row.name)).toEqual(['graph_code_embeddings', 'graph_code_jobs', 'graph_code_policy']);
  } finally {
    await client.query('ROLLBACK');
    client.release();
  }
});

it('upgrades a baseline, then preserves data, indexes and constraints on replay', async () => {
  const client = await pool.connect();
  const schema = `semantic_migration_${randomUUID().replaceAll('-', '')}`;
  const projectId = randomUUID();
  try {
    await client.query(`CREATE SCHEMA "${schema}"`);
    await client.query("SELECT set_config('search_path', $1, false)", [schema]);
    await client.query('CREATE TABLE projects (id uuid PRIMARY KEY)');
    await client.query('INSERT INTO projects VALUES ($1)', [projectId]);
    await client.query(migration);
    await client.query("INSERT INTO graph_code_policy(project_id, provider) VALUES ($1, 'off')", [projectId]);
    await client.query(`INSERT INTO graph_code_embeddings
      (project_id, identity, model, document_version, fingerprint, document_mode, embedding)
      VALUES ($1, $2, 'test-model', 'code-symbol/1', $2, 'metadata', $3)`,
    [projectId, 'a'.repeat(64), Array.from({ length: 384 }, () => 1)]);
    const job = await client.query<{ id: string }>(`INSERT INTO graph_code_jobs
      (project_id, policy_revision, model, state) VALUES ($1, 1, 'test-model', 'running') RETURNING id`, [projectId]);
    for (let attempt = 0; attempt < 2; attempt++) await client.query(migration);
    expect((await client.query('SELECT provider FROM graph_code_policy')).rows).toEqual([{ provider: 'off' }]);
    expect((await client.query('SELECT cardinality(embedding) AS dimensions FROM graph_code_embeddings')).rows).toEqual([{ dimensions: 384 }]);
    expect((await client.query('SELECT id, state FROM graph_code_jobs')).rows).toEqual([{ id: job.rows[0].id, state: 'running' }]);
    const indexes = await client.query<{ name: string }>(`
      SELECT indexname AS name FROM pg_indexes WHERE schemaname = $1
      AND indexname IN ('graph_code_jobs_running', 'graph_code_jobs_recent') ORDER BY indexname
    `, [schema]);
    expect(indexes.rows.map(row => row.name)).toEqual(['graph_code_jobs_recent', 'graph_code_jobs_running']);
    await expect(client.query(`INSERT INTO graph_code_jobs
      (project_id, policy_revision, model, state) VALUES ($1, 1, 'test-model', 'running')`, [projectId])).rejects.toMatchObject({ code: '23505' });
    await expect(client.query("UPDATE graph_code_policy SET provider = 'openai' WHERE project_id = $1", [projectId])).rejects.toMatchObject({ code: '23514' });
    await expect(client.query('UPDATE graph_code_embeddings SET embedding = ARRAY[1.0]')).rejects.toMatchObject({ code: '23514' });
    await client.query('DELETE FROM projects WHERE id = $1', [projectId]);
    for (const table of ['graph_code_policy', 'graph_code_embeddings', 'graph_code_jobs']) {
      expect((await client.query(`SELECT count(*)::int AS count FROM ${table}`)).rows).toEqual([{ count: 0 }]);
    }
  } finally {
    await client.query('ROLLBACK');
    await client.query('RESET search_path');
    await client.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
    client.release();
  }
});
