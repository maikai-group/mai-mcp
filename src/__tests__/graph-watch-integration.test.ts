import { afterAll, afterEach, describe, expect, it, vi } from 'vitest';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync, spawn } from 'node:child_process';
import { Pool } from 'pg';
import { requireDisposableTestDbUrl } from './test-db-url.js';
import type { GraphWatchController } from '../graph/watch.js';

const TEST_DB = requireDisposableTestDbUrl();
process.env.MAI_DB_URL = TEST_DB;
process.env.MAI_PROJECT_SLUG = 'graph-watch-test';
const admin = new Pool({ connectionString: TEST_DB });
const projects: string[] = [];
const dirs: string[] = [];
const watchers: GraphWatchController[] = [];
interface Row { id: string; name: string; kind: string; file_path: string; content_hash: string | null }
afterEach(async () => {
  await Promise.all(watchers.splice(0).map(watcher => watcher.stop()));
  for (const id of projects.splice(0)) await admin.query('DELETE FROM projects WHERE id = $1', [id]);
  for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});
afterAll(async () => { await admin.end(); const { closePool } = await import('../db.js'); await closePool(); });
async function fixture() {
  const repo = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'mai-watch-integration-'))); dirs.push(repo);
  const file = (name: string) => path.join(repo, name);
  const git = (...args: string[]) => execFileSync('git', ['-C', repo, '-c', 'user.email=t@t', '-c', 'user.name=t', ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  git('init'); fs.writeFileSync(file('a.ts'), 'export function alpha() {}\n'); fs.writeFileSync(file('stable.ts'), 'export function stable() {}\n');
  git('add', '.'); git('commit', '-m', 'fixture');
  const project = (await admin.query<{ id: string; slug: string }>(
    `INSERT INTO projects (slug, name, path, metadata) VALUES ('graph-watch-' || substr(md5(random()::text),1,8), 'Graph Watch', $1,
      jsonb_build_object('repos', jsonb_build_array($1::text))) RETURNING id, slug`, [repo],
  )).rows[0]; projects.push(project.id);
  const args = { projectId: project.id, slug: project.slug };
  const rows = async () => (await admin.query<Row>('SELECT id, name, kind, file_path, content_hash FROM graph_nodes WHERE project_id = $1', [project.id])).rows;
  return { repo, file, git, args, rows };
}
describe('foreground graph watch integration', () => {
  it('refreshes edits, reverts, staging, cached removal and rename with real Git, watchers and graph writers', async () => {
    const f = await fixture();
    const { runGraphBuild } = await import('../graph/build.js');
    const { runGraphUpdate } = await import('../graph/update.js');
    const { startGraphWatch } = await import('../graph/watch.js');
    const { repoStaleness } = await import('../graph/staleness.js');
    await runGraphBuild(f.args);
    const stable = (await f.rows()).find(row => row.name === 'stable' && row.kind === 'function')?.id;
    expect(stable).toBeDefined(); let runs = 0;
    watchers.push(await startGraphWatch({ repos: [f.repo], excludes: [], debounceMs: 20, intervalMs: 50,
      update: async () => { await runGraphUpdate(f.args); runs++; }, report: () => {},
    }));
    await vi.waitFor(() => expect(runs).toBeGreaterThan(0), { timeout: 30_000 });
    const edited = 'export function edited() {}\n'; fs.writeFileSync(f.file('a.ts'), edited);
    await vi.waitFor(async () => expect((await f.rows()).find(row => row.name === 'edited' && row.kind === 'function')?.content_hash)
      .toBe(crypto.createHash('sha256').update(edited).digest('hex')), { timeout: 30_000 });
    expect((await repoStaleness(f.args.projectId, f.repo, [f.repo])).stale).toBe(0);
    f.git('restore', 'a.ts');
    await vi.waitFor(async () => expect((await f.rows()).some(row => row.name === 'alpha')).toBe(true), { timeout: 30_000 });
    fs.writeFileSync(f.file('new.ts'), 'export function added() {}\n'); f.git('add', 'new.ts');
    await vi.waitFor(async () => expect((await f.rows()).some(row => row.name === 'added')).toBe(true), { timeout: 30_000 });
    f.git('rm', '--cached', 'new.ts'); expect(fs.existsSync(f.file('new.ts'))).toBe(true);
    await vi.waitFor(async () => expect((await f.rows()).some(row => row.name === 'added')).toBe(false), { timeout: 30_000 });
    f.git('mv', 'a.ts', 'renamed.ts');
    await vi.waitFor(async () => {
      const rows = await f.rows(); expect(rows.some(row => row.file_path === f.file('a.ts'))).toBe(false);
      expect(rows.some(row => row.name === 'alpha' && row.file_path === f.file('renamed.ts'))).toBe(true);
    }, { timeout: 30_000 });
    expect((await f.rows()).find(row => row.name === 'stable' && row.kind === 'function')?.id).toBe(stable);
  }, 180_000);
  it.skipIf(process.platform === 'win32').each(['SIGINT', 'SIGTERM'] as const)('the built CLI handles %s and does not auto-build a missing graph', async signal => {
    const f = await fixture();
    const child = spawn(process.execPath, ['build/cli.js', 'graph', 'watch', '--project', f.args.slug], {
      cwd: process.cwd(), stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env, MAI_DB_URL: TEST_DB, MAI_PROJECT_SLUG: f.args.slug, MAI_GRAPH_DB_URL: '', MAI_EMBEDDINGS: '0' },
    });
    let output = ''; child.stdout.on('data', data => { output += String(data); }); child.stderr.on('data', data => { output += String(data); });
    const exit = new Promise<{ code: number | null; signal: string | null }>((resolve, reject) => {
      child.once('error', reject); child.once('exit', (code, childSignal) => resolve({ code, signal: childSignal }));
    });
    const deadline = setTimeout(() => child.kill('SIGKILL'), 45_000);
    try {
      await vi.waitFor(() => expect(output).toContain('No graph yet'), { timeout: 30_000 });
      child.kill(signal); expect(await exit).toEqual({ code: 0, signal: null });
      expect(output).toContain('Graph watcher stopped.'); expect(await f.rows()).toHaveLength(0);
    } finally {
      clearTimeout(deadline); if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL'); await exit;
    }
  }, 60_000);
});
