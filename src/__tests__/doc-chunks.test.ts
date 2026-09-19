/** Doc-chunk auto-ingest (plan 20). Fake embedder throughout — no model load,
 * no network (plan 14 R8). Throwaway project + cascade cleanup (lesson
 * 63fb332c); the DB URL comes from the validated disposable test variable
 * below — its database name must start `mai_plan23_` and can never be
 * `mai_brain`, so this file names no other database (the plans-findings pass-4
 * B7 rule: this suite DELETES the project it uses, so it must be impossible to
 * point it at the operator's real brain). */
import { beforeAll, afterAll, beforeEach, afterEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Pool } from 'pg';
import { requireDisposableTestDbUrl } from './test-db-url.js';

// Restore EVERYTHING this file mutates (plans-findings pass-3 W2): pinned/DB/
// agent vars captured at module top BEFORE mutation; the embedding trio is
// captured in beforeAll AFTER dotenv defusal.
const saved: Record<string, string | undefined> = {
  MAI_PROJECT_SLUG: process.env.MAI_PROJECT_SLUG,
  MAI_DB_URL: process.env.MAI_DB_URL,
  MAI_LLM_SUMMARY: process.env.MAI_LLM_SUMMARY,
  MAI_AGENT_ID: process.env.MAI_AGENT_ID,
};
process.env.MAI_PROJECT_SLUG = 'plan20-test';
process.env.MAI_DB_URL = requireDisposableTestDbUrl();
process.env.MAI_LLM_SUMMARY = '0';
process.env.MAI_AGENT_ID = 'tester@vitest';

const admin = new Pool({ connectionString: process.env.MAI_DB_URL });
let root: string;
let projectId: string;

function fakeVec(text: string): number[] {
  const v = new Array(384).fill(0);
  for (let i = 0; i < text.length; i++) v[(text.charCodeAt(i) * 31 + i) % 384] += 1;
  return v;
}
const oneHot = (i: number): number[] => {
  const v = new Array(384).fill(0);
  v[i] = 1;
  return v;
};

beforeAll(async () => {
  await import('../db.js'); // dotenv defusal before scrubbing (plan-13 P2-B1)
  for (const k of ['MAI_EMBEDDINGS', 'OPENAI_API_KEY', 'VOYAGE_API_KEY']) saved[k] = process.env[k];
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'plan20-'));
  fs.mkdirSync(path.join(root, 'docs'), { recursive: true });
  await admin.query(`DELETE FROM projects WHERE slug = 'plan20-test'`);
  const p = await admin.query<{ id: string }>(
    `INSERT INTO projects (slug, name, path) VALUES ('plan20-test','Plan20 Test',$1) RETURNING id`,
    [root]
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
  await admin.query(`DELETE FROM projects WHERE slug = 'plan20-test'`); // cascades plans + doc_chunks
  await admin.end();
  const { getPool } = await import('../db.js');
  await getPool().end();
  fs.rmSync(root, { recursive: true, force: true });
});
beforeEach(async () => {
  process.env.MAI_EMBEDDINGS = '1';
  delete process.env.OPENAI_API_KEY;
  delete process.env.VOYAGE_API_KEY;
  const { setLocalEmbedderForTests } = await import('../embeddings.js');
  setLocalEmbedderForTests(async (t) => fakeVec(t));
  // doc_chunks rows with plan_id NULL do NOT cascade from the plans delete —
  // both tables are cleaned explicitly.
  await admin.query(`DELETE FROM doc_chunks WHERE project_id = $1`, [projectId]);
  await admin.query(`DELETE FROM plans WHERE project_id = $1`, [projectId]);
});

// ---------- chunker (pure — no DB) ----------

