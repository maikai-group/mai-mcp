import { afterAll, afterEach, describe, expect, it, vi } from 'vitest';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { Pool } from 'pg';
import { requireDisposableTestDbUrl } from './test-db-url.js';
import { SourceEvidence } from '../graph/source-evidence.js';
import { readEndpointMetadata, serviceIdentity } from '../graph/contracts.js';

const TEST_DB = requireDisposableTestDbUrl();
process.env.MAI_DB_URL = TEST_DB;
process.env.MAI_PROJECT_SLUG = 'working-tree-test';
const admin = new Pool({ connectionString: TEST_DB });
const projects: string[] = [];
const dirs: string[] = [];
const hash = (text: string): string => crypto.createHash('sha256').update(text).digest('hex');
interface Row {
  id: string; name: string; kind: string; file_path: string | null;
  content_hash: string | null; commit_sha: string | null; extracted_by: string; metadata: unknown;
}
afterEach(async () => {
  vi.restoreAllMocks();
  for (const id of projects.splice(0)) await admin.query('DELETE FROM projects WHERE id = $1', [id]);
  for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});
afterAll(async () => { await admin.end(); });

async function fixture(files: Record<string, string>) {
  const repo = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'mai-working-tree-')));
  dirs.push(repo);
  const git = (...args: string[]): string => execFileSync('git', [
    '-C', repo, '-c', 'user.email=t@t', '-c', 'user.name=t', ...args,
  ], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
  const file = (rel: string): string => path.join(repo, rel);
  git('init', '-q');
  for (const [rel, body] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(file(rel)), { recursive: true });
    fs.writeFileSync(file(rel), body);
  }
  git('add', '-A');
  git('commit', '-qm', 'base');
  const project = (await admin.query<{ id: string; slug: string }>(
    `INSERT INTO projects (slug, name, path, metadata)
     VALUES ('working-tree-' || substr(md5(random()::text),1,8), 'Working Tree', $1,
       jsonb_build_object('repos', jsonb_build_array($1::text))) RETURNING id, slug`, [repo],
  )).rows[0];
  projects.push(project.id);
  const args = { projectId: project.id, slug: project.slug };
  const { runGraphBuild } = await import('../graph/build.js');
  const { runGraphUpdate } = await import('../graph/update.js');
  const { repoStaleness } = await import('../graph/staleness.js');
  await runGraphBuild(args);
  const rows = async (): Promise<Row[]> => (await admin.query<Row>(
    `SELECT id, name, kind, file_path, content_hash, commit_sha, extracted_by, metadata
       FROM graph_nodes WHERE project_id = $1 ORDER BY kind, name, id`, [project.id],
  )).rows;
  return {
    repo, file, git, projectId: project.id, rows,
    build: () => runGraphBuild(args), update: () => runGraphUpdate(args),
    stale: () => repoStaleness(project.id, repo, [repo]),
  };
}

function named(rows: Row[], name: string): Row {
  const row = rows.find((item) => item.name === name && item.kind === 'function');
  if (row === undefined) throw new Error(`missing fixture function ${name}`);
  return row;
}

