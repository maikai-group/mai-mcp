/** Orphan sweep integration (plan 27 Part A). The segment-ingest.test.ts
 * harness pattern: throwaway project on the 54334 brain (MAI_DB_URL overrides
 * for a disposable DB), MAI_LLM_SUMMARY='0' — set, never deleted (lesson
 * 57ac4b5a). The segmented fixture is the spec-§5 regression: an ingested
 * multi-segment transcript must NOT read as an orphan. */
import { beforeAll, afterAll, beforeEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Pool } from 'pg';
import { requireDisposableTestDbUrl } from './test-db-url.js';

process.env.MAI_PROJECT_SLUG = 'sweep-test';
process.env.MAI_DB_URL = requireDisposableTestDbUrl();
process.env.MAI_LLM_SUMMARY = '0';

const admin = new Pool({ connectionString: process.env.MAI_DB_URL });
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'mai-sweep-'));
const scopeRepo = path.join(tmp, 'scope-repo');

const L = (i: number) =>
  `{"type":"assistant","timestamp":"2026-08-0${i}T00:00:00Z","message":{"content":[{"type":"thinking","thinking":"block ${i}"}]}}`;

const ref = (file: string, id: string) => ({
  path: file, transcriptId: id, harness: 'claude-code', cwd: '/tmp/x',
});

beforeAll(async () => {
  await admin.query(`DELETE FROM projects WHERE slug = 'sweep-test'`);
  fs.mkdirSync(scopeRepo, { recursive: true });
  await admin.query(
    `INSERT INTO projects (slug, name, path) VALUES ('sweep-test', 'Sweep Test', $1)`,
    [scopeRepo]
  );
});
afterAll(async () => {
  await admin.query(`DELETE FROM projects WHERE slug = 'sweep-test'`); // cascades sessions/watermarks
  await admin.end();
  const { getPool } = await import('../db.js');
  await getPool().end();
  fs.rmSync(tmp, { recursive: true, force: true });
});
beforeEach(async () => {
  await admin.query(
    `DELETE FROM code_sessions WHERE project_id = (SELECT id FROM projects WHERE slug='sweep-test')`
  );
  await admin.query(
    `DELETE FROM transcript_watermarks WHERE project_id = (SELECT id FROM projects WHERE slug='sweep-test')`
  );
});

const sessionCount = () =>
  admin
    .query(
      `SELECT count(*)::int AS n FROM code_sessions
        WHERE project_id = (SELECT id FROM projects WHERE slug='sweep-test')`
    )
    .then((r) => Number(r.rows[0].n));

async function transcriptState(file: string) {
  const sessions = await admin.query<{ original_session_id: string }>(
    `SELECT original_session_id FROM code_sessions
      WHERE project_id = (SELECT id FROM projects WHERE slug='sweep-test')
        AND metadata->>'transcript_path' = $1
      ORDER BY original_session_id`,
    [file]
  );
  const watermarks = await admin.query<{ n: number }>(
    `SELECT count(*)::int AS n FROM transcript_watermarks
      WHERE project_id = (SELECT id FROM projects WHERE slug='sweep-test')
        AND transcript_path = $1`,
    [file]
  );
  return {
    ids: sessions.rows.map((row) => row.original_session_id),
    watermarks: Number(watermarks.rows[0].n),
  };
}

function claudeIdentityFixture(name: string) {
  const projectsRoot = fs.mkdtempSync(path.join(tmp, `${name}-projects-`));
  const projectDir = path.join(projectsRoot, 'one-project');
  fs.mkdirSync(projectDir, { recursive: true });
  const file = path.join(projectDir, `${name}.jsonl`);
  const entry = (day: number) => JSON.stringify({
    type: 'assistant',
    sessionId: 'payload-id-that-differs',
    cwd: scopeRepo,
    timestamp: `2026-08-${String(day).padStart(2, '0')}T00:00:00Z`,
    message: { content: [{ type: 'thinking', thinking: `identity ${day}` }] },
  }) + '\n';
  return { projectsRoot, file, entry };
}

