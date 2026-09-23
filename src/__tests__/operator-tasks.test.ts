import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { Pool } from 'pg';
import { requireDisposableTestDbUrl } from './test-db-url.js';

const saved: Record<string, string | undefined> = {
  MAI_PROJECT_SLUG: process.env.MAI_PROJECT_SLUG,
  MAI_DB_URL: process.env.MAI_DB_URL,
  MAI_AGENT_ID: process.env.MAI_AGENT_ID,
  MAI_EMBEDDINGS: process.env.MAI_EMBEDDINGS,
  MAI_BRAIN_ROOT: process.env.MAI_BRAIN_ROOT,
};
process.env.MAI_PROJECT_SLUG = 'plan43-test';
process.env.MAI_DB_URL = requireDisposableTestDbUrl();
process.env.MAI_AGENT_ID = 'plan43-agent-a';
process.env.MAI_EMBEDDINGS = '0';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'plan43-'));
process.env.MAI_BRAIN_ROOT = root;
const admin = new Pool({ connectionString: process.env.MAI_DB_URL });
const docs = path.join(root, 'docs');

async function withOperatorTaskWire<T>(
  fn: (call: (name: string, args: unknown) => Promise<{ text: string; isError: boolean }>) => Promise<T>,
): Promise<T> {
  const { buildServer } = await import('../index.js');
  const { Client, InMemoryTransport } = await import('@modelcontextprotocol/client');
  const server = buildServer(async () => '');
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 'plan43-wire', version: '0.0.0' });
  try {
    await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
    return await fn(async (name, args) => {
      // JSON.parse deliberately supplies the protocol boundary's untrusted
      // shape without a TypeScript assertion; the domain must narrow it.
      const request = JSON.parse(JSON.stringify({ name, arguments: args }));
      try {
        const result = await client.callTool(request);
        const blocks = Array.isArray(result.content) ? result.content : [];
        return {
          text: blocks.map((block) => (
            'text' in block && typeof block.text === 'string' ? block.text : ''
          )).join('\n\n'),
          isError: result.isError === true,
        };
      } catch (error) {
        // The protocol itself rejects null/array/primitive arguments before
        // dispatch; that is still an actual wire-level rejection.
        return { text: error instanceof Error ? error.message : String(error), isError: true };
      }
    });
  } finally {
    await client.close().catch(() => {});
    await server.close().catch(() => {});
  }
}

function checklist(items: readonly { key: string; kind: 'blocking' | 'follow-up'; title: string; instructions: string }[]): string {
  return `# Plan\n\n## Operator Checklist\n\n\`\`\`operator-checklist\n${JSON.stringify(items, null, 2)}\n\`\`\`\n\n## End\n`;
}

const one = checklist([
  { key: 'O1', kind: 'blocking', title: 'Smoke dashboard', instructions: 'Open it.\nCheck it.' },
]);

async function writeApprovedPlan(rel: string, markdown = one) {
  fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true });
  fs.writeFileSync(path.join(root, rel), markdown);
  const { planRegister } = await import('../plans.js');
  const plan = await planRegister({ path: rel, status: 'approved' });
  await admin.query(
    `INSERT INTO plan_reviews (plan_id, pass, kind, reviewer_agent, verdict, plan_sha, synthesis)
     VALUES ($1,1,'blind','reviewer','approved',$2,'clear')`, [plan.id, plan.current_sha]
  );
  return plan;
}

beforeAll(async () => {
  await import('../db.js');
  fs.mkdirSync(docs, { recursive: true });
  await admin.query(`DELETE FROM projects WHERE slug IN ('plan43-test','plan43-foreign')`);
  await admin.query(
    `INSERT INTO projects (slug,name,path) VALUES ('plan43-test','Plan43 Test',$1)`, [root]
  );
});

afterAll(async () => {
  await admin.query(`DELETE FROM projects WHERE slug IN ('plan43-test','plan43-foreign')`);
  await admin.end();
  const { closePool } = await import('../db.js');
  await closePool();
  for (const [key, value] of Object.entries(saved)) {
    if (value === undefined) delete process.env[key]; else process.env[key] = value;
  }
  fs.rmSync(root, { recursive: true, force: true });
});

beforeEach(async () => {
  process.env.MAI_AGENT_ID = 'plan43-agent-a';
  await admin.query(
    `DELETE FROM plans WHERE project_id = (SELECT id FROM projects WHERE slug='plan43-test')`
  );
  await admin.query(
    `DELETE FROM operator_tasks WHERE project_id = (SELECT id FROM projects WHERE slug='plan43-test')`
  );
});

describe('operator task migration', () => {
  it('moves repeatedly between the immutable four-index base and six-index history schema', async () => {
    const baseForward = fs.readFileSync(path.join(process.cwd(), 'db/migrations/2026-08-27-operator-tasks.sql'), 'utf8');
    const baseRollback = fs.readFileSync(path.join(process.cwd(), 'db/migrations/2026-08-27-operator-tasks.rollback.sql'), 'utf8');
    const historyForward = fs.readFileSync(path.join(process.cwd(), 'db/migrations/2026-08-28-operator-task-history.sql'), 'utf8');
    const historyRollback = fs.readFileSync(path.join(process.cwd(), 'db/migrations/2026-08-28-operator-task-history.rollback.sql'), 'utf8');
    const project = await admin.query<{ id: string }>(`SELECT id FROM projects WHERE slug='plan43-test'`);
    const projectId = project.rows[0].id;
    const decision = await admin.query<{ id: string }>(
      `INSERT INTO code_decisions (project_id,decision_type,description) VALUES ($1,'testing','plan43-survivor') RETURNING id`,
      [projectId]
    );
    const lesson = await admin.query<{ id: string }>(
      `INSERT INTO lessons (project_id,rule) VALUES ($1,'plan43-survivor') RETURNING id`, [projectId]
    );
    const plan = await admin.query<{ id: string }>(
      `INSERT INTO plans (project_id,slug,path,title) VALUES ($1,'plan43-migration','docs/migration.md','migration') RETURNING id`,
      [projectId]
    );
    const before = await admin.query<{ payload: string }>(
      `SELECT jsonb_build_object(
        'decision',(SELECT to_jsonb(d) FROM code_decisions d WHERE id=$1),
        'lesson',(SELECT to_jsonb(l) FROM lessons l WHERE id=$2),
        'plan',(SELECT to_jsonb(p) FROM plans p WHERE id=$3))::text AS payload`,
      [decision.rows[0].id, lesson.rows[0].id, plan.rows[0].id]
    );
    await admin.query(baseRollback);
    await admin.query(baseForward);
    const baseColumns = await admin.query<{ removed_at: string | null }>(
      `SELECT data_type AS removed_at FROM information_schema.columns
        WHERE table_schema='public' AND table_name='operator_tasks' AND column_name='removed_at'`
    );
    expect(baseColumns.rows).toEqual([]);
    const baseIndexes = await admin.query<{ name: string }>(
      `SELECT indexname AS name FROM pg_indexes
        WHERE schemaname='public' AND tablename='operator_tasks'
          AND indexname <> 'operator_tasks_pkey' ORDER BY indexname`
    );
    expect(baseIndexes.rows).toHaveLength(4);
    await admin.query(
      `INSERT INTO operator_tasks
       (project_id,plan_id,task_key,content_hash,source_kind,kind,title,instructions,
        assigned_by_agent,assigned_by_session,sort_order)
       VALUES($1,$2,'LEGACY',$3,'plan','blocking','legacy','legacy','agent','session',0)`,
      [projectId, plan.rows[0].id, crypto.createHash('sha256').update('legacy').digest('hex')]
    );
    await admin.query(historyForward);
    await admin.query(historyForward);
    const current = await admin.query<{ source_plan_slug: string; removed_type: string; source_type: string }>(
      `SELECT task.source_plan_slug,
              (SELECT data_type FROM information_schema.columns WHERE table_schema='public'
                AND table_name='operator_tasks' AND column_name='removed_at') AS removed_type,
              (SELECT data_type FROM information_schema.columns WHERE table_schema='public'
                AND table_name='operator_tasks' AND column_name='source_plan_slug') AS source_type
         FROM operator_tasks task WHERE task.task_key='LEGACY'`
    );
    expect(current.rows[0]).toEqual({
      source_plan_slug: 'plan43-migration', removed_type: 'timestamp with time zone', source_type: 'text',
    });
    const currentIndexes = await admin.query<{ name: string; predicate: string | null }>(
      `SELECT indexname AS name, indexdef AS predicate FROM pg_indexes
        WHERE schemaname='public' AND tablename='operator_tasks'
          AND indexname <> 'operator_tasks_pkey' ORDER BY indexname`
    );
    expect(currentIndexes.rows).toHaveLength(6);
    expect(currentIndexes.rows.find((row) => row.name === 'operator_tasks_plan_source_key')?.predicate)
      .toContain('source_plan_slug');
    expect(currentIndexes.rows.find((row) => row.name === 'operator_tasks_visible')?.predicate)
      .toContain('(removed_at IS NULL)');
    const constraints = await admin.query<{ name: string; definition: string }>(
      `SELECT conname AS name, pg_get_constraintdef(oid) AS definition
         FROM pg_constraint WHERE conrelid='operator_tasks'::regclass
           AND conname IN ('operator_tasks_source_identity','operator_tasks_removed_terminal')
         ORDER BY conname`
    );
    expect(constraints.rows.map((row) => row.name)).toEqual([
      'operator_tasks_removed_terminal', 'operator_tasks_source_identity',
    ]);
    expect(constraints.rows.map((row) => row.definition).join('\n')).toContain('removed_at');
    expect(constraints.rows.map((row) => row.definition).join('\n')).toContain('source_plan_slug');
    await admin.query(historyRollback);
    await admin.query(historyRollback);
    const after = await admin.query<{ payload: string }>(
      `SELECT jsonb_build_object(
        'decision',(SELECT to_jsonb(d) FROM code_decisions d WHERE id=$1),
        'lesson',(SELECT to_jsonb(l) FROM lessons l WHERE id=$2),
        'plan',(SELECT to_jsonb(p) FROM plans p WHERE id=$3))::text AS payload`,
      [decision.rows[0].id, lesson.rows[0].id, plan.rows[0].id]
    );
    expect(after.rows[0].payload).toBe(before.rows[0].payload);
    const rolledBackIndexes = await admin.query<{ name: string }>(
      `SELECT indexname AS name FROM pg_indexes
        WHERE schemaname='public' AND tablename='operator_tasks'
          AND indexname <> 'operator_tasks_pkey' ORDER BY indexname`
    );
    expect(rolledBackIndexes.rows).toHaveLength(4);
    await admin.query(historyForward);
    const table = await admin.query<{ name: string }>(
      `SELECT to_regclass('operator_tasks')::text AS name`
    );
    expect(table.rows[0].name).toBe('operator_tasks');
  });

  it('fails closed when a legacy plan task has lost its source plan identity', async () => {
    const baseForward = fs.readFileSync(path.join(process.cwd(), 'db/migrations/2026-08-27-operator-tasks.sql'), 'utf8');
    const baseRollback = fs.readFileSync(path.join(process.cwd(), 'db/migrations/2026-08-27-operator-tasks.rollback.sql'), 'utf8');
    const historyForward = fs.readFileSync(path.join(process.cwd(), 'db/migrations/2026-08-28-operator-task-history.sql'), 'utf8');
    await admin.query(baseRollback);
    await admin.query(baseForward);
    const project = await admin.query<{ id: string }>(`SELECT id FROM projects WHERE slug='plan43-test'`);
    await admin.query(
      `INSERT INTO operator_tasks
       (project_id,plan_id,task_key,content_hash,source_kind,kind,title,instructions,
        assigned_by_agent,assigned_by_session,sort_order)
       VALUES($1,NULL,'ORPHAN',$2,'plan','blocking','orphan','orphan','agent','session',0)`,
      [project.rows[0].id, crypto.createHash('sha256').update('orphan').digest('hex')]
    );
    await expect(admin.query(historyForward)).rejects.toThrow(/cannot recover source identity/);
    await admin.query(`DELETE FROM operator_tasks WHERE task_key='ORPHAN'`);
    await admin.query(historyForward);
  });
});

