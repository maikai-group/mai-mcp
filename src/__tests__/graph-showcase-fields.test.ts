import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { Pool } from 'pg';
import fs from 'node:fs';
import { closePool, poolConfig } from '../db.js';
import {
  effectiveEdgeStrength,
  readEdgeStrengths,
  readLastTouched,
  readNodeConfidence,
} from '../graph/metrics.js';
import { graphOverview } from '../graph/overview.js';
import { graphNeighborsRows } from '../graph/query.js';

const admin = new Pool(poolConfig());
const SLUG = 'showcase-fields-test';
const FOREIGN_SLUG = 'showcase-fields-foreign-test';
// TWO repos sharing the SAME relative path — this is the fixture that
// discriminates. A single-repo fixture passes against the broken query.
const PHYSICAL_TMP = fs.realpathSync.native('/tmp');
const REPO_A = `${PHYSICAL_TMP}/showcase-fields-repo-a`;
const REPO_B = `${PHYSICAL_TMP}/showcase-fields-repo-b`;
let projectId = '';
let foreignProjectId = '';
let fileNodeId = '';   // lives in REPO_A
let repoBNodeId = '';  // same relative path, REPO_B
let dbNodeId = '';
let cochangeEdgeId = '';
let linkedEdgeId = '';

beforeAll(async () => {
  fs.mkdirSync(REPO_A, { recursive: true });
  fs.mkdirSync(REPO_B, { recursive: true });
  await admin.query(`DELETE FROM projects WHERE slug = ANY($1::text[])`, [[SLUG, FOREIGN_SLUG]]);
  const p = await admin.query<{ id: string }>(
    `INSERT INTO projects (slug, name, path, metadata) VALUES ($1, 'Showcase', $2, $3::jsonb) RETURNING id`,
    [SLUG, REPO_A, JSON.stringify({ repos: [REPO_A, REPO_B] })]
  );
  projectId = p.rows[0].id;
  const foreign = await admin.query<{ id: string }>(
    `INSERT INTO projects (slug, name, path, metadata) VALUES ($1, 'Foreign showcase', $2, $3::jsonb) RETURNING id`,
    [FOREIGN_SLUG, REPO_A, JSON.stringify({ repos: [REPO_A] })]
  );
  foreignProjectId = foreign.rows[0].id;

  const nodes = await admin.query<{ id: string }>(
    `INSERT INTO graph_nodes (project_id, kind, name, qualified_name, file_path, extracted_by)
     VALUES ($1, 'file', 'a.ts', 'a/src/a.ts', $2, 'ts'),
            ($1, 'file', 'a.ts', 'b/src/a.ts', $3, 'ts'),
            ($1, 'table', 'users', 'db.users', NULL, 'db')
     RETURNING id`,
    [projectId, `${REPO_A}/src/a.ts`, `${REPO_B}/src/a.ts`]
  );
  fileNodeId = nodes.rows[0].id;
  repoBNodeId = nodes.rows[1].id;
  dbNodeId = nodes.rows[2].id;

  // Authored and committed times deliberately disagree. REPO_A was authored
  // newest but committed oldest; the product signal is committed history.
  // Both repos touch 'src/a.ts', so this also discriminates repo identity.
  const older = await admin.query<{ id: string }>(
    `INSERT INTO code_commits (project_id, commit_hash, message, timestamp, committed_at, repo_path)
     VALUES ($1, $2, 'seed a', '2026-08-18T00:00:00Z', '2026-08-10T00:00:00Z', $3) RETURNING id`,
    [projectId, 'a'.repeat(40), REPO_A]
  );
  const newer = await admin.query<{ id: string }>(
    `INSERT INTO code_commits (project_id, commit_hash, message, timestamp, committed_at, repo_path)
     VALUES ($1, $2, 'seed b', '2026-08-01T00:00:00Z', '2026-08-17T00:00:00Z', $3) RETURNING id`,
    [projectId, 'b'.repeat(40), REPO_B]
  );
  await admin.query(
    `INSERT INTO commit_files (project_id, commit_id, path, status)
     VALUES ($1, $2, 'src/a.ts', 'modified'), ($1, $3, 'src/a.ts', 'modified')`,
    [projectId, older.rows[0].id, newer.rows[0].id]
  );

  // Schema-valid adversarial row: commit_files.project_id and commit_id have
  // independent foreign keys, so this project-A file can point at a newer
  // project-B commit with the same repo/path unless the query scopes BOTH.
  const foreignCommit = await admin.query<{ id: string }>(
    `INSERT INTO code_commits (project_id, commit_hash, message, timestamp, committed_at, repo_path)
     VALUES ($1, $2, 'foreign commit', '2026-08-19T00:00:00Z', '2026-08-19T00:00:00Z', $3) RETURNING id`,
    [foreignProjectId, 'f'.repeat(40), REPO_A]
  );
  await admin.query(
    `INSERT INTO commit_files (project_id, commit_id, path, status)
     VALUES ($1, $2, 'src/a.ts', 'modified')`,
    [projectId, foreignCommit.rows[0].id]
  );

  const decision = await admin.query<{ id: string }>(
    `INSERT INTO code_decisions
       (project_id, decision_type, description, confidence, cited_count, reinforcement_count)
     VALUES ($1, 'architecture', 'seed decision', 0.93, 2, 3) RETURNING id`,
    [projectId]
  );
  const retracted = await admin.query<{ id: string }>(
    `INSERT INTO code_decisions (project_id, decision_type, description, confidence, retracted_at)
     VALUES ($1, 'architecture', 'retracted decision', 0.99, NOW()) RETURNING id`,
    [projectId]
  );
  const invalid = await admin.query<{ id: string }>(
    `INSERT INTO code_decisions
       (project_id, decision_type, description, confidence, still_valid, retracted_at)
     VALUES ($1, 'architecture', 'invalid decision', 1.0, false, NULL) RETURNING id`,
    [projectId]
  );
  for (const decisionId of [decision.rows[0].id, retracted.rows[0].id, invalid.rows[0].id]) {
    await admin.query(
      `INSERT INTO memory_edges (project_id, from_kind, from_id, to_kind, to_id, relation)
       VALUES ($1, 'decision', $2, 'graph_node', $3, 'affects')`,
      [projectId, decisionId, fileNodeId]
    );
  }

  const lesson = await admin.query<{ id: string }>(
    `INSERT INTO lessons (project_id, rule, cited_count, reinforcement_count)
     VALUES ($1, 'seed lesson', 1, 2) RETURNING id`, [projectId]
  );
  await admin.query(
    `INSERT INTO memory_edges (project_id, from_kind, from_id, to_kind, to_id, relation)
     VALUES ($1, 'lesson', $2, 'graph_node', $3, 'affects')`,
    [projectId, lesson.rows[0].id, repoBNodeId]
  );

  const edgeRows = await admin.query<{ id: string; relation: string }>(
    `INSERT INTO graph_edges (project_id, from_node, to_node, relation, weight)
     VALUES ($1, $2, $3, 'co_changed_with', 7),
            ($1, $2, $3, 'calls', 1)
     RETURNING id, relation`,
    [projectId, fileNodeId, repoBNodeId]
  );
  cochangeEdgeId = edgeRows.rows.find((r) => r.relation === 'co_changed_with')?.id ?? '';
  linkedEdgeId = edgeRows.rows.find((r) => r.relation === 'calls')?.id ?? '';
});