describe('working-tree updates', () => {
  it.each([null, 'f'.repeat(40)])('does not re-extract unchanged TS/Python when commit provenance is %s', async (stamp) => {
    const f = await fixture({ 'a.ts': 'export function alpha() {}\n', 'a.py': 'def bravo():\n    pass\n' });
    await admin.query('UPDATE graph_nodes SET commit_sha = $2 WHERE project_id = $1', [f.projectId, stamp]);
    const before = (await f.rows()).filter((row) => ['ts', 'python'].includes(row.extracted_by)).map((row) => row.id);
    expect(before.length).toBeGreaterThan(0);
    const { tsExtractor } = await import('../graph/extractors/ts.js');
    const { pythonExtractor } = await import('../graph/extractors/python.js');
    const tsRun = vi.spyOn(tsExtractor, 'extract');
    const pyRun = vi.spyOn(pythonExtractor, 'extract');
    await f.update();
    expect(tsRun).not.toHaveBeenCalled();
    expect(pyRun).not.toHaveBeenCalled();
    expect((await f.rows()).filter((row) => ['ts', 'python'].includes(row.extracted_by)).map((row) => row.id)).toEqual(before);
  }, 120000);

  it('reports newly staged Kotlin/Swift source until a full build extracts it', async () => {
    const f = await fixture({ 'a.ts': 'export function alpha() {}\n' });
    fs.writeFileSync(f.file('new.kt'), 'fun newKotlin() {}\n');
    fs.writeFileSync(f.file('new.swift'), 'func newSwift() {}\n');
    f.git('add', 'new.kt', 'new.swift');
    expect(await f.update()).toContain('run mai graph build');
    expect((await f.rows()).some((row) => ['newKotlin', 'newSwift'].includes(row.name))).toBe(false);
    await f.build();
    for (const name of ['newKotlin', 'newSwift']) expect((await f.rows()).some((row) => row.name === name)).toBe(true);
    expect(await f.update()).not.toContain('run mai graph build');
  }, 120000);

  it('does not repeatedly select declaration files or generated C++ headers', async () => {
    const f = await fixture({ 'a.ts': 'export function alpha() {}\n', 'types.d.ts': 'declare function typed(): void;\n',
      'Object.generated.h': 'void generated();\n' });
    const { tsExtractor } = await import('../graph/extractors/ts.js');
    const { cppExtractor } = await import('../graph/extractors/cpp.js');
    const tsRun = vi.spyOn(tsExtractor, 'extract');
    const cppRun = vi.spyOn(cppExtractor, 'extract');
    for (let i = 0; i < 2; i++) {
      expect(await f.update()).toContain(`- ${path.basename(f.repo)}: up-to-date`);
      expect(tsRun).not.toHaveBeenCalled();
      expect(cppRun).not.toHaveBeenCalled();
    }
  }, 120000);

  it('applies tracked membership and excludes to all repo-local glue inputs', async () => {
    const f = await fixture({ 'a.ts': 'export function alpha() {}\n', '.gitignore': '.mcp.json\n' });
    const configs = {
      'package.json': JSON.stringify({ scripts: { localScript: 'node a.ts' } }),
      '.mcp.json': JSON.stringify({ mcpServers: { localServer: { command: 'node', args: ['a.ts'] } } }),
      '.claude/settings.json': JSON.stringify({ hooks: { SessionStart: [{ hooks: [{ command: 'node a.ts' }] }] } }),
    };
    for (const [rel, text] of Object.entries(configs)) {
      fs.mkdirSync(path.dirname(f.file(rel)), { recursive: true });
      fs.writeFileSync(f.file(rel), text);
    }
    const local = async (): Promise<Row[]> => (await f.rows()).filter((row) => row.extracted_by === 'glue'
      && row.file_path !== null && Object.keys(configs).map(f.file).includes(row.file_path));
    await f.build();
    expect(await local()).toHaveLength(0); // untracked package/hooks and ignored MCP
    await f.update();
    expect(await local()).toHaveLength(0);
    f.git('add', '-f', ...Object.keys(configs));
    await f.update();
    expect(new Set((await local()).map((row) => row.file_path))).toEqual(new Set(Object.keys(configs).map(f.file)));
    await admin.query("UPDATE projects SET metadata = jsonb_set(metadata, '{graph_excludes}', $2::jsonb) WHERE id = $1",
      [f.projectId, JSON.stringify(Object.keys(configs).map(f.file))]);
    await f.update();
    expect(await local()).toHaveLength(0);
    await admin.query("UPDATE projects SET metadata = jsonb_set(metadata, '{graph_excludes}', '[]'::jsonb) WHERE id = $1", [f.projectId]);
    await f.update();
    expect(await local()).toHaveLength(3);
    // A separately registered physical .claude root owns the hook file.
    const { glueExtractor } = await import('../graph/extractors/glue.js');
    const nested = await glueExtractor.extract({ projectId: f.projectId, repoPaths: [f.repo, f.file('.claude')] });
    expect(nested.nodes.some((row) => row.filePath === f.file('.claude/settings.json'))).toBe(false);
    f.git('rm', '--cached', '-f', ...Object.keys(configs));
    expect(Object.keys(configs).every((rel) => fs.existsSync(f.file(rel)))).toBe(true);
    await f.update();
    expect(await local()).toHaveLength(0);
  }, 120000);

  it('updates dirty, staged, new, renamed and deleted source without a new commit', async () => {
    const initial = 'export function alpha() { return 1; }\n';
    const f = await fixture({ 'café.ts': initial, 'b.ts': 'export function bravo() { return 2; }\n', '.gitignore': 'ignored.ts\n' });
    const sha = f.git('rev-parse', 'HEAD');
    const stable = named(await f.rows(), 'bravo').id;
    fs.writeFileSync(f.file('café.ts'), 'export function altered() { return 3; }\n');
    expect((await f.stale()).stale).toBeGreaterThan(0);
    await f.update();
    expect(named(await f.rows(), 'altered').content_hash).toBe(hash(fs.readFileSync(f.file('café.ts'), 'utf8')));
    expect(named(await f.rows(), 'bravo').id).toBe(stable);
    expect((await f.stale()).stale).toBe(0);
    fs.writeFileSync(f.file('café.ts'), initial);
    expect((await f.stale()).stale).toBeGreaterThan(0);
    f.git('add', 'café.ts');
    await f.update();
    expect(named(await f.rows(), 'alpha')).toBeDefined();
    expect((await f.rows()).some((row) => row.name === 'altered')).toBe(false);
    for (const rel of ['new.ts', 'ignored.ts']) fs.writeFileSync(f.file(rel), `export function ${rel.split('.')[0]}Fn() {}\n`);
    await f.update();
    expect((await f.rows()).some((row) => row.name === 'newFn' || row.name === 'ignoredFn')).toBe(false);
    f.git('add', 'new.ts');
    await f.update();
    expect(named(await f.rows(), 'newFn')).toBeDefined();
    f.git('mv', 'new.ts', ' lead.ts');
    await f.update();
    expect(named(await f.rows(), 'newFn').file_path).toBe(f.file(' lead.ts'));
    expect((await f.rows()).some((row) => row.file_path === f.file('new.ts'))).toBe(false);
    f.git('rm', '--cached', ' lead.ts');
    expect(fs.existsSync(f.file(' lead.ts'))).toBe(true);
    fs.unlinkSync(f.file('café.ts'));
    await f.update();
    expect((await f.rows()).some((row) => ['newFn', 'alpha'].includes(row.name))).toBe(false);
    expect(named(await f.rows(), 'bravo').id).toBe(stable);
    expect(f.git('rev-parse', 'HEAD')).toBe(sha);
  }, 120000);

  it('refreshes legacy missing evidence even when its file anchor matches; no-op updates retain TS evidence', async () => {
    const f = await fixture({ 'a.ts': 'export function alpha() { return 1; }\n' });
    await admin.query(`UPDATE graph_nodes SET content_hash = NULL WHERE project_id = $1 AND kind = 'function'`, [f.projectId]);
    expect((await f.stale()).method).toBe('whole-graph');
    await f.update();
    expect(named(await f.rows(), 'alpha').content_hash).toBe(hash(fs.readFileSync(f.file('a.ts'), 'utf8')));
    expect((await f.stale()).stale).toBe(0);
    const before = (await f.rows()).filter((row) => row.extracted_by === 'ts');
    await f.update();
    expect((await f.rows()).filter((row) => row.extracted_by === 'ts')).toEqual(before);
    fs.writeFileSync(f.file('a.ts'), 'export function beta() {}\n');
    vi.spyOn(SourceEvidence.prototype, 'read').mockResolvedValueOnce({ state: 'unknown', reason: 'budget' });
    await f.update();
    expect(named(await f.rows(), 'beta')).toBeDefined();
  }, 120000);

  it('updates TS/Python/C++ and full-run languages while Kotlin/Swift require a build', async () => {
    const files = {
      'a.ts': 'export function tsOld() {}\n', 'a.py': 'def pyOld():\n    pass\n',
      'a.cpp': 'int cppOld() { return 1; }\n', 'a.php': '<?php function phpOld() {}\n',
      'a.go': 'package main\nfunc goOld() {}\n', 'a.kt': 'fun ktOld() {}\n',
      'a.swift': 'func swiftOld() {}\n', 'run.sh': '#!/bin/sh\necho old\n',
    };
    const f = await fixture(files);
    for (const [rel, text] of Object.entries(files)) fs.writeFileSync(f.file(rel), text.replace(/Old/g, 'New').replace('echo old', 'echo new'));
    const out = await f.update();
    const rows = await f.rows();
    for (const name of ['tsNew', 'pyNew', 'cppNew', 'phpNew', 'goNew']) expect(rows.some((row) => row.name === name)).toBe(true);
    for (const name of ['ktOld', 'swiftOld']) expect(rows.some((row) => row.name === name)).toBe(true);
    expect(out).toContain('run mai graph build');
    expect((await f.stale()).stale).toBeGreaterThan(0);
    await f.build();
    const built = await f.rows();
    for (const name of ['ktNew', 'swiftNew']) expect(built.some((row) => row.name === name)).toBe(true);
    expect((await f.stale()).stale).toBe(0);
  }, 120000);

  it('keeps endpoint alias checks scoped to each owning root and project', async () => {
    const server = (route: string): string => `import express from 'express';\nconst app = express();\napp.get('${route}', () => undefined);\n`;
    const f = await fixture({
      'package.json': JSON.stringify({ name: 'outer-service' }),
      'server.ts': server('/outer'),
      'inner/package.json': JSON.stringify({ name: 'inner-service' }),
      'inner/server.ts': server('/inner'),
    });
    await admin.query("UPDATE projects SET metadata = jsonb_set(metadata, '{repos}', $2::jsonb) WHERE id = $1",
      [f.projectId, JSON.stringify([f.repo, f.file('inner')])]);
    await f.build();
    const identities = (await f.rows()).filter((row) => row.kind === 'endpoint')
      .map((row) => readEndpointMetadata(row.metadata)?.service_id);
    expect(new Set(identities)).toEqual(new Set([serviceIdentity(f.repo).id, serviceIdentity(f.file('inner')).id]));
    const other = await fixture({ 'server.ts': server('/other') });
    await admin.query(`UPDATE graph_nodes SET metadata = jsonb_set(metadata, '{service_aliases}', '["stale-other"]'::jsonb)
      WHERE project_id = $1 AND kind = 'endpoint'`, [other.projectId]);
    const { tsExtractor } = await import('../graph/extractors/ts.js');
    const { pythonExtractor } = await import('../graph/extractors/python.js');
    const tsRun = vi.spyOn(tsExtractor, 'extract');
    const pyRun = vi.spyOn(pythonExtractor, 'extract');
    const before = (await f.rows()).filter((row) => row.extracted_by === 'ts').map((row) => row.id);
    await f.update();
    expect(tsRun).not.toHaveBeenCalled();
    expect(pyRun).not.toHaveBeenCalled();
    expect((await f.rows()).filter((row) => row.extracted_by === 'ts').map((row) => row.id)).toEqual(before);
  }, 120000);

  it.each(['package.json', 'composer.json', 'pyproject.toml'])('repairs endpoint aliases after %s edit/update/revert without a commit', async (manifest) => {
    const body = (name: string): string => manifest.endsWith('.toml') ? `[project]\nname = "${name}"\n` : JSON.stringify({ name });
    const f = await fixture({
      [manifest]: body('before-service'),
      'server.ts': "import express from 'express';\nconst app = express();\napp.get('/health', () => undefined);\n",
      'app.py': 'from fastapi import FastAPI\napp = FastAPI()\n@app.get("/ready")\ndef ready():\n    pass\n',
    });
    const sha = f.git('rev-parse', 'HEAD');
    for (const name of ['after-service', 'before-service']) {
      fs.writeFileSync(f.file(manifest), body(name));
      const out = await f.update();
      expect(out).toContain('full re-run — service identity manifest changed');
      const endpoints = (await f.rows()).filter((row) => row.kind === 'endpoint');
      expect(new Set(endpoints.map((row) => row.extracted_by))).toEqual(new Set(['ts', 'python']));
      for (const row of endpoints) expect(readEndpointMetadata(row.metadata)?.service_aliases).toEqual(serviceIdentity(f.repo).aliases);
      expect(endpoints.every((row) => readEndpointMetadata(row.metadata)?.service_aliases.includes(name))).toBe(true);
    }
    expect(f.git('rev-parse', 'HEAD')).toBe(sha);
  }, 120000);

  it('preserves graph rows when the Git census fails or the registered root disappears', async () => {
    const f = await fixture({ 'a.ts': 'export function alpha() {}\n' });
    const before = await f.rows();
    const index = fs.readFileSync(f.file('.git/index'));
    fs.writeFileSync(f.file('.git/index'), 'broken');
    await expect(f.update()).rejects.toThrow('census failed');
    expect(await f.rows()).toEqual(before);
    fs.writeFileSync(f.file('.git/index'), index);
    const moved = `${f.repo}-moved`;
    fs.renameSync(f.repo, moved);
    try {
      await expect(f.update()).rejects.toThrow('Registered repo root is missing');
      expect(await f.rows()).toEqual(before);
    } finally { fs.renameSync(moved, f.repo); }
  });

  it('persists parsed evidence when source changes after extraction and repairs it next time', async () => {
    const f = await fixture({ 'a.ts': 'export function alpha() {}\n' });
    const { tsExtractor } = await import('../graph/extractors/ts.js');
    const extract = tsExtractor.extract.bind(tsExtractor);
    fs.writeFileSync(f.file('a.ts'), 'export function beta() {}\n');
    vi.spyOn(tsExtractor, 'extract').mockImplementationOnce(async (input) => {
      const output = await extract(input);
      fs.writeFileSync(f.file('a.ts'), 'export function gamma() {}\n');
      return output;
    });
    await f.update();
    expect(named(await f.rows(), 'beta').content_hash).toBe(hash('export function beta() {}\n'));
    expect((await f.stale()).stale).toBeGreaterThan(0);
    await f.update();
    expect(named(await f.rows(), 'gamma')).toBeDefined();
    expect((await f.stale()).stale).toBe(0);
  }, 120000);

  it('keeps earlier extraction evidence after a later extractor fails and repairs remaining work', async () => {
    const f = await fixture({ 'a.ts': 'export function alpha() {}\n', 'a.cpp': 'int cppOld() { return 1; }\n' });
    const { cppExtractor } = await import('../graph/extractors/cpp.js');
    fs.writeFileSync(f.file('a.ts'), 'export function beta() {}\n');
    fs.writeFileSync(f.file('a.cpp'), 'int cppNew() { return 2; }\n');
    vi.spyOn(cppExtractor, 'extract').mockRejectedValueOnce(new Error('test extraction failure'));
    await expect(f.update()).rejects.toThrow('test extraction failure');
    expect(named(await f.rows(), 'beta')).toBeDefined();
    expect((await f.rows()).some((row) => row.name === 'cppOld')).toBe(true);
    expect((await f.stale()).stale).toBeGreaterThan(0);
    await f.update();
    expect((await f.rows()).some((row) => row.name === 'cppNew')).toBe(true);
    expect((await f.stale()).stale).toBe(0);
  }, 120000);
});
