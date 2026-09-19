/** Local-embeddings tier: detection, tagging, mismatch filtering, rebuild,
 * consent. Default suite uses the FAKE embedder — no model download/network;
 * the explicitly gated final describe resets to the real pipeline. */
import { beforeAll, afterAll, beforeEach, afterEach, describe, expect, it } from 'vitest';
import fs from 'node:fs'; // readFileSync for the real migration file — os/path were unused (pass-6 N2)
import { Pool } from 'pg';

process.env.MAI_PROJECT_SLUG = 'emb-local-test';
process.env.MAI_DB_URL =
  process.env.MAI_DB_URL ?? 'postgresql://postgres:postgres@127.0.0.1:54334/mai_brain';
process.env.MAI_LLM_SUMMARY = '0';

const admin = new Pool({ connectionString: process.env.MAI_DB_URL });
const saved: Record<string, string | undefined> = {};

/** Deterministic 384-dim fake vector; distinct texts → low cosine, same → 1. */
function fakeVec(text: string): number[] {
  const v = new Array(384).fill(0);
  for (let i = 0; i < text.length; i++) v[(text.charCodeAt(i) * 31 + i) % 384] += 1;
  return v;
}

beforeAll(async () => {
  // Dotenv defusal (plan-13 P2-B1) — MUST import a module whose graph reaches
  // src/env.ts (pass-4 W10: embeddings.ts imports only openai + builtins, so
  // importing it defused nothing; env.js first loaded mid-test via lessons.js
  // → db.js, inside the exact refill window the comment claimed to close).
  await import('../db.js');
  for (const k of ['MAI_EMBEDDINGS', 'OPENAI_API_KEY', 'VOYAGE_API_KEY']) saved[k] = process.env[k];
  await admin.query(`DELETE FROM projects WHERE slug = 'emb-local-test'`);
  await admin.query(`INSERT INTO projects (slug, name) VALUES ('emb-local-test', 'Emb Local Test')`);
});
afterAll(async () => {
  const { setLocalEmbedderForTests } = await import('../embeddings.js');
  setLocalEmbedderForTests(null); // symmetry with llm-consent.test.ts (pass-5 N4)
  for (const [k, v] of Object.entries(saved)) {
    if (v === undefined) delete process.env[k]; else process.env[k] = v;
  }
  await admin.query(`DELETE FROM projects WHERE slug = 'emb-local-test'`);
  await admin.query(`DELETE FROM lessons WHERE rule LIKE 'EMBTEST %'`);
  await admin.end();
  const { getPool } = await import('../db.js');
  await getPool().end();
});
beforeEach(async () => {
  process.env.MAI_EMBEDDINGS = '1';
  delete process.env.OPENAI_API_KEY;
  delete process.env.VOYAGE_API_KEY;
  const { setLocalEmbedderForTests } = await import('../embeddings.js');
  setLocalEmbedderForTests(async (t) => fakeVec(t));
});

describe('tier detection + model ids', () => {
  it('keyless → local; openai key wins; disabled → null', async () => {
    const { currentEmbeddingModelId } = await import('../embeddings.js');
    expect(currentEmbeddingModelId()).toBe('local:bge-small-en-v1.5');
    process.env.OPENAI_API_KEY = 'sk-test';
    expect(currentEmbeddingModelId()).toBe('openai:text-embedding-3-small');
    process.env.MAI_EMBEDDINGS = '0';
    delete process.env.OPENAI_API_KEY;
    expect(currentEmbeddingModelId()).toBeNull();
  });
  it('embed() routes to the injected local embedder and caches', async () => {
    const { embed } = await import('../embeddings.js');
    const v = await embed('hello world');
    expect(v).toHaveLength(384);
    expect(await embed('hello world')).toEqual(v);
  });
  it('embedQuery adds the BGE instruction locally while raw embed does not', async () => {
    const { embed, embedQuery, LOCAL_QUERY_PREFIX, setLocalEmbedderForTests } =
      await import('../embeddings.js');
    const seen: string[] = [];
    setLocalEmbedderForTests(async (text) => {
      seen.push(text);
      return fakeVec(text);
    });
    await embed('stored passage');
    await embedQuery('retrieval query');
    expect(seen).toEqual(['stored passage', `${LOCAL_QUERY_PREFIX}retrieval query`]);
  });
  it('hybrid result budgeting is globally capped and reserves stale visibility', async () => {
    const { budgetHybridHits } = await import('../embeddings.js');
    expect(budgetHybridHits(['s1', 's2'], ['t1', 't2'], 2)).toEqual({
      semantic: ['s1'], stale: ['t1'],
    });
    expect(budgetHybridHits(['s1'], ['t1'], 1)).toEqual({
      semantic: ['s1'], stale: [],
    });
    expect(budgetHybridHits(['s1'], [], 1)).toEqual({
      semantic: ['s1'], stale: [],
    });
  });
});