describe('chunkMarkdown', () => {
  const doc = [
    '# Plan 99 fixture',
    'intro line',
    '',
    '## Task 1: Wire the flux capacitor',
    'Body for task one.',
    '',
    '### Step 1: Solder',
    'Solder the leads.',
    '',
    '## Task 2: Test it',
    'Body for task two.',
  ].join('\n');

  it('splits on ##/### heading boundaries with heading trails (spec §4)', async () => {
    const { chunkMarkdown } = await import('../doc-chunks.js');
    const chunks = chunkMarkdown(doc);
    expect(chunks.map((c) => c.headingTrail)).toEqual([
      'Plan 99 fixture',
      'Task 1: Wire the flux capacitor',
      'Task 1: Wire the flux capacitor > Step 1: Solder',
      'Task 2: Test it',
    ]);
  });

  it('heading-looking lines inside fenced code blocks never split (plan docs quote task templates)', async () => {
    const { chunkMarkdown } = await import('../doc-chunks.js');
    const fenced = ['## Real section', 'text', '```md', '## Fake heading', '### Also fake', '```', 'more text'].join('\n');
    const chunks = chunkMarkdown(fenced);
    expect(chunks).toHaveLength(1);
    expect(chunks[0].headingTrail).toBe('Real section');
    expect(chunks[0].endLine).toBe(7);
  });

  it('a tilde run cannot close a backtick fence, and a backtick run cannot close a tilde fence (finding c82d5a79)', async () => {
    const { chunkMarkdown } = await import('../doc-chunks.js');
    const backtickOpen = ['## Real', '```md', '~~~', '## MUST STAY CODE', '```', 'tail'].join('\n');
    const tildeOpen = ['## Real', '~~~md', '```', '## ALSO CODE', '~~~', 'tail'].join('\n');
    expect(chunkMarkdown(backtickOpen).map((c) => c.headingTrail)).toEqual(['Real']);
    expect(chunkMarkdown(tildeOpen).map((c) => c.headingTrail)).toEqual(['Real']);
  });

  it('only the same marker with sufficient length closes a fence', async () => {
    const { chunkMarkdown } = await import('../doc-chunks.js');
    const doc = [
      '## Real', '````md', '```', '## SHORTER STAYS CODE', '````',
      '## After close', 'body',
    ].join('\n');
    expect(chunkMarkdown(doc).map((c) => c.headingTrail)).toEqual(['Real', 'After close']);
  });

  it('a same-marker run with trailing text is code content, not a closing fence (finding 558a072a)', async () => {
    const { chunkMarkdown } = await import('../doc-chunks.js');
    const doc = [
      '## Real', '````md', '````not-a-close', '## MUST STAY CODE', '````',
      '## After close', 'body',
    ].join('\n');
    expect(chunkMarkdown(doc).map((c) => c.headingTrail)).toEqual(['Real', 'After close']);
  });

  it('four-space-indented fence-like lines are not fences (CommonMark indentation bound)', async () => {
    const { chunkMarkdown } = await import('../doc-chunks.js');
    const doc = ['## Real', '    ```', '## Still a heading', '    ```', 'body'].join('\n');
    expect(chunkMarkdown(doc).map((c) => c.headingTrail)).toEqual(['Real', 'Still a heading']);
  });

  it('line ranges are 1-based inclusive, tile the document, and map back to the exact source lines', async () => {
    const { chunkMarkdown } = await import('../doc-chunks.js');
    const lines = doc.split('\n');
    const chunks = [...chunkMarkdown(doc)].sort((a, b) => a.startLine - b.startLine);
    expect(chunks[0].startLine).toBe(1);
    expect(chunks[chunks.length - 1].endLine).toBe(lines.length);
    for (let i = 1; i < chunks.length; i++) expect(chunks[i].startLine).toBe(chunks[i - 1].endLine + 1);
    for (const c of chunks) expect(c.content).toBe(lines.slice(c.startLine - 1, c.endLine).join('\n'));
  });

  it('an oversize section splits at paragraph boundaries under the ~1,500-char cap (spec §4)', async () => {
    const { chunkMarkdown, CHUNK_CHAR_CAP } = await import('../doc-chunks.js');
    const p = 'x'.repeat(700);
    const big = ['## Big section', p, '', p, '', p].join('\n');
    const chunks = chunkMarkdown(big);
    expect(chunks).toHaveLength(2);
    for (const c of chunks) expect(c.content.length).toBeLessThanOrEqual(CHUNK_CHAR_CAP);
    expect(chunks.map((c) => [c.startLine, c.endLine])).toEqual([[1, 5], [6, 6]]);
    expect(chunks.every((c) => c.headingTrail === 'Big section')).toBe(true);
  });

  it('a single line longer than the cap stays whole — the path:line contract outranks the approximate cap', async () => {
    const { chunkMarkdown, CHUNK_CHAR_CAP } = await import('../doc-chunks.js');
    const giant = ['## Giant', 'y'.repeat(CHUNK_CHAR_CAP + 500)].join('\n');
    const chunks = chunkMarkdown(giant);
    const oversize = chunks.find((c) => c.content.length > CHUNK_CHAR_CAP);
    expect(oversize).toBeDefined();
    expect(oversize?.startLine).toBe(oversize?.endLine); // a single, real line — never a mid-line split
  });

  it('an over-cap atomic line keeps its trailing blank line so ranges still tile (finding cc05a5c5)', async () => {
    const { chunkMarkdown, CHUNK_CHAR_CAP } = await import('../doc-chunks.js');
    const source = ['## Giant', 'y'.repeat(CHUNK_CHAR_CAP + 500), '', '## After', 'body'].join('\n');
    const chunks = [...chunkMarkdown(source)].sort((a, b) => a.startLine - b.startLine);
    expect(chunks.map((c) => [c.startLine, c.endLine])).toEqual([[1, 1], [2, 3], [4, 5]]);
    expect(chunks.map((c) => c.content).join('\n')).toBe(source);
  });

  it('is deterministic: identical input produces identical chunks including hashes', async () => {
    const { chunkMarkdown } = await import('../doc-chunks.js');
    expect(JSON.stringify(chunkMarkdown(doc))).toBe(JSON.stringify(chunkMarkdown(doc)));
    expect(chunkMarkdown(doc)[0].contentHash).toMatch(/^[0-9a-f]{64}$/);
  });

  it('a doc opening with ## has no preamble chunk; a real preamble rides the H1 trail', async () => {
    const { chunkMarkdown } = await import('../doc-chunks.js');
    expect(chunkMarkdown('## Only\nbody')[0].headingTrail).toBe('Only');
    expect(chunkMarkdown(doc)[0].headingTrail).toBe('Plan 99 fixture');
  });

  it('leading blank lines attach to the first heading section so ranges tile the whole document', async () => {
    const { chunkMarkdown } = await import('../doc-chunks.js');
    const source = '\n\n## A\nbody';
    const chunks = chunkMarkdown(source);
    expect(chunks).toHaveLength(1);
    expect([chunks[0].startLine, chunks[0].endLine]).toEqual([1, 4]);
    expect(chunks[0].content).toBe(source);
  });

  it('blank-only documents still produce one exact tiled chunk and stable hash (finding 56df5a70)', async () => {
    const { chunkMarkdown } = await import('../doc-chunks.js');
    for (const source of ['', '\n', '   \n\t']) {
      const chunks = chunkMarkdown(source);
      expect(chunks).toHaveLength(1);
      expect([chunks[0].startLine, chunks[0].endLine]).toEqual([1, source.split('\n').length]);
      expect(chunks[0].headingTrail).toBe('(preamble)');
      expect(chunks[0].content).toBe(source);
      expect(chunks[0].contentHash).toMatch(/^[0-9a-f]{64}$/);
    }
  });
});

// ---------- lifecycle: register / SHA-refresh / attach (DB) ----------

const PLAN_DOC = [
  '# Plan 20 lifecycle fixture',
  '',
  '## Task 1: Wire the capacitor',
  'PLAN20 zebra hydration protocol body.',
  '',
  '### Step 1: Solder',
  'Solder the leads.',
  '',
  '## Task 2: Test it',
  'Body for task two.',
].join('\n');

