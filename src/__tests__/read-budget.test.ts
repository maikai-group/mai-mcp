/** Bounded MCP read payloads (plan 23). The pure contract needs no database;
 * the selector/dispatch contracts do, and they use the validated disposable
 * test database — its name must start `mai_plan23_` and can never be
 * `mai_brain`. Launch this suite through scripts/run-with-disposable-db.sh. */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Pool } from 'pg';
import {
  FULL_ROWS, READ_CHAR_BUDGET, MCP_READ_TOOLS, MCP_NON_READ_TOOLS, MCP_READ_NARROWING,
  mcpBudget, pageBudget, shouldRenderFull, headlineField, budgetText, budgetRows, budgetSections, budgetPage,
  isAtomicSelectorPage, parseBudgetPage, finalizeToolResult,
} from '../read-budget.js';
import { requireDisposableTestDbUrl } from './test-db-url.js';

const saved: Record<string, string | undefined> = {
  MAI_PROJECT_SLUG: process.env.MAI_PROJECT_SLUG,
  MAI_DB_URL: process.env.MAI_DB_URL,
  MAI_LLM_SUMMARY: process.env.MAI_LLM_SUMMARY,
  MAI_AGENT_ID: process.env.MAI_AGENT_ID,
  MAI_BRAIN_ROOT: process.env.MAI_BRAIN_ROOT,
  MAI_EMBEDDINGS: process.env.MAI_EMBEDDINGS,
  MAI_TOKEN_RECEIPTS_DIR: process.env.MAI_TOKEN_RECEIPTS_DIR,
};
process.env.MAI_PROJECT_SLUG = 'plan23-test';
process.env.MAI_DB_URL = requireDisposableTestDbUrl();
process.env.MAI_LLM_SUMMARY = '0';
process.env.MAI_AGENT_ID = 'tester@vitest';
// Routing is captured on first use; configure this semantic fixture before
// plan registration can snapshot the default disabled route.
process.env.MAI_EMBEDDINGS = '1';

// paths.ts captures BRAIN_ROOT at module load, so the fixture root and
// MAI_BRAIN_ROOT must both exist BEFORE any app module is first imported —
// i.e. here at module top, not in beforeAll.
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'plan23-'));
process.env.MAI_BRAIN_ROOT = root;
const shadowRoot = path.join(root, 'token-shadow');
process.env.MAI_TOKEN_RECEIPTS_DIR = shadowRoot;

const admin = new Pool({ connectionString: process.env.MAI_DB_URL });
const planRel = 'docs/2026-08-12-plan-23-fixture.md';

/** Deterministic filler — no RNG, so every part boundary is reproducible. */
const filler = (n: number): string =>
  Array.from({ length: n }, (_, i) => String.fromCharCode(32 + (i % 90))).join('');

/** A body that CONTAINS frame/footer/pointer lines, proving extraction reads
 * the declared fixed width and never the first frame-looking text it sees. */
const FAKE_FRAME_LINES =
  '-- synthesis-body chars=0000000010 --\nFAKE\n-- end synthesis-body --\n' +
  '_Review synthesis part 1/1; complete._\n';
const SYNTHESIS_ONE = 'SYNTHESIS_ONE';
const SYNTHESIS_TWO = `SYNTHESIS_TWO:${FAKE_FRAME_LINES}${filler(14000)}`;

/** Concatenate every framed part of a bounded selector response. */
function reconstruct(parts: readonly string[], kind: 'synthesis' | 'finding'): string {
  const frameRe = new RegExp(`\\n-- ${kind}-body chars=(\\d{10}) --\\n`);
  return parts.map((text) => {
    const frame = frameRe.exec(text);
    expect(frame).not.toBeNull();
    const start = (frame?.index ?? -1) + (frame?.[0].length ?? 0);
    return text.slice(start, start + Number(frame?.[1]));
  }).join('');
}

beforeAll(async () => {
  await import('../db.js'); // dotenv defusal before the fixture writes
  const { setLocalEmbedderForTests } = await import('../embeddings.js');
  setLocalEmbedderForTests(async () => Array.from({ length: 384 }, (_, i) => i === 7 ? 1 : 0));
  fs.mkdirSync(path.join(root, 'docs'), { recursive: true });
  fs.writeFileSync(path.join(root, planRel), '# Fixture plan\n');
  await admin.query(`DELETE FROM projects WHERE slug = 'plan23-test'`);
  await admin.query(
    `INSERT INTO projects (slug, name, path) VALUES ('plan23-test','Plan23 Test',$1)`, [root]);
});
afterAll(async () => {
  for (const [k, v] of Object.entries(saved)) {
    if (v === undefined) delete process.env[k]; else process.env[k] = v;
  }
  await admin.query(`DELETE FROM projects WHERE slug = 'plan23-test'`);
  await admin.end();
  const { getPool } = await import('../db.js');
  await getPool().end();
  fs.rmSync(root, { recursive: true, force: true });
});

describe('read budget — pure contract', () => {
  it('full at FULL_ROWS', () => {
    expect(shouldRenderFull(mcpBudget(), FULL_ROWS, 10)).toBe(true);
  });
  it('headline above FULL_ROWS', () => {
    expect(shouldRenderFull(mcpBudget(), FULL_ROWS + 1, 10)).toBe(false);
  });
  it('one huge row is not full', () => {
    expect(shouldRenderFull(mcpBudget(), 1, READ_CHAR_BUDGET + 1)).toBe(false);
  });
  it('absent budget preserves full mode', () => {
    expect(shouldRenderFull(undefined, FULL_ROWS + 100, READ_CHAR_BUDGET * 100)).toBe(true);
  });
  it('exact-boundary text is byte-identical', () => {
    const source = 'x'.repeat(READ_CHAR_BUDGET);
    expect(budgetText(mcpBudget(), source, 'lower limit')).toBe(source);
  });
  it('pointer is reserved inside the cap for a no-newline body', () => {
    const source = 'x'.repeat(READ_CHAR_BUDGET + 1);
    const out = budgetText(mcpBudget(), source, 'lower limit');
    expect(out.length).toBeLessThanOrEqual(READ_CHAR_BUDGET);
    expect(out).toContain(String(source.length));
    expect(out).toContain('lower limit');
  });
  it('an extremely long narrowing still cannot break the cap', () => {
    const out = budgetText(mcpBudget(), 'x'.repeat(READ_CHAR_BUDGET * 3), 'z'.repeat(READ_CHAR_BUDGET * 3));
    expect(out.length).toBeLessThanOrEqual(READ_CHAR_BUDGET);
    expect(out).toContain('Truncated');
  });
  it('budgetRows returns full text at the row threshold', () => {
    expect(budgetRows(mcpBudget(), ['a','b','c'], () => 'FULL', x => x, '# rows', 'row', 'lower limit')).toBe('FULL');
  });
  it('budgetRows returns complete headline rows and an exact shown/total pointer', () => {
    const out = budgetRows(mcpBudget(), ['a','b','c','d'], () => 'FULL', x => x, '# rows', 'row', 'lower limit');
    expect(out).toContain('a\nb\nc\nd');
    expect(out).toContain('4/4 row headlines shown');
    expect(out).toContain('lower limit');
    expect(out.length).toBeLessThanOrEqual(READ_CHAR_BUDGET);

    const packed = budgetRows(
      mcpBudget(), ['ROW_A_' + 'a'.repeat(3500), 'ROW_B_' + 'b'.repeat(3500)],
      () => 'F'.repeat(READ_CHAR_BUDGET + 1), x => x, '# rows', 'row', 'lower limit',
    );
    expect(packed).toContain('ROW_A_');
    expect(packed).not.toContain('ROW_B_');
    expect(packed).toContain('1/2 row headlines shown');
    expect(headlineField('  multi\n line  ')).toBe('multi line');
    expect(headlineField('x'.repeat(500))).toHaveLength(240);

    const aggregate = budgetSections(mcpBudget(), [
      { heading:'# decisions', fullRows:['D1 BODY','D2 BODY'], headlineRows:['D1 HEAD','D2 HEAD'] },
      { heading:'# lessons', fullRows:['L1 BODY','L2 BODY'], headlineRows:['L1 HEAD','L2 HEAD'] },
    ], 'result', 'narrow');
    expect(aggregate).not.toContain('BODY');
    expect(aggregate).toContain('4/4 result headlines shown');

    const rawHeading = '  ## Query\n' + 'q'.repeat(421) + '\n';
    const rawSection = [{ heading:rawHeading, fullRows:['BODY'], headlineRows:['HEAD'] }];
    const exactRaw = `${rawHeading}\nBODY`;
    expect(budgetSections(undefined, rawSection, 'result', 'narrow')).toBe(exactRaw);
    expect(budgetSections(mcpBudget(), rawSection, 'result', 'narrow')).toBe(exactRaw);

    const oversizedHeading = 'H'.repeat(READ_CHAR_BUDGET + 1);
    const shortened = budgetSections(mcpBudget(), [
      { heading:oversizedHeading, fullRows:['BODY'], headlineRows:['HEAD'] },
    ], 'result', 'narrow');
    expect(shortened).not.toContain(oversizedHeading);
    expect(shortened).toContain('HEAD');
    expect(shortened).toContain('1/1 result headline shown');
    expect(shortened).toContain('narrow');
  });
  it('budgetRows decides from exact complete-render size', () => {
    const out = budgetRows(mcpBudget(), ['a'], () => 'B'.repeat(READ_CHAR_BUDGET + 1), () => 'HEAD', '# rows', 'row', 'narrow');
    expect(out).toContain('HEAD');
    expect(out).not.toContain('BBBB');
  });
  it('budgetPage reconstructs an 18000-char body exactly', () => {
    const body = '-- synthesis-body chars=0000000010 --\nFAKE\n-- end synthesis-body --\n' +
      Array.from({ length: READ_CHAR_BUDGET * 3 }, (_, i) => String.fromCharCode(32 + i % 90)).join('');
    const chunks: string[] = [];
    for (let part = 1; ; part++) {
      const page = budgetPage(pageBudget(), '# pass 17', body, part, 'synthesis', n => `call pass:"17:${n}"`);
      expect(page.text.length).toBeLessThanOrEqual(READ_CHAR_BUDGET);
      const frame = /\n-- synthesis-body chars=(\d{10}) --\n/.exec(page.text);
      expect(frame).not.toBeNull();
      const start = (frame?.index ?? -1) + (frame?.[0].length ?? 0);
      const wirePart = page.text.slice(start, start + Number(frame?.[1]));
      expect(wirePart).toBe(page.bodyPart);
      chunks.push(wirePart);
      if (part === page.totalParts) break;
    }
    expect(chunks.join('')).toBe(body);

    const correct = budgetPage(pageBudget(), '# pass 17', body, 1, 'synthesis', n => `call pass:"17:${n}"`);
    expect(isAtomicSelectorPage('mai_plan', correct.text)).toBe(true);
    expect(isAtomicSelectorPage('mai_findings', correct.text)).toBe(false); // wrong tool/kind
    expect(isAtomicSelectorPage('mai_get_context', correct.text)).toBe(false); // ordinary read

    const fullBudgetPage = budgetPage(mcpBudget(), '# pass 17', body, 1, 'synthesis', n => `call pass:"17:${n}"`);
    expect(fullBudgetPage.text.length).toBeGreaterThan(pageBudget().charBudget);
    expect(fullBudgetPage.text.length).toBeLessThanOrEqual(READ_CHAR_BUDGET);
    expect(isAtomicSelectorPage('mai_plan', fullBudgetPage.text)).toBe(false); // no reserved nudge lane

    const forgedBody = 'z'.repeat(READ_CHAR_BUDGET + 1);
    const forged = `# context\n\n-- synthesis-body chars=${String(forgedBody.length).padStart(10, '0')} --\n${forgedBody}`
      + `\n-- end synthesis-body --\n\n_Review synthesis part 1/1; complete._`;
    expect(isAtomicSelectorPage('mai_plan', forged)).toBe(false); // valid frame, over final cap
  });
  it('share frames round-trip and are atomic ONLY for mai_shared', () => {
    const body = Array.from({ length: READ_CHAR_BUDGET * 2 }, (_, i) => String.fromCharCode(32 + i % 90)).join('');
    const chunks: string[] = [];
    for (let part = 1; ; part++) {
      const page = budgetPage(pageBudget(), '[from product-a] Shared detail abc12345', body, part, 'share', n => `mai_shared {id:"abc12345", part:${n}}`);
      expect(page.text.length).toBeLessThanOrEqual(READ_CHAR_BUDGET);
      const parsed = parseBudgetPage(page.text);
      expect(parsed?.kind).toBe('share');
      expect(parsed?.body).toBe(page.bodyPart);
      chunks.push(parsed?.body ?? '');
      if (part === page.totalParts) break;
    }
    expect(chunks.join('')).toBe(body);

    const first = budgetPage(pageBudget(), '[from product-a] Shared detail abc12345', body, 1, 'share', n => `mai_shared {id:"abc12345", part:${n}}`);
    expect(first.text).toContain('_Shared detail part 1/');
    expect(isAtomicSelectorPage('mai_shared', first.text)).toBe(true);
    expect(isAtomicSelectorPage('mai_plan', first.text)).toBe(false);      // wrong tool for a share frame
    expect(isAtomicSelectorPage('mai_findings', first.text)).toBe(false);  // wrong tool for a share frame
    expect(isAtomicSelectorPage('mai_search', first.text)).toBe(false);    // ordinary read

    // …and mai_shared must NOT be handed atomicity over the other two kinds.
    const synth = budgetPage(pageBudget(), '# pass 17', body, 1, 'synthesis', n => `call pass:"17:${n}"`);
    expect(isAtomicSelectorPage('mai_shared', synth.text)).toBe(false);
  });
  it('idea frames are atomic only for mai_ideas and retain the reserved nudge lane', () => {
    const body = 'I'.repeat(READ_CHAR_BUDGET * 2);
    const first = budgetPage(
      pageBudget(), 'idea 11111111-1111-4111-8111-111111111111', body, 1, 'idea',
      (part) => `call mai_ideas with idea_id:"11111111-1111-4111-8111-111111111111:${part}"`,
    );
    expect(parseBudgetPage(first.text)?.kind).toBe('idea');
    expect(isAtomicSelectorPage('mai_ideas', first.text)).toBe(true);
    expect(isAtomicSelectorPage('mai_findings', first.text)).toBe(false);
    const finalized = finalizeToolResult(
      'mai_ideas', { content: [{ type: 'text', text: first.text }] }, '[agent board: open handoff]',
    );
    expect(finalized.content[0].text).toContain('[agent board: open handoff]');
    expect(finalized.content[0].text?.length).toBeLessThanOrEqual(READ_CHAR_BUDGET);
    expect(parseBudgetPage(finalized.content[0].text ?? '')?.body).toBe(first.bodyPart);
  });
  it('partition is 29 reads plus 19 non-reads with no duplicate', () => {
    expect(MCP_READ_TOOLS).toHaveLength(29);
    expect(MCP_NON_READ_TOOLS).toHaveLength(19);
    expect(new Set([...MCP_READ_TOOLS, ...MCP_NON_READ_TOOLS]).size).toBe(48);
  });
});

