/**
 * Behavioral extractor: pure parsing/pair-counting, a deterministic tmpdir git
 * repo, and engine idempotency (weight refresh, no duplicate edges).
 */
import { beforeAll, afterAll, describe, expect, it } from 'vitest';
import { Pool } from 'pg';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { serviceIdentity, serviceSourceQName } from '../graph/contracts.js';
import { behavioralExtractor, coChangePairs, parseGitNameOnly } from '../graph/extractors/behavioral.js';
import type { GraphExtractor } from '../graph/types.js';

const exec = promisify(execFile);

process.env.MAI_PROJECT_SLUG = 'behavioral-test';
process.env.MAI_DB_URL =
  process.env.MAI_DB_URL ?? 'postgresql://postgres:postgres@127.0.0.1:54334/mai_brain';

const admin = new Pool({ connectionString: process.env.MAI_DB_URL });
let projectA = '';
let repoDir = '';
let serviceId = '';

const GIT = (args: string[]) =>
  exec('git', ['-C', repoDir, '-c', 'user.email=t@t', '-c', 'user.name=t', ...args]);

beforeAll(async () => {
  await admin.query(`DELETE FROM projects WHERE slug = 'behavioral-test'`);
  const a = await admin.query<{ id: string }>(
    `INSERT INTO projects (slug, name) VALUES ('behavioral-test','B') RETURNING id`
  );
  projectA = a.rows[0].id;

  // Deterministic history: a.ts+b.ts co-change twice, c.ts changes alone once.
  repoDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mai-behavioral-'));
  serviceId = serviceIdentity(repoDir).id;
  await exec('git', ['-C', repoDir, 'init', '-q']);
  const write = (f: string, content: string) => fs.writeFileSync(path.join(repoDir, f), content);
  write('a.ts', 'export const a = 1;');
  write('b.ts', 'export const b = 1;');
  await GIT(['add', 'a.ts', 'b.ts']);
  await GIT(['commit', '-q', '-m', 'one']);
  write('a.ts', 'export const a = 2;');
  write('b.ts', 'export const b = 2;');
  await GIT(['add', 'a.ts', 'b.ts']);
  await GIT(['commit', '-q', '-m', 'two']);
  write('c.ts', 'export const c = 1;');
  await GIT(['add', 'c.ts']);
  await GIT(['commit', '-q', '-m', 'three']);
});

afterAll(async () => {
  await admin.query(`DELETE FROM projects WHERE slug = 'behavioral-test'`);
  fs.rmSync(repoDir, { recursive: true, force: true });
  await admin.end();
  const { getPool } = await import('../db.js');
  await getPool().end();
});

