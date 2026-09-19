/** Plan/review/finding records. Fake embedder throughout — no model load, no
 * network (plan 14 R8). Throwaway project; the DB URL comes from the validated
 * disposable test variable below — its database name must start `mai_plan23_`
 * and can never be `mai_brain`, so this file names no other database. (The
 * legacy predecessor port is a forbidden literal in the release leak check —
 * pass-4 B3 — so it is not written here even in a comment.) */
import { beforeAll, afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Pool } from 'pg';
// Type-only — erased at compile, so it cannot load app code before the env
// pinning below (the runtime plans.js imports stay dynamic for that reason).
import type { FindingSeverity, FindingStatus } from '../plans.js';
import { requireDisposableTestDbUrl } from './test-db-url.js';

// Restore EVERYTHING this file mutates (pass-3 W2): the pinned/DB/agent vars
// are captured at module top BEFORE mutation; the embedding trio is captured
// in beforeAll AFTER dotenv defusal, because dotenv may legitimately populate
// those and later files expect the post-dotenv values back.
const saved: Record<string, string | undefined> = {
  MAI_PROJECT_SLUG: process.env.MAI_PROJECT_SLUG,
  MAI_DB_URL: process.env.MAI_DB_URL,
  MAI_LLM_SUMMARY: process.env.MAI_LLM_SUMMARY,
  MAI_AGENT_ID: process.env.MAI_AGENT_ID,
};
process.env.MAI_PROJECT_SLUG = 'plan16-test';
// The dedicated MAI_TEST_DB_URL is the authority, never an inherited
// MAI_DB_URL (pass-4 B7): this suite DELETES the project it uses, so it must be
// impossible to point it at the operator's real brain. The validated database
// name must start `mai_plan23_` and can never be `mai_brain`; the host must be
// local. The original value is in `saved` and restored in afterAll. (No
// server-side port assertion is possible: docker maps the host port to 5432
// inside the container, so inet_server_port() cannot witness the host binding.)
process.env.MAI_DB_URL = requireDisposableTestDbUrl();
process.env.MAI_LLM_SUMMARY = '0';
process.env.MAI_AGENT_ID = 'tester@vitest';

const admin = new Pool({ connectionString: process.env.MAI_DB_URL });
let root: string;
let planRel: string;

function fakeVec(text: string): number[] {
  const v = new Array(384).fill(0);
  for (let i = 0; i < text.length; i++) v[(text.charCodeAt(i) * 31 + i) % 384] += 1;
  return v;
}

beforeAll(async () => {
  await import('../db.js'); // dotenv defusal before scrubbing (plan-13 P2-B1)
  for (const k of ['MAI_EMBEDDINGS', 'OPENAI_API_KEY', 'VOYAGE_API_KEY']) saved[k] = process.env[k];
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'plan16-'));
  fs.mkdirSync(path.join(root, 'docs'), { recursive: true });
  planRel = 'docs/2026-08-09-plan-99-fixture.md';
  fs.writeFileSync(path.join(root, planRel), '# Fixture plan\n');
  await admin.query(`DELETE FROM projects WHERE slug = 'plan16-test'`);
  await admin.query(`INSERT INTO projects (slug, name, path) VALUES ('plan16-test','Plan16 Test',$1)`, [root]);
});
afterAll(async () => {
  const { setLocalEmbedderForTests } = await import('../embeddings.js');
  setLocalEmbedderForTests(null);
  for (const [k, v] of Object.entries(saved)) {
    if (v === undefined) delete process.env[k]; else process.env[k] = v;
  }
  await admin.query(`DELETE FROM lessons WHERE project_id IS NULL AND rule LIKE 'PLAN22 finding_ref %'`);
  await admin.query(`DELETE FROM projects WHERE slug = 'plan16-test'`);
  await admin.end();
  const { getPool } = await import('../db.js');
  await getPool().end();
  fs.rmSync(root, { recursive: true, force: true });
});
beforeEach(async () => {
  // finding_ref has no polymorphic FK on citing_id; clean the suite's derived
  // rows explicitly before the plan/finding cascade removes their source.
  await admin.query(
    `DELETE FROM memory_citations
      WHERE project_id = (SELECT id FROM projects WHERE slug='plan16-test')
        AND citing_kind = 'finding' AND relation = 'finding_ref'`
  );
  await admin.query(
    `DELETE FROM code_decisions
      WHERE project_id = (SELECT id FROM projects WHERE slug='plan16-test')`
  );
  await admin.query(
    `DELETE FROM lessons
      WHERE project_id = (SELECT id FROM projects WHERE slug='plan16-test')
         OR (project_id IS NULL AND rule LIKE 'PLAN22 finding_ref %')`
  );
  process.env.MAI_EMBEDDINGS = '1';
  delete process.env.OPENAI_API_KEY;
  delete process.env.VOYAGE_API_KEY;
  const { setLocalEmbedderForTests } = await import('../embeddings.js');
  setLocalEmbedderForTests(async (t) => fakeVec(t));
  await admin.query(
    `DELETE FROM plans WHERE project_id = (SELECT id FROM projects WHERE slug='plan16-test')`
  );
});