describe('parseOperatorChecklist', () => {
  it('accepts zero, one, 100, and CRLF blocks while preserving source order', async () => {
    const { parseOperatorChecklist } = await import('../operator-tasks.js');
    expect(parseOperatorChecklist('# no checklist\n')).toEqual([]);
    expect(parseOperatorChecklist(one.replace(/\n/g, '\r\n'))).toEqual([
      { key: 'O1', kind: 'blocking', title: 'Smoke dashboard', instructions: 'Open it.\nCheck it.', sort_order: 0 },
    ]);
    const hundred = Array.from({ length: 100 }, (_, index) => {
      const kind: 'blocking' | 'follow-up' = index % 2 === 0 ? 'blocking' : 'follow-up';
      return { key: `O${index + 1}`, kind, title: `Title ${index}`, instructions: `Instructions ${index}` };
    });
    const parsed = parseOperatorChecklist(checklist(hundred));
    expect(parsed).toHaveLength(100);
    expect(parsed[99].sort_order).toBe(99);
    expect(parsed[1].kind).toBe('follow_up');
  });

  it('accepts CommonMark h2 indentation and optional closing hashes', async () => {
    const { parseOperatorChecklist } = await import('../operator-tasks.js');
    const commonMark = one
      .replace('## Operator Checklist', '   ## Operator Checklist ###   ')
      .replace('```operator-checklist', '   ```operator-checklist')
      .replace('\n```\n\n## End', '\n   ```\n\n   ## End ##');
    expect(parseOperatorChecklist(commonMark)).toHaveLength(1);
  });

  it.each([
    ['wrong heading depth', '# P\n\n### Operator Checklist\n'],
    ['missing heading space', '# P\n\n##Operator Checklist\n'],
    ['four-space heading', '# P\n\n    ## Operator Checklist\n'],
    ['orphan fence', '# P\n\n```operator-checklist\n[]\n```\n'],
    ['indented orphan fence', '# P\n\n    ```operator-checklist\n[]\n    ```\n'],
    ['tilde orphan fence', '# P\n\n~~~operator-checklist\n[]\n~~~\n'],
    ['accepted plus malformed duplicate', `${one}\n### Operator Checklist\n`],
    ['accepted plus tilde fence', `${one}\n~~~operator-checklist\n[]\n~~~\n`],
  ])('fails closed on near-match syntax: %s', async (_name, markdown) => {
    const { parseOperatorChecklist } = await import('../operator-tasks.js');
    expect(() => parseOperatorChecklist(markdown)).toThrow();
  });

  it.each([
    ['duplicate heading', `${one}\n## Operator Checklist\n`],
    ['second fence', one.replace('## End', '```operator-checklist\n[]\n```\n\n## End')],
    ['missing fence', '# P\n\n## Operator Checklist\n'],
    ['unclosed fence', '# P\n\n## Operator Checklist\n\n```operator-checklist\n[]'],
    ['trailing prose', one.replace('\n\n## End', '\ntrailing\n\n## End')],
    ['malformed JSON', one.replace(/\[\s*\{[\s\S]*\}\s*\]/, '{')],
    ['non-array', '# P\n## Operator Checklist\n```operator-checklist\n{}\n```'],
    ['empty', '# P\n## Operator Checklist\n```operator-checklist\n[]\n```'],
  ])('rejects %s', async (_name, markdown) => {
    const { parseOperatorChecklist } = await import('../operator-tasks.js');
    expect(() => parseOperatorChecklist(markdown)).toThrow();
  });

  it.each([
    [{ key: 'O0', kind: 'blocking', title: 'x', instructions: 'y' }, /key/],
    [{ key: 'O1', kind: 'other', title: 'x', instructions: 'y' }, /kind/],
    [{ key: 'O1', kind: 'blocking', title: '', instructions: 'y' }, /title/],
    [{ key: 'O1', kind: 'blocking', title: 'x'.repeat(301), instructions: 'y' }, /title/],
    [{ key: 'O1', kind: 'blocking', title: 'x', instructions: '' }, /instructions/],
    [{ key: 'O1', kind: 'blocking', title: 'x', instructions: 'y'.repeat(4001) }, /instructions/],
    [{ key: 'O1', kind: 'blocking', title: 'x\u0001', instructions: 'y' }, /control/],
    [{ key: 'O1', kind: 'blocking', title: 'x', instructions: 'y\u0001' }, /control/],
    [{ key: 'O1', kind: 'blocking', title: 'x', instructions: 'y', extra: true }, /exactly/],
    [['not-object'], /object/],
    [null, /object/],
    [7, /object/],
  ])('rejects malformed item %#', async (item, pattern) => {
    const { parseOperatorChecklist } = await import('../operator-tasks.js');
    const markdown = `# P\n## Operator Checklist\n\`\`\`operator-checklist\n${JSON.stringify([item])}\n\`\`\``;
    expect(() => parseOperatorChecklist(markdown)).toThrow(pattern);
  });

  it('rejects duplicate keys and prototype-looking own keys', async () => {
    const { parseOperatorChecklist } = await import('../operator-tasks.js');
    const duplicate = checklist([
      { key: 'O1', kind: 'blocking', title: 'a', instructions: 'a' },
      { key: 'O1', kind: 'follow-up', title: 'b', instructions: 'b' },
    ]);
    expect(() => parseOperatorChecklist(duplicate)).toThrow(/duplicate/);
    const smuggled = '# P\n## Operator Checklist\n```operator-checklist\n[{"key":"O1","kind":"blocking","title":"x","instructions":"y","__proto__":{}}]\n```';
    expect(() => parseOperatorChecklist(smuggled)).toThrow(/exactly/);
    const tooMany: Array<{ key: string; kind: 'blocking' | 'follow-up'; title: string; instructions: string }> =
      Array.from({ length: 101 }, (_, index) => ({
        key: `O${index + 1}`, kind: 'blocking', title: 'x', instructions: 'y',
      }));
    expect(() => parseOperatorChecklist(checklist(tooMany))).toThrow(/1 to 100/);
  });
});

