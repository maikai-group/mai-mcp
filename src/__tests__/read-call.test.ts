/** build/read-call.js — one-shot JSON reads (conductor-machine-contract/2,
 * plan ea1965f1 Task 5). Disposable DB. The unit group imports the exported
 * functions (the entry guard makes import side-effect-free); the subprocess
 * group spawns the BUILT entry and proves the full exit-code taxonomy
 * (0/2/3/4/5) plus the stdout flush discriminator. Foreign-project fixtures
 * are admin-pool SQL only — in-process re-pinning is impossible (module-load
 * PROJECT_SLUG const; the 906c496f rule). */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
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
process.env.MAI_PROJECT_SLUG = 'readcall-test';
process.env.MAI_DB_URL = requireDisposableTestDbUrl();
process.env.MAI_AGENT_ID = 'readcall-tester@vitest';

const admin = new Pool({ connectionString: process.env.MAI_DB_URL });
let root: string;
let projectId: string;
let projectBId: string;
let localPlanId: string;
let emptyPlanId: string;
let localReviewId: string;
let localFindingId: string;
let foreignPlanId: string;
let foreignReviewId: string;
let foreignFindingId: string;
let foreignBoardRootId: string;
let localBoardRootId: string;
let foreignArtifactSha: string;
const NOWHERE_UUID = '99999999-9999-4999-8999-999999999999';

async function seedPlanBundle(project: string, slugSuffix: string): Promise<{ planId: string; reviewId: string; findingId: string }> {
  const { rows: plan } = await admin.query<{ id: string }>(
    `INSERT INTO plans (project_id, slug, path, title, current_sha, status)
     VALUES ($1, $2, $3, 'Fixture Plan', 'aaaa', 'reviewing') RETURNING id`,
    [project, `fixture-${slugSuffix}`, `docs/fixture-${slugSuffix}.md`]);
  const planId = plan[0].id;
  const { rows: review } = await admin.query<{ id: string }>(
    `INSERT INTO plan_reviews (plan_id, pass, kind, reviewer_agent, verdict, plan_sha, synthesis)
     VALUES ($1, 1, 'blind', 'fixture-reviewer', 'blocked', 'deadbeef', 'fixture synthesis') RETURNING id`,
    [planId]);
  const reviewId = review[0].id;
  const { rows: finding } = await admin.query<{ id: string }>(
    `INSERT INTO plan_findings (review_id, plan_id, project_id, severity, title, location, issue, evidence, fix)
     VALUES ($1, $2, $3, 'blocker', 'Fixture finding', 'Task 1', 'issue text', 'evidence text', 'fix text') RETURNING id`,
    [reviewId, planId, project]);
  return { planId, reviewId, findingId: finding[0].id };
}

beforeAll(async () => {
  await import('../db.js'); // dotenv defusal before app imports
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'readcall-'));
  await admin.query(`DELETE FROM projects WHERE slug IN ('readcall-test','readcall-test-b')`);
  const { rows: a } = await admin.query<{ id: string }>(
    `INSERT INTO projects (slug, name, path) VALUES ('readcall-test','ReadCall Test',$1) RETURNING id`,
    [path.join(root, 'a')]);
  projectId = a[0].id;
  const { rows: b } = await admin.query<{ id: string }>(
    `INSERT INTO projects (slug, name, path) VALUES ('readcall-test-b','ReadCall Test B',$1) RETURNING id`,
    [path.join(root, 'b')]);
  projectBId = b[0].id;

  const local = await seedPlanBundle(projectId, 'local');
  localPlanId = local.planId; localReviewId = local.reviewId; localFindingId = local.findingId;
  const foreign = await seedPlanBundle(projectBId, 'foreign');
  foreignPlanId = foreign.planId; foreignReviewId = foreign.reviewId; foreignFindingId = foreign.findingId;
  const { rows: empty } = await admin.query<{ id: string }>(
    `INSERT INTO plans (project_id, slug, path, title, status)
     VALUES ($1, 'fixture-empty', 'docs/fixture-empty.md', 'Empty Plan', 'draft') RETURNING id`,
    [projectId]);
  emptyPlanId = empty[0].id;

  const { rows: foreignRoot } = await admin.query<{ id: string }>(
    `INSERT INTO agent_messages (project_id, author_agent, type, status, body)
     VALUES ($1, 'foreign@test', 'note', 'open', 'foreign board root') RETURNING id`,
    [projectBId]);
  foreignBoardRootId = foreignRoot[0].id;

  const { rows: localRoot } = await admin.query<{ id: string }>(
    `INSERT INTO agent_messages (project_id, author_agent, type, status, body, created_at)
     VALUES ($1, 'local@test', 'note', 'open', 'ROOT message', '2026-08-29T09:00:00.000000Z') RETURNING id`,
    [projectId]);
  localBoardRootId = localRoot[0].id;
  for (let i = 1; i <= 5; i++) {
    await admin.query(
      `INSERT INTO agent_messages (project_id, thread_id, author_agent, type, status, body, created_at)
       VALUES ($1, $2, 'local@test', 'answer', 'open', $3, $4)`,
      [projectId, localBoardRootId, `REPLY ${i}`, `2026-08-29T09:00:0${i}.000000Z`]);
  }

  const foreignBytes = Buffer.from('foreign-only artifact body', 'utf8');
  foreignArtifactSha = createHash('sha256').update(foreignBytes).digest('hex');
  await admin.query(
    `INSERT INTO run_artifacts (project_id, kind, sha256, byte_length, content, created_by_agent, created_by_session)
     VALUES ($1, 'frozen_plan', $2, $3, $4, 'admin@test', 'admin-session')`,
    [projectBId, foreignArtifactSha, foreignBytes.byteLength, foreignBytes]);
});

