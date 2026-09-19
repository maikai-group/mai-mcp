// Shared real-git staleness fixture (plan 46). NOT a .test.ts file — see the
// task prose: a fixture exported from one suite into another would make vitest
// collect the exporter twice. Same non-collected pattern as ./test-db-url.ts.
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import crypto from 'node:crypto';
import os from 'node:os';
import path from 'node:path';
import type { Pool } from 'pg';

export interface StalenessFixture {
  projectId: string;
  repo: string;
}

/**
 * Two files stamped at commit A, one of them changed by commit B (= HEAD).
 * The honest per-file answer is stale 1 / total 2 — a PARTIAL count, so two
 * producers that agree on 0 or agree on N still fail the agreement gate.
 * Callers own cleanup: DELETE FROM projects WHERE id = projectId (graph_nodes
 * cascade) and fs.rmSync(repo) in their finally/afterAll.
 */
export async function seedTwoFileRepoWithOneChange(pool: Pool): Promise<StalenessFixture> {
  const repo = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'mai-staleness-')));
  const git = (...args: string[]): string =>
    execFileSync('git', ['-C', repo, '-c', 'user.email=t@t', '-c', 'user.name=t', ...args], {
      encoding: 'utf8',
    }).trim();
  git('init', '-q');
  fs.writeFileSync(path.join(repo, 'a.ts'), 'export const a = 1;\n');
  fs.writeFileSync(path.join(repo, 'b.ts'), 'export const b = 1;\n');
  git('add', 'a.ts', 'b.ts');
  git('commit', '-qm', 'base');
  const shaA = git('rev-parse', 'HEAD');

  const inserted = await pool.query<{ id: string }>(
    `INSERT INTO projects (slug, name, path, metadata)
     VALUES ('staleness-fixture-' || substr(md5(random()::text), 1, 8), 'Staleness Fixture', $1,
             jsonb_build_object('repos', jsonb_build_array($1::text)))
     RETURNING id`,
    [repo],
  );
  const projectId = inserted.rows[0].id;
  for (const rel of ['a.ts', 'b.ts']) {
    await pool.query(
      `INSERT INTO graph_nodes (project_id, kind, name, qualified_name, file_path, extracted_by, commit_sha, content_hash)
       VALUES ($1, 'file', $2, 'service-source:staleness-fixture:file:' || $2, $3, 'ts', $4, $5)`,
      [projectId, rel, path.join(repo, rel), shaA, crypto.createHash('sha256').update(fs.readFileSync(path.join(repo, rel), 'utf8')).digest('hex')],
    );
  }

  fs.appendFileSync(path.join(repo, 'a.ts'), 'export const a2 = 2;\n');
  git('add', 'a.ts');
  git('commit', '-qm', 'change a');
  return { projectId, repo };
}
