/** run_receipts ledger (conductor-machine-contract/2, plan ea1965f1 Task 2).
 * Disposable DB throughout — the validated test variable can never point at
 * the live 54334 mai_brain. Foreign-project fixtures are written via the admin
 * pool, never via the domain functions: in-process re-pinning is impossible
 * (PROJECT_SLUG is a module-load const; __resetProjectIdCacheForTests clears
 * only the memoized project UUID — the 906c496f rule). */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createHash } from 'node:crypto';
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
process.env.MAI_PROJECT_SLUG = 'receipts-test';
process.env.MAI_DB_URL = requireDisposableTestDbUrl();
process.env.MAI_AGENT_ID = 'receipts-tester@vitest';

const admin = new Pool({ connectionString: process.env.MAI_DB_URL });
let root: string;
let projectId: string;
let projectBId: string;

function receiptOf(receiptKey: string, extra: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    receiptKey,
    kind: 'result',
    cycleId: 'cycle-a',
    schemaVersion: 'conductor/1',
    ...extra,
  };
}

async function rowCount(key: string): Promise<number> {
  const { rows } = await admin.query<{ n: string }>(
    'SELECT count(*) AS n FROM run_receipts WHERE receipt_key = $1', [key]);
  return Number(rows[0].n);
}

async function seedForeignReceipt(cycleId: string, key: string): Promise<{ id: string; cursorTs: string }> {
  const payload = { receiptKey: key, kind: 'result', cycleId, schemaVersion: 'conductor/1' };
  const json = JSON.stringify(payload);
  const sha = createHash('sha256').update(json, 'utf8').digest('hex');
  const { rows } = await admin.query<{ id: string; cursor_ts: string }>(
    `INSERT INTO run_receipts
       (project_id, receipt_key, kind, cycle_id, schema_version, payload, payload_sha256,
        created_by_agent, created_by_session)
     VALUES ($1,$2,'result',$3,'conductor/1',$4,$5,'admin@test','admin-session')
     RETURNING id, to_char(created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS cursor_ts`,
    [projectBId, key, cycleId, json, sha]);
  return { id: rows[0].id, cursorTs: rows[0].cursor_ts };
}

beforeAll(async () => {
  await import('../db.js'); // dotenv defusal before app imports
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'receipts-'));
  await admin.query(`DELETE FROM projects WHERE slug IN ('receipts-test','receipts-test-b')`);
  const { rows: a } = await admin.query<{ id: string }>(
    `INSERT INTO projects (slug, name, path) VALUES ('receipts-test','Receipts Test',$1) RETURNING id`,
    [path.join(root, 'a')]);
  projectId = a[0].id;
  const { rows: b } = await admin.query<{ id: string }>(
    `INSERT INTO projects (slug, name, path) VALUES ('receipts-test-b','Receipts Test B',$1) RETURNING id`,
    [path.join(root, 'b')]);
  projectBId = b[0].id;
});

afterAll(async () => {
  await admin.query(`DELETE FROM projects WHERE slug IN ('receipts-test','receipts-test-b')`);
  await admin.end();
  const { getPool } = await import('../db.js');
  await getPool().end();
  for (const [k, v] of Object.entries(saved)) {
    if (v === undefined) delete process.env[k]; else process.env[k] = v;
  }
  fs.rmSync(root, { recursive: true, force: true });
});

beforeEach(async () => {
  const { __resetProjectIdCacheForTests } = await import('../db.js');
  __resetProjectIdCacheForTests();
  await admin.query('DELETE FROM run_receipts WHERE project_id IN ($1, $2)', [projectId, projectBId]);
  await admin.query('DELETE FROM plans WHERE project_id IN ($1, $2)', [projectId, projectBId]);
});

