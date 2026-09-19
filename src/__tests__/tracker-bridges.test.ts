/** Tracker bridges (plan 21): review verdict → the plan's board thread, and
 * plan lifecycle auto-advance from the git-sync pass.
 *
 * Throwaway project + cascade cleanup (lesson 63fb332c — no read verb in
 * mai-mcp is write-free, so nothing here may delete rows out of a shared
 * project). The DB URL comes from the validated disposable test variable, never
 * an inherited MAI_DB_URL (plans-findings pass-4 B7): this suite DELETES the
 * project it uses, so it must be impossible to point it at the operator's real
 * brain. The validated database name must start `mai_plan23_` and can never be
 * `mai_brain`. Fake embedder throughout — no model load, no network
 * (plan 14 R8). */
import { beforeAll, afterAll, beforeEach, describe, expect, it } from 'vitest';
import { Pool } from 'pg';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { requireDisposableTestDbUrl } from './test-db-url.js';

// Restore EVERYTHING this file mutates: the pinned/DB/agent/toggle vars are
// captured at module top BEFORE mutation; the embedding trio is captured in
// beforeAll AFTER dotenv defusal.
const saved: Record<string, string | undefined> = {
  MAI_PROJECT_SLUG: process.env.MAI_PROJECT_SLUG,
  MAI_DB_URL: process.env.MAI_DB_URL,
  MAI_LLM_SUMMARY: process.env.MAI_LLM_SUMMARY,
  MAI_AGENT_ID: process.env.MAI_AGENT_ID,
  MAI_PLAN_AUTOADVANCE: process.env.MAI_PLAN_AUTOADVANCE,
};
process.env.MAI_PROJECT_SLUG = 'plan21-test';
process.env.MAI_DB_URL = requireDisposableTestDbUrl();
process.env.MAI_LLM_SUMMARY = '0';
process.env.MAI_AGENT_ID = 'tester@vitest';
// '' means UNSET to the resolver — this suite never `delete`s an env gate
// (lesson 57ac4b5a: src/env.ts's dotenv load repopulates a missing key).
process.env.MAI_PLAN_AUTOADVANCE = '';

const admin = new Pool({ connectionString: process.env.MAI_DB_URL });
const PLAN_REL = 'docs/superpowers/plans/2026-08-12-plan-99-fixture.md';
let repo: string;
let projectId: string;

function fakeVec(text: string): number[] {
  const v = new Array(384).fill(0);
  for (let i = 0; i < text.length; i++) v[(text.charCodeAt(i) * 31 + i) % 384] += 1;
  return v;
}

interface MessageRow {
  id: string;
  thread_id: string | null;
  status: string;
  body: string;
  author_agent: string;
  author_session: string | null;
  refs: Array<{ kind: string; id?: string; path?: string }>;
}

async function messages(status?: string): Promise<MessageRow[]> {
  const r = await admin.query<MessageRow>(
    `SELECT id, thread_id, status, body, author_agent, author_session, refs
       FROM agent_messages
      WHERE project_id = $1 AND ($2::text IS NULL OR status = $2)
      ORDER BY created_at ASC, id ASC`,
    [projectId, status ?? null]
  );
  return r.rows;
}

async function threadRootOf(planId: string): Promise<string | null> {
  const r = await admin.query<{ board_thread_id: string | null }>(
    `SELECT board_thread_id FROM plans WHERE id = $1`,
    [planId]
  );
  return r.rows[0]?.board_thread_id ?? null;
}

beforeAll(async () => {
  await import('../db.js'); // dotenv defusal before scrubbing (plan-13 P2-B1)
  for (const k of ['MAI_EMBEDDINGS', 'OPENAI_API_KEY', 'VOYAGE_API_KEY']) saved[k] = process.env[k];
  repo = fs.mkdtempSync(path.join(os.tmpdir(), 'plan21-'));
  fs.mkdirSync(path.join(repo, 'docs/superpowers/plans'), { recursive: true });
  await admin.query(`DELETE FROM projects WHERE slug = 'plan21-test'`);
  const p = await admin.query<{ id: string }>(
    `INSERT INTO projects (slug, name, path, metadata)
     VALUES ('plan21-test', 'Plan21 Test', $1, $2::jsonb) RETURNING id`,
    [repo, JSON.stringify({ repos: [repo] })]
  );
  projectId = p.rows[0].id;
});