describe('bounded model load (pass-5 B2)', () => {
  // The real initLocal() bound cannot be exercised without a model, so the
  // BOUND ITSELF is the unit under test — a verification that never faces a
  // never-resolving promise cannot detect the hang it guards (lesson 5ce0fadd).
  it('withTimeout rejects instead of waiting forever', async () => {
    const { withTimeout } = await import('../embeddings.js');
    await expect(
      withTimeout(new Promise<never>(() => {}), 50, 'local model load')
    ).rejects.toThrow(/local model load exceeded 50ms/);
  });
  it('withTimeout passes a resolved value straight through', async () => {
    const { withTimeout } = await import('../embeddings.js');
    await expect(withTimeout(Promise.resolve(7), 5_000, 'x')).resolves.toBe(7);
  });
  it('a REJECTING embedder yields null, never a thrown tool error (pass-7 B2)', async () => {
    // Inference failure, not load failure — the case only the local tier left
    // unguarded. embed() must honour its null contract exactly as the OpenAI
    // and Voyage branches do, or mai_lesson_add/mai_search surface a crash
    // instead of degrading to trigram.
    const { setLocalEmbedderForTests, embed, embeddingsStatus } = await import('../embeddings.js');
    setLocalEmbedderForTests(async () => { throw new Error('onnx forward pass exploded'); });
    await expect(embed('inference blows up')).resolves.toBeNull();
    expect(embeddingsStatus()).toContain('failed to embed');
  });
  it('a non-Error rejection cannot escape the embed() null contract (pass-9 B2)', async () => {
    const { setLocalEmbedderForTests, embed, embeddingsStatus } = await import('../embeddings.js');
    setLocalEmbedderForTests(async () => { throw 'onnx worker terminated'; });
    await expect(embed('non-error rejection')).resolves.toBeNull();
    expect(embeddingsStatus()).toContain('failed to embed');
  });
});

