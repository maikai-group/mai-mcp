/**
 * resolveConsumerGraphDbUrl (manual-run schema refresh): an agent running
 * `mai graph update` interactively never sources the consumer project's .env,
 * so MAI_GRAPH_DB_URL is absent from its shell and the db: layer silently
 * skips. The resolver closes that gap by reading the single MAI_GRAPH_DB_URL
 * key out of the pinned project's own .env (project.path or a registered repo).
 *
 * Two invariants the gate cares about:
 *  - only the MAI_GRAPH_DB_URL key is taken — the consumer .env is NEVER
 *    sourced wholesale, so a stray MAI_DB_URL there cannot redirect a brain
 *    write (iron rule 5);
 *  - process.env is never mutated as a side effect.
 */
import { beforeAll, afterAll, describe, expect, it } from 'vitest';
import { Pool } from 'pg';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

process.env.MAI_DB_URL =
  process.env.MAI_DB_URL ?? 'postgresql://postgres:postgres@127.0.0.1:54334/mai_brain';

const admin = new Pool({ connectionString: process.env.MAI_DB_URL });

const SLUGS = ['gdburl-inpath', 'gdburl-inrepo', 'gdburl-none', 'gdburl-keyonly'] as const;
const dirs: string[] = [];

function tmpdir(): string {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'mai-gdburl-'));
  dirs.push(d);
  return d;
}

async function makeProject(slug: string, rootPath: string, repos: string[]): Promise<string> {
  await admin.query(`DELETE FROM projects WHERE slug = $1`, [slug]);
  const r = await admin.query<{ id: string }>(
    `INSERT INTO projects (slug, name, path, metadata)
     VALUES ($1, $1, $2, jsonb_build_object('repos', $3::jsonb)) RETURNING id`,
    [slug, rootPath, JSON.stringify(repos)]
  );
  return r.rows[0].id;
}

afterAll(async () => {
  await admin.query(`DELETE FROM projects WHERE slug = ANY($1)`, [SLUGS]);
  for (const d of dirs) fs.rmSync(d, { recursive: true, force: true });
  await admin.end();
});

describe('resolveConsumerGraphDbUrl', () => {
  let inPath = '';
  let inRepo = '';
  let none = '';
  let keyOnly = '';

  beforeAll(async () => {
    const URL = 'postgresql://ro:secret@db.example.com:5432/appdb';

    // .env at the project root (project.path) — a real consumer layout.
    const root1 = tmpdir();
    fs.mkdirSync(path.join(root1, 'app'));
    fs.writeFileSync(path.join(root1, '.env'), `MAI_GRAPH_DB_URL=${URL}\n`);
    inPath = await makeProject('gdburl-inpath', root1, [path.join(root1, 'app')]);

    // .env inside a registered repo, not at the umbrella root.
    const root2 = tmpdir();
    const repo2 = path.join(root2, 'backend');
    fs.mkdirSync(repo2);
    fs.writeFileSync(path.join(repo2, '.env'), `MAI_GRAPH_DB_URL="${URL}"\n`);
    inRepo = await makeProject('gdburl-inrepo', root2, [repo2]);

    // No .env anywhere → undefined.
    const root3 = tmpdir();
    fs.mkdirSync(path.join(root3, 'x'));
    none = await makeProject('gdburl-none', root3, [path.join(root3, 'x')]);

    // .env present but WITHOUT the graph key (only a brain-shaped url) →
    // undefined, and process.env untouched.
    const root4 = tmpdir();
    fs.writeFileSync(
      path.join(root4, '.env'),
      'MAI_DB_URL=postgresql://postgres:postgres@127.0.0.1:54334/mai_brain\n'
    );
    keyOnly = await makeProject('gdburl-keyonly', root4, [root4]);
  });

  it('reads MAI_GRAPH_DB_URL from the project root .env', async () => {
    const { resolveConsumerGraphDbUrl } = await import('../graph/db-url.js');
    expect(await resolveConsumerGraphDbUrl(inPath)).toBe(
      'postgresql://ro:secret@db.example.com:5432/appdb'
    );
  });

  it('reads MAI_GRAPH_DB_URL from a registered repo .env (quoted value)', async () => {
    const { resolveConsumerGraphDbUrl } = await import('../graph/db-url.js');
    expect(await resolveConsumerGraphDbUrl(inRepo)).toBe(
      'postgresql://ro:secret@db.example.com:5432/appdb'
    );
  });

  it('returns undefined when no .env defines the key', async () => {
    const { resolveConsumerGraphDbUrl } = await import('../graph/db-url.js');
    expect(await resolveConsumerGraphDbUrl(none)).toBeUndefined();
  });

  it('takes only the graph key and never mutates process.env', async () => {
    const { resolveConsumerGraphDbUrl } = await import('../graph/db-url.js');
    const brainBefore = process.env.MAI_DB_URL;
    expect(await resolveConsumerGraphDbUrl(keyOnly)).toBeUndefined();
    // The consumer .env's MAI_DB_URL must NOT have leaked into our env.
    expect(process.env.MAI_DB_URL).toBe(brainBefore);
  });
});