describe('plan registration', () => {
  it('is idempotent on path and derives a slug', async () => {
    const { planRegister } = await import('../plans.js');
    const a = await planRegister({ path: planRel });
    const b = await planRegister({ path: planRel });
    expect(b.id).toBe(a.id);
    expect(a.slug).toBe('plan-99-fixture');
    expect(a.current_sha).toMatch(/^[0-9a-f]{64}$/);
  });
  it('a renamed file updates the existing row rather than orphaning findings', async () => {
    const { planRegister } = await import('../plans.js');
    const first = await planRegister({ path: planRel });
    const moved = 'docs/2026-08-09-plan-99-fixture-renamed.md';
    fs.writeFileSync(path.join(root, moved), '# Fixture plan\n');
    const second = await planRegister({ path: moved, slug: 'plan-99-fixture' });
    expect(second.id).toBe(first.id); // same record, new path
    expect(second.path).toBe(moved);
  });
  it('an unreadable plan path is a loud error, never a silent NULL sha', async () => {
    const { planRegister } = await import('../plans.js');
    await expect(planRegister({ path: 'docs/does-not-exist.md' })).rejects.toThrow(/Cannot read plan file/);
  });
  it('refuses absolute paths and traversal out of the project root (pass-3 B5)', async () => {
    const { planRegister } = await import('../plans.js');
    await expect(planRegister({ path: path.join(root, planRel) })).rejects.toThrow(/repo-relative/);
    await expect(planRegister({ path: '../outside.md' })).rejects.toThrow(/escapes the project root/);
  });
  it('containment survives a trailing-slash registered root (pass-4 B4)', async () => {
    // mai init stores args.root verbatim and accepts `/x/y/` — the pre-fix
    // prefix check built `root//` and rejected every in-repo path.
    const { planRegister } = await import('../plans.js');
    await admin.query(`UPDATE projects SET path = $1 WHERE slug = 'plan16-test'`, [root + path.sep]);
    try {
      const p = await planRegister({ path: planRel });
      expect(p.slug).toBe('plan-99-fixture');
    } finally {
      await admin.query(`UPDATE projects SET path = $1 WHERE slug = 'plan16-test'`, [root]);
    }
  });
  it('a symlink inside the repo pointing outside it is refused (pass-4 B4)', async () => {
    const { planRegister } = await import('../plans.js');
    const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'plan16-outside-'));
    fs.writeFileSync(path.join(outside, 'outside.md'), '# outside\n');
    fs.symlinkSync(path.join(outside, 'outside.md'), path.join(root, 'docs', 'sneaky.md'));
    try {
      await expect(planRegister({ path: 'docs/sneaky.md' })).rejects.toThrow(/escapes the project root/);
    } finally {
      fs.rmSync(path.join(root, 'docs', 'sneaky.md'), { force: true });
      fs.rmSync(outside, { recursive: true, force: true });
    }
  });
  it('a plain fetch never clobbers a human title (pass-3 B5)', async () => {
    const { planRegister } = await import('../plans.js');
    await planRegister({ path: planRel, title: 'Fixture: the human title' });
    const again = await planRegister({ path: planRel }); // idempotent fetch, no title arg
    expect(again.title).toBe('Fixture: the human title'); // pre-fix: clobbered to the slug
  });
  it('passes:"latest" renders only the newest synthesis plus the earlier-pass pointer (plan 17 R1/R2)', async () => {
    const { planRegister, reviewPost, planText } = await import('../plans.js');
    await planRegister({ path: planRel });
    await reviewPost({ plan: planRel, kind: 'author', verdict: 'blocked', synthesis: 'first-pass synthesis', findings: [] });
    await reviewPost({ plan: planRel, kind: 'blind', verdict: 'approved', synthesis: 'second-pass synthesis', findings: [] });
    const out = await planText({ path: planRel, passes: 'latest' });
    expect(out).toContain('second-pass synthesis'); // full prose, newest pass
    expect(out).not.toContain('first-pass synthesis'); // older pass omitted from the render
    // Pointer still derives from review_count; plan 23 R6 renamed the recovery
    // route to the single-pass selector, with `all` still offered alongside.
    expect(out).toContain('(1 earlier pass(es) — call with pass:"N" for one complete review, or passes:"all")');
  });
  it('plain fetch defaults to latest and points to selected parts (plan 23 R6)', async () => {
    // Plan 23 moved the DEFAULT from all-passes to latest so an ordinary fetch
    // cannot blow the read budget on review history. The omitted passes must
    // still be recoverable, and the pointer names the single-pass selector.
    const { planRegister, reviewPost, planText } = await import('../plans.js');
    await planRegister({ path: planRel });
    await reviewPost({ plan: planRel, kind: 'author', verdict: 'blocked', synthesis: 'first-pass synthesis', findings: [] });
    await reviewPost({ plan: planRel, kind: 'blind', verdict: 'approved', synthesis: 'second-pass synthesis', findings: [] });
    const out = await planText({ path: planRel });
    expect(out).not.toContain('first-pass synthesis'); // older pass omitted by default
    expect(out).toContain('second-pass synthesis');    // newest pass, complete prose
    expect(out).toContain('pass:"N"');                 // single-pass recovery selector
  });
  it('passes:"all" still renders every pass complete on an unbudgeted call (plan 16 R1)', async () => {
    // `all` remains accepted and, small, still carries the whole history — it
    // is bounded only by the MCP budget, never narrowed at the source.
    const { planRegister, reviewPost, planText } = await import('../plans.js');
    await planRegister({ path: planRel });
    await reviewPost({ plan: planRel, kind: 'author', verdict: 'blocked', synthesis: 'first-pass synthesis', findings: [] });
    await reviewPost({ plan: planRel, kind: 'blind', verdict: 'approved', synthesis: 'second-pass synthesis', findings: [] });
    const out = await planText({ path: planRel, passes: 'all' });
    expect(out).toContain('first-pass synthesis');
    expect(out).toContain('second-pass synthesis');
    expect(out).not.toContain('earlier pass(es)'); // nothing omitted under `all`
  });
  it('typo’d passes value is rejected at the boundary, never silently defaulted (plan 17 R3)', async () => {
    const { planText } = await import('../plans.js');
    await expect(planText({ path: planRel, passes: 'newest' })).rejects.toThrow(/passes/);
  });
  it('planSummary reads reviews and count in ONE plan_reviews statement (pass-1 B3)', async () => {
    // Two statements are two snapshots: a review posted between them pairs a
    // stale latest row with a newer count and the pointer mislabels the
    // omitted NEWEST pass "earlier". Structural pin: exactly one plan_reviews
    // read per summary — reintroducing the separate count query goes red.
    const { planRegister, reviewPost } = await import('../plans.js');
    const { getPool } = await import('../db.js');
    await planRegister({ path: planRel });
    await reviewPost({ plan: planRel, kind: 'author', verdict: 'approved', synthesis: 's', findings: [] });
    const pool = getPool();
    const spy = vi.spyOn(pool, 'query');
    await planRegister({ path: planRel, passes: 'latest' });
    const reviewReads = spy.mock.calls.filter((c) => String(c[0]).includes('FROM plan_reviews'));
    expect(reviewReads).toHaveLength(1);
    spy.mockRestore();
  });
});