describe('plan sync and ad-hoc assignment', () => {
  it('direct executing registration syncs atomically, reports counts, retries, and rejects unregistered execution', async () => {
    const plan = await writeApprovedPlan('docs/direct-executing.md');
    const { planRegister, planText } = await import('../plans.js');
    const started = await planRegister({ path: plan.path, status: 'executing' });
    expect(started.status).toBe('executing');
    expect(started.operator_tasks).toMatchObject({
      plan_id: plan.id,
      plan_title: plan.title,
      plan_sha: plan.current_sha,
      inserted: 1,
      existing: 0,
      blocking: 1,
      url: `http://127.0.0.1:6601/#/tasks?plan=${plan.id}`,
    });
    const before = await admin.query<{ assigned_by_agent: string; assigned_by_session: string }>(
      `SELECT assigned_by_agent,assigned_by_session FROM operator_tasks WHERE plan_id=$1`, [plan.id]
    );
    process.env.MAI_AGENT_ID = 'plan43-agent-b';
    const retry = await planRegister({ path: plan.path, status: 'executing' });
    expect(retry.operator_tasks).toMatchObject({ inserted: 0, existing: 1 });
    const after = await admin.query<{ assigned_by_agent: string; assigned_by_session: string }>(
      `SELECT assigned_by_agent,assigned_by_session FROM operator_tasks WHERE plan_id=$1`, [plan.id]
    );
    expect(after.rows[0]).toEqual(before.rows[0]);
    const text = await planText({ path: plan.path, status: 'executing' });
    expect(text).toContain(
      `operator tasks for ${retry.operator_tasks?.plan_title} @ ${retry.operator_tasks?.plan_sha?.slice(0, 8)}: ` +
      `0 inserted, 1 existing; 1 blocking, 0 follow-up — My Tasks: ` +
      `http://127.0.0.1:6601/#/tasks?plan=${plan.id}`
    );

    fs.writeFileSync(path.join(docs, 'never-registered.md'), '# unregistered\n');
    await expect(planRegister({ path: 'docs/never-registered.md', status: 'executing' }))
      .rejects.toThrow(/must be registered/);
    const absent = await admin.query<{ n: string }>(
      `SELECT count(*)::text AS n FROM plans WHERE path='docs/never-registered.md'`
    );
    expect(absent.rows[0].n).toBe('0');
  });

  it('serializes direct starts on the project/path lock and rolls sync back when the status write fails', async () => {
    const plan = await writeApprovedPlan('docs/direct-atomic.md');
    const project = await admin.query<{ id: string }>(`SELECT id FROM projects WHERE slug='plan43-test'`);
    const projectId = project.rows[0].id;
    const locker = await admin.connect();
    await locker.query('BEGIN');
    await locker.query(
      `SELECT pg_advisory_xact_lock(hashtextextended($1, 0))`,
      [`${projectId}:${plan.path}`],
    );
    const { planRegister } = await import('../plans.js');
    let settled = false;
    const starting = planRegister({ path: plan.path, status: 'executing' })
      .finally(() => { settled = true; });
    await new Promise((resolve) => setTimeout(resolve, 75));
    expect(settled).toBe(false);
    await locker.query('COMMIT');
    locker.release();
    expect((await starting).status).toBe('executing');

    await admin.query(`DELETE FROM operator_tasks WHERE plan_id=$1`, [plan.id]);
    await admin.query(`UPDATE plans SET status='approved' WHERE id=$1`, [plan.id]);
    const functionName = `plan43_fail_exec_${projectId.replaceAll('-', '_')}`;
    await admin.query(
      `CREATE OR REPLACE FUNCTION ${functionName}() RETURNS trigger LANGUAGE plpgsql AS $$
       BEGIN RAISE EXCEPTION 'injected status write failure'; END $$`
    );
    await admin.query(
      `CREATE TRIGGER plan43_fail_exec BEFORE UPDATE ON plans
       FOR EACH ROW WHEN (NEW.project_id = '${projectId}'::uuid AND NEW.status = 'executing')
       EXECUTE FUNCTION ${functionName}()`
    );
    try {
      await expect(planRegister({ path: plan.path, status: 'executing' }))
        .rejects.toThrow(/injected status write failure/);
      const state = await admin.query<{ status: string; tasks: string }>(
        `SELECT p.status, count(t.id)::text AS tasks FROM plans p
         LEFT JOIN operator_tasks t ON t.plan_id=p.id WHERE p.id=$1 GROUP BY p.status`, [plan.id]
      );
      expect(state.rows[0]).toEqual({ status: 'approved', tasks: '0' });
    } finally {
      await admin.query(`DROP TRIGGER plan43_fail_exec ON plans`);
      await admin.query(`DROP FUNCTION ${functionName}()`);
    }
  });

  it('serializes a competing non-executing alias registration on the execution identity lock', async () => {
    const targetRel = 'docs/direct-race.md';
    const aliasRel = 'docs/direct-race-link.md';
    const plan = await writeApprovedPlan(targetRel);
    fs.symlinkSync(path.basename(targetRel), path.join(root, aliasRel));
    const project = await admin.query<{ id: string }>(`SELECT id FROM projects WHERE slug='plan43-test'`);
    const locker = await admin.connect();
    await locker.query('BEGIN');
    await locker.query(
      `SELECT pg_advisory_xact_lock(hashtextextended($1, 0))`,
      [`${project.rows[0].id}:${targetRel}`],
    );
    const { planRegister } = await import('../plans.js');
    let registrationSettled = false;
    let executionSettled = false;
    const registration = planRegister({ path: aliasRel, title: 'serialized title' })
      .finally(() => { registrationSettled = true; });
    const execution = planRegister({ path: targetRel, status: 'executing' })
      .finally(() => { executionSettled = true; });
    await new Promise((resolve) => setTimeout(resolve, 75));
    // With the old pool-direct non-executing path, registration completed here
    // while execution alone waited. Both must now queue on the same identity.
    expect(registrationSettled).toBe(false);
    expect(executionSettled).toBe(false);
    await locker.query('COMMIT');
    locker.release();
    const [registered, started] = await Promise.all([registration, execution]);
    expect(registered.id).toBe(plan.id);
    expect(started.id).toBe(plan.id);
    const stable = await admin.query<{ status: string; plans: string; tasks: string }>(
      `SELECT min(p.status) AS status, count(DISTINCT p.id)::text AS plans,
              count(t.id)::text AS tasks
         FROM plans p LEFT JOIN operator_tasks t ON t.plan_id=p.id
        WHERE p.project_id=$1 AND p.path=$2`, [project.rows[0].id, targetRel]
    );
    expect(stable.rows[0]).toEqual({ status: 'executing', plans: '1', tasks: '1' });
  });

  it('consolidates aliases inside the executing transaction and preserves every dependent task field', async () => {
    const targetRel = 'docs/alias-executing.md';
    const aliasRel = 'docs/alias-executing-link.md';
    fs.writeFileSync(path.join(root, targetRel), one);
    fs.symlinkSync(path.basename(targetRel), path.join(root, aliasRel));
    const sha = crypto.createHash('sha256').update(fs.readFileSync(path.join(root, targetRel))).digest('hex');
    const project = await admin.query<{ id: string }>(`SELECT id FROM projects WHERE slug='plan43-test'`);
    const survivor = await admin.query<{ id: string }>(
      `INSERT INTO plans(project_id,slug,path,title,current_sha,status)
       VALUES($1,'alias-exec-survivor',$2,'survivor',$3,'approved') RETURNING id`,
      [project.rows[0].id, targetRel, sha]
    );
    const loser = await admin.query<{ id: string }>(
      `INSERT INTO plans(project_id,slug,path,title,current_sha,status)
       VALUES($1,'alias-exec-loser',$2,'loser',$3,'approved') RETURNING id`,
      [project.rows[0].id, aliasRel, sha]
    );
    await admin.query(
      `INSERT INTO plan_reviews(plan_id,pass,kind,reviewer_agent,verdict,plan_sha,synthesis)
       VALUES($1,1,'blind','reviewer','approved',$2,'clear'),
             ($3,1,'blind','loser-reviewer','approved',$2,'loser clear')`,
      [survivor.rows[0].id, sha, loser.rows[0].id]
    );
    const loserReview = await admin.query<{ id: string }>(
      `SELECT id FROM plan_reviews WHERE plan_id=$1`, [loser.rows[0].id]
    );
    await admin.query(
      `INSERT INTO plan_findings(review_id,plan_id,project_id,severity,title,location,issue,evidence,fix,status)
       VALUES($1,$2,$3,'note','kept plan finding','x:1','i','e','f','open')`,
      [loserReview.rows[0].id, loser.rows[0].id, project.rows[0].id]
    );
    await admin.query(
      `INSERT INTO code_findings(project_id,plan_id,base_sha,head_sha,reviewer_agent,severity,title,location,issue,evidence,fix,status)
       VALUES($1,$2,'a','b','reviewer','note','kept','x:1','i','e','f','open')`,
      [project.rows[0].id, loser.rows[0].id]
    );
    const completedAt = new Date('2026-01-02T03:04:05Z');
    await admin.query(
      `INSERT INTO operator_tasks
       (project_id,plan_id,task_key,content_hash,source_kind,source_plan_slug,kind,title,instructions,
        assigned_by_agent,assigned_by_session,sort_order,status,resolved_at,removed_at,created_at,updated_at)
       VALUES($1,$2,'OLD_PLAN',$3,'plan','alias-exec-loser','follow_up','old title','old instructions',
              'old-agent','old-session',7,'completed',$4,$4,$4,$4),
             ($1,$2,'OLD_ADHOC',$5,'ad_hoc',NULL,'blocking','adhoc title','adhoc instructions',
              'adhoc-agent','adhoc-session',3,'pending',NULL,NULL,$4,$4)`,
      [project.rows[0].id, loser.rows[0].id,
        crypto.createHash('sha256').update('old-plan').digest('hex'), completedAt,
        crypto.createHash('sha256').update('old-adhoc').digest('hex')]
    );
    const before = await admin.query<{ task_key: string; payload: string }>(
      `SELECT task_key,(to_jsonb(t)-'plan_id'-'source_plan_slug')::text AS payload FROM operator_tasks t
       WHERE plan_id=$1 ORDER BY task_key`, [loser.rows[0].id]
    );
    const { planRegister } = await import('../plans.js');
    const result = await planRegister({ path: targetRel, status: 'executing' });
    expect(result.id).toBe(survivor.rows[0].id);
    expect(result.operator_tasks).toMatchObject({ inserted: 1, existing: 0, blocking: 2 });
    const after = await admin.query<{
      task_key: string; plan_id: string; source_plan_slug: string | null; payload: string;
    }>(
      `SELECT task_key,plan_id,source_plan_slug,
              (to_jsonb(t)-'plan_id'-'source_plan_slug')::text AS payload FROM operator_tasks t
       WHERE task_key IN ('OLD_PLAN','OLD_ADHOC') ORDER BY task_key`
    );
    expect(after.rows.map((row) => ({ task_key: row.task_key, payload: row.payload }))).toEqual(before.rows);
    expect(after.rows.every((row) => row.plan_id === survivor.rows[0].id)).toBe(true);
    expect(after.rows.map((row) => row.source_plan_slug)).toEqual([null, 'alias-exec-survivor']);
    expect((await admin.query(`SELECT 1 FROM plans WHERE id=$1`, [loser.rows[0].id])).rowCount).toBe(0);
    expect((await admin.query(`SELECT 1 FROM plan_reviews WHERE plan_id=$1`, [survivor.rows[0].id])).rowCount).toBe(2);
    expect((await admin.query(`SELECT 1 FROM plan_findings WHERE plan_id=$1`, [survivor.rows[0].id])).rowCount).toBe(1);
    expect((await admin.query(`SELECT 1 FROM code_findings WHERE plan_id=$1`, [survivor.rows[0].id])).rowCount).toBe(1);
    const { listOperatorTasks } = await import('../operator-tasks.js');
    const listed = await listOperatorTasks({
      projectId: project.rows[0].id, planId: survivor.rows[0].id, includeHistory: true, summaryOnly: true,
    });
    expect(listed.blocking_count).toBe(2);
  });

  it('preserves chronological review authority across executing aliases and rolls back a newer block', async () => {
    const targetRel = 'docs/alias-review-authority.md';
    const aliasRel = 'docs/alias-review-authority-link.md';
    fs.writeFileSync(path.join(root, targetRel), one);
    fs.symlinkSync(path.basename(targetRel), path.join(root, aliasRel));
    const sha = crypto.createHash('sha256').update(fs.readFileSync(path.join(root, targetRel))).digest('hex');
    const project = await admin.query<{ id: string }>(`SELECT id FROM projects WHERE slug='plan43-test'`);
    const rows = await admin.query<{ id: string; path: string }>(
      `INSERT INTO plans(project_id,slug,path,title,current_sha,status) VALUES
       ($1,'alias-authority-survivor',$2,'survivor',$4,'approved'),
       ($1,'alias-authority-loser',$3,'loser',$4,'approved') RETURNING id,path`,
      [project.rows[0].id, targetRel, aliasRel, sha]
    );
    const survivor = rows.rows.find((row) => row.path === targetRel);
    const loser = rows.rows.find((row) => row.path === aliasRel);
    if (!survivor || !loser) throw new Error('alias fixtures missing');
    await admin.query(
      `INSERT INTO plan_reviews(id,plan_id,pass,kind,reviewer_agent,verdict,plan_sha,synthesis,created_at) VALUES
       ('51000000-0000-4000-8000-000000000001',$1,1,'blind','older','approved',$3,'older approval','2026-01-01T00:00:00Z'),
       ('51000000-0000-4000-8000-000000000002',$2,1,'blind','newer','blocked',$3,'newer block','2026-01-01T00:00:01Z')`,
      [survivor.id, loser.id, sha]
    );
    const { planRegister } = await import('../plans.js');
    await expect(planRegister({ path: targetRel, status: 'executing' }))
      .rejects.toThrow(/no latest approved review/);
    expect((await admin.query(`SELECT 1 FROM plans WHERE id=ANY($1::uuid[])`, [[survivor.id, loser.id]])).rowCount).toBe(2);
    const reviews = await admin.query<{ plan_id: string; pass: number }>(
      `SELECT plan_id,pass FROM plan_reviews WHERE plan_id=ANY($1::uuid[]) ORDER BY id`,
      [[survivor.id, loser.id]]
    );
    expect(reviews.rows).toEqual([{ plan_id: survivor.id, pass: 1 }, { plan_id: loser.id, pass: 1 }]);
  });

  it('renumbers equal-time alias reviews deterministically by UUID on non-executing registration', async () => {
    const targetRel = 'docs/alias-review-tie.md';
    const aliasRel = 'docs/alias-review-tie-link.md';
    fs.writeFileSync(path.join(root, targetRel), '# tie\n');
    fs.symlinkSync(path.basename(targetRel), path.join(root, aliasRel));
    const project = await admin.query<{ id: string }>(`SELECT id FROM projects WHERE slug='plan43-test'`);
    const rows = await admin.query<{ id: string; path: string }>(
      `INSERT INTO plans(project_id,slug,path,title,status) VALUES
       ($1,'alias-tie-survivor',$2,'survivor','draft'),
       ($1,'alias-tie-loser',$3,'loser','draft') RETURNING id,path`,
      [project.rows[0].id, targetRel, aliasRel]
    );
    const survivor = rows.rows.find((row) => row.path === targetRel);
    const loser = rows.rows.find((row) => row.path === aliasRel);
    if (!survivor || !loser) throw new Error('alias fixtures missing');
    await admin.query(
      `INSERT INTO plan_reviews(id,plan_id,pass,kind,reviewer_agent,verdict,synthesis,created_at) VALUES
       ('52000000-0000-4000-8000-000000000001',$1,1,'blind','first','blocked','first','2026-01-01T00:00:00Z'),
       ('52000000-0000-4000-8000-000000000002',$2,1,'blind','second','approved','second','2026-01-01T00:00:00Z')`,
      [survivor.id, loser.id]
    );
    const { planRegister } = await import('../plans.js');
    expect((await planRegister({ path: targetRel })).id).toBe(survivor.id);
    const reviews = await admin.query<{ id: string; pass: number; verdict: string }>(
      `SELECT id,pass,verdict FROM plan_reviews WHERE plan_id=$1 ORDER BY pass`, [survivor.id]
    );
    expect(reviews.rows).toEqual([
      { id: '52000000-0000-4000-8000-000000000001', pass: 1, verdict: 'blocked' },
      { id: '52000000-0000-4000-8000-000000000002', pass: 2, verdict: 'approved' },
    ]);
  });

  it('uses the same alias helper for non-executing registration and rolls collisions back', async () => {
    const targetRel = 'docs/alias-plain.md';
    const aliasRel = 'docs/alias-plain-link.md';
    const planBody = checklist([
      { key: 'O1', kind: 'blocking', title: 'same', instructions: 'same' },
    ]);
    fs.writeFileSync(path.join(root, targetRel), planBody);
    fs.symlinkSync(path.basename(targetRel), path.join(root, aliasRel));
    const project = await admin.query<{ id: string }>(`SELECT id FROM projects WHERE slug='plan43-test'`);
    const rows = await admin.query<{ id: string; path: string }>(
      `INSERT INTO plans(project_id,slug,path,title,status) VALUES
       ($1,'alias-plain-survivor',$2,'survivor','draft'),
       ($1,'alias-plain-loser',$3,'loser','draft') RETURNING id,path`,
      [project.rows[0].id, targetRel, aliasRel]
    );
    const survivor = rows.rows.find((row) => row.path === targetRel);
    const loser = rows.rows.find((row) => row.path === aliasRel);
    if (!survivor || !loser) throw new Error('alias fixtures missing');
    const hash = crypto.createHash('sha256').update(JSON.stringify({
      key: 'O1', kind: 'blocking', title: 'same', instructions: 'same',
    })).digest('hex');
    for (const [planId, planSlug] of [
      [survivor.id, 'alias-plain-survivor'], [loser.id, 'alias-plain-loser'],
    ] as const) {
      await admin.query(
        `INSERT INTO operator_tasks(project_id,plan_id,task_key,content_hash,source_kind,source_plan_slug,
         kind,title,instructions,
          assigned_by_agent,assigned_by_session,sort_order)
         VALUES($1,$2,'O1',$3,'plan',$4,'blocking','same','same','a','s',0)`,
        [project.rows[0].id, planId, hash, planSlug]
      );
    }
    const { planRegister } = await import('../plans.js');
    await expect(planRegister({ path: targetRel })).rejects.toThrow(/exists on both plans/);
    expect((await admin.query(`SELECT 1 FROM plans WHERE id=ANY($1::uuid[])`, [[survivor.id, loser.id]])).rowCount).toBe(2);
    expect((await admin.query(`SELECT 1 FROM operator_tasks WHERE plan_id=ANY($1::uuid[])`, [[survivor.id, loser.id]])).rowCount).toBe(2);
    await admin.query(`DELETE FROM operator_tasks WHERE plan_id=$1`, [survivor.id]);
    await admin.query(
      `UPDATE operator_tasks
          SET status='completed',resolved_at='2026-01-02T00:00:00Z',
              removed_at='2026-01-03T00:00:00Z'
        WHERE plan_id=$1 AND task_key='O1'`,
      [loser.id]
    );
    await admin.query(
      `INSERT INTO operator_tasks
       (project_id,plan_id,task_key,content_hash,source_kind,source_plan_slug,kind,title,instructions,
        assigned_by_agent,assigned_by_session,sort_order)
       VALUES($1,$2,'LINKED_ADHOC',$3,'ad_hoc',NULL,'follow_up','adhoc','adhoc','adhoc-agent','adhoc-session',1)`,
      [project.rows[0].id, loser.id, crypto.createHash('sha256').update('adhoc').digest('hex')]
    );
    const before = await admin.query<{ task_key: string; payload: string }>(
      `SELECT task_key,(to_jsonb(t)-'plan_id'-'source_plan_slug')::text AS payload
         FROM operator_tasks t WHERE plan_id=$1 ORDER BY task_key`, [loser.id]
    );
    const merged = await planRegister({ path: targetRel });
    expect(merged.id).toBe(survivor.id);
    const after = await admin.query<{
      task_key: string; id: string; plan_id: string; source_plan_slug: string | null; payload: string;
    }>(
      `SELECT id,task_key,plan_id,source_plan_slug,
              (to_jsonb(t)-'plan_id'-'source_plan_slug')::text AS payload
         FROM operator_tasks t WHERE plan_id=$1 ORDER BY task_key`,
      [survivor.id]
    );
    expect(after.rows.map(({ task_key, payload }) => ({ task_key, payload }))).toEqual(before.rows);
    expect(after.rows.every((row) => row.plan_id === survivor.id)).toBe(true);
    expect(after.rows.map((row) => row.source_plan_slug)).toEqual([null, 'alias-plain-survivor']);

    const originalPlanTaskId = after.rows.find((row) => row.task_key === 'O1')?.id;
    expect(originalPlanTaskId).toBeDefined();
    const planSha = crypto.createHash('sha256').update(planBody).digest('hex');
    await admin.query(`UPDATE plans SET status='approved',current_sha=$2 WHERE id=$1`, [survivor.id, planSha]);
    await admin.query(
      `INSERT INTO plan_reviews(plan_id,pass,kind,reviewer_agent,verdict,plan_sha,synthesis)
       VALUES($1,1,'blind','reviewer','approved',$2,'approved')`,
      [survivor.id, planSha]
    );
    const { syncPlanOperatorTasks } = await import('../operator-tasks.js');
    expect(await syncPlanOperatorTasks({ plan: survivor.id })).toMatchObject({ inserted: 0, existing: 1 });
    const stable = await admin.query<{ id: string; removed_at: Date | null }>(
      `SELECT id,removed_at FROM operator_tasks WHERE plan_id=$1 AND task_key='O1'`, [survivor.id]
    );
    expect(stable.rows[0].id).toBe(originalPlanTaskId);
    expect(stable.rows[0].removed_at).not.toBeNull();
  });

  it('rolls alias consolidation and dependent reassignment back when checklist sync fails', async () => {
    const targetRel = 'docs/alias-failing.md';
    const aliasRel = 'docs/alias-failing-link.md';
    const malformed = '# failing\n\n## Operator Checklist\n\n```operator-checklist\nnot-json\n```\n';
    fs.writeFileSync(path.join(root, targetRel), malformed);
    fs.symlinkSync(path.basename(targetRel), path.join(root, aliasRel));
    const sha = crypto.createHash('sha256').update(malformed).digest('hex');
    const project = await admin.query<{ id: string }>(`SELECT id FROM projects WHERE slug='plan43-test'`);
    const rows = await admin.query<{ id: string; path: string }>(
      `INSERT INTO plans(project_id,slug,path,title,current_sha,status) VALUES
       ($1,'alias-fail-survivor',$2,'survivor',$4,'approved'),
       ($1,'alias-fail-loser',$3,'loser',$4,'approved') RETURNING id,path`,
      [project.rows[0].id, targetRel, aliasRel, sha]
    );
    const survivor = rows.rows.find((row) => row.path === targetRel);
    const loser = rows.rows.find((row) => row.path === aliasRel);
    if (!survivor || !loser) throw new Error('alias fixtures missing');
    await admin.query(
      `INSERT INTO plan_reviews(plan_id,pass,kind,reviewer_agent,verdict,plan_sha,synthesis)
       VALUES($1,1,'blind','reviewer','approved',$2,'clear'),
             ($3,1,'blind','loser','approved',$2,'clear')`, [survivor.id, sha, loser.id]
    );
    await admin.query(
      `INSERT INTO operator_tasks(project_id,plan_id,task_key,content_hash,source_kind,source_plan_slug,
        kind,title,instructions,
        assigned_by_agent,assigned_by_session,sort_order)
       VALUES($1,$2,'LOSER_ONLY',$3,'plan','alias-fail-loser','blocking','kept','kept','a','s',0)`,
      [project.rows[0].id, loser.id, crypto.createHash('sha256').update('kept').digest('hex')]
    );
    const before = await admin.query<{ payload: string }>(
      `SELECT jsonb_build_object(
        'plans',(SELECT jsonb_agg(to_jsonb(p) ORDER BY p.id) FROM plans p WHERE p.id=ANY($1::uuid[])),
        'reviews',(SELECT jsonb_agg(to_jsonb(r) ORDER BY r.id) FROM plan_reviews r WHERE r.plan_id=ANY($1::uuid[])),
        'tasks',(SELECT jsonb_agg(to_jsonb(t) ORDER BY t.id) FROM operator_tasks t WHERE t.plan_id=ANY($1::uuid[])))::text AS payload`,
      [[survivor.id, loser.id]]
    );
    const { planRegister } = await import('../plans.js');
    await expect(planRegister({ path: targetRel, status: 'executing' })).rejects.toThrow(/valid JSON/);
    const after = await admin.query<{ payload: string }>(
      `SELECT jsonb_build_object(
        'plans',(SELECT jsonb_agg(to_jsonb(p) ORDER BY p.id) FROM plans p WHERE p.id=ANY($1::uuid[])),
        'reviews',(SELECT jsonb_agg(to_jsonb(r) ORDER BY r.id) FROM plan_reviews r WHERE r.plan_id=ANY($1::uuid[])),
        'tasks',(SELECT jsonb_agg(to_jsonb(t) ORDER BY t.id) FROM operator_tasks t WHERE t.plan_id=ANY($1::uuid[])))::text AS payload`,
      [[survivor.id, loser.id]]
    );
    expect(after.rows[0].payload).toBe(before.rows[0].payload);
  });

  it('syncs zero, inserts, retries, rejects changed bodies, and preserves provenance', async () => {
    const { operatorTasksPost, syncPlanOperatorTasks } = await import('../operator-tasks.js');
    const empty = await writeApprovedPlan('docs/empty.md', '# Empty\n');
    expect(await syncPlanOperatorTasks({ plan: empty.id })).toMatchObject({ inserted: 0, existing: 0 });
    const plan = await writeApprovedPlan('docs/one.md');
    const first = await syncPlanOperatorTasks({ plan: plan.path, expectedSha: plan.current_sha ?? undefined });
    expect(first).toMatchObject({ inserted: 1, existing: 0, blocking: 1, follow_up: 0 });
    const storedBefore = await admin.query<{ assigned_by_agent: string; assigned_by_session: string; content_hash: string }>(
      `SELECT assigned_by_agent,assigned_by_session,content_hash FROM operator_tasks WHERE plan_id=$1`, [plan.id]
    );
    process.env.MAI_AGENT_ID = 'plan43-agent-b';
    const retry = await syncPlanOperatorTasks({ plan: plan.id });
    expect(retry).toMatchObject({ inserted: 0, existing: 1 });
    expect(await operatorTasksPost({ mode: 'sync-plan', plan_path: plan.path })).toBe(
      `operator tasks for ${plan.title} @ ${plan.current_sha?.slice(0, 8)}: ` +
      `0 inserted, 1 existing; 1 blocking, 0 follow-up — My Tasks: ` +
      `http://127.0.0.1:6601/#/tasks?plan=${plan.id}`
    );
    const storedAfter = await admin.query<{ assigned_by_agent: string; assigned_by_session: string; content_hash: string }>(
      `SELECT assigned_by_agent,assigned_by_session,content_hash FROM operator_tasks WHERE plan_id=$1`, [plan.id]
    );
    expect(storedAfter.rows[0]).toEqual(storedBefore.rows[0]);
    expect(storedAfter.rows[0].assigned_by_agent).toBe('plan43-agent-a');
    expect(storedAfter.rows[0].content_hash).toMatch(/^[0-9a-f]{64}$/);
    await admin.query(`UPDATE operator_tasks SET content_hash=$2 WHERE plan_id=$1`, [plan.id, '0'.repeat(64)]);
    await expect(syncPlanOperatorTasks({ plan: plan.id })).rejects.toThrow(/collision/);
  });

  it('updates only plan task order when equal-content checklist items are reordered', async () => {
    const first = checklist([
      { key: 'O1', kind: 'blocking', title: 'first', instructions: 'first instructions' },
      { key: 'O2', kind: 'follow-up', title: 'second', instructions: 'second instructions' },
    ]);
    const plan = await writeApprovedPlan('docs/reordered.md', first);
    const { syncPlanOperatorTasks } = await import('../operator-tasks.js');
    await syncPlanOperatorTasks({ plan: plan.id });
    await admin.query(
      `UPDATE operator_tasks SET status='completed',resolution_note='kept',resolved_at='2026-01-02T00:00:00Z'
        WHERE plan_id=$1 AND task_key='O1'`, [plan.id]
    );
    const before = await admin.query<{ task_key: string; payload: string }>(
      `SELECT task_key,(to_jsonb(t)-'sort_order')::text AS payload
         FROM operator_tasks t WHERE plan_id=$1 ORDER BY task_key`, [plan.id]
    );
    const reordered = checklist([
      { key: 'O2', kind: 'follow-up', title: 'second', instructions: 'second instructions' },
      { key: 'O1', kind: 'blocking', title: 'first', instructions: 'first instructions' },
    ]);
    fs.writeFileSync(path.join(root, plan.path), reordered);
    const sha = crypto.createHash('sha256').update(reordered).digest('hex');
    await admin.query(`UPDATE plans SET current_sha=$2 WHERE id=$1`, [plan.id, sha]);
    await admin.query(
      `INSERT INTO plan_reviews(plan_id,pass,kind,reviewer_agent,verdict,plan_sha,synthesis)
       VALUES($1,2,'blind','reviewer','approved',$2,'reorder approved')`, [plan.id, sha]
    );
    expect(await syncPlanOperatorTasks({ plan: plan.id })).toMatchObject({ inserted: 0, existing: 2 });
    const after = await admin.query<{ task_key: string; sort_order: number; payload: string }>(
      `SELECT task_key,sort_order,(to_jsonb(t)-'sort_order')::text AS payload
         FROM operator_tasks t WHERE plan_id=$1 ORDER BY task_key`, [plan.id]
    );
    expect(after.rows.map(({ task_key, payload }) => ({ task_key, payload }))).toEqual(before.rows);
    expect(after.rows.map(({ task_key, sort_order }) => ({ task_key, sort_order }))).toEqual([
      { task_key: 'O1', sort_order: 1 }, { task_key: 'O2', sort_order: 0 },
    ]);
  });

  it('fails closed for missing/blocked review, SHA drift, expected SHA mismatch, and foreign path', async () => {
    const { syncPlanOperatorTasks } = await import('../operator-tasks.js');
    fs.writeFileSync(path.join(docs, 'missing-review.md'), one);
    const { planRegister } = await import('../plans.js');
    const missing = await planRegister({ path: 'docs/missing-review.md', status: 'approved' });
    await expect(syncPlanOperatorTasks({ plan: missing.id })).rejects.toThrow(/no latest approved review/);

    const blocked = await writeApprovedPlan('docs/blocked.md');
    await admin.query(
      `INSERT INTO plan_reviews (plan_id,pass,kind,reviewer_agent,verdict,plan_sha,synthesis)
       VALUES ($1,2,'blind','r','blocked',$2,'blocked')`, [blocked.id, blocked.current_sha]
    );
    await expect(syncPlanOperatorTasks({ plan: blocked.id })).rejects.toThrow(/no latest approved review/);

    const drift = await writeApprovedPlan('docs/drift.md');
    fs.appendFileSync(path.join(root, drift.path), '\nchanged\n');
    await expect(syncPlanOperatorTasks({ plan: drift.id })).rejects.toThrow(/SHA drift/);

    const expected = await writeApprovedPlan('docs/expected.md');
    await expect(syncPlanOperatorTasks({ plan: expected.id, expectedSha: 'f'.repeat(64) })).rejects.toThrow(/SHA mismatch/);

    const foreignRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'plan43-foreign-'));
    try {
      await admin.query(
        `INSERT INTO projects (slug,name,path) VALUES ('plan43-foreign','Foreign',$1)`, [foreignRoot]
      );
      await admin.query(
        `INSERT INTO plans (project_id,slug,path,title,status)
         VALUES ((SELECT id FROM projects WHERE slug='plan43-foreign'),'foreign','docs/foreign.md','foreign','approved')`
      );
      await expect(syncPlanOperatorTasks({ plan: 'docs/foreign.md' })).rejects.toThrow(/No registered plan/);
    } finally {
      fs.rmSync(foreignRoot, { recursive: true, force: true });
    }
  });

  it('assigns 1/50 transactionally, normalizes order, retries equally, and rejects collisions/reordering', async () => {
    const { operatorTasksPost } = await import('../operator-tasks.js');
    const tasks = [
      { key: 'Z9', kind: 'follow-up', title: 'z', instructions: 'z' },
      { key: 'A1', kind: 'blocking', title: 'a', instructions: 'a' },
    ];
    const first = await operatorTasksPost({ mode: 'assign', tasks });
    expect(first).toContain('2 inserted');
    expect(first).not.toContain('title');
    const rows = await admin.query<{ task_key: string; kind: string; sort_order: number }>(
      `SELECT task_key,kind,sort_order FROM operator_tasks WHERE source_kind='ad_hoc' ORDER BY sort_order`
    );
    expect(rows.rows).toEqual([
      { task_key: 'Z9', kind: 'follow_up', sort_order: 0 },
      { task_key: 'A1', kind: 'blocking', sort_order: 1 },
    ]);
    expect(await operatorTasksPost({ mode: 'assign', tasks })).toContain('2 existing');
    await expect(operatorTasksPost({ mode: 'assign', tasks: [...tasks].reverse() })).rejects.toThrow(/collision/);
    const fifty = Array.from({ length: 50 }, (_, index) => ({
      key: `B${index}`, kind: 'blocking', title: `t${index}`, instructions: `i${index}`,
    }));
    expect(await operatorTasksPost({ mode: 'assign', tasks: fifty })).toContain('50 inserted');
    await expect(operatorTasksPost({ mode: 'assign', tasks: [] })).rejects.toThrow(/1 to 50/);
    await expect(operatorTasksPost({ mode: 'assign', tasks: [...fifty, fifty[0]] })).rejects.toThrow(/1 to 50/);

    await operatorTasksPost({ mode: 'assign', tasks: [
      { key: 'COLLIDE', kind: 'blocking', title: 'old', instructions: 'old' },
    ] });
    await expect(operatorTasksPost({ mode: 'assign', tasks: [
      { key: 'ROLLBACK', kind: 'blocking', title: 'new', instructions: 'new' },
      { key: 'COLLIDE', kind: 'blocking', title: 'changed', instructions: 'changed' },
    ] })).rejects.toThrow(/collision/);
    const rolledBack = await admin.query<{ n: string }>(
      `SELECT count(*)::text AS n FROM operator_tasks WHERE task_key='ROLLBACK'`
    );
    expect(rolledBack.rows[0].n).toBe('0');
  });

  it('rejects malformed external shapes without inserting and enforces plan association', async () => {
    const { operatorTasksPost } = await import('../operator-tasks.js');
    const invalid = [
      null, [], 7, { mode: 'other' }, { mode: 'sync-plan' },
      { mode: 'sync-plan', plan_path: 'x', extra: true },
      { mode: 'assign', tasks: [{ key: 'bad', kind: 'blocking', title: 'x', instructions: 'y' }] },
      { mode: 'assign', tasks: [{ key: 'A', kind: 'blocking', title: 'x', instructions: 'y', extra: true }] },
    ];
    for (const value of invalid) await expect(operatorTasksPost(value)).rejects.toThrow();
    const prototypeInput = Object.create(null);
    prototypeInput.mode = 'assign';
    prototypeInput.tasks = [{ key: 'PROTO', kind: 'blocking', title: 'x', instructions: 'y' }];
    await expect(operatorTasksPost(prototypeInput)).rejects.toThrow(/plain object/);
    const symbolInput = { mode: 'assign', tasks: [{ key: 'SYMBOL', kind: 'blocking', title: 'x', instructions: 'y' }] };
    Object.defineProperty(symbolInput, Symbol('hidden'), { value: true });
    await expect(operatorTasksPost(symbolInput)).rejects.toThrow(/symbol/);
    const count = await admin.query<{ n: string }>(`SELECT count(*)::text AS n FROM operator_tasks`);
    expect(count.rows[0].n).toBe('0');

    const planA = await writeApprovedPlan('docs/assoc-a.md');
    const planB = await writeApprovedPlan('docs/assoc-b.md');
    const task = [{ key: 'LINK', kind: 'blocking', title: 'same', instructions: 'same' }];
    await operatorTasksPost({ mode: 'assign', plan_path: planA.path, tasks: task });
    await expect(operatorTasksPost({ mode: 'assign', plan_path: planB.path, tasks: task })).rejects.toThrow(/collision/);
    await expect(operatorTasksPost({ mode: 'assign', tasks: task })).rejects.toThrow(/collision/);
    const reverse = [{ key: 'REVERSE', kind: 'blocking', title: 'same', instructions: 'same' }];
    await operatorTasksPost({ mode: 'assign', plan_path: planB.path, tasks: reverse });
    await expect(operatorTasksPost({ mode: 'assign', plan_path: planA.path, tasks: reverse })).rejects.toThrow(/collision/);
    const unlinked = [{ key: 'UNLINKED', kind: 'blocking', title: 'same', instructions: 'same' }];
    await operatorTasksPost({ mode: 'assign', tasks: unlinked });
    await expect(operatorTasksPost({ mode: 'assign', plan_path: planA.path, tasks: unlinked })).rejects.toThrow(/collision/);
  });

  it('narrows hostile payloads and preserves bounded receipts through actual tools/call', async () => {
    const fiftyOne = Array.from({ length: 51 }, (_, index) => ({
      key: `W${index}`, kind: 'blocking', title: 'x', instructions: 'y',
    }));
    const invalid: unknown[] = [
      null, [], 3.5, { extra: true }, { mode: 'wrong' },
      { mode: 'sync-plan' }, { mode: 'sync-plan', plan_path: 'missing.md', extra: true },
      { mode: 'assign', plan_path: 'missing.md', tasks: [], extra: true },
      { mode: 'assign', plan_path: 'missing.md', tasks: [] },
      { mode: 'assign', tasks: fiftyOne },
      { mode: 'assign', tasks: [{ key: 'bad', kind: 'blocking', title: 'x', instructions: 'y' }] },
      { mode: 'assign', tasks: [{ key: 'WIRE_BAD', kind: 'nope', title: 'x', instructions: 'y' }] },
      { mode: 'assign', tasks: [{ key: 'WIRE_BAD', kind: 'blocking', title: '', instructions: 'y' }] },
      { mode: 'assign', tasks: [{ key: 'WIRE_BAD', kind: 'blocking', title: 'x'.repeat(301), instructions: 'y' }] },
      { mode: 'assign', tasks: [{ key: 'WIRE_BAD', kind: 'blocking', title: 'x', instructions: 'y'.repeat(4001) }] },
      { mode: 'assign', plan_path: 1.5, tasks: [{ key: 'WIRE_BAD', kind: 'blocking', title: 'x', instructions: 'y' }] },
      { mode: 'assign', plan_path: 'missing.md', tasks: [{ key: 'WIRE_BAD', kind: 'blocking', title: 'x', instructions: 'y' }] },
      { mode: 'sync-plan', plan_path: 'missing.md', tasks: [{ key: 'WIRE_BAD', kind: 'blocking', title: 'x', instructions: 'y' }] },
    ];
    await withOperatorTaskWire(async (call) => {
      for (const payload of invalid) {
        const result = await call('mai_user_tasks_post', payload);
        expect(result.isError).toBe(true);
      }
      for (const payload of [null, [], 1.5, { extra: true }, { detail: 'wide' }, { history: 1.5 }]) {
        const result = await call('mai_user_tasks', payload);
        expect(result.isError).toBe(true);
      }
      const empty = await admin.query<{ n: string }>(`SELECT count(*)::text AS n FROM operator_tasks`);
      expect(empty.rows[0].n).toBe('0');

      const assigned = await call('mai_user_tasks_post', {
        mode: 'assign', tasks: [
          { key: 'WIRE_Z', kind: 'follow-up', title: 'Follow title', instructions: 'f'.repeat(4000) },
          { key: 'WIRE_A', kind: 'blocking', title: 'Block title', instructions: 'b'.repeat(1900) },
        ],
      });
      expect(assigned.isError).toBe(false);
      expect(assigned.text).toContain('2 inserted');
      expect(assigned.text).toContain('My Tasks: http://127.0.0.1:6601/#/tasks');
      expect(assigned.text).not.toContain('Follow title');
      expect(assigned.text).not.toContain('ffff');
      const stored = await admin.query<{ task_key: string; kind: string; sort_order: number }>(
        `SELECT task_key,kind,sort_order FROM operator_tasks ORDER BY sort_order`
      );
      expect(stored.rows).toEqual([
        { task_key: 'WIRE_Z', kind: 'follow_up', sort_order: 0 },
        { task_key: 'WIRE_A', kind: 'blocking', sort_order: 1 },
      ]);
      const retry = await call('mai_user_tasks_post', {
        mode: 'assign', tasks: [
          { key: 'WIRE_A', kind: 'blocking', title: 'Block title', instructions: 'b'.repeat(1900) },
          { key: 'WIRE_Z', kind: 'follow-up', title: 'Follow title', instructions: 'f'.repeat(4000) },
        ],
      });
      expect(retry.isError).toBe(true);
      const full = await call('mai_user_tasks', { detail: 'full' });
      expect(full.isError).toBe(false);
      expect(full.text.length).toBeLessThanOrEqual(6000);
      expect(full.text).toContain('call mai_user_tasks with one plan_path');
    });
  });
});

