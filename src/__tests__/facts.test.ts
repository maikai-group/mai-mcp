/** Global user-facts (plan 11 Task 2): propose → review union → promote →
 * prime inclusion; retract/unretract.
 *
 * CLEANUP RULE: user_facts is GLOBAL and shares the table with real operator
 * facts — NEVER blanket-delete. Every fixture row carries the evidence marker
 * below, and both hooks delete only by that marker. */
import { beforeAll, afterAll, describe, expect, it } from 'vitest';
import { Pool } from 'pg';

process.env.MAI_PROJECT_SLUG = 'facts-test';
process.env.MAI_DB_URL =
  process.env.MAI_DB_URL ?? 'postgresql://postgres:postgres@127.0.0.1:54334/mai_brain';

const admin = new Pool({ connectionString: process.env.MAI_DB_URL });

const MARKER = 'facts-test-fixture';

let projectId = '';

beforeAll(async () => {
  await admin.query(`DELETE FROM user_facts WHERE evidence = $1`, [MARKER]);
  await admin.query(`DELETE FROM projects WHERE slug = 'facts-test'`);
  const p = await admin.query<{ id: string }>(
    `INSERT INTO projects (slug, name) VALUES ('facts-test', 'Facts Test') RETURNING id`
  );
  projectId = p.rows[0].id;
  await admin.query(
    `INSERT INTO code_decisions (project_id, decision_type, description, confidence, source, timestamp)
     VALUES ($1, 'arch', 'a decision candidate', 0.6, 'agent-inferred', NOW())`,
    [projectId]
  );
});

afterAll(async () => {
  await admin.query(`DELETE FROM user_facts WHERE evidence = $1`, [MARKER]);
  await admin.query(`DELETE FROM projects WHERE slug = 'facts-test'`);
  await admin.end();
  const { getPool } = await import('../db.js');
  await getPool().end();
});

describe('factAdd', () => {
  it('proposes a candidate with evidence', async () => {
    const { factAdd } = await import('../facts.js');
    const row = await factAdd({
      category: 'preference',
      fact: 'Prefers explicit git paths over broad staging.',
      evidence: MARKER,
    });
    expect(row.source).toBe('agent-inferred');
    expect(row.category).toBe('preference');
    expect(row.retracted_at).toBeNull();
  });

  it('rejects a missing evidence, an invalid category, and a fact over 300 chars', async () => {
    const { factAdd } = await import('../facts.js');
    await expect(factAdd({ category: 'workflow', fact: 'x', evidence: '  ' })).rejects.toThrow(
      /evidence is required/
    );
    await expect(
      // Category is validated at runtime — the cast reaches the guard the way a
      // malformed tool call would.
      factAdd({ category: 'nonsense' as 'workflow', fact: 'x', evidence: MARKER })
    ).rejects.toThrow(/category must be one of/);
    await expect(
      factAdd({ category: 'workflow', fact: 'x'.repeat(301), evidence: MARKER })
    ).rejects.toThrow(/exceeds 300 chars/);
    await expect(factAdd({ category: 'workflow', fact: '   ', evidence: MARKER })).rejects.toThrow(
      /fact is required/
    );
  });
});

describe('review union', () => {
  it('shows fact candidates alongside decisions, each tagged by kind', async () => {
    const { reviewQueueRows, reviewQueue } = await import('../decisions.js');
    const rows = await reviewQueueRows(30, projectId);

    const fact = rows.find((r) => r.kind === 'fact' && r.reasoning?.includes(MARKER));
    expect(fact).toBeDefined();
    expect(fact!.decision_type).toBe('preference');
    expect(fact!.confidence).toBe(0.5);
    expect(fact!.keywords).toContain('user-fact');
    expect(rows.some((r) => r.kind === 'decision' && r.description === 'a decision candidate')).toBe(true);

    const md = await reviewQueue(30, projectId);
    expect(md).toContain('[fact/preference]');
  });
});