describe('transition population — flag flip on an unembedded corpus (pass-4 B6/B7)', () => {
  // The state of EVERY existing install the moment consent defaults to Yes:
  // tier enabled, zero rows carry the current tag. Search must degrade to
  // trigram, dedup must still reinforce — neither may go dark. MUST run
  // before the tagging/rebuild describes below (they create current-tag rows
  // that would satisfy the semantic branch and mask the fall-through).
  it('mai_search decisions branch falls through to trigram (B6)', async () => {
    const pid = (await admin.query(`SELECT id FROM projects WHERE slug='emb-local-test'`)).rows[0].id;
    // Project-scoped lane: clear it so ZERO current-tag rows exist in scope
    // (fixture rows only — this is the throwaway project).
    await admin.query(`DELETE FROM code_decisions WHERE project_id = $1`, [pid]);
    await admin.query(
      `INSERT INTO code_decisions (project_id, decision_type, description)
       VALUES ($1,'testing','EMBTEST transition trigram-findable decision')`, [pid]);
    const { unifiedSearch } = await import('../decisions.js');
    const out = await unifiedSearch({ query: 'transition trigram-findable', kind: 'decisions', projectId: pid });
    expect(out).toContain('trigram-findable decision'); // pre-fix: the rebuild-hint message, zero hits
  });
  it('mai_search decisions falls through when embed() returns null (pass-5 B1)', async () => {
    // The OTHER unavailable state: dep resolvable, tier reports enabled, but
    // the model will not load — exactly what downloadNow() leaves behind when
    // the init-time fetch fails and MAI_EMBEDDINGS=1 stays in .env. Reuses the
    // fixture row from the test above (vitest runs a describe's tests in order).
    const { setLocalEmbedderForTests, embeddingsEnabled } = await import('../embeddings.js');
    setLocalEmbedderForTests(async () => null);
    expect(embeddingsEnabled()).toBe(true); // the trap: "enabled" yet unusable
    const pid = (await admin.query(`SELECT id FROM projects WHERE slug='emb-local-test'`)).rows[0].id;
    const { unifiedSearch } = await import('../decisions.js');
    const out = await unifiedSearch({ query: 'transition trigram-findable', kind: 'decisions', projectId: pid });
    expect(out).toContain('trigram-findable decision'); // pre-fix: "Failed to embed query."
  });
  it('mai_search decisions falls through on a threshold miss (pass-6 B2)', async () => {
    // The THIRD non-answer: tag correct, embedder working, nothing clears the
    // 0.25 cosine floor. Orthogonal one-hot vectors make the score exactly 0 —
    // provable, not "probably low", so this cannot pass by luck.
    const { setLocalEmbedderForTests } = await import('../embeddings.js');
    const oneHot = (i: number) => { const v = new Array(384).fill(0); v[i] = 1; return v; };
    setLocalEmbedderForTests(async () => oneHot(0));
    const pid = (await admin.query(`SELECT id FROM projects WHERE slug='emb-local-test'`)).rows[0].id;
    await admin.query(`DELETE FROM code_decisions WHERE project_id = $1`, [pid]);
    await admin.query(
      `INSERT INTO code_decisions (project_id, decision_type, description, embedding, embedding_model)
       VALUES ($1,'testing','EMBTEST zzz orthogonal marker decision', $2, 'local:bge-small-en-v1.5')`,
      [pid, oneHot(1)]); // cosine(e0, e1) === 0 — well under minScore 0.25
    const { unifiedSearch } = await import('../decisions.js');
    const out = await unifiedSearch({ query: 'orthogonal marker', kind: 'decisions', projectId: pid });
    expect(out).toContain('orthogonal marker decision'); // pre-fix: "No decisions above similarity threshold 0.25"
  });
  it('lessonSearch falls through to trigram when nothing scores (B6)', async () => {
    // Lessons are GLOBAL and this machine may carry REAL current-tag vectors
    // (post-fleet-rebuild) — pin the candidate pool to a fixture tag so both
    // branches see only rows this test controls, deterministic on any machine.
    await admin.query(
      `INSERT INTO lessons (rule, tags) VALUES ('EMBTEST transition searchable untagged lesson', '{embtest-transition}')`);
    const { lessonSearch } = await import('../lessons.js');
    const out = await lessonSearch({ query: 'transition searchable untagged', tags: ['embtest-transition'] });
    expect(out).toContain('EMBTEST transition searchable untagged lesson'); // pre-fix: "No lessons match"
  });
  it('lessonAdd still dedups via trigram when no candidate is comparable (B7)', async () => {
    // Rule text distinctive enough that no REAL lesson reaches the trgm-0.50
    // candidate pool — only the identical fixture row does.
    await admin.query(`INSERT INTO lessons (rule) VALUES ('EMBTEST zq transition dedup reinforcement target rule xv')`);
    const gate = await import('../write-gate.js');
    await gate.recordReadResults('lessons', []);
    const { lessonAdd } = await import('../lessons.js');
    const out = await lessonAdd({
      rule: 'EMBTEST zq transition dedup reinforcement target rule xv', // identical text → trgm 1.0 ≥ 0.80
      citation: { kind: 'novel', justification: 'plan-14 transition-state fixture — dedup must reinforce, not duplicate, when no vector is comparable' },
    });
    expect(out).toContain('Reinforced existing lesson'); // pre-fix: inserts a duplicate row
  });
});