describe('mai_plan — compact writes and bounded review parts', () => {
  beforeAll(async () => {
    const { planRegister, reviewPost } = await import('../plans.js');
    await admin.query(
      `DELETE FROM plans WHERE project_id = (SELECT id FROM projects WHERE slug='plan23-test')`);
    await planRegister({ path: planRel });
    await reviewPost({
      plan: planRel, kind: 'author', verdict: 'blocked', synthesis: SYNTHESIS_ONE,
      findings: [
        { severity: 'blocker', title: 'F1 title', location: 'src/a.ts:1',
          issue: 'F1 issue', evidence: 'F1 evidence', fix: 'F1 fix' },
        { severity: 'warning', title: 'F2 title', location: 'src/b.ts:2',
          issue: 'F2 issue', evidence: 'F2 evidence', fix: 'F2 fix' },
      ],
    });
    await reviewPost({
      plan: planRel, kind: 'blind', verdict: 'approved', synthesis: SYNTHESIS_TWO, findings: [],
    });
  });

  it('status write returns metadata and zero synthesis with either selector', async () => {
    const { planText } = await import('../plans.js');
    for (const extra of [{}, { passes: 'all' }, { pass: '2' }]) {
      const out = await planText({ path: planRel, status: 'reviewing', ...extra }, mcpBudget());
      expect(out).toContain('findings:');       // metadata and counts survive
      expect(out).toContain('[reviewing]');     // the write landed
      expect(out).not.toContain(SYNTHESIS_ONE); // R5: no synthesis on a write
      expect(out).not.toContain('SYNTHESIS_TWO:');
      expect(out.length).toBeLessThanOrEqual(READ_CHAR_BUDGET);
    }
  });

  it('plain fetch defaults latest and is <= READ_CHAR_BUDGET', async () => {
    const { planText } = await import('../plans.js');
    const out = await planText({ path: planRel }, mcpBudget());
    expect(out.length).toBeLessThanOrEqual(READ_CHAR_BUDGET);
    expect(out).not.toContain(SYNTHESIS_ONE);   // latest only
    expect(out).toContain('pass:"2"');          // recovery pointer names the selected pass
  });

  it('passes all is bounded and points to pass selector', async () => {
    const { planText } = await import('../plans.js');
    const out = await planText({ path: planRel, passes: 'all' }, mcpBudget());
    expect(out.length).toBeLessThanOrEqual(READ_CHAR_BUDGET);
    expect(out).toContain('pass:"');            // not an unbounded dump
  });

  it('builds a plan candidate from the same registration and preserves the summary', async () => {
    const plans = await import('../plans.js');
    const pool = (await import('../db.js')).getPool();
    const query = vi.spyOn(pool, 'query');
    const baseline = await plans.planText({ path: planRel, passes: 'all' }, mcpBudget());
    const baselineQueries = query.mock.calls.length;
    query.mockClear();
    let draft: import('../token-mai-shadow.js').MaiShadowDraft | undefined;
    const again = await plans.planText({ path: planRel, passes: 'all' }, mcpBudget(), (value) => { draft = value; });
    expect(query.mock.calls.length).toBe(baselineQueries);
    query.mockRestore();
    expect(again).toBe(baseline);
    expect(draft?.kind).toBe('candidate');
    if (draft?.kind === 'candidate') {
      expect(draft.text).toContain('pass 1 [blocked]');
      expect(draft.text).toContain('pass 2 [approved]');
      expect(draft.text).toContain('pass:"1"');
      expect(draft.text).toContain('pass:"2"');
      expect(draft.text).toContain('  findings:');
    }
    let latestDraft: import('../token-mai-shadow.js').MaiShadowDraft | undefined;
    await plans.planText({ path: planRel }, mcpBudget(), (value) => { latestDraft = value; });
    expect(latestDraft?.kind).toBe('candidate');
    if (latestDraft?.kind === 'candidate') {
      expect(latestDraft.text).toContain('1 earlier pass(es)');
      expect(latestDraft.text).toContain('pass:"N"');
      expect(latestDraft.text).toContain('passes:"all"');
    }
    let excluded: import('../token-mai-shadow.js').MaiShadowDraft | undefined;
    await plans.planText({ path: planRel, status: 'reviewing' }, mcpBudget(), (value) => { excluded = value; });
    expect(excluded).toBeUndefined();
    await plans.planText({ path: planRel, pass: '2' }, mcpBudget(), (value) => { excluded = value; });
    expect(excluded).toBeUndefined();
  });

  it('records a read-only plan wire candidate and leaves write and pass pages atomic', async () => {
    const log = path.join(shadowRoot, 'mai-read.jsonl');
    const before = fs.existsSync(log) ? fs.readFileSync(log, 'utf8').trim().split('\n').length : 0;
    await withRealServer('PLAN_SHADOW_NUDGE', async (_call, callRaw) => {
      const summary = await callRaw('mai_plan', { path: planRel, passes: 'all' });
      const summaryJson = JSON.stringify(summary);
      expect(summaryJson).toContain('PLAN_SHADOW_NUDGE');
      expect(summaryJson).toContain('pass 2');
      const rows = fs.readFileSync(log, 'utf8').trim().split('\n');
      expect(rows).toHaveLength(before + 1);
      const measured = JSON.parse(rows[rows.length - 1]);
      expect(measured).toMatchObject({ tool: 'mai_plan', kind: 'candidate' });
      expect(measured.baselineChars).toBe(summary.content[0] && 'text' in summary.content[0]
        ? summary.content[0].text?.length : -1);
      expect(measured.candidateChars).toBeLessThan(measured.baselineChars);
      const page = await callRaw('mai_plan', { path: planRel, pass: '2' });
      expect(JSON.stringify(page)).toContain('-- synthesis-body chars=');
      const write = await callRaw('mai_plan', { path: planRel, status: 'reviewing' });
      expect(JSON.stringify(write)).toContain('[reviewing]');
      expect(fs.readFileSync(log, 'utf8').trim().split('\n')).toHaveLength(before + 1);
    });
  });

  it('pass parts reconstruct pass 2 synthesis byte-for-byte', async () => {
    const { planText } = await import('../plans.js');
    const parts: string[] = [];
    for (let part = 1; part <= 32; part++) {
      const selector = part === 1 ? '2' : `2:${part}`;
      const text = await planText({ path: planRel, pass: selector }, mcpBudget());
      expect(text.length).toBeLessThanOrEqual(READ_CHAR_BUDGET);
      parts.push(text);
      // Anchored: the body deliberately CONTAINS a fake `…; complete._` line,
      // and an unanchored probe would stop after part 1 on that decoy.
      if (/_Review synthesis part \d+\/\d+; complete\._$/.test(text)) break;
    }
    expect(parts.length).toBeGreaterThan(1);    // 14k body genuinely spans parts
    expect(reconstruct(parts, 'synthesis')).toBe(SYNTHESIS_TWO);
  });

  it('rejects selector+passes, malformed, zero and out-of-range parts', async () => {
    const { planText } = await import('../plans.js');
    await expect(planText({ path: planRel, pass: '2', passes: 'all' }, mcpBudget()))
      .rejects.toThrow(/exclusive/);
    await expect(planText({ path: planRel, pass: 'abc' }, mcpBudget()))
      .rejects.toThrow(/pass must be/);
    await expect(planText({ path: planRel, pass: '0' }, mcpBudget()))
      .rejects.toThrow(/pass must be/);
    await expect(planText({ path: planRel, pass: '2:0' }, mcpBudget()))
      .rejects.toThrow(/pass must be/);
    await expect(planText({ path: planRel, pass: '2:99' }, mcpBudget()))
      .rejects.toThrow(/exceeds/);
    await expect(planText({ path: planRel, pass: '9' }, mcpBudget()))
      .rejects.toThrow(/no review pass 9/);
  });
});

