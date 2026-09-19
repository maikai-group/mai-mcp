/** Curation loops (plan 22). Throwaway projects + cascade cleanup (lesson
 * 63fb332c: no read verb in mai-mcp is write-free, and this build makes reads
 * write MORE). The suite defaults to the execution brain but honours an
 * inherited MAI_DB_URL so reviews can run it against a disposable database;
 * every deletion remains slug/project scoped. Fake embedder throughout: no
 * model load, no network (plan 14 R8). No assertion hardcodes 90 — the window
 * is imported. */
import { beforeAll, afterAll, beforeEach, describe, expect, it } from 'vitest';
import { Pool } from 'pg';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const execFileP = promisify(execFile);

const saved: Record<string, string | undefined> = {
  MAI_PROJECT_SLUG: process.env.MAI_PROJECT_SLUG,
  MAI_DB_URL: process.env.MAI_DB_URL,
  MAI_LLM_SUMMARY: process.env.MAI_LLM_SUMMARY,
  MAI_AGENT_ID: process.env.MAI_AGENT_ID,
};
process.env.MAI_PROJECT_SLUG = 'plan22-test';
process.env.MAI_DB_URL =
  process.env.MAI_DB_URL ?? 'postgresql://postgres:postgres@127.0.0.1:54334/mai_brain';
process.env.MAI_LLM_SUMMARY = '0';
process.env.MAI_AGENT_ID = 'tester@vitest';

const admin = new Pool({ connectionString: process.env.MAI_DB_URL });
let projectId = '';
let otherId = '';

const oneHot = (i: number): number[] => {
  const v = new Array(384).fill(0);
  v[i] = 1;
  return v;
};

/** Seed a decision. `ageDays` back-dates `timestamp`; `curation_baseline_at`
 * stays NULL exactly as it does for any row created after the migration. */
async function seedDecision(opts: {
  project?: string;
  description: string;
  ageDays?: number;
  surfaced?: number;
  cited?: number;
  source?: string;
  stillValid?: boolean;
  retracted?: boolean;
  embedding?: number[] | null;
  embeddingModel?: string | null;
}): Promise<string> {
  const r = await admin.query<{ id: string }>(
    `INSERT INTO code_decisions
       (project_id, decision_type, description, source, timestamp, still_valid,
        retracted_at, retraction_reason, surfaced_count, cited_count,
        embedding, embedding_model, confidence)
     VALUES ($1,'arch',$2,$3, NOW() - make_interval(days => $4::int), $5,
             CASE WHEN $6 THEN NOW() ELSE NULL END,
             CASE WHEN $6 THEN 'test' ELSE NULL END,
             $7,$8,$9,$10, 0.8)
     RETURNING id`,
    [
      opts.project ?? projectId, opts.description, opts.source ?? 'agent-inferred',
      opts.ageDays ?? 0, opts.stillValid ?? true, opts.retracted ?? false,
      opts.surfaced ?? 0, opts.cited ?? 0,
      opts.embedding ?? null, opts.embeddingModel ?? null,
    ]
  );
  return r.rows[0].id;
}

async function seedLesson(opts: {
  project?: string | null;
  rule: string;
  ageDays?: number;
  surfaced?: number;
  cited?: number;
  confidence?: number;
}): Promise<string> {
  const r = await admin.query<{ id: string }>(
    `INSERT INTO lessons
       (project_id, rule, created_at, surfaced_count, cited_count, confidence_score)
     VALUES ($1,$2, NOW() - make_interval(days => $3::int), $4, $5, $6)
     RETURNING id`,
    [
      opts.project === undefined ? projectId : opts.project,
      opts.rule, opts.ageDays ?? 0, opts.surfaced ?? 0, opts.cited ?? 0,
      opts.confidence ?? 0.5,
    ]
  );
  return r.rows[0].id;
}

async function counters(kind: 'decision' | 'lesson', id: string) {
  const table = kind === 'decision' ? 'code_decisions' : 'lessons';
  const r = await admin.query<{ surfaced_count: number; cited_count: number }>(
    `SELECT surfaced_count, cited_count FROM ${table} WHERE id = $1`,
    [id]
  );
  return { surfaced: Number(r.rows[0].surfaced_count), cited: Number(r.rows[0].cited_count) };
}

/** Per-test reset: ROWS only. The projects themselves are created ONCE in
 * beforeAll and dropped ONCE in afterAll, and that ordering is LOAD-BEARING —
 * `write-gate.ts` memoizes `_sessionTokenId` for the life of the module, so
 * deleting the project between tests would cascade that token row away while
 * the memo still points at it. Every later `verifyCatA` would then read an
 * empty `result_set_ids` and reject a citation that was genuinely searched for
 * — a whole-file false red with no obvious cause. Cascade cleanup (lesson
 * 63fb332c) still happens; it happens at afterAll. */
async function resetRows(): Promise<void> {
  const both = [projectId, otherId];
  await admin.query(`DELETE FROM memory_citations WHERE project_id = ANY($1::uuid[])`, [both]);
  await admin.query(`DELETE FROM curation_candidates WHERE project_id = ANY($1::uuid[])`, [both]);
  await admin.query(`DELETE FROM code_decisions WHERE project_id = ANY($1::uuid[])`, [both]);
  await admin.query(
    `DELETE FROM lessons
      WHERE project_id = ANY($1::uuid[])
         OR (project_id IS NULL AND rule LIKE 'plan22-global%')`,
    [both]
  );
}

/** Cascade cleanup — deletes the PROJECTS, which sweeps decisions, lessons,
 * citations, candidates, doc chunks and session tokens with them. Global
 * lessons have no project to cascade from, so they go first, by marker. */
async function dropProjects(): Promise<void> {
  await admin.query(`DELETE FROM lessons WHERE project_id IS NULL AND rule LIKE 'plan22-global%'`);
  await admin.query(`DELETE FROM projects WHERE slug IN ('plan22-test','plan22-other')`);
}

beforeAll(async () => {
  await import('../db.js'); // dotenv defusal before scrubbing (plan-13 P2-B1)
  for (const k of ['MAI_EMBEDDINGS', 'OPENAI_API_KEY', 'VOYAGE_API_KEY']) saved[k] = process.env[k];
  await dropProjects();
  const p = await admin.query<{ id: string }>(
    `INSERT INTO projects (slug, name) VALUES ('plan22-test','Plan22') RETURNING id`
  );
  projectId = p.rows[0].id;
  const o = await admin.query<{ id: string }>(
    `INSERT INTO projects (slug, name) VALUES ('plan22-other','Plan22 Other') RETURNING id`
  );
  otherId = o.rows[0].id;
  const { __resetProjectIdCacheForTests } = await import('../db.js');
  __resetProjectIdCacheForTests();
});

