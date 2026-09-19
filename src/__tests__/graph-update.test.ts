/**
 * mai graph update — schema refresh leg (decision 8c86dbbe): when a dbUrl is
 * present, the db extractor re-introspects the schema; without it, no table
 * nodes appear. Uses the mai_brain DB itself as a live schema to introspect.
 */
import { beforeAll, afterAll, describe, expect, it } from 'vitest';
import { Pool } from 'pg';
import fs from 'node:fs';
import crypto from 'node:crypto';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import type { GraphExtractor } from '../graph/types.js';

const exec = promisify(execFile);

process.env.MAI_PROJECT_SLUG = 'graphupd-test';
process.env.MAI_DB_URL =
  process.env.MAI_DB_URL ?? 'postgresql://postgres:postgres@127.0.0.1:54334/mai_brain';

const admin = new Pool({ connectionString: process.env.MAI_DB_URL });
let withDb = '';
let withoutDb = '';
let repoDir = '';

/** One file node so runGraphUpdate's "graph exists" guard passes; repos point at
 * a real (tiny) git repo so headSha/git-diff succeed and report up-to-date. */
function seed(repoBase: string): GraphExtractor {
  return {
    name: 'seed-u',
    vocabulary: { kinds: ['file'], relations: [] },
    extract: async () => ({
      nodes: [{ kind: 'file', name: 'a.ts', qualifiedName: `${repoBase}/a.ts`, filePath: path.join(repoDir, 'a.ts'), contentHash: crypto.createHash('sha256').update('export const a = 1;').digest('hex') }],
      edges: [],
    }),
  };
}

async function makeProject(slug: string): Promise<string> {
  await admin.query(`DELETE FROM projects WHERE slug = $1`, [slug]);
  const r = await admin.query<{ id: string }>(
    `INSERT INTO projects (slug, name, path, metadata) VALUES ($1, $1, $2, jsonb_build_object('repos', jsonb_build_array($2::text))) RETURNING id`,
    [slug, repoDir]
  );
  return r.rows[0].id;
}

beforeAll(async () => {
  repoDir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'mai-graphupd-')));
  await exec('git', ['-C', repoDir, 'init', '-q']);
  fs.writeFileSync(path.join(repoDir, 'a.ts'), 'export const a = 1;');
  await exec('git', ['-C', repoDir, '-c', 'user.email=t@t', '-c', 'user.name=t', 'add', 'a.ts']);
  await exec('git', ['-C', repoDir, '-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-q', '-m', 'one']);

  withDb = await makeProject('graphupd-test');
  withoutDb = await makeProject('graphupd-test-nodb');
  const { runExtractor } = await import('../graph/engine.js');
  const repoBase = path.basename(repoDir);
  await runExtractor(seed(repoBase), { projectId: withDb, repoPaths: [repoDir] });
  await runExtractor(seed(repoBase), { projectId: withoutDb, repoPaths: [repoDir] });
});

afterAll(async () => {
  await admin.query(`DELETE FROM projects WHERE slug IN ('graphupd-test','graphupd-test-nodb')`);
  fs.rmSync(repoDir, { recursive: true, force: true });
  await admin.end();
  const { getPool } = await import('../db.js');
  await getPool().end();
});

const tableCount = async (projectId: string): Promise<number> => {
  const r = await admin.query<{ c: string }>(
    `SELECT COUNT(*)::text AS c FROM graph_nodes WHERE project_id = $1 AND kind = 'table'`,
    [projectId]
  );
  return Number(r.rows[0].c);
};