describe('doc-chunk lifecycle', () => {
  const rel = 'docs/2026-08-12-plan20-lifecycle.md';

  it('mai_plan registration chunks the doc: plan_id FK, kind, current model tag (spec §3/§5)', async () => {
    fs.writeFileSync(path.join(root, rel), PLAN_DOC);
    const { planRegister } = await import('../plans.js');
    const reg = await planRegister({ path: rel });
    const rows = await admin.query<{
      plan_id: string; kind: string; heading_trail: string; embedding_model: string;
    }>(
      `SELECT plan_id, kind, heading_trail, embedding_model
         FROM doc_chunks WHERE project_id = $1 AND path = $2 ORDER BY chunk_index`,
      [projectId, rel]
    );
    expect(rows.rows).toHaveLength(4);
    expect(rows.rows.every((r) => r.plan_id === reg.id && r.kind === 'plan')).toBe(true);
    expect(rows.rows.every((r) => r.embedding_model === 'local:bge-small-en-v1.5')).toBe(true);
    expect(rows.rows.map((r) => r.heading_trail)).toContain('Task 1: Wire the capacitor > Step 1: Solder');
  });

  it('SHA refresh replaces chunks atomically: all-new rows, one new doc_sha, new content present', async () => {
    fs.writeFileSync(path.join(root, rel), PLAN_DOC);
    const { planRegister } = await import('../plans.js');
    await planRegister({ path: rel });
    const before = await admin.query<{ id: string; doc_sha: string }>(
      `SELECT id, doc_sha FROM doc_chunks WHERE project_id = $1 AND path = $2`, [projectId, rel]);
    fs.appendFileSync(path.join(root, rel), '\n\n## Task 3: Ship it\nShip body.');
    await planRegister({ path: rel }); // SHA-refresh path
    const after = await admin.query<{ id: string; doc_sha: string; heading_trail: string }>(
      `SELECT id, doc_sha, heading_trail FROM doc_chunks WHERE project_id = $1 AND path = $2`, [projectId, rel]);
    expect(after.rows.map((r) => r.heading_trail)).toContain('Task 3: Ship it');
    expect(new Set(after.rows.map((r) => r.doc_sha)).size).toBe(1);
    expect(after.rows[0].doc_sha).not.toBe(before.rows[0].doc_sha);
    const beforeIds = new Set(before.rows.map((r) => r.id));
    expect(after.rows.some((r) => beforeIds.has(r.id))).toBe(false); // delete-and-rechunk, per doc
  });

  it('an unchanged re-register leaves the chunk rows untouched (doc_sha short-circuit)', async () => {
    fs.writeFileSync(path.join(root, rel), PLAN_DOC);
    const { planRegister } = await import('../plans.js');
    await planRegister({ path: rel });
    const ids = (
      await admin.query<{ id: string }>(
        `SELECT id FROM doc_chunks WHERE project_id = $1 AND path = $2 ORDER BY chunk_index`, [projectId, rel])
    ).rows.map((r) => r.id);
    await planRegister({ path: rel });
    const again = (
      await admin.query<{ id: string }>(
        `SELECT id FROM doc_chunks WHERE project_id = $1 AND path = $2 ORDER BY chunk_index`, [projectId, rel])
    ).rows.map((r) => r.id);
    expect(again).toEqual(ids);
  });

  it('a chunking failure never fails registration — best-effort warn + zero chunks (derived data)', async () => {
    // PG rejects \u0000 in a text param (verified live 2026-08-12: `invalid
    // byte sequence for encoding "UTF8": 0x00`) — a NUL byte in the doc makes
    // the chunk INSERT throw while registration's own writes are unaffected.
    const nulRel = 'docs/2026-08-12-plan20-nul.md';
    fs.writeFileSync(
      path.join(root, nulRel),
      Buffer.concat([Buffer.from('## Nul section\nbody '), Buffer.from([0]), Buffer.from(' tail')])
    );
    const warns: string[] = [];
    const spy = vi.spyOn(console, 'warn').mockImplementation((...a: unknown[]) => {
      warns.push(a.join(' '));
    });
    try {
      const { planRegister } = await import('../plans.js');
      const reg = await planRegister({ path: nulRel });
      expect(reg.current_sha).toMatch(/^[0-9a-f]{64}$/); // registration landed
    } finally {
      spy.mockRestore();
    }
    expect(warns.some((w) => w.includes('[mai-docs]'))).toBe(true);
    const n = await admin.query(
      `SELECT count(*) FROM doc_chunks WHERE project_id = $1 AND path = $2`, [projectId, nulRel]);
    expect(Number(n.rows[0].count)).toBe(0); // atomic: no partial chunk set survives the rollback
  });

  it('late registration attaches plan_id to sweep-written chunks WITHOUT rechunking (unchanged path)', async () => {
    const lateRel = 'docs/2026-08-12-plan20-late.md';
    fs.writeFileSync(path.join(root, lateRel), PLAN_DOC);
    const { rechunkDoc } = await import('../doc-chunks.js');
    const { resolvePlanPath, planRegister } = await import('../plans.js');
    const abs = await resolvePlanPath(projectId, lateRel);
    // repo_root is the REALPATH'd registered root (B1 identity): passing
    // fs.realpathSync(root) here also pins that the mai_plan hook computes the
    // same value — otherwise the attach below would find no matching rows.
    await rechunkDoc({
      projectId, repoRoot: fs.realpathSync(root), path: lateRel, absPath: abs, kind: 'plan', planId: null,
    });
    const before = (
      await admin.query<{ id: string; plan_id: string | null }>(
        `SELECT id, plan_id FROM doc_chunks WHERE project_id = $1 AND path = $2 ORDER BY chunk_index`,
        [projectId, lateRel])
    ).rows;
    expect(before.every((r) => r.plan_id === null)).toBe(true);
    const reg = await planRegister({ path: lateRel });
    const after = (
      await admin.query<{ id: string; plan_id: string | null }>(
        `SELECT id, plan_id FROM doc_chunks WHERE project_id = $1 AND path = $2 ORDER BY chunk_index`,
        [projectId, lateRel])
    ).rows;
    expect(after.every((r) => r.plan_id === reg.id)).toBe(true);
    expect(after.map((r) => r.id)).toEqual(before.map((r) => r.id)); // attached, not rechunked
  });

  it('reconciles different-basename physical aliases without losing reviews/findings (6c2cd767/74e23d3b)', async () => {
    const canonical = 'REAL.md';
    const oldAlias = 'ALIAS.md';
    const abs = path.join(root, canonical);
    fs.writeFileSync(abs, PLAN_DOC);
    fs.symlinkSync(canonical, path.join(root, oldAlias));
    const aliasPlan = await admin.query<{ id: string }>(
      `INSERT INTO plans (project_id, slug, path, title, current_sha, status)
       VALUES ($1, 'ALIAS', $2, 'Alias fixture', $3, 'reviewing') RETURNING id`,
      [projectId, oldAlias, '0'.repeat(64)]
    );
    const canonicalPlan = await admin.query<{ id: string }>(
      `INSERT INTO plans (project_id, slug, path, title, current_sha, status)
       VALUES ($1, 'REAL', $2, 'Canonical fixture', $3, 'draft') RETURNING id`,
      [projectId, canonical, '0'.repeat(64)]
    );
    const review = await admin.query<{ id: string }>(
      `INSERT INTO plan_reviews
         (plan_id, pass, kind, reviewer_agent, verdict, plan_sha, synthesis)
       VALUES ($1, 1, 'blind', 'legacy-fixture', 'blocked', $2, 'must survive merge') RETURNING id`,
      [aliasPlan.rows[0].id, '0'.repeat(64)]
    );
    await admin.query(
      `INSERT INTO plan_findings
         (review_id, plan_id, project_id, ref, severity, title, location, issue, evidence, fix)
       VALUES ($1,$2,$3,'B1','blocker','legacy finding','Task 3','i','e','f')`,
      [review.rows[0].id, aliasPlan.rows[0].id, projectId]
    );
    const { rechunkDoc } = await import('../doc-chunks.js');
    await rechunkDoc({
      projectId, repoRoot: fs.realpathSync(root), path: oldAlias, absPath: abs,
      kind: 'plan', planId: aliasPlan.rows[0].id,
    });

    const { planRegister } = await import('../plans.js');
    const a = await planRegister({ path: oldAlias }); // default slug ALIAS differs from canonical REAL
    const b = await planRegister({ path: canonical });
    expect(a.id).toBe(canonicalPlan.rows[0].id); // canonical row wins deterministically
    expect(b.id).toBe(a.id);
    expect(a.path).toBe(canonical);
    expect(b.path).toBe(canonical);
    const plans = await admin.query<{ id: string; path: string }>(
      `SELECT id, path FROM plans WHERE project_id = $1`, [projectId]);
    expect(plans.rows).toEqual([{ id: a.id, path: canonical }]);
    const deps = await admin.query<{ reviews: string; findings: string }>(
      `SELECT
         (SELECT count(*)::text FROM plan_reviews WHERE plan_id = $1) reviews,
         (SELECT count(*)::text FROM plan_findings WHERE plan_id = $1) findings`, [a.id]);
    expect(deps.rows[0]).toEqual({ reviews: '1', findings: '1' });
    const identities = await admin.query<{ path: string; plan_id: string | null }>(
      `SELECT DISTINCT path, plan_id FROM doc_chunks WHERE project_id = $1 ORDER BY path`, [projectId]);
    expect(identities.rows).toEqual([{ path: canonical, plan_id: a.id }]);
  });
});