afterAll(async () => {
  const { setLocalEmbedderForTests } = await import('../embeddings.js');
  setLocalEmbedderForTests(null);
  for (const [k, v] of Object.entries(saved)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  await dropProjects();
  await admin.end();
  const { getPool } = await import('../db.js');
  await getPool().end();
});

beforeEach(async () => {
  await resetRows();
  process.env.MAI_EMBEDDINGS = '0';
  delete process.env.OPENAI_API_KEY;
  delete process.env.VOYAGE_API_KEY;
  const { setLocalEmbedderForTests } = await import('../embeddings.js');
  setLocalEmbedderForTests(null);
});

// ---------- §2.1 surfaced tier: the piggyback ----------

describe('surfaced counters (spec §2.1)', () => {
  it('state 1 — semantic UNAVAILABLE: the all-row trigram fallback bumps surfaced_count', async () => {
    const id = await seedDecision({ description: 'zebra hydration protocol for the widget' });
    const { unifiedSearch } = await import('../decisions.js');
    await unifiedSearch({ query: 'zebra hydration protocol', kind: 'decisions' });
    expect((await counters('decision', id)).surfaced).toBe(1);
  });

  it('state 2 — semantic HITS plus the stale-trigram pass: both lanes bump (lesson 8712fd38)', async () => {
    process.env.MAI_EMBEDDINGS = '1';
    const { setLocalEmbedderForTests, currentEmbeddingModelId } = await import('../embeddings.js');
    setLocalEmbedderForTests(async () => oneHot(3));
    const model = currentEmbeddingModelId();
    const fresh = await seedDecision({
      description: 'fresh semantic row about zebra hydration',
      embedding: oneHot(3), embeddingModel: model,
    });
    const stale = await seedDecision({
      description: 'zebra hydration protocol, stale tag',
      embedding: oneHot(3), embeddingModel: 'local:ancient-model',
    });
    const { unifiedSearch } = await import('../decisions.js');
    await unifiedSearch({ query: 'zebra hydration protocol', kind: 'decisions', limit: 5 });
    expect((await counters('decision', fresh)).surfaced).toBe(1);
    expect((await counters('decision', stale)).surfaced).toBe(1);
  });

  it('state 3 — semantic AVAILABLE but ZERO hits above threshold: the all-row rescue still bumps', async () => {
    process.env.MAI_EMBEDDINGS = '1';
    const { setLocalEmbedderForTests, currentEmbeddingModelId } = await import('../embeddings.js');
    setLocalEmbedderForTests(async () => oneHot(0));
    const model = currentEmbeddingModelId();
    // Embedded with the CURRENT tag (so the semantic lane runs) but ORTHOGONAL
    // to the query vector (cosine 0 < 0.25) — the third state reviewers miss.
    const id = await seedDecision({
      description: 'zebra hydration protocol for the widget',
      embedding: oneHot(200), embeddingModel: model,
    });
    const { unifiedSearch } = await import('../decisions.js');
    await unifiedSearch({ query: 'zebra hydration protocol', kind: 'decisions' });
    expect((await counters('decision', id)).surfaced).toBe(1);
  });

  it('one search increments ONCE; two searches increment twice (no double-count)', async () => {
    const id = await seedDecision({ description: 'zebra hydration protocol for the widget' });
    const { unifiedSearch } = await import('../decisions.js');
    // kind:'all' runs the decisions lane once even though the result set also
    // feeds the lessons/doc lanes; id = ANY($1) is idempotent per statement.
    await unifiedSearch({ query: 'zebra hydration protocol', kind: 'all' });
    expect((await counters('decision', id)).surfaced).toBe(1);
    await unifiedSearch({ query: 'zebra hydration protocol', kind: 'all' });
    expect((await counters('decision', id)).surfaced).toBe(2);
  });

  it("a pinned project's search never bumps another project's counters (isolation.test.ts precedent)", async () => {
    const mine = await seedDecision({ description: 'zebra hydration protocol here' });
    const theirs = await seedDecision({ project: otherId, description: 'zebra hydration protocol there' });
    const { unifiedSearch } = await import('../decisions.js');
    await unifiedSearch({ query: 'zebra hydration protocol', kind: 'decisions' });
    expect((await counters('decision', mine)).surfaced).toBe(1);
    expect((await counters('decision', theirs)).surfaced).toBe(0);
  });
});

// ---------- §3 candidacy ----------

describe('prune candidacy (spec §3.1)', () => {
  const OLD = async () => (await import('../curation.js')).CURATION_WINDOW_DAYS + 10;

  async function candidateIds(): Promise<string[]> {
    const { curationCandidates } = await import('../curation.js');
    return (await curationCandidates(projectId, 50)).map((c) => c.targetId);
  }

  it('a FRESH unsurfaced entry is NOT a candidate — new is not stale (the age floor)', async () => {
    const id = await seedDecision({ description: 'brand new decision', ageDays: 2 });
    expect(await candidateIds()).not.toContain(id);
  });

  it('an OLD unsurfaced entry IS a candidate, with basis never-surfaced', async () => {
    const id = await seedDecision({ description: 'old and never seen', ageDays: await OLD() });
    const { curationCandidates } = await import('../curation.js');
    const hit = (await curationCandidates(projectId, 50)).find((c) => c.targetId === id);
    expect(hit?.basis).toBe('never-surfaced');
  });

  it('an OLD surfaced-but-uncited entry IS a candidate, with basis never-cited', async () => {
    const id = await seedDecision({ description: 'old, seen, never used', ageDays: await OLD(), surfaced: 7 });
    const { curationCandidates } = await import('../curation.js');
    const hit = (await curationCandidates(projectId, 50)).find((c) => c.targetId === id);
    expect(hit?.basis).toBe('never-cited');
    expect(hit?.surfacedCount).toBe(7);
  });

  it('an OLD surfaced AND cited entry is NOT a candidate — it earned its keep', async () => {
    const id = await seedDecision({ description: 'load bearing', ageDays: await OLD(), surfaced: 9, cited: 2 });
    expect(await candidateIds()).not.toContain(id);
  });

  it('a RETRACTED entry is NOT a candidate — already retired', async () => {
    const id = await seedDecision({
      description: 'already retracted', ageDays: await OLD(), stillValid: false, retracted: true,
    });
    expect(await candidateIds()).not.toContain(id);
  });

  it('a GLOBAL lesson IS a candidate and carries the isGlobal flag (aebc6583 / §10.3)', async () => {
    const id = await seedLesson({ project: null, rule: 'plan22-global never cited rule', ageDays: await OLD() });
    const { curationCandidates } = await import('../curation.js');
    const hit = (await curationCandidates(projectId, 50)).find((c) => c.targetId === id);
    expect(hit).toBeDefined();
    expect(hit?.isGlobal).toBe(true);
    expect(hit?.targetKind).toBe('lesson');
  });

  it('operator-approved entries rank LAST — telemetry may ask, never outrank', async () => {
    const approved = await seedDecision({
      description: 'operator approved and unused', ageDays: await OLD(), surfaced: 99, source: 'user-approved',
    });
    const inferred = await seedDecision({
      description: 'agent inferred and unused', ageDays: await OLD(), surfaced: 1,
    });
    const ids = await candidateIds();
    expect(ids.indexOf(inferred)).toBeLessThan(ids.indexOf(approved));
  });

  it('a KEPT verdict inside the window suppresses; beyond the window it re-surfaces', async () => {
    const { CURATION_WINDOW_DAYS } = await import('../curation.js');
    const id = await seedDecision({ description: 'kept once already', ageDays: CURATION_WINDOW_DAYS + 10 });
    await admin.query(
      `INSERT INTO curation_candidates (project_id,target_kind,target_id,basis,status,resolved_at)
       VALUES ($1,'decision',$2,'never-surfaced','kept', NOW() - make_interval(days => 5))`,
      [projectId, id]
    );
    expect(await candidateIds()).not.toContain(id);
    await admin.query(
      `UPDATE curation_candidates SET resolved_at = NOW() - make_interval(days => $2::int)
        WHERE target_id = $1`,
      [id, CURATION_WINDOW_DAYS + 1]
    );
    expect(await candidateIds()).toContain(id);
  });

  it('an OPEN agent proposal owns the target — no duplicate telemetry card or count', async () => {
    const id = await seedDecision({ description: 'old entry with agent evidence', ageDays: await OLD() });
    await admin.query(
      `INSERT INTO curation_candidates
         (project_id,target_kind,target_id,basis,status,evidence,proposed_by)
       VALUES ($1,'decision',$2,'agent-evidence','open','measured contradiction','tester@vitest')`,
      [projectId, id]
    );
    const { curationCandidates, curationCards, curationCounts } = await import('../curation.js');
    expect((await curationCandidates(projectId, 50)).map((c) => c.targetId)).not.toContain(id);
    const sameTarget = (await curationCards(projectId, 50)).filter((c) => c.targetId === id);
    expect(sameTarget).toHaveLength(1);
    expect(sameTarget[0]).toMatchObject({
      basis: 'agent-evidence', approveAction: 'retire', denyAction: 'keep',
    });
    expect(await curationCounts(projectId)).toEqual({
      candidates: 0,
      proposals: 1,
      graduations: 0,
    });
  });

  it('the migration baseline buys the legacy corpus exactly one window (spec §7)', async () => {
    const { CURATION_WINDOW_DAYS } = await import('../curation.js');
    const id = await seedDecision({ description: 'ancient legacy row', ageDays: 900 });
    await admin.query(`UPDATE code_decisions SET curation_baseline_at = NOW() WHERE id = $1`, [id]);
    expect(await candidateIds()).not.toContain(id);
    await admin.query(
      `UPDATE code_decisions SET curation_baseline_at = NOW() - make_interval(days => $2::int) WHERE id = $1`,
      [id, CURATION_WINDOW_DAYS + 1]
    );
    expect(await candidateIds()).toContain(id);
  });
});
// ---------- §2.2 / §2.3 the citation that used to be thrown away ----------

/** Mint a read token for the pinned session. Every Cat A write needs one —
 * lesson 63fb332c: the read IS a write. */
async function searchFor(query: string, kind: 'decisions' | 'lessons'): Promise<void> {
  const { unifiedSearch } = await import('../decisions.js');
  await unifiedSearch({ query, kind });
}

async function citations(): Promise<Array<{
  citing_kind: string; citing_id: string | null; cited_kind: string; cited_id: string;
  relation: string; status: string; reason: string;
}>> {
  const r = await admin.query<{
    citing_kind: string; citing_id: string | null; cited_kind: string; cited_id: string;
    relation: string; status: string; reason: string;
  }>(
    `SELECT citing_kind, citing_id::text AS citing_id, cited_kind, cited_id::text AS cited_id,
            relation, status, reason
       FROM memory_citations WHERE project_id = $1 ORDER BY created_at`,
    [projectId]
  );
  return r.rows;
}

describe('citation persistence (spec §2.2/§2.3)', () => {
  it('an extends citation persists with the citing id set, status recorded', async () => {
    const cited = await seedDecision({ description: 'zebra hydration protocol baseline' });
    await searchFor('zebra hydration protocol', 'decisions');
    const { decisionAdd } = await import('../decisions.js');
    const out = await decisionAdd({
      citation: { kind: 'extends', extends_id: cited, how: 'adds the flush step' },
      decisionType: 'arch',
      description: 'zebra hydration protocol now includes a flush step',
    });
    const rows = await citations();
    expect(rows).toHaveLength(1);
    expect(rows[0].cited_id).toBe(cited);
    expect(rows[0].relation).toBe('extends');
    expect(rows[0].status).toBe('recorded');
    expect(rows[0].citing_kind).toBe('decision');
    expect(rows[0].citing_id).not.toBeNull();
    expect(out).toContain(rows[0].citing_id ?? 'MISSING');
  });

  it('an AGENT-INFERRED supersedes files status=proposed — it surfaces for a verdict (§4.1)', async () => {
    const cited = await seedDecision({ description: 'zebra hydration protocol baseline' });
    await searchFor('zebra hydration protocol', 'decisions');
    const { decisionAdd } = await import('../decisions.js');
    await decisionAdd({
      citation: { kind: 'supersedes', supersedes_id: cited, reason: 'the protocol was measured wrong' },
      decisionType: 'arch',
      description: 'zebra hydration protocol replaced by the measured one',
      source: 'agent-inferred',
    });
    const rows = await citations();
    expect(rows[0].status).toBe('proposed');
    // The superseded row is UNTOUCHED — this build does not change that (§4.1).
    const still = await admin.query<{ still_valid: boolean }>(
      `SELECT still_valid FROM code_decisions WHERE id = $1`, [cited]);
    expect(still.rows[0].still_valid).toBe(true);
  });

  it('an OPERATOR-SOURCED supersedes files status=recorded — the operator was already in the loop', async () => {
    const cited = await seedDecision({ description: 'zebra hydration protocol baseline' });
    await searchFor('zebra hydration protocol', 'decisions');
    const { decisionAdd } = await import('../decisions.js');
    await decisionAdd({
      citation: { kind: 'supersedes', supersedes_id: cited, reason: 'operator chose the measured protocol' },
      decisionType: 'arch',
      description: 'zebra hydration protocol replaced, operator approved',
      source: 'user-approved',
    });
    expect((await citations())[0].status).toBe('recorded');
  });

  it('a write that FAILS after gate approval rolls the citation back WITH it (§2.3)', async () => {
    const cited = await seedDecision({ description: 'zebra hydration protocol baseline' });
    await searchFor('zebra hydration protocol', 'decisions');
    const { decisionAdd } = await import('../decisions.js');
    // PG rejects a NUL in a text parameter ("invalid byte sequence for encoding
    // UTF8: 0x00" — verified live 2026-08-12 by plan 20). Putting it in the
    // CITATION's `how` makes the SECOND statement of the transaction fail,
    // AFTER the entry INSERT has already succeeded. Nothing may survive it.
    const nul = String.fromCharCode(0);
    await expect(
      decisionAdd({
        citation: { kind: 'extends', extends_id: cited, how: `broken${nul}citation` },
        decisionType: 'arch',
        description: 'zebra hydration protocol addendum that must not land',
      })
    ).rejects.toThrow();
    expect(await citations()).toHaveLength(0);
    const orphan = await admin.query(
      `SELECT id FROM code_decisions WHERE project_id = $1 AND description LIKE '%must not land%'`,
      [projectId]
    );
    expect(orphan.rows).toHaveLength(0);
  });

  it('a REJECTED write creates no citation — a rejection must not manufacture a signal', async () => {
    await seedDecision({ description: 'zebra hydration protocol baseline' });
    await searchFor('zebra hydration protocol', 'decisions');
    const { decisionAdd } = await import('../decisions.js');
    await expect(
      decisionAdd({
        citation: {
          kind: 'extends',
          extends_id: '00000000-0000-0000-0000-000000000000',
          how: 'never searched for this one',
        },
        decisionType: 'arch',
        description: 'rejected write',
      })
    ).rejects.toThrow();
    expect(await citations()).toHaveLength(0);
  });
});

// ---------- §6 lessons-only reinforcement (decision aebc6583) ----------

describe('lessons-only reinforcement (aebc6583 / §6)', () => {
  it('citing a DECISION moves the counts and leaves confidence BYTE-IDENTICAL', async () => {
    const cited = await seedDecision({ description: 'zebra hydration protocol baseline' });
    const before = await admin.query<{ confidence: number }>(
      `SELECT confidence FROM code_decisions WHERE id = $1`, [cited]);
    await searchFor('zebra hydration protocol', 'decisions');
    const { decisionAdd } = await import('../decisions.js');
    await decisionAdd({
      citation: { kind: 'extends', extends_id: cited, how: 'adds the flush step' },
      decisionType: 'arch',
      description: 'zebra hydration protocol now includes a flush step',
    });
    const after = await admin.query<{
      confidence: number; cited_count: number; reinforcement_count: number; last_cited_at: Date | null;
    }>(
      `SELECT confidence, cited_count, reinforcement_count, last_cited_at
         FROM code_decisions WHERE id = $1`,
      [cited]
    );
    expect(Number(after.rows[0].cited_count)).toBe(1);
    expect(Number(after.rows[0].reinforcement_count)).toBe(1);
    expect(after.rows[0].last_cited_at).not.toBeNull();
    // THE ASYMMETRY. `confidence` on a decision is a TRIAGE SELECTOR
    // (reviewQueueRows selects confidence < 0.5) — a citation bump would let
    // telemetry silently empty the operator's queue. A later refactor that
    // "tidies" this into symmetry is a regression, and this line catches it.
    expect(Number(after.rows[0].confidence)).toBe(Number(before.rows[0].confidence));
  });

  it('citing a LESSON moves confidence_score by exactly REINFORCEMENT_BUMP', async () => {
    const { REINFORCEMENT_BUMP } = await import('../lessons.js');
    const cited = await seedLesson({ rule: 'always frobnicate the zebra before hydrating', confidence: 0.50 });
    await searchFor('frobnicate the zebra', 'lessons');
    const { lessonAdd } = await import('../lessons.js');
    await lessonAdd({
      rule: 'a totally different rule about widget serialisation ordering',
      citation: { kind: 'extends', extends_id: cited, how: 'the same discipline, applied to widgets' },
    });
    const after = await admin.query<{
      confidence_score: string; reinforcement_count: number; cited_count: number;
    }>(
      `SELECT confidence_score, reinforcement_count, cited_count FROM lessons WHERE id = $1`, [cited]);
    expect(Number(after.rows[0].confidence_score)).toBeCloseTo(0.50 + REINFORCEMENT_BUMP, 10);
    expect(Number(after.rows[0].reinforcement_count)).toBe(1);
    expect(Number(after.rows[0].cited_count)).toBe(1);
  });

  it('lesson reinforcement CAPS at MAX_CONFIDENCE and never exceeds it', async () => {
    const { MAX_CONFIDENCE } = await import('../lessons.js');
    const cited = await seedLesson({ rule: 'always frobnicate the zebra before hydrating', confidence: 0.99 });
    await searchFor('frobnicate the zebra', 'lessons');
    const { lessonAdd } = await import('../lessons.js');
    await lessonAdd({
      rule: 'a totally different rule about widget serialisation ordering',
      citation: { kind: 'extends', extends_id: cited, how: 'the same discipline, applied to widgets' },
    });
    const after = await admin.query<{ confidence_score: string }>(
      `SELECT confidence_score FROM lessons WHERE id = $1`, [cited]);
    expect(Number(after.rows[0].confidence_score)).toBe(MAX_CONFIDENCE);
  });

  it('the near-duplicate reinforcement path shares the helper and is never NaN', async () => {
    // node-postgres returns DECIMAL as a STRING, so the old JS arithmetic
    // ("0.50" + 0.05) produced NaN. This asserts a real number lands.
    const { REINFORCEMENT_BUMP } = await import('../lessons.js');
    const rule = 'never point the brain at port 55444 under any circumstance';
    const existing = await seedLesson({ rule, confidence: 0.50 });
    await searchFor('port 55444', 'lessons');
    const { lessonAdd } = await import('../lessons.js');
    const out = await lessonAdd({
      rule,
      citation: {
        kind: 'novel',
        justification: 'a deliberate near-duplicate to exercise the dedup reinforcement path',
      },
    });
    expect(out).toMatch(/^Reinforced existing lesson/);
    expect(out).not.toContain('NaN');
    const after = await admin.query<{ confidence_score: string; reinforcement_count: number }>(
      `SELECT confidence_score, reinforcement_count FROM lessons WHERE id = $1`, [existing]);
    expect(Number.isNaN(Number(after.rows[0].confidence_score))).toBe(false);
    expect(Number(after.rows[0].confidence_score)).toBeCloseTo(0.50 + REINFORCEMENT_BUMP, 10);
    expect(Number(after.rows[0].reinforcement_count)).toBe(1);
  });

  it('a near-duplicate extends a DIFFERENT lesson atomically — citation and both reinforcements land once', async () => {
    const cited = await seedLesson({
      rule: 'always frobnicate the zebra before hydrating', confidence: 0.50,
    });
    const duplicateRule = 'serialize every widget before opening the transport';
    const duplicate = await seedLesson({ rule: duplicateRule, confidence: 0.40 });
    await searchFor('frobnicate the zebra before hydrating', 'lessons');
    const { lessonAdd } = await import('../lessons.js');
    const out = await lessonAdd({
      rule: duplicateRule,
      citation: { kind: 'extends', extends_id: cited, how: 'applies the same ordering discipline' },
    });
    expect(out).toMatch(/^Reinforced existing lesson/);
    const rows = await citations();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      citing_kind: 'lesson', citing_id: duplicate,
      cited_kind: 'lesson', cited_id: cited, relation: 'extends', status: 'recorded',
    });
    const counts = await admin.query<{
      id: string; cited_count: number; reinforcement_count: number;
    }>(
      `SELECT id::text AS id, cited_count, reinforcement_count
         FROM lessons WHERE id = ANY($1::uuid[]) ORDER BY id`,
      [[cited, duplicate]]
    );
    const byId = new Map(counts.rows.map((r) => [r.id, r]));
    expect(Number(byId.get(cited)?.cited_count)).toBe(1);
    expect(Number(byId.get(cited)?.reinforcement_count)).toBe(1);
    expect(Number(byId.get(duplicate)?.cited_count)).toBe(0);
    expect(Number(byId.get(duplicate)?.reinforcement_count)).toBe(1);
  });

  it('a near-duplicate supersedes a DIFFERENT lesson and preserves the proposal', async () => {
    const cited = await seedLesson({ rule: 'hydrate the zebra before measuring it' });
    const duplicateRule = 'measure the zebra before hydration begins';
    const duplicate = await seedLesson({ rule: duplicateRule });
    await searchFor('hydrate the zebra before measuring it', 'lessons');
    const { lessonAdd } = await import('../lessons.js');
    await lessonAdd({
      rule: duplicateRule,
      citation: { kind: 'supersedes', supersedes_id: cited, reason: 'the order was measured wrong' },
    });
    expect((await citations())[0]).toMatchObject({
      citing_id: duplicate, cited_id: cited, relation: 'supersedes', status: 'proposed',
    });
    const live = await admin.query<{ retired_at: Date | null }>(
      `SELECT retired_at FROM lessons WHERE id = ANY($1::uuid[]) ORDER BY id`, [[cited, duplicate]]
    );
    expect(live.rows.every((r) => r.retired_at === null)).toBe(true);
  });

  it('same-target near-duplicate citations reject self-extends and self-supersedes without reinforcement', async () => {
    const rule = 'never hydrate a zebra through the production port';
    const existing = await seedLesson({ rule });
    await searchFor(rule, 'lessons');
    const { lessonAdd } = await import('../lessons.js');
    await expect(lessonAdd({
      rule,
      citation: { kind: 'extends', extends_id: existing, how: 'would create a self-reference' },
    })).rejects.toThrow(/same near-duplicate lesson/);
    await expect(lessonAdd({
      rule,
      citation: { kind: 'supersedes', supersedes_id: existing, reason: 'would self-supersede' },
    })).rejects.toThrow(/same near-duplicate lesson/);
    expect(await citations()).toHaveLength(0);
    const after = await admin.query<{ reinforcement_count: number }>(
      `SELECT reinforcement_count FROM lessons WHERE id = $1`, [existing]
    );
    expect(Number(after.rows[0].reinforcement_count)).toBe(0);
  });

  it('a citation failure on the near-duplicate branch rolls back BOTH target reinforcements', async () => {
    const cited = await seedLesson({ rule: 'frobnicate the rollback zebra first' });
    const duplicateRule = 'serialize the rollback widget last';
    const duplicate = await seedLesson({ rule: duplicateRule });
    await searchFor('frobnicate the rollback zebra first', 'lessons');
    const nul = String.fromCharCode(0);
    const { lessonAdd } = await import('../lessons.js');
    await expect(lessonAdd({
      rule: duplicateRule,
      citation: { kind: 'extends', extends_id: cited, how: `broken${nul}citation` },
    })).rejects.toThrow();
    expect(await citations()).toHaveLength(0);
    const after = await admin.query<{ reinforcement_count: number }>(
      `SELECT reinforcement_count FROM lessons WHERE id = ANY($1::uuid[])`, [[cited, duplicate]]
    );
    expect(after.rows.map((r) => Number(r.reinforcement_count))).toEqual([0, 0]);
  });
});

