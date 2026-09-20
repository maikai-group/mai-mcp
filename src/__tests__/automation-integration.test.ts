import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Pool } from 'pg';
import { requireDisposableTestDbUrl } from './test-db-url.js';
import { applySchema, MAX_AUTOMATION_OUTPUT } from '../automation.js';

const DB = requireDisposableTestDbUrl();
const admin = new Pool({ connectionString: DB });
const PREFIX = 'automation-test';
const entry = path.resolve('build/entry.js');
const contract = 'mai-automation-contract/1';
let root: string;
let repo: string;
let other: string;
let transcript: string;
let initialFiles: Record<string, string>;
interface Run { code: number; stdout: string; stderr: string; elapsed: number }
function child(args: string[], env: NodeJS.ProcessEnv = {}): Promise<Run> {
  const started = Date.now();
  return new Promise((resolve, reject) => {
    execFile(process.execPath, args, { timeout: 30000, maxBuffer: 64 * 1024,
      env: { ...process.env, MAI_DB_URL: DB, MAI_PROJECT_SLUG: PREFIX,
        MAI_LLM_SUMMARY: '0', MAI_EMBEDDINGS: '0', HOME: root, CODEX_HOME: path.join(root, '.codex'), ...env } },
    (error, stdout, stderr) => {
      if (error?.killed || error?.signal) { reject(error); return; }
      const code = error === null ? 0 : typeof error.code === 'number' ? error.code : -1;
      resolve({ code, stdout, stderr, elapsed: Date.now() - started });
    });
  });
}
const cli = (args: string[], env: NodeJS.ProcessEnv = {}) => child([entry, ...args], env);
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
function json(result: Run, code = 0): Record<string, unknown> {
  expect(result.code, result.stderr + result.stdout).toBe(code);
  expect(Buffer.byteLength(result.stdout)).toBeLessThanOrEqual(MAX_AUTOMATION_OUTPUT);
  expect(Buffer.byteLength(result.stderr)).toBeLessThanOrEqual(MAX_AUTOMATION_OUTPUT);
  expect(result.stdout.trim().split('\n')).toHaveLength(1);
  const parsed: unknown = JSON.parse(result.stdout);
  if (!isRecord(parsed)) throw new Error('not an object');
  return parsed;
}
function files(directory: string): Record<string, string> {
  const result: Record<string, string> = {};
  const walk = (dir: string) => {
    for (const name of fs.readdirSync(dir)) {
      const full = path.join(dir, name);
      if (fs.lstatSync(full).isDirectory()) walk(full);
      else result[path.relative(directory, full)] = fs.readFileSync(full).toString('base64');
    }
  };
  walk(directory);
  return result;
}
function rollout(file: string, cwd = repo, id = randomUUID()): string {
  fs.writeFileSync(file, [
    { type: 'session_meta', payload: { id, cwd } },
    { type: 'response_item', timestamp: '2026-09-19T10:00:00Z',
      payload: { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'fixture response' }] } },
  ].map(value => JSON.stringify(value)).join('\n') + '\n');
  return id;
}
const ensure = (slug = PREFIX, directory = repo) => cli(['projects', 'ensure', '--slug', slug, '--root', directory, '--json']);
const ingest = (file = transcript, env: NodeJS.ProcessEnv = {}) => cli(['ingest', '--transcript', file, '--harness', 'codex', '--json'], env);
async function isolatedDatabase(work: (url: string, pool: Pool) => Promise<void>): Promise<void> {
  const name = 'mai_plan23_automation_' + randomUUID().replaceAll('-', '');
  const url = new URL(DB); url.pathname = '/' + name;
  await admin.query(`CREATE DATABASE "${name}"`);
  const pool = new Pool({ connectionString: url.href });
  try { await work(url.href, pool); }
  finally {
    await pool.end();
    await admin.query('SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname=$1', [name]);
    await admin.query(`DROP DATABASE "${name}"`);
  }
}
beforeAll(async () => {
  root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'mai-automation-test-')));
  repo = path.join(root, 'repo'); other = path.join(root, 'other');
  fs.mkdirSync(repo); fs.mkdirSync(other);
  for (const name of ['.mcp.json', '.claude/settings.json', '.codex/config.toml', 'AGENTS.md', 'CLAUDE.md', 'file.txt']) {
    const full = path.join(repo, name); fs.mkdirSync(path.dirname(full), { recursive: true }); fs.writeFileSync(full, 'sentinel:' + name);
  }
  initialFiles = files(repo);
  await admin.query('DELETE FROM projects WHERE starts_with(slug,$1)', [PREFIX]);
  const existingProjects = (await admin.query('SELECT id,slug,path,metadata FROM projects ORDER BY id')).rows;
  const adoption = json(await cli(['database', 'ensure', '--json']));
  expect(adoption.changed).toBe(true);
  expect(json(await cli(['database', 'ensure', '--json']))).toEqual({ ...adoption, changed: false });
  expect((await admin.query('SELECT id,slug,path,metadata FROM projects ORDER BY id')).rows).toEqual(existingProjects);
  transcript = path.join(root, 'rollout.jsonl');
});
afterAll(async () => {
  await admin.query('DELETE FROM projects WHERE starts_with(slug,$1)', [PREFIX]);
  await admin.end();
  if (root) fs.rmSync(root, { recursive: true, force: true });
});

