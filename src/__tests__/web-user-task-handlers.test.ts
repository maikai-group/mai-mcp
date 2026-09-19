import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import crypto from 'node:crypto';
import { Pool } from 'pg';
import { requireDisposableTestDbUrl } from './test-db-url.js';
import {
  createUserTaskGetHandlers,
  createUserTaskPostHandlers,
  UserTaskClientError,
} from '../web-user-task-handlers.js';
import type { OperatorTaskMutationResult } from '../operator-tasks.js';

const savedDb = process.env.MAI_DB_URL;
process.env.MAI_DB_URL = requireDisposableTestDbUrl();
const admin = new Pool({ connectionString: process.env.MAI_DB_URL });
let projectA = '';
let projectB = '';
const url = new URL('http://127.0.0.1/api/user-tasks?project=tasks-a');

const getHandlers = createUserTaskGetHandlers(async () => projectA);
const postHandlers = createUserTaskPostHandlers(async () => projectA);
const get = (query = '') => {
  const handler = getHandlers['/api/user-tasks'];
  if (!handler) throw new Error('GET handler missing');
  return handler(new URL(`http://127.0.0.1/api/user-tasks?project=tasks-a${query}`));
};
const post = (body: Record<string, unknown>) => {
  const handler = postHandlers['/api/user-tasks/status'];
  if (!handler) throw new Error('POST handler missing');
  return handler(body, url).then((result) => {
    if ('removed_count' in result) throw new Error('status handler returned a removal result');
    return result;
  });
};
const remove = (body: Record<string, unknown>) => {
  const handler = postHandlers['/api/user-tasks/remove'];
  if (!handler) throw new Error('remove POST handler missing');
  return handler(body, url);
};

async function expectClientError(
  promise: Promise<unknown>, status: number,
): Promise<UserTaskClientError> {
  try {
    await promise;
  } catch (error) {
    expect(error).toBeInstanceOf(UserTaskClientError);
    if (!(error instanceof UserTaskClientError)) throw error;
    expect(error.status).toBe(status);
    return error;
  }
  throw new Error('expected UserTaskClientError');
}

async function seedTask(args: {
  id: string;
  projectId: string;
  planId?: string;
  planSlug?: string;
  key: string;
  kind: 'blocking' | 'follow_up';
  title: string;
  agent: string;
  order: number;
  status?: 'pending' | 'completed' | 'dismissed';
  resolutionNote?: string;
  removedAt?: string;
  created: string;
}): Promise<void> {
  const terminal = args.status === 'completed' || args.status === 'dismissed';
  if (args.planId && !args.planSlug) throw new Error('linked task requires plan slug');
  await admin.query(
    `INSERT INTO operator_tasks
      (id,project_id,plan_id,task_key,content_hash,source_kind,source_plan_slug,kind,title,instructions,
       assigned_by_agent,assigned_by_session,sort_order,status,resolution_note,resolved_at,removed_at,
       created_at,updated_at)
     VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,'web-session',$12,$13,$14,$15,$16,$17,$17)`,
    [args.id, args.projectId, args.planId ?? null, args.key,
      crypto.createHash('sha256').update(args.id).digest('hex'),
      args.planId ? 'plan' : 'ad_hoc', args.planSlug ?? null, args.kind, args.title,
      `${args.title} instructions`, args.agent, args.order, args.status ?? 'pending',
      args.status === 'dismissed' ? (args.resolutionNote ?? 'waived') : null,
      terminal ? '2026-01-04T00:00:00Z' : null, args.removedAt ?? null, args.created]
  );
}

async function seedTerminalBatch(args: {
  idPrefix: string;
  count: number;
  projectId: string;
  planId?: string;
  planSlug?: string;
  keyPrefix: string;
}): Promise<void> {
  for (let index = 0; index < args.count; index += 1) {
    await seedTask({
      id: `${args.idPrefix}-0000-4000-8000-${String(index + 1).padStart(12, '0')}`,
      projectId: args.projectId,
      planId: args.planId,
      planSlug: args.planSlug,
      key: args.planId ? `O${index + 100}` : `${args.keyPrefix}_${index + 1}`,
      kind: index % 2 === 0 ? 'blocking' : 'follow_up',
      title: `${args.keyPrefix} ${index + 1}`,
      agent: `${args.keyPrefix.toLowerCase()}-agent`,
      order: index % 100,
      status: 'completed',
      created: new Date(Date.UTC(2026, 0, 6, 0, 0, index)).toISOString(),
    });
  }
}