// ---------- sweep (ingest-chain trigger) ----------

describe('docs sweep', () => {
  let root2: string;
  beforeEach(async () => {
    // The sweep describe gets its OWN root per test: conventional dirs are
    // fixed paths, so reusing the shared root would leak fixture files
    // between cases and break the exact-count assertions.
    root2 = fs.mkdtempSync(path.join(os.tmpdir(), 'plan20-sweep-'));
    for (const d of ['docs/superpowers/plans', 'docs/superpowers/specs', 'notes']) {
      fs.mkdirSync(path.join(root2, d), { recursive: true });
    }
    await admin.query(`UPDATE projects SET path = $1 WHERE id = $2`, [root2, projectId]);
  });
  afterEach(async () => {
    await admin.query(`UPDATE projects SET path = $1 WHERE id = $2`, [root, projectId]);
    fs.rmSync(root2, { recursive: true, force: true });
  });

  it('scan set = conventional dirs + registered-plan dirs; kind labeling + plan_id attach (spec §2)', async () => {
    fs.writeFileSync(path.join(root2, 'docs/superpowers/plans/2026-08-12-plan-a.md'), '## A section\nPlan A body.');
    fs.writeFileSync(path.join(root2, 'docs/superpowers/specs/2026-08-12-spec-b.md'), '## B section\nSpec B body.');
    fs.writeFileSync(path.join(root2, 'notes/2026-08-12-plan-c.md'), '## C section\nPlan C body.');
    const { planRegister } = await import('../plans.js');
    // Custom dir reaches the scan set via the plans table (the custom-layout
    // docs/plans pattern) — and registration already chunked it, so the sweep
    // must count it unchanged.
    const regC = await planRegister({ path: 'notes/2026-08-12-plan-c.md' });
    const { runDocsSweep } = await import('../scripts/docs-sweep.js');
    const summary = await runDocsSweep();
    expect(summary).toBe(
      'docs sweep: 3 doc(s) seen, 2 re-chunked, 1 unchanged, 0 failed, 0 deleted doc(s) swept'
    );
    const rows = await admin.query<{ path: string; kind: string; plan_id: string | null }>(
      `SELECT DISTINCT path, kind, plan_id FROM doc_chunks WHERE project_id = $1 ORDER BY path`,
      [projectId]
    );
    expect(rows.rows).toEqual([
      { path: 'docs/superpowers/plans/2026-08-12-plan-a.md', kind: 'plan', plan_id: null },
      { path: 'docs/superpowers/specs/2026-08-12-spec-b.md', kind: 'spec', plan_id: null },
      { path: 'notes/2026-08-12-plan-c.md', kind: 'plan', plan_id: regC.id },
    ]);
  });

  it('changed/unchanged/deleted: exactly the changed set re-chunks; deleted docs are swept (spec §7)', async () => {
    const a = 'docs/superpowers/plans/2026-08-12-plan-a.md';
    const b = 'docs/superpowers/specs/2026-08-12-spec-b.md';
    fs.writeFileSync(path.join(root2, a), '## A section\nPlan A body.');
    fs.writeFileSync(path.join(root2, b), '## B section\nSpec B body.');
    const { runDocsSweep } = await import('../scripts/docs-sweep.js');
    expect(await runDocsSweep()).toBe(
      'docs sweep: 2 doc(s) seen, 2 re-chunked, 0 unchanged, 0 failed, 0 deleted doc(s) swept'
    );
    fs.appendFileSync(path.join(root2, b), '\n\n## B2 section\nPLAN20SWEEPMARK new spec body.');
    fs.rmSync(path.join(root2, a));
    expect(await runDocsSweep()).toBe(
      'docs sweep: 1 doc(s) seen, 1 re-chunked, 0 unchanged, 0 failed, 1 deleted doc(s) swept'
    );
    const aCount = await admin.query(
      `SELECT count(*) FROM doc_chunks WHERE project_id = $1 AND path = $2`, [projectId, a]);
    expect(Number(aCount.rows[0].count)).toBe(0);
    const bRows = await admin.query<{ content: string }>(
      `SELECT content FROM doc_chunks WHERE project_id = $1 AND path = $2`, [projectId, b]);
    expect(bRows.rows.some((r) => r.content.includes('PLAN20SWEEPMARK'))).toBe(true);
  });

  it('a blank-only doc persists doc_sha and is unchanged with stable row identity on the second sweep (finding 56df5a70)', async () => {
    const rel = 'docs/superpowers/plans/2026-08-12-blank-plan.md';
    fs.writeFileSync(path.join(root2, rel), '   \n\t');
    const { runDocsSweep } = await import('../scripts/docs-sweep.js');
    expect(await runDocsSweep()).toBe(
      'docs sweep: 1 doc(s) seen, 1 re-chunked, 0 unchanged, 0 failed, 0 deleted doc(s) swept'
    );
    const before = await admin.query<{ id: string; doc_sha: string; content: string }>(
      `SELECT id, doc_sha, content FROM doc_chunks
        WHERE project_id = $1 AND path = $2 ORDER BY chunk_index`, [projectId, rel]);
    expect(before.rows).toHaveLength(1);
    expect(before.rows[0].content).toBe('   \n\t');
    expect(before.rows[0].doc_sha).toMatch(/^[0-9a-f]{64}$/);

    expect(await runDocsSweep()).toBe(
      'docs sweep: 1 doc(s) seen, 0 re-chunked, 1 unchanged, 0 failed, 0 deleted doc(s) swept'
    );
    const after = await admin.query<{ id: string; doc_sha: string }>(
      `SELECT id, doc_sha FROM doc_chunks
        WHERE project_id = $1 AND path = $2 ORDER BY chunk_index`, [projectId, rel]);
    expect(after.rows).toEqual(before.rows.map(({ id, doc_sha }) => ({ id, doc_sha })));
  });

  it('EVERY registered repo is swept: a metadata.repos root OUTSIDE the umbrella is seen, chunked, and deletion-swept (finding 2481fa65 / decision 1a4765b0)', async () => {
    // projects.path = the umbrella (root2); the registered repo lives
    // somewhere else entirely — the exact outside-repo umbrella shape, where
    // getProjectRepos returns metadata.repos and NOT projects.path.
    const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'plan20-outside-'));
    fs.mkdirSync(path.join(outside, 'docs/superpowers/plans'), { recursive: true });
    const outRel = 'docs/superpowers/plans/2026-08-12-plan-outside.md';
    fs.writeFileSync(path.join(outside, outRel), '## Outside section\nPLAN20OUTSIDE body.');
    fs.writeFileSync(path.join(root2, 'docs/superpowers/plans/2026-08-12-plan-a.md'), '## A section\nPlan A body.');
    await admin.query(`UPDATE projects SET metadata = $1::jsonb WHERE id = $2`, [
      JSON.stringify({ repos: [outside] }), projectId,
    ]);
    try {
      const { runDocsSweep } = await import('../scripts/docs-sweep.js');
      expect(await runDocsSweep()).toBe(
        'docs sweep: 2 doc(s) seen, 2 re-chunked, 0 unchanged, 0 failed, 0 deleted doc(s) swept'
      );
      // Identity: rows under the umbrella keep project-root-relative paths
      // (byte-identical to single-root behaviour); the outside repo records
      // its OWN realpath'd root. Both roots are realpath'd — mkdtemp under
      // /var on macOS is a symlink to /private/var, which is exactly the
      // canonicalization this contract depends on.
      const rows = await admin.query<{ repo_root: string; path: string }>(
        `SELECT DISTINCT repo_root, path FROM doc_chunks WHERE project_id = $1 ORDER BY path`,
        [projectId]
      );
      expect(rows.rows).toEqual([
        { repo_root: fs.realpathSync(root2), path: 'docs/superpowers/plans/2026-08-12-plan-a.md' },
        { repo_root: fs.realpathSync(outside), path: outRel },
      ]);
      // The deletion sweep reaches the outside root too.
      fs.rmSync(path.join(outside, outRel));
      expect(await runDocsSweep()).toBe(
        'docs sweep: 1 doc(s) seen, 0 re-chunked, 1 unchanged, 0 failed, 1 deleted doc(s) swept'
      );
      const left = await admin.query(
        `SELECT count(*) FROM doc_chunks WHERE project_id = $1 AND repo_root = $2`,
        [projectId, fs.realpathSync(outside)]
      );
      expect(Number(left.rows[0].count)).toBe(0);
    } finally {
      await admin.query(`UPDATE projects SET metadata = '{}'::jsonb WHERE id = $1`, [projectId]);
      fs.rmSync(outside, { recursive: true, force: true });
    }
  });

  it('review/findings filename families produce ZERO chunks; plans and specs beside them still ingest (finding 9238bdf1, spec §2)', async () => {
    // Fixtures are this repository's REAL filenames — the corpus the first
    // hook sweep would otherwise have ingested.
    const excluded = [
      'docs/superpowers/plans/2026-07-22-plan-9-review.md',
      'docs/superpowers/plans/2026-08-10-plan-16-review-pass-3.md',
      'docs/superpowers/specs/2026-07-08-capture-spike-findings.md',
    ];
    const included = [
      'docs/superpowers/plans/2026-08-09-plan-16-findings-tracker.md', // a PLAN — "findings" mid-stem
      'docs/superpowers/specs/2026-08-09-plan-findings-tracker-design.md', // its spec
    ];
    // Tracker identity outranks the filename contract: a review-named file
    // that IS registered as a plan ingests (registration already chunked it,
    // so the sweep must count it unchanged, not skip it).
    const registeredReview = 'docs/superpowers/plans/2026-08-08-plan-13-review.md';
    for (const rel of [...excluded, ...included, registeredReview]) {
      fs.writeFileSync(path.join(root2, rel), `## Section for ${path.basename(rel)}\nPLAN20CLASSIFY body.`);
    }
    const { planRegister } = await import('../plans.js');
    const regReview = await planRegister({ path: registeredReview });
    const { runDocsSweep } = await import('../scripts/docs-sweep.js');
    expect(await runDocsSweep()).toBe(
      'docs sweep: 3 doc(s) seen, 2 re-chunked, 1 unchanged, 0 failed, 0 deleted doc(s) swept'
    );
    const rows = await admin.query<{ path: string; plan_id: string | null }>(
      `SELECT DISTINCT path, plan_id FROM doc_chunks WHERE project_id = $1 ORDER BY path`,
      [projectId]
    );
    expect(rows.rows.map((r) => r.path).sort()).toEqual([...included, registeredReview].sort());
    for (const rel of excluded) {
      const n = await admin.query(
        `SELECT count(*) FROM doc_chunks WHERE project_id = $1 AND path = $2`, [projectId, rel]);
      expect(Number(n.rows[0].count)).toBe(0);
    }
    expect(rows.rows.find((r) => r.path === registeredReview)?.plan_id).toBe(regReview.id);
  });

  it('a registered plan under a conventional specs dir keeps kind=plan when it CHANGES (finding abdf0cd3)', async () => {
    const rel = 'docs/superpowers/specs/2026-08-12-plan-filed-in-specs.md';
    fs.writeFileSync(path.join(root2, rel), '## Filed section\nPLAN20FILED body.');
    const { planRegister } = await import('../plans.js');
    const reg = await planRegister({ path: rel }); // registration chunks it as a plan
    fs.appendFileSync(path.join(root2, rel), '\n\n## Second section\nPLAN20FILED more body.');
    const { runDocsSweep } = await import('../scripts/docs-sweep.js');
    expect(await runDocsSweep()).toBe(
      'docs sweep: 1 doc(s) seen, 1 re-chunked, 0 unchanged, 0 failed, 0 deleted doc(s) swept'
    );
    const rows = await admin.query<{ kind: string; plan_id: string | null }>(
      `SELECT DISTINCT kind, plan_id FROM doc_chunks WHERE project_id = $1 AND path = $2`,
      [projectId, rel]
    );
    // Directory kind would say 'spec'; tracker identity wins.
    expect(rows.rows).toEqual([{ kind: 'plan', plan_id: reg.id }]);
  });

  it('a registered plan under a conventional specs dir keeps kind=plan and its plan_id when UNCHANGED (finding abdf0cd3 — the relabel path)', async () => {
    const rel = 'docs/superpowers/specs/2026-08-12-plan-filed-in-specs.md';
    fs.writeFileSync(path.join(root2, rel), '## Filed section\nPLAN20FILED body.');
    const { planRegister } = await import('../plans.js');
    const reg = await planRegister({ path: rel });
    const before = (
      await admin.query<{ id: string }>(
        `SELECT id FROM doc_chunks WHERE project_id = $1 AND path = $2 ORDER BY chunk_index`,
        [projectId, rel])
    ).rows.map((r) => r.id);
    const { runDocsSweep } = await import('../scripts/docs-sweep.js');
    expect(await runDocsSweep()).toBe(
      'docs sweep: 1 doc(s) seen, 0 re-chunked, 1 unchanged, 0 failed, 0 deleted doc(s) swept'
    );
    const rows = await admin.query<{ id: string; kind: string; plan_id: string | null }>(
      `SELECT id, kind, plan_id FROM doc_chunks WHERE project_id = $1 AND path = $2 ORDER BY chunk_index`,
      [projectId, rel]
    );
    // The unchanged branch UPDATEs plan_id AND kind — with directory kind
    // winning it would rewrite these rows to 'spec'.
    expect(rows.rows.every((r) => r.kind === 'plan' && r.plan_id === reg.id)).toBe(true);
    expect(rows.rows.map((r) => r.id)).toEqual(before); // attached/kept, not rechunked
  });

  it('tracker identity is root-qualified: external path collisions never inherit plan_id/kind or bypass exclusions (finding ec3abe2d)', async () => {
    const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'plan20-collision-'));
    fs.mkdirSync(path.join(outside, 'docs/superpowers/specs'), { recursive: true });
    const collision = 'docs/superpowers/specs/2026-08-12-collision.md';
    const review = 'docs/superpowers/specs/2026-08-12-plan-review.md';
    for (const rel of [collision, review]) {
      fs.writeFileSync(path.join(root2, rel), `## Project ${path.basename(rel)}\nPROJECT ROOT body.`);
      fs.writeFileSync(path.join(outside, rel), `## Outside ${path.basename(rel)}\nOUTSIDE ROOT body.`);
    }
    const { planRegister } = await import('../plans.js');
    const projectPlan = await planRegister({ path: collision });
    await planRegister({ path: review }); // tracker identity legitimately overrides review exclusion HERE only
    await admin.query(`UPDATE projects SET metadata = $1::jsonb WHERE id = $2`, [
      JSON.stringify({ repos: [outside] }), projectId,
    ]);
    try {
      const { runDocsSweep } = await import('../scripts/docs-sweep.js');
      expect(await runDocsSweep()).toBe(
        'docs sweep: 3 doc(s) seen, 1 re-chunked, 2 unchanged, 0 failed, 0 deleted doc(s) swept'
      );
      const outsideRows = await admin.query<{ path: string; kind: string; plan_id: string | null }>(
        `SELECT DISTINCT path, kind, plan_id FROM doc_chunks
          WHERE project_id = $1 AND repo_root = $2 ORDER BY path`,
        [projectId, fs.realpathSync(outside)]
      );
      expect(outsideRows.rows).toEqual([{ path: collision, kind: 'spec', plan_id: null }]);
      expect(outsideRows.rows[0].plan_id).not.toBe(projectPlan.id);
      // The external review collision stays excluded even though the project
      // root has a registered plan at the identical relative path.
      expect(outsideRows.rows.some((r) => r.path === review)).toBe(false);
    } finally {
      await admin.query(`UPDATE projects SET metadata = '{}'::jsonb WHERE id = $1`, [projectId]);
      fs.rmSync(outside, { recursive: true, force: true });
    }
  });

  it('targets a project-root plan without ingesting adjacent root Markdown, then deletes it (eeadd2bf/ed9b7c52)', async () => {
    const rel = 'PLAN.md';
    const abs = path.join(root2, rel);
    fs.writeFileSync(abs, '## Root plan\nROOT LEVEL body.');
    const readme = path.join(root2, 'README.md');
    const contributing = path.join(root2, 'CONTRIBUTING.md');
    fs.writeFileSync(readme, '## README\nARBITRARY root markdown.');
    fs.writeFileSync(contributing, '## Contributing\nARBITRARY root markdown.');
    // Seed the pre-fix untouched tracker spelling directly. The sweep must
    // canonicalize it BEFORE scan-shape selection; no mai_plan re-register is
    // allowed to perform the repair first (finding 09f1f43f).
    const reg = (
      await admin.query<{ id: string }>(
        `INSERT INTO plans (project_id, slug, path, title, current_sha, status)
         VALUES ($1, 'root-plan-legacy', 'docs/../PLAN.md', 'Legacy root plan', $2, 'draft')
         RETURNING id`,
        [projectId, '0'.repeat(64)]
      )
    ).rows[0];
    // Simulate a stale README chunk written by fix merge 3's over-broad `.`
    // scan. The repaired targeted-file eligibility must sweep it.
    const { rechunkDoc } = await import('../doc-chunks.js');
    await rechunkDoc({
      projectId, repoRoot: fs.realpathSync(root2), path: 'README.md', absPath: readme,
      kind: 'plan', planId: null,
    });
    const { runDocsSweep } = await import('../scripts/docs-sweep.js');

    expect(await runDocsSweep()).toBe(
      'docs sweep: 1 doc(s) seen, 1 re-chunked, 0 unchanged, 0 failed, 1 deleted doc(s) swept'
    );
    const kept = await admin.query<{ kind: string; plan_id: string | null }>(
      `SELECT DISTINCT kind, plan_id FROM doc_chunks
        WHERE project_id = $1 AND repo_root = $2 AND path = $3`,
      [projectId, fs.realpathSync(root2), rel]
    );
    expect(kept.rows).toEqual([{ kind: 'plan', plan_id: reg.id }]);
    const arbitrary = await admin.query(
      `SELECT count(*) FROM doc_chunks WHERE project_id = $1 AND path IN ('README.md', 'CONTRIBUTING.md')`,
      [projectId]
    );
    expect(Number(arbitrary.rows[0].count)).toBe(0);

    fs.unlinkSync(abs);
    expect(await runDocsSweep()).toBe(
      'docs sweep: 0 doc(s) seen, 0 re-chunked, 0 unchanged, 0 failed, 1 deleted doc(s) swept'
    );
    const left = await admin.query(
      `SELECT count(*) FROM doc_chunks WHERE project_id = $1 AND path = $2`, [projectId, rel]);
    expect(Number(left.rows[0].count)).toBe(0);
    expect(fs.existsSync(readme) && fs.existsSync(contributing)).toBe(true); // excluded by scope, not deleted
  });

  it('deregistering external AND nested repos sweeps still-existing chunks from the current eligibility set (finding b1e0bf97)', async () => {
    const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'plan20-deregister-out-'));
    const nested = path.join(root2, 'nested-repo');
    const rel = 'docs/superpowers/plans/2026-08-12-deregister.md';
    for (const repo of [outside, nested]) {
      fs.mkdirSync(path.join(repo, 'docs/superpowers/plans'), { recursive: true });
      fs.writeFileSync(path.join(repo, rel), `## ${path.basename(repo)}\nSTILL EXISTS body.`);
    }
    await admin.query(`UPDATE projects SET metadata = $1::jsonb WHERE id = $2`, [
      JSON.stringify({ repos: [outside, nested] }), projectId,
    ]);
    try {
      const { runDocsSweep } = await import('../scripts/docs-sweep.js');
      expect(await runDocsSweep()).toBe(
        'docs sweep: 2 doc(s) seen, 2 re-chunked, 0 unchanged, 0 failed, 0 deleted doc(s) swept'
      );
      await admin.query(`UPDATE projects SET metadata = '{}'::jsonb WHERE id = $1`, [projectId]);
      // Files still exist. Only registration changed; both identities are now
      // outside the CURRENT root+scan-directory set and must be swept.
      expect(fs.existsSync(path.join(outside, rel))).toBe(true);
      expect(fs.existsSync(path.join(nested, rel))).toBe(true);
      expect(await runDocsSweep()).toBe(
        'docs sweep: 0 doc(s) seen, 0 re-chunked, 0 unchanged, 0 failed, 2 deleted doc(s) swept'
      );
      const left = await admin.query(
        `SELECT count(*) FROM doc_chunks WHERE project_id = $1`, [projectId]);
      expect(Number(left.rows[0].count)).toBe(0);
    } finally {
      await admin.query(`UPDATE projects SET metadata = '{}'::jsonb WHERE id = $1`, [projectId]);
      fs.rmSync(outside, { recursive: true, force: true });
      fs.rmSync(nested, { recursive: true, force: true });
    }
  });
});