describe('mixed corpus — current-tag and stale rows side by side (pass-7 B1)', () => {
  // A PARTIALLY rebuilt corpus, which is durable, not transient: rebuild's
  // `unembeddable` rows stay stale until someone re-runs it, and spec §7 lists
  // an interrupted rebuild as a supported state. Every test here has a
  // current-tag distractor that makes the semantic branch "succeed" — the exact
  // condition under which the earlier all-or-nothing fall-through dropped the
  // stale rows entirely.
  const oneHot = (i: number) => { const v = new Array(384).fill(0); v[i] = 1; return v; };

  it('decisions search merges stale trigram hits with semantic hits', async () => {
    const pid = (await admin.query(`SELECT id FROM projects WHERE slug='emb-local-test'`)).rows[0].id;
    await admin.query(`DELETE FROM code_decisions WHERE project_id = $1`, [pid]);
    const { setLocalEmbedderForTests } = await import('../embeddings.js');
    setLocalEmbedderForTests(async () => oneHot(0));
    await admin.query(
      `INSERT INTO code_decisions (project_id, decision_type, description, embedding, embedding_model)
       VALUES ($1,'testing','EMBTEST mixed current distractor row', $2, 'local:bge-small-en-v1.5'),
              ($1,'testing','EMBTEST mixed stale exact phrase row', $3, 'openai:text-embedding-3-small')`,
      [pid, oneHot(0), new Array(1536).fill(0.1)]); // distractor cosine 1.0 → semantic "succeeds"
    const { unifiedSearch } = await import('../decisions.js');
    const out = await unifiedSearch({ query: 'mixed stale exact phrase', kind: 'decisions', projectId: pid, limit: 2 });
    expect(out).toContain('mixed stale exact phrase row'); // pre-fix: dropped entirely
    expect(out).toContain('not yet re-embedded');          // labelled, so the rebuild debt is visible
    expect(out.split('\n').filter((line) => line.startsWith('- `'))).toHaveLength(2); // one GLOBAL limit
  });

  it('lessonSearch merges stale trigram hits with semantic hits', async () => {
    const { setLocalEmbedderForTests } = await import('../embeddings.js');
    setLocalEmbedderForTests(async () => oneHot(0));
    await admin.query(
      `INSERT INTO lessons (rule, tags, embedding, embedding_model)
       VALUES ('EMBTEST mixed lesson current distractor', '{embtest-mixed}', $1, 'local:bge-small-en-v1.5'),
              ('EMBTEST mixed lesson stale exact phrase', '{embtest-mixed}', $2, 'openai:text-embedding-3-small')`,
      [oneHot(0), new Array(1536).fill(0.1)]);
    const { lessonSearch } = await import('../lessons.js');
    const out = await lessonSearch({ query: 'mixed lesson stale exact phrase', tags: ['embtest-mixed'], limit: 2 });
    expect(out).toContain('EMBTEST mixed lesson stale exact phrase'); // pre-fix: dropped
    expect(out).toContain('not yet re-embedded');
    expect(out.split('\n').filter((line) => line.startsWith('- `'))).toHaveLength(2); // never 2 × limit
  });

  it('lessonSearch never trigram-prefilters current semantic candidates', async () => {
    // 60 stale lexical distractors exceed widePool=50. The current row has low
    // lexical overlap but a perfect fake cosine. A single trigram-ordered pool
    // drops it before scoring; independent retrieval must keep it.
    const { setLocalEmbedderForTests } = await import('../embeddings.js');
    setLocalEmbedderForTests(async () => oneHot(17));
    await admin.query(`DELETE FROM lessons WHERE tags && '{embtest-recall}'::text[]`);
    await admin.query(
      `INSERT INTO lessons (rule, tags, embedding, embedding_model)
       VALUES ('EMBTEST semantic-only riverbed target', '{embtest-recall}', $1, 'local:bge-small-en-v1.5')`,
      [oneHot(17)]
    );
    for (let i = 0; i < 60; i++) {
      await admin.query(
        `INSERT INTO lessons (rule, tags) VALUES ($1, '{embtest-recall}')`,
        [`EMBTEST lexical bait phrase distractor ${i}`]
      );
    }
    const { lessonSearch } = await import('../lessons.js');
    const out = await lessonSearch({
      query: 'EMBTEST lexical bait phrase', tags: ['embtest-recall'], limit: 2,
    });
    expect(out).toContain('EMBTEST semantic-only riverbed target');
    expect(out.split('\n').filter((line) => line.startsWith('- `'))).toHaveLength(2);
  });

  it('lessonAdd dedups against a STALE exact match despite a current-tag distractor', async () => {
    // The sharpest case: `comparable` was true (the distractor carries a
    // current tag), so the old guard skipped trgm and inserted a duplicate even
    // though an exact match sat at candidates.rows[0] with trgm 1.0.
    const { setLocalEmbedderForTests } = await import('../embeddings.js');
    setLocalEmbedderForTests(async () => oneHot(5)); // orthogonal to the distractor → no cosine match
    const dupRule = 'EMBTEST qh mixed dedup stale exact duplicate rule wz';
    await admin.query(`INSERT INTO lessons (rule) VALUES ($1)`, [dupRule]); // stale: no vector, no tag
    await admin.query(
      `INSERT INTO lessons (rule, embedding, embedding_model)
       VALUES ($1, $2, 'local:bge-small-en-v1.5')`,
      ['EMBTEST qh mixed dedup stale exact duplicate rule zz', oneHot(9)]); // trgm-close distractor
    const gate = await import('../write-gate.js');
    await gate.recordReadResults('lessons', []);
    const { lessonAdd } = await import('../lessons.js');
    const out = await lessonAdd({
      rule: dupRule,
      citation: { kind: 'novel', justification: 'plan-14 mixed-corpus fixture — dedup must find the stale exact match past a current-tag distractor' },
    });
    expect(out).toContain('Reinforced existing lesson'); // pre-fix: inserted a duplicate
  });

  it('lessonAdd never re-accepts a CURRENT row that cosine rejected', async () => {
    // Lexically similar enough for the 0.80 fallback, but provably orthogonal
    // under cosine. The fallback is stale-only after a successful embedding;
    // otherwise it bypasses Task 6's calibrated threshold and reinforces the
    // wrong current-model lesson.
    const { setLocalEmbedderForTests } = await import('../embeddings.js');
    setLocalEmbedderForTests(async () => oneHot(21));
    const candidate = 'EMBTEST qv never reaccept current cosine rejected rule alphaa';
    const incoming = 'EMBTEST qv never reaccept current cosine rejected rule alphab';
    await admin.query(`DELETE FROM lessons WHERE rule = ANY($1::text[])`, [[candidate, incoming]]);
    await admin.query(
      `INSERT INTO lessons (rule, embedding, embedding_model)
       VALUES ($1, $2, 'local:bge-small-en-v1.5')`,
      [candidate, oneHot(22)]
    );
    const lexical = await admin.query<{ sim: number }>(
      `SELECT similarity($1, $2) AS sim`, [candidate, incoming]
    );
    expect(lexical.rows[0].sim).toBeGreaterThanOrEqual(0.80); // prove the old fallback would accept it
    const gate = await import('../write-gate.js');
    await gate.recordReadResults('lessons', []);
    const { lessonAdd } = await import('../lessons.js');
    const out = await lessonAdd({
      rule: incoming,
      citation: { kind: 'novel', justification: 'plan-14 regression fixture — current-tag cosine rejection must not be overridden by lexical fallback' },
    });
    expect(out).toContain('Added lesson');
    expect(out).not.toContain('Reinforced existing lesson');
  });
});

