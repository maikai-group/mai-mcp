/** Plan 24 test 20(b) ONLY. `vi.mock` is hoisted and file-scoped, so injecting
 * a failing recordFindingReferences in the main suite would replace
 * ../curation.js for every test in that file — including 20(a)'s citation
 * assertion. This file exists so the injection has nothing else to break.
 * It keeps the same disposable-database pin and cleanup as its sibling:
 * file-scoped mocking is not permission to omit database isolation. */
import { beforeAll, afterAll, describe, expect, it, vi } from 'vitest';
import { Pool } from 'pg';
import { requireDisposableTestDbUrl } from './test-db-url.js';

const saved: Record<string, string | undefined> = {
  MAI_PROJECT_SLUG: process.env.MAI_PROJECT_SLUG,
  MAI_DB_URL: process.env.MAI_DB_URL,
  MAI_LLM_SUMMARY: process.env.MAI_LLM_SUMMARY,
  MAI_AGENT_ID: process.env.MAI_AGENT_ID,
  MAI_EMBEDDINGS: process.env.MAI_EMBEDDINGS,
};
const SLUG = 'plan24-atomicity';
process.env.MAI_PROJECT_SLUG = SLUG;
process.env.MAI_DB_URL = requireDisposableTestDbUrl();
process.env.MAI_LLM_SUMMARY = '0';
process.env.MAI_AGENT_ID = 'tester@vitest';
process.env.MAI_EMBEDDINGS = '0';

const admin = new Pool({ connectionString: process.env.MAI_DB_URL });

vi.mock('../curation.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../curation.js')>()),
  recordFindingReferences: vi.fn().mockRejectedValue(new Error('injected')),
}));

beforeAll(async () => {
  await import('../db.js'); // dotenv defusal
  await admin.query(`DELETE FROM projects WHERE slug = $1`, [SLUG]);
  await admin.query(`INSERT INTO projects (slug, name) VALUES ($1,'Plan24 Atomicity')`, [SLUG]);
});

afterAll(async () => {
  for (const [k, v] of Object.entries(saved)) {
    if (v === undefined) delete process.env[k]; else process.env[k] = v;
  }
  await admin.query(`DELETE FROM projects WHERE slug = $1`, [SLUG]);
  await admin.end();
  const { getPool } = await import('../db.js');
  await getPool().end();
});

describe('20b: the finding and its citations are one transaction', () => {
  it('a failing recordFindingReferences rolls the finding back — no orphan row', async () => {
    const { codeFindingAdd, parseFinding } = await import('../code-findings.js');
    const title = 'PLAN24 atomicity fixture';
    await expect(codeFindingAdd(SLUG, parseFinding({
      base_sha: 'a', head_sha: 'b', severity: 'blocker', title,
      location: 'src/a.ts:1', issue: 'i', evidence: 'e', fix: 'f',
    }))).rejects.toThrow(/injected/);
    // Falsifiable in the intended direction: move recordFindingReferences
    // outside the transaction and this count becomes 1.
    const n = await admin.query<{ n: string }>(
      `SELECT count(*)::text AS n FROM code_findings WHERE title = $1`, [title]);
    expect(n.rows[0].n).toBe('0');
  });
});