describe('citation counter recount (spec §2.4)', () => {
  it('rebuilds project entries, aggregates global lessons fleet-wide, and leaves foreign project rows alone', async () => {
    const decision = await seedDecision({ description: 'recount decision', cited: 99 });
    const lesson = await seedLesson({ rule: 'recount project lesson', cited: 99 });
    const global = await seedLesson({ project: null, rule: 'plan22-global recount lesson', cited: 99 });
    const foreign = await seedDecision({ project: otherId, description: 'recount foreign', cited: 77 });
    await admin.query(
      `INSERT INTO memory_citations
         (project_id,citing_kind,cited_kind,cited_id,relation,reason,status)
       VALUES ($1,'decision','decision',$2,'extends','d','recorded'),
              ($1,'lesson','lesson',$3,'extends','l','recorded'),
              ($1,'lesson','lesson',$4,'extends','g1','recorded'),
              ($5,'lesson','lesson',$4,'extends','g2','recorded')`,
      [projectId, decision, lesson, global, otherId]
    );
    const { curationRecount } = await import('../curation.js');
    await curationRecount(projectId);
    const d = await admin.query<{ cited_count: number; last_cited_at: Date | null }>(
      `SELECT cited_count,last_cited_at FROM code_decisions WHERE id=$1`, [decision]);
    const l = await admin.query<{ id: string; cited_count: number }>(
      `SELECT id::text AS id,cited_count FROM lessons WHERE id=ANY($1::uuid[])`, [[lesson, global]]);
    const byId = new Map(l.rows.map((r) => [r.id, Number(r.cited_count)]));
    expect(Number(d.rows[0].cited_count)).toBe(1);
    expect(d.rows[0].last_cited_at).not.toBeNull();
    expect(byId.get(lesson)).toBe(1);
    expect(byId.get(global)).toBe(2);
    expect((await counters('decision', foreign)).cited).toBe(77);
  });

  it('the shipped `mai curation --recount` CLI reaches the rebuild path', async () => {
    const decision = await seedDecision({ description: 'CLI recount decision', cited: 0 });
    await admin.query(
      `INSERT INTO memory_citations
         (project_id,citing_kind,cited_kind,cited_id,relation,reason,status)
       VALUES ($1,'decision','decision',$2,'extends','cli','recorded')`,
      [projectId, decision]
    );
    const { stdout } = await execFileP(process.execPath, ['build/cli.js', 'curation', '--recount'], {
      env: { ...process.env, MAI_DB_URL: process.env.MAI_DB_URL, MAI_PROJECT_SLUG: 'plan22-test' },
    });
    expect(stdout).toMatch(/recounted .* decisions .* lessons/i);
    expect((await counters('decision', decision)).cited).toBe(1);
  });
});
// ---------- §4.2 mai_retract is propose-only for agents (aebc6583) ----------

