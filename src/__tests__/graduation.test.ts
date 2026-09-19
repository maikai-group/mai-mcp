/** Graduation end-to-end (plan 27 Part B): the relearn signal, computed
 * candidacy, promote/reject verdicts, the rendered projection, counts and
 * prime. curation.test.ts harness pattern: throwaway project, 54334 default
 * with MAI_DB_URL override for disposable DBs, MAI_LLM_SUMMARY='0' set (never
 * deleted — lesson 57ac4b5a). No assertion hardcodes 5 — the threshold is
 * imported (spec §3.1). */
import { beforeAll, afterAll, beforeEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Pool } from 'pg';
import { requireDisposableTestDbUrl } from './test-db-url.js';

process.env.MAI_PROJECT_SLUG = 'plan27-grad-test';
process.env.MAI_DB_URL = requireDisposableTestDbUrl();
process.env.MAI_LLM_SUMMARY = '0';
process.env.MAI_AGENT_ID = 'tester@vitest';

const admin = new Pool({ connectionString: process.env.MAI_DB_URL });
let projectId = '';
let repoDir = '';

const BRAIN = '## MEMORY BRAIN (mai-mcp)\n\nbody\n\n<!-- /mai-brain-block v3 -->\n';

async function seedLesson(opts: {
  rule: string;
  relearned: number;
  global?: boolean;
  retired?: boolean;
}): Promise<string> {
  const r = await admin.query<{ id: string }>(
    `INSERT INTO lessons (project_id, rule, confidence_score, relearned_count, retired_at, retirement_reason)
     VALUES ($1, $2, 0.5, $3, $4, $5) RETURNING id`,
    [
      opts.global ? null : projectId, opts.rule, opts.relearned,
      opts.retired ? new Date() : null, opts.retired ? 'test' : null,
    ]
  );
  return r.rows[0].id;
}

beforeAll(async () => {
  await admin.query(`DELETE FROM projects WHERE slug = 'plan27-grad-test'`);
  repoDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mai-grad-repo-'));
  const ins = await admin.query<{ id: string }>(
    `INSERT INTO projects (slug, name, path, metadata)
     VALUES ('plan27-grad-test', 'Grad Test', $1, jsonb_build_object('repos', jsonb_build_array($1::text)))
     RETURNING id`,
    [repoDir]
  );
  projectId = ins.rows[0].id;
});
afterAll(async () => {
  // AMENDMENT A18 (plan 27, finding fce650a5 — the same W1 shape A1 fixed in
  // rules-render.test.ts). repoDir is minted by mkdtempSync in beforeAll and
  // the plan's teardown never removed it, so every focused/full/assembled-
  // public repetition left an OS scratch directory behind — one that by this
  // point holds a written CLAUDE.md and several note fixtures.
  //
  // The finally is load-bearing, not decoration: the finding explicitly asks
  // for a structure that still cleans up if DB teardown fails, and every
  // statement below it can throw (a dropped disposable DB, an already-ended
  // pool). Leaving rmSync as the last statement would have satisfied the
  // finding's letter and missed its point.
  try {
    // Global test lessons carry project_id NULL and do not cascade — sweep by rule prefix.
    await admin.query(`DELETE FROM lessons WHERE rule LIKE 'p27test:%'`);
    await admin.query(`DELETE FROM projects WHERE slug = 'plan27-grad-test'`);
    await admin.end();
    const { getPool } = await import('../db.js');
    await getPool().end();
  } finally {
    fs.rmSync(repoDir, { recursive: true, force: true });
  }
});
beforeEach(async () => {
  await admin.query(`DELETE FROM curation_candidates WHERE project_id = $1`, [projectId]);
  await admin.query(`DELETE FROM lessons WHERE rule LIKE 'p27test:%'`);
  const { renderGraduatedRulesBlock } = await import('../rules-render.js');
  fs.writeFileSync(path.join(repoDir, 'CLAUDE.md'), BRAIN + '\n' + renderGraduatedRulesBlock([]));
});