afterAll(async () => {
  try {
    await admin.query(`DELETE FROM projects WHERE slug = ANY($1::text[])`, [[SLUG, FOREIGN_SLUG]]);
  } finally {
    try {
      await admin.end();
    } finally {
      // readNodeMetrics/readEdgeStrengths use db.ts's lazy singleton, which is
      // separate from `admin`. Close both pools even if fixture cleanup fails.
      await closePool();
      fs.rmSync(REPO_A, { recursive: true, force: true });
      fs.rmSync(REPO_B, { recursive: true, force: true });
    }
  }
});

describe('lastTouched', () => {
  it('joins absolute node paths to repo-relative commit paths', async () => {
    const m = await readLastTouched(projectId, [REPO_A, REPO_B]);
    expect(m.get(fileNodeId)).toBe(new Date('2026-08-10T00:00:00Z').toISOString());
  });

  it('uses authored time only as the legacy fallback when committed_at is null', async () => {
    const legacy = await admin.query<{ id: string }>(
      `INSERT INTO code_commits
         (project_id, commit_hash, message, timestamp, committed_at, repo_path)
       VALUES ($1, $2, 'legacy', '2026-08-12T00:00:00Z', NULL, $3) RETURNING id`,
      [projectId, 'd'.repeat(40), REPO_A]
    );
    await admin.query(
      `INSERT INTO commit_files (project_id, commit_id, path, status)
       VALUES ($1, $2, 'src/a.ts', 'modified')`,
      [projectId, legacy.rows[0].id]
    );
    expect((await readLastTouched(projectId, [REPO_A, REPO_B])).get(fileNodeId))
      .toBe(new Date('2026-08-12T00:00:00Z').toISOString());
    await admin.query(`DELETE FROM code_commits WHERE id = $1`, [legacy.rows[0].id]);
  });

  // THE discriminating test. Against a query that derives only the relative
  // path, repoA's node picks up repoB's 2026-08-17 commit and this fails with
  // exactly one week of drift — the shape measured at 81 days on real data.
  it('never takes a timestamp from a sibling repo with the same relative path', async () => {
    const m = await readLastTouched(projectId, [REPO_A, REPO_B]);
    expect(m.get(fileNodeId)).toBe(new Date('2026-08-10T00:00:00Z').toISOString());
    expect(m.get(repoBNodeId)).toBe(new Date('2026-08-17T00:00:00Z').toISOString());
    expect(m.get(fileNodeId)).not.toBe(m.get(repoBNodeId));
  });

  it('does not let a pruned tombstone advance live graph recency', async () => {
    const tombstone = await admin.query<{ id: string }>(
      `INSERT INTO code_commits
         (project_id, commit_hash, message, timestamp, committed_at, repo_path)
       VALUES ($1, $2, 'pruned recency fixture', '2026-08-20T00:00:00Z',
               '2026-08-20T00:00:00Z', $3)
       RETURNING id`,
      [projectId, '7'.repeat(40), REPO_A]
    );
    await admin.query(
      `INSERT INTO commit_files (project_id, commit_id, path, status)
       VALUES ($1, $2, 'src/a.ts', 'modified')`,
      [projectId, tombstone.rows[0].id]
    );
    await admin.query(
      `INSERT INTO git_history_rewrites
         (project_id, commit_id, old_hash, new_hash, reason)
       VALUES ($1, $2, $3, NULL, 'test: pruned graph recency')`,
      [projectId, tombstone.rows[0].id, '7'.repeat(40)]
    );

    const m = await readLastTouched(projectId, [REPO_A, REPO_B]);
    expect(m.get(fileNodeId)).toBe(new Date('2026-08-10T00:00:00Z').toISOString());
    await admin.query(`DELETE FROM code_commits WHERE id = $1`, [tombstone.rows[0].id]);
  });

  it('never follows a schema-valid commit_files row into another project', async () => {
    const m = await readLastTouched(projectId, [REPO_A, REPO_B]);
    expect(m.get(fileNodeId)).toBe(new Date('2026-08-10T00:00:00Z').toISOString());
    expect(m.get(fileNodeId)).not.toBe(new Date('2026-08-19T00:00:00Z').toISOString());
  });

  it('omits nodes with no file rather than inventing a timestamp', async () => {
    const m = await readLastTouched(projectId, [REPO_A, REPO_B]);
    expect(m.has(dbNodeId)).toBe(false);
  });

  it('returns nothing when the repo prefix does not match — the join is the risk', async () => {
    const m = await readLastTouched(projectId, ['/somewhere/else']);
    expect(m.size).toBe(0);
  });

  it('is empty, not throwing, for a project with no registered repos', async () => {
    const m = await readLastTouched(projectId, []);
    expect(m.size).toBe(0);
  });

  it('drops a commit that cannot prove its repo rather than letting it float', async () => {
    const orphan = await admin.query<{ id: string }>(
      `INSERT INTO code_commits (project_id, commit_hash, message, timestamp, repo_path)
       VALUES ($1, $2, 'no repo', '2026-08-18T00:00:00Z', NULL) RETURNING id`,
      [projectId, 'c'.repeat(40)]
    );
    await admin.query(
      `INSERT INTO commit_files (project_id, commit_id, path, status) VALUES ($1, $2, 'src/a.ts', 'modified')`,
      [projectId, orphan.rows[0].id]
    );
    const m = await readLastTouched(projectId, [REPO_A, REPO_B]);
    // Still repoA's own commit — the unattributable 08-18 row must not win.
    expect(m.get(fileNodeId)).toBe(new Date('2026-08-10T00:00:00Z').toISOString());
    await admin.query(`DELETE FROM code_commits WHERE id = $1`, [orphan.rows[0].id]);
  });
});