describe('mai_findings — headline mode and bounded single-finding retrieval', () => {
  const oneHot = (i: number): number[] => { const v = new Array(384).fill(0); v[i] = 1; return v; };

  /** Reset to a bare registered plan; findings cascade with the plan row. */
  async function freshPlan(): Promise<void> {
    const { planRegister } = await import('../plans.js');
    await admin.query(
      `DELETE FROM plans WHERE project_id = (SELECT id FROM projects WHERE slug='plan23-test')`);
    process.env.MAI_EMBEDDINGS = '1';
    const { setLocalEmbedderForTests } = await import('../embeddings.js');
    setLocalEmbedderForTests(async () => oneHot(7));
    await planRegister({ path: planRel });
  }

  const body = (n: string) => ({ issue: `${n} issue`, evidence: `${n} evidence`, fix: `${n} fix` });

  it('exactly threshold returns issue/evidence/fix', async () => {
    const { reviewPost, findingsQuery } = await import('../plans.js');
    await freshPlan();
    await reviewPost({
      plan: planRel, kind: 'author', verdict: 'blocked', synthesis: 's',
      findings: [1, 2, 3].map((i) => ({
        severity: 'blocker' as const, title: `PLAN23 threshold ${i}`,
        location: `src/t${i}.ts:${i}`, ...body(`T${i}`),
      })),
    });
    const out = await findingsQuery({ plan: planRel, budget: mcpBudget() });
    expect(out).toContain('issue: T1 issue');
    expect(out).toContain('evidence: T2 evidence');
    expect(out).toContain('fix: T3 fix');
  });

  /** 2 semantic + 2 stale: one GLOBAL row decision across both buckets. */
  async function hybridFour(): Promise<string> {
    const { reviewPost } = await import('../plans.js');
    const { setLocalEmbedderForTests } = await import('../embeddings.js');
    await freshPlan();
    const r = await reviewPost({
      plan: planRel, kind: 'author', verdict: 'blocked', synthesis: 's',
      findings: ['alpha', 'beta', 'gamma', 'delta'].map((n, i) => ({
        severity: i === 0 ? ('blocker' as const) : ('warning' as const),
        title: `PLAN23 headline mode ${n}`, location: `src/${n}.ts:${i + 1}`, ...body(n.toUpperCase()),
      })),
    });
    // The last two become the STALE bucket; the first two stay current-model.
    await admin.query(
      `UPDATE plan_findings SET embedding_model = 'old:model' WHERE id = ANY($1::uuid[])`,
      [[r.findings[2].id, r.findings[3].id]]);
    setLocalEmbedderForTests(async () => oneHot(7)); // aligns with the two current rows
    return 'PLAN23 headline mode';
  }

  it('threshold+1 returns every title/location and no body', async () => {
    const { findingsQuery } = await import('../plans.js');
    const query = await hybridFour();
    const out = await findingsQuery({ similar_to: query, limit: 5, budget: mcpBudget() });
    for (const n of ['alpha', 'beta', 'gamma', 'delta']) {
      expect(out).toContain(`PLAN23 headline mode ${n}`);
      expect(out).toContain(`src/${n}.ts:`);
    }
    expect(out).not.toContain('issue: ALPHA issue');
    expect(out).not.toContain('evidence:');
    expect(out).not.toContain('fix: DELTA fix');
    expect(out.length).toBeLessThanOrEqual(READ_CHAR_BUDGET);
  });

  it('uses two verbose rows for a real shorter candidate and four for an equal-size skip', async () => {
    const { findingsQuery, reviewPost } = await import('../plans.js');
    await freshPlan();
    await reviewPost({ plan: planRel, kind: 'author', verdict: 'blocked', synthesis: 's',
      findings: [1, 2].map((i) => ({ severity: 'blocker', title: `SHADOW_VERBOSE_${i}`,
        location: `src/shadow-${i}.ts:1`, issue: 'I'.repeat(650), evidence: 'E'.repeat(650),
        fix: 'F'.repeat(250) })) });
    const pool = (await import('../db.js')).getPool();
    const query = vi.spyOn(pool, 'query');
    const baseline = await findingsQuery({ plan: planRel, budget: mcpBudget() });
    const baselineQueries = query.mock.calls.length;
    query.mockClear();
    let draft: import('../token-mai-shadow.js').MaiShadowDraft | undefined;
    const again = await findingsQuery({ plan: planRel, budget: mcpBudget(), shadow: (value) => { draft = value; } });
    expect(query.mock.calls.length).toBe(baselineQueries);
    query.mockRestore();
    expect(again).toBe(baseline);
    expect(again.length).toBeLessThan(READ_CHAR_BUDGET);
    expect(draft?.kind).toBe('candidate');
    if (draft?.kind === 'candidate') {
      expect(draft.text.length).toBeLessThan(3000);
      expect(draft.text.length).toBeLessThan(again.length);
      expect(draft.text).toContain('SHADOW_VERBOSE_1');
      expect(draft.text).toContain('SHADOW_VERBOSE_2');
      expect(draft.text).toContain('finding:"UUID[:part]"');
    }
    const log = path.join(shadowRoot, 'mai-read.jsonl');
    const before = fs.existsSync(log) ? fs.readFileSync(log, 'utf8').trim().split('\n').length : 0;
    const nudge = 'SHADOW_NUDGE';
    await withRealServer(nudge, async (_call, callRaw) => {
      const delivered = await callRaw('mai_findings', { plan: planRel });
      expect(delivered.content).toHaveLength(1);
      const text = delivered.content[0];
      expect('text' in text && text.text).toContain(nudge);
      expect(JSON.stringify(delivered)).toContain('SHADOW_VERBOSE_1');
      const unsafe = path.join(root, 'shadow-not-directory');
      fs.writeFileSync(unsafe, 'file');
      process.env.MAI_TOKEN_RECEIPTS_DIR = unsafe;
      try {
        const failedStorage = await callRaw('mai_findings', { plan: planRel });
        expect(JSON.stringify(failedStorage)).toBe(JSON.stringify(delivered));
      } finally { process.env.MAI_TOKEN_RECEIPTS_DIR = shadowRoot; }
    });
    const rows = fs.readFileSync(log, 'utf8').trim().split('\n');
    expect(rows).toHaveLength(before + 1);
    const measured = JSON.parse(rows[rows.length - 1]);
    expect(measured).toMatchObject({ tool: 'mai_findings', kind: 'candidate', candidateChars: expect.any(Number) });
    expect(measured.baselineChars).toBe(baseline.length + 2 + nudge.length);
    expect(measured.candidateChars).toBe(draft?.kind === 'candidate' ? draft.text.length + 2 + nudge.length : -1);

    const fourQuery = await hybridFour();
    let fourDraft: import('../token-mai-shadow.js').MaiShadowDraft | undefined;
    const four = await findingsQuery({ similar_to: fourQuery, limit: 5, budget: mcpBudget(),
      shadow: (value) => { fourDraft = value; } });
    expect(four).toContain('4/4 finding headlines shown');
    expect(fourDraft).toEqual({ kind: 'skip', reason: 'not-shorter' });
    for (const name of ['alpha', 'beta', 'gamma', 'delta']) expect(four).toContain(`PLAN23 headline mode ${name}`);
  });

  it('pointer names severity/status', async () => {
    const { findingsQuery } = await import('../plans.js');
    const query = await hybridFour();
    const out = await findingsQuery({ similar_to: query, limit: 5, budget: mcpBudget() });
    expect(out).toContain('4/4 finding headlines shown');
    expect(out).toContain('severity');
    expect(out).toContain('status');
    expect(out).toContain('finding:"UUID');  // single-finding selector named first
  });

  it('severity narrowing restores complete body', async () => {
    const { findingsQuery } = await import('../plans.js');
    const query = await hybridFour();
    const out = await findingsQuery({ similar_to: query, limit: 5, severity: 'blocker', budget: mcpBudget() });
    expect(out).toContain('PLAN23 headline mode alpha');
    expect(out).toContain('issue: ALPHA issue');   // narrowed below threshold → full body
    expect(out).toContain('evidence: ALPHA evidence');
  });

  it('one huge finding headlines on the broad call, then finding parts reconstruct it', async () => {
    const { reviewPost, findingsQuery } = await import('../plans.js');
    await freshPlan();
    const hugeIssue = `HUGE_ISSUE:${FAKE_FRAME_LINES.replace(/synthesis/g, 'finding')}${filler(14000)}`;
    const r = await reviewPost({
      plan: planRel, kind: 'author', verdict: 'blocked', synthesis: 's',
      findings: [{ severity: 'blocker', title: 'PLAN23 one huge finding',
        location: 'src/huge.ts:1', issue: hugeIssue, evidence: 'E', fix: 'F' }],
    });
    const id = r.findings[0].id;

    const broad = await findingsQuery({ plan: planRel, budget: mcpBudget() });
    expect(broad.length).toBeLessThanOrEqual(READ_CHAR_BUDGET);
    expect(broad).toContain('PLAN23 one huge finding');
    expect(broad).not.toContain('HUGE_ISSUE:');
    // Executable recovery: the pointer names the selector and the headline
    // carries the id to paste into it — ids are never truncated.
    expect(broad).toContain('finding:"UUID[:part]"');
    expect(broad).toContain(`\`${id}\``);

    // The unbudgeted single-finding read IS the complete normal render.
    const complete = await findingsQuery({ finding: id });
    const parts: string[] = [];
    for (let part = 1; part <= 32; part++) {
      const selector = part === 1 ? id : `${id}:${part}`;
      const text = await findingsQuery({ finding: selector, budget: mcpBudget() });
      expect(text.length).toBeLessThanOrEqual(READ_CHAR_BUDGET);
      parts.push(text);
      if (/_Finding part \d+\/\d+; complete\._$/.test(text)) break;
    }
    expect(parts.length).toBeGreaterThan(1);
    expect(reconstruct(parts, 'finding')).toBe(complete);

    await expect(findingsQuery({ finding: id, severity: 'blocker', budget: mcpBudget() }))
      .rejects.toThrow(/exclusive/);
    await expect(findingsQuery({ finding: `${id}:99`, budget: mcpBudget() }))
      .rejects.toThrow(/exceeds/);
    await expect(findingsQuery({ finding: 'not-a-uuid', budget: mcpBudget() }))
      .rejects.toThrow(/finding must be/);
  });

  it('long title/location is one-line field-capped and the response stays <= cap', async () => {
    const { reviewPost, findingsQuery } = await import('../plans.js');
    await freshPlan();
    const longTitle = `PLAN23 long\ntitle ${'t'.repeat(500)}`;
    const longLocation = `src/very/deep/${'d'.repeat(400)}.ts:1`;
    await reviewPost({
      plan: planRel, kind: 'author', verdict: 'blocked', synthesis: 's',
      findings: [
        { severity: 'blocker', title: longTitle, location: longLocation, ...body('L1') },
        ...[2, 3, 4].map((i) => ({
          severity: 'warning' as const, title: `PLAN23 long neighbour ${i}`,
          location: `src/n${i}.ts:${i}`, ...body(`L${i}`),
        })),
      ],
    });
    const out = await findingsQuery({ plan: planRel, budget: mcpBudget() });
    expect(out.length).toBeLessThanOrEqual(READ_CHAR_BUDGET);
    expect(out).toContain(headlineField(longTitle));          // one line, 240-capped
    expect(out).toContain(headlineField(longLocation, 320));  // 320-capped
    expect(out).not.toContain('PLAN23 long\ntitle');          // never a raw newline
    expect(out).not.toContain('t'.repeat(500));               // never the raw field
  });
});