afterAll(async () => {
  await admin.query(`DELETE FROM projects WHERE slug IN ('readcall-test','readcall-test-b')`);
  await admin.end();
  const { getPool } = await import('../db.js');
  await getPool().end();
  for (const [k, v] of Object.entries(saved)) {
    if (v === undefined) delete process.env[k]; else process.env[k] = v;
  }
  fs.rmSync(root, { recursive: true, force: true });
});

describe('read-call unit group', () => {
  it('import is side-effect-free and ping returns the contract identity', async () => {
    const mod = await import('../read-call.js');
    expect(process.exitCode).toBeUndefined();
    const result = await mod.ping();
    expect(result.ok).toBe(true);
    expect(result.contract).toBe('conductor-machine-contract/2');
    expect(typeof result.projectId).toBe('string');
    const build = result.build;
    if (build !== null) {
      expect(build).toMatchObject({
        version: expect.any(String), sha: expect.any(String),
        dirty: expect.any(Boolean), builtAt: expect.any(String),
      });
    }
  });

  it('plan_state: NOT_FOUND for unregistered path; full shape for a registered fixture', async () => {
    const { planState, ReadCallError } = await import('../read-call.js');
    const { EXIT } = await import('../code-findings.js');
    await expect(planState({ path: 'docs/never-registered.md' })).rejects.toMatchObject({
      constructor: ReadCallError, code: EXIT.NOT_FOUND,
    });
    const state = await planState({ path: 'docs/fixture-local.md' });
    expect(state.planId).toBe(localPlanId);
    const passes = state.passes;
    const findings = state.findings;
    expect(Array.isArray(passes) && passes.length === 1).toBe(true);
    expect(Array.isArray(findings) && findings.length === 1).toBe(true);
    if (Array.isArray(passes)) expect(passes[0]).toMatchObject({ planSha: 'deadbeef', verdict: 'blocked' });
    if (Array.isArray(findings)) expect(findings[0]).toMatchObject({ id: localFindingId, severity: 'blocker' });
  });

  it('findings: by plan_id and by ids return full rows; neither key is EXIT.VALIDATION', async () => {
    const { findingsRead, ReadCallError } = await import('../read-call.js');
    const { EXIT } = await import('../code-findings.js');
    const byPlan = await findingsRead({ plan_id: localPlanId });
    const planFindings = byPlan.findings;
    expect(Array.isArray(planFindings) && planFindings.length === 1).toBe(true);
    if (Array.isArray(planFindings)) {
      expect(planFindings[0]).toMatchObject({
        id: localFindingId, issue: 'issue text', evidence: 'evidence text', fix: 'fix text', status: 'open',
      });
    }
    const byIds = await findingsRead({ ids: [localFindingId] });
    const idFindings = byIds.findings;
    expect(Array.isArray(idFindings) && idFindings.length === 1).toBe(true);
    expect(byIds.missingIds).toEqual([]);
    await expect(findingsRead({})).rejects.toMatchObject({ constructor: ReadCallError, code: EXIT.VALIDATION });
    await expect(findingsRead({ ids: [] })).rejects.toMatchObject({ constructor: ReadCallError, code: EXIT.VALIDATION });
  });

  it('review_state returns exact identity + per-finding rows; unknown UUID is NOT_FOUND', async () => {
    const { reviewState, ReadCallError } = await import('../read-call.js');
    const { EXIT } = await import('../code-findings.js');
    const state = await reviewState({ review_id: localReviewId });
    expect(state).toMatchObject({
      reviewId: localReviewId, pass: 1, kind: 'blind', verdict: 'blocked',
      planId: localPlanId, planSha: 'deadbeef', reviewerAgent: 'fixture-reviewer',
    });
    const findings = state.findings;
    expect(Array.isArray(findings) && findings.length === 1).toBe(true);
    if (Array.isArray(findings)) expect(findings[0]).toMatchObject({ id: localFindingId, severity: 'blocker', status: 'open' });
    await expect(reviewState({ review_id: NOWHERE_UUID })).rejects.toMatchObject({
      constructor: ReadCallError, code: EXIT.NOT_FOUND,
    });
  });

  it('project mismatch matrix: foreign records exit 4, nowhere records exit 3, missingIds keeps caller tokens (e90c0156/7dcdd3f9/e4f3acff)', async () => {
    const { findingsRead, reviewState, boardThread, artifactRead } = await import('../read-call.js');
    const { EXIT } = await import('../code-findings.js');
    await expect(reviewState({ review_id: foreignReviewId })).rejects.toMatchObject({ code: EXIT.PROJECT_MISMATCH });
    await expect(findingsRead({ ids: [foreignFindingId] })).rejects.toMatchObject({ code: EXIT.PROJECT_MISMATCH });
    await expect(findingsRead({ ids: [localFindingId, foreignFindingId] })).rejects.toMatchObject({ code: EXIT.PROJECT_MISMATCH });
    await expect(findingsRead({ plan_id: foreignPlanId })).rejects.toMatchObject({ code: EXIT.PROJECT_MISMATCH });
    await expect(boardThread({ thread_id: foreignBoardRootId })).rejects.toMatchObject({ code: EXIT.PROJECT_MISMATCH });
    await expect(artifactRead({ sha256: foreignArtifactSha })).rejects.toMatchObject({ code: EXIT.PROJECT_MISMATCH });
    await expect(boardThread({ thread_id: NOWHERE_UUID })).rejects.toMatchObject({ code: EXIT.NOT_FOUND });
    await expect(artifactRead({ sha256: 'e'.repeat(64) })).rejects.toMatchObject({ code: EXIT.NOT_FOUND });
    const mixed = await findingsRead({ ids: ['BAD-Token', localFindingId.toUpperCase(), NOWHERE_UUID] });
    const rows = mixed.findings;
    expect(Array.isArray(rows) && rows.length === 1).toBe(true);
    expect(mixed.missingIds).toEqual(['BAD-Token', NOWHERE_UUID]);
    const empty = await findingsRead({ plan_id: emptyPlanId });
    expect(empty.findings).toEqual([]);
  });

  it('board_thread pages oldest-first with stream-bound cursors (caa798a7)', async () => {
    const { boardThread } = await import('../read-call.js');
    const bodies: string[] = [];
    let cursor: string | undefined;
    let pages = 0;
    for (;;) {
      const args: Record<string, unknown> = { thread_id: localBoardRootId, limit: 2 };
      if (cursor !== undefined) args.cursor = cursor;
      const page = await boardThread(args);
      pages += 1;
      const messages = page.messages;
      expect(Array.isArray(messages)).toBe(true);
      if (Array.isArray(messages)) {
        for (const m of messages) {
          if (typeof m === 'object' && m !== null && 'body' in m) bodies.push(String(m.body));
        }
      }
      if (typeof page.nextCursor === 'string') cursor = page.nextCursor;
      else break;
    }
    expect(pages).toBe(3);
    expect(bodies).toEqual(['ROOT message', 'REPLY 1', 'REPLY 2', 'REPLY 3', 'REPLY 4', 'REPLY 5']);
    const first = await boardThread({ thread_id: localBoardRootId, limit: 2 });
    await expect(boardThread({ thread_id: foreignBoardRootId, cursor: first.nextCursor }))
      .rejects.toThrow('cursor does not belong to this stream');
  });

  it('dispatch rejects unknown fns naming the roster', async () => {
    const { dispatch, ReadCallError } = await import('../read-call.js');
    const { EXIT } = await import('../code-findings.js');
    await expect(dispatch('nope', {})).rejects.toMatchObject({ constructor: ReadCallError, code: EXIT.VALIDATION });
    await expect(dispatch('nope', {})).rejects.toThrow('ping|plan_state|findings|receipts|review_state|board_thread|artifact');
  });
});