describe('automation public subprocess contract', () => {
  it('discovers the existing build without a database or project pin', async () => {
    const result = json(await cli(['capabilities', '--json'], { MAI_DB_URL: '', MAI_PROJECT_SLUG: '' }));
    expect(Object.keys(result).sort()).toEqual(['build', 'contract', 'ok', 'operations', 'readContract']);
    expect(result).toMatchObject({ ok: true, contract, readContract: 'conductor-machine-contract/2',
      operations: ['database_ensure', 'project_ensure', 'targeted_ingest'] });
    expect(result.build).toEqual(JSON.parse(fs.readFileSync('build/build-info.json', 'utf8')));
    expect(Object.keys(Object(result.build)).sort()).toEqual(['builtAt', 'dirty', 'sha', 'version']);
  });
  it.each([
    ['capabilities', '--json', '--json'], ['database', 'drop', '--json'],
    ['capabilities', '--json=false'], ['projects', 'ensure', '--slug', 'x', '--json'],
    ['ingest', '--scan', '--json'], ['ingest', '--transcript', '/x', '--harness', 'claude-code', '--json'],
    ['database', 'ensure', '--json', '--unknown'],
  ])('rejects malformed arguments without raw errors: %j', async (...args) => {
    expect(json(await cli(args), 2)).toEqual({ ok: false, contract, error: 'validation', message: 'Invalid automation arguments' });
  });
  it('requires an explicit URL', async () => {
    for (const args of [ ['database', 'ensure', '--json'],
      ['projects', 'ensure', '--slug', PREFIX, '--root', repo, '--json'],
      ['ingest', '--transcript', transcript, '--harness', 'codex', '--json'] ]) {
      expect(json(await cli(args, { MAI_DB_URL: '' }), 2).error).toBe('validation');
    }
    expect(json(await cli(['database', 'ensure', '--json'], { MAI_DB_URL: 'not-a-url' }), 2).error).toBe('validation');
  });
  it('skips a real isolated checkout dotenv for both automation entry names', async () => {
    const fixture = path.join(root, 'dotenv-fixture');
    const build = path.join(fixture, 'build');
    fs.mkdirSync(build, { recursive: true });
    fs.writeFileSync(path.join(fixture, 'package.json'), '{"type":"module"}\n');
    fs.writeFileSync(path.join(fixture, '.env'), 'MAI_DB_URL=checkout-db-canary\nAUTOMATION_ENV_CANARY=checkout-canary\n');
    fs.symlinkSync(path.resolve('node_modules'), path.join(fixture, 'node_modules'), process.platform === 'win32' ? 'junction' : 'dir');
    for (const name of ['env.js', 'automation-command.js']) fs.copyFileSync(path.resolve('build', name), path.join(build, name));
    const entrySource = `import './env.js'; console.log(JSON.stringify({db:process.env.MAI_DB_URL??null,canary:process.env.AUTOMATION_ENV_CANARY??null}));`;
    try {
      for (const name of ['entry.js', 'cli.js']) {
        const script = path.join(build, name); fs.writeFileSync(script, entrySource);
        // Omit keys only in this isolated child; the user's checkout .env is never touched.
        const env = { MAI_DB_URL: undefined, AUTOMATION_ENV_CANARY: undefined };
        expect(json(await child([script, 'database', 'ensure', '--json'], env))).toEqual({ db: null, canary: null });
        expect(json(await child([script, 'projects'], env))).toEqual({ db: 'checkout-db-canary', canary: 'checkout-canary' });
      }
    } finally { fs.rmSync(fixture, { recursive: true, force: true }); }
  });
  it('reports infrastructure failure without the credential canary', async () => {
    const url = new URL(DB); url.port = '1'; url.password = 'automation-credential-canary';
    const result = await cli(['database', 'ensure', '--json'], { MAI_DB_URL: url.href });
    expect(json(result, 5).error).toBe('infrastructure');
    expect(result.stdout + result.stderr).not.toContain('automation-credential-canary');
  });
  it('bootstraps a truly empty database then performs a stable no-op', async () => {
    await isolatedDatabase(async (url, pool) => {
      const first = json(await cli(['database', 'ensure', '--json'], { MAI_DB_URL: url }));
      const second = json(await cli(['database', 'ensure', '--json'], { MAI_DB_URL: url }));
      expect(Object.keys(first).sort()).toEqual(['changed', 'contract', 'ok', 'schemaVersion']);
      expect(first).toMatchObject({ ok: true, contract, changed: true });
      expect(first.schemaVersion).toMatch(/^sha256:[a-f0-9]{64}$/);
      expect(second).toEqual({ ...first, changed: false });
      expect((await pool.query("SELECT to_regclass('public.graph_code_embeddings') AS name")).rows[0].name).toBe('graph_code_embeddings');
    });
  });
  it('rolls back failed producer SQL and validates boundaries before mutation', async () => {
    await isolatedDatabase(async (_url, pool) => {
      const baseline = [{ name: 'db/schema.sql', sql: 'CREATE TABLE projects(id integer);' }];
      await expect(applySchema(pool, [...baseline, { name: 'fail.sql', sql: 'CREATE TABLE first_effect(id integer); SELECT missing_column;' }])).rejects.toThrow();
      expect((await pool.query("SELECT to_regclass('public.projects') AS p,to_regclass('public.first_effect') AS f,to_regclass('public.mai_automation_schema') AS m")).rows[0])
        .toEqual({ p: null, f: null, m: null });
      await expect(applySchema(pool, [...baseline, { name: 'bad.sql', sql: 'SELECT 1;\nCOMMIT;' }])).rejects.toThrow('transaction boundary');
      expect((await applySchema(pool, baseline)).changed).toBe(true);
      expect((await applySchema(pool, baseline)).changed).toBe(false);
    });
  });
  it('registers and retries without modifying any project/harness bytes', async () => {
    const before = files(root);
    const first = json(await ensure());
    expect(Object.keys(first).sort()).toEqual(['changed', 'graph', 'ok', 'projectId', 'root', 'slug']);
    expect(first).toMatchObject({ ok: true, slug: PREFIX, root: repo, changed: true, graph: 'deferred' });
    expect(json(await ensure())).toEqual({ ...first, changed: false });
    expect(files(root)).toEqual(before);
    expect(files(repo)).toEqual(initialFiles);
    expect(json(await ensure(PREFIX, other), 4).error).toBe('project_mismatch');
    expect(files(root)).toEqual(before);
  });
  it('preserves existing harness and custom metadata byte-for-byte', async () => {
    await admin.query(`UPDATE projects SET metadata=metadata||$2::jsonb WHERE slug=$1`,
      [PREFIX, JSON.stringify({ capture_harnesses: ['codex'], custom: { keep: true } })]);
    const before = (await admin.query('SELECT metadata,last_active_at FROM projects WHERE slug=$1', [PREFIX])).rows;
    expect(json(await ensure()).changed).toBe(false);
    expect((await admin.query('SELECT metadata,last_active_at FROM projects WHERE slug=$1', [PREFIX])).rows).toEqual(before);
  });
  it('rejects missing, relative, noncanonical, and non-directory roots without inserting', async () => {
    expect(json(await ensure(PREFIX + '-bad', path.join(root, 'missing')), 3).error).toBe('not_found');
    expect(json(await ensure(PREFIX + '-bad', 'relative'), 2).error).toBe('validation');
    expect(json(await ensure(PREFIX + '-bad', path.join(repo, 'file.txt')), 2).error).toBe('validation');
    const alias = path.join(root, 'alias'); fs.symlinkSync(repo, alias, process.platform === 'win32' ? 'junction' : 'dir');
    try { expect(json(await ensure(PREFIX + '-bad', alias), 2).error).toBe('validation'); }
    finally { fs.unlinkSync(alias); }
    expect((await admin.query('SELECT id FROM projects WHERE slug=$1', [PREFIX + '-bad'])).rows).toHaveLength(0);
  });
  it('ingests one exact transcript and replays without scanning or provider work', async () => {
    const id = rollout(transcript);
    const decoy = path.join(root, 'decoy.jsonl'); const decoyId = rollout(decoy);
    const before = files(root);
    const first = json(await ingest(transcript, { MAI_LLM_SUMMARY: '1', MAI_LLM_PROVIDER: 'openai', OPENAI_API_KEY: 'automation-provider-canary' }));
    expect(Object.keys(first).sort()).toEqual(['fullReingest', 'ok', 'segmentsPersisted', 'status', 'transcriptId']);
    expect(first).toMatchObject({ ok: true, status: 'ingested', transcriptId: id, fullReingest: true });
    expect(first.segmentsPersisted).toBeGreaterThan(0);
    const sessions = (await admin.query('SELECT id,original_session_id,message_count FROM code_sessions WHERE starts_with(original_session_id,$1)', [id])).rows;
    const watermarks = (await admin.query('SELECT project_id,transcript_path,open_seq,open_start_offset,ingested_mtime_ms,file_size_bytes FROM transcript_watermarks WHERE transcript_path=$1', [transcript])).rows;
    expect(json(await ingest())).toEqual({ ok: true, status: 'unchanged', transcriptId: id, fullReingest: false, segmentsPersisted: 0 });
    expect((await admin.query('SELECT id,original_session_id,message_count FROM code_sessions WHERE starts_with(original_session_id,$1)', [id])).rows).toEqual(sessions);
    expect((await admin.query('SELECT project_id,transcript_path,open_seq,open_start_offset,ingested_mtime_ms,file_size_bytes FROM transcript_watermarks WHERE transcript_path=$1', [transcript])).rows).toEqual(watermarks);
    expect((await admin.query('SELECT id FROM code_sessions WHERE starts_with(original_session_id,$1)', [decoyId])).rows).toHaveLength(0);
    expect((await admin.query('SELECT id FROM code_decisions WHERE project_id=(SELECT id FROM projects WHERE slug=$1)', [PREFIX])).rows).toHaveLength(0);
    expect(files(root)).toEqual(before);
  });
  it('fails closed on foreign cwd, missing project/file, malformed metadata and bad pin', async () => {
    const counts = async () => (await admin.query('SELECT (SELECT count(*) FROM code_sessions) AS sessions,(SELECT count(*) FROM transcript_watermarks) AS watermarks')).rows;
    const before = await counts();
    const file = path.join(root, 'foreign.jsonl'); rollout(file, other);
    expect(json(await ingest(file), 4).error).toBe('project_mismatch');
    expect(json(await ingest(transcript, { MAI_PROJECT_SLUG: PREFIX + '-unknown' }), 3).error).toBe('not_found');
    expect(json(await ingest(path.join(root, 'absent.jsonl')), 3).error).toBe('not_found');
    for (const pin of ['', 'BAD']) expect(json(await ingest(transcript, { MAI_PROJECT_SLUG: pin }), 2).error).toBe('validation');
    fs.writeFileSync(file, 'not json');
    expect(json(await ingest(file), 2).error).toBe('validation');
    expect(await counts()).toEqual(before);
  });
  it('never updates a foreign session with a colliding global transcript id', async () => {
    json(await ensure(PREFIX + '-foreign', other));
    const file = path.join(root, 'collision.jsonl'); const id = rollout(file);
    await admin.query(`INSERT INTO code_sessions(project_id,original_session_id,message_count)
      SELECT id,$2,123 FROM projects WHERE slug=$1`, [PREFIX + '-foreign', id + '#0']);
    const before = (await admin.query('SELECT * FROM code_sessions WHERE original_session_id=$1', [id + '#0'])).rows;
    expect(json(await ingest(file), 4).error).toBe('project_mismatch');
    expect((await admin.query('SELECT * FROM code_sessions WHERE original_session_id=$1', [id + '#0'])).rows).toEqual(before);
  });
  it('preserves human output and the existing one-shot read contract', async () => {
    expect((await cli(['--help'])).stdout).toContain('Usage: mai');
    expect((await cli(['projects'])).stdout).toContain(PREFIX);
    const human = await cli(['ingest', '--transcript', transcript, '--harness', 'codex']);
    expect(human.code).toBe(0); expect(human.stdout).toContain('ingested 0 segment(s)');
    const read = await child([path.resolve('build/read-call.js'), 'ping', '{}']);
    expect(json(read)).toMatchObject({ ok: true, contract: 'conductor-machine-contract/2' });
  });
  it('clears the production deadline on immediate success and drains naturally', async () => {
    const result = await child(['--input-type=module', '-e', `
      import {runAutomation} from './build/automation.js';
      await runAutomation(['database','ensure','--json'],{
        timeoutMs:900000,close:async()=>{},execute:async()=>({ok:true,contract:'mai-automation-contract/1',changed:false,schemaVersion:'fixture'})
      });`]);
    expect(json(result).ok).toBe(true);
    expect(result.elapsed).toBeLessThan(1500);
  });
  it('emits no second JSON when a timed-out operation resolves during cleanup', async () => {
    const result = await child(['--input-type=module', '-e', `
      import {runAutomation} from './build/automation.js';
      let task;
      await runAutomation(['database','ensure','--json'],{
        timeoutMs:20,close:async()=>{await task;},execute:()=>task=new Promise(resolve=>setTimeout(()=>resolve({ok:true,contract:'mai-automation-contract/1',changed:false,schemaVersion:'fixture'}),100))
      });`]);
    expect(json(result, 5)).toEqual({ ok: false, contract, error: 'infrastructure', message: 'Automation deadline exceeded' });
  });
  it('bounds timeout diagnostics, process exit and owned database work', async () => {
    const app = 'automation-timeout-' + randomUUID();
    const result = await child(['--input-type=module', '-e', `
      import {Pool} from 'pg';
      import {runAutomation} from './build/automation.js';
      const pool=new Pool({connectionString:process.env.MAI_DB_URL,application_name:process.env.AUTOMATION_TEST_APP,statement_timeout:6000});
      await runAutomation(['database','ensure','--json'],{
        timeoutMs:50,close:async()=>{await pool.end();},execute:async()=>{
          const client=await pool.connect();
          try{await client.query('BEGIN');await client.query('CREATE TABLE automation_timeout_effect(id integer)');
            for(let i=0;i<100;i++)console.error('diagnostic'.repeat(100));
            await client.query('SELECT pg_sleep(30)');
            return {ok:true,contract:'mai-automation-contract/1',changed:false,schemaVersion:'fixture'};
          }finally{client.release(true);}
        }
      });`], { AUTOMATION_TEST_APP: app });
    expect(json(result, 5).message).toBe('Automation deadline exceeded');
    expect(result.stderr.length).toBeGreaterThan(0);
    expect(result.elapsed).toBeGreaterThanOrEqual(2000);
    expect(result.elapsed).toBeLessThan(5000);
    // PostgreSQL may notice the disconnected socket only when its statement ends.
    for (let attempt = 0; attempt < 80; attempt++) {
      if ((await admin.query('SELECT pid FROM pg_stat_activity WHERE application_name=$1', [app])).rows.length === 0) break;
      await new Promise(resolve => setTimeout(resolve, 100));
    }
    expect((await admin.query('SELECT pid FROM pg_stat_activity WHERE application_name=$1', [app])).rows).toHaveLength(0);
    expect((await admin.query("SELECT to_regclass('public.automation_timeout_effect') AS effect")).rows[0].effect).toBeNull();
  });
});