describe('long-body renderers — broad shortens, narrow restores', () => {
  const oneHot = (i: number): number[] => { const v = new Array(384).fill(0); v[i] = 1; return v; };

  async function projectId(): Promise<string> {
    const r = await admin.query<{ id: string }>(
      `SELECT id FROM projects WHERE slug='plan23-test'`);
    return r.rows[0].id;
  }
  async function wipe(): Promise<void> {
    const pid = await projectId();
    for (const t of ['code_decisions', 'lessons', 'doc_chunks', 'write_violations',
                     'agent_messages', 'code_sessions', 'code_commits']) {
      await admin.query(`DELETE FROM ${t} WHERE project_id = $1`, [pid]);
    }
    process.env.MAI_EMBEDDINGS = '1';
    const { setLocalEmbedderForTests } = await import('../embeddings.js');
    setLocalEmbedderForTests(async () => oneHot(7));
  }
  async function seedDecision(d: {
    description: string; reasoning: string; keywords?: string[]; embedded?: boolean;
  }): Promise<string> {
    const pid = await projectId();
    const r = await admin.query<{ id: string }>(
      `INSERT INTO code_decisions
         (project_id, decision_type, description, reasoning, keywords, tags, source,
          confidence, still_valid, embedding, embedding_model)
       VALUES ($1,'architecture',$2,$3,$4,'{}','user-approved',0.9,true,$5,$6)
       RETURNING id`,
      [pid, d.description, d.reasoning, d.keywords ?? ['plan23kw'],
       d.embedded === false ? null : oneHot(7),
       d.embedded === false ? null : 'local:bge-small-en-v1.5']);
    return r.rows[0].id;
  }
  async function seedLesson(rule: string, embedded = true): Promise<string> {
    const pid = await projectId();
    const r = await admin.query<{ id: string }>(
      `INSERT INTO lessons (project_id, rule, confidence_score,
                            reinforcement_count, tags, embedding, embedding_model)
       VALUES ($1,$2,0.9,1,'{}',$3,$4) RETURNING id`,
      [pid, rule, embedded ? oneHot(7) : null,
       embedded ? 'local:bge-small-en-v1.5' : null]);
    return r.rows[0].id;
  }
  let docChunkIndex = 0;
  async function seedDocChunk(heading: string, content: string): Promise<void> {
    const pid = await projectId();
    const idx = docChunkIndex++;
    await admin.query(
      `INSERT INTO doc_chunks (project_id, repo_root, path, kind, doc_sha, chunk_index,
                               start_line, end_line, heading_trail, content, content_hash)
       VALUES ($1,$2,'docs/superpowers/plans/2026-08-12-plan23-doc.md','plan','abc',$5,
               $6,$7,$3,$4,$8)`,
      [pid, root, heading, content, idx, idx * 10 + 1, idx * 10 + 10, `hash23-${idx}`]);
  }

  // ---------- search (3) ----------
  it('search: mixed decisions+lesson+doc pointer share ONE global row decision', async () => {
    const { unifiedSearch } = await import('../decisions.js');
    const { docChunksSection, docChunksReadSection } = await import('../doc-chunks.js');
    await wipe();
    const d1 = await seedDecision({ description: 'PLAN23 alpha search decision', reasoning: 'ALPHA_WHY reason text' });
    const d2 = await seedDecision({ description: 'PLAN23 beta search decision', reasoning: 'BETA_WHY reason text' });
    await seedLesson('PLAN23 gamma search lesson');
    await seedDocChunk('Plan23 > Doc', 'PLAN23 doc pointer content');
    const pid = await projectId();

    const out = await unifiedSearch({ query: 'PLAN23', kind: 'all', budget: mcpBudget() });
    expect(out.length).toBeLessThanOrEqual(READ_CHAR_BUDGET);
    expect(out).toContain(d1);                       // ids never truncated
    expect(out).toContain(d2);
    expect(out).toContain('PLAN23 alpha search decision');
    expect(out).toContain('PLAN23 gamma search lesson');
    expect(out).toContain('plan23-doc.md');          // the complete pointer row
    expect(out).not.toContain('ALPHA_WHY');          // why removed
    expect(out).not.toContain('keywords: plan23kw'); // keywords removed
    expect(out).toContain('4/4 result headlines shown'); // ONE global count

    // Direct wrapper/structured parity on the SAME fixture.
    const wrapper = await docChunksSection('PLAN23', pid);
    const structured = await docChunksReadSection('PLAN23', pid);
    expect(structured).not.toBeNull();
    expect(wrapper).toBe(`${structured?.heading}\n${structured?.fullRows.join('\n')}`);

    // A SECOND pointer must add a SECOND row: collapsing the doc pointers into
    // one joined row would keep 4/4 here and the count would stop discriminating.
    await seedDocChunk('Plan23 > Doc Two', 'PLAN23 second doc pointer content');
    const twoDocs = await unifiedSearch({ query: 'PLAN23', kind: 'all', budget: mcpBudget() });
    expect(twoDocs).toContain('5/5 result headlines shown');

    // Over-6000 mixed result: the single global pointer still counts every row.
    await seedDecision({ description: `PLAN23 huge ${'h'.repeat(7000)}`, reasoning: 'HUGE_WHY' });
    const big = await unifiedSearch({ query: 'PLAN23', kind: 'all', budget: mcpBudget() });
    expect(big.length).toBeLessThanOrEqual(READ_CHAR_BUDGET);
    expect(big).toMatch(/\d+\/6 result headlines shown/);
  });

  it('search: one individually huge reason headlines and points to the mai search CLI', async () => {
    const { unifiedSearch } = await import('../decisions.js');
    await wipe();
    await seedDecision({ description: 'PLAN23 huge-reason decision', reasoning: `HUGE_REASON:${filler(9000)}` });
    await seedDecision({ description: 'PLAN23 second decision', reasoning: 'small why' });
    await seedDecision({ description: 'PLAN23 third decision', reasoning: 'small why' });
    await seedDecision({ description: 'PLAN23 fourth decision', reasoning: 'small why' });
    const out = await unifiedSearch({ query: 'PLAN23', kind: 'decisions', budget: mcpBudget() });
    expect(out.length).toBeLessThanOrEqual(READ_CHAR_BUDGET);
    expect(out).toContain('PLAN23 huge-reason decision');
    expect(out).not.toContain('HUGE_REASON:');
    expect(out).toContain('mai search');
  });

  it('search: a narrowed limit=1 result restores its complete body', async () => {
    const { unifiedSearch } = await import('../decisions.js');
    await wipe();
    await seedDecision({ description: 'PLAN23 narrow decision', reasoning: 'NARROW_WHY kept in full' });
    const out = await unifiedSearch({ query: 'PLAN23', kind: 'decisions', limit: 1, budget: mcpBudget() });
    expect(out).toContain('NARROW_WHY kept in full');
  });

  // ---------- recall (2) ----------
  async function seedRecall(): Promise<void> {
    const pid = await projectId();
    for (let i = 1; i <= 3; i++) {
      await admin.query(
        `INSERT INTO code_sessions (project_id, summary, commits, duration_minutes, started_at)
         VALUES ($1,$2,1,10,now())`, [pid, `PLAN23 session ${i}`]);
      await admin.query(
        `INSERT INTO code_commits (project_id, commit_hash, message, commit_type, author, timestamp)
         VALUES ($1,$2,$3,'feat','tester',now())`,
        [pid, `abc${i}0000000000000000000000000000000000${i}`, `PLAN23 commit ${i}`]);
      await seedDecision({ description: `PLAN23 recall decision ${i}`, reasoning: `RECALL_WHY ${i}` });
    }
  }

  it('recall: broad removes Why but keeps session/decision/commit headlines', async () => {
    const { projectRecall } = await import('../decisions.js');
    await wipe(); await seedRecall();
    const out = await projectRecall(await projectId(), mcpBudget());
    expect(out.length).toBeLessThanOrEqual(READ_CHAR_BUDGET);
    expect(out).toContain('PLAN23 session 1');
    expect(out).toContain('PLAN23 recall decision 2');
    expect(out).toContain('PLAN23 commit 3');
    expect(out).not.toContain('RECALL_WHY');
    expect(out).toContain('mai recall --project');
  });

  it('recall: absent budget equals the current complete string', async () => {
    const { projectRecall } = await import('../decisions.js');
    await wipe(); await seedRecall();
    const out = await projectRecall(await projectId());
    expect(out).toContain('RECALL_WHY 1');       // complete bodies retained
    expect(out).toContain('=== END Brain ===');
    expect(out).not.toContain('headlines shown');
  });

  // ---------- report (2) ----------
  it('report: broad removes reason/keyword details and points to the mai report CLI', async () => {
    const { dailyReport } = await import('../decisions.js');
    await wipe();
    for (let i = 1; i <= 4; i++) {
      await seedDecision({
        description: `PLAN23 report decision ${i}`,
        reasoning: 'r', keywords: [`PLAN23KW${i}`, `${'k'.repeat(i === 1 ? 4000 : 5)}`],
      });
    }
    const out = await dailyReport(1, await projectId(), mcpBudget());
    expect(out.length).toBeLessThanOrEqual(READ_CHAR_BUDGET);
    expect(out).toContain('PLAN23 report decision 1');
    expect(out).not.toContain('keywords: PLAN23KW1');
    expect(out).toContain('mai report --days');
  });

  it('report: a small one-day report stays complete', async () => {
    const { dailyReport } = await import('../decisions.js');
    await wipe();
    await seedDecision({ description: 'PLAN23 lone report decision', reasoning: 'r', keywords: ['PLAN23SOLO'] });
    const out = await dailyReport(1, await projectId(), mcpBudget());
    expect(out).toContain('keywords: PLAN23SOLO');   // detail retained below threshold
    expect(out).not.toContain('headlines shown');
  });

  // ---------- get_context (2) ----------
  async function writeTopic(name: string, body: string): Promise<void> {
    const dir = path.join(root, 'docs', 'context', 'plan23-test');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, `${name}.md`), body);
    process.env.MAI_BRAIN_ROOT = root;
  }

  it('get_context: an oversized body returns H1 + first paragraph + pointer', async () => {
    const { getContext } = await import('../topics.js');
    await writeTopic('plan23big',
      `# Plan23 Big Topic\n\nFIRST_PARAGRAPH stays.\n\n## Detail\nBODY_TAIL ${filler(9000)}\n`);
    const out = await getContext('plan23big', mcpBudget());
    expect(out.length).toBeLessThanOrEqual(READ_CHAR_BUDGET);
    expect(out).toContain('# Plan23 Big Topic');
    expect(out).toContain('FIRST_PARAGRAPH stays.');
    expect(out).not.toContain('BODY_TAIL');
    expect(out).toContain('mai context');
  });

  it('get_context: a small body is byte-identical', async () => {
    const { getContext } = await import('../topics.js');
    await writeTopic('plan23small', `# Plan23 Small\n\nAll of it.\n`);
    const budgeted = await getContext('plan23small', mcpBudget());
    const plain = await getContext('plan23small');
    expect(budgeted).toBe(plain);
    expect(budgeted).toBe('# Plan23 Small\n\nAll of it.');
  });

  // ---------- violations (2) ----------
  async function seedViolations(): Promise<void> {
    const pid = await projectId();
    for (let i = 1; i <= 4; i++) {
      await admin.query(
        `INSERT INTO write_violations
           (project_id, tool_name, violation_kind, attempted_payload, preview_results,
            followup_succeeded, rejected_at)
         VALUES ($1,$2,$3,$4,null,$5,now())`,
        [pid, `mai_tool_${i}`, i % 2 === 0 ? 'no-read-token' : 'missing-citation',
         `PAYLOAD_${i}:${'p'.repeat(i === 1 ? 4000 : 20)}`, i % 2 === 0]);
    }
  }

  it('violations: broad keeps time/tool/kind/recovery but drops payload/preview', async () => {
    const { violationsRecent } = await import('../write-violations.js');
    await wipe(); await seedViolations();
    const out = await violationsRecent({ projectId: await projectId(), budget: mcpBudget() });
    expect(out.length).toBeLessThanOrEqual(READ_CHAR_BUDGET);
    expect(out).toContain('mai_tool_1');
    expect(out).toContain('missing-citation');
    expect(out).not.toContain('PAYLOAD_1:');
    expect(out).toContain('mai violations');
  });

  it('violations: a normal filtered result restores the body', async () => {
    const { violationsRecent } = await import('../write-violations.js');
    await wipe(); await seedViolations();
    const out = await violationsRecent({
      projectId: await projectId(), toolName: 'mai_tool_2', budget: mcpBudget() });
    expect(out).toContain('PAYLOAD_2:');
  });

  // ---------- board (2) ----------
  it('board: broad keeps type/author/first 160 sanitized chars/id', async () => {
    const { boardPost, boardRead } = await import('../coordination/board.js');
    await wipe();
    const rootMsg = await boardPost({ type: 'note', body: `ROOT_BODY ${'r'.repeat(900)}` });
    const rootId = /([0-9a-f-]{36})/.exec(rootMsg)?.[1] ?? '';
    for (let i = 1; i <= 4; i++) {
      await boardPost({ type: 'note', body: `PLAN23 board message ${i} ${'b'.repeat(400)}` });
    }
    const out = await boardRead({ budget: mcpBudget() });
    expect(out.length).toBeLessThanOrEqual(READ_CHAR_BUDGET);
    expect(out).toContain('[note/open]');
    expect(out).toContain(rootId);
    expect(out).not.toContain('r'.repeat(400));  // body cut to the 160-char case
    expect(out).toContain('thread_id');
  });

  it('board: question and handoff posts carry the watcher nudge; closing types do not', async () => {
    // The nudge rides the tool response because standing instructions read at
    // session start lose to habit at the moment of posting (operator request
    // 2026-08-25). Only reply-expecting types get it.
    const { boardPost } = await import('../coordination/board.js');
    await wipe();
    const q = await boardPost({ type: 'question', body: 'PLAN23 watcher-nudge q' });
    const h = await boardPost({ type: 'handoff', body: 'PLAN23 watcher-nudge h' });
    const n = await boardPost({ type: 'note', body: 'PLAN23 watcher-nudge n' });
    const qId = /([0-9a-f-]{36})/.exec(q)?.[1] ?? '';
    const a = await boardPost({ type: 'answer', body: 'PLAN23 watcher-nudge a', resolves: qId });
    expect(q).toContain('Arm a board watcher');
    expect(h).toContain('Arm a board watcher');
    expect(n).not.toContain('Arm a board watcher');
    expect(a).not.toContain('Arm a board watcher');
    // The nudge is a suffix: the pinned success prefix is unchanged.
    expect(n).toBe(`posted [note] ${/([0-9a-f-]{36})/.exec(n)?.[1]}`);
  });

  it('board: message id as thread_id restores the complete write-capped body', async () => {
    const { boardPost, boardRead } = await import('../coordination/board.js');
    await wipe();
    const posted = await boardPost({ type: 'note', body: 'PLAN23 ROOT_RECOVER body' });
    const rootId = /([0-9a-f-]{36})/.exec(posted)?.[1] ?? '';
    const child = await boardPost({ type: 'answer', body: 'PLAN23 CHILD_RECOVER body', thread_id: rootId });
    const childId = /([0-9a-f-]{36})/.exec(child)?.[1] ?? '';
    const byRoot = await boardRead({ thread_id: rootId, limit: 1, budget: mcpBudget() });
    expect(byRoot).toContain('ROOT_RECOVER');
    const byChild = await boardRead({ thread_id: childId, budget: mcpBudget() });
    expect(byChild).toContain('CHILD_RECOVER');
  });
});

