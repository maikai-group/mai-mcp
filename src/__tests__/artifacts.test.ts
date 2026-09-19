/** run_artifacts content-addressed immutable store (conductor-machine-contract/2,
 * plan ea1965f1 Task 3). Disposable DB; same suite conventions as receipts.test.ts.
 * Foreign-project fixtures go through the admin pool, never by re-pinning
 * artifactPut — in-process re-pinning is impossible (module-load PROJECT_SLUG
 * const; the 906c496f rule). */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Pool } from 'pg';
import { requireDisposableTestDbUrl } from './test-db-url.js';

const saved: Record<string, string | undefined> = {
  MAI_PROJECT_SLUG: process.env.MAI_PROJECT_SLUG,
  MAI_DB_URL: process.env.MAI_DB_URL,
  MAI_AGENT_ID: process.env.MAI_AGENT_ID,
};
process.env.MAI_PROJECT_SLUG = 'artifacts-test';
process.env.MAI_DB_URL = requireDisposableTestDbUrl();
process.env.MAI_AGENT_ID = 'artifacts-tester@vitest';

const admin = new Pool({ connectionString: process.env.MAI_DB_URL });
let root: string;
let projectId: string;
let projectBId: string;

beforeAll(async () => {
  await import('../db.js'); // dotenv defusal before app imports
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'artifacts-'));
  await admin.query(`DELETE FROM projects WHERE slug IN ('artifacts-test','artifacts-test-b')`);
  const { rows: a } = await admin.query<{ id: string }>(
    `INSERT INTO projects (slug, name, path) VALUES ('artifacts-test','Artifacts Test',$1) RETURNING id`,
    [path.join(root, 'a')]);
  projectId = a[0].id;
  const { rows: b } = await admin.query<{ id: string }>(
    `INSERT INTO projects (slug, name, path) VALUES ('artifacts-test-b','Artifacts Test B',$1) RETURNING id`,
    [path.join(root, 'b')]);
  projectBId = b[0].id;
});

afterAll(async () => {
  await admin.query(`DELETE FROM projects WHERE slug IN ('artifacts-test','artifacts-test-b')`);
  await admin.end();
  const { getPool } = await import('../db.js');
  await getPool().end();
  for (const [k, v] of Object.entries(saved)) {
    if (v === undefined) delete process.env[k]; else process.env[k] = v;
  }
  fs.rmSync(root, { recursive: true, force: true });
});

beforeEach(async () => {
  const { __resetProjectIdCacheForTests } = await import('../db.js');
  __resetProjectIdCacheForTests();
  await admin.query('DELETE FROM run_artifacts WHERE project_id IN ($1, $2)', [projectId, projectBId]);
});