describe('agent-facing retraction is PROPOSE ONLY (aebc6583 / §4.2)', () => {
  it('a call WITHOUT propose:true is rejected, names the propose form, and changes no still_valid', async () => {
    const id = await seedDecision({ description: 'a decision an agent wants gone' });
    const { retractFromAgent } = await import('../curation.js');
    await expect(
      retractFromAgent({ decisionId: id, reason: 'I think this is wrong' })
    ).rejects.toThrow(/propose: true/);
    const after = await admin.query<{ still_valid: boolean; retracted_at: Date | null }>(
      `SELECT still_valid, retracted_at FROM code_decisions WHERE id = $1`, [id]);
    expect(after.rows[0].still_valid).toBe(true);
    expect(after.rows[0].retracted_at).toBeNull();
    expect(
      (await admin.query(`SELECT id FROM curation_candidates WHERE project_id = $1`, [projectId])).rows
    ).toHaveLength(0);
  });

  it('propose:true files an OPEN candidate with the evidence and still changes no still_valid', async () => {
    const id = await seedDecision({ description: 'a decision an agent wants gone' });
    const { retractFromAgent } = await import('../curation.js');
    const out = await retractFromAgent({
      decisionId: id, reason: 'the measured protocol contradicts it', propose: true,
    });
    expect(out).toMatch(/PROPOSED/);
    const rows = await admin.query<{ status: string; basis: string; evidence: string; proposed_by: string }>(
      `SELECT status, basis, evidence, proposed_by FROM curation_candidates
        WHERE project_id = $1 AND target_id = $2`, [projectId, id]);
    expect(rows.rows).toHaveLength(1);
    expect(rows.rows[0].status).toBe('open');
    expect(rows.rows[0].basis).toBe('agent-evidence');
    expect(rows.rows[0].evidence).toContain('measured protocol');
    expect(rows.rows[0].proposed_by).toBe('tester@vitest');
    const after = await admin.query<{ still_valid: boolean }>(
      `SELECT still_valid FROM code_decisions WHERE id = $1`, [id]);
    expect(after.rows[0].still_valid).toBe(true);
  });

  it('a re-proposal on an already-open candidate is a NO-OP, not a queue flood', async () => {
    const id = await seedDecision({ description: 'a decision an agent wants gone' });
    const { retractFromAgent } = await import('../curation.js');
    await retractFromAgent({ decisionId: id, reason: 'first evidence', propose: true });
    const second = await retractFromAgent({ decisionId: id, reason: 'second evidence', propose: true });
    expect(second).toMatch(/already open/);
    const rows = await admin.query(
      `SELECT id FROM curation_candidates WHERE project_id = $1 AND target_id = $2`, [projectId, id]);
    expect(rows.rows).toHaveLength(1);
  });

  it('a reason over the field char limit is REJECTED and files no candidate — the agent arm keeps the check it replaces', async () => {
    // The gate this arm takes over from (decisionRetract) enforces
    // FIELD_CHAR_LIMIT. If retractFromAgent skipped it, mai_retract would accept
    // through the new arm what it rejects today, and write it unbounded into
    // curation_candidates.evidence — R6's "loses power and gains none" would be
    // false, and this is the test that says so (pass-4 finding c5768610).
    const id = await seedDecision({ description: 'a decision an agent wants gone' });
    const { retractFromAgent } = await import('../curation.js');
    await expect(
      retractFromAgent({ decisionId: id, reason: 'x'.repeat(1001), propose: true })
    ).rejects.toThrow(/char limit/i);
    expect(
      (await admin.query(`SELECT id FROM curation_candidates WHERE project_id = $1 AND target_id = $2`, [projectId, id])).rows
    ).toHaveLength(0);
    // ...and the rejection is LOGGED, exactly as the operator path logs it.
    const v = await admin.query<{ n: string }>(
      `SELECT count(*) AS n FROM write_violations WHERE project_id = $1 AND tool_name = 'mai_retract'`,
      [projectId]
    );
    expect(Number(v.rows[0].n)).toBeGreaterThan(0);
  });

  it('the OPERATOR path still retracts — the hardening must not break /api/retract', async () => {
    const id = await seedDecision({ description: 'a decision the operator retracts' });
    const { decisionRetract } = await import('../decisions.js');
    const out = await decisionRetract({ decisionId: id, reason: 'operator says no', projectId });
    expect(out).toMatch(/^Retracted decision/);
    const after = await admin.query<{ still_valid: boolean; retracted_at: Date | null }>(
      `SELECT still_valid, retracted_at FROM code_decisions WHERE id = $1`, [id]);
    expect(after.rows[0].still_valid).toBe(false);
    expect(after.rows[0].retracted_at).not.toBeNull();
  });
});
// ---------- §5.1 operator verdicts — the ONLY mutating paths ----------

