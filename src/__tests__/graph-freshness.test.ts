/**
 * Plan 28 — the DB-schema freshness axis.
 *
 * Part 1 (this task): the classifier is pure and total, and every render helper
 * has a defined output for every state. No database required.
 * Part 2 (Task 2): DB-isolated reader/graphStale state tests + the URL-leak
 * assertions.
 *
 * IMPORT DISCIPLINE — load-bearing, do not "simplify" to a static import.
 * `freshness.ts` imports `../db.js`, so it is a DB consumer even for its pure
 * helpers. ES imports are hoisted and evaluated before any module body runs, so
 * a static import here would evaluate `env.js` BEFORE Task 2's
 * `process.env.MAI_PROJECT_SLUG` / `MAI_DB_URL` assignments — leaving
 * PROJECT_SLUG '' and silently breaking every DB-backed case in this file.
 * Types are imported with `import type` (erased, no evaluation); values are
 * pulled in with `await import` inside each test, the same house pattern
 * prime.test.ts and context-budget.test.ts use.
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Pool } from 'pg';
import { requireDisposableTestDbUrl } from './test-db-url.js';

const TEST_DB = requireDisposableTestDbUrl();
process.env.MAI_PROJECT_SLUG = 'freshness-test';
process.env.MAI_DB_URL = TEST_DB;

const admin = new Pool({ connectionString: TEST_DB });
const LEAK_URL = 'postgresql://leakuser:leakpassword@leak.example.invalid:5432/leakdb';
import type { DbSchemaInputs, DbSchemaState, GraphStaleCounts } from '../graph/freshness.js';

const OLD = new Date('2026-06-13T06:03:25.374Z');
const NEW = new Date('2026-08-18T05:59:27.537Z');

const base: DbSchemaInputs = {
  dbNodes: 0,
  dbTables: 0,
  dbLastExtracted: null,
  codeLastExtracted: null,
  urlConfigured: false,
};

describe('classifyDbSchema (pure, table-driven)', () => {
  const cases: Array<{ name: string; input: DbSchemaInputs; expected: DbSchemaState }> = [
    {
      name: 'no schema nodes, no URL → not-configured',
      input: { ...base, codeLastExtracted: NEW },
      expected: { state: 'not-configured' },
    },
    {
      name: 'no schema nodes, URL configured → never-extracted',
      input: { ...base, codeLastExtracted: NEW, urlConfigured: true },
      expected: { state: 'never-extracted' },
    },
    {
      name: 'schema nodes, no URL → stale/no-url (every update skips the layer)',
      input: { ...base, dbNodes: 142, dbTables: 10, dbLastExtracted: OLD, codeLastExtracted: NEW },
      expected: { state: 'stale', reason: 'no-url', tables: 10, nodes: 142, lastExtracted: OLD },
    },
    {
      name: 'schema older than the last code extraction → stale/behind-code',
      input: {
        ...base,
        dbNodes: 142,
        dbTables: 10,
        dbLastExtracted: OLD,
        codeLastExtracted: NEW,
        urlConfigured: true,
      },
      expected: { state: 'stale', reason: 'behind-code', tables: 10, nodes: 142, lastExtracted: OLD },
    },
    {
      name: 'schema at or after the last code extraction → fresh',
      input: {
        ...base,
        dbNodes: 142,
        dbTables: 10,
        dbLastExtracted: NEW,
        codeLastExtracted: NEW,
        urlConfigured: true,
      },
      expected: { state: 'fresh', tables: 10, nodes: 142, lastExtracted: NEW },
    },
    {
      name: 'schema nodes but no code extraction at all → fresh (nothing proves it is behind)',
      input: { ...base, dbNodes: 3, dbTables: 1, dbLastExtracted: OLD, urlConfigured: true },
      expected: { state: 'fresh', tables: 1, nodes: 3, lastExtracted: OLD },
    },
    {
      name: 'schema nodes with no recorded extraction time → stale, never fresh (D1)',
      input: { ...base, dbNodes: 5, dbTables: 2, codeLastExtracted: NEW, urlConfigured: true },
      expected: { state: 'stale', reason: 'behind-code', tables: 2, nodes: 5, lastExtracted: null },
    },
  ];

  for (const c of cases) {
    it(c.name, async () => {
      const { classifyDbSchema } = await import('../graph/freshness.js');
      expect(classifyDbSchema(c.input)).toEqual(c.expected);
    });
  }

  it('never claims fresh without a timestamp', async () => {
    const { classifyDbSchema } = await import('../graph/freshness.js');
    for (const c of cases) {
      const out = classifyDbSchema(c.input);
      if (out.state === 'fresh') expect(out.lastExtracted).toBeInstanceOf(Date);
    }
  });
});

const ALL_STATES: DbSchemaState[] = [
  { state: 'not-configured' },
  { state: 'never-extracted' },
  { state: 'stale', reason: 'no-url', tables: 10, nodes: 142, lastExtracted: OLD },
  { state: 'stale', reason: 'behind-code', tables: 10, nodes: 142, lastExtracted: OLD },
  { state: 'fresh', tables: 10, nodes: 142, lastExtracted: NEW },
];

describe('render helpers cover every state', () => {
  it('prime line: one non-empty, schema-scoped line per state', async () => {
    const { renderDbSchemaPrimeLine } = await import('../graph/freshness.js');
    for (const s of ALL_STATES) {
      const line = renderDbSchemaPrimeLine(s);
      expect(line.startsWith('_Graph (db schema): ')).toBe(true);
      expect(line.endsWith('_')).toBe(true);
      expect(line).not.toContain('\n');
    }
  });

  it('prime line: every not-fresh state says so out loud', async () => {
    const { renderDbSchemaPrimeLine } = await import('../graph/freshness.js');
    for (const s of ALL_STATES) {
      if (s.state === 'fresh') continue;
      expect(renderDbSchemaPrimeLine(s)).toMatch(/STALE|not configured|never extracted/);
    }
  });

  it('compact clause is null exactly for fresh (Q4: budgeted append)', async () => {
    const { renderDbSchemaCompactClause } = await import('../graph/freshness.js');
    for (const s of ALL_STATES) {
      const clause = renderDbSchemaCompactClause(s);
      if (s.state === 'fresh') expect(clause).toBeNull();
      else expect(clause).toMatch(/^db schema: /);
    }
  });

  it('graphStale section renders a heading for EVERY state, not-configured included', async () => {
    const { renderDbSchemaSection } = await import('../graph/freshness.js');
    for (const s of ALL_STATES) {
      const lines = renderDbSchemaSection(s);
      expect(lines[0]).toBe('## DB schema');
      expect(lines.length).toBeGreaterThanOrEqual(2);
    }
    expect(renderDbSchemaSection({ state: 'not-configured' }).join('\n')).toContain('NOT CONFIGURED');
  });

  it('every rendered timestamp carries the "as of" honesty boundary', async () => {
    const { renderDbSchemaPrimeLine, renderDbSchemaSection } = await import('../graph/freshness.js');
    const fresh = renderDbSchemaPrimeLine({ state: 'fresh', tables: 10, nodes: 142, lastExtracted: NEW });
    expect(fresh).toContain('not a live comparison');
    const section = renderDbSchemaSection({ state: 'fresh', tables: 10, nodes: 142, lastExtracted: NEW }).join('\n');
    expect(section).toContain('not a live comparison');
  });

  it('code line is explicitly scoped to the code axis in all four shapes', async () => {
    const { renderCodePrimeLine } = await import('../graph/freshness.js');
    expect(renderCodePrimeLine({ total: 0, stale: 0, method: 'per-file' })).toBe('_Graph (code): not built yet — run mai graph build._');
    expect(renderCodePrimeLine({ total: 683, stale: 12, method: 'per-file' })).toContain('12/683 nodes whose source differs from extraction');
    expect(renderCodePrimeLine({ total: 683, stale: 12, method: 'whole-graph' })).toContain('12/683 nodes with stale or unverified source');
    expect(renderCodePrimeLine({ total: 683, stale: 0, method: 'per-file' })).toBe('_Graph (code): 683 nodes, source verified._');
    const shapes: GraphStaleCounts[] = [
      { total: 0, stale: 0, method: 'per-file' }, { total: 683, stale: 12, method: 'per-file' }, { total: 683, stale: 0, method: 'per-file' },
    ];
    for (const c of shapes) {
      expect(renderCodePrimeLine(c).startsWith('_Graph (code): ')).toBe(true);
    }
  });
});

let projectId = '';
let emptyDir = '';

async function seedNode(kind: string, name: string, extractedBy: string, extractedAt: string): Promise<void> {
  await admin.query(
    `INSERT INTO graph_nodes (project_id, kind, name, qualified_name, extracted_by, extracted_at)
     VALUES ($1, $2, $3, $4, $5, $6::timestamptz)`,
    [projectId, kind, name, `${extractedBy}.${name}`, extractedBy, extractedAt]
  );
}

async function resetNodes(): Promise<void> {
  await admin.query(`DELETE FROM graph_nodes WHERE project_id = $1`, [projectId]);
}

beforeAll(async () => {
  emptyDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mai-freshness-'));
  await admin.query(`DELETE FROM projects WHERE slug = 'freshness-test'`);
  const p = await admin.query<{ id: string }>(
    `INSERT INTO projects (slug, name, path) VALUES ('freshness-test', 'Freshness Test', $1) RETURNING id`,
    [emptyDir]
  );
  projectId = p.rows[0].id;
});

afterAll(async () => {
  await admin.query(`DELETE FROM projects WHERE slug = 'freshness-test'`); // graph_nodes cascade
  fs.rmSync(emptyDir, { recursive: true, force: true });
  await admin.end();
  const { getPool } = await import('../db.js');
  await getPool().end();
});

beforeEach(async () => {
  delete process.env.MAI_GRAPH_DB_URL;
  await resetNodes();
});

afterEach(() => {
  delete process.env.MAI_GRAPH_DB_URL;
});

describe('readDbSchemaState (DB-isolated throwaway project)', () => {
  it('PRECONDITION: no .env in scope defines MAI_GRAPH_DB_URL', async () => {
    // If this fails, a developer .env is bleeding into the "no URL" cases —
    // fail loudly here rather than let the state tests silently pass wrong.
    // docs/architecture.md:299: the key belongs in the CONSUMER project's .env,
    // never in mai-mcp's own.
    const { resolveConsumerGraphDbUrl } = await import('../graph/db-url.js');
    expect(await resolveConsumerGraphDbUrl(projectId)).toBeUndefined();
  });

  it('code nodes only, no URL → not-configured', async () => {
    await seedNode('function', 'a', 'ts', '2026-08-18T00:00:00Z');
    const { readDbSchemaState } = await import('../graph/freshness.js');
    expect(await readDbSchemaState(projectId)).toEqual({ state: 'not-configured' });
  });

  it('code nodes only, URL configured → never-extracted', async () => {
    await seedNode('function', 'a', 'ts', '2026-08-18T00:00:00Z');
    process.env.MAI_GRAPH_DB_URL = LEAK_URL;
    const { readDbSchemaState } = await import('../graph/freshness.js');
    expect(await readDbSchemaState(projectId)).toEqual({ state: 'never-extracted' });
  });

  it('schema nodes with no URL → stale/no-url with the real counts', async () => {
    await seedNode('table', 't1', 'db', '2026-06-13T06:03:25Z');
    await seedNode('column', 'c1', 'db', '2026-06-13T06:03:25Z');
    await seedNode('function', 'a', 'ts', '2026-08-18T00:00:00Z');
    const { readDbSchemaState } = await import('../graph/freshness.js');
    const s = await readDbSchemaState(projectId);
    expect(s).toMatchObject({ state: 'stale', reason: 'no-url', tables: 1, nodes: 2 });
  });

  it('schema older than the newest code extraction → stale/behind-code', async () => {
    await seedNode('table', 't1', 'db', '2026-06-13T06:03:25Z');
    await seedNode('function', 'a', 'ts', '2026-08-18T00:00:00Z');
    process.env.MAI_GRAPH_DB_URL = LEAK_URL;
    const { readDbSchemaState } = await import('../graph/freshness.js');
    expect(await readDbSchemaState(projectId)).toMatchObject({ state: 'stale', reason: 'behind-code' });
  });

  it('schema newer than the newest code extraction → fresh', async () => {
    await seedNode('table', 't1', 'db', '2026-08-18T12:00:00Z');
    await seedNode('function', 'a', 'ts', '2026-08-18T00:00:00Z');
    process.env.MAI_GRAPH_DB_URL = LEAK_URL;
    const { readDbSchemaState } = await import('../graph/freshness.js');
    expect(await readDbSchemaState(projectId)).toMatchObject({ state: 'fresh', tables: 1, nodes: 1 });
  });

  it('the process env URL is evidence for the PINNED project only (D7 half one)', async () => {
    // A second project, not the pinned slug. The env var must not be attributed
    // to it, so with no schema nodes it stays not-configured, not never-extracted.
    const other = await admin.query<{ id: string }>(
      `INSERT INTO projects (slug, name, path) VALUES ('freshness-other', 'Other', $1) RETURNING id`,
      [emptyDir]
    );
    try {
      process.env.MAI_GRAPH_DB_URL = LEAK_URL;
      const { readDbSchemaState } = await import('../graph/freshness.js');
      expect(await readDbSchemaState(other.rows[0].id)).toEqual({ state: 'not-configured' });
      // …and it IS evidence for the pinned one, same env, same call.
      expect(await readDbSchemaState(projectId)).toEqual({ state: 'never-extracted' });
    } finally {
      await admin.query(`DELETE FROM projects WHERE slug = 'freshness-other'`);
    }
  });
});

describe('non-pinned projects report truthfully and actionably (D7)', () => {
  it("a non-pinned project's OWN .env is still evidence, and the fix names the pinning requirement", async () => {
    // graphStale is reachable for any project (cli.ts:652, web-server.ts:295).
    // The project's own .env is project-scoped evidence, so `never-extracted` is
    // the true state — but `mai graph update` run from THIS session would not
    // resolve it (cli.ts:610), so the instruction has to say where to run it.
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mai-freshness-other-'));
    fs.writeFileSync(path.join(dir, '.env'), `MAI_GRAPH_DB_URL=${LEAK_URL}\n`);
    const other = await admin.query<{ id: string }>(
      `INSERT INTO projects (slug, name, path) VALUES ('freshness-other', 'Other', $1) RETURNING id`,
      [dir]
    );
    try {
      delete process.env.MAI_GRAPH_DB_URL; // prove it is the .env doing the work
      const { readDbSchemaState } = await import('../graph/freshness.js');
      expect(await readDbSchemaState(other.rows[0].id)).toEqual({ state: 'never-extracted' });
      const { graphStale } = await import('../graph/query.js');
      const out = await graphStale({ projectId: other.rows[0].id });
      expect(out).toContain('NEVER EXTRACTED');
      expect(out).toContain('from a session pinned to this project');
      expect(out).not.toContain('leakpassword'); // the leak rule holds off-pin too
    } finally {
      await admin.query(`DELETE FROM projects WHERE slug = 'freshness-other'`);
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('graphStale renders the DB-schema section', () => {
  it('renders the section when nothing is configured (silence was the bug)', async () => {
    const { graphStale } = await import('../graph/query.js');
    const out = await graphStale({ projectId });
    expect(out).toContain('## DB schema');
    expect(out).toContain('NOT CONFIGURED');
    expect(out).toContain('Two independent axes');
  });

  it('fails closed with the authoritative repair command when the physical product root is missing', async () => {
    await admin.query(`UPDATE projects SET path = NULL, metadata = '{}'::jsonb WHERE id = $1`, [projectId]);
    try {
      const { graphStale } = await import('../graph/query.js');
      await expect(graphStale({ projectId })).rejects.toThrow(/--replace-repos --repo <absolute-repo>/);
    } finally {
      await admin.query(`UPDATE projects SET path = $2 WHERE id = $1`, [projectId, emptyDir]);
    }
  });

  it('names the stale reason and the last introspection', async () => {
    // 1 table + 1 column = 2 db nodes, so the render is discriminating on BOTH
    // numbers rather than printing the same value twice.
    await seedNode('table', 't1', 'db', '2026-06-13T06:03:25Z');
    await seedNode('column', 'c1', 'db', '2026-06-13T06:03:25Z');
    await seedNode('function', 'a', 'ts', '2026-08-18T00:00:00Z');
    const { graphStale } = await import('../graph/query.js');
    const out = await graphStale({ projectId });
    expect(out).toContain('## DB schema');
    expect(out).toMatch(/1 tables, 2 nodes — last introspection 2026-06-13 06:03/);
    expect(out).toContain('STALE');
    expect(out).toContain('skipping the schema layer');
  });
});

describe('URL leak (mandatory)', () => {
  // prime/primeStartup are NOT asserted here: at this task prime does not call
  // readDbSchemaState at all, so a leak assertion against it could not fail for
  // the right reason. Task 3 Step 5 adds it once prime reads the schema axis.
  it('never renders the dev-DB URL in graphStale', async () => {
    process.env.MAI_GRAPH_DB_URL = LEAK_URL;
    await seedNode('table', 't1', 'db', '2026-06-13T06:03:25Z');
    await seedNode('function', 'a', 'ts', '2026-08-18T00:00:00Z');
    const { graphStale } = await import('../graph/query.js');
    const out = await graphStale({ projectId });
    expect(out).toContain('## DB schema'); // the section really rendered
    for (const secret of [LEAK_URL, 'leakpassword', 'leak.example.invalid', 'leakuser']) {
      expect(out).not.toContain(secret);
    }
  });

  it('never renders the dev-DB URL on the error path either', async () => {
    process.env.MAI_GRAPH_DB_URL = LEAK_URL;
    const { graphStale } = await import('../graph/query.js');
    const missing = '00000000-0000-0000-0000-000000000000';
    let text = '';
    try {
      text = await graphStale({ projectId: missing });
    } catch (e) {
      text = e instanceof Error ? `${e.message}\n${e.stack ?? ''}` : String(e);
    }
    expect(text).not.toContain('leakpassword');
    expect(text).not.toContain('leak.example.invalid');
  });

  it('freshness.ts consumes the resolver inline and never binds the URL', () => {
    // Structural, not aspirational: the resolver result is compared in the same
    // expression it is produced in, so there is no variable holding a URL.
    const src = fs.readFileSync(
      new URL('../graph/freshness.ts', import.meta.url),
      'utf8'
    );
    // Count CODE, not file text. The module deliberately spells the env var
    // inside its render strings (operators need to be told what to set) and
    // explains the scoping rules in comments; a raw-text count would pin the
    // prose and pass while a second real read slipped in. No string literal in
    // this file contains `/*` or begins a line with `//`, so the strip is safe.
    const code = src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
    // REACH GUARD: the strip must remove comments, not the module.
    expect(code).toContain('export function classifyDbSchema');
    expect(code).toContain('async function isGraphDbUrlConfigured');
    expect((code.match(/process\.env\.MAI_GRAPH_DB_URL/g) ?? []).length).toBe(1);
    expect((code.match(/resolveConsumerGraphDbUrl/g) ?? []).length).toBe(2); // import + one inline call
    expect(code).toMatch(/\(await resolveConsumerGraphDbUrl\(projectId\)\) !== undefined/);
    expect(code).not.toMatch(/=\s*await resolveConsumerGraphDbUrl/);
  });

  it('never renders the dev-DB URL in prime or the compact briefing (Task 3)', async () => {
    process.env.MAI_GRAPH_DB_URL = LEAK_URL;
    delete process.env.MAI_PRIME_STARTUP;
    await seedNode('table', 't1', 'db', '2026-06-13T06:03:25Z');
    await seedNode('function', 'a', 'ts', '2026-08-18T00:00:00Z');
    const { prime, primeStartup } = await import('../prime.js');
    const full = await prime('leak probe', 'summary');
    const compact = await primeStartup();
    // Both really rendered the schema axis — otherwise this proves nothing.
    expect(full).toMatch(/_Graph \(db schema\): /);
    expect(compact).toContain('db schema:');
    for (const out of [full, compact]) {
      for (const secret of [LEAK_URL, 'leakpassword', 'leak.example.invalid', 'leakuser']) {
        expect(out).not.toContain(secret);
      }
    }
  });
});

describe('budgeted freshness envelope lines (plan 38)', () => {
  it('code axis keeps all three shapes and maxes at exactly 55 chars', async () => {
    const { renderCodePrimeEnvelopeLine, CODE_FRESHNESS_LINE_MAX } = await import('../graph/freshness.js');
    expect(CODE_FRESHNESS_LINE_MAX).toBe(55);
    expect(renderCodePrimeEnvelopeLine({ total: 0, stale: 0 , method: 'per-file' }))
      .toBe('_Graph (code): not built — mai graph build._');
    expect(renderCodePrimeEnvelopeLine({ total: 10, stale: 0 , method: 'per-file' }))
      .toBe('_Graph (code): 10 nodes, source verified._');
    const max = renderCodePrimeEnvelopeLine({ total: 999_999, stale: 999_999 , method: 'per-file' });
    expect(max).toBe('_Graph (code): 999999/999999 stale — mai graph update._');
    expect(max).toHaveLength(CODE_FRESHNESS_LINE_MAX);
    const over = renderCodePrimeEnvelopeLine({ total: 1_000_000, stale: 1_000_000 , method: 'per-file' });
    expect(over).toBe('_Graph (code): ≥1M/≥1M stale — mai graph update._');
    expect(over.length).toBeLessThanOrEqual(CODE_FRESHNESS_LINE_MAX);
    expect(renderCodePrimeEnvelopeLine({ total: Number.NaN, stale: 5 , method: 'per-file' }))
      .toContain('?');
  });

  it('schema axis keeps every state and maxes at exactly 83 chars', async () => {
    const { renderDbSchemaPrimeEnvelopeLine, DB_SCHEMA_FRESHNESS_LINE_MAX } =
      await import('../graph/freshness.js');
    expect(DB_SCHEMA_FRESHNESS_LINE_MAX).toBe(83);
    expect(renderDbSchemaPrimeEnvelopeLine({ state: 'not-configured' }))
      .toBe(`_Graph (db schema): not configured; kind:'table' returns none._`);
    expect(renderDbSchemaPrimeEnvelopeLine({ state: 'never-extracted' }))
      .toBe('_Graph (db schema): never extracted — mai graph update._');

    const noUrl = renderDbSchemaPrimeEnvelopeLine({
      state: 'stale', reason: 'no-url', tables: 999_999, nodes: 999_999, lastExtracted: null,
    });
    expect(noUrl).toBe('_Graph (db schema): 999999 tables, STALE (no URL); answers may be incomplete._');
    expect(noUrl.length).toBeLessThanOrEqual(DB_SCHEMA_FRESHNESS_LINE_MAX);

    const behind = renderDbSchemaPrimeEnvelopeLine({
      state: 'stale', reason: 'behind-code', tables: 999_999, nodes: 999_999, lastExtracted: null,
    });
    expect(behind)
      .toBe('_Graph (db schema): 999999 tables, STALE (behind code); answers may be incomplete._');
    expect(behind).toHaveLength(DB_SCHEMA_FRESHNESS_LINE_MAX);

    const overBehind = renderDbSchemaPrimeEnvelopeLine({
      state: 'stale', reason: 'behind-code', tables: 1_000_000, nodes: 1_000_000, lastExtracted: null,
    });
    expect(overBehind).toContain('≥1M tables');
    expect(overBehind.length).toBeLessThanOrEqual(DB_SCHEMA_FRESHNESS_LINE_MAX);

    const fresh = renderDbSchemaPrimeEnvelopeLine({
      state: 'fresh', tables: 999_999, nodes: 999_999,
      lastExtracted: new Date('2026-08-27T12:34:56.000Z'),
    });
    expect(fresh)
      .toBe('_Graph (db schema): 999999 tables, fresh as of 2026-08-27 12:34; not live._');
    expect(fresh.length).toBeLessThanOrEqual(DB_SCHEMA_FRESHNESS_LINE_MAX);

    // Accepted expanded-year timestamps keep their complete signed minute token.
    const positive = renderDbSchemaPrimeEnvelopeLine({
      state: 'fresh', tables: 999_999, nodes: 999_999,
      lastExtracted: new Date('+010000-01-01T12:34:56.000Z'),
    });
    expect(positive).toContain('+010000-01-01 12:34');
    expect(positive).toContain('not live');
    expect(positive).toHaveLength(78);
    expect(positive.length).toBeLessThanOrEqual(DB_SCHEMA_FRESHNESS_LINE_MAX);

    const negative = renderDbSchemaPrimeEnvelopeLine({
      state: 'fresh', tables: 999_999, nodes: 999_999,
      lastExtracted: new Date('-000001-01-01T12:34:56.000Z'),
    });
    expect(negative).toContain('-000001-01-01 12:34');
    expect(negative.length).toBeLessThanOrEqual(DB_SCHEMA_FRESHNESS_LINE_MAX);
  });
});

describe('one staleness producer (R3)', () => {
  it('graphStaleCounts and graphStale report the SAME totals for one project', async () => {
    const { graphStaleCounts } = await import('../graph/freshness.js');
    const { graphStale } = await import('../graph/query.js');
    const { seedTwoFileRepoWithOneChange } = await import('./staleness-fixture.js');
    // Seed: two files at sha A, commit a change to ONE, so the honest answer is
    // a partial count rather than 0 or N — a vacuous fixture would let both
    // producers agree on nothing.
    const { projectId, repo } = await seedTwoFileRepoWithOneChange(admin);
    try {
      const counts = await graphStaleCounts(projectId);
      const markdown = await graphStale({ projectId });

      // graphStale renders `## <repo> — <stale>/<total> stale (HEAD …)`.
      const heading = /^## .+ — (\d+)\/(\d+) stale/m.exec(markdown);
      expect(heading).not.toBeNull();
      const staleText = heading?.[1] ?? '';
      const totalText = heading?.[2] ?? '';

      expect(Number(staleText)).toBe(counts.stale);
      expect(Number(totalText)).toBe(counts.total);
      // And the shared fixture's known answer, so agreeing on a wrong number fails:
      expect(counts.stale).toBe(1);
      expect(counts.total).toBe(2);
      expect(counts.method).toBe('per-file');
    } finally {
      await admin.query(`DELETE FROM projects WHERE id = $1`, [projectId]);
      fs.rmSync(repo, { recursive: true, force: true });
    }
  });

  it('the budgeted envelope line is byte-identical to its pinned form', async () => {
    const { renderCodePrimeEnvelopeLine } = await import('../graph/freshness.js');
    expect(renderCodePrimeEnvelopeLine({ total: 999999, stale: 999999, method: 'per-file' }))
      .toBe('_Graph (code): 999999/999999 stale — mai graph update._');
    // The discriminator must NOT leak into the budgeted line (R4).
    expect(renderCodePrimeEnvelopeLine({ total: 999999, stale: 999999, method: 'whole-graph' }))
      .toBe('_Graph (code): 999999/999999 stale — mai graph update._');
  });

  it('the DB-schema axis preserves its state strings with the schema-pass noun', async () => {
    const { renderDbSchemaPrimeLine } = await import('../graph/freshness.js');
    // Literal goldens: the fresh noun names the refreshing pass; other states stay pinned.
    // OLD renders '2026-06-13 06:03' and NEW '2026-08-18 05:59' through asOf.
    expect(renderDbSchemaPrimeLine({ state: 'not-configured' }))
      .toBe(`_Graph (db schema): not configured — no MAI_GRAPH_DB_URL for this project; kind:'table' questions will find nothing._`);
    expect(renderDbSchemaPrimeLine({ state: 'never-extracted' }))
      .toBe('_Graph (db schema): configured but never extracted — run mai graph update._');
    expect(renderDbSchemaPrimeLine({ state: 'stale', reason: 'no-url', tables: 10, nodes: 142, lastExtracted: OLD }))
      .toBe('_Graph (db schema): 10 tables as of 2026-06-13 06:03 — STALE: no MAI_GRAPH_DB_URL resolvable, so mai graph update is skipping the schema layer. Schema answers may be missing or wrong._');
    expect(renderDbSchemaPrimeLine({ state: 'stale', reason: 'behind-code', tables: 10, nodes: 142, lastExtracted: OLD }))
      .toBe('_Graph (db schema): 10 tables as of 2026-06-13 06:03 — STALE: a newer code extraction ran without a schema refresh. Schema answers may be missing or wrong._');
    expect(renderDbSchemaPrimeLine({ state: 'fresh', tables: 10, nodes: 142, lastExtracted: NEW }))
      .toBe('_Graph (db schema): 10 tables, schema pass 2026-08-18 05:59 (as of that pass — not a live comparison)._');
  });
});

describe('compact startup qualifier (fourth surface)', () => {
  it('a whole-graph fallback is qualified (unverified)', async () => {
    delete process.env.MAI_PRIME_STARTUP;
    const { primeStartup } = await import('../prime.js');
    // emptyDir is a plain mkdtemp, never git init'd, so headSha is null and
    // repoStaleness takes the whole-graph branch. file_path must live UNDER
    // the registered root or the node falls outside every starts_with()
    // staleness query — which is why seedNode (file_path NULL) cannot be
    // reused here. And it must be the CANONICAL root: loadProjectGraphRoots
    // realpaths every registered root (roots.ts:36-42 via db.ts:222-225), so
    // on macOS the raw mkdtemp '/var/folders/…' compares against
    // '/private/var/folders/…' and a raw-path node silently falls outside the
    // query — the same realpath discipline Task 2 Step 0's fixture and
    // graph-contract-gates.test.ts:276 already follow.
    const realRoot = fs.realpathSync.native(emptyDir);
    await admin.query(
      `INSERT INTO graph_nodes (project_id, kind, name, qualified_name, file_path, extracted_by, commit_sha)
       VALUES ($1, 'function', 'w', 'ts.w', $2, 'ts', NULL)`,
      [projectId, path.join(realRoot, 'w.ts')],
    );
    try {
      const compact = await primeStartup();
      expect(compact).toContain('Graph: 1/1 nodes stale (unverified)');
    } finally {
      await resetNodes();
    }
  });

  it('a per-file count carries no qualifier', async () => {
    delete process.env.MAI_PRIME_STARTUP;
    const { primeStartup } = await import('../prime.js');
    const { seedTwoFileRepoWithOneChange } = await import('./staleness-fixture.js');
    // Re-home the pinned project onto the fixture's REAL git repo and move the
    // fixture's nodes onto it, so primeStartup (which reads the env-pinned
    // project) sees a per-file 1-of-2 answer. The restore-in-finally pattern
    // is the same one prime.test.ts uses for its lifecycle fixture.
    const fixture = await seedTwoFileRepoWithOneChange(admin);
    try {
      await admin.query(
        `UPDATE graph_nodes SET project_id = $1 WHERE project_id = $2`,
        [projectId, fixture.projectId],
      );
      await admin.query(
        `UPDATE projects SET path = $2, metadata = jsonb_build_object('repos', jsonb_build_array($2::text)) WHERE id = $1`,
        [projectId, fixture.repo],
      );
      const compact = await primeStartup();
      expect(compact).toContain('Graph: 1/2 nodes stale');
      expect(compact).not.toContain('(unverified)');
    } finally {
      await resetNodes();
      await admin.query(
        `UPDATE projects SET path = $2, metadata = jsonb_build_object('repos', jsonb_build_array($2::text)) WHERE id = $1`,
        [projectId, emptyDir],
      );
      await admin.query(`DELETE FROM projects WHERE id = $1`, [fixture.projectId]);
      fs.rmSync(fixture.repo, { recursive: true, force: true });
    }
  });
});

describe('schema re-stamp after a successful refresh (R10)', () => {
  // A refusal on a closed local port: passes dialectOf() at the choke point,
  // then fails inside the extractor — the "introspection threw" path.
  const REFUSED_URL = 'postgresql://nobody:nobody@127.0.0.1:1/nope';

  interface R10Fixture { projectId: string; repo: string; slug: string }

  async function seedRefreshFixture(): Promise<R10Fixture> {
    const { seedTwoFileRepoWithOneChange } = await import('./staleness-fixture.js');
    const fixture = await seedTwoFileRepoWithOneChange(admin);
    // The project's OWN .env is the project-scoped URL evidence
    // (isGraphDbUrlConfigured → resolveConsumerGraphDbUrl); the process-scoped
    // MAI_GRAPH_DB_URL only counts for the env-pinned project, which this
    // throwaway fixture is not. Untracked, so it never enters a git diff.
    fs.writeFileSync(path.join(fixture.repo, '.env'), `MAI_GRAPH_DB_URL=${TEST_DB}\n`);
    // One committed shell script, so the shell extractor — which runs AFTER the
    // db extractor in both producers — emits a node stamped after the schema
    // pass. Without a late-extractor node the ordering defect is invisible on
    // this fixture and a re-stamp moved before those extractors (S6) survives.
    fs.writeFileSync(path.join(fixture.repo, 'run.sh'), '#!/usr/bin/env bash\necho hi\n');
    execFileSync('git', ['-C', fixture.repo, '-c', 'user.email=t@t', '-c', 'user.name=t', 'add', 'run.sh']);
    execFileSync('git', ['-C', fixture.repo, '-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-qm', 'add run.sh']);
    const slugRow = await admin.query<{ slug: string }>(`SELECT slug FROM projects WHERE id = $1`, [fixture.projectId]);
    return { ...fixture, slug: slugRow.rows[0].slug };
  }

  async function dropFixture(f: R10Fixture): Promise<void> {
    await admin.query(`DELETE FROM projects WHERE id = $1`, [f.projectId]);
    fs.rmSync(f.repo, { recursive: true, force: true });
  }

  /** Two pre-existing schema nodes stamped OLD — the un-refreshed control. */
  async function seedOldSchema(projectId: string): Promise<void> {
    for (const [kind, name] of [['table', 'old_t'], ['column', 'old_t.c']] as const) {
      await admin.query(
        `INSERT INTO graph_nodes (project_id, kind, name, qualified_name, extracted_by, extracted_at)
         VALUES ($1, $2, $3, $4, 'db', $5::timestamptz)`,
        [projectId, kind, name, `db.${name}`, OLD.toISOString()],
      );
    }
  }

  interface AxisStamps { dbLast: Date | null; codeLast: Date | null; dbNodes: number; dbTables: number; codeAfterSchema: number }
  /** Millis of a stamp that the case has already asserted non-null; a null here
   * fails loudly rather than being narrowed away by an assertion. */
  const millis = (d: Date | null): number => {
    if (d === null) throw new Error('expected a non-null extracted_at stamp');
    return d.getTime();
  };
  async function stamps(projectId: string): Promise<AxisStamps> {
    const r = await admin.query<{ db_last: Date | null; code_last: Date | null; db_nodes: string; db_tables: string; code_after: string }>(
      `SELECT MAX(extracted_at) FILTER (WHERE extracted_by = 'db') AS db_last,
              MAX(extracted_at) FILTER (WHERE extracted_by <> 'db') AS code_last,
              COUNT(*) FILTER (WHERE extracted_by = 'db')::text AS db_nodes,
              COUNT(*) FILTER (WHERE extracted_by = 'db' AND kind = 'table')::text AS db_tables,
              COUNT(*) FILTER (WHERE extracted_by <> 'db'
                AND extracted_at >= (SELECT MIN(extracted_at) FROM graph_nodes g2
                                       WHERE g2.project_id = $1 AND g2.extracted_by = 'db'))::text AS code_after
         FROM graph_nodes WHERE project_id = $1`,
      [projectId],
    );
    const row = r.rows[0];
    return {
      dbLast: row.db_last ? new Date(row.db_last) : null,
      codeLast: row.code_last ? new Date(row.code_last) : null,
      dbNodes: Number(row.db_nodes),
      dbTables: Number(row.db_tables),
      codeAfterSchema: Number(row.code_after),
    };
  }

  it('a successful runGraphUpdate refresh leaves the schema fresh, not behind-code', async () => {
    const f = await seedRefreshFixture();
    try {
      const { runGraphUpdate } = await import('../graph/update.js');
      const { readDbSchemaState } = await import('../graph/freshness.js');
      const { dbExtractor } = await import('../graph/extractors/db.js');
      // Independent "before": what the extractor emits for this schema, counted
      // before any re-stamp could touch the stored rows (assertion 4).
      const emitted = await dbExtractor.extract({ projectId: f.projectId, repoPaths: [], dbUrl: TEST_DB });
      const emittedTables = emitted.nodes.filter((n) => n.kind === 'table').length;

      const out = await runGraphUpdate({ projectId: f.projectId, slug: f.slug, dbUrl: TEST_DB });
      expect(out).toMatch(/^- db: \d+ nodes, \d+ edges \(full re-introspection/m);
      expect(out).toMatch(/^- freshness: \d+ schema nodes re-stamped to this pass$/m);

      const s = await stamps(f.projectId);
      expect(s.dbLast).not.toBeNull();
      expect(s.codeLast).not.toBeNull();
      // Assertion 1: the schema stamp is at or past every code stamp.
      expect(millis(s.dbLast)).toBeGreaterThanOrEqual(millis(s.codeLast));
      // Assertion 4: re-stamping changed only extracted_at — the stored table
      // and node counts still equal what the extractor emitted.
      expect(s.dbNodes).toBe(emitted.nodes.length);
      expect(s.dbTables).toBe(emittedTables);
      // Assertion 5: no code node carries the schema pass's stamp.
      expect(s.codeAfterSchema).toBe(0);

      expect(await readDbSchemaState(f.projectId)).toMatchObject({ state: 'fresh', tables: emittedTables, nodes: emitted.nodes.length });
    } finally {
      await dropFixture(f);
    }
  });

  it('runGraphUpdate with no dbUrl leaves an old schema untouched and behind-code (the control)', async () => {
    const f = await seedRefreshFixture();
    try {
      await seedOldSchema(f.projectId);
      const { runGraphUpdate } = await import('../graph/update.js');
      const { readDbSchemaState } = await import('../graph/freshness.js');
      const out = await runGraphUpdate({ projectId: f.projectId, slug: f.slug });
      expect(out).toContain('- db: skipped (no MAI_GRAPH_DB_URL');
      expect(out).not.toContain('schema nodes re-stamped');
      const s = await stamps(f.projectId);
      expect(s.dbLast?.toISOString()).toBe(OLD.toISOString());
      expect(s.dbNodes).toBe(2);
      expect(await readDbSchemaState(f.projectId)).toMatchObject({ state: 'stale', reason: 'behind-code' });
    } finally {
      await dropFixture(f);
    }
  });

  it('runGraphUpdate whose introspection threw never re-stamps: a failed refresh cannot read fresh', async () => {
    const f = await seedRefreshFixture();
    try {
      await seedOldSchema(f.projectId);
      const { runGraphUpdate } = await import('../graph/update.js');
      const { readDbSchemaState } = await import('../graph/freshness.js');
      const out = await runGraphUpdate({ projectId: f.projectId, slug: f.slug, dbUrl: REFUSED_URL });
      expect(out).toContain('- db: skipped (introspection failed');
      expect(out).not.toContain('schema nodes re-stamped');
      const s = await stamps(f.projectId);
      expect(s.dbLast?.toISOString()).toBe(OLD.toISOString());
      expect(await readDbSchemaState(f.projectId)).toMatchObject({ state: 'stale', reason: 'behind-code' });
    } finally {
      await dropFixture(f);
    }
  });

  it('classifyDbSchema is unmodified: the behind-code rule still reads the raw stamps (R5)', async () => {
    const { classifyDbSchema } = await import('../graph/freshness.js');
    const inputs = { dbNodes: 2, dbTables: 1, dbLastExtracted: OLD, codeLastExtracted: NEW, urlConfigured: true };
    expect(classifyDbSchema(inputs)).toEqual({ state: 'stale', reason: 'behind-code', tables: 1, nodes: 2, lastExtracted: OLD });
    expect(classifyDbSchema({ ...inputs, dbLastExtracted: NEW, codeLastExtracted: OLD }))
      .toEqual({ state: 'fresh', tables: 1, nodes: 2, lastExtracted: NEW });
  });

  it('runGraphBuild: the same holds at the second producer — with a dbUrl fresh, without one untouched', async () => {
    const withUrl = await seedRefreshFixture();
    const noUrl = await seedRefreshFixture();
    try {
      const { runGraphBuild } = await import('../graph/build.js');
      const { readDbSchemaState } = await import('../graph/freshness.js');
      const { dbExtractor } = await import('../graph/extractors/db.js');
      const emitted = await dbExtractor.extract({ projectId: withUrl.projectId, repoPaths: [], dbUrl: TEST_DB });
      const emittedTables = emitted.nodes.filter((n) => n.kind === 'table').length;

      const built = await runGraphBuild({ projectId: withUrl.projectId, slug: withUrl.slug, dbUrl: TEST_DB });
      expect(built).toMatch(/^- db: \d+ nodes, \d+ edges/m);
      expect(built).toMatch(/^- freshness: \d+ schema nodes re-stamped to this pass$/m);
      const s = await stamps(withUrl.projectId);
      expect(millis(s.dbLast)).toBeGreaterThanOrEqual(millis(s.codeLast));
      expect(s.dbNodes).toBe(emitted.nodes.length);
      expect(s.dbTables).toBe(emittedTables);
      expect(s.codeAfterSchema).toBe(0);
      expect(await readDbSchemaState(withUrl.projectId)).toMatchObject({ state: 'fresh', tables: emittedTables });

      // The no-dbUrl half: a build still produces every code-extractor summary,
      // so a re-stamp keyed off "any summary" (S9) would touch these OLD rows.
      await seedOldSchema(noUrl.projectId);
      const rebuilt = await runGraphBuild({ projectId: noUrl.projectId, slug: noUrl.slug });
      expect(rebuilt).not.toContain('- db:');
      expect(rebuilt).not.toContain('schema nodes re-stamped');
      const c = await stamps(noUrl.projectId);
      expect(c.dbLast?.toISOString()).toBe(OLD.toISOString());
      expect(c.dbNodes).toBe(2);
      expect(await readDbSchemaState(noUrl.projectId)).toMatchObject({ state: 'stale', reason: 'behind-code' });
    } finally {
      await dropFixture(withUrl);
      await dropFixture(noUrl);
    }
  });

  it('runGraphBuild whose introspection threw aborts before any re-stamp', async () => {
    const f = await seedRefreshFixture();
    try {
      await seedOldSchema(f.projectId);
      const { runGraphBuild } = await import('../graph/build.js');
      await expect(runGraphBuild({ projectId: f.projectId, slug: f.slug, dbUrl: REFUSED_URL })).rejects.toThrow();
      const s = await stamps(f.projectId);
      expect(s.dbLast?.toISOString()).toBe(OLD.toISOString());
      expect(s.dbNodes).toBe(2);
    } finally {
      await dropFixture(f);
    }
  });
});