describe('write-path tagging — atomic embed on insert', () => {
  it('lessonAdd embeds + stamps atomically in the INSERT (was a two-step untagged UPDATE)', async () => {
    const { lessonAdd } = await import('../lessons.js');
    // Write-gate: novel citations require a prior search THIS session — a
    // zero-hit search suffices (house pattern, write-gate.test.ts:307).
    const gate = await import('../write-gate.js');
    await gate.recordReadResults('lessons', []);
    await lessonAdd({
      rule: 'EMBTEST lessons get tagged vectors on insert',
      citation: { kind: 'novel', justification: 'plan-14 test fixture — atomic embed+tag on insert (replaces the untagged two-step UPDATE)' },
    });
    const row = await admin.query(
      `SELECT embedding IS NOT NULL AS has_vec, embedding_model FROM lessons WHERE rule LIKE 'EMBTEST lessons get tagged%'`);
    expect(row.rows[0].has_vec).toBe(true);
    expect(row.rows[0].embedding_model).toBe('local:bge-small-en-v1.5');
  });
});

describe('migration dimension backfill (review W5)', () => {
  it('tags pre-existing vectors by dimension; unknown dims stay untagged', async () => {
    const pid = (await admin.query(`SELECT id FROM projects WHERE slug='emb-local-test'`)).rows[0].id;
    await admin.query(
      `INSERT INTO code_decisions (project_id, decision_type, description, embedding)
       VALUES ($1,'testing','EMBTEST backfill 1024', $2),
              ($1,'testing','EMBTEST backfill 1536', $3),
              ($1,'testing','EMBTEST backfill 384',  $4)`,
      [pid, new Array(1024).fill(0.1), new Array(1536).fill(0.1), new Array(384).fill(0.1)]
    );
    // Re-running the REAL migration file IS the test (idempotent by design;
    // duplicating its SQL here would drift). This is an UNSCOPED write to the
    // shared brain (pass-4 N8) — safe because the UPDATEs touch only
    // `embedding IS NOT NULL AND embedding_model IS NULL`, a population that
    // is empty after Task 1 ran (pass-3 verified live count 0) and that the
    // migration itself keeps empty.
    const sql = fs.readFileSync('db/migrations/2026-08-08-embedding-model-tags.sql', 'utf8');
    await admin.query(sql);
    const tags = await admin.query(
      `SELECT description, embedding_model FROM code_decisions
        WHERE description LIKE 'EMBTEST backfill %' ORDER BY description`);
    expect(tags.rows.map((r) => r.embedding_model)).toEqual([
      'voyage:voyage-3',               // 1024
      'openai:text-embedding-3-small', // 1536
      null,                            // 384 without a tag = unknown legacy dim — stays untagged
    ]);
  });
});