describe('reads, ordering, and operator transitions', () => {
  it('returns deterministic grouping/order, excludes bodies from summary, and bounds full output', async () => {
    const { operatorTasksPost, operatorTasksText, listOperatorTasks } = await import('../operator-tasks.js');
    const plan = await writeApprovedPlan('docs/read.md', checklist([
      { key: 'O1', kind: 'follow-up', title: 'Plan follow', instructions: 'p'.repeat(3000) },
      { key: 'O2', kind: 'blocking', title: 'Plan block', instructions: 'block' },
    ]));
    const { syncPlanOperatorTasks } = await import('../operator-tasks.js');
    await syncPlanOperatorTasks({ plan: plan.id });
    await operatorTasksPost({ mode: 'assign', tasks: [
      { key: 'Z', kind: 'follow-up', title: 'Agent follow', instructions: 'agent body' },
      { key: 'A', kind: 'blocking', title: 'Agent block', instructions: 'agent body' },
    ] });
    const project = await admin.query<{ id: string }>(`SELECT id FROM projects WHERE slug='plan43-test'`);
    const listed = await listOperatorTasks({ projectId: project.rows[0].id, includeHistory: true, summaryOnly: false });
    expect(listed.groups.map((group) => group.group_kind)).toEqual(['plan', 'unlinked']);
    expect(listed.groups[0].tasks.map((task) => task.title)).toEqual(['Plan block', 'Plan follow']);
    expect(listed.groups[1].tasks.map((task) => task.title)).toEqual(['Agent block', 'Agent follow']);
    const summary = await operatorTasksText({ plan_path: plan.path, detail: 'summary' });
    expect(summary).toContain('pending=2');
    expect(summary).toContain(`plan ${plan.title}`);
    expect(summary).toContain(`@ ${plan.current_sha?.slice(0, 8)}`);
    expect(summary).toContain(`http://127.0.0.1:6601/#/tasks?plan=${plan.id}`);
    expect(summary).not.toContain('Plan block');
    const full = await operatorTasksText({ detail: 'full', history: true }, { fullRows: 100, charBudget: 6000 });
    expect(full.length).toBeLessThanOrEqual(6000);
    expect(full).toContain('My Tasks');
  });

  it('budgets the complete full-read wire response including its counts heading', async () => {
    const { operatorTasksPost, operatorTasksText } = await import('../operator-tasks.js');
    await operatorTasksPost({ mode: 'assign', tasks: [
      { key: 'WIRE_A', kind: 'blocking', title: 'A', instructions: 'a'.repeat(4000) },
      { key: 'WIRE_B', kind: 'follow-up', title: 'B', instructions: 'b'.repeat(1819) },
    ] });
    const rendered = await operatorTasksText(
      { detail: 'full' }, { fullRows: 3, charBudget: 6000 },
    );
    expect(rendered.length).toBeLessThanOrEqual(6000);
    expect(rendered).toContain('## Unlinked tasks');
  });

  it('budgets summary reads across many agent groups', async () => {
    const { operatorTasksText } = await import('../operator-tasks.js');
    const project = await admin.query<{ id: string }>(`SELECT id FROM projects WHERE slug='plan43-test'`);
    for (let index = 0; index < 30; index += 1) {
      const key = `GROUP_${index}`;
      await admin.query(
        `INSERT INTO operator_tasks
          (project_id,task_key,content_hash,source_kind,kind,title,instructions,
           assigned_by_agent,assigned_by_session,sort_order)
         VALUES ($1,$2,$3,'ad_hoc','blocking',$2,'body',$4,$5,0)`,
        [project.rows[0].id, key, crypto.createHash('sha256').update(key).digest('hex'),
          `agent-${index}-${'x'.repeat(300)}`, `summary-session-${index}`],
      );
    }
    const rendered = await operatorTasksText(
      { detail: 'summary' }, { fullRows: 3, charBudget: 6000 },
    );
    expect(rendered.length).toBeLessThanOrEqual(6000);
    expect(rendered).toContain('operator tasks: pending=30');
    expect(rendered).toContain('- unlinked tasks');
    expect(rendered).not.toContain('agent-29-');
  });

  it('uses every declared tie-breaker across plan, agent, pending, and history rows', async () => {
    const { listOperatorTasks } = await import('../operator-tasks.js');
    const project = await admin.query<{ id: string }>(`SELECT id FROM projects WHERE slug='plan43-test'`);
    const projectId = project.rows[0].id;
    const planA = '00000000-0000-4000-8000-000000000001';
    const planB = '00000000-0000-4000-8000-000000000002';
    await admin.query(
      `INSERT INTO plans (id,project_id,slug,path,title,status,updated_at) VALUES
       ($1,$3,'tie-a','docs/tie-a.md','Tie A','executing','2026-01-01T00:00:00Z'),
       ($2,$3,'tie-b','docs/tie-b.md','Tie B','executing','2026-01-02T00:00:00Z')`,
      [planA, planB, projectId]
    );
    const rows = [
      ['10000000-0000-4000-8000-000000000002', planA, 'PA2', 'plan', 'tie-a', 'blocking', 'plan-a-2', 'a', 'agent-z', 0, 'pending', null, '2026-01-01T00:00:00Z'],
      ['10000000-0000-4000-8000-000000000001', planA, 'PA1', 'plan', 'tie-a', 'blocking', 'plan-a-1', 'a', 'agent-a', 0, 'pending', null, '2026-01-01T00:00:00Z'],
      ['20000000-0000-4000-8000-000000000001', planB, 'PB1', 'plan', 'tie-b', 'follow_up', 'plan-b', 'b', 'agent-b', 0, 'pending', null, '2026-01-01T00:00:00Z'],
      ['30000000-0000-4000-8000-000000000001', null, 'UA1', 'ad_hoc', null, 'blocking', 'agent-a', 'a', 'agent-a', 0, 'pending', null, '2026-01-01T00:00:00Z'],
      ['40000000-0000-4000-8000-000000000001', null, 'UZ1', 'ad_hoc', null, 'blocking', 'agent-z', 'z', 'agent-z', 0, 'pending', null, '2026-01-01T00:00:00Z'],
      ['50000000-0000-4000-8000-000000000001', planA, 'HNEW', 'plan', 'tie-a', 'blocking', 'new history', 'h', 'agent-a', 9, 'completed', '2026-01-03T00:00:00Z', '2026-01-01T00:00:00Z'],
      ['50000000-0000-4000-8000-000000000002', planA, 'HSORT0', 'plan', 'tie-a', 'blocking', 'sort zero', 'h', 'agent-a', 0, 'completed', '2026-01-02T00:00:00Z', '2026-01-01T00:00:00Z'],
      ['50000000-0000-4000-8000-000000000003', planA, 'HSORT1', 'plan', 'tie-a', 'blocking', 'sort one', 'h', 'agent-a', 1, 'completed', '2026-01-02T00:00:00Z', '2026-01-01T00:00:00Z'],
      ['50000000-0000-4000-8000-000000000004', planA, 'HCREATE1', 'plan', 'tie-a', 'blocking', 'created one', 'h', 'agent-a', 2, 'completed', '2026-01-02T00:00:00Z', '2026-01-01T00:00:00Z'],
      ['50000000-0000-4000-8000-000000000005', planA, 'HCREATE2', 'plan', 'tie-a', 'blocking', 'created two', 'h', 'agent-a', 2, 'completed', '2026-01-02T00:00:00Z', '2026-01-02T00:00:00Z'],
      ['50000000-0000-4000-8000-000000000006', planA, 'HID_A', 'plan', 'tie-a', 'blocking', 'id a', 'h', 'agent-a', 3, 'completed', '2026-01-02T00:00:00Z', '2026-01-01T00:00:00Z'],
      ['50000000-0000-4000-8000-000000000007', planA, 'HID_B', 'plan', 'tie-a', 'blocking', 'id b', 'h', 'agent-a', 3, 'completed', '2026-01-02T00:00:00Z', '2026-01-01T00:00:00Z'],
    ];
    for (const row of rows) {
      const terminal = row[10] === 'completed';
      await admin.query(
        `INSERT INTO operator_tasks
          (id,project_id,plan_id,task_key,content_hash,source_kind,source_plan_slug,kind,title,instructions,
           assigned_by_agent,assigned_by_session,sort_order,status,resolved_at,created_at,updated_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,'tie-session',$12,$13,$14,$15,$15)`,
        [row[0], projectId, row[1], row[2], crypto.createHash('sha256').update(String(row[2])).digest('hex'),
          row[3], row[4], row[5], row[6], row[7], row[8], row[9], row[10],
          terminal ? row[11] : null, row[12]]
      );
    }
    const listed = await listOperatorTasks({ projectId, includeHistory: true, summaryOnly: false });
    expect(listed.groups.map((group) => group.group_key)).toEqual([
      `plan:${planB}`, `plan:${planA}`, 'unlinked',
    ]);
    const planAGroup = listed.groups.find((group) => group.group_key === `plan:${planA}`);
    expect(planAGroup?.tasks.map((task) => task.task_key)).toEqual([
      'PA1', 'PA2', 'HNEW', 'HSORT0', 'HSORT1', 'HCREATE1', 'HCREATE2', 'HID_A', 'HID_B',
    ]);
    expect(listed.groups[2].tasks.map((task) => task.task_key)).toEqual(['UA1', 'UZ1']);
  });

  it('completes, reopens, dismisses, advances timestamps, and protects invalid/foreign transitions', async () => {
    const { operatorTasksPost, operatorTaskStatus, OperatorTaskConflictError, OperatorTaskNotFoundError } = await import('../operator-tasks.js');
    await operatorTasksPost({ mode: 'assign', tasks: [
      { key: 'STATE', kind: 'blocking', title: 'state', instructions: 'state' },
      { key: 'DISMISS', kind: 'follow-up', title: 'dismiss', instructions: 'dismiss' },
    ] });
    const project = await admin.query<{ id: string }>(`SELECT id FROM projects WHERE slug='plan43-test'`);
    const taskRows = await admin.query<{ id: string; task_key: string; updated_at: Date }>(
      `SELECT id,task_key,updated_at FROM operator_tasks ORDER BY task_key`
    );
    const dismiss = taskRows.rows.find((row) => row.task_key === 'DISMISS');
    const state = taskRows.rows.find((row) => row.task_key === 'STATE');
    expect(dismiss).toBeDefined();
    expect(state).toBeDefined();
    if (!dismiss || !state) throw new Error('fixture tasks missing');

    await admin.query(`UPDATE operator_tasks SET updated_at=now()-interval '1 minute' WHERE id IN ($1,$2)`, [dismiss.id, state.id]);
    await expect(operatorTaskStatus({ projectId: project.rows[0].id, taskId: state.id, action: 'reopen' }))
      .rejects.toBeInstanceOf(OperatorTaskConflictError);
    const completed = await operatorTaskStatus({ projectId: project.rows[0].id, taskId: state.id, action: 'complete' });
    expect(completed.task.status).toBe('completed');
    expect(new Date(completed.task.updated_at).getTime()).toBeGreaterThan(new Date(state.updated_at).getTime());
    const beforeRejected = completed.task.updated_at;
    await expect(operatorTaskStatus({ projectId: project.rows[0].id, taskId: state.id, action: 'complete' }))
      .rejects.toBeInstanceOf(OperatorTaskConflictError);
    await expect(operatorTaskStatus({ projectId: project.rows[0].id, taskId: state.id, action: 'dismiss', reason: 'no' }))
      .rejects.toBeInstanceOf(OperatorTaskConflictError);
    const unchanged = await admin.query<{ updated_at: Date }>(`SELECT updated_at FROM operator_tasks WHERE id=$1`, [state.id]);
    expect(new Date(unchanged.rows[0].updated_at).getTime()).toBe(new Date(beforeRejected).getTime());
    expect((await operatorTaskStatus({ projectId: project.rows[0].id, taskId: state.id, action: 'reopen' })).task.status).toBe('pending');
    await expect(operatorTaskStatus({ projectId: project.rows[0].id, taskId: dismiss.id, action: 'dismiss', reason: '  ' }))
      .rejects.toBeInstanceOf(OperatorTaskConflictError);
    const dismissed = await operatorTaskStatus({ projectId: project.rows[0].id, taskId: dismiss.id, action: 'dismiss', reason: ' waived ' });
    expect(dismissed.task.resolution_note).toBe('waived');
    await expect(operatorTaskStatus({ projectId: project.rows[0].id, taskId: dismiss.id, action: 'complete' }))
      .rejects.toBeInstanceOf(OperatorTaskConflictError);
    await expect(operatorTaskStatus({ projectId: project.rows[0].id, taskId: dismiss.id, action: 'dismiss', reason: 'again' }))
      .rejects.toBeInstanceOf(OperatorTaskConflictError);
    expect((await operatorTaskStatus({ projectId: project.rows[0].id, taskId: dismiss.id, action: 'reopen' })).task.resolution_note).toBeNull();

    await expect(operatorTaskStatus({ projectId: crypto.randomUUID(), taskId: state.id, action: 'complete' }))
      .rejects.toBeInstanceOf(OperatorTaskNotFoundError);
    await expect(operatorTaskStatus({ projectId: project.rows[0].id, taskId: crypto.randomUUID(), action: 'complete' }))
      .rejects.toBeInstanceOf(OperatorTaskNotFoundError);
  });

  it('removes completed and dismissed rows atomically while hiding every tombstone read surface', async () => {
    const plan = await writeApprovedPlan('docs/remove-terminal.md', checklist([
      { key: 'O1', kind: 'blocking', title: 'Completed title', instructions: 'completed body' },
      { key: 'O2', kind: 'follow-up', title: 'Dismissed title', instructions: 'dismissed body' },
    ]));
    const {
      syncPlanOperatorTasks, operatorTaskStatus, removeOperatorTasks, listOperatorTasks,
      operatorTasksText, OperatorTaskConflictError,
    } = await import('../operator-tasks.js');
    await syncPlanOperatorTasks({ plan: plan.id });
    const project = await admin.query<{ id: string }>(`SELECT id FROM projects WHERE slug='plan43-test'`);
    const ids = await admin.query<{ id: string; task_key: string }>(
      `SELECT id,task_key FROM operator_tasks WHERE plan_id=$1 ORDER BY task_key`, [plan.id]
    );
    const completedId = ids.rows.find((row) => row.task_key === 'O1')?.id;
    const dismissedId = ids.rows.find((row) => row.task_key === 'O2')?.id;
    if (!completedId || !dismissedId) throw new Error('terminal fixtures missing');
    await operatorTaskStatus({ projectId: project.rows[0].id, taskId: completedId, action: 'complete' });
    await operatorTaskStatus({
      projectId: project.rows[0].id, taskId: dismissedId, action: 'dismiss', reason: 'waived',
    });
    const before = await admin.query<{
      id: string; status: string; resolution_note: string | null; resolved_at: Date;
    }>(
      `SELECT id,status,resolution_note,resolved_at FROM operator_tasks
        WHERE id=ANY($1::uuid[]) ORDER BY id`, [[completedId, dismissedId]]
    );
    expect(await removeOperatorTasks({
      projectId: project.rows[0].id, target: { mode: 'tasks', taskIds: [completedId, dismissedId] },
    })).toEqual({ removed_count: 2 });
    const after = await admin.query<{
      id: string; status: string; resolution_note: string | null; resolved_at: Date; removed_at: Date | null;
    }>(
      `SELECT id,status,resolution_note,resolved_at,removed_at FROM operator_tasks
        WHERE id=ANY($1::uuid[]) ORDER BY id`, [[completedId, dismissedId]]
    );
    expect(after.rows.map(({ removed_at: _removedAt, ...row }) => row)).toEqual(before.rows);
    expect(after.rows.every((row) => row.removed_at !== null)).toBe(true);

    const listed = await listOperatorTasks({
      projectId: project.rows[0].id, includeHistory: true, summaryOnly: false,
    });
    expect(listed).toMatchObject({ pending_count: 0, blocking_count: 0, follow_up_count: 0 });
    expect(listed.rows).toEqual([]);
    expect(listed.groups).toEqual([]);
    const summary = await operatorTasksText({ history: true, detail: 'summary' });
    const full = await operatorTasksText({ history: true, detail: 'full' });
    for (const text of [summary, full]) {
      expect(text).not.toContain('Completed title');
      expect(text).not.toContain('Dismissed title');
    }
    await expect(operatorTaskStatus({
      projectId: project.rows[0].id, taskId: completedId, action: 'reopen',
    })).rejects.toBeInstanceOf(OperatorTaskConflictError);
  });

  it('rejects malformed, duplicate, pending, missing, foreign, mixed, and removed task sets without partial stamps', async () => {
    const {
      operatorTasksPost, operatorTaskStatus, removeOperatorTasks,
      OperatorTaskConflictError, OperatorTaskNotFoundError,
    } = await import('../operator-tasks.js');
    await operatorTasksPost({ mode: 'assign', tasks: [
      { key: 'REMOVE_OK', kind: 'blocking', title: 'terminal', instructions: 'terminal' },
      { key: 'REMOVE_PENDING', kind: 'follow-up', title: 'pending', instructions: 'pending' },
    ] });
    const project = await admin.query<{ id: string }>(`SELECT id FROM projects WHERE slug='plan43-test'`);
    const local = await admin.query<{ id: string; task_key: string }>(
      `SELECT id,task_key FROM operator_tasks WHERE task_key IN ('REMOVE_OK','REMOVE_PENDING')`
    );
    const terminalId = local.rows.find((row) => row.task_key === 'REMOVE_OK')?.id;
    const pendingId = local.rows.find((row) => row.task_key === 'REMOVE_PENDING')?.id;
    if (!terminalId || !pendingId) throw new Error('removal fixtures missing');
    await operatorTaskStatus({ projectId: project.rows[0].id, taskId: terminalId, action: 'complete' });

    const foreign = await admin.query<{ id: string }>(
      `INSERT INTO projects(slug,name,path) VALUES('plan44-removal-foreign','foreign',$1) RETURNING id`,
      [root]
    );
    const foreignId = crypto.randomUUID();
    await admin.query(
      `INSERT INTO operator_tasks
       (id,project_id,task_key,content_hash,source_kind,kind,title,instructions,
        assigned_by_agent,assigned_by_session,sort_order,status,resolved_at)
       VALUES($1,$2,'FOREIGN_REMOVE',$3,'ad_hoc','blocking','foreign','foreign','agent','foreign-session',0,
              'completed',now())`,
      [foreignId, foreign.rows[0].id, crypto.createHash('sha256').update('foreign-remove').digest('hex')]
    );
    try {
      const conflictSets: readonly (readonly string[])[] = [
        [], ['bad'], [terminalId, terminalId], [pendingId], [terminalId, pendingId],
      ];
      for (const taskIds of conflictSets) {
        await expect(removeOperatorTasks({
          projectId: project.rows[0].id, target: { mode: 'tasks', taskIds },
        })).rejects.toBeInstanceOf(OperatorTaskConflictError);
      }
      for (const taskIds of [[crypto.randomUUID()], [foreignId], [terminalId, crypto.randomUUID()]]) {
        await expect(removeOperatorTasks({
          projectId: project.rows[0].id, target: { mode: 'tasks', taskIds },
        })).rejects.toBeInstanceOf(OperatorTaskNotFoundError);
      }
      const untouched = await admin.query<{ removed_at: Date | null }>(
        `SELECT removed_at FROM operator_tasks WHERE id=$1`, [terminalId]
      );
      expect(untouched.rows[0].removed_at).toBeNull();
      expect(await removeOperatorTasks({
        projectId: project.rows[0].id, target: { mode: 'tasks', taskIds: [terminalId] },
      })).toEqual({ removed_count: 1 });
      await expect(removeOperatorTasks({
        projectId: project.rows[0].id, target: { mode: 'tasks', taskIds: [terminalId] },
      })).rejects.toBeInstanceOf(OperatorTaskConflictError);
      expect((await admin.query<{ removed_at: Date | null }>(
        `SELECT removed_at FROM operator_tasks WHERE id=$1`, [foreignId]
      )).rows[0].removed_at).toBeNull();
    } finally {
      await admin.query(`DELETE FROM projects WHERE id=$1`, [foreign.rows[0].id]);
    }
  });

  it('removes 101-row plan and unlinked groups atomically and rejects stale membership snapshots', async () => {
    const planItems = Array.from({ length: 100 }, (_, index) => ({
      key: `O${index + 1}`,
      kind: index % 2 === 0 ? 'blocking' as const : 'follow-up' as const,
      title: `plan ${index}`,
      instructions: `plan instructions ${index}`,
    }));
    const plan = await writeApprovedPlan('docs/remove-groups.md', checklist(planItems));
    const {
      syncPlanOperatorTasks, operatorTasksPost, listOperatorTasks, removeOperatorTasks,
      operatorTaskStatus, OperatorTaskConflictError,
    } = await import('../operator-tasks.js');
    await syncPlanOperatorTasks({ plan: plan.id });
    await operatorTasksPost({ mode: 'assign', plan_path: plan.path, tasks: [
      { key: 'LINKED_101', kind: 'follow-up', title: 'linked ad hoc', instructions: 'linked' },
    ] });
    const project = await admin.query<{ id: string }>(`SELECT id FROM projects WHERE slug='plan43-test'`);
    await admin.query(
      `UPDATE operator_tasks SET status='completed',resolved_at=now(),updated_at=now()
        WHERE project_id=$1 AND plan_id=$2`, [project.rows[0].id, plan.id]
    );
    let listed = await listOperatorTasks({
      projectId: project.rows[0].id, includeHistory: true, summaryOnly: false,
    });
    const planGroup = listed.groups.find((group) => group.group_key === `plan:${plan.id}`);
    expect(planGroup?.tasks).toHaveLength(101);
    expect(planGroup?.removal_snapshot).toMatch(/^[0-9a-f]{64}$/);
    expect(await removeOperatorTasks({
      projectId: project.rows[0].id,
      target: { mode: 'group', groupKey: `plan:${plan.id}`, snapshot: planGroup?.removal_snapshot ?? '' },
    })).toEqual({ removed_count: 101 });

    const unlinked = Array.from({ length: 101 }, (_, index) => ({
      key: `UNLINKED_${index}`,
      kind: index % 2 === 0 ? 'blocking' as const : 'follow-up' as const,
      title: `unlinked ${index}`,
      instructions: `unlinked instructions ${index}`,
    }));
    await operatorTasksPost({ mode: 'assign', tasks: unlinked.slice(0, 50) });
    await operatorTasksPost({ mode: 'assign', tasks: unlinked.slice(50, 100) });
    await operatorTasksPost({ mode: 'assign', tasks: unlinked.slice(100) });
    await admin.query(
      `UPDATE operator_tasks SET status='completed',resolved_at=now(),updated_at=now()
        WHERE project_id=$1 AND plan_id IS NULL AND removed_at IS NULL`, [project.rows[0].id]
    );
    listed = await listOperatorTasks({
      projectId: project.rows[0].id, includeHistory: true, summaryOnly: false,
    });
    const unlinkedGroup = listed.groups.find((group) => group.group_key === 'unlinked');
    expect(unlinkedGroup?.tasks).toHaveLength(101);
    expect(await removeOperatorTasks({
      projectId: project.rows[0].id,
      target: { mode: 'group', groupKey: 'unlinked', snapshot: unlinkedGroup?.removal_snapshot ?? '' },
    })).toEqual({ removed_count: 101 });

    const stalePlan = await writeApprovedPlan('docs/stale-group.md', checklist([
      { key: 'O1', kind: 'blocking', title: 'stale one', instructions: 'stale one' },
    ]));
    await syncPlanOperatorTasks({ plan: stalePlan.id });
    const staleRow = await admin.query<{ id: string }>(
      `SELECT id FROM operator_tasks WHERE plan_id=$1 AND task_key='O1'`, [stalePlan.id]
    );
    await operatorTaskStatus({
      projectId: project.rows[0].id, taskId: staleRow.rows[0].id, action: 'complete',
    });
    listed = await listOperatorTasks({
      projectId: project.rows[0].id, includeHistory: true, summaryOnly: false,
    });
    let staleSnapshot = listed.groups.find((group) => group.group_key === `plan:${stalePlan.id}`)?.removal_snapshot;
    await operatorTasksPost({ mode: 'assign', plan_path: stalePlan.path, tasks: [
      { key: 'STALE_ADD', kind: 'follow-up', title: 'added', instructions: 'added' },
    ] });
    await admin.query(
      `UPDATE operator_tasks SET status='completed',resolved_at=now(),updated_at=now()
        WHERE plan_id=$1 AND task_key='STALE_ADD'`, [stalePlan.id]
    );
    await expect(removeOperatorTasks({
      projectId: project.rows[0].id,
      target: { mode: 'group', groupKey: `plan:${stalePlan.id}`, snapshot: staleSnapshot ?? '' },
    })).rejects.toBeInstanceOf(OperatorTaskConflictError);
    expect((await admin.query<{ n: string }>(
      `SELECT count(*)::text AS n FROM operator_tasks WHERE plan_id=$1 AND removed_at IS NOT NULL`, [stalePlan.id]
    )).rows[0].n).toBe('0');

    listed = await listOperatorTasks({ projectId: project.rows[0].id, includeHistory: true, summaryOnly: false });
    staleSnapshot = listed.groups.find((group) => group.group_key === `plan:${stalePlan.id}`)?.removal_snapshot;
    await operatorTaskStatus({
      projectId: project.rows[0].id, taskId: staleRow.rows[0].id, action: 'reopen',
    });
    await expect(removeOperatorTasks({
      projectId: project.rows[0].id,
      target: { mode: 'group', groupKey: `plan:${stalePlan.id}`, snapshot: staleSnapshot ?? '' },
    })).rejects.toBeInstanceOf(OperatorTaskConflictError);

    await operatorTaskStatus({
      projectId: project.rows[0].id, taskId: staleRow.rows[0].id, action: 'complete',
    });
    listed = await listOperatorTasks({ projectId: project.rows[0].id, includeHistory: true, summaryOnly: false });
    staleSnapshot = listed.groups.find((group) => group.group_key === `plan:${stalePlan.id}`)?.removal_snapshot;
    await admin.query(`UPDATE operator_tasks SET updated_at=updated_at+interval '1 second' WHERE id=$1`, [staleRow.rows[0].id]);
    await expect(removeOperatorTasks({
      projectId: project.rows[0].id,
      target: { mode: 'group', groupKey: `plan:${stalePlan.id}`, snapshot: staleSnapshot ?? '' },
    })).rejects.toBeInstanceOf(OperatorTaskConflictError);
    expect((await admin.query<{ n: string }>(
      `SELECT count(*)::text AS n FROM operator_tasks WHERE plan_id=$1 AND removed_at IS NOT NULL`, [stalePlan.id]
    )).rows[0].n).toBe('0');
  });

  it('reattaches identical plan tasks after deletion without resurrecting removed history', async () => {
    const {
      syncPlanOperatorTasks, operatorTaskStatus, removeOperatorTasks, listOperatorTasks,
    } = await import('../operator-tasks.js');
    const body = checklist([
      { key: 'O1', kind: 'blocking', title: 'visible pending', instructions: 'pending' },
      { key: 'O2', kind: 'follow-up', title: 'removed terminal', instructions: 'terminal' },
    ]);
    const plan = await writeApprovedPlan('docs/delete.md', body);
    await syncPlanOperatorTasks({ plan: plan.id });
    const project = await admin.query<{ id: string }>(`SELECT id FROM projects WHERE slug='plan43-test'`);
    const original = await admin.query<{ id: string; task_key: string }>(
      `SELECT id,task_key FROM operator_tasks WHERE plan_id=$1 ORDER BY task_key`, [plan.id]
    );
    const removedId = original.rows.find((row) => row.task_key === 'O2')?.id;
    if (!removedId) throw new Error('removed fixture missing');
    await operatorTaskStatus({ projectId: project.rows[0].id, taskId: removedId, action: 'complete' });
    await removeOperatorTasks({
      projectId: project.rows[0].id, target: { mode: 'tasks', taskIds: [removedId] },
    });
    await admin.query(`DELETE FROM plans WHERE id=$1`, [plan.id]);
    const unlinked = await listOperatorTasks({
      projectId: project.rows[0].id, includeHistory: true, summaryOnly: false,
    });
    expect(unlinked.groups.map((group) => group.group_key)).toEqual(['unlinked']);
    expect(unlinked.groups[0].tasks.map((task) => task.task_key)).toEqual(['O1']);
    expect(unlinked.rows.some((task) => task.id === removedId)).toBe(false);

    const replacement = await writeApprovedPlan('docs/delete.md', body);
    expect(replacement.id).not.toBe(plan.id);
    expect(await syncPlanOperatorTasks({ plan: replacement.id })).toMatchObject({ inserted: 0, existing: 2 });
    const reattached = await admin.query<{
      id: string; task_key: string; plan_id: string; removed_at: Date | null;
    }>(
      `SELECT id,task_key,plan_id,removed_at FROM operator_tasks
        WHERE source_plan_slug=$1 ORDER BY task_key`, [replacement.slug]
    );
    expect(reattached.rows).toHaveLength(2);
    expect(reattached.rows.map((row) => row.id)).toEqual(original.rows.map((row) => row.id));
    expect(reattached.rows.every((row) => row.plan_id === replacement.id)).toBe(true);
    expect(reattached.rows.find((row) => row.task_key === 'O2')?.removed_at).not.toBeNull();
  });
});