afterAll(async () => {
  const { setLocalEmbedderForTests } = await import('../embeddings.js');
  setLocalEmbedderForTests(null);
  for (const [k, v] of Object.entries(saved)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  await admin.query(`DELETE FROM projects WHERE slug = 'plan21-test'`);
  await admin.end();
  const { getPool } = await import('../db.js');
  await getPool().end();
  fs.rmSync(repo, { recursive: true, force: true });
});

beforeEach(async () => {
  process.env.MAI_EMBEDDINGS = '1';
  delete process.env.OPENAI_API_KEY;
  delete process.env.VOYAGE_API_KEY;
  process.env.MAI_PLAN_AUTOADVANCE = '';
  const { setLocalEmbedderForTests } = await import('../embeddings.js');
  setLocalEmbedderForTests(async (t) => fakeVec(t));
  await admin.query(`DELETE FROM agent_messages WHERE project_id = $1`, [projectId]);
  await admin.query(`DELETE FROM operator_tasks WHERE project_id = $1`, [projectId]);
  await admin.query(`DELETE FROM plans WHERE project_id = $1`, [projectId]);
  await admin.query(`DELETE FROM code_commits WHERE project_id = $1`, [projectId]);
  await admin.query(`DELETE FROM write_violations WHERE project_id = $1`, [projectId]);
  await admin.query(
    `UPDATE projects SET path = $2, metadata = $3::jsonb WHERE id = $1`,
    [projectId, repo, JSON.stringify({ repos: [repo] })]
  );
  fs.mkdirSync(path.join(repo, 'docs/superpowers/plans'), { recursive: true });
  fs.writeFileSync(path.join(repo, PLAN_REL), '# Fixture plan 99\n\n- [ ] Step 1\n');
});

describe('postMessage seam (plan 21 R2)', () => {
  it('returns a structured result and boardPost formats it byte-identically', async () => {
    const { postMessage, boardPost } = await import('../coordination/board.js');
    const posted = await postMessage({ type: 'note', body: 'seam probe one' });
    expect(posted.ok).toBe(true);
    if (!posted.ok) return;
    expect(posted.id).toMatch(/^[0-9a-f-]{36}$/);
    expect(posted.threadId).toBeNull();
    expect(posted.duplicate).toBe(false);
    expect(posted.resolveNote).toBe('');

    const line = await boardPost({ type: 'note', body: 'seam probe two' });
    const rows = await messages();
    const second = rows.find((m) => m.body === 'seam probe two');
    expect(second).toBeDefined();
    expect(line).toBe(`posted [note] ${second?.id}`);
  });

  it('the duplicate path returns the existing id and boardPost says so', async () => {
    const { postMessage, boardPost } = await import('../coordination/board.js');
    const first = await postMessage({ type: 'note', body: 'seam duplicate probe' });
    expect(first.ok).toBe(true);
    if (!first.ok) return;
    const again = await postMessage({ type: 'note', body: 'seam duplicate probe' });
    expect(again.ok).toBe(true);
    if (!again.ok) return;
    expect(again.duplicate).toBe(true);
    expect(again.id).toBe(first.id);
    const line = await boardPost({ type: 'note', body: 'seam duplicate probe' });
    expect(line).toBe(`duplicate — already posted as ${first.id}. Not re-posted.`);
    expect((await messages()).filter((m) => m.body === 'seam duplicate probe')).toHaveLength(1);
  });

  it('resolves + resolution transitions the target and reports it in both surfaces', async () => {
    const { postMessage, boardPost } = await import('../coordination/board.js');
    const target = await postMessage({ type: 'question', body: 'seam target question' });
    expect(target.ok).toBe(true);
    if (!target.ok) return;
    const reply = await postMessage({
      type: 'answer', body: 'seam reply', resolves: target.id, resolution: 'superseded',
    });
    expect(reply.ok).toBe(true);
    if (!reply.ok) return;
    expect(reply.threadId).toBe(target.id); // thread canonicalized to the root
    expect(reply.resolveNote).toBe(` — marked ${target.id.slice(0, 8)} superseded`);
    const closed = (await messages()).find((m) => m.id === target.id);
    expect(closed?.status).toBe('superseded');

    // Second resolve of an already-closed target is reported, not overwritten.
    const line = await boardPost({ type: 'answer', body: 'seam reply two', resolves: target.id });
    expect(line).toContain(`was already closed (left as-is)`);
  });

  it('author overrides author_agent only — author_session stays the process session', async () => {
    const { postMessage, SERVER_AGENT } = await import('../coordination/board.js');
    const { INSTANCE_SESSION } = await import('../session-identity.js');
    const posted = await postMessage({ type: 'note', body: 'seam author probe', author: SERVER_AGENT });
    expect(posted.ok).toBe(true);
    if (!posted.ok) return;
    const row = (await messages()).find((m) => m.id === posted.id);
    expect(SERVER_AGENT).toBe('mai@server');
    expect(row?.author_agent).toBe('mai@server');
    expect(row?.author_session).toBe(INSTANCE_SESSION);
    // The default is unchanged: no author → agentIdentity() (MAI_AGENT_ID).
    const plain = await postMessage({ type: 'note', body: 'seam author default' });
    expect(plain.ok).toBe(true);
    if (!plain.ok) return;
    expect((await messages()).find((m) => m.id === plain.id)?.author_agent).toBe('tester@vitest');
  });
});

describe('Bridge A — review verdict → the plan board thread (plan 21 R4/R5)', () => {
  async function register(): Promise<{ id: string; slug: string; path: string }> {
    const { planRegister } = await import('../plans.js');
    const p = await planRegister({ path: PLAN_REL });
    return { id: p.id, slug: p.slug, path: p.path };
  }

  /** Deterministic concurrency discriminator: the fixed tree must expose a
   * second backend WAITING on the advisory lock. If the second caller reaches
   * the facade instead, or no advisory waiter appears, fail by mechanism — no
   * fixed sleep is treated as proof of serialization. */
  async function requireAdvisoryWaiter(callCount: () => number): Promise<void> {
    const deadline = Date.now() + 2_000;
    while (Date.now() < deadline) {
      if (callCount() > 1) throw new Error('second caller reached the facade before the advisory lock released');
      const waiting = await admin.query<{ n: string }>(
        `SELECT count(*) AS n FROM pg_locks
          WHERE locktype = 'advisory' AND NOT granted
            AND database = (SELECT oid FROM pg_database WHERE datname = current_database())`
      );
      if (Number(waiting.rows[0].n) > 0) return;
      await new Promise<void>((resolve) => setTimeout(resolve, 10));
    }
    throw new Error('second backend never became an advisory-lock waiter');
  }

  it('formatVerdictNote renders the §3.4 shape and capNoteBody keeps it far under the gate', async () => {
    const { formatVerdictNote, capNoteBody } = await import('../plans.js');
    const { FIELD_CHAR_LIMIT } = await import('../write-gate.js');
    const body = formatVerdictNote({
      pass: 3, kind: 'blind', verdict: 'blocked', slug: 'plan-21-tracker-bridges',
      planSha: '81171ec76847ad370bb25f8c2dcf8e2e', openBlockers: 2, openWarnings: 1,
      path: 'docs/superpowers/plans/2026-08-12-plan-21-tracker-bridges.md',
    });
    expect(body).toBe(
      'pass 3 [blind/blocked] on plan-21-tracker-bridges @ 81171ec7 — 2 blocker(s), 1 warning(s) open. ' +
      'Read: mai_plan {path:"docs/superpowers/plans/2026-08-12-plan-21-tracker-bridges.md"}'
    );
    // No sha pinned → the segment disappears entirely (never a bare '@').
    expect(
      formatVerdictNote({
        pass: 1, kind: 'author', verdict: 'approved', slug: 's', planSha: null,
        openBlockers: 0, openWarnings: 0, path: 'p.md',
      })
    ).toBe('pass 1 [author/approved] on s — 0 blocker(s), 0 warning(s) open. Read: mai_plan {path:"p.md"}');
    // The generic cap is enforced in code, not asserted in prose.
    const huge = capNoteBody('z'.repeat(4000));
    expect(huge.length).toBe(900);
    expect(huge.length).toBeLessThan(FIELD_CHAR_LIMIT);
    expect(huge.endsWith('…')).toBe(true);
    // At the board's accepted ref-path bound plus a filesystem-valid slug and
    // 32-bit count fields, the actionable suffix remains complete.
    const maxPath = 'p'.repeat(512);
    const boundary = formatVerdictNote({
      pass: 2147483647, kind: 'blind', verdict: 'blocked', slug: 's'.repeat(255),
      planSha: 'a'.repeat(64), openBlockers: 2147483647, openWarnings: 2147483647,
      path: maxPath,
    });
    expect(boundary.length).toBeLessThanOrEqual(900);
    expect(boundary.length).toBeLessThan(FIELD_CHAR_LIMIT);
    expect(boundary.endsWith(`Read: mai_plan {path:"${maxPath}"}`)).toBe(true);
    expect(capNoteBody('short')).toBe('short');
  });

  it('the first verdict opens the thread, stores its root, and posts the §3.4 body', async () => {
    const plan = await register();
    const { reviewPost } = await import('../plans.js');
    const r = await reviewPost({
      plan: plan.path, kind: 'blind', verdict: 'blocked', synthesis: 'Blocked on two things.',
      findings: [
        { severity: 'blocker', title: 'B1', location: `${PLAN_REL}:1`, issue: 'i', evidence: 'e', fix: 'f' },
        { severity: 'warning', title: 'W1', location: `${PLAN_REL}:1`, issue: 'i', evidence: 'e', fix: 'f' },
      ],
    });
    expect(r.warnings).toEqual([]);
    const open = await messages('open');
    expect(open).toHaveLength(1);
    expect(open[0].body).toMatch(
      new RegExp(`^pass 1 \\[blind/blocked\\] on ${plan.slug} @ [0-9a-f]{8} — 1 blocker\\(s\\), 1 warning\\(s\\) open\\. Read: mai_plan \\{path:"${PLAN_REL}"\\}$`)
    );
    expect(open[0].refs).toEqual([{ kind: 'file', path: PLAN_REL }]);
    expect(await threadRootOf(plan.id)).toBe(open[0].id);
    expect(open[0].thread_id).toBeNull(); // the root's own id IS the thread
  });

  it('a second verdict supersedes the first under the same root — one open note, full chain retained', async () => {
    const plan = await register();
    const { reviewPost } = await import('../plans.js');
    await reviewPost({
      plan: plan.path, kind: 'blind', verdict: 'blocked', synthesis: 'pass one',
      findings: [{ severity: 'blocker', title: 'B1', location: 'x:1', issue: 'i', evidence: 'e', fix: 'f' }],
    });
    const root = await threadRootOf(plan.id);
    await reviewPost({
      plan: plan.path, kind: 'blind', verdict: 'approved', synthesis: 'pass two', findings: [],
    });
    expect(await threadRootOf(plan.id)).toBe(root); // root is stable
    const all = await messages();
    expect(all).toHaveLength(2);
    expect(all[0].status).toBe('superseded');
    expect(all[1].status).toBe('open');
    expect(all[1].thread_id).toBe(root);
    expect(all[1].body).toContain('pass 2 [blind/approved]');
    const open = await messages('open');
    expect(open).toHaveLength(1);
    // boardRead on the root still returns the whole chain oldest-first.
    const { boardRead } = await import('../coordination/board.js');
    const chain = await boardRead({ thread_id: root ?? undefined });
    expect(chain).toContain('pass 1 [blind/blocked]');
    expect(chain).toContain('pass 2 [blind/approved]');
  });

  it('supersedes only the prior server verdict and preserves a newer human question', async () => {
    const plan = await register();
    const { reviewPost } = await import('../plans.js');
    await reviewPost({
      plan: plan.path, kind: 'blind', verdict: 'blocked', synthesis: 'pass one', findings: [],
    });
    const root = await threadRootOf(plan.id);
    const { boardPost } = await import('../coordination/board.js');
    await boardPost({
      type: 'question', body: 'human question that must stay open', thread_id: root ?? undefined,
    });
    await reviewPost({
      plan: plan.path, kind: 'blind', verdict: 'approved', synthesis: 'pass two', findings: [],
    });

    const all = await messages();
    expect(all).toHaveLength(3);
    expect(all.find((m) => m.body.includes('pass 1 [blind/blocked]'))?.status).toBe('superseded');
    expect(all.find((m) => m.body === 'human question that must stay open')?.status).toBe('open');
    expect(all.find((m) => m.body.includes('pass 2 [blind/approved]'))?.status).toBe('open');
    const derivedOpen = (await messages('open')).filter((m) => m.author_agent === 'mai@server');
    expect(derivedOpen).toHaveLength(1);
    expect(derivedOpen[0].body).toContain('pass 2 [blind/approved]');
  });

  it('boardPrimeSection shows exactly ONE line for the plan across three passes', async () => {
    const plan = await register();
    const { reviewPost } = await import('../plans.js');
    for (const [i, verdict] of (['blocked', 'blocked', 'approved'] as const).entries()) {
      await reviewPost({
        plan: plan.path, kind: 'blind', verdict, synthesis: `pass ${i + 1} synthesis`, findings: [],
      });
    }
    const { boardPrimeSection } = await import('../coordination/board.js');
    const section = await boardPrimeSection(projectId);
    expect(section).toContain('## Agent board — 1 open item(s)');
    expect(section.match(/pass \d \[/g)).toEqual(['pass 3 [']);
  });

  it('the note is authored mai@server and a huge review writes ZERO write_violations rows', async () => {
    const plan = await register();
    const { reviewPost } = await import('../plans.js');
    const findings = Array.from({ length: 20 }, (_, i) => ({
      severity: 'warning' as const, title: `W${i}`, location: 'x:1',
      issue: 'i'.repeat(200), evidence: 'e'.repeat(200), fix: 'f'.repeat(200),
    }));
    await reviewPost({
      plan: plan.path, kind: 'blind', verdict: 'blocked', synthesis: 'S'.repeat(4000), findings,
    });
    const open = await messages('open');
    expect(open).toHaveLength(1);
    expect(open[0].author_agent).toBe('mai@server');
    expect(open[0].body.length).toBeLessThanOrEqual(900);
    expect(open[0].body).not.toContain('SSSS'); // the synthesis is NEVER in the body
    const v = await admin.query<{ n: string }>(
      `SELECT count(*) AS n FROM write_violations WHERE project_id = $1`, [projectId]
    );
    expect(Number(v.rows[0].n)).toBe(0);
  });

  it('a notify failure warns but never rolls back the posted review', async () => {
    const plan = await register();
    // The facade is a singleton object and postPlanNote calls it by property,
    // so swapping the method is the one injection that reaches the real code
    // path (the internal call is not interceptable by module mocking).
    const { coordination } = await import('../coordination/index.js');
    const real = coordination.postPlanThreadNote;
    coordination.postPlanThreadNote = async (): Promise<never> => {
      throw new Error('board is down');
    };
    try {
      const { reviewPost } = await import('../plans.js');
      const r = await reviewPost({
        plan: plan.path, kind: 'author', verdict: 'approved', synthesis: 'clean', findings: [],
      });
      expect(r.pass).toBe(1);
      expect(r.warnings.some((w) => w.startsWith('board-notify:'))).toBe(true);
      expect(r.warnings.some((w) => w.includes('board is down'))).toBe(true);
      const rows = await admin.query<{ n: string }>(
        `SELECT count(*) AS n FROM plan_reviews WHERE plan_id = $1`, [plan.id]
      );
      expect(Number(rows.rows[0].n)).toBe(1); // the review COMMITTED
      expect(await messages()).toHaveLength(0); // and nothing was posted
      expect(await threadRootOf(plan.id)).toBeNull();
    } finally {
      coordination.postPlanThreadNote = real;
    }
  });

  it('a stale board_thread_id self-heals into a fresh thread (no FK — §6)', async () => {
    const plan = await register();
    const { reviewPost } = await import('../plans.js');
    await reviewPost({ plan: plan.path, kind: 'blind', verdict: 'blocked', synthesis: 'p1', findings: [] });
    const firstRoot = await threadRootOf(plan.id);
    expect(firstRoot).not.toBeNull();
    await admin.query(`DELETE FROM agent_messages WHERE id = $1`, [firstRoot]);
    await reviewPost({ plan: plan.path, kind: 'blind', verdict: 'approved', synthesis: 'p2', findings: [] });
    const newRoot = await threadRootOf(plan.id);
    expect(newRoot).not.toBe(firstRoot);
    const open = await messages('open');
    expect(open).toHaveLength(1);
    expect(open[0].id).toBe(newRoot);
  });

  it('the SESSION suppression arm skips safely and returns its root for pointer self-heal', async () => {
    // Arm (b): this process already posted body X. Reposting X must be a clean
    // skip — NOT a duplicate-id resolve that would close Y and leave the thread
    // with zero open messages.
    const plan = await register();
    const { postPlanNote } = await import('../plans.js');
    expect((await postPlanNote(plan.id, 'derived body X', [{ kind: 'file', path: PLAN_REL }])).delivery).toBe('posted');
    const root = await threadRootOf(plan.id);
    expect((await postPlanNote(plan.id, 'derived body Y', [{ kind: 'file', path: PLAN_REL }])).delivery).toBe('posted');
    const beforeY = await messages('open');
    expect(beforeY).toHaveLength(1);
    expect(beforeY[0].body).toBe('derived body Y');

    expect((await postPlanNote(plan.id, 'derived body X', [{ kind: 'file', path: PLAN_REL }])).delivery).toBe('suppressed');
    const after = await messages('open');
    expect(after).toHaveLength(1);
    expect(after[0].body).toBe('derived body Y'); // Y is STILL open
    expect(await threadRootOf(plan.id)).toBe(root);
    expect(await messages()).toHaveLength(2); // nothing new was inserted

    // A recreated/null plan pointer may adopt a provenance-matched surviving
    // server row. Structured suppression must return X's canonical root rather
    // than leaving the plan detached or pretending a new note was posted.
    await admin.query(`UPDATE plans SET board_thread_id = NULL WHERE id = $1`, [plan.id]);
    expect((await postPlanNote(
      plan.id, 'derived body X', [{ kind: 'file', path: PLAN_REL }]
    )).delivery).toBe('suppressed');
    expect(await threadRootOf(plan.id)).toBe(root);
    expect(await messages()).toHaveLength(2);

    // But an existing pointer to another live root makes X foreign, not a
    // self-heal candidate. The collision must fail without rewriting either
    // root or closing a message.
    const { postMessage } = await import('../coordination/board.js');
    const foreign = await postMessage({ type: 'note', body: 'unrelated live root' });
    expect(foreign.ok).toBe(true);
    if (!foreign.ok) return;
    await admin.query(`UPDATE plans SET board_thread_id = $2 WHERE id = $1`, [plan.id, foreign.id]);
    await expect(postPlanNote(
      plan.id, 'derived body X', [{ kind: 'file', path: PLAN_REL }]
    )).rejects.toThrow('plan-thread body collides with non-canonical session message');
    expect(await threadRootOf(plan.id)).toBe(foreign.id);
    expect(await messages()).toHaveLength(3);
  });

  it('closing a finding posts NOTHING — finding transitions stay tracker-only (f2f18031 item 1)', async () => {
    const plan = await register();
    const { reviewPost, findingUpdate } = await import('../plans.js');
    const r = await reviewPost({
      plan: plan.path, kind: 'blind', verdict: 'blocked', synthesis: 'one blocker',
      findings: [{ ref: 'B1', severity: 'blocker', title: 'B1', location: 'x:1', issue: 'i', evidence: 'e', fix: 'f' }],
    });
    const before = await messages();
    expect(before).toHaveLength(1);
    await findingUpdate({ finding_id: r.findings[0].id, status: 'fixed', note: 'fixed it' });
    expect(await messages()).toHaveLength(1); // byte-for-byte the same board
    expect((await messages())[0].id).toBe(before[0].id);
  });

  it('serializes concurrent first verdicts: one stable root and exactly one open note', async () => {
    const plan = await register();
    const { postPlanNote } = await import('../plans.js');
    const { coordination } = await import('../coordination/index.js');
    const real = coordination.postPlanThreadNote;
    let calls = 0;
    let pending: Promise<unknown>[] = [];
    let releaseFirst: (() => void) | undefined;
    let firstEntered: (() => void) | undefined;
    const gate = new Promise<void>((resolve) => { releaseFirst = resolve; });
    const entered = new Promise<void>((resolve) => { firstEntered = resolve; });
    coordination.postPlanThreadNote = async (args, client) => {
      calls++;
      if (calls === 1) firstEntered?.();
      await gate;
      return real(args, client);
    };
    try {
      // Exercise the delivery primitive directly. Two reviewPost calls can
      // serialize earlier while updating plans.current_sha, which would make
      // the advisory-lock assertion a false negative.
      const first = postPlanNote(plan.id, 'concurrent verdict A', [{ kind: 'file', path: plan.path }]);
      await entered;
      const second = postPlanNote(plan.id, 'concurrent verdict B', [{ kind: 'file', path: plan.path }]);
      pending = [first, second];
      // Prove the mechanism, not timing: the second backend must be visible as
      // an advisory-lock waiter and cannot have reached the facade.
      await requireAdvisoryWaiter(() => calls);
      expect(calls).toBe(1);
      releaseFirst?.();
      await Promise.all([first, second]);
      const all = await messages();
      expect(all).toHaveLength(2);
      expect(await messages('open')).toHaveLength(1);
      const root = await threadRootOf(plan.id);
      expect(root).toBe(all[0].id);
      expect(all[1].thread_id).toBe(root);
    } finally {
      releaseFirst?.();
      await Promise.allSettled(pending);
      coordination.postPlanThreadNote = real;
    }
  });

  it('serializes concurrent children under an existing root — no two-open-child race', async () => {
    const plan = await register();
    const { postPlanNote } = await import('../plans.js');
    await postPlanNote(plan.id, 'root verdict', [{ kind: 'file', path: plan.path }]);
    const root = await threadRootOf(plan.id);
    const { coordination } = await import('../coordination/index.js');
    const real = coordination.postPlanThreadNote;
    let calls = 0;
    let pending: Promise<unknown>[] = [];
    let releaseFirst: (() => void) | undefined;
    let firstEntered: (() => void) | undefined;
    const gate = new Promise<void>((resolve) => { releaseFirst = resolve; });
    const entered = new Promise<void>((resolve) => { firstEntered = resolve; });
    coordination.postPlanThreadNote = async (args, client) => {
      calls++;
      if (calls === 1) firstEntered?.();
      await gate;
      return real(args, client);
    };
    try {
      const first = postPlanNote(plan.id, 'child verdict A', [{ kind: 'file', path: plan.path }]);
      await entered;
      const second = postPlanNote(plan.id, 'child verdict B', [{ kind: 'file', path: plan.path }]);
      pending = [first, second];
      await requireAdvisoryWaiter(() => calls);
      expect(calls).toBe(1);
      releaseFirst?.();
      await Promise.all([first, second]);
      const all = await messages();
      expect(all).toHaveLength(3);
      expect(await messages('open')).toHaveLength(1);
      expect(await threadRootOf(plan.id)).toBe(root);
      expect(all.slice(1).every((m) => m.thread_id === root)).toBe(true);
    } finally {
      releaseFirst?.();
      await Promise.allSettled(pending);
      coordination.postPlanThreadNote = real;
    }
  });

  it('keeps verdict delivery monotonic when delayed pass 1 resumes after pass 2', async () => {
    const plan = await register();
    const { reviewPost, _setBeforeVerdictDeliveryForTests } = await import('../plans.js');
    let releaseFirst: (() => void) | undefined;
    let firstPaused: (() => void) | undefined;
    const gate = new Promise<void>((resolve) => { releaseFirst = resolve; });
    const paused = new Promise<void>((resolve) => { firstPaused = resolve; });
    _setBeforeVerdictDeliveryForTests(async (pass) => {
      if (pass !== 1) return;
      firstPaused?.();
      await gate;
    });
    try {
      const first = reviewPost({
        plan: plan.path, kind: 'blind', verdict: 'blocked', synthesis: 'older delayed', findings: [],
      });
      await paused;
      const second = await reviewPost({
        plan: plan.path, kind: 'blind', verdict: 'approved', synthesis: 'newer delivered', findings: [],
      });
      expect(second.pass).toBe(2);
      releaseFirst?.();
      await first;
      const open = await messages('open');
      expect(open).toHaveLength(1);
      expect(open[0].body).toContain('pass 2 [blind/approved]');
      expect(open[0].body).not.toContain('pass 1 [');
    } finally {
      releaseFirst?.();
      _setBeforeVerdictDeliveryForTests(null);
    }
  });

  it('rejects a foreign plan id before posting or writing its thread pointer', async () => {
    const foreignSlug = 'plan21-foreign';
    await admin.query(`DELETE FROM projects WHERE slug = $1`, [foreignSlug]);
    const foreign = await admin.query<{ project_id: string; plan_id: string }>(
      `WITH p AS (
         INSERT INTO projects (slug, name, path, metadata)
         VALUES ($1, 'Foreign', $2, '{}'::jsonb) RETURNING id
       ), q AS (
         INSERT INTO plans (project_id, slug, path, title)
         SELECT id, 'foreign-plan', 'foreign.md', 'Foreign' FROM p RETURNING id, project_id
       )
       SELECT project_id, id AS plan_id FROM q`,
      [foreignSlug, repo]
    );
    const ids = foreign.rows[0];
    try {
      const { postPlanNote } = await import('../plans.js');
      await expect(
        postPlanNote(ids.plan_id, 'must not cross the pin wall', [{ kind: 'file', path: 'foreign.md' }])
      ).rejects.toThrow('not found in pinned project');
      expect(await messages()).toHaveLength(0);
      const row = await admin.query<{ board_thread_id: string | null }>(
        `SELECT board_thread_id FROM plans WHERE id = $1 AND project_id = $2`,
        [ids.plan_id, ids.project_id]
      );
      expect(row.rows[0].board_thread_id).toBeNull();
    } finally {
      await admin.query(`DELETE FROM projects WHERE id = $1`, [ids.project_id]);
    }
  });
});

describe('Bridge B — plan lifecycle auto-advance (plan 21 R6-R10)', () => {
  const HOURS = 60 * 60 * 1000;

  /** Register the fixture plan, then BACK-DATE its created_at so the anchor sits
   * two hours in the past and fixture commits can be placed on either side of
   * it without any future-dated rows. */
  async function approvedPlan(status = 'approved'): Promise<{ id: string; slug: string; path: string }> {
    const { planRegister } = await import('../plans.js');
    const p = await planRegister({ path: PLAN_REL });
    await admin.query(
      `UPDATE plans SET status = $2, created_at = now() - interval '2 hours' WHERE id = $1`,
      [p.id, status]
    );
    if (status === 'approved') {
      await admin.query(
        `INSERT INTO plan_reviews
           (plan_id,pass,kind,reviewer_agent,verdict,plan_sha,synthesis,created_at)
         VALUES ($1,1,'blind','plan43-reviewer','approved',$2,'approved for lifecycle fixture',
                 now() - interval '2 hours')`,
        [p.id, p.current_sha]
      );
    }
    return { id: p.id, slug: p.slug, path: p.path };
  }

  async function seedCommit(a: {
    hash: string; message: string; body?: string; agoMs: number; files?: string[]; repoPath?: string;
  }): Promise<string> {
    const at = new Date(Date.now() - a.agoMs).toISOString();
    const c = await admin.query<{ id: string }>(
      `INSERT INTO code_commits (project_id, commit_hash, message, body, timestamp, committed_at, repo_path)
       VALUES ($1,$2,$3,$4,$5::timestamptz,$5::timestamptz,$6) RETURNING id`,
      [projectId, a.hash, a.message, a.body ?? null, at, a.repoPath ?? repo]
    );
    for (const f of a.files ?? []) {
      await admin.query(
        `INSERT INTO commit_files (project_id, commit_id, path, status, additions, deletions)
         VALUES ($1,$2,$3,'modified',1,0)`,
        [projectId, c.rows[0].id, f]
      );
    }
    return c.rows[0].id;
  }

  async function statusOf(planId: string): Promise<string> {
    const r = await admin.query<{ status: string }>(`SELECT status FROM plans WHERE id = $1`, [planId]);
    return r.rows[0].status;
  }

  async function requireLifecycleAdvisoryWaiter(): Promise<void> {
    const deadline = Date.now() + 2_000;
    while (Date.now() < deadline) {
      const waiting = await admin.query<{ n: string }>(
        `SELECT count(*) AS n FROM pg_locks
          WHERE locktype = 'advisory' AND NOT granted
            AND database = (SELECT oid FROM pg_database WHERE datname = current_database())`
      );
      if (Number(waiting.rows[0].n) > 0) return;
      await new Promise<void>((resolve) => setTimeout(resolve, 10));
    }
    throw new Error('lifecycle caller never became an advisory-lock waiter');
  }

  it('lifecycle action suffixes survive supported bounds, and R-A flips on a plan-file commit', async () => {
    const {
      advancePlanLifecycle, formatExecutingNote, formatExecutingSuggestion, formatExecutedSuggestion,
    } = await import('../git/plan-lifecycle.js');
    const { FIELD_CHAR_LIMIT } = await import('../write-gate.js');
    const maxPath = 'p'.repeat(512);
    const boundary = { slug: 's'.repeat(255), commits: 2147483647, path: maxPath };
    const flip = formatExecutingNote(boundary);
    const executing = formatExecutingSuggestion(boundary);
    const executed = formatExecutedSuggestion(boundary);
    for (const body of [flip, executing, executed]) {
      expect(body.length).toBeLessThanOrEqual(900);
      expect(body.length).toBeLessThan(FIELD_CHAR_LIMIT);
    }
    expect(flip.endsWith(`Read: mai_plan {path:"${maxPath}"}`)).toBe(true);
    expect(executing.endsWith(`mai_plan {path:"${maxPath}", status:"executing"}`)).toBe(true);
    expect(executed.endsWith(`mai_plan {path:"${maxPath}", status:"executed"}`)).toBe(true);

    const plan = await approvedPlan();
    const commitId = await seedCommit({
      hash: 'a'.repeat(40), message: 'chore: tick a checkbox', agoMs: 1 * HOURS, files: [PLAN_REL],
    });
    expect(await advancePlanLifecycle(projectId)).toBe(
      'plan lifecycle [auto]: 1 advanced to executing, 1 note(s) posted, 0 suppressed, 0 stale prompt(s) retracted, 0 failed\n' +
      'operator tasks: 0 inserted, 0 existing; 0 blocking, 0 follow-up — My Tasks: http://127.0.0.1:6601/#/tasks'
    );
    expect(await statusOf(plan.id)).toBe('executing');
    const open = await messages('open');
    expect(open).toHaveLength(1);
    expect(open[0].author_agent).toBe('mai@server');
    expect(open[0].body).toBe(
      `${plan.slug} — approved → executing: 1 task commit(s) since approval. Read: mai_plan {path:"${PLAN_REL}"}`
    );
    expect(open[0].refs).toEqual([{ kind: 'commit', id: commitId }]);
    expect(await threadRootOf(plan.id)).toBe(open[0].id);
  });

  it('the Git lifecycle producer syncs checklist rows before its guarded transition', async () => {
    fs.writeFileSync(path.join(repo, PLAN_REL),
      '# Fixture plan 99\n\n## Operator Checklist\n\n```operator-checklist\n' +
      '[{"key":"O1","kind":"blocking","title":"bridge","instructions":"bridge"}]\n```\n');
    const plan = await approvedPlan();
    await seedCommit({
      hash: 'ab'.repeat(20), message: 'chore: start bridge checklist', agoMs: 1 * HOURS, files: [PLAN_REL],
    });
    const { advancePlanLifecycle } = await import('../git/plan-lifecycle.js');
    const receipt = await advancePlanLifecycle(projectId);
    expect(receipt).toContain('operator tasks: 1 inserted, 0 existing; 1 blocking, 0 follow-up');
    expect(await statusOf(plan.id)).toBe('executing');
    const tasks = await admin.query<{
      task_key: string; assigned_by_agent: string; assigned_by_session: string;
    }>(
      `SELECT task_key,assigned_by_agent,assigned_by_session FROM operator_tasks WHERE plan_id=$1`, [plan.id]
    );
    const { INSTANCE_SESSION } = await import('../session-identity.js');
    expect(tasks.rows).toEqual([{
      task_key: 'O1', assigned_by_agent: 'tester@vitest', assigned_by_session: INSTANCE_SESSION,
    }]);
  });

  it('the Git lifecycle producer applies authoritative checklist reorder without rewriting task state', async () => {
    const render = (items: unknown[]) =>
      `# Fixture plan 99\n\n## Operator Checklist\n\n\`\`\`operator-checklist\n${JSON.stringify(items)}\n\`\`\`\n`;
    const first = [
      { key: 'O1', kind: 'blocking', title: 'first', instructions: 'first' },
      { key: 'O2', kind: 'follow-up', title: 'second', instructions: 'second' },
    ];
    fs.writeFileSync(path.join(repo, PLAN_REL), render(first));
    const plan = await approvedPlan();
    const { syncPlanOperatorTasks } = await import('../operator-tasks.js');
    await syncPlanOperatorTasks({ plan: plan.id });
    await admin.query(
      `UPDATE operator_tasks SET status='completed',resolution_note='preserved',resolved_at='2026-01-02T00:00:00Z'
        WHERE plan_id=$1 AND task_key='O1'`, [plan.id]
    );
    const before = await admin.query<{ task_key: string; payload: string }>(
      `SELECT task_key,(to_jsonb(t)-'sort_order')::text AS payload
         FROM operator_tasks t WHERE plan_id=$1 ORDER BY task_key`, [plan.id]
    );
    const reversed = render([...first].reverse());
    fs.writeFileSync(path.join(repo, PLAN_REL), reversed);
    const { createHash } = await import('node:crypto');
    const sha = createHash('sha256').update(reversed).digest('hex');
    await admin.query(`UPDATE plans SET current_sha=$2 WHERE id=$1`, [plan.id, sha]);
    await admin.query(`UPDATE plan_reviews SET plan_sha=$2 WHERE plan_id=$1`, [plan.id, sha]);
    await seedCommit({
      hash: 'ac'.repeat(20), message: 'chore: reorder bridge checklist', agoMs: 1 * HOURS, files: [PLAN_REL],
    });
    const { advancePlanLifecycle } = await import('../git/plan-lifecycle.js');
    expect(await advancePlanLifecycle(projectId)).toContain('operator tasks: 0 inserted, 2 existing');
    const after = await admin.query<{ task_key: string; sort_order: number; payload: string }>(
      `SELECT task_key,sort_order,(to_jsonb(t)-'sort_order')::text AS payload
         FROM operator_tasks t WHERE plan_id=$1 ORDER BY task_key`, [plan.id]
    );
    expect(after.rows.map(({ task_key, payload }) => ({ task_key, payload }))).toEqual(before.rows);
    expect(after.rows.map(({ task_key, sort_order }) => ({ task_key, sort_order }))).toEqual([
      { task_key: 'O1', sort_order: 1 }, { task_key: 'O2', sort_order: 0 },
    ]);
  });

  it('a same-session human body collision rolls back instead of masquerading as suppression', async () => {
    const plan = await approvedPlan();
    await seedCommit({
      hash: '09'.repeat(20), message: 'chore: tick with a body collision', agoMs: 1 * HOURS,
      files: [PLAN_REL],
    });
    const body =
      `${plan.slug} — approved → executing: 1 task commit(s) since approval. ` +
      `Read: mai_plan {path:"${PLAN_REL}"}`;
    // Ordinary boardPost shares INSTANCE_SESSION but is authored by the test
    // agent. Its byte-identical body must never count as the required derived
    // lifecycle note, and the global session+body unique index means the
    // server cannot insert another row with this body in this process.
    const { boardPost } = await import('../coordination/board.js');
    await boardPost({ type: 'note', body });

    const { advancePlanLifecycle } = await import('../git/plan-lifecycle.js');
    expect(await advancePlanLifecycle(projectId)).toBe(
      `plan lifecycle [auto]: 0 advanced to executing, 0 note(s) posted, 0 suppressed, ` +
      `0 stale prompt(s) retracted, 1 failed ` +
      `(${plan.slug}: plan-thread body collides with non-canonical session message)`
    );
    expect(await statusOf(plan.id)).toBe('approved');
    expect(await threadRootOf(plan.id)).toBeNull();
    const all = await messages();
    expect(all).toHaveLength(1);
    expect(all[0].author_agent).toBe('tester@vitest');
    expect(all[0].body).toBe(body);
  });

  it('a board failure rolls back BOTH the approved → executing transition and its note', async () => {
    const plan = await approvedPlan();
    await seedCommit({
      hash: '0'.repeat(40), message: 'chore: tick atomically', agoMs: 1 * HOURS, files: [PLAN_REL],
    });
    const { coordination } = await import('../coordination/index.js');
    const real = coordination.postPlanThreadNote;
    coordination.postPlanThreadNote = async (): Promise<never> => {
      throw new Error('board is down');
    };
    try {
      const { advancePlanLifecycle } = await import('../git/plan-lifecycle.js');
      expect(await advancePlanLifecycle(projectId)).toBe(
        `plan lifecycle [auto]: 0 advanced to executing, 0 note(s) posted, 0 suppressed, ` +
        `0 stale prompt(s) retracted, 1 failed (${plan.slug}: board is down)`
      );
      expect(await statusOf(plan.id)).toBe('approved');
      expect(await messages()).toHaveLength(0);
      expect(await threadRootOf(plan.id)).toBeNull();
    } finally {
      coordination.postPlanThreadNote = real;
    }
  });

  it('reports partial multi-candidate success truthfully and continues after one delivery failure', async () => {
    const first = await approvedPlan();
    fs.writeFileSync(path.join(repo, 'second.md'), '# Second plan\n');
    const secondSha = await import('node:crypto').then(({ createHash }) =>
      createHash('sha256').update(fs.readFileSync(path.join(repo, 'second.md'))).digest('hex'));
    const second = await admin.query<{ id: string; slug: string }>(
      `INSERT INTO plans (project_id, slug, path, title, status, current_sha, created_at, updated_at)
       VALUES ($1, 'plan-97-second', 'second.md', 'Second', 'approved',
               $2, now() - interval '2 hours', now() - interval '1 second')
       RETURNING id, slug`,
      [projectId, secondSha]
    );
    await admin.query(
      `INSERT INTO plan_reviews
         (plan_id,pass,kind,reviewer_agent,verdict,plan_sha,synthesis,created_at)
       VALUES ($1,1,'blind','plan43-reviewer','approved',$2,'approved',now()-interval '2 hours')`,
      [second.rows[0].id, secondSha]
    );
    await admin.query(`UPDATE plans SET updated_at = now() WHERE id = $1`, [first.id]);
    await seedCommit({
      hash: '01'.repeat(20), message: `feat: ${first.slug}`, agoMs: 1 * HOURS, files: ['src/first.ts'],
    });
    await seedCommit({
      hash: '02'.repeat(20), message: 'feat: plan-97-second', agoMs: 1 * HOURS, files: ['src/second.ts'],
    });
    const { coordination } = await import('../coordination/index.js');
    const real = coordination.postPlanThreadNote;
    let calls = 0;
    coordination.postPlanThreadNote = async (args, client) => {
      calls++;
      if (calls === 2) throw new Error('second board failure');
      return real(args, client);
    };
    try {
      const { advancePlanLifecycle } = await import('../git/plan-lifecycle.js');
      expect(await advancePlanLifecycle(projectId)).toBe(
        `plan lifecycle [auto]: 1 advanced to executing, 1 note(s) posted, 0 suppressed, ` +
        `0 stale prompt(s) retracted, 1 failed (${second.rows[0].slug}: second board failure)\n` +
        `operator tasks: 0 inserted, 0 existing; 0 blocking, 0 follow-up — My Tasks: http://127.0.0.1:6601/#/tasks`
      );
      expect(await statusOf(first.id)).toBe('executing');
      expect(await statusOf(second.rows[0].id)).toBe('approved');
      expect(await messages()).toHaveLength(1);
    } finally {
      coordination.postPlanThreadNote = real;
    }
  });

  it('revalidates suggest-executing after the lock and never downgrades a concurrently executed plan', async () => {
    process.env.MAI_PLAN_AUTOADVANCE = 'suggest';
    const plan = await approvedPlan();
    await seedCommit({ hash: '03'.repeat(20), message: 'chore: tick', agoMs: 1 * HOURS, files: [PLAN_REL] });
    const locker = await admin.connect();
    await locker.query('BEGIN');
    await locker.query(`SELECT pg_advisory_xact_lock(hashtextextended($1, 0))`, [`${projectId}:${plan.id}`]);
    try {
      const { advancePlanLifecycle } = await import('../git/plan-lifecycle.js');
      const run = advancePlanLifecycle(projectId);
      await requireLifecycleAdvisoryWaiter(); // initial evaluation is complete; delivery is blocked
      await admin.query(`UPDATE plans SET status = 'executed' WHERE id = $1`, [plan.id]);
      await locker.query('COMMIT');
      expect(await run).toBe(
        'plan lifecycle [suggest]: 0 advanced to executing, 0 note(s) posted, 0 suppressed, ' +
        '0 stale prompt(s) retracted, 0 failed'
      );
      expect(await statusOf(plan.id)).toBe('executed');
      expect(await messages()).toHaveLength(0);
    } finally {
      await locker.query('ROLLBACK').catch(() => {});
      locker.release();
    }
  });

  it('revalidates open findings after the lock before posting Mark executed', async () => {
    const plan = await approvedPlan('executing');
    await seedCommit({ hash: '04'.repeat(20), message: 'chore: tick', agoMs: 1 * HOURS, files: [PLAN_REL] });
    const locker = await admin.connect();
    await locker.query('BEGIN');
    await locker.query(`SELECT pg_advisory_xact_lock(hashtextextended($1, 0))`, [`${projectId}:${plan.id}`]);
    try {
      const { advancePlanLifecycle } = await import('../git/plan-lifecycle.js');
      const run = advancePlanLifecycle(projectId);
      await requireLifecycleAdvisoryWaiter();
      const rv = await admin.query<{ id: string }>(
        `INSERT INTO plan_reviews (plan_id, pass, kind, reviewer_agent, verdict, synthesis)
         VALUES ($1, 1, 'blind', 'r@x', 'blocked', 'concurrent blocker') RETURNING id`,
        [plan.id]
      );
      await admin.query(
        `INSERT INTO plan_findings (review_id, plan_id, project_id, severity, title, location, issue, evidence, fix)
         VALUES ($1,$2,$3,'blocker','concurrent','x:1','i','e','f')`,
        [rv.rows[0].id, plan.id, projectId]
      );
      await locker.query('COMMIT');
      expect(await run).toBe(
        'plan lifecycle [auto]: 0 advanced to executing, 0 note(s) posted, 0 suppressed, ' +
        '0 stale prompt(s) retracted, 0 failed'
      );
      expect((await messages('open')).some((m) => m.body.includes('Mark executed?'))).toBe(false);
    } finally {
      await locker.query('ROLLBACK').catch(() => {});
      locker.release();
    }
  });

  it('revalidates commit evidence after the lock before retracting a valid prompt', async () => {
    const plan = await approvedPlan('executing');
    await seedCommit({ hash: '05'.repeat(20), message: 'chore: tick', agoMs: 1 * HOURS, files: [PLAN_REL] });
    const { advancePlanLifecycle, planLifecycleSection } = await import('../git/plan-lifecycle.js');
    await advancePlanLifecycle(projectId);
    expect((await messages('open')).some((m) => m.body.includes('Mark executed?'))).toBe(true);
    await admin.query(`DELETE FROM code_commits WHERE project_id = $1`, [projectId]);

    const locker = await admin.connect();
    await locker.query('BEGIN');
    await locker.query(`SELECT pg_advisory_xact_lock(hashtextextended($1, 0))`, [`${projectId}:${plan.id}`]);
    try {
      const run = advancePlanLifecycle(projectId);
      await requireLifecycleAdvisoryWaiter();
      await seedCommit({ hash: '06'.repeat(20), message: 'chore: retick', agoMs: 1 * HOURS, files: [PLAN_REL] });
      await locker.query('COMMIT');
      expect(await run).toBe(
        'plan lifecycle [auto]: 0 advanced to executing, 0 note(s) posted, 0 suppressed, ' +
        '0 stale prompt(s) retracted, 0 failed'
      );
      expect((await messages('open')).some((m) => m.body.includes('Mark executed?'))).toBe(true);
      expect(await planLifecycleSection(projectId)).toContain('Mark executed?');
    } finally {
      await locker.query('ROLLBACK').catch(() => {});
      locker.release();
    }
  });

  it('R-B: a commit whose message names the slug OR the plan-number token matches', async () => {
    const plan = await approvedPlan();
    // Neither commit touches the plan file — R-A cannot fire.
    await seedCommit({ hash: 'b'.repeat(40), message: `feat: work on ${plan.slug}`, agoMs: 1 * HOURS, files: ['src/x.ts'] });
    await seedCommit({ hash: 'c'.repeat(40), message: 'feat: more', body: 'part of plan 99 hardening', agoMs: 1 * HOURS, files: ['src/y.ts'] });
    // Negative controls in the SAME window: a different plan number, and a
    // longer number that must not match on a prefix (\y word boundaries).
    await seedCommit({ hash: 'd'.repeat(40), message: 'feat: plan-13 hardening parity', agoMs: 1 * HOURS, files: ['src/z.ts'] });
    await seedCommit({ hash: 'e'.repeat(40), message: 'feat: plan-990 unrelated', agoMs: 1 * HOURS, files: ['src/w.ts'] });
    const { advancePlanLifecycle } = await import('../git/plan-lifecycle.js');
    await advancePlanLifecycle(projectId);
    expect(await statusOf(plan.id)).toBe('executing');
    const open = await messages('open');
    expect(open[0].body).toContain('2 task commit(s) since approval'); // exactly the two real matches
  });

  it('ignores pruned tombstones in both path and message lifecycle arms', async () => {
    const plan = await approvedPlan();
    const pathCommitId = await seedCommit({
      hash: '71'.repeat(20),
      message: 'chore: unrelated path-only tombstone',
      agoMs: 1 * HOURS,
      files: [PLAN_REL],
    });
    const messageCommitId = await seedCommit({
      hash: '72'.repeat(20),
      message: `feat: work on ${plan.slug}`,
      agoMs: 1 * HOURS,
      files: ['src/tombstone.ts'],
    });
    await admin.query(
      `INSERT INTO git_history_rewrites
         (project_id, commit_id, old_hash, new_hash, reason)
       VALUES ($1, $2, $3, NULL, 'test: pruned path evidence'),
              ($1, $4, $5, NULL, 'test: pruned message evidence')`,
      [projectId, pathCommitId, '71'.repeat(20), messageCommitId, '72'.repeat(20)]
    );

    const { advancePlanLifecycle } = await import('../git/plan-lifecycle.js');
    expect(await advancePlanLifecycle(projectId)).toBe(
      'plan lifecycle [auto]: 0 advanced to executing, 0 note(s) posted, ' +
        '0 suppressed, 0 stale prompt(s) retracted, 0 failed'
    );
    expect(await statusOf(plan.id)).toBe('approved');
    expect(await messages()).toHaveLength(0);
  });

  it('umbrella normalization: a sub-repo commit matches R-A where the naive comparison provably cannot', async () => {
    // projects.path is the umbrella; the registered repo is a sub-directory of
    // it, exactly the sub-repo umbrella shape. plans.path is umbrella-relative while
    // commit_files.path is repo-relative — the prefix must be stripped.
    const sub = path.join(repo, 'app');
    fs.mkdirSync(path.join(sub, 'docs/superpowers/plans'), { recursive: true });
    const umbrellaRel = 'app/docs/superpowers/plans/2026-08-12-plan-98-sub.md';
    const repoRel = 'docs/superpowers/plans/2026-08-12-plan-98-sub.md';
    fs.writeFileSync(path.join(repo, umbrellaRel), '# Sub plan\n');
    await admin.query(`UPDATE projects SET metadata = $2::jsonb WHERE id = $1`, [
      projectId, JSON.stringify({ repos: [sub] }),
    ]);
    const { planRegister } = await import('../plans.js');
    const p = await planRegister({ path: umbrellaRel });
    await admin.query(
      `UPDATE plans SET status = 'approved', created_at = now() - interval '2 hours' WHERE id = $1`,
      [p.id]
    );
    await admin.query(
      `INSERT INTO plan_reviews
         (plan_id,pass,kind,reviewer_agent,verdict,plan_sha,synthesis,created_at)
       VALUES ($1,1,'blind','plan43-reviewer','approved',$2,'approved',now()-interval '2 hours')`,
      [p.id, p.current_sha]
    );
    await seedCommit({ hash: 'f'.repeat(40), message: 'chore: tick', agoMs: 1 * HOURS, files: [repoRel], repoPath: sub });

    // Falsifiability: NO stored commit_files.path equals plans.path, so a naive
    // comparison could not possibly match this fixture.
    const naive = await admin.query<{ n: string }>(
      `SELECT count(*) AS n FROM commit_files WHERE project_id = $1 AND path = $2`, [projectId, umbrellaRel]
    );
    expect(Number(naive.rows[0].n)).toBe(0);

    const { advancePlanLifecycle } = await import('../git/plan-lifecycle.js');
    await advancePlanLifecycle(projectId);
    expect(await statusOf(p.id)).toBe('executing');
  });

  it('matches path evidence stored under a valid legacy symlink alias of the physical repo', async () => {
    const plan = await approvedPlan();
    const aliasParent = fs.mkdtempSync(path.join(os.tmpdir(), 'plan21-alias-'));
    const alias = path.join(aliasParent, 'repo-alias');
    try {
      fs.symlinkSync(repo, alias, 'dir');
      await admin.query(`UPDATE projects SET metadata = $2::jsonb WHERE id = $1`, [
        projectId, JSON.stringify({ repos: [alias] }),
      ]);
      await seedCommit({
        hash: '73'.repeat(20),
        message: 'chore: legacy alias path evidence',
        agoMs: 1 * HOURS,
        files: [PLAN_REL],
        repoPath: alias,
      });
      const canonicalOnly = await admin.query<{ n: string }>(
        `SELECT count(*)::text AS n FROM code_commits WHERE project_id = $1 AND repo_path = $2`,
        [projectId, fs.realpathSync.native(repo)],
      );
      expect(canonicalOnly.rows[0].n).toBe('0');

      const { advancePlanLifecycle } = await import('../git/plan-lifecycle.js');
      await advancePlanLifecycle(projectId);
      expect(await statusOf(plan.id)).toBe('executing');
    } finally {
      fs.rmSync(aliasParent, { recursive: true, force: true });
    }
  });

  it('R-A excludes an outside repo even when its relative path collides with the umbrella plan path', async () => {
    const plan = await approvedPlan();
    const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'plan21-outside-'));
    try {
      // The project/plan remain rooted at `repo`, but git evidence comes from
      // an independently registered repository outside that umbrella. Its
      // repo-relative path deliberately equals the umbrella-relative plan path.
      await admin.query(`UPDATE projects SET metadata = $2::jsonb WHERE id = $1`, [
        projectId, JSON.stringify({ repos: [outside] }),
      ]);
      await seedCommit({
        hash: '9'.repeat(40),
        message: 'chore: unrelated external repository edit',
        agoMs: 1 * HOURS,
        files: [PLAN_REL],
        repoPath: outside,
      });

      const { advancePlanLifecycle } = await import('../git/plan-lifecycle.js');
      expect(await advancePlanLifecycle(projectId)).toBe(
        'plan lifecycle [auto]: 0 advanced to executing, 0 note(s) posted, ' +
        '0 suppressed, 0 stale prompt(s) retracted, 0 failed'
      );
      expect(await statusOf(plan.id)).toBe('approved');
      expect(await messages()).toHaveLength(0);
    } finally {
      fs.rmSync(outside, { recursive: true, force: true });
    }
  });

  it('the anchor holds: a PRE-anchor commit naming the plan does not flip it', async () => {
    const plan = await approvedPlan();
    await seedCommit({ hash: '1'.repeat(40), message: `feat: ${plan.slug} groundwork`, agoMs: 3 * HOURS, files: [PLAN_REL] });
    const { advancePlanLifecycle } = await import('../git/plan-lifecycle.js');
    expect(await advancePlanLifecycle(projectId)).toBe(
      'plan lifecycle [auto]: 0 advanced to executing, 0 note(s) posted, 0 suppressed, 0 stale prompt(s) retracted, 0 failed'
    );
    expect(await statusOf(plan.id)).toBe('approved');
    expect(await messages()).toHaveLength(0);
  });

  it('an approved REVIEW moves the anchor forward, retiring commits that predate it', async () => {
    const plan = await approvedPlan();
    await seedCommit({ hash: '2'.repeat(40), message: 'chore: tick', agoMs: 90 * 60 * 1000, files: [PLAN_REL] });
    // An approved review posted 1h ago becomes the anchor and retires that commit.
    await admin.query(
      `INSERT INTO plan_reviews (plan_id, pass, kind, reviewer_agent, verdict, plan_sha, synthesis, created_at)
       SELECT id, 2, 'blind', 'r@x', 'approved', current_sha, 's', now() - interval '1 hour'
         FROM plans WHERE id=$1`,
      [plan.id]
    );
    const { advancePlanLifecycle } = await import('../git/plan-lifecycle.js');
    await advancePlanLifecycle(projectId);
    expect(await statusOf(plan.id)).toBe('approved');
  });

  it('evaluates every candidate: an eligible 21st/oldest plan is not silently omitted', async () => {
    const target = await approvedPlan();
    await admin.query(
      `UPDATE plans SET updated_at = now() - interval '3 hours' WHERE id = $1`,
      [target.id]
    );
    for (let i = 0; i < 20; i++) {
      await admin.query(
        `INSERT INTO plans (project_id, slug, path, title, status, created_at, updated_at)
         VALUES ($1, $2, $3, $4, 'approved', now(), now())`,
        [projectId, `newer-${i}`, `newer-${i}.md`, `Newer ${i}`]
      );
    }
    await seedCommit({
      hash: 'a1'.repeat(20), message: 'chore: tick oldest eligible',
      agoMs: 1 * HOURS, files: [PLAN_REL],
    });
    const { advancePlanLifecycle } = await import('../git/plan-lifecycle.js');
    expect(await advancePlanLifecycle(projectId)).toContain('1 advanced to executing');
    expect(await statusOf(target.id)).toBe('executing');
  });

  it('guards: draft / reviewing / executed / abandoned never transition', async () => {
    const { advancePlanLifecycle } = await import('../git/plan-lifecycle.js');
    for (const status of ['draft', 'reviewing', 'executed', 'abandoned']) {
      await admin.query(`DELETE FROM plans WHERE project_id = $1`, [projectId]);
      await admin.query(`DELETE FROM code_commits WHERE project_id = $1`, [projectId]);
      await admin.query(`DELETE FROM agent_messages WHERE project_id = $1`, [projectId]);
      const plan = await approvedPlan(status);
      await seedCommit({ hash: '3'.repeat(40), message: 'chore: tick', agoMs: 1 * HOURS, files: [PLAN_REL] });
      await advancePlanLifecycle(projectId);
      expect(await statusOf(plan.id)).toBe(status);
      expect(await messages()).toHaveLength(0);
    }
  });

  it('a second run is a no-op: no second flip, no second note (thread suppression arm)', async () => {
    const plan = await approvedPlan();
    await seedCommit({ hash: '4'.repeat(40), message: 'chore: tick', agoMs: 1 * HOURS, files: [PLAN_REL] });
    const { advancePlanLifecycle } = await import('../git/plan-lifecycle.js');
    await advancePlanLifecycle(projectId);
    expect(await statusOf(plan.id)).toBe('executing');
    const afterFirst = await messages();
    // Second run: the plan is now `executing` with 0 open findings, so the
    // executed SUGGESTION becomes due — one new note that supersedes the flip
    // note. A third run must then add nothing at all.
    await advancePlanLifecycle(projectId);
    const afterSecond = await messages();
    expect(afterSecond.length).toBe(afterFirst.length + 1);
    expect(await messages('open')).toHaveLength(1);
    const third = await advancePlanLifecycle(projectId);
    expect(third).toContain('1 suppressed');
    expect(await messages()).toHaveLength(afterSecond.length);
    expect(await statusOf(plan.id)).toBe('executing');
  });

  it('CROSS-PROCESS repost suppression: a prior process’s identical open note is not reposted', async () => {
    // sync-commits is a fresh short-lived process per run, so the md5
    // idempotency (author_session-keyed) cannot dedup across runs. The THREAD
    // arm is what stops the executed suggestion reposting forever (§4.5).
    const plan = await approvedPlan('executing');
    await seedCommit({ hash: '5'.repeat(40), message: 'chore: tick', agoMs: 1 * HOURS, files: [PLAN_REL] });
    const { formatExecutedSuggestion } = await import('../git/plan-lifecycle.js');
    const body = formatExecutedSuggestion({ slug: plan.slug, commits: 1, path: PLAN_REL });
    const prior = await admin.query<{ id: string }>(
      `INSERT INTO agent_messages (project_id, author_agent, author_session, type, body)
       VALUES ($1, 'mai@server', gen_random_uuid()::text, 'note', $2) RETURNING id`,
      [projectId, body]
    );
    await admin.query(`UPDATE plans SET board_thread_id = $2 WHERE id = $1`, [plan.id, prior.rows[0].id]);
    const { advancePlanLifecycle } = await import('../git/plan-lifecycle.js');
    expect(await advancePlanLifecycle(projectId)).toContain('1 suppressed');
    const all = await messages();
    expect(all).toHaveLength(1);
    expect(all[0].id).toBe(prior.rows[0].id);
    expect(all[0].status).toBe('open');
  });

  it('the executed suggestion appears in the thread and in planLifecycleSection, and retracts when a finding reopens', async () => {
    const plan = await approvedPlan('executing');
    await seedCommit({ hash: '6'.repeat(40), message: 'chore: tick', agoMs: 1 * HOURS, files: [PLAN_REL] });
    const { advancePlanLifecycle, planLifecycleSection } = await import('../git/plan-lifecycle.js');
    await advancePlanLifecycle(projectId);
    const open = await messages('open');
    expect(open).toHaveLength(1);
    expect(open[0].body).toBe(
      `${plan.slug} — 0 open findings, 1 task commit(s) since approval. Mark executed? mai_plan {path:"${PLAN_REL}", status:"executed"}`
    );
    const section = await planLifecycleSection(projectId);
    expect(section).toContain('## Plan lifecycle');
    expect(section).toContain('Mark executed?');
    expect(await statusOf(plan.id)).toBe('executing'); // NEVER auto-executed

    // A newer human question must neither be superseded by a derivation nor
    // hide the older matching lifecycle prompt from exact retraction.
    const root = await threadRootOf(plan.id);
    const { boardPost } = await import('../coordination/board.js');
    await boardPost({
      type: 'question', body: 'human completion question stays open', thread_id: root ?? undefined,
    });

    // One open finding retracts the prime line immediately and the persisted
    // board prompt on the next lifecycle pass (finding transitions POST no note).
    const rv = await admin.query<{ id: string }>(
      `INSERT INTO plan_reviews (plan_id, pass, kind, reviewer_agent, verdict, synthesis)
       VALUES ($1, 1, 'blind', 'r@x', 'blocked', 's') RETURNING id`,
      [plan.id]
    );
    await admin.query(
      `INSERT INTO plan_findings (review_id, plan_id, project_id, severity, title, location, issue, evidence, fix)
       VALUES ($1,$2,$3,'blocker','B1','x:1','i','e','f')`,
      [rv.rows[0].id, plan.id, projectId]
    );
    expect(await planLifecycleSection(projectId)).toBe('');
    await advancePlanLifecycle(projectId);
    expect((await messages('open')).some((m) => m.body.includes('Mark executed?'))).toBe(false);
    expect((await messages('open')).some((m) => m.body === 'human completion question stays open')).toBe(true);
  });

  it('marking the plan executed retracts its already-open Mark executed prompt', async () => {
    const plan = await approvedPlan('executing');
    await seedCommit({ hash: '61'.repeat(20), message: 'chore: tick', agoMs: 1 * HOURS, files: [PLAN_REL] });
    const { advancePlanLifecycle, planLifecycleSection } = await import('../git/plan-lifecycle.js');
    await advancePlanLifecycle(projectId);
    expect((await messages('open')).some((m) => m.body.includes('Mark executed?'))).toBe(true);
    const { planRegister } = await import('../plans.js');
    await planRegister({ path: PLAN_REL, status: 'executed' });
    await advancePlanLifecycle(projectId);
    expect(await statusOf(plan.id)).toBe('executed');
    expect((await messages('open')).some((m) => m.body.includes('Mark executed?'))).toBe(false);
    expect(await planLifecycleSection(projectId)).toBe('');
  });

  it('toggle suggest: no status write, different wording, and the section renders it', async () => {
    process.env.MAI_PLAN_AUTOADVANCE = 'suggest';
    const plan = await approvedPlan();
    await seedCommit({ hash: '7'.repeat(40), message: 'chore: tick', agoMs: 1 * HOURS, files: [PLAN_REL] });
    const { advancePlanLifecycle, planLifecycleSection } = await import('../git/plan-lifecycle.js');
    expect(await advancePlanLifecycle(projectId)).toBe(
      'plan lifecycle [suggest]: 0 advanced to executing, 1 note(s) posted, 0 suppressed, 0 stale prompt(s) retracted, 0 failed'
    );
    expect(await statusOf(plan.id)).toBe('approved');
    const open = await messages('open');
    expect(open[0].body).toBe(
      `${plan.slug} — 1 task commit(s) since approval. Mark executing? mai_plan {path:"${PLAN_REL}", status:"executing"}`
    );
    expect(await planLifecycleSection(projectId)).toContain('Mark executing?');
  });

  it('toggle off: no status write, no note, no prime line', async () => {
    process.env.MAI_PLAN_AUTOADVANCE = 'off';
    const plan = await approvedPlan();
    await seedCommit({ hash: '8'.repeat(40), message: 'chore: tick', agoMs: 1 * HOURS, files: [PLAN_REL] });
    const { advancePlanLifecycle, planLifecycleSection } = await import('../git/plan-lifecycle.js');
    expect(await advancePlanLifecycle(projectId)).toBe('plan lifecycle [off]: disabled');
    expect(await statusOf(plan.id)).toBe('approved');
    expect(await messages()).toHaveLength(0);
    expect(await planLifecycleSection(projectId)).toBe('');
  });

  it('the toggle resolver: unset and unrecognized both fall back to auto, unrecognized warns once', async () => {
    const { planAutoAdvanceMode, _resetPlanAutoAdvanceWarningForTests } = await import('../env.js');
    process.env.MAI_PLAN_AUTOADVANCE = '';
    expect(planAutoAdvanceMode()).toBe('auto');
    process.env.MAI_PLAN_AUTOADVANCE = '  SUGGEST  ';
    expect(planAutoAdvanceMode()).toBe('suggest');
    process.env.MAI_PLAN_AUTOADVANCE = 'Off';
    expect(planAutoAdvanceMode()).toBe('off');
    const warned: string[] = [];
    const realWarn = console.warn;
    console.warn = (...a: unknown[]): void => { warned.push(a.map(String).join(' ')); };
    try {
      _resetPlanAutoAdvanceWarningForTests();
      process.env.MAI_PLAN_AUTOADVANCE = 'yes-please';
      expect(planAutoAdvanceMode()).toBe('auto'); // never a throw — this runs inside a hook
      expect(planAutoAdvanceMode()).toBe('auto'); // same invalid value: still one warning per process
    } finally {
      console.warn = realWarn;
      process.env.MAI_PLAN_AUTOADVANCE = '';
    }
    expect(warned).toHaveLength(1);
    expect(warned[0]).toContain('MAI_PLAN_AUTOADVANCE');
  });

  it('syncGit runs the pass and appends its line; mai_prime carries the section', async () => {
    const plan = await approvedPlan();
    await seedCommit({ hash: '9'.repeat(40), message: 'chore: tick', agoMs: 1 * HOURS, files: [PLAN_REL] });
    const { syncGit } = await import('../git/sync.js');
    const summary = await syncGit(); // the fixture repo is not a git repo → the repo line is a skip
    expect(summary).toContain('plan lifecycle [auto]:');
    expect(await statusOf(plan.id)).toBe('executing');
    const { prime } = await import('../prime.js');
    const out = await prime('checking the lifecycle section', 'summary');
    expect(out).toContain('## Plan lifecycle');
    expect(out).toContain('Mark executed?');
  });
});