function discoveryFixture() {
  const root = fs.mkdtempSync(path.join(tmp, 'discovery-'));
  const claudeProjects = path.join(root, 'claude-projects');
  const claudeDir = path.join(claudeProjects, 'one-project');
  const codexSessions = path.join(root, 'codex-sessions', '2026', '08', '14');
  fs.mkdirSync(claudeDir, { recursive: true });
  fs.mkdirSync(codexSessions, { recursive: true });
  const foreignRepo = path.join(tmp, 'foreign-repo');
  const claude = {
    recent: path.join(claudeDir, 'claude-recent.jsonl'),
    old: path.join(claudeDir, 'claude-old.jsonl'),
    foreign: path.join(claudeDir, 'claude-foreign.jsonl'),
  };
  fs.writeFileSync(claude.recent, JSON.stringify({ cwd: path.join(scopeRepo, 'src') }) + '\n');
  fs.writeFileSync(claude.old, JSON.stringify({ cwd: scopeRepo }) + '\n');
  fs.writeFileSync(claude.foreign, JSON.stringify({ cwd: foreignRepo }) + '\n');
  const codex = {
    recent: path.join(codexSessions, 'rollout-recent.jsonl'),
    old: path.join(codexSessions, 'rollout-old.jsonl'),
    foreign: path.join(codexSessions, 'rollout-foreign.jsonl'),
  };
  const meta = (id: string, cwd: string) => JSON.stringify({
    timestamp: '2026-08-14T00:00:00.000Z',
    type: 'session_meta',
    payload: { type: 'session_meta', id, cwd, originator: 'Codex CLI', cli_version: 'test' },
  }) + '\n';
  fs.writeFileSync(codex.recent, meta('11111111-1111-1111-1111-111111111111', scopeRepo));
  fs.writeFileSync(codex.old, meta('22222222-2222-2222-2222-222222222222', scopeRepo));
  fs.writeFileSync(codex.foreign, meta('33333333-3333-3333-3333-333333333333', foreignRepo));
  const old = new Date(Date.now() - 8 * 86_400_000);
  fs.utimesSync(claude.old, old, old);
  fs.utimesSync(codex.old, old, old);
  return { claudeProjects, codexSessions, claude, codex };
}