describe('the relearn signal (R3)', () => {
  it('reinforceLesson default bumps reinforcement only; {relearned:true} bumps both', async () => {
    const { reinforceLesson } = await import('../lessons.js');
    const { getPool } = await import('../db.js');
    const id = await seedLesson({ rule: 'p27test: signal', relearned: 0 });
    const a = await reinforceLesson(getPool(), id);
    expect(a).toMatchObject({ reinforcementCount: 1, relearnedCount: 0 });
    const b = await reinforceLesson(getPool(), id, { relearned: true });
    expect(b).toMatchObject({ reinforcementCount: 2, relearnedCount: 1 });
  });

  it('the citation path (recordCitation → bumpCited) never moves relearned_count', async () => {
    const { recordCitation } = await import('../curation.js');
    const id = await seedLesson({ rule: 'p27test: cited', relearned: 3 });
    const client = await admin.connect();
    try {
      await client.query('BEGIN');
      await recordCitation(client, projectId, {
        citingKind: 'lesson', citingId: id, citedKind: 'lesson', citedId: id,
        relation: 'extends', reason: 'test citation', sessionTokenId: null,
        source: 'agent-inferred',
      });
      await client.query('COMMIT');
    } finally {
      client.release();
    }
    const after = await admin.query(`SELECT relearned_count, cited_count FROM lessons WHERE id = $1`, [id]);
    expect(Number(after.rows[0].relearned_count)).toBe(3); // unchanged
    expect(Number(after.rows[0].cited_count)).toBe(1);
  });
});

describe('candidacy (R4)', () => {
  it('at threshold → candidate; below, global, retired → not', async () => {
    const { graduationCandidates, GRADUATION_REINFORCEMENTS } = await import('../curation.js');
    const hit = await seedLesson({ rule: 'p27test: at threshold', relearned: GRADUATION_REINFORCEMENTS });
    await seedLesson({ rule: 'p27test: below', relearned: GRADUATION_REINFORCEMENTS - 1 });
    await seedLesson({ rule: 'p27test: global', relearned: GRADUATION_REINFORCEMENTS, global: true });
    await seedLesson({ rule: 'p27test: retired', relearned: GRADUATION_REINFORCEMENTS, retired: true });
    const c = await graduationCandidates(projectId);
    expect(c.map((x) => x.targetId)).toEqual([hit]);
    expect(c[0].relearnedCount).toBe(GRADUATION_REINFORCEMENTS);
  });

  it('one-target precedence is proposal → graduation → telemetry in cards and counts', async () => {
    const { curationCards, curationCounts, GRADUATION_REINFORCEMENTS, CURATION_WINDOW_DAYS } =
      await import('../curation.js');
    const id = await seedLesson({ rule: 'p27test: one target one action', relearned: GRADUATION_REINFORCEMENTS });
    await admin.query(
      `UPDATE lessons SET created_at = NOW() - make_interval(days => $2::int + 1),
                          curation_baseline_at = NOW() - make_interval(days => $2::int + 1)
        WHERE id = $1`,
      [id, CURATION_WINDOW_DAYS]
    );
    const sameTarget = (await curationCards(projectId)).filter((c) => c.targetId === id);
    expect(sameTarget).toHaveLength(1);
    expect(sameTarget[0].basis).toBe('graduate');
    expect(sameTarget[0].approveAction).toBe('promote');
    expect(await curationCounts(projectId)).toMatchObject({ candidates: 0, graduations: 1 });
    await admin.query(
      `INSERT INTO curation_candidates
         (project_id, target_kind, target_id, basis, status, proposed_by, evidence)
       VALUES ($1, 'lesson', $2, 'agent-evidence', 'open', 'tester', 'contradicted')`,
      [projectId, id]
    );
    const proposalWins = (await curationCards(projectId)).filter((c) => c.targetId === id);
    expect(proposalWins).toHaveLength(1);
    expect(proposalWins[0].basis).toBe('agent-evidence');
    expect(proposalWins[0].approveAction).toBe('retire');
    expect(await curationCounts(projectId)).toMatchObject({ candidates: 0, proposals: 1, graduations: 0 });
  });

  it('dismissed suppresses for one window, not forever; applied suppresses forever', async () => {
    const { graduationCandidates, curationReject, curationPromote, GRADUATION_REINFORCEMENTS, CURATION_WINDOW_DAYS } =
      await import('../curation.js');
    const id = await seedLesson({ rule: 'p27test: suppression', relearned: GRADUATION_REINFORCEMENTS });
    await curationReject({ lessonId: id, projectId });
    expect((await graduationCandidates(projectId)).length).toBe(0);
    // Age the dismissal past the window → candidate again.
    await admin.query(
      `UPDATE curation_candidates
          SET resolved_at = NOW() - make_interval(days => $2::int + 1)
        WHERE project_id = $1 AND basis = 'graduate'`,
      [projectId, CURATION_WINDOW_DAYS]
    );
    expect((await graduationCandidates(projectId)).length).toBe(1);
    // Applied → gone for good, even with an aged verdict.
    await curationPromote({ lessonId: id, projectId });
    await admin.query(
      `UPDATE curation_candidates
          SET resolved_at = NOW() - make_interval(days => $2::int + 1)
        WHERE project_id = $1 AND basis = 'graduate' AND status = 'applied'`,
      [projectId, CURATION_WINDOW_DAYS]
    );
    expect((await graduationCandidates(projectId)).length).toBe(0);
  });
});