describe('review posting', () => {
  it('assigns sequential passes and returns stable ids per ref', async () => {
    const { planRegister, reviewPost } = await import('../plans.js');
    await planRegister({ path: planRel });
    const one = await reviewPost({
      plan: planRel, kind: 'author', verdict: 'blocked', synthesis: 'first pass',
      findings: [{
        ref: 'B1', severity: 'blocker', title: 'Unbounded wait in the hot path',
        location: 'src/x.ts:10', issue: 'no timeout', evidence: 'bare fetch', fix: 'add AbortSignal',
      }],
    });
    expect(one.pass).toBe(1);
    expect(one.findings[0].id).toMatch(/^[0-9a-f-]{36}$/);
    const two = await reviewPost({
      plan: planRel, kind: 'blind', verdict: 'approved', synthesis: 'second pass', findings: [],
    });
    expect(two.pass).toBe(2); // server-assigned, not caller-supplied
  });
  it('the same ref in two reviews is unambiguous because the UUID is the identifier', async () => {
    const { planRegister, reviewPost } = await import('../plans.js');
    await planRegister({ path: planRel });
    const mk = (kind: 'author' | 'blind') => reviewPost({
      plan: planRel, kind, verdict: 'blocked', synthesis: 's',
      findings: [{
        ref: 'B1', severity: 'blocker', title: `B1 from ${kind}`,
        location: 'src/x.ts:1', issue: 'i', evidence: 'e', fix: 'f',
      }],
    });
    const a = await mk('author');
    const b = await mk('blind');
    expect(a.findings[0].id).not.toBe(b.findings[0].id);
  });
  it('two CONCURRENT posts get distinct passes {1,2} without surfacing an error — the 23505 retry (R5)', async () => {
    // Spec §10 requires this under genuine concurrency (pass-2 B7): the retry
    // branch is the mechanism R5 exists for, and a sequential test never runs it.
    const { planRegister, reviewPost } = await import('../plans.js');
    await planRegister({ path: planRel });
    const post = () => reviewPost({
      plan: planRel, kind: 'blind', verdict: 'approved', synthesis: 's', findings: [],
    });
    const [a, b] = await Promise.all([post(), post()]);
    expect([a.pass, b.pass].sort()).toEqual([1, 2]);
  });
  it('a finding with blank evidence is refused at the boundary, not by PG (R3, pass-2 B4)', async () => {
    const { planRegister, reviewPost } = await import('../plans.js');
    await planRegister({ path: planRel });
    await expect(reviewPost({
      plan: planRel, kind: 'author', verdict: 'blocked', synthesis: 's',
      findings: [{ severity: 'blocker', title: 't', location: 'l', issue: 'i', evidence: '  ', fix: 'f' }],
    })).rejects.toThrow(/'evidence' is required/); // NOT /violates not-null constraint/
  });
  it('MCP receipt guards reject dropped/partial findings and contradictory verdicts before writing', async () => {
    const { planRegister, reviewPost } = await import('../plans.js');
    const reg = await planRegister({ path: planRel });
    const finding = { severity: 'blocker' as const, title: 'payload guard', location: 'l', issue: 'i', evidence: 'e', fix: 'f' };
    const countReviews = async (): Promise<number> => {
      const rows = await admin.query<{ count: string }>(`SELECT count(*)::text AS count FROM plan_reviews WHERE plan_id = $1`, [reg.id]);
      return Number(rows.rows[0].count);
    };
    expect(await countReviews()).toBe(0);
    await expect(reviewPost({
      plan: planRel, kind: 'blind', verdict: 'blocked', synthesis: 's', findings: [], finding_count: 1,
    })).rejects.toThrow(/intended 1 finding.*received 0/);
    await expect(reviewPost({
      plan: planRel, kind: 'blind', verdict: 'blocked', synthesis: 's', findings: [], finding_count: 0,
    })).rejects.toThrow(/blocked review must include at least one blocker/);
    await expect(reviewPost({
      plan: planRel, kind: 'blind', verdict: 'approved', synthesis: 's', findings: [finding], finding_count: 1,
    })).rejects.toThrow(/approved review cannot include blocker/);
    expect(await countReviews()).toBe(0);

    const posted = await reviewPost({
      plan: planRel, kind: 'blind', verdict: 'blocked', synthesis: 's', findings: [finding], finding_count: 1,
    });
    expect(posted.findings).toHaveLength(1);
    expect(await countReviews()).toBe(1);
  });
  it('the real MCP route preserves a large findings array and refuses a simulated dropped array atomically', async () => {
    const { planRegister } = await import('../plans.js');
    const reg = await planRegister({ path: planRel });
    const { buildServer } = await import('../index.js');
    const { Client, InMemoryTransport } = await import('@modelcontextprotocol/client');
    const server = buildServer(async () => '');
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: 'review-payload-wire', version: '0.0.0' });
    const textOf = (content: unknown): string => {
      if (!Array.isArray(content)) return '';
      return content.map((block) => (
        typeof block === 'object' && block !== null && 'text' in block && typeof block.text === 'string'
          ? block.text
          : ''
      )).join('\n');
    };
    await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
    try {
      const findings = ['B1', 'B2', 'B3'].map((ref) => ({
        ref,
        severity: 'blocker',
        title: `large payload ${ref}`,
        location: 'src/plans.ts:1',
        issue: `issue-${ref}-${'x'.repeat(12_000)}`,
        evidence: `evidence-${ref}`,
        fix: `fix-${ref}`,
      }));
      const posted = await client.callTool({
        name: 'mai_review_post',
        arguments: {
          plan: planRel, kind: 'blind', verdict: 'blocked', synthesis: 'large transport proof',
          findings, finding_count: findings.length,
        },
      });
      expect(textOf(posted.content)).toMatch(/review [0-9a-f-]{36} pass 1 posted \(3 finding\(s\)\)/);
      expect(textOf(posted.content)).toContain('B3 →');

      const dropped = await client.callTool({
        name: 'mai_review_post',
        arguments: {
          plan: planRel, kind: 'blind', verdict: 'blocked', synthesis: 'simulated transport loss',
          findings: [], finding_count: findings.length,
        },
      });
      expect(textOf(dropped.content)).toContain('intended 3 finding(s), but the server received 0');
      const count = await admin.query<{ count: string }>(
        `SELECT count(*)::text AS count FROM plan_reviews WHERE plan_id = $1`, [reg.id]
      );
      expect(Number(count.rows[0].count)).toBe(1);
    } finally {
      await client.close();
      await server.close();
    }
  });
  it('an out-of-enum severity is refused with a message naming the finding', async () => {
    const { planRegister, reviewPost } = await import('../plans.js');
    await planRegister({ path: planRel });
    await expect(reviewPost({
      plan: planRel, kind: 'author', verdict: 'blocked', synthesis: 's',
      findings: [{ ref: 'B1', severity: 'catastrophic' as FindingSeverity, title: 't',
        location: 'l', issue: 'i', evidence: 'e', fix: 'f' }],
    })).rejects.toThrow(/severity must be one of/);
  });
  it('recurrence_of must name a real finding in THIS project — no dangling edges (pass-3 B3)', async () => {
    const { planRegister, reviewPost } = await import('../plans.js');
    await planRegister({ path: planRel });
    await expect(reviewPost({
      plan: planRel, kind: 'author', verdict: 'blocked', synthesis: 's',
      findings: [{ severity: 'blocker', title: 't', location: 'l', issue: 'i', evidence: 'e', fix: 'f',
        recurrence_of: '00000000-0000-4000-8000-000000000000' }],
    })).rejects.toThrow(/matches no finding in this project/);
  });
  it("recurrence_of cannot reach ANOTHER project's real finding (pass-6 W1)", async () => {
    // The dangling-UUID case above never proves project scoping — a finding
    // that EXISTS but belongs elsewhere is the isolation half of the check.
    const { planRegister, reviewPost } = await import('../plans.js');
    await planRegister({ path: planRel });
    const pb = await admin.query<{ id: string }>(
      `INSERT INTO projects (slug, name) VALUES ('plan16-other','Other') RETURNING id`);
    try {
      const plB = await admin.query<{ id: string }>(
        `INSERT INTO plans (project_id, slug, path, title) VALUES ($1,'p','docs/p.md','P') RETURNING id`,
        [pb.rows[0].id]);
      const rvB = await admin.query<{ id: string }>(
        `INSERT INTO plan_reviews (plan_id, pass, kind, reviewer_agent, verdict, synthesis) VALUES ($1,1,'author','t','blocked','s') RETURNING id`,
        [plB.rows[0].id]);
      const fB = await admin.query<{ id: string }>(
        `INSERT INTO plan_findings (review_id, plan_id, project_id, severity, title, location, issue, evidence, fix)
         VALUES ($1,$2,$3,'blocker','other-project finding','l','i','e','f') RETURNING id`,
        [rvB.rows[0].id, plB.rows[0].id, pb.rows[0].id]);
      await expect(reviewPost({
        plan: planRel, kind: 'blind', verdict: 'blocked', synthesis: 's',
        findings: [{ severity: 'blocker', title: 't', location: 'l', issue: 'i', evidence: 'e', fix: 'f',
          recurrence_of: fB.rows[0].id }],
      })).rejects.toThrow(/matches no finding in this project/);
    } finally {
      await admin.query(`DELETE FROM projects WHERE slug = 'plan16-other'`); // cascades the B chain
    }
  });
  it('a plan mutated DURING embedding still draws R-drift — the hash happens after embed (pass-6 B3)', async () => {
    // Embedding is the long window (up to 20s cold). Pre-fix, the sha was
    // taken BEFORE it: an edit landing mid-embed recorded the stale hash, no
    // warning, and plans.current_sha refreshed with pre-edit data.
    const { planRegister, reviewPost } = await import('../plans.js');
    const { setLocalEmbedderForTests } = await import('../embeddings.js');
    const reg = await planRegister({ path: planRel });
    setLocalEmbedderForTests(async (t) => {
      fs.appendFileSync(path.join(root, planRel), '\n<!-- mutated mid-embed -->\n');
      return fakeVec(t);
    });
    const r = await reviewPost({
      plan: planRel, kind: 'blind', verdict: 'blocked', synthesis: 's',
      plan_sha: reg.current_sha ?? undefined,
      findings: [{ severity: 'blocker', title: 'mid-embed probe', location: 'l',
        issue: 'i', evidence: 'e', fix: 'f' }],
    });
    expect(r.warnings.some((w) => w.includes('R-drift'))).toBe(true);
    expect(r.pass).toBeGreaterThan(0); // and it still posted
  });
  it('a clean zero-finding approval is readable back WITH its synthesis (R1, pass-3 B1)', async () => {
    const { planRegister, reviewPost } = await import('../plans.js');
    await planRegister({ path: planRel });
    await reviewPost({
      plan: planRel, kind: 'blind', verdict: 'approved',
      synthesis: 'CLEAN-PASS: the plan holds together', findings: [],
    });
    const again = await planRegister({ path: planRel });
    expect(again.reviews).toHaveLength(1);
    expect(again.reviews[0].verdict).toBe('approved');
    expect(again.reviews[0].synthesis).toContain('CLEAN-PASS'); // pre-fix: no read surface returned this
  });
  it('a blank synthesis is refused — the analytical prose cannot be silently lost (pass-4 B2)', async () => {
    const { planRegister, reviewPost } = await import('../plans.js');
    await planRegister({ path: planRel });
    await expect(reviewPost({
      plan: planRel, kind: 'blind', verdict: 'approved', synthesis: '   ', findings: [],
    })).rejects.toThrow(/'synthesis' is required/);
  });
  it('R-location validates BOTH ends of a range and flags reversed ranges (pass-4 B6)', async () => {
    const { planRegister, reviewPost } = await import('../plans.js');
    const reg = await planRegister({ path: planRel });
    const r = await reviewPost({
      plan: planRel, kind: 'blind', verdict: 'blocked', synthesis: 's',
      plan_sha: reg.current_sha ?? undefined,
      findings: [
        { ref: 'OK', severity: 'note', title: 'valid range', location: `${planRel}:1-2`,
          issue: 'i', evidence: 'e', fix: 'f' },
        { ref: 'END', severity: 'note', title: 'end out of range', location: `${planRel}:1-999999`,
          issue: 'i', evidence: 'e', fix: 'f' }, // pre-fix: start-only capture passed this
        { ref: 'REV', severity: 'note', title: 'reversed', location: `${planRel}:2-1`,
          issue: 'i', evidence: 'e', fix: 'f' },
      ],
    });
    expect(r.warnings).toHaveLength(2);
    expect(r.warnings.some((w) => w.includes('END'))).toBe(true);
    expect(r.warnings.some((w) => w.includes('REV'))).toBe(true);
  });
  it('records a recurrence edge in memory_edges (no schema change needed)', async () => {
    const { planRegister, reviewPost } = await import('../plans.js');
    await planRegister({ path: planRel });
    const first = await reviewPost({
      plan: planRel, kind: 'author', verdict: 'blocked', synthesis: 's',
      findings: [{ ref: 'B1', severity: 'blocker', title: 'forced exit aborts',
        location: 'src/cli.ts:540', issue: 'i', evidence: 'e', fix: 'f' }],
    });
    const second = await reviewPost({
      plan: planRel, kind: 'blind', verdict: 'blocked', synthesis: 's',
      findings: [{ ref: 'B1', severity: 'blocker', title: 'forced exit aborts again',
        location: 'src/web-server.ts:588', issue: 'i', evidence: 'e', fix: 'f',
        recurrence_of: first.findings[0].id }],
    });
    const edge = await admin.query(
      `SELECT relation FROM memory_edges WHERE from_kind='finding' AND from_id=$1 AND to_id=$2`,
      [second.findings[0].id, first.findings[0].id]
    );
    expect(edge.rows[0].relation).toBe('recurrence_of');
  });

  it('warns on mid-review drift and still posts — warn, never block (R11 R-drift)', async () => {
    // The spec §12 field failure: plan mutates between pin and post, line
    // citations decay silently. The pin is taken FIRST, the file mutates, the
    // post must carry the warning AND succeed.
    const { planRegister, reviewPost } = await import('../plans.js');
    const reg = await planRegister({ path: planRel });
    fs.appendFileSync(path.join(root, planRel), '\n<!-- drift: mutated after the pin -->\n');
    const r = await reviewPost({
      plan: planRel, kind: 'blind', verdict: 'blocked', synthesis: 's',
      plan_sha: reg.current_sha ?? undefined,
      findings: [{ ref: 'B1', severity: 'blocker', title: 'drift probe',
        location: 'src/x.ts:1', issue: 'i', evidence: 'e', fix: 'f' }],
    });
    expect(r.warnings.some((w) => w.includes('R-drift'))).toBe(true); // pre-fix: field absent
    expect(r.pass).toBeGreaterThan(0); // posted anyway — enforcement is a non-goal (§3)
  });

  it('warns on a citation past the end of the file (R11 R-location)', async () => {
    const { planRegister, reviewPost } = await import('../plans.js');
    const reg = await planRegister({ path: planRel }); // re-register: pin matches the mutated file
    const r = await reviewPost({
      plan: planRel, kind: 'blind', verdict: 'blocked', synthesis: 's',
      plan_sha: reg.current_sha ?? undefined,
      findings: [{ ref: 'B1', severity: 'blocker', title: 'location probe',
        location: `${planRel}:999999`, issue: 'i', evidence: 'e', fix: 'f' }],
    });
    expect(r.warnings.some((w) => w.includes('R-location'))).toBe(true);
  });

  it('a matching pin with in-range citations posts with zero warnings (R11 clean path)', async () => {
    const { planRegister, reviewPost } = await import('../plans.js');
    const reg = await planRegister({ path: planRel });
    const r = await reviewPost({
      plan: planRel, kind: 'blind', verdict: 'approved', synthesis: 's',
      plan_sha: reg.current_sha ?? undefined, findings: [],
    });
    expect(r.warnings).toEqual([]);
  });

  it('a source-file citation is NEVER line-warned — only the plan itself is checkable (R11, pass-2 B5)', async () => {
    // The negative case is the one that matters: real findings overwhelmingly
    // cite the codebase, and the pre-fix check compared EVERY :NNN against the
    // plan's line count — this exact call false-warned.
    const { planRegister, reviewPost } = await import('../plans.js');
    const reg = await planRegister({ path: planRel });
    const r = await reviewPost({
      plan: planRel, kind: 'blind', verdict: 'blocked', synthesis: 's',
      plan_sha: reg.current_sha ?? undefined,
      findings: [{ severity: 'blocker', title: 'source citation probe',
        location: 'src/web-server.ts:999999', issue: 'i', evidence: 'e', fix: 'f' }],
    });
    expect(r.warnings).toEqual([]);
  });
});