describe('runSweep', () => {
  it('sniffs the first non-empty string cwd without trusting the parsed JSON shape', async () => {
    const { sniffClaudeCwd } = await import('../scripts/discover-transcripts.js');
    const f = path.join(tmp, 'sniff.jsonl');
    fs.writeFileSync(f, [
      'null',
      '[]',
      '{"cwd":42}',
      '{"cwd":""}',
      '{not json}',
      '{"cwd":"/tmp/right"}',
      '{"cwd":"/tmp/wrong"}',
    ].join('\n') + '\n');
    expect(await sniffClaudeCwd(f)).toBe('/tmp/right');
  });

  it('Claude discovery returns only the recent transcript inside the registered project', async () => {
    const { discoverClaude } = await import('../scripts/discover-transcripts.js');
    const fx = discoveryFixture();
    const cutoff = Date.now() - 7 * 86_400_000;
    const refs = await discoverClaude([scopeRepo], cutoff, fx.claudeProjects);
    expect(refs.map((r) => path.basename(r.path))).toEqual(['claude-recent.jsonl']);
    expect(refs[0]).toMatchObject({
      harness: 'claude-code', transcriptId: 'claude-recent', cwd: path.join(scopeRepo, 'src'),
    });
  });

  it('Codex discovery returns only the recent rollout inside the registered project', async () => {
    const { discoverCodex } = await import('../scripts/discover-transcripts.js');
    const fx = discoveryFixture();
    const cutoff = Date.now() - 7 * 86_400_000;
    const refs = await discoverCodex([scopeRepo], cutoff, fx.codexSessions);
    expect(refs.map((r) => path.basename(r.path))).toEqual(['rollout-recent.jsonl']);
    expect(refs[0]).toMatchObject({
      harness: 'codex', transcriptId: '11111111-1111-1111-1111-111111111111', cwd: scopeRepo,
    });
  });

  it('the default sweep branch unions both scoped discoveries with the seven-day cutoff', async () => {
    const { runSweep } = await import('../scripts/sweep-orphans.js');
    const fx = discoveryFixture();
    const r = await runSweep({
      discoveryRoots: { claudeProjects: fx.claudeProjects, codexSessions: fx.codexSessions },
      minQuietMs: 0,
      ingest: async () => { throw new Error('discovery-only discriminator'); },
    });
    expect(r.scanned).toBe(2);
    expect(r.orphans).toBe(2);
    expect(r.attempted).toBe(2);
    expect(r.failed).toHaveLength(2);
    expect(r.failed.join('\n')).toContain('claude-recent.jsonl');
    expect(r.failed.join('\n')).toContain('rollout-recent.jsonl');
  });

  it('recovers a never-ingested transcript (the crash case) through the segmented path', async () => {
    const { runSweep } = await import('../scripts/sweep-orphans.js');
    const f = path.join(tmp, 'crash.jsonl');
    fs.writeFileSync(f, [L(1), L(3)].join('\n') + '\n'); // 48h gap → 2 segments
    const r = await runSweep({ refs: [ref(f, 'sweep-crash')], minQuietMs: 0 });
    expect(r.orphans).toBe(1);
    expect(r.recovered).toEqual(['crash.jsonl']);
    expect(await sessionCount()).toBe(2); // segmented, indistinguishable from hook ingest
    const wm = await admin.query(
      `SELECT count(*)::int AS n FROM transcript_watermarks
        WHERE project_id = (SELECT id FROM projects WHERE slug='sweep-test')`
    );
    expect(wm.rows[0].n).toBe(1);
  });

  it('a segmented, already-ingested transcript is NOT an orphan (spec §5 cardinality regression)', async () => {
    const { runSweep } = await import('../scripts/sweep-orphans.js');
    const { ingestTranscriptSegmented } = await import('../capture/segment-ingest.js');
    const { ClaudeCodeAdapter } = await import('../capture/claude-code.js');
    const f = path.join(tmp, 'seg.jsonl');
    fs.writeFileSync(f, [L(1), L(3), L(5)].join('\n') + '\n'); // 3 segments, many rows, ONE path
    await ingestTranscriptSegmented(new ClaudeCodeAdapter(), ref(f, 'sweep-seg'));
    expect(await sessionCount()).toBe(3);
    const r = await runSweep({ refs: [ref(f, 'sweep-seg')], minQuietMs: 0 });
    expect(r.orphans).toBe(0);
    expect(r.recovered).toEqual([]);
    expect(await sessionCount()).toBe(3); // nothing re-ingested
  });

  it('hook then sweep keeps one filename-derived Claude session family and watermark', async () => {
    const { discoverClaude } = await import('../scripts/discover-transcripts.js');
    const { runIngestSession } = await import('../scripts/ingest-session.js');
    const { runSweep } = await import('../scripts/sweep-orphans.js');
    const fx = claudeIdentityFixture('identity-hook-first');
    fs.writeFileSync(fx.file, fx.entry(1));

    await runIngestSession({
      argv: ['node', 'ingest-session'],
      readInput: async () => JSON.stringify({
        session_id: 'payload-id-that-differs', transcript_path: fx.file, cwd: scopeRepo,
      }),
    });
    fs.appendFileSync(fx.file, fx.entry(3));
    fs.utimesSync(fx.file, new Date(), new Date(Date.now() + 5000));
    const refs = await discoverClaude([scopeRepo], 0, fx.projectsRoot);
    expect(refs).toHaveLength(1);
    await runSweep({ refs, minQuietMs: 0 });

    const state = await transcriptState(fx.file);
    expect(state.ids).toEqual(['identity-hook-first#0', 'identity-hook-first#1']);
    expect(state.watermarks).toBe(1);
  });

  it('sweep then hook keeps one filename-derived Claude session family and watermark', async () => {
    const { discoverClaude } = await import('../scripts/discover-transcripts.js');
    const { runIngestSession } = await import('../scripts/ingest-session.js');
    const { runSweep } = await import('../scripts/sweep-orphans.js');
    const fx = claudeIdentityFixture('identity-sweep-first');
    fs.writeFileSync(fx.file, fx.entry(1));

    const refs = await discoverClaude([scopeRepo], 0, fx.projectsRoot);
    expect(refs).toHaveLength(1);
    await runSweep({ refs, minQuietMs: 0 });
    fs.appendFileSync(fx.file, fx.entry(3));
    fs.utimesSync(fx.file, new Date(), new Date(Date.now() + 5000));
    await runIngestSession({
      argv: ['node', 'ingest-session'],
      readInput: async () => JSON.stringify({
        session_id: 'payload-id-that-differs', transcript_path: fx.file, cwd: scopeRepo,
      }),
    });

    const state = await transcriptState(fx.file);
    expect(state.ids).toEqual(['identity-sweep-first#0', 'identity-sweep-first#1']);
    expect(state.watermarks).toBe(1);
  });

  it('appended-after-ingest content makes it an orphan again; sweep ingests incrementally', async () => {
    const { runSweep } = await import('../scripts/sweep-orphans.js');
    const { ingestTranscriptSegmented } = await import('../capture/segment-ingest.js');
    const { ClaudeCodeAdapter } = await import('../capture/claude-code.js');
    const f = path.join(tmp, 'append.jsonl');
    fs.writeFileSync(f, L(1) + '\n');
    await ingestTranscriptSegmented(new ClaudeCodeAdapter(), ref(f, 'sweep-app'));
    fs.appendFileSync(f, L(3) + '\n');
    fs.utimesSync(f, new Date(), new Date(Date.now() + 5000)); // mtime past watermark
    const r = await runSweep({ refs: [ref(f, 'sweep-app')], minQuietMs: 0 });
    expect(r.orphans).toBe(1);
    expect(r.recovered).toEqual(['append.jsonl']);
  });

  it('empty files are skipped, never errored', async () => {
    const { runSweep } = await import('../scripts/sweep-orphans.js');
    const f = path.join(tmp, 'empty.jsonl');
    fs.writeFileSync(f, '');
    const r = await runSweep({ refs: [ref(f, 'sweep-empty')], minQuietMs: 0 });
    expect(r).toMatchObject({ skippedEmpty: 1, orphans: 0, failed: [] });
  });

  it('caps at SWEEP_MAX_INGESTS and reports the rest as backlog', async () => {
    const { runSweep, SWEEP_MAX_INGESTS } = await import('../scripts/sweep-orphans.js');
    const refs = [];
    for (let i = 0; i < SWEEP_MAX_INGESTS + 2; i++) {
      const f = path.join(tmp, `cap-${i}.jsonl`);
      fs.writeFileSync(f, L(1) + '\n');
      refs.push(ref(f, `sweep-cap-${i}`));
    }
    const r = await runSweep({ refs, minQuietMs: 0 });
    expect(r.recovered.length).toBe(SWEEP_MAX_INGESTS); // no assertion hardcodes 5
    expect(r.attempted).toBe(SWEEP_MAX_INGESTS);
    expect(r.backlog).toBe(2);
  });

  it('failed ingests consume the attempt cap and leave the rest as backlog', async () => {
    const { runSweep, SWEEP_MAX_INGESTS } = await import('../scripts/sweep-orphans.js');
    const refs = [];
    for (let i = 0; i < SWEEP_MAX_INGESTS + 2; i++) {
      const f = path.join(tmp, `fail-cap-${i}.jsonl`);
      fs.writeFileSync(f, L(1) + '\n');
      refs.push(ref(f, `sweep-fail-${i}`));
    }
    const r = await runSweep({
      refs,
      minQuietMs: 0,
      ingest: async () => { throw new Error('injected ingest failure'); },
    });
    expect(r.attempted).toBe(SWEEP_MAX_INGESTS);
    expect(r.failed).toHaveLength(SWEEP_MAX_INGESTS);
    expect(r.backlog).toBe(2);
  });

  it('a vanished file is silently skipped (raced deletion)', async () => {
    const { runSweep } = await import('../scripts/sweep-orphans.js');
    const r = await runSweep({ refs: [ref(path.join(tmp, 'gone.jsonl'), 'sweep-gone')], minQuietMs: 0 });
    expect(r).toMatchObject({ scanned: 1, orphans: 0, failed: [] });
  });

  it('entry posts a top-level failure, posts no routine empty run, and stays hook-safe', async () => {
    const { runSweepEntry } = await import('../scripts/sweep-orphans.js');
    const posts: string[] = [];
    await runSweepEntry({
      run: async () => { throw new Error('discovery down'); },
      post: async (body) => { posts.push(body); },
    });
    expect(posts).toEqual([expect.stringContaining('FAILED')]);
    posts.length = 0;
    await runSweepEntry({
      run: async () => ({
        scanned: 0, orphans: 0, attempted: 0, recovered: [], failed: [],
        backlog: 0, skippedEmpty: 0, skippedLocked: 0, skippedLive: 0, lockErrors: [],
      }),
      post: async (body) => { posts.push(body); },
    });
    expect(posts).toEqual([]);
  });
  // AMENDMENT A13 (plan 27, finding 4560dc13, operator-approved 2026-08-15).
  // PROVEN BY MUTATION before these two cases existed: deleting the entire
  // lock/recheck/unlock block left all 12 original cases green. The suite
  // proved the sweep ingests and counts, and nothing about the one property
  // the sweep was designed for. This is a recurrence of bf2b6962 (plan 21 W1,
  // "no mutation check covers the advisory lock") — that repair closed the
  // instance, not the class. Both cases below fail if the lock block goes.
  it('a transcript already locked by another sweep is skipped, not double-ingested', async () => {
    const { runSweep } = await import('../scripts/sweep-orphans.js');
    const f = path.join(tmp, 'contended.jsonl');
    fs.writeFileSync(f, L(1) + '\n');
    const proj = await admin.query<{ id: string }>(
      `SELECT id FROM projects WHERE slug = 'sweep-test'`
    );
    const lockKey = `${proj.rows[0].id}:${f}`;
    // A SECOND connection holds the exact key the sweep will try — this is the
    // two-sessions-ending-together race, made deterministic.
    const rival = await admin.connect();
    try {
      const held = await rival.query<{ locked: boolean }>(
        `SELECT pg_try_advisory_lock(hashtextextended($1, 0)) AS locked`,
        [lockKey]
      );
      expect(held.rows[0].locked).toBe(true); // the rival really holds it
      const r = await runSweep({ refs: [ref(f, 'sweep-contended')], minQuietMs: 0 });
      expect(r).toMatchObject({ orphans: 1, skippedLocked: 1, attempted: 0, recovered: [], failed: [] });
      expect(await sessionCount()).toBe(0); // the whole point: no double ingest
    } finally {
      await rival.query(`SELECT pg_advisory_unlock(hashtextextended($1, 0))`, [lockKey]);
      rival.release();
    }
  });

  it('the post-lock recheck makes the race loser a no-op instead of a second ingest', async () => {
    const { runSweep } = await import('../scripts/sweep-orphans.js');
    const f = path.join(tmp, 'recheck.jsonl');
    fs.writeFileSync(f, L(1) + '\n');
    // Stand in for the race winner: the watermark lands AFTER this sweep has
    // counted the orphan, exactly where the recheck runs. `ingest` must never
    // fire — if the recheck is removed, it does, and this fails.
    let ingestCalls = 0;
    const r = await runSweep({
      refs: [ref(f, 'sweep-recheck')],
      minQuietMs: 0,
      ingest: async () => { ingestCalls++; throw new Error('recheck should have prevented this'); },
      beforeLock: async () => {
        const st = fs.statSync(f);
        await admin.query(
          `INSERT INTO transcript_watermarks
             (project_id, transcript_path, harness, open_seq, open_start_offset,
              ingested_mtime_ms, file_size_bytes)
           SELECT id, $1, 'claude-code', 1, 0, $2, $3 FROM projects WHERE slug = 'sweep-test'`,
          [f, String(Math.ceil(st.mtimeMs) + 1000), String(st.size)]
        );
      },
    });
    expect(ingestCalls).toBe(0);
    expect(r).toMatchObject({ orphans: 1, attempted: 0, recovered: [], failed: [] });
    expect(await sessionCount()).toBe(0);
  });

  // AMENDMENT A17 (finding 3660501b): the DEFAULT quiescence floor. Every case
  // above passes minQuietMs: 0 to sweep its just-written fixture; this one uses
  // the production default and must hold a live transcript back.
  it('a transcript written seconds ago is held back as live, not swept', async () => {
    const { runSweep, SWEEP_MIN_QUIET_MS } = await import('../scripts/sweep-orphans.js');
    expect(SWEEP_MIN_QUIET_MS).toBeGreaterThan(0);
    const f = path.join(tmp, 'live.jsonl');
    fs.writeFileSync(f, L(1) + '\n'); // mtime = now
    const r = await runSweep({ refs: [ref(f, 'sweep-live')] }); // production floor
    expect(r).toMatchObject({ scanned: 1, skippedLive: 1, orphans: 0, attempted: 0, recovered: [] });
    expect(await sessionCount()).toBe(0);
  });
  // AMENDMENT A15 (finding 6c32d934): the board note must SUPERSEDE its
  // predecessor. This exercises the REAL defaultSweepPost — every other entry
  // case injects `post`, which is exactly why the repost bug was invisible.
  it('successive sweep notes supersede, leaving exactly one open note on the board', async () => {
    const { runSweepEntry } = await import('../scripts/sweep-orphans.js');
    const failing = async () => ({
      scanned: 1, orphans: 1, attempted: 1, recovered: [], failed: ['stuck.jsonl: nope'],
      backlog: 0, skippedEmpty: 0, skippedLocked: 0, skippedLive: 0, lockErrors: [],
    });
    const openNotes = async () => {
      const r = await admin.query<{ n: number }>(
        `SELECT count(*)::int AS n FROM agent_messages
          WHERE project_id = (SELECT id FROM projects WHERE slug='sweep-test')
            AND status = 'open' AND body LIKE 'Orphan sweep%'`
      );
      return Number(r.rows[0].n);
    };
    await admin.query(
      `DELETE FROM agent_messages WHERE project_id = (SELECT id FROM projects WHERE slug='sweep-test')`
    );
    await runSweepEntry({ run: failing });
    expect(await openNotes()).toBe(1);
    // A persisting condition across THREE session ends must not accumulate.
    // In production each run is a fresh process with a fresh INSTANCE_SESSION,
    // so the board's md5 idempotency cannot help; nothing may pile up here.
    await runSweepEntry({ run: failing });
    await runSweepEntry({ run: failing });
    expect(await openNotes()).toBe(1);
    // ...and when the condition CHANGES, the new note replaces the old one
    // rather than joining it.
    const worse = async () => ({ ...(await failing()), failed: ['stuck.jsonl: nope', 'other.jsonl: nope'] });
    await runSweepEntry({ run: worse });
    expect(await openNotes()).toBe(1);
    const bodies = await admin.query<{ body: string }>(
      `SELECT body FROM agent_messages
        WHERE project_id = (SELECT id FROM projects WHERE slug='sweep-test')
          AND status = 'open' AND body LIKE 'Orphan sweep%'`
    );
    expect(bodies.rows[0].body).toContain('other.jsonl'); // the survivor is the CURRENT one
    const total = await admin.query<{ n: number }>(
      `SELECT count(*)::int AS n FROM agent_messages
        WHERE project_id = (SELECT id FROM projects WHERE slug='sweep-test')
          AND body LIKE 'Orphan sweep%'`
    );
    expect(Number(total.rows[0].n)).toBe(2); // two distinct states, never four notes
  });
});