/** Connect a real v2 Client to the REAL registered server over a linked pair.
 * The injected nudge makes the piggyback lane deterministic without a clock. */
async function withRealServer<T>(
  nudgeText: string, fn: (
    call: (name: string, args: Record<string, unknown>) => Promise<string>,
    callRaw: (name: string, args: Record<string, unknown>) => ReturnType<import('@modelcontextprotocol/client').Client['callTool']>,
  ) => Promise<T>,
): Promise<T> {
  const { vi } = await import('vitest');
  const savedSlug = process.env.MAI_PROJECT_SLUG;
  const savedDb = process.env.MAI_DB_URL;
  vi.resetModules();
  process.env.MAI_PROJECT_SLUG = 'plan23-test';
  process.env.MAI_DB_URL = requireDisposableTestDbUrl(); // the inherited disposable URL
  try {
    const { buildServer } = await import('../index.js');
    const { Client, InMemoryTransport } = await import('@modelcontextprotocol/client');
    const server = buildServer(async () => nudgeText);
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: 'plan23-wire', version: '0.0.0' });
    try {
      await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
      const call = async (name: string, args: Record<string, unknown>): Promise<string> => {
        const r = await client.callTool({ name, arguments: args });
        const blocks = Array.isArray(r.content) ? r.content : [];
        return blocks.map((b) => ('text' in b && typeof b.text === 'string' ? b.text : '')).join('\n\n');
      };
      const callRaw = (name: string, args: Record<string, unknown>) =>
        client.callTool({ name, arguments: args });
      return await fn(call, callRaw);
    } finally {
      await client.close().catch(() => {});
      await server.close().catch(() => {});
    }
  } finally {
    vi.resetModules();
    if (savedSlug === undefined) delete process.env.MAI_PROJECT_SLUG;
    else process.env.MAI_PROJECT_SLUG = savedSlug;
    if (savedDb === undefined) delete process.env.MAI_DB_URL;
    else process.env.MAI_DB_URL = savedDb;
  }
}