describe('verdicts + the rendered projection (R6, R7, R8)', () => {
  it('promote writes ONE applied row, renders the rule; double promote is a no-op', async () => {
    const { curationPromote, GRADUATION_REINFORCEMENTS } = await import('../curation.js');
    const id = await seedLesson({ rule: 'p27test: promoted rule', relearned: GRADUATION_REINFORCEMENTS + 1 });
    const msg = await curationPromote({ lessonId: id, projectId });
    expect(msg).toContain('Promoted lesson');
    expect(msg).toContain('updated');
    const file = fs.readFileSync(path.join(repoDir, 'CLAUDE.md'), 'utf8');
    expect(file).toContain('p27test: promoted rule');
    expect(file).toContain(`relearned ×${GRADUATION_REINFORCEMENTS + 1}`);
    const again = await curationPromote({ lessonId: id, projectId });
    expect(again).toContain('already a promoted rule');
    const rows = await admin.query(
      `SELECT count(*)::int AS n FROM curation_candidates
        WHERE project_id = $1 AND basis = 'graduate' AND status = 'applied'`,
      [projectId]
    );
    expect(rows.rows[0].n).toBe(1);
  });

  it('promote below threshold / unknown / global lesson → message, no row, no write', async () => {
    const { curationPromote, GRADUATION_REINFORCEMENTS } = await import('../curation.js');
    const low = await seedLesson({ rule: 'p27test: low', relearned: GRADUATION_REINFORCEMENTS - 1 });
    const glob = await seedLesson({ rule: 'p27test: glob', relearned: GRADUATION_REINFORCEMENTS, global: true });
    expect(await curationPromote({ lessonId: low, projectId })).toContain('below the graduation threshold');
    expect(await curationPromote({ lessonId: glob, projectId })).toContain('No live project-local lesson');
    const rows = await admin.query(
      `SELECT count(*)::int AS n FROM curation_candidates WHERE project_id = $1 AND basis = 'graduate'`,
      [projectId]
    );
    expect(rows.rows[0].n).toBe(0);
  });

  it('promote commits but reports render deferral for a non-absence read failure', async () => {
    const { curationPromote, GRADUATION_REINFORCEMENTS } = await import('../curation.js');
    const id = await seedLesson({
      rule: 'p27test: unreadable projection target',
      relearned: GRADUATION_REINFORCEMENTS,
    });
    const file = path.join(repoDir, 'CLAUDE.md');
    fs.chmodSync(file, 0o000);
    let message = '';
    try {
      message = await curationPromote({ lessonId: id, projectId });
    } finally {
      fs.chmodSync(file, 0o600);
    }
    expect(message).toContain('Render deferred');
    const verdict = await admin.query<{ status: string }>(
      `SELECT status FROM curation_candidates
        WHERE project_id = $1 AND target_id = $2 AND basis = 'graduate'`,
      [projectId, id]
    );
    expect(verdict.rows[0].status).toBe('applied');
  });

  it('re-render is byte-stable (drift gate): a second render changes nothing', async () => {
    const { curationPromote, GRADUATION_REINFORCEMENTS } = await import('../curation.js');
    const { writeGraduatedRulesBlocks } = await import('../rules-render.js');
    const id = await seedLesson({ rule: 'p27test: stable', relearned: GRADUATION_REINFORCEMENTS });
    await curationPromote({ lessonId: id, projectId });
    const once = fs.readFileSync(path.join(repoDir, 'CLAUDE.md'), 'utf8');
    expect(await writeGraduatedRulesBlocks(projectId)).toEqual([]); // nothing to write
    expect(fs.readFileSync(path.join(repoDir, 'CLAUDE.md'), 'utf8')).toBe(once);
  });

  it('serializes an older paused render behind the current DB projection', async () => {
    const { curationPromote, GRADUATION_REINFORCEMENTS } = await import('../curation.js');
    const { writeGraduatedRulesBlocks } = await import('../rules-render.js');
    const olderId = await seedLesson({
      rule: 'p27test: older projection rule',
      relearned: GRADUATION_REINFORCEMENTS,
    });
    const newerId = await seedLesson({
      rule: 'p27test: newer projection rule',
      relearned: GRADUATION_REINFORCEMENTS,
    });
    await curationPromote({ lessonId: olderId, projectId });

    let announceSnapshot: (() => void) | undefined;
    let releaseOlder: (() => void) | undefined;
    const snapshotReady = new Promise<void>((resolve) => { announceSnapshot = resolve; });
    const holdOlder = new Promise<void>((resolve) => { releaseOlder = resolve; });
    const older = writeGraduatedRulesBlocks(projectId, {
      afterSnapshot: async () => {
        announceSnapshot?.();
        await holdOlder;
      },
    });
    await snapshotReady;
    await admin.query(
      `INSERT INTO curation_candidates
         (project_id,target_kind,target_id,basis,status,resolved_at)
       VALUES ($1,'lesson',$2,'graduate','applied',NOW())`,
      [projectId, newerId]
    );
    const newer = writeGraduatedRulesBlocks(projectId);

    let observedLockWait = false;
    try {
      for (let i = 0; i < 100 && !observedLockWait; i++) {
        const waiting = await admin.query<{ n: number }>(
          `SELECT count(*)::int AS n FROM pg_stat_activity
            WHERE datname = current_database() AND wait_event_type = 'Lock'
              AND query LIKE '%pg_advisory_xact_lock(hashtextextended%'`
        );
        observedLockWait = waiting.rows[0].n > 0;
        if (!observedLockWait) await new Promise<void>((resolve) => setTimeout(resolve, 10));
      }
      expect(observedLockWait).toBe(true); // unlocked writer would already have written B
    } finally {
      releaseOlder?.();
    }
    await Promise.all([older, newer]);
    const final = fs.readFileSync(path.join(repoDir, 'CLAUDE.md'), 'utf8');
    expect(final).toContain('p27test: older projection rule');
    expect(final).toContain('p27test: newer projection rule');
  });

  it('retiring a graduated lesson drops its rule at the verdict (R8 post-commit hook)', async () => {
    const { curationPromote, curationRetire, GRADUATION_REINFORCEMENTS } = await import('../curation.js');
    const id = await seedLesson({ rule: 'p27test: doomed rule', relearned: GRADUATION_REINFORCEMENTS });
    await curationPromote({ lessonId: id, projectId });
    expect(fs.readFileSync(path.join(repoDir, 'CLAUDE.md'), 'utf8')).toContain('p27test: doomed rule');
    await curationRetire({ targetKind: 'lesson', targetId: id, reason: 'test retire', projectId });
    const after = fs.readFileSync(path.join(repoDir, 'CLAUDE.md'), 'utf8');
    expect(after).not.toContain('p27test: doomed rule');
    expect(after).toContain('No graduated rules yet');
  });

  it('releases verdict clients before a pool-sized concurrent render batch', async () => {
    const { curationPromote, curationRetire, GRADUATION_REINFORCEMENTS } =
      await import('../curation.js');
    const { getPool } = await import('../db.js');
    const batchSize = getPool().options.max;
    expect(batchSize).toBeGreaterThan(1);
    const ids: string[] = [];
    for (let i = 0; i < batchSize; i++) {
      const id = await seedLesson({
        rule: `p27test: saturated graduated rule ${i}`,
        relearned: GRADUATION_REINFORCEMENTS,
      });
      ids.push(id);
      await curationPromote({ lessonId: id, projectId });
    }
    const rowBlocker = await admin.connect();
    const renderBlocker = await admin.connect();
    const renderLockKey = `mai:graduated-rules:${projectId}`;
    await renderBlocker.query(
      `SELECT pg_advisory_lock(hashtextextended($1, 0))`,
      [renderLockKey]
    );
    await rowBlocker.query('BEGIN');
    await rowBlocker.query(
      `SELECT id FROM lessons WHERE id = ANY($1::uuid[]) ORDER BY id FOR UPDATE`,
      [ids]
    );
    const pending = Promise.all(ids.map((id) => curationRetire({
      targetKind: 'lesson', targetId: id, reason: 'batch retire', projectId,
    })));
    try {
      let verdictWaits = 0;
      for (let i = 0; i < 300 && verdictWaits < batchSize; i++) {
        const waiting = await admin.query<{ n: number }>(
          `SELECT count(*)::int AS n FROM pg_stat_activity
            WHERE datname = current_database() AND wait_event_type = 'Lock'
              AND query LIKE '%SELECT id FROM lessons%FOR UPDATE%'`
        );
        verdictWaits = waiting.rows[0].n;
        if (verdictWaits < batchSize) {
          await new Promise<void>((resolve) => setTimeout(resolve, 10));
        }
      }
      expect(verdictWaits).toBe(batchSize); // every product-pool client is held
      await rowBlocker.query('COMMIT');

      // Every repaired verdict now commits + releases before its renderer tries
      // to acquire a product client. All renderers therefore reach the shared
      // advisory lock. With the old placement, all verdict clients remain
      // checked out and this count stays zero until connection timeouts begin.
      let renderWaits = 0;
      for (let i = 0; i < 300 && renderWaits < batchSize; i++) {
        const waiting = await admin.query<{ n: number }>(
          `SELECT count(*)::int AS n FROM pg_stat_activity
            WHERE datname = current_database() AND wait_event_type = 'Lock'
              AND query LIKE '%pg_advisory_xact_lock(hashtextextended%'`
        );
        renderWaits = waiting.rows[0].n;
        if (renderWaits < batchSize) {
          await new Promise<void>((resolve) => setTimeout(resolve, 10));
        }
      }
      expect(renderWaits).toBe(batchSize);
      await renderBlocker.query(
        `SELECT pg_advisory_unlock(hashtextextended($1, 0))`,
        [renderLockKey]
      );
      const messages = await pending;
      expect(messages).toHaveLength(batchSize);
      const final = fs.readFileSync(path.join(repoDir, 'CLAUDE.md'), 'utf8');
      for (let i = 0; i < batchSize; i++) {
        expect(final).not.toContain(`p27test: saturated graduated rule ${i}`);
      }
      expect(final).toContain('No graduated rules yet');
    } finally {
      await rowBlocker.query('ROLLBACK').catch(() => undefined);
      await renderBlocker.query(
        `SELECT pg_advisory_unlock(hashtextextended($1, 0))`,
        [renderLockKey]
      ).catch(() => undefined);
      rowBlocker.release();
      renderBlocker.release();
      await pending.catch(() => undefined);
    }
  }, 15_000);

  it('globalizing a promoted lesson removes its origin-project rule and preserves verdict history', async () => {
    const { curationPromote, GRADUATION_REINFORCEMENTS } = await import('../curation.js');
    const { lessonGlobalize } = await import('../lessons.js');
    const id = await seedLesson({
      rule: 'p27test: project rule becomes global knowledge',
      relearned: GRADUATION_REINFORCEMENTS,
    });
    await curationPromote({ lessonId: id, projectId });
    expect(fs.readFileSync(path.join(repoDir, 'CLAUDE.md'), 'utf8')).toContain(
      'p27test: project rule becomes global knowledge'
    );

    expect(await lessonGlobalize(id, 'test scope transition', projectId)).toContain('Globalized lesson');
    const after = fs.readFileSync(path.join(repoDir, 'CLAUDE.md'), 'utf8');
    expect(after).not.toContain('p27test: project rule becomes global knowledge');
    expect(after).toContain('No graduated rules yet');
    const state = await admin.query(
      `SELECT l.project_id, c.status
         FROM lessons l JOIN curation_candidates c ON c.target_id = l.id
        WHERE l.id = $1 AND c.project_id = $2 AND c.basis = 'graduate'`,
      [id, projectId]
    );
    expect(state.rows[0]).toMatchObject({ project_id: null, status: 'applied' });
  });

  it('reject leaves the lesson live and the block unchanged', async () => {
    const { curationReject, GRADUATION_REINFORCEMENTS } = await import('../curation.js');
    const id = await seedLesson({ rule: 'p27test: not a rule', relearned: GRADUATION_REINFORCEMENTS });
    const before = fs.readFileSync(path.join(repoDir, 'CLAUDE.md'), 'utf8');
    const msg = await curationReject({ lessonId: id, projectId });
    expect(msg).toContain('Not a rule');
    expect(fs.readFileSync(path.join(repoDir, 'CLAUDE.md'), 'utf8')).toBe(before);
    const live = await admin.query(`SELECT retired_at FROM lessons WHERE id = $1`, [id]);
    expect(live.rows[0].retired_at).toBeNull();
  });

  it('reject locks and revalidates after a concurrent scope change, so no stale verdict lands', async () => {
    const { curationReject, GRADUATION_REINFORCEMENTS } = await import('../curation.js');
    const id = await seedLesson({
      rule: 'p27test: reject race',
      relearned: GRADUATION_REINFORCEMENTS,
    });
    const blocker = await admin.connect();
    await blocker.query('BEGIN');
    await blocker.query(`UPDATE lessons SET project_id = NULL WHERE id = $1`, [id]);
    const pending = curationReject({ lessonId: id, projectId });
    try {
      let observedLockWait = false;
      for (let i = 0; i < 100 && !observedLockWait; i++) {
        const waiting = await admin.query<{ n: number }>(
          `SELECT count(*)::int AS n
             FROM pg_stat_activity
            WHERE datname = current_database()
              AND wait_event_type = 'Lock'
              AND query LIKE '%SELECT id FROM lessons%FOR UPDATE%'`
        );
        observedLockWait = waiting.rows[0].n > 0;
        if (!observedLockWait) await new Promise<void>((resolve) => setTimeout(resolve, 10));
      }
      expect(observedLockWait).toBe(true); // old two-statement implementation never waits here
      await blocker.query('COMMIT');
      expect(await pending).toContain('No live project-local lesson');
      const verdicts = await admin.query(
        `SELECT id FROM curation_candidates
          WHERE project_id = $1 AND target_id = $2 AND basis = 'graduate'`,
        [projectId, id]
      );
      expect(verdicts.rows).toHaveLength(0);
    } finally {
      await blocker.query('ROLLBACK').catch(() => undefined);
      blocker.release();
    }
  });

  it('CLI unpromote dismisses the verdict, preserves the lesson, and rerenders', async () => {
    const { execFileSync } = await import('node:child_process');
    const { curationPromote, GRADUATION_REINFORCEMENTS } = await import('../curation.js');
    const id = await seedLesson({ rule: 'p27test: removable rule', relearned: GRADUATION_REINFORCEMENTS });
    await curationPromote({ lessonId: id, projectId });
    const noteFile = path.join(repoDir, 'unpromote-note.txt');
    fs.writeFileSync(noteFile, 'too project-specific\n');
    const runCli = (argv: string[]) =>
      execFileSync(process.execPath, ['build/cli.js', ...argv], {
        encoding: 'utf8', env: { ...process.env, MAI_DB_URL: requireDisposableTestDbUrl() },
      });

    expect(runCli(['curation', '--recount', '--project', 'plan27-grad-test'])).toContain('Recounted');
    expect(runCli(['--help'])).toContain(
      'curation unpromote --lesson ID --note-file PATH  Remove a promoted rule without deleting its lesson'
    );
    expect(() => runCli([
      'curation', 'unpromote', '--recount', '--lesson', id, '--note-file', noteFile,
      '--project', 'plan27-grad-test',
    ])).toThrow(); // the two forms are mutually exclusive
    expect(() => runCli([
      'curation', 'unpromote', '--note-file', noteFile, '--project', 'plan27-grad-test',
    ])).toThrow(); // missing --lesson
    expect(() => runCli([
      'curation', 'unpromote', '--lesson', '--note-file', noteFile,
      '--project', 'plan27-grad-test',
    ])).toThrow(); // bare --lesson
    expect(() => execFileSync(process.execPath, [
      'build/cli.js', 'curation', 'unpromote', '--lesson', id,
      '--project', 'plan27-grad-test',
    ], { encoding: 'utf8', env: { ...process.env, MAI_DB_URL: requireDisposableTestDbUrl() } })).toThrow();
    expect(() => execFileSync(process.execPath, [
      'build/cli.js', 'curation', 'unpromote', '--lesson', id,
      '--project', 'plan27-grad-test', '--note-file',
    ], { encoding: 'utf8', env: { ...process.env, MAI_DB_URL: requireDisposableTestDbUrl() } })).toThrow();
    expect(() => runCli([
      'curation', 'unpromote', '--lesson', id, '--note-file', path.join(repoDir, 'missing-note.txt'),
      '--project', 'plan27-grad-test',
    ])).toThrow();
    const emptyNote = path.join(repoDir, 'empty-note.txt');
    const whitespaceNote = path.join(repoDir, 'whitespace-note.txt');
    fs.writeFileSync(emptyNote, '');
    fs.writeFileSync(whitespaceNote, ' \n\t');
    for (const invalid of [emptyNote, whitespaceNote]) {
      expect(() => runCli([
        'curation', 'unpromote', '--lesson', id, '--note-file', invalid,
        '--project', 'plan27-grad-test',
      ])).toThrow();
    }
    expect(() => runCli([
      'curation', 'unpromote', 'extra', '--lesson', id, '--note-file', noteFile,
      '--project', 'plan27-grad-test',
    ])).toThrow();
    expect(() => runCli([
      'curation', 'unpromote', '--lesson', id, '--note-file', noteFile, '--project',
    ])).toThrow();
    await admin.query(
      `INSERT INTO projects (slug, name, path) VALUES ('plan27-grad-foreign', 'Foreign', $1)
       ON CONFLICT (slug) DO NOTHING`,
      [repoDir]
    );
    const foreign = execFileSync(process.execPath, [
      'build/cli.js', 'curation', 'unpromote', '--lesson', id,
      '--note-file', noteFile, '--project', 'plan27-grad-foreign',
    ], { encoding: 'utf8', env: { ...process.env, MAI_DB_URL: requireDisposableTestDbUrl() } });
    expect(foreign).toContain('no applied graduation verdict');
    expect((await admin.query(
      `SELECT status FROM curation_candidates WHERE project_id=$1 AND target_id=$2 AND basis='graduate'`,
      [projectId, id]
    )).rows[0].status).toBe('applied');
    await admin.query(`DELETE FROM projects WHERE slug='plan27-grad-foreign'`);
    // No --project: this is the env-pinned `pid(args) === undefined` boundary.
    const out = execFileSync(process.execPath, [
      'build/cli.js', 'curation', 'unpromote', '--lesson', id,
      '--note-file', noteFile,
    ], { encoding: 'utf8', env: { ...process.env, MAI_DB_URL: requireDisposableTestDbUrl() } });
    expect(out).toContain('Unpromoted lesson');
    const state = await admin.query(
      `SELECT c.status, l.retired_at, l.relearned_count
         FROM curation_candidates c JOIN lessons l ON l.id = c.target_id
        WHERE c.project_id = $1 AND c.target_id = $2 AND c.basis = 'graduate'
        ORDER BY c.resolved_at DESC LIMIT 1`,
      [projectId, id]
    );
    expect(state.rows[0]).toMatchObject({
      status: 'dismissed', retired_at: null,
      relearned_count: GRADUATION_REINFORCEMENTS,
    });
    expect(fs.readFileSync(path.join(repoDir, 'CLAUDE.md'), 'utf8')).not.toContain('p27test: removable rule');
  });
});