describe('identity and authoritative degree', () => {
  it('keeps full identity/location on landing nodes and reports project-wide degree', async () => {
    const overview = await graphOverview(projectId);
    const file = overview.topNodes.find((n) => n.id === fileNodeId);
    expect(file).toMatchObject({
      id: fileNodeId,
      qualified_name: 'a/src/a.ts',
      file_path: `${REPO_A}/src/a.ts`,
      line: null,
      degree: 2,
    });
  });

  it('hydrates the same project-wide degree and identity on neighborhood nodes', async () => {
    const hood = await graphNeighborsRows({ nodeId: fileNodeId, depth: 1, projectId });
    const file = hood?.nodes.find((n) => n.id === fileNodeId);
    expect(file).toMatchObject({
      id: fileNodeId,
      qualified_name: 'a/src/a.ts',
      file_path: `${REPO_A}/src/a.ts`,
      line: null,
      degree: 2,
    });
  });
});

describe('confidence', () => {
  it('takes the max confidence of linked, still-valid non-retracted decisions', async () => {
    const m = await readNodeConfidence(projectId);
    expect(m.get(fileNodeId)).toBeCloseTo(0.93);
  });

  it('ignores a higher-confidence still_valid=false decision without a retraction timestamp', async () => {
    const m = await readNodeConfidence(projectId);
    expect(m.get(fileNodeId)).toBeCloseTo(0.93);
    expect(m.get(fileNodeId)).not.toBe(1);
  });

  it('omits unlinked nodes rather than defaulting them', async () => {
    const m = await readNodeConfidence(projectId);
    expect(m.has(dbNodeId)).toBe(false);
  });
});

describe('effective edge strength', () => {
  it('uses measured co-change weight without adding endpoint telemetry', async () => {
    expect((await readEdgeStrengths(projectId)).get(cochangeEdgeId)).toBe(7);
  });

  it('adds active decision and lesson citation/reinforcement counts at either endpoint', async () => {
    // calls baseline 3 + decision (2 cited + 3 reinforced) + lesson (1 + 2)
    expect((await readEdgeStrengths(projectId)).get(linkedEdgeId)).toBe(11);
  });

  it('gives structural relation tiers and an unknown relation explicit baselines', () => {
    expect(effectiveEdgeStrength('calls', 1, 0)).toBe(3);
    expect(effectiveEdgeStrength('imports', 1, 0)).toBe(2);
    expect(effectiveEdgeStrength('defines', 1, 0)).toBe(1);
    expect(effectiveEdgeStrength('future_relation', null, 0)).toBe(1);
  });
});