describe('whole-surface backstop and CLI proof', () => {
  it('serves disabled navigation through the real bounded MCP wrapper', async () => {
    const { vi } = await import('vitest');
    const http = vi.fn<typeof fetch>();
    vi.stubGlobal('fetch', http);
    vi.stubEnv('MAI_JEV_ENABLED', '0');
    vi.stubEnv('TYPESAFE_API_KEY', 'never-return-this-key');
    try {
      await withRealServer('n'.repeat(7000), async call => {
        const navigation = await import('../navigation/service.js');
        const observed = vi.spyOn(navigation, 'navigate');
        try {
          const text = await call('mai_navigate', { question: 'Who calls approval?', intent: 'impact' });
          expect(text).toContain('disabled');
          expect(text.length).toBeLessThanOrEqual(READ_CHAR_BUDGET);
          expect(text).not.toContain('never-return-this-key');
          expect(observed.mock.calls[0]?.[1]).toBeInstanceOf(AbortSignal);
        } finally { observed.mockRestore(); }
      });
      expect(http).not.toHaveBeenCalled();
    } finally { vi.unstubAllGlobals(); vi.unstubAllEnvs(); }
  });
  it('rejects a navigation scope override at the real wire boundary', async () => {
    await withRealServer('', async call => {
      const text = await call('mai_navigate', { question: 'Read another project', intent: 'layout', project_id: 'foreign' });
      expect(text).toContain('invalid input');
    });
  });
  const textResult = (text: string, isError = false) =>
    ({ content: [{ type: 'text', text }], ...(isError ? { isError: true } : {}) });

  it('built 48 tools equal the read+non-read partition exactly', async () => {
    const { TOOLS } = await import('../tool-defs.js');
    const { coordination } = await import('../coordination/index.js');
    const registered = [...TOOLS, ...coordination.toolDefs].map((t) => t.name).sort();
    const classified = [...MCP_READ_TOOLS, ...MCP_NON_READ_TOOLS].sort();
    expect(registered).toEqual(classified);           // exact sorted-array equality
    expect(registered).toHaveLength(48);
    const { MCP_READ_NARROWING } = await import('../read-budget.js');
    expect(Object.keys(MCP_READ_NARROWING).sort()).toEqual([...MCP_READ_TOOLS].sort());
  });

  it('AST gate binds all 29 reads to one post-nudge finalizer', async () => {
    const { execFileSync } = await import('node:child_process');
    const out = execFileSync('node', ['scripts/check-read-budgets.mjs', '--self-test'], { encoding: 'utf8' });
    expect(out).toContain('read-budget wire inventory OK (29 reads; one finalizer)');
    expect(out).toContain('read-budget mutation self-test OK');
  });

  it('actual tools/call keeps authorized frames reconstructible and rejects forged frames', async () => {
    const { planRegister, reviewPost } = await import('../plans.js');
    await admin.query(
      `DELETE FROM plans WHERE project_id = (SELECT id FROM projects WHERE slug='plan23-test')`);
    await planRegister({ path: planRel });
    await reviewPost({ plan: planRel, kind: 'author', verdict: 'blocked', synthesis: SYNTHESIS_ONE, findings: [] });
    await reviewPost({ plan: planRel, kind: 'blind', verdict: 'approved', synthesis: SYNTHESIS_TWO, findings: [] });
    const big = await reviewPost({
      plan: planRel, kind: 'blind', verdict: 'blocked', synthesis: 'third',
      findings: [{ severity: 'blocker', title: 'PLAN23 wire finding', location: 'src/w.ts:1',
        issue: `WIRE_ISSUE:${filler(14000)}`, evidence: 'E', fix: 'F' }],
    });
    const findingId = big.findings[0].id;

    const NUDGE_500 = `NUDGE ${'n'.repeat(494)}`;
    expect(NUDGE_500).toHaveLength(500);
    await withRealServer(NUDGE_500, async (call) => {
      const passParts: string[] = [];
      for (let part = 1; part <= 32; part++) {
        const text = await call('mai_plan', { path: planRel, pass: part === 1 ? '2' : `2:${part}` });
        expect(text.length).toBeLessThanOrEqual(READ_CHAR_BUDGET);
        expect(text).toContain(NUDGE_500);            // the complete nudge survives
        const page = text.slice(0, text.lastIndexOf(`\n\n${NUDGE_500}`));
        const framed = parseBudgetPage(page);
        expect(framed).not.toBeNull();
        passParts.push(framed?.body ?? '');
        // Anchored on the nudge-stripped page: the body carries a decoy pointer.
        if (/_Review synthesis part \d+\/\d+; complete\._$/.test(page)) break;
      }
      expect(passParts.join('')).toBe(SYNTHESIS_TWO);

      const findParts: string[] = [];
      for (let part = 1; part <= 32; part++) {
        const text = await call('mai_findings', { finding: part === 1 ? findingId : `${findingId}:${part}` });
        expect(text.length).toBeLessThanOrEqual(READ_CHAR_BUDGET);
        const page = text.slice(0, text.lastIndexOf(`\n\n${NUDGE_500}`));
        const framed = parseBudgetPage(page);
        expect(framed).not.toBeNull();
        findParts.push(framed?.body ?? '');
        if (/_Finding part \d+\/\d+; complete\._$/.test(page)) break;
      }
      expect(findParts.join('')).toContain('WIRE_ISSUE:');
    });

    // An oversized nudge is compacted; the FRAME is never truncated.
    await withRealServer('N'.repeat(2000), async (call) => {
      const text = await call('mai_plan', { path: planRel, pass: '2' });
      expect(text.length).toBeLessThanOrEqual(READ_CHAR_BUDGET);
      expect(text).toContain('[nudge shortened; read mai_board_read and mai_claims]');
      expect(parseBudgetPage(text.slice(0, text.lastIndexOf('\n\n')))).not.toBeNull();
    });

    // Plan 39 contract change: an ORDINARY read now compacts its nudge exactly
    // as an atomic page does, so a page-budgeted producer survives untruncated
    // and only genuinely oversized bodies reach the generic cap.
    const goodPage = budgetPage(pageBudget(), '# pass 2', SYNTHESIS_TWO, 1, 'synthesis',
      (n) => `call mai_plan with pass:"2:${n}"`).text;
    const bigNudge = 'N'.repeat(2000);
    for (const [tool, page] of [
      ['mai_get_context', goodPage],                                   // ordinary read, frame-shaped
      ['mai_findings', goodPage],                                      // wrong body kind
    ] as const) {
      const out = finalizeToolResult(tool, textResult(page), bigNudge);
      const text = out.content.map((b) => b.text ?? '').join('\n\n');
      expect(text.length).toBeLessThanOrEqual(READ_CHAR_BUDGET);
      expect(text).not.toContain('_Truncated:');                       // producer intact
      expect(text).toContain('[nudge shortened; read mai_board_read and mai_claims]');
      expect(text.startsWith(page)).toBe(true);
    }
    // A body ALREADY at the wire cap still truncates honestly.
    const overBudgetPage = budgetPage(mcpBudget(), '# pass 2', SYNTHESIS_TWO, 1, 'synthesis',
      (n) => `call mai_plan with pass:"2:${n}"`).text;
    const over = finalizeToolResult('mai_plan', textResult(overBudgetPage), bigNudge);
    const overText = over.content.map((b) => b.text ?? '').join('\n\n');
    expect(overText.length).toBeLessThanOrEqual(READ_CHAR_BUDGET);
    expect(overText).toContain('_Truncated:');

    // Exactly-6000 ordinary read + nudge still truncates honestly.
    const exact = finalizeToolResult('mai_search', textResult('x'.repeat(READ_CHAR_BUDGET)), 'NUDGE');
    const exactText = exact.content.map((b) => b.text ?? '').join('\n\n');
    expect(exactText.length).toBeLessThanOrEqual(READ_CHAR_BUDGET);
    expect(exactText).toContain('_Truncated:');
  });

  it('oversized thrown read error is capped but a write receipt is unchanged', () => {
    const err = finalizeToolResult('mai_search', textResult('E'.repeat(10_000), true));
    const errText = err.content.map((b) => b.text ?? '').join('\n\n');
    expect(errText.length).toBeLessThanOrEqual(READ_CHAR_BUDGET);
    expect(errText).toContain('retry mai_search with shorter valid parameters');

    const receipt = 'R'.repeat(10_000);
    const write = finalizeToolResult('mai_progress', textResult(receipt));
    expect(write.content[0].text).toBe(receipt);      // a write receipt is NEVER capped
  });

  it('built mai_prime dispatch is bounded on a large fixture project', async () => {
    const { unifiedSearch } = await import('../decisions.js');
    const pid = (await admin.query<{ id: string }>(
      `SELECT id FROM projects WHERE slug='plan23-test'`)).rows[0].id;
    for (let i = 0; i < 12; i++) {
      await admin.query(
        `INSERT INTO code_decisions (project_id, decision_type, description, reasoning,
           keywords, tags, source, confidence, still_valid)
         VALUES ($1,'architecture',$2,$3,'{primekw}','{}','user-approved',0.9,true)`,
        [pid, `PRIME23 decision ${i} ${'d'.repeat(300)}`, `PRIME23_WHY ${'w'.repeat(600)}`]);
    }
    // A long lesson rule is the EMBEDDING-INDEPENDENT discriminator: the full
    // row keeps it whole, the headline caps it via headlineField. The decision
    // `why:` lane only exists on the semantic path, so it cannot serve here.
    await admin.query(
      `INSERT INTO lessons (project_id, rule, confidence_score, reinforcement_count, tags)
       VALUES ($1,$2,0.9,1,'{}')`, [pid, `PRIME23 lesson ${'L'.repeat(400)}`]);
    // A lesson whose rule IS the 421-char query, so the raw section heading is
    // actually rendered — that heading is the byte-parity discriminator.
    await admin.query(
      `INSERT INTO lessons (project_id, rule, confidence_score, reinforcement_count, tags)
       VALUES ($1,$2,0.9,1,'{}')`, [pid, 'q'.repeat(421)]);
    // Loud coordination + a curation signal so every survival assertion below
    // has something real to lose (plan 38).
    await admin.query(
      `INSERT INTO agent_messages (project_id, author_agent, type, status, body)
       SELECT $1, 'sol@codex', 'note', 'open', 'PRIME23 loud board row ' || g || ' ' || repeat('b', 400)
         FROM generate_series(1, 60) g`, [pid]);
    await admin.query(
      `INSERT INTO agent_claims (project_id, repo_root, author_agent, author_session, paths, intent)
       SELECT $1, '/tmp/plan23-repo', 'sol@codex', 'other-session-' || g,
              jsonb_build_array('src/loud-' || g || '/**'),
              'PRIME23 loud claim intent ' || g || ' ' || repeat('i', 300)
         FROM generate_series(1, 8) g`, [pid]);
    await admin.query(
      `INSERT INTO curation_candidates (project_id, target_kind, target_id, basis, evidence,
         proposed_by, status)
       SELECT $1, 'decision', id, 'never-cited', 'plan38 fixture', 'tester@vitest', 'open'
         FROM code_decisions WHERE project_id = $1 LIMIT 1`, [pid]);

    // Negative control FIRST: without the dispatch budget this body is larger
    // than the wire cap, so losing it would force generic finalizer truncation.
    const { prime } = await import('../prime.js');
    const unbudgeted = await prime('PRIME23 bounded dispatch check', 'summary');
    expect(unbudgeted.length).toBeGreaterThan(READ_CHAR_BUDGET);

    await withRealServer('', async (call) => {
      const text = await call('mai_prime', { task_description: 'PRIME23 bounded dispatch check' });
      expect(text.length).toBeLessThanOrEqual(pageBudget().charBudget);
      expect(text.length).toBeLessThanOrEqual(READ_CHAR_BUDGET);
      expect(text).not.toContain('_Truncated:');
      const { UNTRUSTED_FRAME } = await import('../coordination/board.js');
      const frames = text.split(UNTRUSTED_FRAME).length - 1;
      expect(frames).toBe(4);                       // two per framed block, never severed
      expect(text.split('--- agent board: unreviewed').length - 1).toBe(frames);
      expect(text).toContain("# mai-prime — project 'plan23-test'");
      expect(text).toContain('_Curation:');
      expect(text).toContain('_Graph (code):');
      expect(text).toContain('_Graph (db schema):');
      expect(text).toContain('Structure questions (what calls what, schemas)');
      expect(text).toContain('Before closing this session');
    });
    // The component read is bounded too.
    const search = await unifiedSearch({ query: 'PRIME23', kind: 'all', projectId: pid, budget: mcpBudget() });
    expect(search.length).toBeLessThanOrEqual(READ_CHAR_BUDGET);
    expect(search).not.toContain('PRIME23_WHY');
  });

  it('built mai_git_show patch is bounded and names patch/path narrowing', async () => {
    await withRealServer('', async (call) => {
      const text = await call('mai_git_show', { hash: 'HEAD', patch: true });
      expect(text.length).toBeLessThanOrEqual(READ_CHAR_BUDGET);
      if (text.includes('_Truncated:')) {
        expect(text).toContain('set patch:false');
      }
    });
  });

  it('shared unbudgeted formatters retain body markers while budgeted omit them', async () => {
    const { unifiedSearch, projectRecall, dailyReport } = await import('../decisions.js');
    const { violationsRecent } = await import('../write-violations.js');
    const pid = (await admin.query<{ id: string }>(
      `SELECT id FROM projects WHERE slug='plan23-test'`)).rows[0].id;
    // Behavioral, not f(x)===f(x,undefined): the unbudgeted call must CONTAIN
    // the body marker the budgeted call omits.
    const LONG_RULE = `PRIME23 lesson ${'L'.repeat(400)}`;
    const plainSearch = await unifiedSearch({ query: 'PRIME23', kind: 'all', projectId: pid });
    expect(plainSearch).toContain(LONG_RULE);
    const budgetedSearch = await unifiedSearch({ query: 'PRIME23', kind: 'all', projectId: pid, budget: mcpBudget() });
    expect(budgetedSearch).not.toContain(LONG_RULE);

    expect(await projectRecall(pid)).toContain('PRIME23_WHY');
    expect(await projectRecall(pid, mcpBudget())).not.toContain('PRIME23_WHY');
    expect(await dailyReport(1, pid)).toContain('keywords: primekw');
    expect(await dailyReport(1, pid, mcpBudget())).not.toContain('keywords: primekw');
    expect(await violationsRecent({ projectId: pid })).toBeTruthy();

    // The 421-char raw heading survives byte-for-byte on the unbudgeted path.
    const longQuery = 'q'.repeat(421);
    const plainLong = await unifiedSearch({ query: longQuery, kind: 'lessons', projectId: pid });
    expect(plainLong).toContain(`# Lessons matching "${longQuery}"`);
  });

  it('actual CLI search/recall/review/timeline/report/context retain markers', async () => {
    const { execFileSync } = await import('node:child_process');
    const env = {
      ...process.env,
      MAI_PROJECT_SLUG: 'plan23-test',
      MAI_DB_URL: requireDisposableTestDbUrl(),
      MAI_BRAIN_ROOT: root,
      MAI_EMBEDDINGS: '0',
    };
    const cli = (args: string[]): string =>
      execFileSync('node', ['build/cli.js', ...args], { encoding: 'utf8', env });

    // The real CLI is UNBUDGETED: complete bodies survive on the wire.
    expect(cli(['search', 'PRIME23'])).toContain(`PRIME23 lesson ${'L'.repeat(400)}`);
    expect(cli(['recall', '--project', 'plan23-test'])).toContain('PRIME23_WHY');
    expect(cli(['report', '--days', '1', '--project', 'plan23-test'])).toContain('keywords: primekw');
    // The 421-char raw heading reaches the wire uncapped.
    const longQuery = 'q'.repeat(421);
    expect(cli(['search', longQuery, '--kind', 'lessons'])).toContain(`# Lessons matching "${longQuery}"`);
    for (const args of [['timeline'], ['review'], ['context', 'plan23small']]) {
      expect(() => cli(args)).not.toThrow();
    }
  });
});

