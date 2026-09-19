/** Integration: watermark lifecycle, sealing, idempotency, incremental append,
 * shrink recovery (spec §6 integration list). Requires docker compose up -d. */
import { beforeAll, afterAll, beforeEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Pool } from 'pg';

process.env.MAI_PROJECT_SLUG = 'seg-ingest-test';
process.env.MAI_DB_URL =
  process.env.MAI_DB_URL ?? 'postgresql://postgres:postgres@127.0.0.1:54334/mai_brain';
process.env.MAI_LLM_SUMMARY = '0'; // rows only — MUST be '0', not deleted: src/env.ts
// runs dotenv.config() (override:false) on first module import, which RE-FILLS a
// deleted key from .env — a deleted var here means live billed Anthropic calls
// per segment (review B3, lesson 57ac4b5a). Setting '0' wins over dotenv.

const admin = new Pool({ connectionString: process.env.MAI_DB_URL });
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'mai-seg-ingest-'));

const L = (i: number, extra = '') =>
  `{"type":"assistant","timestamp":"2026-08-0${i}T00:00:00Z"${extra},"message":{"content":[{"type":"thinking","thinking":"block ${i}"}]}}`;

beforeAll(async () => {
  await admin.query(`DELETE FROM projects WHERE slug = 'seg-ingest-test'`);
  await admin.query(`INSERT INTO projects (slug, name) VALUES ('seg-ingest-test', 'Seg Ingest Test')`);
});
afterAll(async () => {
  await admin.query(`DELETE FROM projects WHERE slug = 'seg-ingest-test'`); // cascades sessions/watermarks
  await admin.end();
  const { getPool } = await import('../../db.js');
  await getPool().end();
});
beforeEach(async () => {
  await admin.query(
    `DELETE FROM code_sessions WHERE project_id = (SELECT id FROM projects WHERE slug='seg-ingest-test')`
  );
  await admin.query(
    `DELETE FROM transcript_watermarks WHERE project_id = (SELECT id FROM projects WHERE slug='seg-ingest-test')`
  );
});

async function run(file: string, dryRun = false) {
  const { ClaudeCodeAdapter } = await import('../claude-code.js');
  const { ingestTranscriptSegmented } = await import('../segment-ingest.js');
  return ingestTranscriptSegmented(
    new ClaudeCodeAdapter(),
    { path: file, transcriptId: 'seg-itest', harness: 'claude-code', cwd: '/tmp/x' },
    { dryRun }
  );
}
const rows = () =>
  admin
    .query(
      `SELECT original_session_id AS oid, metadata FROM code_sessions
        WHERE original_session_id LIKE 'seg-itest#%' ORDER BY oid`
    )
    .then((r) => r.rows);

describe('segmented ingest', () => {
  it('full ingest: 48h-gapped file → 2 segments, first sealed, watermark points at open', async () => {
    const f = path.join(tmp, 'a.jsonl');
    fs.writeFileSync(f, [L(1), L(3)].join('\n') + '\n'); // Aug 1 → Aug 3 = 48h gap
    const rep = await run(f);
    expect(rep).toMatchObject({ status: 'ingested', segmentsPersisted: 2, fullReingest: true });
    const r = await rows();
    expect(r.map((x) => x.oid)).toEqual(['seg-itest#0', 'seg-itest#1']);
    expect(r[0].metadata.segment_sealed).toBe(true);
    expect(r[1].metadata.segment_sealed).toBe(false);
    expect(r[1].metadata.harness).toBe('claude-code');
    // Scoped to the throwaway project (pass-3 blocker): live hooks write real
    // watermark rows to this table once Task 7 ships — unscoped queries go red.
    const wm = await admin.query(
      `SELECT open_seq FROM transcript_watermarks
        WHERE project_id = (SELECT id FROM projects WHERE slug='seg-ingest-test')`);
    expect(wm.rows[0].open_seq).toBe(1);
  });

  it('idempotency: second run with no change is a pure skip (0 segments touched)', async () => {
    const f = path.join(tmp, 'b.jsonl');
    fs.writeFileSync(f, L(1) + '\n');
    await run(f);
    const rep2 = await run(f);
    expect(rep2.status).toBe('unchanged');
  });

  it('incremental: appended gap seals the open segment; sealed rows untouched', async () => {
    const f = path.join(tmp, 'c.jsonl');
    fs.writeFileSync(f, [L(1), L(3)].join('\n') + '\n');
    await run(f);
    const before = await rows();
    fs.appendFileSync(f, L(5) + '\n'); // another 48h gap → #1 seals, #2 opens
    fs.utimesSync(f, new Date(), new Date(Date.now() + 5000)); // AFTER append — append resets mtime; same-ms would skip
    const rep = await run(f);
    expect(rep.segmentsPersisted).toBe(2); // re-persist #1 (now sealed) + new #2 — #0 never touched
    const after = await rows();
    expect(after.map((x) => x.oid)).toEqual(['seg-itest#0', 'seg-itest#1', 'seg-itest#2']);
    expect(after[1].metadata.segment_sealed).toBe(true);
    expect(after[2].metadata.segment_sealed).toBe(false);
    expect(after[0].metadata).toEqual(before[0].metadata); // sealed → untouched
  });

  it('shrink recovery: smaller file discards watermark and re-ingests fully', async () => {
    const f = path.join(tmp, 'd.jsonl');
    fs.writeFileSync(f, [L(1), L(3), L(5)].join('\n') + '\n');
    await run(f);
    fs.writeFileSync(f, L(1) + '\n'); // rewrite smaller
    fs.utimesSync(f, new Date(), new Date(Date.now() + 5000));
    const rep = await run(f);
    expect(rep.fullReingest).toBe(true);
    expect((await rows()).map((x) => x.oid)).toEqual(['seg-itest#0']);
  });

  it('dry-run writes nothing', async () => {
    const f = path.join(tmp, 'e.jsonl');
    fs.writeFileSync(f, [L(1), L(3)].join('\n') + '\n');
    const rep = await run(f, true);
    expect(rep).toMatchObject({ status: 'dry-run', segmentsPlanned: 2, segmentsPersisted: 0 });
    expect(await rows()).toEqual([]);
    expect((await admin.query(
      `SELECT count(*)::int AS n FROM transcript_watermarks
        WHERE project_id = (SELECT id FROM projects WHERE slug='seg-ingest-test')`)).rows[0].n).toBe(0);
  });
});