describe('operator verdicts (spec §5.1)', () => {
  it('KEEP writes a kept verdict and suppresses the entry for one window', async () => {
    const { CURATION_WINDOW_DAYS, curationKeep, curationCandidates } = await import('../curation.js');
    const id = await seedDecision({ description: 'unused but wanted', ageDays: CURATION_WINDOW_DAYS + 10 });
    expect((await curationCandidates(projectId, 50)).map((c) => c.targetId)).toContain(id);
    const out = await curationKeep({
      targetKind: 'decision', targetId: id, basis: 'never-surfaced', note: 'still the plan', projectId,
    });
    expect(out).toMatch(/Kept/);
    expect((await curationCandidates(projectId, 50)).map((c) => c.targetId)).not.toContain(id);
    // Keep must NOT retire anything.
    const after = await admin.query<{ still_valid: boolean }>(
      `SELECT still_valid FROM code_decisions WHERE id = $1`, [id]);
    expect(after.rows[0].still_valid).toBe(true);
  });

  it('KEEP on an OPEN agent proposal closes that proposal instead of stacking a second row', async () => {
    const { curationKeep, curationProposals } = await import('../curation.js');
    const { retractFromAgent } = await import('../curation.js');
    const id = await seedDecision({ description: 'agent wanted this gone' });
    await retractFromAgent({ decisionId: id, reason: 'agent evidence here', propose: true });
    expect(await curationProposals(projectId, 50)).toHaveLength(1);
    await curationKeep({ targetKind: 'decision', targetId: id, basis: 'agent-evidence', projectId });
    expect(await curationProposals(projectId, 50)).toHaveLength(0);
    const rows = await admin.query<{ status: string }>(
      `SELECT status FROM curation_candidates WHERE project_id = $1 AND target_id = $2`, [projectId, id]);
    expect(rows.rows).toHaveLength(1);
    expect(rows.rows[0].status).toBe('kept');
  });

  it('RETIRE retires a decision and closes any open proposal for it', async () => {
    const { curationRetire, retractFromAgent } = await import('../curation.js');
    const id = await seedDecision({ description: 'genuinely wrong decision' });
    await retractFromAgent({ decisionId: id, reason: 'agent evidence here', propose: true });
    await curationRetire({ targetKind: 'decision', targetId: id, reason: 'operator agrees', projectId });
    const after = await admin.query<{ still_valid: boolean; retraction_reason: string }>(
      `SELECT still_valid, retraction_reason FROM code_decisions WHERE id = $1`, [id]);
    expect(after.rows[0].still_valid).toBe(false);
    expect(after.rows[0].retraction_reason).toBe('operator agrees');
    const cand = await admin.query<{ status: string }>(
      `SELECT status FROM curation_candidates WHERE project_id = $1 AND target_id = $2`, [projectId, id]);
    expect(cand.rows[0].status).toBe('applied');
  });

  it('RETIRE retires a GLOBAL lesson, removes it from reads, and UNRETIRE restores it (§10.3)', async () => {
    const { curationRetire, curationUnretire } = await import('../curation.js');
    const { lessonSearch } = await import('../lessons.js');
    const id = await seedLesson({ project: null, rule: 'plan22-global rule about frobnicating zebras' });
    expect(await lessonSearch({ query: 'frobnicating zebras', projectId })).toContain(id);
    const out = await curationRetire({
      targetKind: 'lesson', targetId: id, reason: 'superseded by the measured rule', projectId,
    });
    expect(out).toContain('GLOBAL');
    expect(await lessonSearch({ query: 'frobnicating zebras', projectId })).not.toContain(id);
    await curationUnretire({ targetKind: 'lesson', targetId: id, projectId });
    expect(await lessonSearch({ query: 'frobnicating zebras', projectId })).toContain(id);
  });

  it('APPLY retires the superseded entry and marks the citation applied; DISMISS leaves both live', async () => {
    const { curationApply, curationDismiss, curationProposals } = await import('../curation.js');
    // Proposal 1 — applied.
    const oldA = await seedDecision({ description: 'zebra hydration protocol baseline' });
    await searchFor('zebra hydration protocol', 'decisions');
    const { decisionAdd } = await import('../decisions.js');
    await decisionAdd({
      citation: { kind: 'supersedes', supersedes_id: oldA, reason: 'measured wrong' },
      decisionType: 'arch', description: 'zebra hydration protocol, measured version',
    });
    const props = await curationProposals(projectId, 50);
    expect(props).toHaveLength(1);
    expect(props[0].replacementSummary).toContain('measured version');
    await curationApply({ citationId: props[0].id, projectId });
    const applied = await admin.query<{ still_valid: boolean }>(
      `SELECT still_valid FROM code_decisions WHERE id = $1`, [oldA]);
    expect(applied.rows[0].still_valid).toBe(false);
    expect(
      (await admin.query<{ status: string }>(
        `SELECT status FROM memory_citations WHERE id = $1`, [props[0].id])).rows[0].status
    ).toBe('applied');

    // Proposal 2 — dismissed: BOTH entries live on.
    const oldB = await seedDecision({ description: 'widget serialisation ordering baseline' });
    await searchFor('widget serialisation ordering', 'decisions');
    await decisionAdd({
      citation: { kind: 'supersedes', supersedes_id: oldB, reason: 'thought it was wrong' },
      decisionType: 'arch', description: 'widget serialisation ordering, alternative',
    });
    const open = (await curationProposals(projectId, 50)).filter((p) => p.targetId === oldB);
    expect(open).toHaveLength(1);
    const msg = await curationDismiss({ citationId: open[0].id, note: 'the original was right', projectId });
    expect(msg).toMatch(/Dismissed/);
    const live = await admin.query<{ still_valid: boolean }>(
      `SELECT still_valid FROM code_decisions WHERE id = $1`, [oldB]);
    expect(live.rows[0].still_valid).toBe(true);
    expect(await curationProposals(projectId, 50)).toHaveLength(0);
  });

  it('APPLY revalidates the replacement under lock — a withdrawn replacement leaves old + proposal live', async () => {
    const old = await seedDecision({ description: 'zebra hydration protocol old version' });
    await searchFor('zebra hydration protocol old version', 'decisions');
    const { decisionAdd, decisionRetract } = await import('../decisions.js');
    await decisionAdd({
      citation: { kind: 'supersedes', supersedes_id: old, reason: 'measured wrong' },
      decisionType: 'arch', description: 'zebra hydration protocol replacement',
    });
    const { curationApply, curationProposals } = await import('../curation.js');
    const proposal = (await curationProposals(projectId, 50)).find((p) => p.targetId === old);
    expect(proposal?.replacementId).not.toBeNull();
    if (!proposal?.replacementId) throw new Error('fixture produced no replacement id');
    await decisionRetract({
      decisionId: proposal.replacementId, reason: 'replacement was withdrawn', projectId,
    });
    const out = await curationApply({ citationId: proposal.id, projectId });
    expect(out).toMatch(/replacement .* no longer live/i);
    const oldRow = await admin.query<{ still_valid: boolean }>(
      `SELECT still_valid FROM code_decisions WHERE id=$1`, [old]
    );
    expect(oldRow.rows[0].still_valid).toBe(true);
    const citation = await admin.query<{ status: string }>(
      `SELECT status FROM memory_citations WHERE id=$1`, [proposal.id]
    );
    expect(citation.rows[0].status).toBe('proposed');
  });

  it('UNDO restores a retired target AND reopens its applied agent proposal atomically', async () => {
    const id = await seedDecision({ description: 'proposal restored by undo' });
    const { retractFromAgent, curationRetire, curationUnretire, curationProposals } =
      await import('../curation.js');
    await retractFromAgent({ decisionId: id, reason: 'agent evidence here', propose: true });
    await curationRetire({ targetKind: 'decision', targetId: id, reason: 'operator agreed', projectId });
    expect(await curationProposals(projectId, 50)).toHaveLength(0);
    await curationUnretire({ targetKind: 'decision', targetId: id, projectId });
    const target = await admin.query<{ still_valid: boolean }>(
      `SELECT still_valid FROM code_decisions WHERE id=$1`, [id]);
    expect(target.rows[0].still_valid).toBe(true);
    const candidate = await admin.query<{ status: string; resolved_at: Date | null }>(
      `SELECT status,resolved_at FROM curation_candidates WHERE project_id=$1 AND target_id=$2`,
      [projectId, id]);
    expect(candidate.rows[0]).toMatchObject({ status: 'open', resolved_at: null });
    expect(await curationProposals(projectId, 50)).toHaveLength(1);
  });

  it('a RETIRE that retires nothing leaves the proposal OPEN — bookkeeping never outruns the mutation', async () => {
    const { curationRetire, curationProposals } = await import('../curation.js');
    // A decision owned by ANOTHER project: the retire matches zero rows.
    // decisionRetract RETURNS a "No decision with id ..." message rather than
    // throwing, so nothing raises here — which is exactly why the guard has to
    // be retireTarget's returned null and not a try/catch, and why wrapping the
    // pair in a transaction alone would not have been enough.
    const foreign = await seedDecision({ project: otherId, description: 'a decision owned by another project' });
    await admin.query(
      `INSERT INTO curation_candidates (project_id,target_kind,target_id,basis,evidence,proposed_by)
       VALUES ($1,'decision',$2,'agent-evidence','agent evidence here','tester@vitest')`,
      [projectId, foreign]
    );
    expect(await curationProposals(projectId, 50)).toHaveLength(1);
    const out = await curationRetire({
      targetKind: 'decision', targetId: foreign, reason: 'operator agrees', projectId,
    });
    expect(out).toMatch(/nothing retired/);
    // The question the operator was asked is STILL open — a verdict must never
    // close a proposal it did not act on.
    const rows = await admin.query<{ status: string }>(
      `SELECT status FROM curation_candidates WHERE project_id = $1 AND target_id = $2`,
      [projectId, foreign]
    );
    expect(rows.rows[0].status).toBe('open');
    expect(await curationProposals(projectId, 50)).toHaveLength(1);
    // ...and the other project's decision is untouched (iron rule 2).
    const after = await admin.query<{ still_valid: boolean }>(
      `SELECT still_valid FROM code_decisions WHERE id = $1`, [foreign]);
    expect(after.rows[0].still_valid).toBe(true);
  });
});
// ---------- §5.1 / §5.2 surfaces ----------