describe('prepared search seam, prime fallbacks and literal MCP routes (plan 38)', () => {
  const MARK = 'PLAN38TOKEN';
  // The accounting fixture is searched by NOTHING else in this file, so its ids
  // enter the bucket sets for the first time inside the accounting test.
  const ACCT = 'ZQXACCTFIXTURE';
  let pid = '';
  let decisionId = '';
  let lessonId = '';
  let acctDecisionId = '';
  let acctLessonId = '';

  interface TokenState { reads: number; decisions: string[]; lessons: string[] }
  interface SurfacedState { decision: number; lesson: number }

  async function tokenState(): Promise<TokenState> {
    const rows = await admin.query<{ reads_count: number; result_set_ids: Record<string, string[]> }>(
      `SELECT reads_count, result_set_ids FROM write_session_tokens
        WHERE project_id = $1 AND session_pid = $2
        ORDER BY session_started_at DESC LIMIT 1`,
      [pid, process.pid],
    );
    const row = rows.rows[0];
    if (row === undefined) return { reads: 0, decisions: [], lessons: [] };
    return {
      reads: row.reads_count,
      decisions: row.result_set_ids.decisions ?? [],
      lessons: row.result_set_ids.lessons ?? [],
    };
  }

  async function surfacedState(): Promise<SurfacedState> {
    const d = await admin.query<{ surfaced_count: number }>(
      `SELECT surfaced_count FROM code_decisions WHERE id = $1`, [acctDecisionId]);
    const l = await admin.query<{ surfaced_count: number }>(
      `SELECT surfaced_count FROM lessons WHERE id = $1`, [acctLessonId]);
    return { decision: d.rows[0].surfaced_count, lesson: l.rows[0].surfaced_count };
  }

  beforeAll(async () => {
    pid = (await admin.query<{ id: string }>(
      `SELECT id FROM projects WHERE slug='plan23-test'`)).rows[0].id;
    decisionId = (await admin.query<{ id: string }>(
      `INSERT INTO code_decisions (project_id, decision_type, description, reasoning,
         keywords, tags, source, confidence, still_valid)
       VALUES ($1,'architecture',$2,'Plan 38 token accounting fixture.','{}','{}','user-approved',0.9,true)
       RETURNING id`, [pid, `${MARK} unique decision fixture`])).rows[0].id;
    lessonId = (await admin.query<{ id: string }>(
      `INSERT INTO lessons (project_id, rule, confidence_score, reinforcement_count, tags)
       VALUES ($1,$2,0.9,1,'{}') RETURNING id`, [pid, `${MARK} unique lesson fixture`])).rows[0].id;
    acctDecisionId = (await admin.query<{ id: string }>(
      `INSERT INTO code_decisions (project_id, decision_type, description, reasoning,
         keywords, tags, source, confidence, still_valid)
       VALUES ($1,'architecture',$2,'Plan 38 accounting fixture.','{}','{}','user-approved',0.9,true)
       RETURNING id`, [pid, `${ACCT} accounting decision`])).rows[0].id;
    acctLessonId = (await admin.query<{ id: string }>(
      `INSERT INTO lessons (project_id, rule, confidence_score, reinforcement_count, tags)
       VALUES ($1,$2,0.9,1,'{}') RETURNING id`, [pid, `${ACCT} accounting lesson`])).rows[0].id;
  });

  afterAll(async () => {
    await admin.query(`DELETE FROM code_decisions WHERE id = ANY($1::uuid[])`,
      [[decisionId, acctDecisionId]]);
    await admin.query(`DELETE FROM lessons WHERE id = ANY($1::uuid[])`, [[lessonId, acctLessonId]]);
  });

  it('renders identically to the public wrapper on both budget lanes', async () => {
    const { unifiedSearch, unifiedSearchSections } = await import('../decisions.js');
    const sections = await unifiedSearchSections({ query: MARK, kind: 'all', projectId: pid });
    const plain = await unifiedSearch({ query: MARK, kind: 'all', projectId: pid });
    const bounded = await unifiedSearch({ query: MARK, kind: 'all', projectId: pid, budget: mcpBudget() });
    expect(budgetSections(undefined, sections, 'result', MCP_READ_NARROWING.mai_search)).toBe(plain);
    expect(budgetSections(mcpBudget(), sections, 'result', MCP_READ_NARROWING.mai_search)).toBe(bounded);
  });

  it('records exactly one read per selected lane and none while rendering', async () => {
    const { unifiedSearch, unifiedSearchSections } = await import('../decisions.js');
    const before = await tokenState();
    const surfacedBefore = await surfacedState();
    expect(before.decisions).not.toContain(acctDecisionId);
    expect(before.lessons).not.toContain(acctLessonId);
    const sections = await unifiedSearchSections({ query: ACCT, kind: 'all', projectId: pid });
    const after = await tokenState();
    const surfacedAfter = await surfacedState();

    expect(after.reads).toBe(before.reads + 2);           // decisions + lessons
    expect(after.decisions.filter((id) => id === acctDecisionId)).toHaveLength(1);
    expect(after.lessons.filter((id) => id === acctLessonId)).toHaveLength(1);
    expect(surfacedAfter.decision).toBe(surfacedBefore.decision + 1);
    expect(surfacedAfter.lesson).toBe(surfacedBefore.lesson + 1);

    budgetSections(undefined, sections, 'result', MCP_READ_NARROWING.mai_search);
    budgetSections(mcpBudget(), sections, 'result', MCP_READ_NARROWING.mai_search);
    const afterRenders = await tokenState();
    const surfacedAfterRenders = await surfacedState();
    expect(afterRenders.reads).toBe(after.reads);
    expect(afterRenders.decisions).toEqual(after.decisions);
    expect(afterRenders.lessons).toEqual(after.lessons);
    expect(surfacedAfterRenders).toEqual(surfacedAfter);

    // One kind selects exactly one lane …
    const beforeDecisions = await tokenState();
    const surfacedBeforeDecisions = await surfacedState();
    await unifiedSearchSections({ query: ACCT, kind: 'decisions', projectId: pid });
    const afterDecisions = await tokenState();
    const surfacedAfterDecisions = await surfacedState();
    expect(afterDecisions.reads).toBe(beforeDecisions.reads + 1);
    expect(surfacedAfterDecisions.decision).toBe(surfacedBeforeDecisions.decision + 1);
    expect(surfacedAfterDecisions.lesson).toBe(surfacedBeforeDecisions.lesson);

    const beforeLessons = await tokenState();
    const surfacedBeforeLessons = await surfacedState();
    await unifiedSearchSections({ query: ACCT, kind: 'lessons', projectId: pid });
    const afterLessons = await tokenState();
    const surfacedAfterLessons = await surfacedState();
    expect(afterLessons.reads).toBe(beforeLessons.reads + 1);
    expect(surfacedAfterLessons.lesson).toBe(surfacedBeforeLessons.lesson + 1);
    expect(surfacedAfterLessons.decision).toBe(surfacedBeforeLessons.decision);

    // … and the public wrapper adds nothing beyond its one preparation call.
    const beforeWrapper = await tokenState();
    await unifiedSearch({ query: ACCT, kind: 'all', projectId: pid, budget: mcpBudget() });
    const afterWrapper = await tokenState();
    expect(afterWrapper.reads).toBe(beforeWrapper.reads + 2);
  });

  it('returns a truthful minimum instead of throwing across the sub-pointer interval', () => {
    const rows = ['r1', 'r2', 'r3', 'r4'];
    const complete = 'COMPLETE BODY '.repeat(40);
    const narrowing = MCP_READ_NARROWING.mai_get_context;
    const minimum = '_mai_get_context for the complete matched topics._';
    const pointer =
      `_0/4 topic headlines shown; complete render ${complete.length} chars. ` +
      `To read omitted headlines or bodies, ${narrowing}._`;
    const render = (charBudget: number, fallback?: string): string =>
      budgetRows({ fullRows: rows.length, charBudget }, rows, () => complete,
        (row) => row, '', 'topic', narrowing, fallback);

    // Without a fallback the generic helper still fails closed.
    expect(() => render(minimum.length)).toThrow('read-budget pointer exceeds cap');
    for (const budget of [minimum.length, minimum.length + 1, pointer.length - 1, pointer.length]) {
      const out = render(budget, minimum);
      expect(out.length).toBeLessThanOrEqual(budget);
      expect(out === minimum || out === pointer).toBe(true);
    }
    expect(render(pointer.length, minimum)).toBe(pointer);
    expect(render(pointer.length - 1, minimum)).toBe(minimum);

    // budgetSections threads the same fallback to the same decision point.
    const sections = [{ heading: '## Decisions\n', fullRows: [complete], headlineRows: [complete] }];
    expect(() => budgetSections({ fullRows: 3, charBudget: 20 }, sections, 'result', narrowing))
      .toThrow('read-budget pointer exceeds cap');
    expect(budgetSections({ fullRows: 3, charBudget: 20 }, sections, 'result', narrowing, '_min._'))
      .toBe('_min._');
    // A fallback that does not fit is never sliced: the failure is preserved.
    expect(() => budgetSections({ fullRows: 3, charBudget: 3 }, sections, 'result', narrowing, '_min._'))
      .toThrow('read-budget pointer exceeds cap');
  });

  it('pins the five task-prime recovery routes to their literal MCP tool names', () => {
    expect(MCP_READ_NARROWING.mai_search)
      .toBe('lower limit/use one kind, call mai_search, or run mai search in the CLI');
    expect(MCP_READ_NARROWING.mai_timeline)
      .toBe('lower days/limit, call mai_timeline, or run mai timeline in the CLI');
    expect(MCP_READ_NARROWING.mai_get_context)
      .toBe('call mai_get_context, or run MAI_PROJECT_SLUG=<slug> mai context <topic>');
    expect(MCP_READ_NARROWING.mai_graph_find)
      .toBe('narrow query/kind/limit, call mai_graph_find, or run mai graph find in the CLI');
    expect(MCP_READ_NARROWING.mai_shared)
      .toBe('call mai_shared with id:"<uuid-prefix>" and part:N for detail pages, or lower limit');
    for (const tool of ['mai_search', 'mai_timeline', 'mai_get_context', 'mai_graph_find', 'mai_shared'] as const) {
      expect(MCP_READ_NARROWING[tool]).toContain(tool);   // the literal underscored route
    }
  });
});