beforeAll(async () => {
  await admin.query(`DELETE FROM projects WHERE slug IN ('tasks-a','tasks-b')`);
  projectA = (await admin.query<{ id: string }>(
    `INSERT INTO projects(slug,name) VALUES('tasks-a','Tasks A') RETURNING id`
  )).rows[0].id;
  projectB = (await admin.query<{ id: string }>(
    `INSERT INTO projects(slug,name) VALUES('tasks-b','Tasks B') RETURNING id`
  )).rows[0].id;
});

beforeEach(async () => {
  await admin.query(`DELETE FROM operator_tasks WHERE project_id=ANY($1::uuid[])`, [[projectA, projectB]]);
  await admin.query(`DELETE FROM plans WHERE project_id=ANY($1::uuid[])`, [[projectA, projectB]]);
  const plans = await admin.query<{ id: string; slug: string }>(
    `INSERT INTO plans(project_id,slug,path,title,status,updated_at) VALUES
      ($1,'new-plan','docs/new.md','New Plan','executing','2026-01-03T00:00:00Z'),
      ($1,'old-plan','docs/old.md','Old Plan','approved','2026-01-02T00:00:00Z'),
      ($2,'foreign-plan','docs/foreign.md','Foreign Plan','executing','2026-01-01T00:00:00Z')
     RETURNING id,slug`, [projectA, projectB]
  );
  const id = (slug: string) => {
    const row = plans.rows.find((plan) => plan.slug === slug);
    if (!row) throw new Error(`missing plan fixture ${slug}`);
    return row.id;
  };
  // Deliberately scrambled insertion order; the domain query owns all order.
  await seedTask({ id: '30000000-0000-4000-8000-000000000003', projectId: projectA,
    key: 'AGENT_Z', kind: 'blocking', title: 'Agent Z', agent: 'agent-z', order: 0,
    created: '2026-01-01T00:00:03Z' });
  await seedTask({ id: '10000000-0000-4000-8000-000000000002', projectId: projectA,
    planId: id('new-plan'), planSlug: 'new-plan', key: 'O2', kind: 'follow_up', title: 'New follow', agent: 'assigner-b', order: 0,
    created: '2026-01-01T00:00:02Z' });
  await seedTask({ id: '20000000-0000-4000-8000-000000000001', projectId: projectA,
    planId: id('old-plan'), planSlug: 'old-plan', key: 'O1', kind: 'blocking', title: 'Old block', agent: 'assigner-c', order: 0,
    created: '2026-01-01T00:00:01Z' });
  await seedTask({ id: '10000000-0000-4000-8000-000000000001', projectId: projectA,
    planId: id('new-plan'), planSlug: 'new-plan', key: 'O1', kind: 'blocking', title: 'New block', agent: 'assigner-a', order: 1,
    created: '2026-01-01T00:00:01Z' });
  await seedTask({ id: '30000000-0000-4000-8000-000000000001', projectId: projectA,
    key: 'AGENT_A', kind: 'blocking', title: 'Agent A', agent: 'agent-a', order: 0,
    created: '2026-01-01T00:00:01Z' });
  await seedTask({ id: '10000000-0000-4000-8000-000000000004', projectId: projectA,
    planId: id('new-plan'), planSlug: 'new-plan', key: 'O3', kind: 'blocking', title: 'New history', agent: 'assigner-a', order: 2,
    status: 'completed', created: '2026-01-01T00:00:04Z' });
  await seedTask({ id: '20000000-0000-4000-8000-000000000002', projectId: projectA,
    planId: id('old-plan'), planSlug: 'old-plan', key: 'O2', kind: 'follow_up', title: 'Old dismissed',
    agent: 'assigner-c', order: 1, status: 'dismissed', resolutionNote: 'superseded',
    created: '2026-01-01T00:00:05Z' });
  await seedTask({ id: '10000000-0000-4000-8000-000000000005', projectId: projectA,
    planId: id('new-plan'), planSlug: 'new-plan', key: 'O4', kind: 'follow_up', title: 'Removed history',
    agent: 'assigner-a', order: 3, status: 'completed', removedAt: '2026-01-05T00:00:00Z',
    created: '2026-01-01T00:00:05Z' });
  await seedTask({ id: '40000000-0000-4000-8000-000000000001', projectId: projectB,
    planId: id('foreign-plan'), planSlug: 'foreign-plan', key: 'O1', kind: 'blocking', title: 'Foreign', agent: 'foreign-agent', order: 0,
    created: '2026-01-01T00:00:01Z' });
});