describe('review queue + prime line (spec §5.1/§5.2)', () => {
  it("returns kind:'curation' alongside decision and fact rows", async () => {
    const { CURATION_WINDOW_DAYS } = await import('../curation.js');
    await seedDecision({ description: 'low confidence triage row', source: 'agent-inferred' });
    const stale = await seedDecision({ description: 'old unused row', ageDays: CURATION_WINDOW_DAYS + 10 });
    const { reviewQueueRows } = await import('../decisions.js');
    const rows = await reviewQueueRows(30, projectId);
    const kinds = new Set(rows.map((r) => r.kind));
    expect(kinds.has('decision')).toBe(true);
    expect(kinds.has('curation')).toBe(true);
    // `some`, not "the first curation row": the ORDER BY puts surfaced_count
    // DESC ahead of created_at ASC, so a pre-existing GLOBAL lesson with any
    // surfacings would outrank the seeded row and this would fail on a brain
    // nobody touched (pass-3 finding 991e7f3d).
    expect(rows.some((r) => r.kind === 'curation' && r.curation.targetId === stale)).toBe(true);
  });

  it('respects `limit` EXACTLY and never starves curation behind a long decision queue', async () => {
    const { CURATION_WINDOW_DAYS } = await import('../curation.js');
    for (let i = 0; i < 20; i++) {
      await seedDecision({ description: `triage row ${i}`, source: 'agent-inferred' });
    }
    for (let i = 0; i < 5; i++) {
      await seedDecision({ description: `old unused ${i}`, ageDays: CURATION_WINDOW_DAYS + 10 });
    }
    const { reviewQueueRows } = await import('../decisions.js');
    const rows = await reviewQueueRows(6, projectId);
    expect(rows).toHaveLength(6);
    expect(rows.filter((r) => r.kind === 'curation').length).toBeGreaterThan(0);
  });

  it('limit=1 with only curation returns exactly one curation row', async () => {
    const { CURATION_WINDOW_DAYS } = await import('../curation.js');
    await seedDecision({ description: 'only old unused', ageDays: CURATION_WINDOW_DAYS + 10 });
    const { reviewQueueRows } = await import('../decisions.js');
    const rows = await reviewQueueRows(1, projectId);
    expect(rows).toHaveLength(1);
    expect(rows[0].kind).toBe('curation');
  });

  it('limit=1 mixed queue keeps the explicit no-starvation contract: curation wins the one slot', async () => {
    const { CURATION_WINDOW_DAYS } = await import('../curation.js');
    await seedDecision({ description: 'triage at limit one', source: 'agent-inferred' });
    await seedDecision({ description: 'curation at limit one', ageDays: CURATION_WINDOW_DAYS + 10 });
    const { reviewQueueRows } = await import('../decisions.js');
    const rows = await reviewQueueRows(1, projectId);
    expect(rows).toHaveLength(1);
    expect(rows[0].kind).toBe('curation');
  });

  it('the markdown labels curation actions DISTINCTLY — never the promote/retract wording', async () => {
    const { CURATION_WINDOW_DAYS } = await import('../curation.js');
    await seedDecision({ description: 'old unused row', ageDays: CURATION_WINDOW_DAYS + 10 });
    const { reviewQueue } = await import('../decisions.js');
    const md = await reviewQueue(30, projectId);
    expect(md).toContain('[curation/never-surfaced]');
    expect(md).toContain('Keep entry');
    expect(md).toContain('Retire entry');
    // The curation lines must not reuse promote/retract vocabulary — an
    // operator's muscle memory is exactly what retires good memory (§5.1).
    const curationLines = md.split('\n').filter((l) => l.includes('actions:'));
    expect(curationLines.length).toBeGreaterThan(0);
    for (const l of curationLines) {
      expect(l).not.toContain('mai_promote');
      expect(l).not.toContain('mai_retract');
    }
  });

  it('a GLOBAL lesson row carries the badge AND the every-project consequence in the markdown', async () => {
    const { CURATION_WINDOW_DAYS, GLOBAL_CONSEQUENCE } = await import('../curation.js');
    await seedLesson({
      project: null, rule: 'plan22-global unused rule', ageDays: CURATION_WINDOW_DAYS + 10,
    });
    const { reviewQueue } = await import('../decisions.js');
    const md = await reviewQueue(30, projectId);
    expect(md).toContain('**GLOBAL**');
    expect(md).toContain(GLOBAL_CONSEQUENCE);
  });

  it('the JSON payload the dashboard reads carries globalNote AND the action labels', async () => {
    const { CURATION_WINDOW_DAYS, GLOBAL_CONSEQUENCE } = await import('../curation.js');
    await seedLesson({
      project: null, rule: 'plan22-global unused rule', ageDays: CURATION_WINDOW_DAYS + 10,
    });
    const { reviewQueueRows } = await import('../decisions.js');
    const row = (await reviewQueueRows(30, projectId)).find((r) => r.kind === 'curation');
    expect(row).toBeDefined();
    if (!row || row.kind !== 'curation') throw new Error('no curation row');
    expect(row.curation.isGlobal).toBe(true);
    expect(row.curation.globalNote).toBe(GLOBAL_CONSEQUENCE);
    expect(row.curation.approveLabel).toBe('Keep entry');
    expect(row.curation.approveAction).toBe('keep');
    expect(row.curation.denyLabel).toBe('Retire entry');
    expect(row.curation.denyAction).toBe('retire');
    expect(row.keywords).toContain('GLOBAL');
  });

  it('approve/deny INVERT between curation sub-kinds — prune vs supersede proposal (§5.1)', async () => {
    const { curationCards } = await import('../curation.js');
    const oldA = await seedDecision({ description: 'zebra hydration protocol baseline' });
    await searchFor('zebra hydration protocol', 'decisions');
    const { decisionAdd } = await import('../decisions.js');
    await decisionAdd({
      citation: { kind: 'supersedes', supersedes_id: oldA, reason: 'measured wrong' },
      decisionType: 'arch', description: 'zebra hydration protocol, measured version',
    });
    const cards = await curationCards(projectId, 30);
    const sup = cards.find((c) => c.citationId !== null);
    expect(sup?.approveAction).toBe('apply');
    expect(sup?.approveLabel).toBe('Apply supersession');
    expect(sup?.denyAction).toBe('dismiss');
    expect(sup?.replacementSummary).toContain('measured version');
  });

  /** GLOBAL lessons belong to no project, so `resetRows` and the afterAll
   * cascade cannot reach them — and spec §10.3 deliberately puts every global
   * in EVERY project's candidate set, including this throwaway one. So the
   * operator's own globals legitimately count here. These three cases are
   * therefore written against a BASELINE captured after reset, never against an
   * absolute zero: pinned absolutely they pass today only because the live
   * brain happens to hold two one-day-old globals, and would start failing
   * about a window after the migration ran, on a brain nobody touched
   * (pass-3 finding 991e7f3d). The candidacy cases above are unaffected —
   * they assert on seeded ids, not on counts. */
  it('the prime line always agrees with curationCounts — and is null EXACTLY when all three are zero', async () => {
    const { primeCurationSection, curationCounts } = await import('../curation.js');
    const { candidates, proposals, graduations } = await curationCounts(projectId);
    const line = await primeCurationSection(projectId);
    // R10's real contract: the line can never advertise a queue that isn't
    // there, because it is built from this same predicate.
    if (candidates === 0 && proposals === 0 && graduations === 0) {
      expect(line).toBeNull();
    } else {
      expect(line).not.toBeNull();
      if (candidates > 0) expect(line).toContain(`${candidates} prune candidate`);
      if (graduations > 0) expect(line).toContain(`${graduations} graduation candidate`);
      if (proposals > 0) expect(line).toContain(`${proposals} proposal`);
    }
  });

  it('a graduation-only delta changes the shared count and prime line', async () => {
    const { curationCounts, primeCurationSection, GRADUATION_REINFORCEMENTS } = await import('../curation.js');
    const before = await curationCounts(projectId);
    const id = await seedLesson({ rule: 'plan22 graduation count' });
    await admin.query(`UPDATE lessons SET relearned_count = $2 WHERE id = $1`, [id, GRADUATION_REINFORCEMENTS]);
    const after = await curationCounts(projectId);
    expect(after).toEqual({
      candidates: before.candidates,
      proposals: before.proposals,
      graduations: before.graduations + 1,
    });
    expect(await primeCurationSection(projectId)).toContain(
      `${after.graduations} graduation candidate`
    );
  });

  it('seeding old uncited entries moves the count by exactly that many, correctly pluralized', async () => {
    const { CURATION_WINDOW_DAYS, primeCurationSection, curationCounts } = await import('../curation.js');
    const base = (await curationCounts(projectId)).candidates;
    await seedDecision({ description: 'old unused one', ageDays: CURATION_WINDOW_DAYS + 10 });
    expect((await curationCounts(projectId)).candidates).toBe(base + 1);
    const single = await primeCurationSection(projectId);
    expect(single).toContain(`${base + 1} prune candidate${base + 1 === 1 ? '' : 's'}`);
    if (base + 1 === 1) expect(single).not.toContain('1 prune candidates');
    expect(single).toContain('mai_review');
    await seedDecision({ description: 'old unused two', ageDays: CURATION_WINDOW_DAYS + 10 });
    expect((await curationCounts(projectId)).candidates).toBe(base + 2);
    expect(await primeCurationSection(projectId)).toContain(`${base + 2} prune candidates`);
  });

  it('the prime line counts proposals separately from candidates', async () => {
    const { primeCurationSection, retractFromAgent, curationCounts } = await import('../curation.js');
    const base = await curationCounts(projectId);
    const id = await seedDecision({ description: 'agent wants this gone' });
    await retractFromAgent({ decisionId: id, reason: 'agent evidence here', propose: true });
    const after = await curationCounts(projectId);
    // The proposal moved ONLY the proposal count — a fresh decision is not a
    // prune candidate, so the candidate side must be untouched.
    expect(after.proposals).toBe(base.proposals + 1);
    expect(after.candidates).toBe(base.candidates);
    expect(await primeCurationSection(projectId)).toContain(`${after.proposals} proposal`);
  });
});
// ---------- §9 the guarantees, as tests ----------