describe('pure functions', () => {
  it('partitions shared-worktree history by longest-prefix owner independent of root order', async () => {
    const parent = fs.mkdtempSync(path.join(os.tmpdir(), 'mai-behavioral-owned-'));
    const child = path.join(parent, 'child');
    const git = (args: string[]) => exec('git', ['-C', parent, '-c', 'user.email=t@t', '-c', 'user.name=t', ...args]);
    try {
      fs.mkdirSync(child, { recursive: true });
      await exec('git', ['-C', parent, 'init', '-q']);
      for (const rel of ['a.ts', 'b.ts', 'child/a.ts', 'child/b.ts']) {
        fs.writeFileSync(path.join(parent, rel), 'export const value = 1;\n');
      }
      fs.symlinkSync(path.join(child, 'a.ts'), path.join(parent, 'linked.ts'));
      await git(['add', '.']);
      await git(['commit', '-q', '-m', 'one']);
      for (const rel of ['a.ts', 'b.ts', 'child/a.ts', 'child/b.ts']) {
        fs.writeFileSync(path.join(parent, rel), 'export const value = 2;\n');
      }
      await git(['add', '.']);
      await git(['commit', '-q', '-m', 'two']);
      const forward = await behavioralExtractor.extract({ projectId: 'x', repoPaths: [parent, child] });
      const reverse = await behavioralExtractor.extract({ projectId: 'x', repoPaths: [child, parent] });
      const signature = (value: typeof forward): string[] => value.edges
        .map((entry) => `${entry.from.qualifiedName}->${entry.to.qualifiedName}:${entry.weight}`)
        .sort();
      expect(signature(forward)).toEqual(signature(reverse));
      expect(forward.edges).toHaveLength(2);
      const parentId = serviceIdentity(parent).id;
      const childId = serviceIdentity(child).id;
      expect(JSON.stringify(forward.edges)).toContain(serviceSourceQName(parentId, `${path.basename(parent)}/a.ts`));
      expect(JSON.stringify(forward.edges)).toContain(serviceSourceQName(childId, 'child/a.ts'));
      expect(JSON.stringify(forward.edges)).not.toContain(`${path.basename(parent)}/child/a.ts`);
      expect(JSON.stringify(forward.edges)).not.toContain(`${path.basename(parent)}/linked.ts`);
    } finally {
      fs.rmSync(parent, { recursive: true, force: true });
    }
  });
  it('parseGitNameOnly splits hash-headed blocks into file lists', () => {
    const out = parseGitNameOnly(
      'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa\nsrc/a.ts\nsrc/b.ts\n\nbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb\nsrc/a.ts\n'
    );
    expect(out).toEqual([['src/a.ts', 'src/b.ts'], ['src/a.ts']]);
  });

  it('coChangePairs counts canonical pairs, skips bulk commits and non-source files', () => {
    const bulk = Array.from({ length: 60 }, (_, i) => `f${i}.ts`);
    const counts = coChangePairs([
      ['src/b.ts', 'src/a.ts', 'README.md'],
      ['src/a.ts', 'src/b.ts'],
      bulk,
    ]);
    expect(counts.get('src/a.ts src/b.ts')).toBe(2);
    expect([...counts.keys()].some((k) => k.includes('README'))).toBe(false);
    expect(counts.size).toBe(1); // the 60-file commit contributed nothing
  });

  it('pairs every file-node-producing language — kt/swift/cpp-family/php + tier-2 go/rs/java/cs (A7)', () => {
    // Before A7 these extensions were silently discarded, blanking co-change
    // for whole repos; .kts stays excluded (structure-only, no file nodes).
    const counts = coChangePairs([
      ['App.kt', 'Engine.swift'],
      ['App.kt', 'Engine.swift'],
      ['Widget.cpp', 'Widget.h'],
      ['Widget.cpp', 'Widget.h'],
      ['plugin.php', 'view.php'],
      ['plugin.php', 'view.php'],
      ['main.go', 'lib.rs'],
      ['main.go', 'lib.rs'],
      ['App.java', 'Program.cs'],
      ['App.java', 'Program.cs'],
      ['settings.gradle.kts', 'other.gradle.kts'],
    ]);
    expect(counts.get('App.kt Engine.swift')).toBe(2);
    expect(counts.get('Widget.cpp Widget.h')).toBe(2);
    expect(counts.get('plugin.php view.php')).toBe(2);
    expect(counts.get('lib.rs main.go')).toBe(2);
    expect(counts.get('App.java Program.cs')).toBe(2);
    expect([...counts.keys()].some((k) => k.includes('.kts'))).toBe(false);
  });
});

describe('extractor + engine', () => {
  it('emits weight≥2 co_changed_with edges; engine persists idempotently', async () => {
    const repoBase = path.basename(repoDir);
    const qname = (file: string): string => serviceSourceQName(serviceId, `${repoBase}/${file}`);
    // Seed the file nodes behavioral edges attach to.
    const seed: GraphExtractor = {
      name: 'seed-b',
      vocabulary: { kinds: ['file'], relations: ['co_changed_with'] },
      extract: async () => ({
        nodes: [
          { kind: 'file', name: 'a.ts', qualifiedName: qname('a.ts'), filePath: path.join(repoDir, 'a.ts') },
          { kind: 'file', name: 'b.ts', qualifiedName: qname('b.ts'), filePath: path.join(repoDir, 'b.ts') },
        ],
        edges: [],
      }),
    };
    const { runExtractor } = await import('../graph/engine.js');
    await runExtractor(seed, { projectId: projectA, repoPaths: [repoDir] });

    const out = await behavioralExtractor.extract({ projectId: projectA, repoPaths: [repoDir] });
    expect(out.nodes).toHaveLength(0);
    const e = out.edges.find((x) => x.relation === 'co_changed_with');
    expect(e).toBeDefined();
    expect(e?.weight).toBe(2);
    expect(e?.confidence).toBe('behavioral');

    const s1 = await runExtractor(behavioralExtractor, { projectId: projectA, repoPaths: [repoDir] });
    expect(s1.edges).toBe(1);
    const s2 = await runExtractor(behavioralExtractor, { projectId: projectA, repoPaths: [repoDir] });
    expect(s2.edges).toBe(1);
    const rows = await admin.query<{ weight: number; confidence: string }>(
      `SELECT weight, confidence FROM graph_edges WHERE project_id = $1 AND relation = 'co_changed_with'`,
      [projectA]
    );
    expect(rows.rows).toHaveLength(1);
    expect(rows.rows[0]).toMatchObject({ weight: 2, confidence: 'behavioral' });
  });
});