describe('read-path mismatch filtering', () => {
  it('decisionsSimilar sees only current-model rows; mismatched are invisible to semantic scoring', async () => {
    const pid = (await admin.query(`SELECT id FROM projects WHERE slug='emb-local-test'`)).rows[0].id;
    // Retrieval now uses a query-only BGE prefix. Keep this filtering test
    // independent of fakeVec's lexical hashing by making both local sides the
    // same controlled direction; the stale 1536d row remains incomparable.
    const currentVec = new Array(384).fill(0);
    currentVec[31] = 1;
    const { setLocalEmbedderForTests } = await import('../embeddings.js');
    setLocalEmbedderForTests(async () => currentVec);
    await admin.query(
      `INSERT INTO code_decisions (project_id, decision_type, description, embedding, embedding_model)
       VALUES ($1,'testing','EMBTEST current-model row', $2, 'local:bge-small-en-v1.5'),
              ($1,'testing','EMBTEST stale openai row', $3, 'openai:text-embedding-3-small')`,
      [pid, currentVec, new Array(1536).fill(0.1)]
    );
    const { decisionsSimilar } = await import('../decisions.js');
    const out = await decisionsSimilar({ query: 'EMBTEST current-model row', projectId: pid, minScore: 0.1 });
    expect(out).toContain('current-model row');
    expect(out).not.toContain('stale openai row'); // 1536-dim row would have silently scored 0 before
  });
});

describe('rebuild', () => {
  it('re-embeds mismatched rows; idempotent; NEVER touches real lessons (review B2)', async () => {
    // Lessons are GLOBAL: without the lessonRuleLike seam this test would
    // fakeVec every real lesson in the shared brain and tag it current —
    // silent, durable corruption of the curated layer. The seam is MANDATORY
    // in tests; the blast-radius guard below proves it held.
    await admin.query(
      `INSERT INTO lessons (rule, embedding, embedding_model)
       VALUES ('EMBTEST stale-tag lesson', $1, 'openai:text-embedding-3-small')`,
      [new Array(1536).fill(0.2)]
    );
    const before = await admin.query(
      `SELECT count(*)::int AS n FROM lessons
        WHERE embedding_model = 'local:bge-small-en-v1.5' AND rule NOT LIKE 'EMBTEST %'`);
    const { runEmbedRebuild } = await import('../scripts/embed-rebuild.js');
    const first = await runEmbedRebuild({ projectSlug: 'emb-local-test', lessonRuleLike: 'EMBTEST %' });
    expect(first).toContain('re-embedded');
    const stale = await admin.query(
      `SELECT count(*)::int AS n FROM code_decisions
        WHERE project_id=(SELECT id FROM projects WHERE slug='emb-local-test')
          AND embedding IS NOT NULL AND embedding_model IS DISTINCT FROM 'local:bge-small-en-v1.5'`);
    expect(stale.rows[0].n).toBe(0);
    const lesson = await admin.query(
      `SELECT embedding_model, array_length(embedding, 1) AS dim FROM lessons
        WHERE rule = 'EMBTEST stale-tag lesson'`);
    expect(lesson.rows[0].embedding_model).toBe('local:bge-small-en-v1.5');
    expect(lesson.rows[0].dim).toBe(384); // re-embedded by the fake, not just re-tagged
    const after = await admin.query(
      `SELECT count(*)::int AS n FROM lessons
        WHERE embedding_model = 'local:bge-small-en-v1.5' AND rule NOT LIKE 'EMBTEST %'`);
    expect(after.rows[0].n).toBe(before.rows[0].n); // blast-radius guard: zero real lessons touched
    const second = await runEmbedRebuild({ projectSlug: 'emb-local-test', lessonRuleLike: 'EMBTEST %' });
    // Anchored (review N2: bare /0 decision\(s\)/ also matched "10 decision(s)").
    expect(second).toContain(': 0 decision(s) + 0 lesson(s)');
  });
  it('unusable model → cannot-rebuild, never "provider appears down" (pass-6 B1)', async () => {
    // The cold-model state downloadNow() creates on a failed init fetch. The
    // preflight must catch it BEFORE the batch loops, so the operator is told
    // the model is missing rather than that their provider is down — and so
    // the 482 vectorless lessons are not written off as "unembeddable".
    const { setLocalEmbedderForTests } = await import('../embeddings.js');
    setLocalEmbedderForTests(async () => null);
    const { runEmbedRebuild } = await import('../scripts/embed-rebuild.js');
    const out = await runEmbedRebuild({ projectSlug: 'emb-local-test', lessonRuleLike: 'EMBTEST %' });
    expect(out).toContain('Cannot rebuild');
    expect(out).not.toContain('provider appears down'); // pre-fix: this, after 25 doomed calls
  });
});