describe('read-call subprocess group', () => {
  function runReadCall(
    args: string[], envOverrides: Record<string, string>,
  ): Promise<{ code: number; stdout: string; stderr: string }> {
    return new Promise((resolve) => {
      execFile(
        process.execPath, ['build/read-call.js', ...args],
        {
          env: { ...process.env, MAI_PROJECT_ROOT: root, ...envOverrides },
          maxBuffer: 64 * 1024 * 1024, timeout: 60_000,
        },
        (error, stdout, stderr) => {
          const code = error === null ? 0 : typeof error.code === 'number' ? error.code : 1;
          resolve({ code, stdout, stderr });
        },
      );
    });
  }
  const okEnv = (): Record<string, string> => {
    const url = process.env.MAI_DB_URL;
    expect(typeof url).toBe('string');
    return { MAI_PROJECT_SLUG: 'readcall-test', MAI_DB_URL: url === undefined ? '' : url };
  };

  it('ping exits 0 with parseable JSON on stdout', async () => {
    const result = await runReadCall(['ping'], okEnv());
    expect(result.code).toBe(0);
    const parsed: unknown = JSON.parse(result.stdout);
    expect(parsed).toMatchObject({ ok: true, contract: 'conductor-machine-contract/2' });
  });

  it('flush discriminator: a >256KiB receipts page arrives complete with exit 0', async () => {
    const bulk = 'R'.repeat(1400);
    const values: string[] = [];
    const params: (string | number)[] = [projectId];
    for (let i = 0; i < 300; i++) {
      const payload = JSON.stringify({
        receiptKey: `flush-${i}`, kind: 'result', cycleId: 'flush-cycle',
        schemaVersion: 'conductor/1', bulk,
      });
      const sha = createHash('sha256').update(payload, 'utf8').digest('hex');
      const base = params.length;
      params.push(`flush-${i}`, payload, sha);
      values.push(`($1, $${base + 1}, 'result', 'flush-cycle', 'conductor/1', $${base + 2}, $${base + 3}, 'admin@test', 'admin-session')`);
    }
    await admin.query(
      `INSERT INTO run_receipts (project_id, receipt_key, kind, cycle_id, schema_version, payload, payload_sha256, created_by_agent, created_by_session)
       VALUES ${values.join(',')}`, params);
    const result = await runReadCall(['receipts', JSON.stringify({ cycle_id: 'flush-cycle', limit: 200 })], okEnv());
    expect(result.code).toBe(0);
    expect(result.stdout.length).toBeGreaterThan(256 * 1024);
    const parsed: unknown = JSON.parse(result.stdout);
    expect(parsed).toMatchObject({ nextCursor: expect.any(String) });
  }, 60_000);

  it('malformed JSON, unknown fn, unregistered plan, and foreign review map to 2/2/3/4', async () => {
    const badJson = await runReadCall(['receipts', '{not-json'], okEnv());
    expect(badJson.code).toBe(2);
    expect(badJson.stdout).toBe('');
    const badFn = await runReadCall(['nope', '{}'], okEnv());
    expect(badFn.code).toBe(2);
    const missingPlan = await runReadCall(['plan_state', JSON.stringify({ path: 'docs/never.md' })], okEnv());
    expect(missingPlan.code).toBe(3);
    const foreign = await runReadCall(['review_state', JSON.stringify({ review_id: foreignReviewId })], okEnv());
    expect(foreign.code).toBe(4);
  }, 60_000);

  it('pin gate: empty and malformed slugs exit 2 before any DB access (c2901e76/c7e69e38)', async () => {
    const emptySlug = await runReadCall(['ping'], {
      MAI_PROJECT_SLUG: '', MAI_DB_URL: 'postgresql://nobody@127.0.0.1:1/unreachable',
    });
    expect(emptySlug.code).toBe(2);
    expect(emptySlug.stdout).toBe('');
    expect(emptySlug.stderr).toContain('MAI_PROJECT_SLUG is missing, empty, or not lowercase kebab-case');
    const badSlug = await runReadCall(['ping'], { ...okEnv(), MAI_PROJECT_SLUG: 'Bad_Slug' });
    expect(badSlug.code).toBe(2);
    expect(badSlug.stdout).toBe('');
  }, 60_000);

  it('db failure exits 5', async () => {
    const result = await runReadCall(['ping'], {
      MAI_PROJECT_SLUG: 'readcall-test', MAI_DB_URL: 'postgresql://nobody@127.0.0.1:59999/closed',
    });
    expect(result.code).toBe(5);
    expect(result.stdout).toBe('');
  }, 60_000);
});