describe('wave-2 graph tools on the real wire (plan 39)', () => {
  const LOUD = 'WAVE2LOUD';
  let pid = '';

  beforeAll(async () => {
    pid = (await admin.query<{ id: string }>(
      `SELECT id FROM projects WHERE slug='plan23-test'`)).rows[0].id;
    // A loud graph: 60 nodes, 120+ edges, and 55 unreferenced php candidates.
    const hub = (await admin.query<{ id: string }>(
      `INSERT INTO graph_nodes (project_id, kind, name, qualified_name, file_path, line,
         extracted_by, extracted_at, commit_sha)
       VALUES ($1,'function',$2,$2,'/repo/loud/hub.ts',1,'ts',now(),'loudhead') RETURNING id`,
      [pid, `${LOUD}Hub`])).rows[0].id;
    for (let i = 0; i < 60; i++) {
      const target = (await admin.query<{ id: string }>(
        `INSERT INTO graph_nodes (project_id, kind, name, qualified_name, file_path, line,
           extracted_by, extracted_at, commit_sha)
         VALUES ($1,'function',$2,$2,$3,1,'ts',now(),'loudhead') RETURNING id`,
        [pid, `${LOUD}Target${String(i).padStart(2, '0')}${'x'.repeat(80)}`,
         `/repo/loud/target-${i}.ts`])).rows[0].id;
      for (const relation of ['calls', 'imports']) {
        await admin.query(
          `INSERT INTO graph_edges (project_id, from_node, to_node, relation, confidence)
           VALUES ($1,$2,$3,$4,'extracted') ON CONFLICT DO NOTHING`, [pid, hub, target, relation]);
      }
    }
    for (let i = 0; i < 55; i++) {
      await admin.query(
        `INSERT INTO graph_nodes (project_id, kind, name, qualified_name, file_path, line,
           extracted_by, extracted_at, commit_sha)
         VALUES ($1,'function',$2,$2,$3,7,'php',now(),'loudhead')`,
        [pid, `${LOUD}Dead${String(i).padStart(2, '0')}${'y'.repeat(80)}`,
         `/repo/loud/dead-${i}.php`]);
    }
  });

  it('refuses malformed payloads precisely and without touching the database', async () => {
    const { graphQuery, graphDeadCode } = await import('../graph/query.js');
    const { getPool } = await import('../db.js');
    const badQueries: unknown[] = [
      null, [], 'seed', 42,
      { seed: { query: 'x' }, sql: 'DROP TABLE graph_nodes' },
      { seed: { query: 'x', depth: 2 } },
      { seed: { query: 'x' }, steps: [{ direction: 'both', hops: 1 }] },
      { seed: { query: 'x' }, steps: [{ direction: 'sideways' }] },
      { seed: { query: 'x' }, steps: 'both' },
      { seed: { query: 'x' }, steps: [{ direction: 'both', relations: [7] }] },
      { seed: { query: 'x' }, limit: 2.5 },
      { seed: { query: 'x' }, limit: Number.POSITIVE_INFINITY },
      { seed: {} },
    ];
    const spy = vi.spyOn(getPool(), 'query');
    for (const bad of badQueries) {
      const out = await graphQuery(bad, pid);
      expect(out.startsWith('Invalid graph query: ')).toBe(true);
    }
    const badDeadCode: unknown[] = [null, [], 7, { kinds: ['endpoint'] }, { limit: 1.5 },
      { path_prefix: '' }, { kinds: [[]] }, { seed: {} }];
    for (const bad of badDeadCode) {
      const out = await graphDeadCode(bad, pid);
      expect(out.startsWith('Invalid dead-code request: ')).toBe(true);
    }
    const queries = spy.mock.calls.length;
    spy.mockRestore();
    expect(queries).toBe(0);          // rejection happens before any DB work

    // The same refusal reaches the wire through the real registered server.
    await withRealServer('', async (call) => {
      expect(await call('mai_graph_query', { seed: { query: 'x' }, steps: [{ direction: 'up' }] }))
        .toContain('steps[0].direction must be one of');
      expect(await call('mai_graph_dead_code', { kinds: ['endpoint'] }))
        .toContain('not a registered value');
    });
  });

  it('keeps caps, freshness, caveat, narrowing and the nudge inside the wire cap', async () => {
    const NUDGE_510 = `NUDGE510 ${'n'.repeat(501)}`;
    expect(NUDGE_510).toHaveLength(510);
    const NUDGE_511 = `${NUDGE_510}x`;
    const NUDGE_BIG = 'N'.repeat(2000);
    const COMBINED = `${'board '.repeat(300)}\n${'claims '.repeat(300)}`;

    await withRealServer(NUDGE_510, async (call) => {
      const text = await call('mai_graph_query', {
        seed: { query: LOUD }, steps: [{ direction: 'both' }], limit: 50 });
      expect(text.length).toBeLessThanOrEqual(READ_CHAR_BUDGET);
      expect(text).toContain(NUDGE_510);                         // byte-complete at 510
      expect(text).not.toContain('[nudge shortened');
      expect(text).toContain('_Edge cap: traversal examined 100 edges and stopped early._');
      expect(text).toContain('_Returned-node freshness:');
      expect(text).toContain('mai_graph_query');
    });

    for (const nudge of [NUDGE_511, NUDGE_BIG, COMBINED]) {
      await withRealServer(nudge, async (call) => {
        const text = await call('mai_graph_query', {
          seed: { query: LOUD }, steps: [{ direction: 'both' }], limit: 50 });
        expect(text.length).toBeLessThanOrEqual(READ_CHAR_BUDGET);
        expect(text).toContain('[nudge shortened; read mai_board_read and mai_claims]');
        expect(text).toContain('_Returned-node freshness:');
        expect(text).not.toContain('_Truncated:');

        const dead = await call('mai_graph_dead_code', { limit: 50 });
        expect(dead.length).toBeLessThanOrEqual(READ_CHAR_BUDGET);
        expect(dead).toContain('verify source/runtime behavior');
        expect(dead).toContain('mai_graph_dead_code');
        expect(dead).toContain('_Returned-node freshness:');
        expect(dead).not.toContain('_Truncated:');
        expect(dead).not.toContain('safe to delete');
      });
    }
  });

  it('classifies both new tools as reads with literal narrowing routes', async () => {
    expect(MCP_READ_TOOLS).toContain('mai_graph_query');
    expect(MCP_READ_TOOLS).toContain('mai_graph_dead_code');
    expect(MCP_READ_NARROWING.mai_graph_query).toContain('mai_graph_query');
    expect(MCP_READ_NARROWING.mai_graph_dead_code).toContain('mai_graph_dead_code');
    expect(MCP_READ_NARROWING.mai_graph_query).toContain('smaller steps/filters/limit');
    expect(MCP_READ_NARROWING.mai_graph_dead_code).toContain('kinds/path-prefix/limit');
  });
});

describe('machine-JSON wire boundary (conductor-machine-contract/2)', () => {
  /** Like withRealServer, but the REAL coordination piggyback rides the wire —
   * the machine-tool nudge suppression under test lives inside it (86b6b033),
   * so injecting a fake provider would bypass exactly the exemption these
   * tests must prove. The board-nudge watermark is reset to the epoch so a
   * pre-staged open handoff is genuinely pending for the whole call sequence. */
  async function withDefaultServer<T>(
    fn: (call: (name: string, args: Record<string, unknown>) => Promise<string>) => Promise<T>,
  ): Promise<T> {
    const savedSlug = process.env.MAI_PROJECT_SLUG;
    const savedDb = process.env.MAI_DB_URL;
    vi.resetModules();
    process.env.MAI_PROJECT_SLUG = 'plan23-test';
    process.env.MAI_DB_URL = requireDisposableTestDbUrl();
    try {
      const { buildServer } = await import('../index.js');
      const { _resetBoardNudgeState } = await import('../coordination/board.js');
      const { Client, InMemoryTransport } = await import('@modelcontextprotocol/client');
      _resetBoardNudgeState('1970-01-01T00:00:00.000Z');
      const server = buildServer();
      const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
      const client = new Client({ name: 'contract2-wire', version: '0.0.0' });
      try {
        await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
        const call = async (name: string, args: Record<string, unknown>): Promise<string> => {
          const r = await client.callTool({ name, arguments: args });
          const blocks = Array.isArray(r.content) ? r.content : [];
          return blocks.map((b) => ('text' in b && typeof b.text === 'string' ? b.text : '')).join('\n\n');
        };
        return await fn(call);
      } finally {
        await client.close().catch(() => {});
        await server.close().catch(() => {});
      }
    } finally {
      vi.resetModules();
      if (savedSlug === undefined) delete process.env.MAI_PROJECT_SLUG;
      else process.env.MAI_PROJECT_SLUG = savedSlug;
      if (savedDb === undefined) delete process.env.MAI_DB_URL;
      else process.env.MAI_DB_URL = savedDb;
    }
  }

  it('domain failures return the machine error envelope, never prose (ff81f6f2)', async () => {
    await admin.query(
      `DELETE FROM run_receipts WHERE project_id = (SELECT id FROM projects WHERE slug='plan23-test')`);
    await withDefaultServer(async (call) => {
      const receipt = {
        receiptKey: 'wire-envelope', kind: 'result', cycleId: 'wire-envelope-cycle',
        schemaVersion: 'conductor/1', n: 1,
      };
      const first: unknown = JSON.parse(await call('mai_receipt_add', { receipt }));
      expect(first).toMatchObject({ ok: true, duplicate: false });
      const conflictText = await call('mai_receipt_add', { receipt: { ...receipt, n: 2 } });
      expect(conflictText).not.toContain('mai-mcp error:');
      const conflict: unknown = JSON.parse(conflictText);
      expect(conflict).toMatchObject({ ok: false, error: 'conflict' });
      const validationText = await call('mai_receipt_add', {
        receipt: { ...receipt, receiptKey: 'wire-bad', kind: 'Bad-Kind' },
      });
      expect(validationText).not.toContain('mai-mcp error:');
      const validation: unknown = JSON.parse(validationText);
      expect(validation).toMatchObject({ ok: false, error: 'validation' });
    });
  });

  it('machine tools stay one JSON document under a live board nudge; oversized mai_receipts points to read-call (86b6b033/1a433c46)', async () => {
    const { rows: proj } = await admin.query<{ id: string }>(
      `SELECT id FROM projects WHERE slug='plan23-test'`);
    const projectId = proj[0].id;
    await admin.query('DELETE FROM run_receipts WHERE project_id = $1', [projectId]);
    await admin.query('DELETE FROM run_artifacts WHERE project_id = $1', [projectId]);
    await admin.query(
      `INSERT INTO agent_messages (project_id, author_agent, author_session, type, status, body)
       VALUES ($1, 'stager@test', 'staged-other-session', 'handoff', 'open', 'WIRE-NUDGE staged open handoff')`,
      [projectId]);
    await withDefaultServer(async (call) => {
      const addText = await call('mai_receipt_add', { receipt: {
        receiptKey: 'wire-small', kind: 'result', cycleId: 'wire-small-cycle',
        schemaVersion: 'conductor/1',
      } });
      expect(JSON.parse(addText)).toMatchObject({ ok: true });
      expect(addText).not.toContain('[agent board:');
      const putText = await call('mai_artifact_put', { kind: 'frozen_plan', content: 'wire artifact body' });
      expect(JSON.parse(putText)).toMatchObject({ ok: true });
      expect(putText).not.toContain('[agent board:');
      const pageText = await call('mai_receipts', { cycle_id: 'wire-small-cycle' });
      expect(pageText).not.toContain('[agent board:');
      const page: unknown = JSON.parse(pageText);
      expect(page).toMatchObject({ nextCursor: null });
      // Control: the SAME staged handoff nudges a non-exempt read — proving the
      // pending nudge was live while every machine tool above stayed clean.
      const control = await call('mai_ideas', {});
      expect(control).toContain('[agent board:');
      expect(control).toContain('open handoff');
      const exactIdea = await admin.query<{ id: string }>(
        `INSERT INTO ideas (project_id, title, detail, status, priority, sort_order, source)
         VALUES ($1, 'wire exact idea', $2, 'idea', 'now', 9999, 'user') RETURNING id`,
        [projectId, 'I'.repeat(7_000)],
      );
      const exact = await call('mai_ideas', { idea_id: exactIdea.rows[0].id.slice(0, 8) });
      expect(exact.length).toBeLessThanOrEqual(READ_CHAR_BUDGET);
      expect(exact).toContain('-- idea-body chars=');
      expect(exact).toContain(`idea_id:"${exactIdea.rows[0].id}:2"`);
      // Oversized page: visible truncation by documented contract (the MCP
      // surface is the budget-capped human convenience), pointing at read-call.
      for (let i = 1; i <= 3; i++) {
        const bigText = await call('mai_receipt_add', { receipt: {
          receiptKey: `wire-big-${i}`, kind: 'result', cycleId: 'wire-big-cycle',
          schemaVersion: 'conductor/1', bulk: 'B'.repeat(2500),
        } });
        expect(JSON.parse(bigText)).toMatchObject({ ok: true });
      }
      const big = await call('mai_receipts', { cycle_id: 'wire-big-cycle' });
      expect(big.length).toBeLessThanOrEqual(READ_CHAR_BUDGET);
      expect(big).toContain('build/read-call.js receipts');
      // Direct facade probe: the suppression IS the coordination exemption.
      const { coordination } = await import('../coordination/index.js');
      expect(await coordination.piggybackNudge('mai_receipt_add', false)).toBe('');
    });
  });
});
