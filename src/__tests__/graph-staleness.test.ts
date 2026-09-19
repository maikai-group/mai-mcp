import { afterAll, afterEach, describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Pool } from 'pg';
import { requireDisposableTestDbUrl } from './test-db-url.js';
import { SourceEvidence } from '../graph/source-evidence.js';

const TEST_DB = requireDisposableTestDbUrl();
process.env.MAI_PROJECT_SLUG = 'staleness-test';
process.env.MAI_DB_URL = TEST_DB;
const admin = new Pool({ connectionString: TEST_DB });
const projects: string[] = [];
const dirs: string[] = [];
const hash = (text: string): string => crypto.createHash('sha256').update(text).digest('hex');
afterEach(async () => {
  for (const id of projects.splice(0)) await admin.query('DELETE FROM projects WHERE id = $1', [id]);
  for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});
afterAll(async () => { await admin.end(); });

async function fixture(files: Record<string, string>, nested: string[] = []) {
  const repo = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'mai-staleness-')));
  dirs.push(repo);
  const git = (...args: string[]): string => execFileSync('git', [
    '-C', repo, '-c', 'user.email=t@t', '-c', 'user.name=t', ...args,
  ], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
  git('init', '-q');
  for (const [rel, text] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(repo, rel)), { recursive: true });
    fs.writeFileSync(path.join(repo, rel), text);
  }
  git('add', '-A');
  const repos = [repo, ...nested.map((rel) => path.join(repo, rel))];
  const projectId = (await admin.query<{ id: string }>(
    `INSERT INTO projects (slug, name, path, metadata)
     VALUES ('staleness-test-' || substr(md5(random()::text),1,8), 'Staleness', $1,
       jsonb_build_object('repos', to_jsonb($2::text[]))) RETURNING id`, [repo, repos],
  )).rows[0].id;
  projects.push(projectId);
  async function node(rel: string, text: string | null, qname = `svc/${rel}`, commit: string | null = null) {
    const row = { kind: 'file', file_path: path.join(repo, rel), content_hash: text === null ? null : hash(text), extracted_by: 'ts' };
    await admin.query(
      `INSERT INTO graph_nodes (project_id, kind, name, qualified_name, file_path, content_hash, extracted_by, commit_sha)
       VALUES ($1, 'file', $2, $3, $4, $5, 'ts', $6)`,
      [projectId, rel, qname, row.file_path, row.content_hash, commit],
    );
    return row;
  }
  return { repo, repos, projectId, git, node, file: (rel: string) => path.join(repo, rel) };
}