describe('finding status', () => {
  it('closing without a note is refused with a self-correcting message', async () => {
    const { planRegister, reviewPost, findingUpdate } = await import('../plans.js');
    await planRegister({ path: planRel });
    const r = await reviewPost({
      plan: planRel, kind: 'author', verdict: 'blocked', synthesis: 's',
      findings: [{ severity: 'warning', title: 'w', location: 'l', issue: 'i', evidence: 'e', fix: 'f' }],
    });
    await expect(findingUpdate({ finding_id: r.findings[0].id, status: 'fixed' }))
      .rejects.toThrow(/requires a note/);
    const ok = await findingUpdate({ finding_id: r.findings[0].id, status: 'fixed', note: 'done in abc1234' });
    expect(ok).toContain('fixed');
    // Resolution note round-trips through the PUBLIC read tool (pass-4 B1):
    // the note is the durable finding→fix link, not private bookkeeping.
    const { findingsQuery } = await import('../plans.js');
    const read = await findingsQuery({ plan: planRel });
    expect(read).toContain('done in abc1234');
  });
  it('a location-only repair updates the citation and leaves status untouched (pass-3 B4)', async () => {
    const { planRegister, reviewPost, findingUpdate, findingsQuery } = await import('../plans.js');
    await planRegister({ path: planRel });
    const r = await reviewPost({
      plan: planRel, kind: 'author', verdict: 'blocked', synthesis: 's',
      findings: [{ severity: 'warning', title: 'repairable', location: 'src/a.ts:10',
        issue: 'i', evidence: 'EVIDENCE-ROUNDTRIP: the quote that substantiates it', fix: 'f' }],
    });
    const out = await findingUpdate({ finding_id: r.findings[0].id, location: 'src/a.ts:42' });
    expect(out).toContain('open'); // status not transitioned by a repair
    const read = await findingsQuery({ plan: planRel });
    expect(read).toContain('src/a.ts:42');
    expect(read).toContain('EVIDENCE-ROUNDTRIP'); // pass-4 B1: evidence renders in the handoff read
  });
  it('closing after the plan drifted from the review pin appends an R-drift warning (R11 close-time, spec §12)', async () => {
    const { planRegister, reviewPost, findingUpdate } = await import('../plans.js');
    const reg = await planRegister({ path: planRel });
    const r = await reviewPost({
      plan: planRel, kind: 'author', verdict: 'blocked', synthesis: 's',
      plan_sha: reg.current_sha ?? undefined,
      findings: [{ severity: 'blocker', title: 'close-drift probe', location: 'l',
        issue: 'i', evidence: 'e', fix: 'f' }],
    });
    fs.appendFileSync(path.join(root, planRel), '\n<!-- drifted before close -->\n');
    const out = await findingUpdate({ finding_id: r.findings[0].id, status: 'fixed', note: 'done' });
    expect(out).toContain('R-drift'); // warned — and the close still landed
    expect(out).toContain('fixed');
  });
});

