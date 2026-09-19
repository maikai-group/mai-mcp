// Longest-prefix repo attribution (lesson 08c7cab2): when an umbrella root and
// its sub-repos are both registered, the sub-repo owns its files — a parent
// full-walk must never delete or re-stamp nested repos' nodes.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Pool } from 'pg';
import { shaForFactory } from '../graph/engine.js';
import { DB_URL } from '../env.js';
import type { GraphExtractor } from '../graph/types.js';

describe('shaForFactory', () => {
  it('longest prefix wins — nested repo owns its files', () => {
    const shas = new Map<string, string | null>([
      ['/u/root', 'ROOT'],
      ['/u/root/native', 'NATIVE'],
    ]);
    const shaFor = shaForFactory(shas);
    expect(shaFor('/u/root/src/a.ts')).toBe('ROOT');
    expect(shaFor('/u/root/native/app.tsx')).toBe('NATIVE');
    expect(shaFor('/u/root/native')).toBe('NATIVE');
    expect(shaFor('/elsewhere/x.ts')).toBeNull();
    expect(shaFor(undefined)).toBeNull();
  });
});

describe('nested-repo update survival', () => {
  const admin = new Pool({ connectionString: DB_URL });
  let root: string;
  let sub: string;
  let projectId: string;
  const git = (dir: string, ...a: string[]): void => {
    execFileSync('git', ['-C', dir, '-c', 'user.email=t@t', '-c', 'user.name=t', ...a]);
  };

  beforeAll(async () => {
    root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'mai-nested-')));
    git(root, 'init', '-q');
    fs.writeFileSync(path.join(root, 'rootfile.ts'), 'export const r = 1;');
    git(root, 'add', 'rootfile.ts');
    git(root, 'commit', '-qm', 'root');
    sub = path.join(root, 'sub');
    fs.mkdirSync(sub);
    git(sub, 'init', '-q');
    fs.writeFileSync(path.join(sub, 'subfile.ts'), 'export const s = 1;');
    git(sub, 'add', 'subfile.ts');
    git(sub, 'commit', '-qm', 'sub');

    await admin.query(`DELETE FROM projects WHERE slug = 'graph-nested-test'`);
    projectId = (
      await admin.query<{ id: string }>(
        `INSERT INTO projects (slug, name, path, metadata)
         VALUES ('graph-nested-test', 'graph-nested-test', $1, jsonb_build_object('repos', jsonb_build_array($1::text, $2::text)))
         RETURNING id`,
        [root, sub]
      )
    ).rows[0].id;

    // Seed one node per repo via a stub extractor, so update has a graph to work on.
    const { runExtractor } = await import('../graph/engine.js');
    const seed: GraphExtractor = {
      name: 'seed-nested',
      vocabulary: { kinds: ['file'], relations: [] },
      extract: async () => ({
        nodes: [
          { kind: 'file', name: 'rootfile.ts', qualifiedName: 'seed/rootfile.ts', filePath: path.join(root, 'rootfile.ts') },
          { kind: 'file', name: 'subfile.ts', qualifiedName: 'seed/sub/subfile.ts', filePath: path.join(sub, 'subfile.ts') },
        ],
        edges: [],
      }),
    };
    await runExtractor(seed, { projectId, repoPaths: [root, sub] });
  });

  afterAll(async () => {
    await admin.query(`DELETE FROM projects WHERE slug = 'graph-nested-test'`);
    fs.rmSync(root, { recursive: true, force: true });
    await admin.end();
    const { getPool } = await import('../db.js');
    await getPool().end();
  });

  it('seeded nodes carry their OWN repo HEAD (not the parent root sha)', async () => {
    const rootHead = execFileSync('git', ['-C', root, 'rev-parse', 'HEAD']).toString().trim();
    const subHead = execFileSync('git', ['-C', sub, 'rev-parse', 'HEAD']).toString().trim();
    expect(rootHead).not.toBe(subHead);
    const r = await admin.query<{ file_path: string; commit_sha: string }>(
      `SELECT file_path, commit_sha FROM graph_nodes WHERE project_id = $1 AND extracted_by = 'seed-nested'`,
      [projectId]
    );
    const bySuffix = (s: string): string | undefined => r.rows.find((x) => x.file_path.endsWith(s))?.commit_sha;
    expect(bySuffix('rootfile.ts')).toBe(rootHead);
    expect(bySuffix(`sub${path.sep}subfile.ts`)).toBe(subHead);
  });

  it("a root full-walk update does NOT delete or re-stamp the nested repo's nodes", async () => {
    // Force root DETERMINISTICALLY into full-walk: give its node a bogus recorded
    // sha — `git diff bogus..HEAD` fails → the rebase-recovery path → full walk.
    // (A new commit would leave root in diff mode and never exercise the
    // dangerous deleted-detection / re-stamp path this test exists to guard.)
    await admin.query(
      `UPDATE graph_nodes SET commit_sha = repeat('0', 40) WHERE project_id = $1 AND file_path = $2`,
      [projectId, path.join(root, 'rootfile.ts')]
    );
    const subHead = execFileSync('git', ['-C', sub, 'rev-parse', 'HEAD']).toString().trim();

    const { runGraphUpdate } = await import('../graph/update.js');
    await runGraphUpdate({ projectId, slug: 'graph-nested-test' });

    const r = await admin.query<{ file_path: string; commit_sha: string }>(
      `SELECT file_path, commit_sha FROM graph_nodes WHERE project_id = $1 AND extracted_by = 'seed-nested'`,
      [projectId]
    );
    const subRow = r.rows.find((x) => x.file_path.endsWith(`sub${path.sep}subfile.ts`));
    expect(subRow).toBeDefined();               // survived the root walk (no false deletion)
    expect(subRow?.commit_sha).toBe(subHead);   // re-stamped to SUB's head, never root's
  });
});