describe('superseded exclusions', () => {
  it('superseded rows are excluded from ALL listing surfaces (review W5)', async () => {
    const pid = (await admin.query(`SELECT id FROM projects WHERE slug='seg-ingest-test'`)).rows[0].id;
    await admin.query(
      `INSERT INTO code_sessions (project_id, original_session_id, started_at, summary, metadata)
       VALUES ($1, 'seg-old-collapsed', now(), 'SUPERSEDED-MARKER-SUMMARY', '{"superseded_by_segmentation": true}'::jsonb)`,
      [pid]
    );
    const { recentSessions, timeline, projectRecall } = await import('../../decisions.js');
    expect(await recentSessions(50, pid)).not.toContain('seg-old-collapsed');
    expect(await timeline(30, 100, pid)).not.toContain('seg-old-collapsed');
    expect(await projectRecall(pid)).not.toContain('SUPERSEDED-MARKER-SUMMARY');
  });
});

describe('reingest supersede procedure (curated preservation — load-bearing)', () => {
  it('deletes only uncurated extraction; promoted + retracted keep session_id; idempotent', async () => {
    const pid = (await admin.query(`SELECT id FROM projects WHERE slug='seg-ingest-test'`)).rows[0].id;
    const f = path.join(tmp, 'mig.jsonl');
    fs.writeFileSync(f, [L(1), L(3)].join('\n') + '\n');
    // Seed the old collapsed row + three decisions.
    const old = await admin.query(
      `INSERT INTO code_sessions (project_id, original_session_id, started_at)
       VALUES ($1, 'seg-mig', now()) RETURNING id`,
      [pid]
    );
    const oldId = old.rows[0].id;
    const dec = (source: string, retracted: boolean, desc: string) =>
      admin.query(
        `INSERT INTO code_decisions (session_id, project_id, decision_type, description, reasoning, source, retracted_at)
         VALUES ($1,$2,'workflow',$3,'r',$4,${retracted ? 'now()' : 'NULL'})`,
        [oldId, pid, desc, source]
      );
    await dec('session-extract', false, 'uncurated — must be deleted');
    await dec('user-approved', false, 'promoted — must survive');
    await dec('session-extract', true, 'retracted — must survive');

    // Run the supersede+reingest core exactly as runReingest does for one ref.
    const { ingestTranscriptSegmented } = await import('../segment-ingest.js');
    const { ClaudeCodeAdapter } = await import('../claude-code.js');
    const migrateOnce = async () => {
      const oldRow = await admin.query(
        `SELECT id FROM code_sessions WHERE project_id=$1 AND original_session_id='seg-mig'`, [pid]);
      const id = oldRow.rows[0].id;
      await admin.query(
        `DELETE FROM code_decisions WHERE session_id=$1 AND source='session-extract' AND retracted_at IS NULL`, [id]);
      await admin.query(
        `UPDATE code_sessions SET metadata = metadata || '{"superseded_by_segmentation": true}'::jsonb WHERE id=$1`, [id]);
      await admin.query(`DELETE FROM transcript_watermarks WHERE project_id=$1 AND transcript_path=$2`, [pid, f]);
      return ingestTranscriptSegmented(new ClaudeCodeAdapter(),
        { path: f, transcriptId: 'seg-mig', harness: 'claude-code', cwd: null }, { forceFull: true });
    };
    await migrateOnce();

    const decisions = await admin.query(
      `SELECT description, session_id FROM code_decisions WHERE project_id=$1 ORDER BY description`, [pid]);
    expect(decisions.rows.map((r) => r.description)).toEqual([
      'promoted — must survive',
      'retracted — must survive',
    ]);
    // A NULL session_id here is a migration failure, not cosmetic (spec §6).
    for (const r of decisions.rows) expect(r.session_id).toBe(oldId);

    const segs = await admin.query(
      `SELECT original_session_id FROM code_sessions WHERE original_session_id LIKE 'seg-mig#%' ORDER BY 1`);
    expect(segs.rows.length).toBe(2);

    // Idempotency (review B4): migrateOnce deletes the watermark, so the second
    // run is a full re-run, NOT 'unchanged' — idempotency here means the upsert
    // creates no additional rows and the delete predicate finds nothing further.
    const rep2 = await migrateOnce();
    expect(rep2.status).toBe('ingested');
    expect(rep2.segmentsPersisted).toBe(2);
    const segs2 = await admin.query(
      `SELECT count(*)::int AS n FROM code_sessions WHERE original_session_id LIKE 'seg-mig#%'`);
    expect(segs2.rows[0].n).toBe(2); // upsert, not insert — still exactly 2
    const decisions2 = await admin.query(`SELECT count(*)::int AS n FROM code_decisions WHERE project_id=$1`, [pid]);
    expect(decisions2.rows[0].n).toBe(2);
  });
});