// ---------- recall: mai_search + mai_prime pointer section ----------

describe('doc-chunk recall (three-state hybrid — lesson 8712fd38)', () => {
  const recallRel = 'docs/2026-08-12-plan20-recall.md';
  const recallDoc = [
    '# Recall fixture',
    '',
    '## Task 1: Hydrate the zebra',
    'PLAN20 zebra hydration protocol ' + 'filler '.repeat(40) + 'FULLBODYMARKER',
    '',
    '## Task 2: Related mention',
    'Also mentions zebra hydration protocol here.',
  ].join('\n');

  it('pointers surface in mai_search: path:line + heading trail + excerpt, never full bodies (spec §6)', async () => {
    const { setLocalEmbedderForTests } = await import('../embeddings.js');
    setLocalEmbedderForTests(async () => oneHot(5)); // query and stored vectors align → semantic lane
    fs.writeFileSync(path.join(root, recallRel), recallDoc);
    const { planRegister } = await import('../plans.js');
    await planRegister({ path: recallRel });
    const { unifiedSearch } = await import('../decisions.js');
    const out = await unifiedSearch({ query: 'zebra hydration protocol', kind: 'all', limit: 15 });
    expect(out).toContain('## Plan/spec docs');
    expect(out).toMatch(new RegExp(`${recallRel}:\\d+-\\d+`));
    expect(out).toContain('Task 1: Hydrate the zebra');
    expect(out).not.toContain('FULLBODYMARKER'); // the pointer IS the product — bodies never render
  });

  it('caps at 3 pointers regardless of matching chunks', async () => {
    const { setLocalEmbedderForTests } = await import('../embeddings.js');
    setLocalEmbedderForTests(async () => oneHot(5));
    const capRel = 'docs/2026-08-12-plan20-cap.md';
    const sections: string[] = [];
    for (let i = 1; i <= 5; i++) sections.push(`## Sec ${i}`, `PLAN20 quokka telemetry rig ${i}.`, '');
    fs.writeFileSync(path.join(root, capRel), sections.join('\n'));
    const { planRegister } = await import('../plans.js');
    await planRegister({ path: capRel });
    const { unifiedSearch } = await import('../decisions.js');
    const out = await unifiedSearch({ query: 'quokka telemetry rig', kind: 'all', limit: 15 });
    const docsSection = out.split('## Plan/spec docs')[1] ?? '';
    expect(docsSection.split('\n').filter((l) => l.startsWith('- '))).toHaveLength(3);
  });

  it('state 1 — embeddings unavailable → the trigram lane still finds the chunk', async () => {
    fs.writeFileSync(path.join(root, recallRel), recallDoc);
    const { planRegister } = await import('../plans.js');
    await planRegister({ path: recallRel });
    process.env.MAI_EMBEDDINGS = '0';
    const { unifiedSearch } = await import('../decisions.js');
    const out = await unifiedSearch({ query: 'zebra hydration protocol', kind: 'all', limit: 15 });
    expect(out).toContain('## Plan/spec docs');
    expect(out).toMatch(new RegExp(`${recallRel}:\\d+-\\d+`));
  });

  it('state 3 — zero semantic hits → all-row trigram rescue, never suppressed by a stale text hit', async () => {
    const { setLocalEmbedderForTests } = await import('../embeddings.js');
    setLocalEmbedderForTests(async () => oneHot(3)); // stored vectors
    fs.writeFileSync(path.join(root, recallRel), recallDoc);
    const { planRegister } = await import('../plans.js');
    await planRegister({ path: recallRel });
    // Plant a stale row that ALSO text-matches the query: it must not suppress
    // the all-row rescue of the cosine-rejected current-model chunk (the
    // plan-16 pass-7 B1 mutation detector, ported to the chunk lane).
    await admin.query(
      `UPDATE doc_chunks SET embedding_model = 'old:model'
        WHERE project_id = $1 AND path = $2 AND heading_trail = 'Task 2: Related mention'`,
      [projectId, recallRel]
    );
    setLocalEmbedderForTests(async () => oneHot(9)); // query orthogonal → cosine 0 → zero semantic hits
    const { unifiedSearch } = await import('../decisions.js');
    const out = await unifiedSearch({ query: 'zebra hydration protocol', kind: 'all', limit: 15 });
    expect(out).toContain('Task 1: Hydrate the zebra'); // current-model row rescued by the all-row pass
  });

  it('state 2 — semantic hits merge with a stale trigram hit under one budget; stale labeled with the remedy', async () => {
    const { setLocalEmbedderForTests } = await import('../embeddings.js');
    setLocalEmbedderForTests(async () => oneHot(5));
    fs.writeFileSync(path.join(root, recallRel), recallDoc);
    const staleRel = 'docs/2026-08-12-plan20-stale.md';
    fs.writeFileSync(
      path.join(root, staleRel),
      '## Stale section\nPLAN20 wombat cadence ledger zebra hydration protocol.'
    );
    const { planRegister } = await import('../plans.js');
    await planRegister({ path: recallRel });
    await planRegister({ path: staleRel });
    await admin.query(
      `UPDATE doc_chunks SET embedding_model = 'old:model' WHERE project_id = $1 AND path = $2`,
      [projectId, staleRel]
    );
    const { unifiedSearch } = await import('../decisions.js');
    const out = await unifiedSearch({ query: 'zebra hydration protocol', kind: 'all', limit: 15 });
    const docsSection = out.split('## Plan/spec docs')[1] ?? '';
    expect(docsSection).toContain(staleRel);
    expect(docsSection).toContain('mai embed --rebuild'); // the stale label names the remedy
  });

  it('mai_prime folds the same pointer section in (via its unifiedSearch kind:"all" call)', async () => {
    const { setLocalEmbedderForTests } = await import('../embeddings.js');
    setLocalEmbedderForTests(async () => oneHot(5));
    fs.writeFileSync(path.join(root, recallRel), recallDoc);
    const { planRegister } = await import('../plans.js');
    await planRegister({ path: recallRel });
    const { prime } = await import('../prime.js');
    const out = await prime('zebra hydration protocol work', 'summary');
    expect(out).toContain('## Plan/spec docs');
    expect(out).toMatch(new RegExp(`${recallRel}:\\d+-\\d+`));
  });
});