describe.skipIf(process.env.MAI_TEST_LOCAL_EMBED !== '1')('real local model (dev-only)', () => {
  it('downloads + embeds 384-dim', async () => {
    const { setLocalEmbedderForTests, downloadLocalModel, embed } = await import('../embeddings.js');
    setLocalEmbedderForTests(null); // reset to the REAL pipeline
    // Prefetch through the LONG bound (pass-5 B2): a cold ~35MB fetch will blow
    // LOCAL_INIT_TIMEOUT_MS, so going straight to embed() would fail on a clean
    // machine and pass on a warm one — the worst kind of test.
    expect(await downloadLocalModel()).toBe(true);
    const v = await embed('the riverbed shapes every flow that follows');
    expect(v).toHaveLength(384);
  }, 300_000);
  it('uses the documented query instruction for real retrieval', async () => {
    const {
      setLocalEmbedderForTests, downloadLocalModel, embed, embedQuery, cosineSim,
    } = await import('../embeddings.js');
    setLocalEmbedderForTests(null);
    expect(await downloadLocalModel()).toBe(true);
    const query = await embedQuery('How should environment secrets be handled?');
    const relevant = await embed('Never commit .env files or credentials to git');
    const unrelated = await embed('Bound every external wait with a timeout');
    expect(cosineSim(query!, relevant!)).toBeGreaterThan(cosineSim(query!, unrelated!));
  }, 300_000);
  it('CALIBRATION: prints the real cosine spread — read this, then set the local threshold', async () => {
    const { setLocalEmbedderForTests, embed, cosineSim } = await import('../embeddings.js');
    setLocalEmbedderForTests(null);
    const near: Array<[string, string]> = [
      ['Never commit .env files', 'Do not commit .env files to git'],
      ['Claim your lane before touching shared code', 'Claim paths before editing shared files'],
    ];
    const unrelated: Array<[string, string]> = [
      ['Never commit .env files', 'Bound every external wait with a timeout'],
      ['Claim your lane before touching shared code', 'Migrations need a paired rollback file'],
    ];
    for (const [label, pairs] of [['NEAR-DUP', near], ['UNRELATED', unrelated]] as const) {
      for (const [a, b] of pairs) {
        const [va, vb] = [await embed(a), await embed(b)];
        console.log(`${label}: ${cosineSim(va!, vb!).toFixed(3)}  "${a}" ↔ "${b}"`);
      }
    }
    // No assertion — this is a measurement, and asserting a guessed band would
    // just re-freeze the guess.
  }, 300_000);
});