describe('runGraphUpdate schema refresh', () => {
  it('introspects the schema when dbUrl is present', async () => {
    const { runGraphUpdate } = await import('../graph/update.js');
    const out = await runGraphUpdate({ projectId: withDb, slug: 'graphupd-test', dbUrl: process.env.MAI_DB_URL });
    expect(out).toMatch(/- db: \d+ nodes/);
    expect(await tableCount(withDb)).toBeGreaterThan(0);
  });

  it('adds no table nodes but reports an explicit skip when dbUrl is absent', async () => {
    const { runGraphUpdate } = await import('../graph/update.js');
    const out = await runGraphUpdate({ projectId: withoutDb, slug: 'graphupd-test-nodb' });
    // The schema layer must announce that it was skipped — a silent absence
    // reads as "nothing changed" and misled a real debugging session.
    expect(out).toMatch(/- db: skipped \(no MAI_GRAPH_DB_URL/);
    expect(await tableCount(withoutDb)).toBe(0);
  });
});

describe('runGraphUpdate observed Git provenance', () => {
  // A no-op source update can still advance observed Git provenance without reparsing.
  it('re-stamps unchanged-file nodes to HEAD without claiming a source reparse', async () => {
    const { runExtractor } = await import('../graph/engine.js');
    const { runGraphUpdate } = await import('../graph/update.js');

    const rd = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'mai-restamp-')));
    const git = (...a: string[]): ReturnType<typeof exec> =>
      exec('git', ['-C', rd, '-c', 'user.email=t@t', '-c', 'user.name=t', ...a]);
    await exec('git', ['-C', rd, 'init', '-q']);
    fs.writeFileSync(path.join(rd, 'a.ts'), 'export const a = 1;');
    await git('add', 'a.ts');
    await git('commit', '-q', '-m', 'one');

    await admin.query(`DELETE FROM projects WHERE slug = 'graphupd-restamp'`);
    const pid = (
      await admin.query<{ id: string }>(
        `INSERT INTO projects (slug, name, path, metadata) VALUES ($1, $1, $2, jsonb_build_object('repos', jsonb_build_array($2::text))) RETURNING id`,
        ['graphupd-restamp', rd]
      )
    ).rows[0].id;

    const base = path.basename(rd);
    const seedR: GraphExtractor = {
      name: 'seed-r',
      vocabulary: { kinds: ['file'], relations: [] },
      extract: async () => ({
        nodes: [{ kind: 'file', name: 'a.ts', qualifiedName: `${base}/a.ts`, filePath: path.join(rd, 'a.ts'), contentHash: crypto.createHash('sha256').update('export const a = 1;').digest('hex') }],
        edges: [],
      }),
    };
    await runExtractor(seedR, { projectId: pid, repoPaths: [rd] });

    // Advance HEAD WITHOUT touching a.ts: the incremental diff re-extracts
    // nothing for it, so a.ts's node now lags the new HEAD.
    fs.writeFileSync(path.join(rd, 'NOTES.md'), 'changelog');
    await git('add', 'NOTES.md');
    await git('commit', '-q', '-m', 'two');
    const head = (await exec('git', ['-C', rd, 'rev-parse', 'HEAD'])).stdout.trim();

    const staleCount = async (): Promise<{ stale: number; total: number }> => {
      const r = await admin.query<{ stale: string; total: string }>(
        `SELECT COUNT(*) FILTER (WHERE commit_sha IS DISTINCT FROM $2)::text AS stale, COUNT(*)::text AS total
         FROM graph_nodes WHERE project_id = $1 AND starts_with(file_path, $3 || '/')`,
        [pid, head, rd]
      );
      return { stale: Number(r.rows[0].stale), total: Number(r.rows[0].total) };
    };

    // Sanity (RED guard): before the update the observed commit metadata has not advanced yet.
    expect((await staleCount()).stale).toBeGreaterThan(0);

    await runGraphUpdate({ projectId: pid, slug: 'graphupd-restamp' });

    const after = await staleCount();
    expect(after.total).toBeGreaterThan(0);
    expect(after.stale).toBe(0);

    await admin.query(`DELETE FROM projects WHERE slug = 'graphupd-restamp'`);
    fs.rmSync(rd, { recursive: true, force: true });
  });
});
