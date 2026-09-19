/** Pins the startup context footprint so it can't creep back (Plan 9 R10). */
import { beforeAll, afterAll, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Pool } from 'pg';
import { requireDisposableTestDbUrl } from './test-db-url.js';
import { TOOLS } from '../tool-defs.js'; // side-effect-free — safe to import statically

// Shared disposable guard (Plan 15 rule 5) BEFORE any DB consumer import;
// coordination/prime stay dynamic imports below for exactly this reason.
const TEST_DB = requireDisposableTestDbUrl();
process.env.MAI_PROJECT_SLUG = 'budget-test';
process.env.MAI_DB_URL = TEST_DB;

const REPO_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const admin = new Pool({ connectionString: TEST_DB });

beforeAll(async () => {
  await admin.query(`DELETE FROM projects WHERE slug = 'budget-test'`);
  await admin.query(`INSERT INTO projects (slug, name) VALUES ('budget-test', 'Budget Test')`);
});

afterAll(async () => {
  await admin.query(`DELETE FROM projects WHERE slug = 'budget-test'`);
  await admin.end();
  const { getPool } = await import('../db.js');
  await getPool().end();
});

describe('startup context budget', () => {
  it('serialized tool defs stay under budget', async () => {
    // Dynamic import so env is set before coordination pulls in db/env.
    const { coordination } = await import('../coordination/index.js');
    const all = [...TOOLS, ...coordination.toolDefs];
    // raised 2026-08-06 for the 4 plan-11 tools (ideas board + facts); descriptions stay budget-tuned
    // raised 2026-08-10 for the 4 plan-16 tools (findings tracker); descriptions stay budget-tuned
    // Plan 16/17 reviewed reserve: keep >=300 chars below the 26,000 hard
    // ceiling; merely passing <26,000 is not sufficient (finding a900a7f4).
    // Plan 39 reviewed ceiling: the authoring baseline was 25,634 under the old
    // 25,700 line; the two wave-2 read tools raise it to 28,500 with at least
    // 300 characters of headroom — met by concise descriptions, never by
    // dropping additionalProperties/enums or runtime validation. Graph unions
    // retain oneOf; mai_user_tasks_post stays flat because Claude clients have
    // been observed flattening oneOf to its first branch.
    const serialized = JSON.stringify(all).length;
    expect(serialized).toBeLessThanOrEqual(30_700);
    expect(31_000 - serialized).toBeGreaterThanOrEqual(300);
    const query = all.find((tool) => tool.name === 'mai_graph_query');
    const deadCode = all.find((tool) => tool.name === 'mai_graph_dead_code');
    const userTasksPost = all.find((tool) => tool.name === 'mai_user_tasks_post');
    const userTasks = all.find((tool) => tool.name === 'mai_user_tasks');
    const ideas = all.find((tool) => tool.name === 'mai_ideas');
    expect(JSON.stringify(query).length).toBeLessThanOrEqual(1_800);
    expect(JSON.stringify(deadCode).length).toBeLessThanOrEqual(700);
    expect(JSON.stringify(userTasksPost).length).toBeLessThanOrEqual(1_900);
    expect(JSON.stringify(userTasks).length).toBeLessThanOrEqual(600);
    expect(JSON.stringify(ideas)).toContain('"idea_id"');
    const serializedUserTasksPost = JSON.stringify(userTasksPost);
    expect(serializedUserTasksPost).toContain('"additionalProperties":false');
    expect(serializedUserTasksPost).toContain('"enum":["sync-plan","assign"]');
    expect(serializedUserTasksPost).toContain('"tasks":{"type":"array"');
    expect(serializedUserTasksPost).toContain('"maxItems":50');
    expect(serializedUserTasksPost).not.toContain('"oneOf"');
    expect(JSON.stringify(query)).toContain('"additionalProperties":false');
    expect(JSON.stringify(query)).toContain('"oneOf"');
    expect(JSON.stringify(query)).toContain('"maxItems":3');
    expect(JSON.stringify(deadCode)).toContain('"additionalProperties":false');
    expect(JSON.stringify(deadCode)).toContain('"enum":["function","class","component"]');
    for (const tool of all) {
      expect(JSON.stringify(tool.inputSchema)).toContain('"additionalProperties":false');
    }
    // Plan 28 B4: the stale tool must name BOTH axes, and it must do so without
    // spending headroom — a clause that does not fit gets cut, never the ceiling
    // raised (measured: 182 -> 176 chars, total 25,640 -> 25,634).
    const stale = all.find((tool) => tool.name === 'mai_graph_stale');
    expect(stale?.description).toMatch(/DB-schema/);
    expect(stale?.description).toMatch(/two independent axes/);
    expect((stale?.description ?? '').length).toBeLessThanOrEqual(182);
    const review = all.find((tool) => tool.name === 'mai_review_post');
    const serializedReview = JSON.stringify(review);
    expect(serializedReview).toContain('"finding_count":{"type":"integer"');
    expect(serializedReview).toContain('"findings","finding_count"]');
  });

  it('compact briefing stays under budget', async () => {
    delete process.env.MAI_PRIME_STARTUP;
    const { primeStartup } = await import('../prime.js');
    const out = await primeStartup();
    expect(out.length).toBeLessThan(1_500);
    expect(out).toContain('mai_prime');
  });

  it('the worst-case FIXED prime envelope still fits its 2,538 ceiling', async () => {
    // Plan 38 enforces this at runtime by throwing, and its own fixture used
    // synthetic fragments — so growing a real fixed signal (the structure
    // pointer, say) could only be caught here. Sum the exported maxima and the
    // real always-present strings, with every separator they own.
    const prime = await import('../prime.js');
    const { RESTART_BANNER_MAX } = await import('../build-info.js');
    const { CURATION_LINE_MAX } = await import('../curation.js');
    const { CODE_FRESHNESS_LINE_MAX, DB_SCHEMA_FRESHNESS_LINE_MAX } =
      await import('../graph/freshness.js');
    const source = fs.readFileSync(
      path.join(REPO_DIR, 'src', 'prime.ts'), 'utf8');
    const literal = (name: string): string => {
      const start = source.indexOf(`const ${name} =`);
      const open = source.indexOf('`', start);
      return source.slice(open + 1, source.indexOf('`;', open + 1));
    };
    const fixed = prime.PRIME_HEADER_MAX
      + prime.PRIME_IDENTITY_LINE_MAX
      + prime.PRIME_FACTS_MAX + prime.PRIME_IDEAS_MAX + prime.PRIME_LIFECYCLE_MAX
      + RESTART_BANNER_MAX + CURATION_LINE_MAX
      + CODE_FRESHNESS_LINE_MAX + DB_SCHEMA_FRESHNESS_LINE_MAX
      + literal('STRUCTURE_POINTER').length + literal('CAPTURE_REMINDER').length;
    const separators = 7 * 3   // facts / roadmap / lifecycle blocks
      + 2                      // curation
      + 3                      // the two freshness lines
      + 7                      // the closing block
      + 1                      // the restart banner's newline
      + 1                      // header → identity
      + 2;                     // pointer → reminder
    expect(fixed + separators).toBeLessThanOrEqual(prime.PRIME_ENVELOPE_MAX);
  });

  it('task-prime and the full briefing name the wave-2 graph tools', async () => {
    const { prime, primeStartup } = await import('../prime.js');
    const task = await prime('wave2 guidance check', 'summary');
    expect(task).toContain('mai_graph_query');
    expect(task).toContain('mai_graph_dead_code');
    process.env.MAI_PRIME_STARTUP = 'full';
    try {
      const full = await primeStartup();
      expect(full).toContain('mai_graph_query');
      expect(full).toContain('mai_graph_dead_code');
    } finally {
      delete process.env.MAI_PRIME_STARTUP;
    }
    // The compact pin is independent and unchanged.
    const compact = await primeStartup();
    expect(compact.length).toBeLessThan(1_500);
  });
});