describe('cloud tier bounds + two-strike cooldown (plan 14b)', () => {
  // globalThis.fetch is STUBBED (pass-2 B3). Pass 1 set an invalid API key and
  // called this "No network" — but a bad key does not avoid the network, it
  // just makes a live call to api.voyageai.com fail. That put real outbound
  // HTTPS into `npm test`, contradicted this file's own header ("no model
  // download/network"), and made the suite depend on DNS, connectivity and
  // provider behaviour. The URL is hardcoded at embeddings.ts:355, so stubbing
  // fetch is the only way to control it.
  const realFetch = globalThis.fetch;
  let calls = 0;

  /** Install a fetch that never touches the network. `mode` picks the shape. */
  function stubFetch(mode: 'reject' | 'ok' | 'hang'): void {
    calls = 0;
    globalThis.fetch = ((_url: string, init?: RequestInit) => {
      calls++;
      if (mode === 'ok') {
        return Promise.resolve(new Response(
          JSON.stringify({ data: [{ embedding: new Array(1024).fill(0.01) }] }),
          { status: 200, headers: { 'Content-Type': 'application/json' } }
        ));
      }
      if (mode === 'reject') {
        return Promise.resolve(new Response('nope', { status: 401 }));
      }
      // 'hang': pending until the caller's AbortSignal fires — the only way to
      // face a host that never answers.
      return new Promise((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () =>
          reject(Object.assign(new Error('The operation was aborted'), { name: 'TimeoutError' })));
      });
    }) as typeof fetch;
  }

  beforeEach(async () => {
    const { __resetCloudTierForTests } = await import('../embeddings.js');
    __resetCloudTierForTests();
    process.env.VOYAGE_API_KEY = 'pa-stubbed-key'; // selects the voyage branch; never sent anywhere
  });
  afterEach(() => {
    globalThis.fetch = realFetch;
    delete process.env.VOYAGE_API_KEY;
  });
  afterAll(async () => {
    const { __resetCloudTierForTests } = await import('../embeddings.js');
    __resetCloudTierForTests();
    globalThis.fetch = realFetch;
  });

  it('ONE failure does not cool down — a blip must not down-tier the brain', async () => {
    const { embed, embeddingsStatus } = await import('../embeddings.js');
    stubFetch('reject');
    expect(await embed('cooldown probe one')).toBeNull();
    expect(embeddingsStatus()).not.toContain('DEGRADED');
  });

  it('TWO consecutive failures arm the cooldown and the status says so', async () => {
    const { embed, embeddingsStatus } = await import('../embeddings.js');
    stubFetch('reject');
    expect(await embed('cooldown probe two-a')).toBeNull();
    expect(await embed('cooldown probe two-b')).toBeNull();
    const status = embeddingsStatus();
    expect(status).toContain('DEGRADED');
    expect(status).toContain('trigram fallback active');
    // The third call must be SKIPPED by the cooldown, not attempted. Assert on
    // the call COUNT, not elapsed time: with a stub, "fast" proves nothing.
    const before = calls;
    expect(await embed('cooldown probe two-c')).toBeNull();
    expect(calls).toBe(before); // pre-fix: 3 — the provider was called again
  });

  it('a SUCCESS resets the streak, so failure-success-failure never cools down (R5)', async () => {
    // R5 explicitly requires success to reset the counter, and pass 1 tested
    // only 1-failure and 2-failure (pass-2 W1). Without this, an implementation
    // that never reset would pass every other case in this file and would cool
    // down after two failures spread across an hour of healthy traffic.
    const { embed, embeddingsStatus } = await import('../embeddings.js');
    stubFetch('reject');
    expect(await embed('reset probe fail-1')).toBeNull();
    stubFetch('ok');
    expect(await embed('reset probe success')).not.toBeNull();
    stubFetch('reject');
    expect(await embed('reset probe fail-2')).toBeNull();
    expect(embeddingsStatus()).not.toContain('DEGRADED'); // 1 consecutive, not 2
  });

  it('a host that never answers is abandoned AT the bound, not waited on (R4)', async () => {
    const { embed, embeddingsStatus } = await import('../embeddings.js');
    stubFetch('hang'); // pending until AbortSignal.timeout fires
    const t = Date.now();
    expect(await embed('bound probe')).toBeNull();
    const elapsed = Date.now() - t;
    expect(elapsed).toBeGreaterThan(4_500);  // it genuinely WAITED the bound...
    expect(elapsed).toBeLessThan(7_000);     // ...and genuinely STOPPED at it
    expect(embeddingsStatus()).toContain('timeout');
  }, 20_000);

  it('the OpenAI client is constructed with the bound and no retries', async () => {
    // maxRetries defaults to 2, which would silently triple the wall time and
    // make CLOUD_EMBED_TIMEOUT_MS a per-attempt bound rather than a total one.
    // Nothing in embed()'s behaviour reveals this, so assert the construction.
    const src = await (await import('node:fs/promises'))
      .readFile(new URL('../embeddings.ts', import.meta.url), 'utf8');
    const ctor = src.slice(src.indexOf('new OpenAI({'), src.indexOf('embeddings.create'));
    expect(ctor).toContain('timeout: CLOUD_EMBED_TIMEOUT_MS');
    expect(ctor).toContain('maxRetries: 0');
  });
});