describe('run_artifacts store', () => {
  it('put returns duplicate false with the exact sha256 and byteLength', async () => {
    const { artifactPut } = await import('../artifacts.js');
    const content = 'frozen plan bytes\n';
    const expectedSha = createHash('sha256').update(Buffer.from(content, 'utf8')).digest('hex');
    const result = await artifactPut({ kind: 'frozen_plan', content });
    expect(result.ok).toBe(true);
    expect(result.duplicate).toBe(false);
    expect(result.sha256).toBe(expectedSha);
    expect(result.byteLength).toBe(Buffer.byteLength(content, 'utf8'));
  });

  it('identical re-put returns duplicate true with the same id and row count 1', async () => {
    const { artifactPut } = await import('../artifacts.js');
    const content = 'same bytes twice';
    const first = await artifactPut({ kind: 'frozen_plan', content });
    const second = await artifactPut({ kind: 'frozen_plan', content });
    expect(second.duplicate).toBe(true);
    expect(second.id).toBe(first.id);
    const { rows } = await admin.query<{ n: string }>(
      'SELECT count(*) AS n FROM run_artifacts WHERE sha256 = $1 AND project_id = $2',
      [first.sha256, projectId]);
    expect(Number(rows[0].n)).toBe(1);
  });

  it('get round-trips multi-byte UTF-8 content exactly', async () => {
    const { artifactPut, artifactGet } = await import('../artifacts.js');
    const content = 'delta review 🎛 evidence\r\nline two — naïve café\n';
    const put = await artifactPut({ kind: 'delta_evidence', content });
    const got = await artifactGet({ sha256: put.sha256 });
    expect(got.content).toBe(content);
    expect(got.kind).toBe('delta_evidence');
    expect(got.sha256).toBe(put.sha256);
    expect(got.byteLength).toBe(Buffer.byteLength(content, 'utf8'));
  });

  it('unknown parameters are rejected naming the key; no mode selector or destructive path exists (40fb864e)', async () => {
    const { artifactPut, ArtifactValidationError } = await import('../artifacts.js');
    await expect(artifactPut({ op: 'put', kind: 'frozen_plan', content: 'x' }))
      .rejects.toThrow('unknown parameter: op');
    await expect(artifactPut({ op: 'release', sha256: 'a'.repeat(64) }))
      .rejects.toBeInstanceOf(ArtifactValidationError);
    await expect(artifactPut({ op: 'release', sha256: 'a'.repeat(64) }))
      .rejects.toThrow('unknown parameter: op');
  });

  it('bad kind, empty content, oversized content, and unknown sha256 on get all fail typed', async () => {
    const { artifactPut, artifactGet, ArtifactValidationError, ArtifactNotFoundError } = await import('../artifacts.js');
    await expect(artifactPut({ kind: 'Bad-Kind', content: 'x' }))
      .rejects.toBeInstanceOf(ArtifactValidationError);
    await expect(artifactPut({ kind: 'frozen_plan', content: '' }))
      .rejects.toBeInstanceOf(ArtifactValidationError);
    await expect(artifactPut({ kind: 'frozen_plan', content: 'x'.repeat(4 * 1024 * 1024 + 1) }))
      .rejects.toBeInstanceOf(ArtifactValidationError);
    await expect(artifactGet({ sha256: 'f'.repeat(64) }))
      .rejects.toBeInstanceOf(ArtifactNotFoundError);
  });

  it('two projects hold the same sha256 independently (project scoping)', async () => {
    const { artifactPut, artifactGet } = await import('../artifacts.js');
    const content = 'shared bytes across projects';
    const bytes = Buffer.from(content, 'utf8');
    const sha = createHash('sha256').update(bytes).digest('hex');
    const local = await artifactPut({ kind: 'frozen_plan', content });
    expect(local.sha256).toBe(sha);
    await admin.query(
      `INSERT INTO run_artifacts
         (project_id, kind, sha256, byte_length, content, created_by_agent, created_by_session)
       VALUES ($1,'frozen_plan',$2,$3,$4,'admin@test','admin-session')`,
      [projectBId, sha, bytes.byteLength, bytes]);
    const { rows } = await admin.query<{ n: string }>(
      'SELECT count(*) AS n FROM run_artifacts WHERE sha256 = $1', [sha]);
    expect(Number(rows[0].n)).toBe(2);
    const got = await artifactGet({ sha256: sha });
    expect(got.content).toBe(content);
  });

  it('immutability probe: no release/delete surface exists and content survives 1000 unrelated inserts', async () => {
    const artifacts = await import('../artifacts.js');
    const exported = Object.keys(artifacts);
    for (const name of exported) {
      expect(name.toLowerCase()).not.toContain('release');
      expect(name.toLowerCase()).not.toContain('delete');
    }
    const { artifactPut, artifactGet } = artifacts;
    const content = 'the original artifact must survive';
    const put = await artifactPut({ kind: 'frozen_plan', content });
    for (let i = 0; i < 1000; i++) {
      const filler = Buffer.from(`unrelated artifact ${i}`, 'utf8');
      const fillerSha = createHash('sha256').update(filler).digest('hex');
      await admin.query(
        `INSERT INTO run_artifacts
           (project_id, kind, sha256, byte_length, content, created_by_agent, created_by_session)
         VALUES ($1,'filler',$2,$3,$4,'admin@test','admin-session')`,
        [projectId, fillerSha, filler.byteLength, filler]);
    }
    const got = await artifactGet({ sha256: put.sha256 });
    expect(got.content).toBe(content);
  });
});