describe('finding_ref citation writer (plan 22 / decision ba95ae4a)', () => {
  it('reviewPost resolves full UUIDs from issue/evidence, dedupes repeats, and cites a global lesson', async () => {
    const project = await admin.query<{ id: string }>(
      `SELECT id FROM projects WHERE slug='plan16-test'`
    );
    const decision = await admin.query<{ id: string }>(
      `INSERT INTO code_decisions (project_id,decision_type,description)
       VALUES ($1,'arch','PLAN22 finding_ref live decision') RETURNING id`,
      [project.rows[0].id]
    );
    const lesson = await admin.query<{ id: string }>(
      `INSERT INTO lessons (project_id,rule)
       VALUES (NULL,'PLAN22 finding_ref global lesson') RETURNING id`
    );
    const { planRegister, reviewPost } = await import('../plans.js');
    await planRegister({ path: planRel });
    const posted = await reviewPost({
      plan: planRel, kind: 'blind', verdict: 'blocked', synthesis: 's',
      findings: [{ severity: 'blocker', title: 'memory-backed finding', location: 'l',
        issue: `decision ${decision.rows[0].id} repeated ${decision.rows[0].id}`,
        evidence: `global lesson ${lesson.rows[0].id}`, fix: 'f' }],
    });
    const refs = await admin.query<{ cited_kind: string; cited_id: string }>(
      `SELECT cited_kind, cited_id::text AS cited_id FROM memory_citations
        WHERE citing_kind='finding' AND citing_id=$1 AND relation='finding_ref'
        ORDER BY cited_kind`,
      [posted.findings[0].id]
    );
    expect(refs.rows).toEqual([
      { cited_kind: 'decision', cited_id: decision.rows[0].id },
      { cited_kind: 'lesson', cited_id: lesson.rows[0].id },
    ]);
    const d = await admin.query<{ cited_count: number }>(
      `SELECT cited_count FROM code_decisions WHERE id=$1`, [decision.rows[0].id]
    );
    const l = await admin.query<{ cited_count: number }>(
      `SELECT cited_count FROM lessons WHERE id=$1`, [lesson.rows[0].id]
    );
    expect(Number(d.rows[0].cited_count)).toBe(1);
    expect(Number(l.rows[0].cited_count)).toBe(1);
  });

  it('resolve-then-record ignores short, unknown, foreign, retracted and retired ids', async () => {
    const project = await admin.query<{ id: string }>(
      `SELECT id FROM projects WHERE slug='plan16-test'`
    );
    const live = await admin.query<{ id: string }>(
      `INSERT INTO code_decisions (project_id,decision_type,description)
       VALUES ($1,'arch','PLAN22 finding_ref only live target') RETURNING id`,
      [project.rows[0].id]
    );
    const dead = await admin.query<{ id: string }>(
      `INSERT INTO code_decisions
         (project_id,decision_type,description,still_valid,retracted_at,retraction_reason)
       VALUES ($1,'arch','PLAN22 finding_ref dead target',false,NOW(),'test') RETURNING id`,
      [project.rows[0].id]
    );
    const retired = await admin.query<{ id: string }>(
      `INSERT INTO lessons (project_id,rule,retired_at,retirement_reason)
       VALUES ($1,'PLAN22 finding_ref retired lesson',NOW(),'test') RETURNING id`,
      [project.rows[0].id]
    );
    const foreignProject = await admin.query<{ id: string }>(
      `INSERT INTO projects (slug,name) VALUES ('plan22-finding-ref-other','Other') RETURNING id`
    );
    try {
      const foreign = await admin.query<{ id: string }>(
        `INSERT INTO code_decisions (project_id,decision_type,description)
         VALUES ($1,'arch','PLAN22 finding_ref foreign target') RETURNING id`,
        [foreignProject.rows[0].id]
      );
      const { planRegister, reviewPost } = await import('../plans.js');
      await planRegister({ path: planRel });
      const posted = await reviewPost({
        plan: planRel, kind: 'blind', verdict: 'blocked', synthesis: 's',
        findings: [{ severity: 'blocker', title: 'resolution wall', location: 'l',
          issue: `${live.rows[0].id} short=${live.rows[0].id.slice(0, 8)} ` +
            `${dead.rows[0].id} ${retired.rows[0].id} ${foreign.rows[0].id}`,
          evidence: 'unknown 00000000-0000-4000-8000-000000000000', fix: 'f' }],
      });
      const refs = await admin.query<{ cited_id: string }>(
        `SELECT cited_id::text AS cited_id FROM memory_citations
          WHERE citing_kind='finding' AND citing_id=$1`, [posted.findings[0].id]
      );
      expect(refs.rows).toEqual([{ cited_id: live.rows[0].id }]);
    } finally {
      await admin.query(`DELETE FROM projects WHERE slug='plan22-finding-ref-other'`);
    }
  });

  it('findingUpdate backfills a stored finding once and repeated updates do not double-count', async () => {
    const { planRegister, findingUpdate } = await import('../plans.js');
    const plan = await planRegister({ path: planRel });
    const target = await admin.query<{ id: string }>(
      `INSERT INTO code_decisions (project_id,decision_type,description)
       VALUES ($1,'arch','PLAN22 finding_ref backfill target') RETURNING id`,
      [plan.project_id]
    );
    const review = await admin.query<{ id: string }>(
      `INSERT INTO plan_reviews
         (plan_id,pass,kind,reviewer_agent,verdict,synthesis)
       VALUES ($1,1,'author','tester@vitest','blocked','s') RETURNING id`, [plan.id]
    );
    const finding = await admin.query<{ id: string }>(
      `INSERT INTO plan_findings
         (review_id,plan_id,project_id,severity,title,location,issue,evidence,fix)
       VALUES ($1,$2,$3,'warning','backfill','l','references ' || $4,'e','f') RETURNING id`,
      [review.rows[0].id, plan.id, plan.project_id, target.rows[0].id]
    );
    await findingUpdate({ finding_id: finding.rows[0].id, location: 'src/a.ts:1' });
    await findingUpdate({ finding_id: finding.rows[0].id, location: 'src/a.ts:2' });
    const refs = await admin.query(
      `SELECT id FROM memory_citations
        WHERE citing_kind='finding' AND citing_id=$1 AND relation='finding_ref'`,
      [finding.rows[0].id]
    );
    expect(refs.rows).toHaveLength(1);
    const count = await admin.query<{ cited_count: number }>(
      `SELECT cited_count FROM code_decisions WHERE id=$1`, [target.rows[0].id]
    );
    expect(Number(count.rows[0].cited_count)).toBe(1);
  });

  it('a later recurrence failure rolls back the finding, finding_ref and counter together', async () => {
    const { planRegister, reviewPost } = await import('../plans.js');
    const plan = await planRegister({ path: planRel });
    const target = await admin.query<{ id: string }>(
      `INSERT INTO code_decisions (project_id,decision_type,description)
       VALUES ($1,'arch','PLAN22 finding_ref rollback target') RETURNING id`,
      [plan.project_id]
    );
    await expect(reviewPost({
      plan: planRel, kind: 'blind', verdict: 'blocked', synthesis: 's',
      findings: [{ severity: 'blocker', title: 'rollback finding', location: 'l',
        issue: `references ${target.rows[0].id}`, evidence: 'e', fix: 'f',
        recurrence_of: '00000000-0000-4000-8000-000000000000' }],
    })).rejects.toThrow(/matches no finding/);
    const refs = await admin.query(
      `SELECT id FROM memory_citations
        WHERE project_id=$1 AND citing_kind='finding' AND relation='finding_ref'`,
      [plan.project_id]
    );
    expect(refs.rows).toHaveLength(0);
    const count = await admin.query<{ cited_count: number }>(
      `SELECT cited_count FROM code_decisions WHERE id=$1`, [target.rows[0].id]
    );
    expect(Number(count.rows[0].cited_count)).toBe(0);
  });
});