describe('surfaces (R5) and counts', () => {
  it('cards carry server-authoritative promote/reject labels and rank after proposals', async () => {
    const { curationCards, GRADUATION_REINFORCEMENTS } = await import('../curation.js');
    await seedLesson({ rule: 'p27test: card', relearned: GRADUATION_REINFORCEMENTS });
    const cards = await curationCards(projectId);
    const grad = cards.find((c) => c.basis === 'graduate');
    expect(grad).toMatchObject({
      targetKind: 'lesson',
      isGlobal: false,
      relearnedCount: GRADUATION_REINFORCEMENTS,
      approveLabel: 'Promote to project rule',
      approveAction: 'promote',
      denyLabel: 'Not a rule',
      denyAction: 'reject',
    });
  });

  it('curationCounts.graduations + prime line mention graduation', async () => {
    const { curationCounts, primeCurationSection, GRADUATION_REINFORCEMENTS } = await import('../curation.js');
    await seedLesson({ rule: 'p27test: count', relearned: GRADUATION_REINFORCEMENTS });
    const counts = await curationCounts(projectId);
    expect(counts.graduations).toBe(1);
    const line = await primeCurationSection(projectId);
    expect(line).toContain('1 graduation candidate');
  });

  it('markdown renderer and JSON rows label graduate cards distinctly', async () => {
    const { reviewQueue, reviewQueueRows } = await import('../decisions.js');
    const { GRADUATION_REINFORCEMENTS } = await import('../curation.js');
    const id = await seedLesson({ rule: 'p27test: rendered', relearned: GRADUATION_REINFORCEMENTS });
    const md = await reviewQueue(30, projectId);
    expect(md).toContain('[curation/graduate]');
    expect(md).toContain('relearned ×');
    const rows = await reviewQueueRows(30, projectId);
    const row = rows.find((r) => r.kind === 'curation' && r.curation.basis === 'graduate');
    expect(row?.id).toBe(`graduate:${id}`);
  });

  it('the promote/reject routes dispatch through createReviewPostHandlers', async () => {
    const { createReviewPostHandlers } = await import('../web-review-handlers.js');
    const { GRADUATION_REINFORCEMENTS } = await import('../curation.js');
    const id = await seedLesson({ rule: 'p27test: routed', relearned: GRADUATION_REINFORCEMENTS });
    const handlers = createReviewPostHandlers(async () => projectId);
    const url = new URL('http://x/api/curation/promote');
    const res = await handlers['/api/curation/promote']({ target_id: id }, url);
    expect(String(res.message)).toContain('Promoted lesson');
    // Reject on an already-promoted lesson records a dismissed row that no
    // predicate reads (applied wins in candidacy) — assert the honest behavior:
    // the call succeeds and the promotion verdict is untouched.
    const rej = await handlers['/api/curation/reject']({ target_id: id, note: 'n' }, url);
    expect(String(rej.message)).toContain('Not a rule');
    const applied = await admin.query(
      `SELECT count(*)::int AS n FROM curation_candidates
        WHERE project_id = $1 AND basis = 'graduate' AND status = 'applied'`,
      [projectId]
    );
    expect(applied.rows[0].n).toBe(1);
  });
});
