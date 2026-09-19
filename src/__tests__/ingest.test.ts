/**
 * Ingest fork: a fixture transcript parses into one code_sessions row with
 * counters, and re-ingest is idempotent via ON CONFLICT (original_session_id).
 * Seeds its own throwaway project (same pattern as isolation.test.ts).
 *
 * Requires: docker compose up -d && npm run db:init.
 */
import { fileURLToPath } from 'node:url';
import { beforeAll, afterAll, describe, expect, it } from 'vitest';
import { Pool } from 'pg';

process.env.MAI_PROJECT_SLUG = 'ingest-test';
process.env.MAI_DB_URL =
  process.env.MAI_DB_URL ?? 'postgresql://postgres:postgres@127.0.0.1:54334/mai_brain';

const admin = new Pool({ connectionString: process.env.MAI_DB_URL });

beforeAll(async () => {
  await admin.query(`DELETE FROM projects WHERE slug = 'ingest-test'`);
  await admin.query(`INSERT INTO projects (slug, name) VALUES ('ingest-test', 'Ingest Test')`);
});

afterAll(async () => {
  await admin.query(`DELETE FROM projects WHERE slug = 'ingest-test'`); // cascades sessions/commits
  await admin.end();
  const { getPool } = await import('../db.js');
  await getPool().end();
});

describe('ingest', () => {
  it('parses the fixture and writes one session row with counters', async () => {
    const { parseJsonl, writeSession } = await import('../ingest.js');
    const parsed = await parseJsonl(
      fileURLToPath(new URL('./fixtures/sample-session.jsonl', import.meta.url))
    );
    expect(parsed.messageCount).toBeGreaterThan(0);
    expect(parsed.toolCalls).toBeGreaterThan(0);
    const sessionUuid = await writeSession(parsed, 'fixture-original-id');
    const row = await admin.query(
      `SELECT message_count, tool_calls, commits FROM code_sessions WHERE id = $1`,
      [sessionUuid]
    );
    expect(row.rows[0].message_count).toBeGreaterThan(0);
    expect(row.rows[0].tool_calls).toBeGreaterThan(0);
  });

  it('writes NO decision rows from a plain ingest (thinking is never stored without the summary layer)', async () => {
    const { parseJsonl, writeSession } = await import('../ingest.js');
    const parsed = await parseJsonl(
      fileURLToPath(new URL('./fixtures/sample-session.jsonl', import.meta.url))
    );
    // The fixture contains a thinking block. A plain ingest (no MAI_LLM_SUMMARY)
    // must persist facts only — never thinking-as-decisions.
    expect(parsed.thinkingBlocks.length).toBeGreaterThan(0);
    const sessionUuid = await writeSession(parsed, 'fixture-original-id');
    const decRows = await admin.query(
      `SELECT count(*) FROM code_decisions WHERE session_id = $1`,
      [sessionUuid]
    );
    expect(Number(decRows.rows[0].count)).toBe(0);
  });

  it('re-ingest is idempotent (ON CONFLICT original_session_id)', async () => {
    const { parseJsonl, writeSession } = await import('../ingest.js');
    const parsed = await parseJsonl(
      fileURLToPath(new URL('./fixtures/sample-session.jsonl', import.meta.url))
    );
    await writeSession(parsed, 'fixture-original-id');
    const count = await admin.query(
      `SELECT count(*) FROM code_sessions WHERE original_session_id = 'fixture-original-id'`
    );
    expect(Number(count.rows[0].count)).toBe(1);
  });

  it('summarizer skip path: llmSummaryEnabled() is false without MAI_LLM_SUMMARY', async () => {
    // Hermetic: the gate is env-driven, so control MAI_LLM_SUMMARY here instead of
    // inheriting whatever a developer's .env sets. Restore it afterwards.
    const prev = process.env.MAI_LLM_SUMMARY;
    delete process.env.MAI_LLM_SUMMARY;
    try {
      const { llmSummaryEnabled } = await import('../summarize.js');
      expect(llmSummaryEnabled()).toBe(false);
    } finally {
      if (prev === undefined) delete process.env.MAI_LLM_SUMMARY;
      else process.env.MAI_LLM_SUMMARY = prev;
    }
  });
});