// ---------- mai embed --rebuild covers chunks ----------

describe('embed rebuild covers doc chunks', () => {
  it('re-embeds stale-tagged chunks with the current model (the plan-16 findings precedent)', async () => {
    const rel = 'docs/2026-08-12-plan20-rebuild.md';
    fs.writeFileSync(path.join(root, rel), '## Rebuild section\nPLAN20 rebuild body.');
    const { planRegister } = await import('../plans.js');
    await planRegister({ path: rel });
    await admin.query(
      `UPDATE doc_chunks SET embedding_model = 'old:model' WHERE project_id = $1 AND path = $2`,
      [projectId, rel]
    );
    const { runEmbedRebuild } = await import('../scripts/embed-rebuild.js');
    // lessonRuleLike confines the GLOBAL lessons half to a no-match pattern —
    // the same seam plans-findings and embeddings-local use to protect real
    // lessons (embed-rebuild.ts RebuildOpts).
    const out = await runEmbedRebuild({ projectSlug: 'plan20-test', lessonRuleLike: 'PLAN20NOLESSON %' });
    expect(out).toContain('chunk(s) re-embedded');
    const rows = await admin.query<{ embedding_model: string }>(
      `SELECT embedding_model FROM doc_chunks WHERE project_id = $1 AND path = $2`, [projectId, rel]);
    expect(rows.rows.every((r) => r.embedding_model === 'local:bge-small-en-v1.5')).toBe(true);
  });
});