describe('promote / prime', () => {
  it('promotes a candidate, which then leaves the queue and primes globally', async () => {
    const { factAdd, factPromote, primeFactsSection } = await import('../facts.js');
    const { reviewQueueRows } = await import('../decisions.js');
    const candidate = await factAdd({
      category: 'tooling',
      fact: 'Runs mai-mcp against the brain DB on port 54334.',
      evidence: MARKER,
    });

    expect((await primeFactsSection()) ?? '').not.toContain(candidate.fact); // candidates never prime

    const promoted = await factPromote(candidate.id);
    expect(promoted.source).toBe('user-approved');

    const rows = await reviewQueueRows(30, projectId);
    expect(rows.some((r) => r.id === candidate.id)).toBe(false);

    const section = await primeFactsSection();
    expect(section).toContain('## User facts (global — apply in every project)');
    expect(section).toContain('**tooling**');
    expect(section).toContain(candidate.fact);
  });
});

describe('retract / unretract', () => {
  it('drops a retracted fact from prime and restores it on unretract', async () => {
    const { factAdd, factPromote, factRetract, factUnretract, factsList, primeFactsSection } =
      await import('../facts.js');
    const row = await factPromote(
      (await factAdd({ category: 'identity', fact: 'A fact that will be retracted.', evidence: MARKER })).id
    );

    await expect(factRetract(row.id, '  ')).rejects.toThrow(/requires a reason/);

    const retracted = await factRetract(row.id, 'no longer true');
    expect(retracted.retracted_at).not.toBeNull();
    expect(retracted.retraction_reason).toBe('no longer true');
    expect((await primeFactsSection()) ?? '').not.toContain(row.fact);
    expect((await factsList()).some((f) => f.id === row.id)).toBe(false);
    expect((await factsList({ includeRetracted: true })).some((f) => f.id === row.id)).toBe(true);

    const restored = await factUnretract(row.id);
    expect(restored.retracted_at).toBeNull();
    expect(restored.retraction_reason).toBeNull();
    expect((await primeFactsSection()) ?? '').toContain(row.fact);
  });
});

describe('budgeted prime facts (plan 38)', () => {
  const FACT_BODY = (i: number): string => `PLAN38 maximum fact ${i} `.padEnd(300, 'x').slice(0, 300);

  it('keeps the legacy 3,697-char block and renders the exact 183-char pointer at 200', async () => {
    const { primeFactsSection } = await import('../facts.js');
    // Deterministic isolation: park any other approved fact for the duration.
    const foreign = await admin.query<{ id: string }>(
      `SELECT id FROM user_facts
        WHERE source = 'user-approved' AND retracted_at IS NULL AND evidence <> $1`, [MARKER]);
    const parked = foreign.rows.map((r) => r.id);
    await admin.query(
      `UPDATE user_facts SET retracted_at = NOW(), retraction_reason = 'plan38 fixture isolation'
        WHERE id = ANY($1::uuid[])`, [parked]);
    await admin.query(`DELETE FROM user_facts WHERE evidence = $1`, [MARKER]);
    try {
      for (let i = 0; i < 12; i++) {
        expect(FACT_BODY(i)).toHaveLength(300);
        await admin.query(
          `INSERT INTO user_facts (category, fact, evidence, source, created_at)
           VALUES ('workflow', $1, $2, 'user-approved', NOW() + make_interval(secs => $3::int))`,
          [FACT_BODY(i), MARKER, i]
        );
      }
      const expectedLegacy = [
        '## User facts (global — apply in every project)',
        '',
        '**workflow**',
        ...Array.from({ length: 12 }, (_, i) => `- ${FACT_BODY(i)}`),
      ].join('\n');
      expect(expectedLegacy).toHaveLength(3697);
      // Exact equality, not containment: the frozen legacy block byte-for-byte.
      expect(await primeFactsSection()).toBe(expectedLegacy);

      const pointer = await primeFactsSection(200);
      expect(pointer).toBe(
        '## User facts\n\n_0/12 fact headlines shown; complete render 3697 chars. ' +
        'To read omitted headlines or bodies, review operator-approved user facts ' +
        'in the dashboard before changing them._'
      );
      expect(pointer).toHaveLength(183);
      expect((pointer ?? '').length).toBeLessThanOrEqual(200);
    } finally {
      await admin.query(`DELETE FROM user_facts WHERE evidence = $1`, [MARKER]);
      await admin.query(
        `UPDATE user_facts SET retracted_at = NULL, retraction_reason = NULL
          WHERE id = ANY($1::uuid[])`, [parked]);
    }
  });
});