/** A fingerprint over EVERY column a curation verdict is allowed to move.
 * If a background pass changes any of them, this string changes. */
async function memoryFingerprint(): Promise<string> {
  const r = await admin.query<{ fp: string }>(
    `SELECT md5(coalesce(string_agg(x, '|' ORDER BY x), '')) AS fp FROM (
        SELECT d.id::text || ':' || d.still_valid::text || ':' ||
               coalesce(d.retracted_at::text,'-') || ':' || d.confidence::text || ':' || d.source AS x
          FROM code_decisions d WHERE d.project_id = $1
        UNION ALL
        SELECT l.id::text || ':' || l.confidence_score::text || ':' ||
               l.reinforcement_count::text || ':' || coalesce(l.retired_at::text,'-') ||
               ':' || coalesce(l.superseded_by::text,'-')
          FROM lessons l WHERE l.project_id = $1 OR l.project_id IS NULL
      ) q`,
    [projectId]
  );
  return r.rows[0].fp;
}

describe('THE guarantee: nothing auto-applies (spec §9/§12)', () => {
  it('the real segmented ingest + temporary-root docs sweep + Stop/prime/queue cycle changes NOTHING', async () => {
    const { CURATION_WINDOW_DAYS, retractFromAgent, curationRetire } = await import('../curation.js');
    // Seed every shape of open proposal + a telemetry candidate.
    const stale = await seedDecision({ description: 'old unused row', ageDays: CURATION_WINDOW_DAYS + 10 });
    const wanted = await seedDecision({ description: 'agent wants this gone' });
    await retractFromAgent({ decisionId: wanted, reason: 'agent evidence here', propose: true });
    const oldA = await seedDecision({ description: 'zebra hydration protocol baseline' });
    await searchFor('zebra hydration protocol', 'decisions');
    const { decisionAdd } = await import('../decisions.js');
    await decisionAdd({
      citation: { kind: 'supersedes', supersedes_id: oldA, reason: 'measured wrong' },
      decisionType: 'arch', description: 'zebra hydration protocol, measured version',
    });
    await seedLesson({ project: null, rule: 'plan22-global unused rule', ageDays: CURATION_WINDOW_DAYS + 10 });

    const before = await memoryFingerprint();

    // Drive the actual automatic lane with no network/model: a real transcript
    // goes through ingestTranscriptSegmented/persistParsedSession; a real
    // temporary registered docs root is swept; the Stop logic claims/renders;
    // then prime and both queue forms read. Derived sessions/chunks may change,
    // but curated liveness/content above may not.
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'mai-plan22-auto-'));
    const transcript = path.join(root, 'session.jsonl');
    const planDir = path.join(root, 'docs', 'superpowers', 'plans');
    fs.mkdirSync(planDir, { recursive: true });
    fs.writeFileSync(path.join(planDir, 'automatic.md'), '# Automatic lane\n\nNo verdict here.\n');
    fs.writeFileSync(
      transcript,
      Array.from({ length: 120 }, (_, i) =>
        JSON.stringify({
          type: 'assistant', timestamp: `2026-08-12T00:${String(i % 60).padStart(2, '0')}:00Z`,
          message: { content: [{ type: 'thinking', thinking: `event ${i}` }] },
        })
      ).join('\n') + '\n'
    );
    try {
      await admin.query(
        `UPDATE projects SET path=$2, metadata=jsonb_build_object('repos',jsonb_build_array($2::text))
          WHERE id=$1`, [projectId, root]
      );
      const { ClaudeCodeAdapter } = await import('../capture/claude-code.js');
      const { ingestTranscriptSegmented } = await import('../capture/segment-ingest.js');
      await ingestTranscriptSegmented(
        new ClaudeCodeAdapter(),
        { path: transcript, transcriptId: 'plan22-auto', harness: 'claude-code', cwd: root }
      );
      const { runDocsSweep } = await import('../scripts/docs-sweep.js');
      expect(await runDocsSweep()).toMatch(/1 doc\(s\) seen/);
      const { claimNudge, nudgeOutput, transcriptIsSubstantial } = await import('../scripts/stop-nudge.js');
      expect(transcriptIsSubstantial(transcript)).toBe(true);
      expect(claimNudge('plan22-auto', root)).toBe(true);
      expect(nudgeOutput()).toContain('Stop');
      const { prime } = await import('../prime.js');
      await prime('curation loops', 'summary');
      const { reviewQueue, reviewQueueRows } = await import('../decisions.js');
      await reviewQueue(50, projectId);
      await reviewQueueRows(50, projectId);
      const { curationCandidates, curationProposals, curationCounts } = await import('../curation.js');
      await curationCandidates(projectId, 50);
      await curationProposals(projectId, 50);
      await curationCounts(projectId);
    } finally {
      await admin.query(`UPDATE projects SET path=NULL, metadata='{}'::jsonb WHERE id=$1`, [projectId]);
      fs.rmSync(root, { recursive: true, force: true });
    }

    expect(await memoryFingerprint()).toBe(before);

    // NEGATIVE CONTROL: the fingerprint must be sensitive enough to catch a
    // real change — otherwise the assertion above proves nothing.
    await curationRetire({
      targetKind: 'decision', targetId: stale, reason: 'an OPERATOR acted', projectId,
    });
    expect(await memoryFingerprint()).not.toBe(before);
  });

  it('NO DECAY: 200 days of non-use changes confidence, confidence_score and the counts not at all', async () => {
    const decision = await seedDecision({ description: 'a rule that fires once every two years', ageDays: 200 });
    const lesson = await seedLesson({ rule: 'never point the brain at port 55444', ageDays: 200, confidence: 0.90 });
    const snap = async () => {
      const d = await admin.query<{ confidence: number; reinforcement_count: number }>(
        `SELECT confidence, reinforcement_count FROM code_decisions WHERE id = $1`, [decision]);
      const l = await admin.query<{ confidence_score: string; reinforcement_count: number }>(
        `SELECT confidence_score, reinforcement_count FROM lessons WHERE id = $1`, [lesson]);
      return JSON.stringify([d.rows[0], l.rows[0]]);
    };
    const before = await snap();
    // Age is not wrongness. Reading, priming and queueing an aged entry must
    // never move a score — staleness raises a QUESTION, never a silent change.
    const { unifiedSearch } = await import('../decisions.js');
    await unifiedSearch({ query: 'port 55444 two years', kind: 'all' });
    const { prime } = await import('../prime.js');
    await prime('an unrelated task', 'summary');
    const { reviewQueueRows } = await import('../decisions.js');
    await reviewQueueRows(50, projectId);
    expect(await snap()).toBe(before);
  });
});