describe('source-based staleness', () => {
  it('agrees across counts, prime/banner rendering, returned nodes and query with unchanged HEAD', async () => {
    const f = await fixture({ 'a.ts': 'alpha', 'b.ts': 'bravo' });
    f.git('commit', '-qm', 'base');
    const sha = f.git('rev-parse', 'HEAD');
    const rows = [await f.node('a.ts', 'alpha', 'svc/a', sha), await f.node('b.ts', 'bravo', 'svc/b', sha)];
    fs.writeFileSync(f.file('a.ts'), 'alter');
    const { repoStaleness, assessNodeStaleness } = await import('../graph/staleness.js');
    const { graphStaleCounts, renderCodePrimeLine, renderFreshnessBanner } = await import('../graph/freshness.js');
    const { graphStale, assessReturnedGraphFreshness, graphQuery } = await import('../graph/query.js');
    expect(await assessNodeStaleness(rows, f.repos)).toEqual(['stale', 'fresh']);
    expect(await repoStaleness(f.projectId, f.repo, f.repos)).toMatchObject({ total: 2, stale: 1, method: 'per-file', head: sha });
    const counts = await graphStaleCounts(f.projectId);
    expect(counts).toEqual({ total: 2, stale: 1, method: 'per-file' });
    expect(await graphStale({ projectId: f.projectId })).toContain('1/2 stale');
    expect(renderCodePrimeLine(counts)).toContain('1/2 nodes whose source differs');
    expect(renderFreshnessBanner({ code: counts, db: { state: 'not-configured' } }).code.tone).toBe('warn');
    expect((await assessReturnedGraphFreshness(f.projectId, rows)).line).toContain('1/2 code nodes source verified, 1 stale');
    expect(await graphQuery({ seed: { query: 'svc/' }, limit: 10 }, f.projectId)).toContain('1/2 code nodes source verified, 1 stale');
    expect(f.git('rev-parse', 'HEAD')).toBe(sha);
  });

  it('can verify staged source before the first commit; null and unreachable commits do not override hashes', async () => {
    const f = await fixture({ 'a.ts': 'alpha' });
    const first = await f.node('a.ts', 'alpha', 'svc/first', null);
    for (let i = 0; i < 25; i++) await f.node('a.ts', 'alpha', `svc/${i}`, i.toString(16).padStart(40, 'f'));
    const { repoStaleness, assessNodeStaleness } = await import('../graph/staleness.js');
    expect(await repoStaleness(f.projectId, f.repo, f.repos)).toMatchObject({ total: 26, stale: 0, head: null, method: 'per-file', fallbackReason: null });
    expect(await assessNodeStaleness([first], f.repos)).toEqual(['fresh']);
    f.git('commit', '-qm', 'base');
    f.git('commit', '--allow-empty', '-qm', 'unrelated');
    const beforeAmend = f.git('rev-parse', 'HEAD');
    f.git('commit', '--amend', '--allow-empty', '-qm', 'amended unrelated');
    expect(f.git('rev-parse', 'HEAD')).not.toBe(beforeAmend);
    expect(fs.readFileSync(f.file('a.ts'), 'utf8')).toBe('alpha');
    expect((await repoStaleness(f.projectId, f.repo, f.repos)).stale).toBe(0);
  });

  it('missing and invalid hashes are unknown, not certified from the current commit', async () => {
    const f = await fixture({ 'a.ts': 'alpha' });
    f.git('commit', '-qm', 'base');
    const node = await f.node('a.ts', null, 'svc/legacy', f.git('rev-parse', 'HEAD'));
    const { repoStaleness, assessNodeStaleness } = await import('../graph/staleness.js');
    expect(await assessNodeStaleness([node, { ...node, content_hash: 'bad' }, { ...node, file_path: null }], f.repos))
      .toEqual(['unattributed', 'unattributed', 'unattributed']);
    expect(await repoStaleness(f.projectId, f.repo, f.repos)).toMatchObject({ stale: 1, method: 'whole-graph', fallbackReason: 'missing extraction evidence' });
  });

  it('counts removed tracked source stale, including an index deletion with retained bytes', async () => {
    const f = await fixture({ 'a.ts': 'alpha', 'b.ts': 'bravo', 'c.ts': 'charl' });
    for (const [rel, body] of [['a.ts', 'alpha'], ['b.ts', 'bravo'], ['c.ts', 'charl']]) await f.node(rel, body);
    f.git('rm', '--cached', 'a.ts');
    fs.unlinkSync(f.file('b.ts'));
    const { repoStaleness } = await import('../graph/staleness.js');
    expect(await repoStaleness(f.projectId, f.repo, f.repos)).toMatchObject({ total: 3, stale: 2, method: 'per-file' });
  });

  it('keeps nested roots, excludes and project-owned DB evidence independent', async () => {
    const f = await fixture({ 'outer.ts': 'alpha', 'inner/a.ts': 'bravo' }, ['inner']);
    await f.node('outer.ts', 'alpha', 'svc/z');
    await f.node('inner/a.ts', 'old', 'svc/a');
    const { projectStaleness, repoStaleness } = await import('../graph/staleness.js');
    expect((await projectStaleness(f.projectId, f.repos)).map((row) => [row.total, row.stale])).toEqual([[1, 0], [1, 1]]);
    const source = new SourceEvidence(f.repos, [f.file('outer.ts')]);
    expect(await repoStaleness(f.projectId, f.repo, f.repos, source)).toMatchObject({ total: 1, stale: 1, method: 'whole-graph' });
    const other = await fixture({ 'outer.ts': 'alpha' });
    await other.node('outer.ts', 'old', 'svc/z');
    expect((await repoStaleness(f.projectId, f.repo, f.repos)).stale).toBe(0);
    expect((await repoStaleness(other.projectId, other.repo, other.repos)).stale).toBe(1);
  });

  it('uses each row’s own extraction hash and sorts subsystem rows', async () => {
    const f = await fixture({ 'a.ts': 'alpha' });
    await f.node('a.ts', 'old', 'svc/z');
    await f.node('a.ts', 'alpha', 'svc/a');
    const { repoStaleness } = await import('../graph/staleness.js');
    expect((await repoStaleness(f.projectId, f.repo, f.repos)).bySubsystem).toEqual([
      { subsystem: 'a', total: 1, stale: 0 }, { subsystem: 'z', total: 1, stale: 1 },
    ]);
  });

  it('reports non-Git and budgeted source conservatively with a fallback reason', async () => {
    const f = await fixture({ 'a.ts': 'alpha' });
    await f.node('a.ts', 'alpha');
    const { repoStaleness } = await import('../graph/staleness.js');
    const small = new SourceEvidence(f.repos, [], { file: 1, total: 1 });
    expect(await repoStaleness(f.projectId, f.repo, f.repos, small)).toMatchObject({ stale: 1, method: 'whole-graph', fallbackReason: 'source unverified (size)' });
    fs.rmSync(f.file('.git'), { recursive: true, force: true });
    expect(await repoStaleness(f.projectId, f.repo, f.repos)).toMatchObject({ stale: 1, method: 'whole-graph', fallbackReason: 'source unverified (non-git)' });
  });

  it('retains Unicode and leading spaces in source attribution', async () => {
    const f = await fixture({ 'café.ts': 'alpha', ' lead.ts': 'bravo', 'plain.ts': 'charl' });
    for (const [rel, body] of [['café.ts', 'alpha'], [' lead.ts', 'bravo'], ['plain.ts', 'charl']]) await f.node(rel, body);
    fs.writeFileSync(f.file('café.ts'), 'alter');
    fs.writeFileSync(f.file(' lead.ts'), 'other');
    const { repoStaleness } = await import('../graph/staleness.js');
    expect(await repoStaleness(f.projectId, f.repo, f.repos)).toMatchObject({ total: 3, stale: 2 });
  });

  it('keeps non-ASCII files in behavioral co-change pairs', async () => {
    const f = await fixture({ 'café.ts': 'a\n', 'other.ts': 'o\n' });
    f.git('commit', '-qm', 'base');
    for (let i = 0; i < 2; i++) {
      fs.appendFileSync(f.file('café.ts'), `a${i}\n`);
      fs.appendFileSync(f.file('other.ts'), `o${i}\n`);
      f.git('add', '-A');
      f.git('commit', '-qm', `co-change ${i}`);
    }
    const { behavioralExtractor } = await import('../graph/extractors/behavioral.js');
    const out = await behavioralExtractor.extract({ projectId: f.projectId, repoPaths: f.repos });
    const pair = out.edges.find((edge) => edge.relation === 'co_changed_with');
    expect(pair).toBeDefined();
    expect(JSON.stringify(pair)).toContain('café.ts');
  });
});