describe('receiptAdd', () => {
  it('insert returns ok with duplicate false and a UUID id', async () => {
    const { receiptAdd } = await import('../receipts.js');
    const result = await receiptAdd({ receipt: receiptOf('k-insert') });
    expect(result.ok).toBe(true);
    expect(result.duplicate).toBe(false);
    expect(result.id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
  });

  it('byte-identical replay returns duplicate true with the same id and row count 1', async () => {
    const { receiptAdd } = await import('../receipts.js');
    const first = await receiptAdd({ receipt: receiptOf('k-replay') });
    const second = await receiptAdd({ receipt: receiptOf('k-replay') });
    expect(second.duplicate).toBe(true);
    expect(second.id).toBe(first.id);
    expect(await rowCount('k-replay')).toBe(1);
  });

  it('same receiptKey with a changed payload throws ReceiptConflictError and leaves the row unchanged', async () => {
    const { receiptAdd, ReceiptConflictError } = await import('../receipts.js');
    await receiptAdd({ receipt: receiptOf('k-conflict', { note: 'original' }) });
    const { rows: before } = await admin.query<{ payload_sha256: string }>(
      'SELECT payload_sha256 FROM run_receipts WHERE receipt_key = $1', ['k-conflict']);
    await expect(receiptAdd({ receipt: receiptOf('k-conflict', { note: 'DIVERGENT' }) }))
      .rejects.toBeInstanceOf(ReceiptConflictError);
    const { rows: after } = await admin.query<{ payload_sha256: string }>(
      'SELECT payload_sha256 FROM run_receipts WHERE receipt_key = $1', ['k-conflict']);
    expect(after).toHaveLength(1);
    expect(after[0].payload_sha256).toBe(before[0].payload_sha256);
  });

  it('consumer-vocabulary kinds all insert', async () => {
    const { receiptAdd } = await import('../receipts.js');
    const kinds = ['cycle_start', 'freeze', 'dispatch', 'delivery', 'result', 'park', 'decision', 'approval_committed'];
    for (const kind of kinds) {
      const result = await receiptAdd({ receipt: receiptOf(`k-kind-${kind}`, { kind }) });
      expect(result.duplicate).toBe(false);
    }
  });

  it('shape violations throw ReceiptValidationError; pass null is accepted', async () => {
    const { receiptAdd, ReceiptValidationError } = await import('../receipts.js');
    const cases: unknown[] = [
      { receipt: receiptOf('k-bad-kind', { kind: 'Bad-Kind' }) },
      { receipt: receiptOf('k-oversize', { filler: 'x'.repeat(262_200) }) },
      { receipt: { receiptKey: 'k-no-cycle', kind: 'result', schemaVersion: 'conductor/1' } },
      { receipt: receiptOf('k-pass-zero', { pass: 0 }) },
      { receipt: receiptOf('k-unknown-top'), extra: 1 },
      { receipt: receiptOf('k'.repeat(257)) },
    ];
    for (const bad of cases) {
      await expect(receiptAdd(bad)).rejects.toBeInstanceOf(ReceiptValidationError);
    }
    const ok = await receiptAdd({ receipt: receiptOf('k-pass-null', { pass: null }) });
    expect(ok.duplicate).toBe(false);
  });

  it('planId links loudly: invalid/null/unregistered rejected, uppercase normalized, omission stores NULL', async () => {
    const { receiptAdd, receiptsQuery, ReceiptValidationError } = await import('../receipts.js');
    const { rows: planRows } = await admin.query<{ id: string }>(
      `INSERT INTO plans (project_id, slug, path, title) VALUES ($1,'receipt-fixture','docs/fixture.md','Fixture') RETURNING id`,
      [projectId]);
    const planUuid = planRows[0].id;
    await expect(receiptAdd({ receipt: receiptOf('k-plan-bad', { planId: 'not-a-uuid' }) }))
      .rejects.toBeInstanceOf(ReceiptValidationError);
    await expect(receiptAdd({ receipt: receiptOf('k-plan-null', { planId: null }) }))
      .rejects.toBeInstanceOf(ReceiptValidationError);
    await expect(receiptAdd({ receipt: receiptOf('k-plan-unreg', { planId: '00000000-0000-4000-8000-000000000000' }) }))
      .rejects.toBeInstanceOf(ReceiptValidationError);
    const upper = await receiptAdd({ receipt: receiptOf('k-plan-upper', { planId: planUuid.toUpperCase() }) });
    const { rows: linked } = await admin.query<{ plan_id: string }>(
      'SELECT plan_id FROM run_receipts WHERE receipt_key = $1', ['k-plan-upper']);
    expect(upper.duplicate).toBe(false);
    expect(linked[0].plan_id).toBe(planUuid);
    await receiptAdd({ receipt: receiptOf('k-plan-omitted', { cycleId: 'cycle-omit' }) });
    const { rows: nulled } = await admin.query<{ plan_id: string | null }>(
      'SELECT plan_id FROM run_receipts WHERE receipt_key = $1', ['k-plan-omitted']);
    expect(nulled[0].plan_id).toBeNull();
    const page = await receiptsQuery({ cycle_id: 'cycle-omit' });
    expect(page.receipts).toHaveLength(1);
    expect(page.receipts[0].receiptKey).toBe('k-plan-omitted');
  });

  it('deleting the plan SET-NULLs plan_id and the receipt row survives', async () => {
    const { receiptAdd } = await import('../receipts.js');
    const { rows: planRows } = await admin.query<{ id: string }>(
      `INSERT INTO plans (project_id, slug, path, title) VALUES ($1,'receipt-del','docs/del.md','Del') RETURNING id`,
      [projectId]);
    await receiptAdd({ receipt: receiptOf('k-plan-del', { planId: planRows[0].id }) });
    await admin.query('DELETE FROM plans WHERE id = $1', [planRows[0].id]);
    const { rows } = await admin.query<{ plan_id: string | null }>(
      'SELECT plan_id FROM run_receipts WHERE receipt_key = $1', ['k-plan-del']);
    expect(rows).toHaveLength(1);
    expect(rows[0].plan_id).toBeNull();
  });

  it('replay after plan deletion succeeds as a no-op; divergent payload still conflicts (6d3e56fe)', async () => {
    const { receiptAdd, ReceiptConflictError } = await import('../receipts.js');
    const { rows: planRows } = await admin.query<{ id: string }>(
      `INSERT INTO plans (project_id, slug, path, title) VALUES ($1,'receipt-replay-del','docs/rd.md','RD') RETURNING id`,
      [projectId]);
    const receipt = receiptOf('k-replay-after-del', { planId: planRows[0].id });
    const first = await receiptAdd({ receipt });
    await admin.query('DELETE FROM plans WHERE id = $1', [planRows[0].id]);
    const replay = await receiptAdd({ receipt });
    expect(replay.duplicate).toBe(true);
    expect(replay.id).toBe(first.id);
    await expect(receiptAdd({ receipt: { ...receipt, note: 'DIVERGENT' } }))
      .rejects.toBeInstanceOf(ReceiptConflictError);
  });
});

describe('receiptsQuery paging', () => {
  it('keyset paging walks 5 receipts as [1,2] [3,4] [5], oldest-first, final cursor null', async () => {
    const { receiptAdd, receiptsQuery } = await import('../receipts.js');
    for (let i = 1; i <= 5; i++) {
      await receiptAdd({ receipt: receiptOf(`k-page-${i}`, { cycleId: 'cycle-page', seq: i }) });
      await admin.query(
        `UPDATE run_receipts SET created_at = $1::timestamptz WHERE receipt_key = $2`,
        [`2026-08-29T10:00:0${i}.000000Z`, `k-page-${i}`]);
    }
    const page1 = await receiptsQuery({ cycle_id: 'cycle-page', limit: 2 });
    expect(page1.receipts.map((r) => r.seq)).toEqual([1, 2]);
    expect(page1.nextCursor).not.toBeNull();
    const page2 = await receiptsQuery({ cycle_id: 'cycle-page', limit: 2, cursor: page1.nextCursor });
    expect(page2.receipts.map((r) => r.seq)).toEqual([3, 4]);
    expect(page2.nextCursor).not.toBeNull();
    const page3 = await receiptsQuery({ cycle_id: 'cycle-page', limit: 2, cursor: page2.nextCursor });
    expect(page3.receipts.map((r) => r.seq)).toEqual([5]);
    expect(page3.nextCursor).toBeNull();
  });

  it('cursor timestamps are microsecond-exact: a +1µs boundary row is served exactly once (60753c12)', async () => {
    const { receiptAdd, receiptsQuery } = await import('../receipts.js');
    await receiptAdd({ receipt: receiptOf('k-micro-1', { cycleId: 'cycle-micro', seq: 1 }) });
    await receiptAdd({ receipt: receiptOf('k-micro-2', { cycleId: 'cycle-micro', seq: 2 }) });
    await admin.query(
      `UPDATE run_receipts SET created_at = '2026-08-29T12:00:00.123456Z'::timestamptz WHERE receipt_key = 'k-micro-1'`);
    await admin.query(
      `UPDATE run_receipts SET created_at = '2026-08-29T12:00:00.123457Z'::timestamptz WHERE receipt_key = 'k-micro-2'`);
    const page1 = await receiptsQuery({ cycle_id: 'cycle-micro', limit: 1 });
    expect(page1.receipts.map((r) => r.seq)).toEqual([1]);
    expect(page1.nextCursor).not.toBeNull();
    const page2 = await receiptsQuery({ cycle_id: 'cycle-micro', limit: 1, cursor: page1.nextCursor });
    expect(page2.receipts.map((r) => r.seq)).toEqual([2]);
    expect(page2.nextCursor).toBeNull();
  });

  it('cursors are stream-bound: a cycle-A cursor is rejected on cycle B and on a plan stream', async () => {
    const { receiptAdd, receiptsQuery } = await import('../receipts.js');
    for (let i = 1; i <= 2; i++) {
      await receiptAdd({ receipt: receiptOf(`k-bind-${i}`, { cycleId: 'cycle-bind-a', seq: i }) });
    }
    const page = await receiptsQuery({ cycle_id: 'cycle-bind-a', limit: 1 });
    expect(page.nextCursor).not.toBeNull();
    await expect(receiptsQuery({ cycle_id: 'cycle-bind-b', cursor: page.nextCursor }))
      .rejects.toThrow('cursor does not belong to this stream');
    await expect(receiptsQuery({ plan_id: '00000000-0000-4000-8000-000000000000', cursor: page.nextCursor }))
      .rejects.toThrow('cursor does not belong to this stream');
  });

  it('cursors are project-bound: an exact foreign-project cursor for the SAME cycle_id is rejected (54292b93)', async () => {
    const { receiptAdd, receiptsQuery, streamTag, encodeCursor } = await import('../receipts.js');
    await receiptAdd({ receipt: receiptOf('k-cross-local', { cycleId: 'cycle-cross', seq: 1 }) });
    const foreign = await seedForeignReceipt('cycle-cross', 'k-cross-foreign');
    const foreignCursor = encodeCursor(
      streamTag('cycle', 'cycle-cross', projectBId), foreign.cursorTs, foreign.id);
    await expect(receiptsQuery({ cycle_id: 'cycle-cross', cursor: foreignCursor }))
      .rejects.toThrow('cursor does not belong to this stream');
  });

  it('malformed cursors throw ReceiptValidationError', async () => {
    const { receiptsQuery, streamTag, encodeCursor, ReceiptValidationError } = await import('../receipts.js');
    const tag = streamTag('cycle', 'cycle-any', projectId);
    const uuid = '11111111-2222-4333-8444-555555555555';
    const malformed = [
      Buffer.from('garbage-not-three-parts', 'utf8').toString('base64url'),
      Buffer.from(`${tag}/2026-08-29T12:00:00.123456Z`, 'utf8').toString('base64url'),
      encodeCursor(tag, '2026-08-29T12:00:00.123Z', uuid),
    ];
    for (const cursor of malformed) {
      await expect(receiptsQuery({ cycle_id: 'cycle-any', cursor }))
        .rejects.toBeInstanceOf(ReceiptValidationError);
    }
  });

  it('rejects unknown parameters and unkeyed reads', async () => {
    const { receiptsQuery, ReceiptValidationError } = await import('../receipts.js');
    await expect(receiptsQuery({ cycle_id: 'c', bogus: true })).rejects.toBeInstanceOf(ReceiptValidationError);
    await expect(receiptsQuery({})).rejects.toBeInstanceOf(ReceiptValidationError);
    await expect(receiptsQuery({ plan_id: 'not-a-uuid' })).rejects.toBeInstanceOf(ReceiptValidationError);
    await expect(receiptsQuery({ cycle_id: 'c', limit: 0 })).rejects.toBeInstanceOf(ReceiptValidationError);
    await expect(receiptsQuery({ cycle_id: 'c', limit: 201 })).rejects.toBeInstanceOf(ReceiptValidationError);
  });
});