describe('budgeted curation envelope line (plan 38)', () => {
  it('keeps all three queues, bounds every count, and maxes at exactly 73 chars', async () => {
    const { renderCurationPrimeEnvelopeLine, CURATION_LINE_MAX } = await import('../curation.js');
    expect(CURATION_LINE_MAX).toBe(73);

    const zero = renderCurationPrimeEnvelopeLine({ candidates: 0, proposals: 0, graduations: 0 });
    expect(zero).toBe('_Curation: prune 0; graduate 0; proposals 0 — mai_review._');
    const one = renderCurationPrimeEnvelopeLine({ candidates: 1, proposals: 1, graduations: 1 });
    expect(one).toBe('_Curation: prune 1; graduate 1; proposals 1 — mai_review._');

    const max = renderCurationPrimeEnvelopeLine({
      candidates: 999_999, proposals: 999_999, graduations: 999_999,
    });
    expect(max).toBe('_Curation: prune 999999; graduate 999999; proposals 999999 — mai_review._');
    expect(max).toHaveLength(CURATION_LINE_MAX);
    expect(max).toContain('mai_review');

    const over = renderCurationPrimeEnvelopeLine({
      candidates: 1_000_000, proposals: 1_000_000, graduations: 1_000_000,
    });
    expect(over).toBe('_Curation: prune ≥1M; graduate ≥1M; proposals ≥1M — mai_review._');
    expect(over.length).toBeLessThanOrEqual(CURATION_LINE_MAX);

    const invalid = renderCurationPrimeEnvelopeLine({
      candidates: Number.NaN, proposals: -1, graduations: Number.MAX_SAFE_INTEGER + 2,
    });
    expect(invalid).toBe('_Curation: prune ?; graduate ?; proposals ? — mai_review._');
    expect(invalid.length).toBeLessThanOrEqual(CURATION_LINE_MAX);
  });

  it('the unbudgeted prose form and the null-on-clean contract are unchanged', async () => {
    const { primeCurationSection } = await import('../curation.js');
    const line = await primeCurationSection(projectId);
    if (line !== null) {
      expect(line.startsWith('_Curation: ')).toBe(true);
      expect(line).toContain('awaiting your review — mai_review._');
      const budgeted = await primeCurationSection(projectId, true);
      expect(budgeted).not.toBeNull();
      expect(budgeted).toMatch(/^_Curation: prune /);
      expect((budgeted ?? '').length).toBeLessThanOrEqual(73);
    }
  });
});
