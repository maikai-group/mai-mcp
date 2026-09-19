// Origin: forked from the Mai Group's predecessor memory server (private).
import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest';
// Type-only import — fully erased at compile time, so it does NOT execute the
// module before MAI_PROJECT_SLUG is set below. Runtime use goes through `gate`.
import type { CitationKind, WriteGateError } from '../write-gate.js';

// Pin BEFORE importing any module: env.ts captures MAI_PROJECT_SLUG at load time.
process.env.MAI_PROJECT_SLUG = 'wg-test';
process.env.MAI_DB_URL =
  process.env.MAI_DB_URL ?? 'postgresql://postgres:postgres@127.0.0.1:54334/mai_brain';

const { getPool, getProjectId } = await import('../db.js');
const gate = await import('../write-gate.js');
const lessons = await import('../lessons.js');

const TEST_TAG = 'TEST_write_gate';

beforeAll(async () => {
  const pool = getPool();
  await pool.query(`DELETE FROM projects WHERE slug = 'wg-test'`);
  await pool.query(`INSERT INTO projects (slug, name) VALUES ('wg-test','WG Test')`);
});

describe('write-gate', () => {
  beforeEach(async () => {
    const pool = getPool();
    const projectId = await getProjectId();
    await pool.query(
      `DELETE FROM write_violations WHERE project_id = $1 AND tool_name LIKE 'TEST_%'`,
      [projectId]
    );
    await pool.query(
      `DELETE FROM lessons WHERE project_id = $1 AND tags @> ARRAY[$2]::text[]`,
      [projectId, TEST_TAG]
    );
    // Reset this process's session-token gate state so each test starts clean.
    // (The token is per-process + memoized; we reset its row rather than re-mint.)
    const tokenId = await gate.ensureSessionToken();
    await pool.query(
      `UPDATE write_session_tokens
       SET reads_count = 0, result_set_ids = '{}'::jsonb,
           writes_attempted = 0, writes_rejected = 0, writes_succeeded = 0
       WHERE id = $1`,
      [tokenId]
    );
  });

  afterAll(async () => {
    const pool = getPool();
    await pool.query(`DELETE FROM projects WHERE slug = 'wg-test'`); // cascades tokens + violations
    await pool.end();
  });

  it('ensureSessionToken: idempotent within the process', async () => {
    const t1 = await gate.ensureSessionToken();
    const t2 = await gate.ensureSessionToken();
    expect(t1).toBe(t2);
  });

  it('verifyCatA: rejects missing citation', async () => {
    await expect(
      gate.verifyCatA({
        bucket: 'lessons',
        citation: undefined,
        payloadFingerprint: 'TEST something',
        toolName: 'TEST_lesson_add',
      })
    ).rejects.toBeInstanceOf(gate.WriteGateError);
  });

  it('verifyCatA: rejects unknown citation kind', async () => {
    await expect(
      gate.verifyCatA({
        bucket: 'lessons',
        citation: { kind: 'bogus' } as unknown as CitationKind,
        payloadFingerprint: 'TEST',
        toolName: 'TEST_lesson_add',
      })
    ).rejects.toBeInstanceOf(gate.WriteGateError);
  });

  it('verifyCatA: rejects novel with <50-char justification', async () => {
    await expect(
      gate.verifyCatA({
        bucket: 'lessons',
        citation: { kind: 'novel', justification: 'too short' },
        payloadFingerprint: 'TEST',
        toolName: 'TEST_lesson_add',
      })
    ).rejects.toThrow(/novel citation's justification is 9 chars/);
  });

  it('verifyCatA: novel-justification error names the real field, not "novel_root"', async () => {
    await expect(
      gate.verifyCatA({
        bucket: 'lessons',
        citation: { kind: 'novel', justification: 'too short' },
        payloadFingerprint: 'TEST',
        toolName: 'TEST_lesson_add',
      })
    ).rejects.toThrow(/citation\.justification/);
  });

  it('verifyCatA: accepts novel with ≥50-char justification after a search this session', async () => {
    // Novel-bypass fix: a search must have happened this session. A zero-hit
    // search counts, so record an empty read first.
    await gate.recordReadResults('lessons', []);
    await expect(
      gate.verifyCatA({
        bucket: 'lessons',
        citation: {
          kind: 'novel',
          justification: 'TEST justification: long enough to pass the gate min char length',
        },
        payloadFingerprint: 'TEST',
        toolName: 'TEST_lesson_add',
      })
    ).resolves.toBeNull();
  });

  it('verifyCatA: novel with zero reads → no_search_token; succeeds after a search', async () => {
    // beforeEach reset reads_count to 0 → "I looked and found nothing" is not yet credible.
    let captured: WriteGateError | null = null;
    try {
      await gate.verifyCatA({
        bucket: 'lessons',
        citation: {
          kind: 'novel',
          justification: 'TEST novel zero reads — justification long enough to pass the min',
        },
        payloadFingerprint: 'TEST',
        toolName: 'TEST_novel_gap',
      });
    } catch (e) {
      if (e instanceof gate.WriteGateError) captured = e;
    }
    expect(captured).not.toBeNull();
    expect(captured!.kind).toBe('no_search_token');

    // A search (even one returning nothing) makes the novel claim credible.
    await gate.recordReadResults('lessons', []);
    await expect(
      gate.verifyCatA({
        bucket: 'lessons',
        citation: {
          kind: 'novel',
          justification: 'TEST novel zero reads — justification long enough to pass the min',
        },
        payloadFingerprint: 'TEST',
        toolName: 'TEST_novel_gap',
      })
    ).resolves.toBeNull();
  });

  it('verifyCatA: rejects supersedes citation with ID not in result-set', async () => {
    await expect(
      gate.verifyCatA({
        bucket: 'lessons',
        citation: {
          kind: 'supersedes',
          supersedes_id: '00000000-0000-0000-0000-000000000000',
          reason: 'TEST reason',
        },
        payloadFingerprint: 'TEST',
        toolName: 'TEST_lesson_add',
      })
    ).rejects.toThrow(/was not returned by any search/);
  });

  it('recordReadResults + verifyCatA: accepts cited ID after a search records it', async () => {
    const pool = getPool();
    const projectId = await getProjectId();
    const inserted = await pool.query<{ id: string }>(
      `INSERT INTO lessons (project_id, rule, tags) VALUES ($1, 'TEST gate-passes rule', ARRAY[$2]::text[]) RETURNING id`,
      [projectId, TEST_TAG]
    );
    const lessonId = inserted.rows[0].id;

    await gate.recordReadResults('lessons', [lessonId]);

    await expect(
      gate.verifyCatA({
        bucket: 'lessons',
        citation: { kind: 'extends', extends_id: lessonId, how: 'TEST' },
        payloadFingerprint: 'TEST',
        toolName: 'TEST_lesson_add',
      })
    ).resolves.toMatchObject({ citedKind: 'lesson', citedId: lessonId, relation: 'extends', reason: 'TEST' });
  });

  it('verifyCatC: rejects decision evidence with <20 char user_quote', async () => {
    await expect(
      gate.verifyCatC({
        evidence: { type: 'decision', user_quote: 'too short' },
        toolName: 'TEST_note',
        payloadFingerprint: 'TEST',
      })
    ).rejects.toThrow(/decision notes require user_quote/);
  });

  it('verifyCatC: undefined evidence → WriteGateError, not a TypeError (live 2026-06-12 failure)', async () => {
    // An agent that omits `evidence` must get a self-correcting rejection,
    // not "Cannot read properties of undefined (reading 'type')".
    let captured: WriteGateError | null = null;
    try {
      await gate.verifyCatC({
        evidence: undefined,
        toolName: 'TEST_progress_no_evidence',
        payloadFingerprint: 'TEST milestone without evidence',
      });
    } catch (e) {
      if (e instanceof gate.WriteGateError) captured = e;
    }
    expect(captured).not.toBeNull();
    expect(captured!.kind).toBe('invalid_trigger_evidence');
    expect(captured!.message).toMatch(/evidence is required/);
  });

  it('verifyCatC: undefined evidence is logged as a violation (telemetry must see it)', async () => {
    try {
      await gate.verifyCatC({
        evidence: undefined,
        toolName: 'TEST_progress_no_evidence_logged',
        payloadFingerprint: 'TEST telemetry row',
      });
    } catch {
      // expected
    }
    const pool = getPool();
    const projectId = await getProjectId();
    const r = await pool.query<{ violation_kind: string }>(
      `SELECT violation_kind FROM write_violations
       WHERE project_id = $1 AND tool_name = 'TEST_progress_no_evidence_logged'
       ORDER BY rejected_at DESC LIMIT 1`,
      [projectId]
    );
    expect(r.rows[0]?.violation_kind).toBe('invalid_trigger_evidence');
  });

  it('appendProgress: undefined evidence → WriteGateError end-to-end through notes.ts', async () => {
    const notes = await import('../notes.js');
    await expect(
      notes.appendProgress('TEST milestone under 500 chars', undefined)
    ).rejects.toBeInstanceOf(gate.WriteGateError);
  });

  it('verifyCatC: accepts agent_observation with ≥50 chars', async () => {
    await expect(
      gate.verifyCatC({
        evidence: {
          type: 'agent_observation',
          what_happened: 'TEST observation: long enough text to satisfy the gate threshold cleanly',
        },
        toolName: 'TEST_agent_remember',
        payloadFingerprint: 'TEST',
      })
    ).resolves.toBeUndefined();
  });

  it('verifyCatC: accepts decision_selection with a valid question + options', async () => {
    await expect(
      gate.verifyCatC({
        evidence: {
          type: 'decision_selection',
          question: 'Guided flow or display-only for the logging screen?',
          options_presented: ['Guided flow', 'Display-only'],
          option_selected: 'Guided flow',
        },
        toolName: 'TEST_note',
        payloadFingerprint: 'TEST',
      })
    ).resolves.toBeUndefined();
  });

  it('verifyCatC: rejects decision_selection when selected is not among options', async () => {
    await expect(
      gate.verifyCatC({
        evidence: {
          type: 'decision_selection',
          question: 'Guided flow or display-only for the logging screen?',
          options_presented: ['Guided flow', 'Display-only'],
          option_selected: 'Something else entirely',
        },
        toolName: 'TEST_note',
        payloadFingerprint: 'TEST',
      })
    ).rejects.toThrow(/option_selected must be one of/);
  });

  it('verifyCatC: rejects decision_selection with fewer than 2 options', async () => {
    await expect(
      gate.verifyCatC({
        evidence: {
          type: 'decision_selection',
          question: 'Pick the flow approach for this screen',
          options_presented: ['Only one'],
          option_selected: 'Only one',
        },
        toolName: 'TEST_note',
        payloadFingerprint: 'TEST',
      })
    ).rejects.toThrow(/at least 2 options_presented/);
  });

  it('decisionAdd: accepts source=user-selected and labels it', async () => {
    const decisions = await import('../decisions.js');
    await gate.recordReadResults('decisions', []); // zero-hit search → makes a novel citation credible
    const out = await decisions.decisionAdd({
      citation: {
        kind: 'novel',
        justification: 'TEST user-selected provenance — justification long enough to pass the gate minimum',
      },
      decisionType: 'architecture',
      description: 'TEST selection decision: guided flow chosen over display-only',
      alternativesConsidered: ['Display-only'],
      source: 'user-selected',
    });
    expect(out).toMatch(/source=user-selected/);
  });

  it('decisionAdd: aliases legacy source=matt-approved to user-approved', async () => {
    const decisions = await import('../decisions.js');
    await gate.recordReadResults('decisions', []); // zero-hit search → makes a novel citation credible
    const out = await decisions.decisionAdd({
      citation: {
        kind: 'novel',
        justification: 'TEST legacy alias — justification long enough to pass the gate minimum length',
      },
      decisionType: 'architecture',
      description: 'TEST alias decision: legacy provenance value normalizes forward',
      source: 'matt-approved',
    });
    expect(out).toMatch(/source=user-approved/);
    expect(out).not.toMatch(/matt-approved/);
  });

  it('enforceCharLimits: accepts 1000-char field', async () => {
    const exactly1000 = 'x'.repeat(1000);
    await expect(
      gate.enforceCharLimits({
        fields: { rule: exactly1000 },
        toolName: 'TEST_lesson_add',
      })
    ).resolves.toBeUndefined();
  });

  it('enforceCharLimits: rejects 1001-char field', async () => {
    const overLimit = 'x'.repeat(1001);
    await expect(
      gate.enforceCharLimits({
        fields: { rule: overLimit },
        toolName: 'TEST_lesson_add',
      })
    ).rejects.toThrow(/char limit exceeded/);
  });

  it('rejection produces WriteGateError with populated preview when seeded', async () => {
    const pool = getPool();
    const projectId = await getProjectId();
    await pool.query(
      `INSERT INTO lessons (project_id, rule, tags) VALUES ($1, 'TEST preview seed for similarity match', ARRAY[$2]::text[])`,
      [projectId, TEST_TAG]
    );

    let captured: WriteGateError | null = null;
    try {
      await gate.verifyCatA({
        bucket: 'lessons',
        citation: undefined,
        payloadFingerprint: 'TEST preview seed for similarity match',
        toolName: 'TEST_lesson_add',
      });
    } catch (e) {
      if (e instanceof gate.WriteGateError) captured = e;
    }
    expect(captured).not.toBeNull();
    expect(captured!.kind).toBe('missing_citation');
    expect(captured!.preview.length).toBeGreaterThanOrEqual(1);
  });

  it('recordWriteSuccess: marks the most-recent rejection as recovered', async () => {
    // Force a rejection via missing citation
    try {
      await gate.verifyCatA({
        bucket: 'lessons',
        citation: undefined,
        payloadFingerprint: 'TEST recovered flow',
        toolName: 'TEST_recover_flow',
      });
    } catch {
      // expected
    }

    // Mark a successful follow-up
    await gate.recordWriteSuccess();

    // Verify the most-recent rejection got followup_succeeded=true
    const pool = getPool();
    const projectId = await getProjectId();
    const r = await pool.query<{ followup_succeeded: boolean | null }>(
      `SELECT followup_succeeded
       FROM write_violations
       WHERE project_id = $1 AND tool_name = 'TEST_recover_flow'
       ORDER BY rejected_at DESC LIMIT 1`,
      [projectId]
    );
    expect(r.rows[0]?.followup_succeeded).toBe(true);
  });

  it('integration: full reject → search → cite → success flow', async () => {
    const pool = getPool();
    const projectId = await getProjectId();

    // Seed a lesson L1
    await pool.query(
      `INSERT INTO lessons (project_id, rule, tags, confidence_score)
       VALUES ($1, 'TEST integration seed for citation', ARRAY[$2]::text[], 0.95)`,
      [projectId, TEST_TAG]
    );

    // 1. lessonAdd without citation → rejected
    let reject1: WriteGateError | null = null;
    try {
      await lessons.lessonAdd({
        rule: 'TEST integration write attempt',
        citation: undefined as unknown as CitationKind,
        tags: [TEST_TAG],
      });
    } catch (e) {
      if (e instanceof gate.WriteGateError) reject1 = e;
    }
    expect(reject1).not.toBeNull();
    expect(reject1!.kind).toBe('missing_citation');

    // 2. lessonSearch mints a token + records returned IDs.
    // Use no-query path (skip embedding filter) so the freshly-inserted-without-
    // embedding seed row is in the result.
    await lessons.lessonSearch({
      tags: [TEST_TAG],
      limit: 50,
    });

    // 3. Get the seeded ID for citation
    const seed = await pool.query<{ id: string }>(
      `SELECT id FROM lessons WHERE project_id = $1 AND rule = 'TEST integration seed for citation' LIMIT 1`,
      [projectId]
    );
    expect(seed.rows.length).toBe(1);
    const seedId = seed.rows[0].id;

    // 4. lessonAdd with valid extends citation → success
    const result = await lessons.lessonAdd({
      rule: 'TEST integration successful add via citation',
      citation: {
        kind: 'extends',
        extends_id: seedId,
        how: 'TEST integration extension scenario',
      },
      tags: [TEST_TAG],
    });
    expect(result).toMatch(/Added lesson|Reinforced/);

    // 5. The earlier rejection should be marked as recovered
    const recovered = await pool.query<{ followup_succeeded: boolean | null }>(
      `SELECT followup_succeeded FROM write_violations
       WHERE project_id = $1 AND tool_name = 'mai_lesson_add' AND violation_kind = 'missing_citation'
       ORDER BY rejected_at DESC LIMIT 1`,
      [projectId]
    );
    expect(recovered.rows[0]?.followup_succeeded).toBe(true);
  });
});