afterAll(async () => {
  await admin.query(`DELETE FROM projects WHERE id=ANY($1::uuid[])`, [[projectA, projectB]]);
  await admin.end();
  const { closePool } = await import('../db.js');
  await closePool();
  if (savedDb === undefined) delete process.env.MAI_DB_URL;
  else process.env.MAI_DB_URL = savedDb;
});

describe('import-safe user task handlers', () => {
  it('preserves domain order and returns joined metadata and assigning agents', async () => {
    const result = await get();
    expect(result.rows.map((task) => task.id)).toEqual([
      '10000000-0000-4000-8000-000000000001',
      '10000000-0000-4000-8000-000000000002',
      '20000000-0000-4000-8000-000000000001',
      '30000000-0000-4000-8000-000000000001',
      '30000000-0000-4000-8000-000000000003',
    ]);
    expect(result.groups.map((group) => group.group_key)).toEqual([
      `plan:${result.rows[0].plan_id}`,
      `plan:${result.rows[2].plan_id}`,
      'unlinked',
    ]);
    expect(result.rows[0]).toMatchObject({
      plan_title: 'New Plan', plan_path: 'docs/new.md', plan_status: 'executing',
      assigned_by_agent: 'assigner-a',
    });
  });

  it('supports strict history/summary flags and empty summary collections', async () => {
    const history = await get('&history=1');
    expect(history.rows).toHaveLength(7);
    expect(history.rows.map((row) => row.title)).not.toContain('Removed history');
    expect(history.rows.filter((row) => row.status !== 'pending').map((row) => row.status).sort())
      .toEqual(['completed', 'dismissed']);
    expect(history.groups.map((group) => group.group_kind)).toEqual(['plan', 'plan', 'unlinked']);
    const summary = await get('&summary=true&history=false');
    expect(summary).toMatchObject({
      pending_count: 5, blocking_count: 4, follow_up_count: 1, rows: [], groups: [],
    });
    for (const query of ['&history=yes', '&summary=2', '&history=', '&summary=TRUE']) {
      await expectClientError(get(query), 400);
    }
  });

  it('completes, reopens, and dismisses with authoritative counts', async () => {
    const completed = await post({
      task_id: '10000000-0000-4000-8000-000000000001', action: 'complete',
    });
    expect(completed).toMatchObject({ pending_count: 4, blocking_count: 3, follow_up_count: 1 });
    expect(completed.task.status).toBe('completed');
    const reopened = await post({
      task_id: '10000000-0000-4000-8000-000000000001', action: 'reopen',
    });
    expect(reopened).toMatchObject({ pending_count: 5, blocking_count: 4, follow_up_count: 1 });
    const dismissed = await post({
      task_id: '10000000-0000-4000-8000-000000000002', action: 'dismiss', reason: ' waived ',
    });
    expect(dismissed).toMatchObject({ pending_count: 4, blocking_count: 4, follow_up_count: 0 });
    expect(dismissed.task.resolution_note).toBe('waived');
  });

  it('validates exact payload shape and maps invalid transitions to 409', async () => {
    for (const body of [
      {}, { task_id: 'x', action: 'other' },
      { task_id: 'x', action: 'complete', reason: 'no' },
      { task_id: 'x', action: 'dismiss' },
      { task_id: 'x', action: 'dismiss', reason: '  ' },
      { task_id: 'x', action: 'complete', extra: true },
    ]) await expectClientError(post(body), 400);
    const malformedId = await expectClientError(post({ task_id: 'x', action: 'complete' }), 400);
    expect(malformedId.message).toBe("field 'task_id' must be a UUID");
    expect(malformedId.message).not.toContain('invalid input syntax');
    await post({ task_id: '10000000-0000-4000-8000-000000000001', action: 'complete' });
    const conflict = await expectClientError(post({
      task_id: '10000000-0000-4000-8000-000000000001', action: 'complete',
    }), 409);
    expect(conflict.message).toBe('Operator task transition is not valid.');
  });

  it('validates exact removal variants with stable client messages', async () => {
    for (const body of [
      {}, { mode: 'unknown' }, { mode: 1 },
      { mode: 'tasks', task_ids: ['10000000-0000-4000-8000-000000000004'], extra: true },
      { mode: 'group', group_key: 'unlinked', snapshot: 'a'.repeat(64), extra: true },
    ]) {
      const error = await expectClientError(remove(body), 400);
      expect(error.message).toBe('request must contain one exact removal variant');
    }

    for (const body of [
      { mode: 'tasks', task_ids: [] },
      { mode: 'tasks', task_ids: 'not-an-array' },
      { mode: 'tasks', task_ids: Array.from({ length: 101 }, (_, index) =>
        `50000000-0000-4000-8000-${String(index).padStart(12, '0')}`) },
    ]) {
      const error = await expectClientError(remove(body), 400);
      expect(error.message).toBe("field 'task_ids' must contain 1 to 100 UUIDs");
    }

    for (const taskIds of [['not-a-uuid'], [42]]) {
      const error = await expectClientError(remove({ mode: 'tasks', task_ids: taskIds }), 400);
      expect(error.message).toBe("field 'task_ids' contains a non-UUID value");
    }
    const duplicate = await expectClientError(remove({
      mode: 'tasks',
      task_ids: [
        ' 10000000-0000-4000-8000-000000000004 ',
        '10000000-0000-4000-8000-000000000004',
      ],
    }), 400);
    expect(duplicate.message).toBe("field 'task_ids' must not contain duplicates");
    const mixedCaseDuplicate = await expectClientError(remove({
      mode: 'tasks',
      task_ids: [
        'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
        'AAAAAAAA-AAAA-4AAA-8AAA-AAAAAAAAAAAA',
      ],
    }), 400);
    expect(mixedCaseDuplicate.message).toBe("field 'task_ids' must not contain duplicates");

    for (const groupKey of ['plan:nope', 'agent:one', 42]) {
      const error = await expectClientError(remove({
        mode: 'group', group_key: groupKey, snapshot: 'a'.repeat(64),
      }), 400);
      expect(error.message).toBe("field 'group_key' must be 'unlinked' or 'plan:<uuid>'");
    }
    for (const snapshot of ['A'.repeat(64), 'a'.repeat(63), 42]) {
      const error = await expectClientError(remove({
        mode: 'group', group_key: 'unlinked', snapshot,
      }), 400);
      expect(error.message).toBe("field 'snapshot' must be 64 lowercase hex characters");
    }
  });

  it('removes completed and dismissed tasks atomically and supports one-id removal', async () => {
    const removed = await remove({
      mode: 'tasks',
      task_ids: [
        '10000000-0000-4000-8000-000000000004',
        '20000000-0000-4000-8000-000000000002',
      ],
    });
    expect(removed).toEqual({ removed_count: 2 });
    const stamped = await admin.query<{ status: string; removed_at: Date | null }>(
      `SELECT status,removed_at FROM operator_tasks
        WHERE id=ANY($1::uuid[]) ORDER BY status`,
      [[
        '10000000-0000-4000-8000-000000000004',
        '20000000-0000-4000-8000-000000000002',
      ]]
    );
    expect(stamped.rows.map((row) => row.status)).toEqual(['completed', 'dismissed']);
    expect(stamped.rows.every((row) => row.removed_at instanceof Date)).toBe(true);

    await seedTask({
      id: '30000000-0000-4000-8000-000000000010', projectId: projectA,
      key: 'ONE_REMOVE', kind: 'follow_up', title: 'One remove', agent: 'agent-one', order: 10,
      status: 'completed', created: '2026-01-06T00:00:10Z',
    });
    await expect(remove({
      mode: 'tasks', task_ids: ['30000000-0000-4000-8000-000000000010'],
    })).resolves.toEqual({ removed_count: 1 });
  });

  it('removes plan and unlinked groups above 100 rows through one request each', async () => {
    const initial = await get('&history=1');
    const newPlan = initial.groups.find((group) => group.plan_title === 'New Plan');
    if (!newPlan?.plan_id) throw new Error('new plan group missing');
    await seedTerminalBatch({
      idPrefix: '51000000', count: 101, projectId: projectA,
      planId: newPlan.plan_id, planSlug: 'new-plan', keyPrefix: 'PLAN_BATCH',
    });
    await seedTerminalBatch({
      idPrefix: '52000000', count: 101, projectId: projectA, keyPrefix: 'UNLINKED_BATCH',
    });

    const populated = await get('&history=1');
    const planGroup = populated.groups.find((group) => group.group_key === newPlan.group_key);
    const unlinked = populated.groups.find((group) => group.group_key === 'unlinked');
    if (!planGroup?.removal_snapshot || !unlinked?.removal_snapshot) {
      throw new Error('terminal group snapshots missing');
    }
    const planTerminalCount = planGroup.tasks.filter((task) => task.status !== 'pending').length;
    const unlinkedTerminalCount = unlinked.tasks.filter((task) => task.status !== 'pending').length;
    expect(planTerminalCount).toBe(102);
    expect(unlinkedTerminalCount).toBe(101);
    await expect(remove({
      mode: 'group', group_key: planGroup.group_key, snapshot: planGroup.removal_snapshot,
    })).resolves.toEqual({ removed_count: 102 });
    await expect(remove({
      mode: 'group', group_key: 'unlinked', snapshot: unlinked.removal_snapshot,
    })).resolves.toEqual({ removed_count: 101 });
    const after = await get('&history=1');
    expect(after.rows.some((task) => task.status !== 'pending'
      && (task.plan_id === newPlan.plan_id || task.plan_id === null))).toBe(false);
  });

  it('rejects stale group snapshots after add, reopen, or update with zero stamps', async () => {
    const beforeAdd = await get('&history=1');
    const newPlan = beforeAdd.groups.find((group) => group.plan_title === 'New Plan');
    if (!newPlan?.plan_id || !newPlan.removal_snapshot) throw new Error('new plan snapshot missing');
    await seedTask({
      id: '53000000-0000-4000-8000-000000000001', projectId: projectA,
      planId: newPlan.plan_id, planSlug: 'new-plan', key: 'O90', kind: 'follow_up',
      title: 'Added terminal', agent: 'agent-add', order: 90, status: 'completed',
      created: '2026-01-06T00:00:01Z',
    });
    await expectClientError(remove({
      mode: 'group', group_key: newPlan.group_key, snapshot: newPlan.removal_snapshot,
    }), 409);

    const beforeReopen = await get('&history=1');
    const oldPlan = beforeReopen.groups.find((group) => group.plan_title === 'Old Plan');
    if (!oldPlan?.removal_snapshot) throw new Error('old plan snapshot missing');
    await post({ task_id: '20000000-0000-4000-8000-000000000002', action: 'reopen' });
    await expectClientError(remove({
      mode: 'group', group_key: oldPlan.group_key, snapshot: oldPlan.removal_snapshot,
    }), 409);

    const beforeUpdate = await get('&history=1');
    const updatedPlan = beforeUpdate.groups.find((group) => group.plan_title === 'New Plan');
    if (!updatedPlan?.removal_snapshot) throw new Error('updated plan snapshot missing');
    await admin.query(
      `UPDATE operator_tasks SET updated_at=updated_at + interval '1 second'
        WHERE id='10000000-0000-4000-8000-000000000004'`
    );
    await expectClientError(remove({
      mode: 'group', group_key: updatedPlan.group_key, snapshot: updatedPlan.removal_snapshot,
    }), 409);
    const stamps = await admin.query<{ count: string }>(
      `SELECT count(*)::text AS count FROM operator_tasks
        WHERE project_id=$1 AND removed_at IS NOT NULL AND id <> $2`,
      [projectA, '10000000-0000-4000-8000-000000000005']
    );
    expect(stamps.rows[0].count).toBe('0');
  });

  it('rejects invalid removal sets atomically and keeps opaque project isolation', async () => {
    const completedId = '10000000-0000-4000-8000-000000000004';
    const pendingId = '10000000-0000-4000-8000-000000000001';
    const removedId = '10000000-0000-4000-8000-000000000005';
    const missingId = '90000000-0000-4000-8000-000000000001';
    const foreignId = '40000000-0000-4000-8000-000000000001';

    for (const ids of [[pendingId], [removedId], [completedId, pendingId]]) {
      const error = await expectClientError(remove({ mode: 'tasks', task_ids: ids }), 409);
      expect(error.message).toBe('Operator task removal is not valid.');
    }
    const missing = await expectClientError(remove({
      mode: 'tasks', task_ids: [completedId, missingId],
    }), 404);
    const foreign = await expectClientError(remove({
      mode: 'tasks', task_ids: [completedId, foreignId],
    }), 404);
    expect(foreign.message).toBe(missing.message);
    expect(missing.message).toBe('Operator task not found.');

    const rows = await admin.query<{ id: string; removed_at: Date | null }>(
      `SELECT id,removed_at FROM operator_tasks WHERE id=ANY($1::uuid[]) ORDER BY id`,
      [[completedId, pendingId, foreignId]]
    );
    expect(rows.rows).toHaveLength(3);
    expect(rows.rows.every((row) => row.removed_at === null)).toBe(true);
  });

  it('uses the same opaque 404 for missing and foreign ids without changing foreign counts', async () => {
    const foreignGet = createUserTaskGetHandlers(async () => projectB)['/api/user-tasks'];
    if (!foreignGet) throw new Error('foreign GET handler missing');
    const before = await foreignGet(new URL('http://127.0.0.1/api/user-tasks?summary=1'));
    const missing = await expectClientError(post({
      task_id: '90000000-0000-4000-8000-000000000001', action: 'complete',
    }), 404);
    const foreign = await expectClientError(post({
      task_id: '40000000-0000-4000-8000-000000000001', action: 'complete',
    }), 404);
    expect(foreign.message).toBe(missing.message);
    const after = await foreignGet(new URL('http://127.0.0.1/api/user-tasks?summary=1'));
    expect(after).toEqual(before);
  });

  it('keeps ordinary reads at two queries regardless of task count', async () => {
    const spy = vi.spyOn(Pool.prototype, 'query');
    try {
      spy.mockClear();
      await get('&history=true');
      expect(spy.mock.calls).toHaveLength(2);
      await seedTask({ id: '30000000-0000-4000-8000-000000000009', projectId: projectA,
        key: 'AGENT_MORE', kind: 'follow_up', title: 'More', agent: 'agent-z', order: 9,
        created: '2026-01-01T00:00:09Z' });
      spy.mockClear();
      await get('&history=true');
      expect(spy.mock.calls).toHaveLength(2);
    } finally {
      spy.mockRestore();
    }
  });

  it('serves summary mode with exactly one aggregate query and no task-row selection', async () => {
    const spy = vi.spyOn(Pool.prototype, 'query');
    try {
      spy.mockClear();
      const summary = await get('&summary=1');
      expect(summary).toMatchObject({ pending_count: 5, rows: [], groups: [] });
      expect(spy.mock.calls).toHaveLength(1);
      const sql = String(spy.mock.calls[0][0]);
      expect(sql).toContain("count(*) FILTER (WHERE status = 'pending')");
      expect(sql).not.toContain('assigned_by_agent');
      expect(sql).not.toContain('LEFT JOIN plans');
    } finally {
      spy.mockRestore();
    }
  });

  it('imports without constructing the web server or reading frontend assets', async () => {
    const module = await import('../web-user-task-handlers.js');
    expect(module.createUserTaskGetHandlers).toBeTypeOf('function');
    expect(module.createUserTaskPostHandlers).toBeTypeOf('function');
  });
});