describe('recall — the reason this exists', () => {
  it('similar_to finds a past finding semantically, across plans', async () => {
    const { planRegister, reviewPost, findingsQuery, } = await import('../plans.js');
    const { setLocalEmbedderForTests } = await import('../embeddings.js');
    const oneHot = (i: number) => { const v = new Array(384).fill(0); v[i] = 1; return v; };
    setLocalEmbedderForTests(async () => oneHot(7)); // query and stored vector align
    await planRegister({ path: planRel });
    await reviewPost({
      plan: planRel, kind: 'author', verdict: 'blocked', synthesis: 's',
      findings: [{ severity: 'blocker', title: 'PLAN16 unbounded external wait',
        location: 'src/a.ts:1', issue: 'i', evidence: 'e', fix: 'f' }],
    });
    const out = await findingsQuery({ similar_to: 'anything at all', limit: 5 });
    expect(out).toContain('PLAN16 unbounded external wait');
  });
  it('falls through to trigram when embeddings are OFF (plan 14 contract)', async () => {
    const { planRegister, reviewPost, findingsQuery } = await import('../plans.js');
    await planRegister({ path: planRel });
    await reviewPost({
      plan: planRel, kind: 'author', verdict: 'blocked', synthesis: 's',
      findings: [{ severity: 'blocker', title: 'PLAN16 trigram findable finding',
        location: 'src/a.ts:1', issue: 'i', evidence: 'e', fix: 'f' }],
    });
    process.env.MAI_EMBEDDINGS = '0'; // provider unavailable
    const out = await findingsQuery({ similar_to: 'trigram findable', limit: 5 });
    expect(out).toContain('PLAN16 trigram findable finding');
  });
  it('stores findings with the current model tag (plan 14 tagging)', async () => {
    const { planRegister, reviewPost } = await import('../plans.js');
    await planRegister({ path: planRel });
    const r = await reviewPost({
      plan: planRel, kind: 'author', verdict: 'blocked', synthesis: 's',
      findings: [{ severity: 'note', title: 'tagged', location: 'l', issue: 'i', evidence: 'e', fix: 'f' }],
    });
    const row = await admin.query(
      `SELECT embedding_model, array_length(embedding,1) AS dim FROM plan_findings WHERE id=$1`,
      [r.findings[0].id]
    );
    expect(row.rows[0].embedding_model).toBe('local:bge-small-en-v1.5');
    expect(row.rows[0].dim).toBe(384);
  });
  it('zero semantic hits fall through to all-row trigram — plan 14 R4 third state (pass-5 B1, pass-7 B1)', async () => {
    // INVERTED from the fix-merge-1 version, which pinned the opposite
    // behaviour on a false premise (passes 2-3 read R5's dedup matrix into the
    // search model; decisionsSimilarOrTrgm rescues below-threshold queries via
    // trgmDecisionHits(…, null)). Search recall must never return nothing
    // while mai_search would answer the same query by text. The stale row
    // planted here is pass-7 B1's mutation detector: a stale trigram hit must
    // NOT suppress the all-row rescue of the cosine-rejected current-model row
    // — an `&& stale.rows.length === 0` guard on the third state fails this.
    const { planRegister, reviewPost, findingsQuery } = await import('../plans.js');
    const { setLocalEmbedderForTests } = await import('../embeddings.js');
    const oneHot = (i: number) => { const v = new Array(384).fill(0); v[i] = 1; return v; };
    setLocalEmbedderForTests(async () => oneHot(3)); // stored vector
    await planRegister({ path: planRel });
    const r = await reviewPost({
      plan: planRel, kind: 'author', verdict: 'blocked', synthesis: 's',
      findings: [
        { severity: 'blocker', title: 'PLAN16 rejected by cosine yet trigram findable',
          location: 'l', issue: 'i', evidence: 'e', fix: 'f' },
        { severity: 'blocker', title: 'PLAN16 stale row rejected by cosine yet trigram findable',
          location: 'l', issue: 'i', evidence: 'e', fix: 'f' },
      ],
    });
    // Second row becomes the stale trigram hit (same seam as the rebuild test).
    await admin.query(`UPDATE plan_findings SET embedding_model = 'old:model' WHERE id = $1`,
      [r.findings[1].id]);
    setLocalEmbedderForTests(async () => oneHot(9)); // query orthogonal → cosine 0, zero semantic hits
    const out = await findingsQuery({ similar_to: 'rejected by cosine yet trigram findable', limit: 5 });
    expect(out).toContain('PLAN16 rejected by cosine yet trigram findable'); // current-model row rescued despite the stale hit
    expect(out).toContain('text match'); // and labelled as the trigram fall-through
  });
  it('plan/status/severity filters compose with similar_to recall (pass-8 W1)', async () => {
    // Validated-then-dropped filters are the stronger variant of pass-4 W2's
    // typo'd-enum defect: the caller asked for open findings and silently got
    // everything. Both rows are semantic hits (identical stored/query vectors),
    // so only the composed status predicate can separate them — not the budget.
    const { planRegister, reviewPost, findingUpdate, findingsQuery } = await import('../plans.js');
    const { setLocalEmbedderForTests } = await import('../embeddings.js');
    const oneHot5 = () => { const v = new Array(384).fill(0); v[5] = 1; return v; };
    setLocalEmbedderForTests(async () => oneHot5());
    await planRegister({ path: planRel });
    const r = await reviewPost({
      plan: planRel, kind: 'author', verdict: 'blocked', synthesis: 's',
      findings: [
        { severity: 'blocker', title: 'PLAN16 composed filter stays open', location: 'l', issue: 'i', evidence: 'e', fix: 'f' },
        { severity: 'blocker', title: 'PLAN16 composed filter got fixed', location: 'l', issue: 'i', evidence: 'e', fix: 'f' },
      ],
    });
    await findingUpdate({ finding_id: r.findings[1].id, status: 'fixed', note: 'done' });
    const out = await findingsQuery({ similar_to: 'PLAN16 composed filter', status: 'open', limit: 5 });
    expect(out).toContain('PLAN16 composed filter stays open');
    expect(out).not.toContain('PLAN16 composed filter got fixed'); // dropped by the composed filter, not the budget
  });
  it('mai embed --rebuild drains the stale findings bucket (pass-2 B8)', async () => {
    // The stale-bucket label tells the operator to run this — it must actually
    // cover findings, or the remedy it names is a dead end.
    const { planRegister, reviewPost } = await import('../plans.js');
    await planRegister({ path: planRel });
    const r = await reviewPost({
      plan: planRel, kind: 'author', verdict: 'blocked', synthesis: 's',
      findings: [{ severity: 'blocker', title: 'stale finding to rebuild', location: 'l',
        issue: 'i', evidence: 'e', fix: 'f' }],
    });
    await admin.query(`UPDATE plan_findings SET embedding_model = 'old:model' WHERE id = $1`, [r.findings[0].id]);
    const { runEmbedRebuild } = await import('../scripts/embed-rebuild.js');
    // lessonRuleLike confines the GLOBAL lessons half to a no-match pattern —
    // same seam the embeddings-local rebuild tests use to protect real lessons.
    const out = await runEmbedRebuild({ projectSlug: 'plan16-test', lessonRuleLike: 'PLAN16NOLESSON %' });
    expect(out).toContain('finding(s) re-embedded');
    const row = await admin.query(`SELECT embedding_model FROM plan_findings WHERE id = $1`, [r.findings[0].id]);
    expect(row.rows[0].embedding_model).toBe('local:bge-small-en-v1.5'); // re-tagged current
  });
  it("a typo'd filter enum is a loud error, not an empty result (pass-4 W2)", async () => {
    const { findingsQuery } = await import('../plans.js');
    await expect(findingsQuery({ status: 'fixedd' as FindingStatus })).rejects.toThrow(/status must be one of/);
  });
});
