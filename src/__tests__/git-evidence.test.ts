/**
 * End-to-end git evidence: tmp fixture repo → syncGit → code_commits +
 * commit_files rows → auto-linked decision edge. Seeds its own throwaway
 * project (same pattern as ingest.test.ts). Requires docker compose + db:init
 * AND the 2026-07-09-git-evidence migration applied.
 */
import { beforeAll, afterAll, describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Pool } from 'pg';

process.env.MAI_PROJECT_SLUG = 'git-evidence-test';
process.env.MAI_DB_URL =
  process.env.MAI_DB_URL ?? 'postgresql://postgres:postgres@127.0.0.1:54334/mai_brain';

const admin = new Pool({ connectionString: process.env.MAI_DB_URL });
let repo: string;
let projectId: string;

function git(args: string[], cwd: string, dateIso?: string): string {
  // Explicit dates keep committed_at ordering deterministic — same-second
  // commits made the ORDER BY nondeterministic on the first run.
  const env = dateIso
    ? { ...process.env, GIT_AUTHOR_DATE: dateIso, GIT_COMMITTER_DATE: dateIso }
    : process.env;
  return execFileSync('git', args, { cwd, encoding: 'utf8', env });
}

// Relative to now: the auto-linker only examines decisions inside its recency
// window, so hardcoded fixture dates age out and the suite starts failing.
const COMMIT1_AT = new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString();
const COMMIT2_AT = new Date(Date.now() - (2 * 60 - 5) * 60 * 1000).toISOString();

beforeAll(async () => {
  repo = fs.mkdtempSync(path.join(os.tmpdir(), 'mai-git-fixture-'));
  git(['init', '-b', 'main'], repo);
  git(['config', 'user.email', 'test@mai.local'], repo);
  git(['config', 'user.name', 'Mai Test'], repo);
  git(['config', 'commit.gpgsign', 'false'], repo); // contributor machines may sign globally
  fs.mkdirSync(path.join(repo, 'src'), { recursive: true });
  fs.writeFileSync(path.join(repo, 'src/a.ts'), 'export const a = 1;\n');
  git(['add', 'src/a.ts'], repo);
  git(['commit', '-m', 'feat(core): add a\n\nBody line one.'], repo, COMMIT1_AT);
  fs.writeFileSync(path.join(repo, 'src/a.ts'), 'export const a = 2;\nexport const b = 3;\n');
  fs.writeFileSync(path.join(repo, 'src/c.ts'), 'export const c = 1;\n');
  git(['add', 'src/a.ts', 'src/c.ts'], repo);
  git(['commit', '-m', 'fix(core): grow a, add c'], repo, COMMIT2_AT);

  await admin.query(`DELETE FROM projects WHERE slug = 'git-evidence-test'`);
  const r = await admin.query<{ id: string }>(
    `INSERT INTO projects (slug, name, path, metadata) VALUES ('git-evidence-test', 'Git Evidence Test', $1, $2) RETURNING id`,
    [repo, JSON.stringify({ repos: [repo] })]
  );
  projectId = r.rows[0].id;
});

afterAll(async () => {
  await admin.query(`DELETE FROM projects WHERE slug = 'git-evidence-test'`);
  fs.rmSync(repo, { recursive: true, force: true });
  await admin.end();
  const { getPool } = await import('../db.js');
  await getPool().end();
});

describe('syncGit', () => {
  it('indexes commits with parents/body/committed_at/repo_path + per-file stats, idempotently', async () => {
    const { syncGit } = await import('../git/sync.js');
    const first = await syncGit();
    expect(first).toContain('2 new');

    const commits = await admin.query(
      `SELECT commit_hash, message, body, committed_at, parents, repo_path, branch_observed
       FROM code_commits WHERE project_id = $1 ORDER BY committed_at ASC`,
      [projectId]
    );
    expect(commits.rows).toHaveLength(2);
    expect(commits.rows[0].message).toBe('feat(core): add a');
    expect(commits.rows[0].body).toContain('Body line one.');
    expect(commits.rows[0].parents).toEqual([]);
    expect(commits.rows[1].parents).toHaveLength(1);
    expect(commits.rows[0].repo_path).toBe(fs.realpathSync.native(repo));
    expect(commits.rows[0].branch_observed).toBe('main');
    expect(commits.rows[0].committed_at).not.toBeNull();

    const files = await admin.query(
      `SELECT cf.path, cf.status, cf.additions FROM commit_files cf
       JOIN code_commits c ON c.id = cf.commit_id
       WHERE c.project_id = $1 ORDER BY cf.path`,
      [projectId]
    );
    // commit1: a.ts added; commit2: a.ts modified + c.ts added → 3 rows
    expect(files.rows).toHaveLength(3);
    expect(files.rows.some((f) => f.path === 'src/c.ts' && f.status === 'added')).toBe(true);

    const second = await syncGit();
    expect(second).toContain('0 new');
    const filesAfter = await admin.query(
      `SELECT COUNT(*)::int AS n FROM commit_files cf JOIN code_commits c ON c.id = cf.commit_id WHERE c.project_id = $1`,
      [projectId]
    );
    expect(filesAfter.rows[0].n).toBe(3);
  });

  it('auto-links a decision to its session-window commit with inferred provenance', async () => {
    // Session spanning the fixture commits + a decision citing src/c.ts.
    const now = await admin.query<{ lo: string; hi: string }>(
      `SELECT (MIN(committed_at) - INTERVAL '1 minute')::text AS lo,
              (MAX(committed_at) + INTERVAL '1 minute')::text AS hi
       FROM code_commits WHERE project_id = $1`,
      [projectId]
    );
    const s = await admin.query<{ id: string }>(
      `INSERT INTO code_sessions (project_id, original_session_id, started_at, ended_at)
       VALUES ($1, 'git-evidence-fixture-session', $2::timestamptz, $3::timestamptz) RETURNING id`,
      [projectId, now.rows[0].lo, now.rows[0].hi]
    );
    await admin.query(
      `INSERT INTO code_decisions (session_id, project_id, decision_type, description, reasoning, files_affected, source, timestamp)
       VALUES ($1, $2, 'architecture', 'Fixture decision about c', 'because', ARRAY['src/c.ts'], 'session-extract', $3::timestamptz)`,
      [s.rows[0].id, projectId, now.rows[0].hi]
    );

    const { autoLinkDecisions } = await import('../git/links.js');
    const summary = await autoLinkDecisions(projectId);
    expect(summary).toMatch(/[1-9]\d* new link/);

    const edges = await admin.query(
      `SELECT e.relation, e.confidence FROM memory_edges e
       JOIN code_decisions d ON d.id = e.from_id
       WHERE e.project_id = $1 AND e.to_kind = 'commit' AND d.description = 'Fixture decision about c'`,
      [projectId]
    );
    expect(edges.rows.length).toBeGreaterThanOrEqual(1);
    expect(edges.rows[0].relation).toBe('implemented_by');
    expect(edges.rows[0].confidence).toBe('inferred');

    // Idempotent: re-run adds nothing
    const again = await autoLinkDecisions(projectId);
    expect(again).toContain('0 new link');
  });
});

describe('git tools', () => {
  it('gitShow returns metadata + files, and honest not-indexed answer', async () => {
    const { gitShow } = await import('../git/tools.js');
    const hashRow = await admin.query<{ commit_hash: string }>(
      `SELECT commit_hash FROM code_commits WHERE project_id = $1 ORDER BY committed_at ASC LIMIT 1`,
      [projectId]
    );
    const out = await gitShow({ hash: hashRow.rows[0].commit_hash });
    expect(out).toContain('feat(core): add a');
    expect(out).toContain('Body line one.');
    expect(out).toContain('src/a.ts');

    const missing = await gitShow({ hash: 'deadbeefdeadbeef' });
    expect(missing).toContain('No indexed commit');
  });

  it('gitShow hydrates a bounded live patch', async () => {
    const { gitShow } = await import('../git/tools.js');
    const hashRow = await admin.query<{ commit_hash: string }>(
      `SELECT commit_hash FROM code_commits WHERE project_id = $1 ORDER BY committed_at DESC LIMIT 1`,
      [projectId]
    );
    const out = await gitShow({ hash: hashRow.rows[0].commit_hash, patch: true });
    expect(out).toContain('## patch');
    expect(out).toContain('+export const c = 1;');
  });

  it('gitContext summarizes worktree + recent commits with links', async () => {
    const { gitContext } = await import('../git/tools.js');
    const out = await gitContext({});
    expect(out).toContain('branch main');
    expect(out).toContain('fix(core): grow a, add c');
    expect(out).toContain('← implements decision'); // from the auto-linked fixture decision
  });

  it('reports true stats on multi-linked commits (regression: edge join inflated SUMs)', async () => {
    // Second decision linked to the same commit — stats must NOT double.
    const commit = await admin.query<{ id: string; commit_hash: string }>(
      `SELECT id, commit_hash FROM code_commits WHERE project_id = $1 ORDER BY committed_at DESC LIMIT 1`,
      [projectId]
    );
    const d2 = await admin.query<{ id: string }>(
      `INSERT INTO code_decisions (project_id, decision_type, description, reasoning, source)
       VALUES ($1, 'architecture', 'Second fixture decision', 'because', 'session-extract') RETURNING id`,
      [projectId]
    );
    await admin.query(
      `INSERT INTO memory_edges (project_id, from_kind, from_id, to_kind, to_id, relation, confidence)
       VALUES ($1, 'decision', $2, 'commit', $3, 'implemented_by', 'inferred')`,
      [projectId, d2.rows[0].id, commit.rows[0].id]
    );
    const truth = await admin.query<{ adds: number }>(
      `SELECT SUM(additions)::int AS adds FROM commit_files WHERE commit_id = $1`,
      [commit.rows[0].id]
    );

    const { gitContext } = await import('../git/tools.js');
    const out = await gitContext({});
    const line = out.split('\n').find((l) => l.includes(commit.rows[0].commit_hash.slice(0, 8)));
    expect(line).toBeDefined();
    expect(line).toContain(`(+${truth.rows[0].adds}/`);
  });

  it('gitTraceDecision tells the lineage story', async () => {
    const { gitTraceDecision } = await import('../git/tools.js');
    const d = await admin.query<{ id: string }>(
      `SELECT id FROM code_decisions WHERE project_id = $1 AND description = 'Fixture decision about c'`,
      [projectId]
    );
    const out = await gitTraceDecision({ decision_id: d.rows[0].id });
    expect(out).toContain('Fixture decision about c');
    expect(out).toContain('git-evidence-fixture-session');
    expect(out).toContain('src/c.ts');
  });
});

describe('Git history rewrite compatibility', () => {
  it('parses rewritten, pruned and unchanged filter-repo mappings strictly', async () => {
    const { parseCommitMap } = await import('../git/remap.js');
    const a = 'a'.repeat(40);
    const b = 'b'.repeat(40);
    const c = 'c'.repeat(40);
    const zero = '0'.repeat(40);
    expect(parseCommitMap(`old                                      new\n${a} ${b}\n${c} ${zero}\n`)).toEqual([
      { oldHash: a, newHash: b },
      { oldHash: c, newHash: null },
    ]);
    expect(() => parseCommitMap(`${a} ${b}\n${a} ${c}\n`)).toThrow('Duplicate old hash');
    expect(() => parseCommitMap(`${a.slice(1)} ${b}\n`)).toThrow('Invalid commit-map row');
  });

  it('allows schema-only rollback while empty and refuses to discard populated provenance', async () => {
    const rollbackSql = fs.readFileSync(
      path.resolve('db/migrations/2026-08-26-git-history-rewrites.rollback.sql'),
      'utf8'
    );
    const initiallyEmpty = await admin.query<{ count: number }>(
      `SELECT COUNT(*)::int AS count FROM git_history_rewrites`
    );
    expect(initiallyEmpty.rows[0].count).toBe(0);

    const client = await admin.connect();
    try {
      await client.query('BEGIN');
      await client.query(rollbackSql);
      const dropped = await client.query<{ table_name: string | null }>(
        `SELECT to_regclass('public.git_history_rewrites')::text AS table_name`
      );
      expect(dropped.rows[0].table_name).toBeNull();
      await client.query('ROLLBACK');
    } finally {
      await client.query('ROLLBACK').catch(() => {});
      client.release();
    }

    const commit = await admin.query<{ id: string }>(
      `INSERT INTO code_commits
         (project_id, commit_hash, message, timestamp, committed_at, repo_path)
       VALUES ($1, $2, 'rollback guard fixture', NOW(), NOW(), $3)
       RETURNING id`,
      [projectId, 'e7'.repeat(20), repo]
    );
    const oldHash = 'fedcba98'.repeat(5);
    await admin.query(
      `INSERT INTO git_history_rewrites
         (project_id, commit_id, old_hash, new_hash, reason)
       VALUES ($1, $2, $3, NULL, 'test: rollback guard')`,
      [projectId, commit.rows[0].id, oldHash]
    );
    await expect(admin.query(rollbackSql)).rejects.toThrow(
      'Refusing git_history_rewrites rollback: provenance rows exist'
    );
    const preserved = await admin.query<{ count: number }>(
      `SELECT COUNT(*)::int AS count FROM git_history_rewrites
       WHERE project_id = $1 AND old_hash = $2`,
      [projectId, oldHash]
    );
    expect(preserved.rows[0].count).toBe(1);
    await admin.query(
      `DELETE FROM git_history_rewrites WHERE project_id = $1 AND old_hash = $2`,
      [projectId, oldHash]
    );
    await admin.query(`DELETE FROM code_commits WHERE id = $1`, [commit.rows[0].id]);
  });

  it('preserves commit UUID links, resolves old SHAs and tombstones pruned commits', async () => {
    const { syncGit } = await import('../git/sync.js');
    const { parseCommitMap, remapGitHistory } = await import('../git/remap.js');
    const { gitContext, gitShow, gitTraceDecision } = await import('../git/tools.js');

    const base = git(['rev-parse', 'HEAD'], repo).trim();
    const prunedAt = new Date(Date.now() + 60 * 60 * 1000).toISOString();
    fs.mkdirSync(path.join(repo, 'db/backups'), { recursive: true });
    fs.writeFileSync(path.join(repo, 'db/backups/rewrite.sql'), 'private fixture dump\n');
    git(['add', 'db/backups/rewrite.sql'], repo);
    git(['commit', '-m', 'chore(backup): pruned fixture'], repo, prunedAt);
    const prunedHash = git(['rev-parse', 'HEAD'], repo).trim();

    fs.writeFileSync(path.join(repo, 'src/rewrite.ts'), 'export const rewritten = true;\n');
    fs.writeFileSync(path.join(repo, 'db/backups/rewrite.sql'), 'private fixture dump v2\n');
    git(['add', 'src/rewrite.ts', 'db/backups/rewrite.sql'], repo);
    git(['commit', '-m', 'feat(core): commit after backup'], repo, new Date(Date.now() - 20 * 60 * 1000).toISOString());
    const oldRewrittenHash = git(['rev-parse', 'HEAD'], repo).trim();

    git(['switch', '-c', 'side-rewrite-old', base], repo);
    fs.mkdirSync(path.join(repo, 'db/backups'), { recursive: true });
    fs.writeFileSync(path.join(repo, 'src/side.ts'), 'export const side = true;\n');
    fs.writeFileSync(path.join(repo, 'db/backups/side.sql'), 'private side-ref dump\n');
    git(['add', 'src/side.ts', 'db/backups/side.sql'], repo);
    git(['commit', '-m', 'feat(side): side history'], repo, new Date(Date.now() - 10 * 60 * 1000).toISOString());
    const oldSideHash = git(['rev-parse', 'HEAD'], repo).trim();
    git(['switch', 'main'], repo);
    await syncGit({ full: true });

    const indexed = await admin.query<{ id: string; commit_hash: string }>(
      `SELECT id, commit_hash FROM code_commits
       WHERE project_id = $1 AND commit_hash = ANY($2::text[])`,
      [projectId, [prunedHash, oldRewrittenHash, oldSideHash]]
    );
    const prunedCommit = indexed.rows.find((row) => row.commit_hash === prunedHash);
    const rewrittenCommit = indexed.rows.find((row) => row.commit_hash === oldRewrittenHash);
    const sideCommit = indexed.rows.find((row) => row.commit_hash === oldSideHash);
    expect(prunedCommit).toBeDefined();
    expect(rewrittenCommit).toBeDefined();
    expect(sideCommit).toBeDefined();
    if (!prunedCommit || !rewrittenCommit || !sideCommit) {
      throw new Error('fixture commits were not indexed');
    }

    const decision = await admin.query<{ id: string }>(
      `INSERT INTO code_decisions
         (project_id, decision_type, description, reasoning, source)
       VALUES ($1, 'architecture', 'Rewrite-linked fixture decision', 'preserve UUID edge', 'user-approved')
       RETURNING id`,
      [projectId]
    );
    await admin.query(
      `INSERT INTO memory_edges
         (project_id, from_kind, from_id, to_kind, to_id, relation, confidence)
       VALUES ($1, 'decision', $2, 'commit', $3, 'implemented_by', 'explicit'),
              ($1, 'decision', $2, 'commit', $4, 'implemented_by', 'explicit')`,
      [projectId, decision.rows[0].id, rewrittenCommit.id, prunedCommit.id]
    );
    const derivationSession = await admin.query<{ id: string }>(
      `INSERT INTO code_sessions
         (project_id, original_session_id, started_at, ended_at)
       VALUES ($1, 'rewrite-tombstone-derivation', $2::timestamptz - interval '1 minute',
               $2::timestamptz)
       RETURNING id`,
      [projectId, prunedAt]
    );
    const derivationDecisions = await admin.query<{ id: string }>(
      `INSERT INTO code_decisions
         (session_id, project_id, decision_type, description, reasoning, files_affected, source, timestamp)
       VALUES
         ($1, $2, 'architecture', 'Tombstone overlap must not link', 'fixture',
          ARRAY['db/backups/rewrite.sql'], 'session-extract', $3::timestamptz),
         ($1, $2, 'architecture', 'Tombstone fallback must not link', 'fixture',
          NULL, 'session-extract', $3::timestamptz)
       RETURNING id`,
      [derivationSession.rows[0].id, projectId, prunedAt]
    );
    const findings = await admin.query<{ id: string; title: string }>(
      `INSERT INTO code_findings
         (project_id, base_sha, head_sha, reviewer_agent, severity, title, location, issue, evidence, fix)
       VALUES
         ($1, $2, $3, 'rewrite-test', 'warning', 'rewrite ref full', 'src/rewrite.ts:1',
          'fixture', 'fixture', 'fixture'),
         ($1, $4, 'working-tree', 'rewrite-test', 'warning', 'rewrite ref 12', 'src/rewrite.ts:1',
          'fixture', 'fixture', 'fixture'),
         ($1, $5, 'working-tree', 'rewrite-test', 'warning', 'rewrite ref 7', 'src/rewrite.ts:1',
          'fixture', 'fixture', 'fixture'),
         ($1, 'working-tree', 'working-tree', 'rewrite-test', 'warning', 'rewrite sentinel', 'src/rewrite.ts:1',
          'fixture', 'fixture', 'fixture')
       RETURNING id, title`,
      [
        projectId,
        oldRewrittenHash,
        prunedHash,
        oldRewrittenHash.slice(0, 12),
        oldRewrittenHash.slice(0, 7),
      ]
    );
    const graphNode = await admin.query<{ id: string }>(
      `INSERT INTO graph_nodes
         (project_id, kind, name, qualified_name, file_path, commit_sha, extracted_by)
       VALUES ($1, 'file', 'rewrite.ts', 'rewrite-fixture:src/rewrite.ts', $2, $3, 'rewrite-test')
       RETURNING id`,
      [projectId, path.join(repo, 'src/rewrite.ts'), oldRewrittenHash]
    );

    git(['rm', 'db/backups/rewrite.sql'], repo);
    const cleanTree = git(['write-tree'], repo).trim();
    git(['config', 'user.name', 'Rewrite Sanitizer'], repo);
    const rewrittenHash = git(
      ['commit-tree', cleanTree, '-p', base, '-m', 'fix(sanitized): rewritten metadata'],
      repo,
      new Date(Date.now() - 20 * 60 * 1000).toISOString()
    ).trim();
    git(['config', 'user.name', 'Mai Test'], repo);
    git(['reset', '--hard', rewrittenHash], repo);

    git(['switch', 'side-rewrite-old'], repo);
    git(['rm', 'db/backups/side.sql'], repo);
    const cleanSideTree = git(['write-tree'], repo).trim();
    const rewrittenSideHash = git(
      ['commit-tree', cleanSideTree, '-p', base, '-m', 'feat(side): side history'],
      repo,
      new Date(Date.now() - 10 * 60 * 1000).toISOString()
    ).trim();
    git(['branch', 'side-clean', rewrittenSideHash], repo);
    git(['switch', 'main'], repo);
    git(['branch', '-D', 'side-rewrite-old'], repo);

    const map = parseCommitMap(
      `old                                      new\n${base} ${base}\n${prunedHash} ${'0'.repeat(40)}\n${oldRewrittenHash} ${rewrittenHash}\n${oldSideHash} ${rewrittenSideHash}\n`
    );

    git(['branch', 'retained-old-rewrite', oldRewrittenHash], repo);
    await expect(remapGitHistory(repo, map, 'test: retained branch')).rejects.toThrow(
      'old hash(es) are still reachable'
    );
    git(['branch', '-D', 'retained-old-rewrite'], repo);

    git(['tag', 'retained-pruned-backup', prunedHash], repo);
    await expect(remapGitHistory(repo, map, 'test: retained tag')).rejects.toThrow(
      'old hash(es) are still reachable'
    );
    git(['tag', '-d', 'retained-pruned-backup'], repo);

    await expect(
      remapGitHistory(
        repo,
        [{ oldHash: oldRewrittenHash, newHash: base }],
        'test: collision must roll back'
      )
    ).rejects.toThrow('already belongs to another indexed commit');
    const afterCollision = await admin.query<{ count: number }>(
      `SELECT COUNT(*)::int AS count FROM git_history_rewrites
       WHERE project_id = $1 AND old_hash = $2`,
      [projectId, oldRewrittenHash]
    );
    expect(afterCollision.rows[0].count).toBe(0);

    const result = await remapGitHistory(repo, map, 'test: remove fixture backup');
    expect(result).toMatchObject({ rewritten: 2, pruned: 1, unchanged: 1, commitRowsUpdated: 2 });
    expect(result.preservedCommitEdges).toBeGreaterThanOrEqual(2);
    await syncGit({ full: true, failFast: true });

    const commits = await admin.query<{ id: string; commit_hash: string }>(
      `SELECT id, commit_hash FROM code_commits WHERE id = ANY($1::uuid[]) ORDER BY id`,
      [[rewrittenCommit.id, prunedCommit.id, sideCommit.id]]
    );
    expect(commits.rows).toContainEqual({ id: rewrittenCommit.id, commit_hash: rewrittenHash });
    expect(commits.rows).toContainEqual({ id: prunedCommit.id, commit_hash: prunedHash });
    expect(commits.rows).toContainEqual({ id: sideCommit.id, commit_hash: rewrittenSideHash });

    const refreshedMetadata = await admin.query<{
      message: string;
      author: string;
      commit_type: string;
      scope: string;
    }>(
      `SELECT message, author, commit_type, scope FROM code_commits WHERE id = $1`,
      [rewrittenCommit.id]
    );
    expect(refreshedMetadata.rows[0]).toEqual({
      message: 'fix(sanitized): rewritten metadata',
      author: 'Rewrite Sanitizer',
      commit_type: 'fix',
      scope: 'sanitized',
    });

    const aliases = await admin.query<{ old_hash: string; new_hash: string | null }>(
      `SELECT old_hash, new_hash FROM git_history_rewrites
       WHERE project_id = $1 AND old_hash = ANY($2::text[]) ORDER BY old_hash`,
      [projectId, [oldRewrittenHash, prunedHash]]
    );
    expect(aliases.rows).toEqual(
      [
        { old_hash: oldRewrittenHash, new_hash: rewrittenHash },
        { old_hash: prunedHash, new_hash: null },
      ].sort((left, right) => left.old_hash.localeCompare(right.old_hash))
    );

    const edges = await admin.query<{ to_id: string }>(
      `SELECT to_id FROM memory_edges
       WHERE project_id = $1 AND from_id = $2 AND to_kind = 'commit' ORDER BY to_id`,
      [projectId, decision.rows[0].id]
    );
    expect(edges.rows.map((row) => row.to_id).sort()).toEqual(
      [rewrittenCommit.id, prunedCommit.id].sort()
    );

    const refs = await admin.query<{ title: string; base_sha: string; head_sha: string }>(
      `SELECT title, base_sha, head_sha FROM code_findings
       WHERE id = ANY($1::uuid[]) ORDER BY title`,
      [findings.rows.map((row) => row.id)]
    );
    expect(refs.rows).toEqual([
      { title: 'rewrite ref 12', base_sha: rewrittenHash, head_sha: 'working-tree' },
      { title: 'rewrite ref 7', base_sha: rewrittenHash, head_sha: 'working-tree' },
      { title: 'rewrite ref full', base_sha: rewrittenHash, head_sha: prunedHash },
      { title: 'rewrite sentinel', base_sha: 'working-tree', head_sha: 'working-tree' },
    ]);
    const node = await admin.query<{ commit_sha: string }>(
      `SELECT commit_sha FROM graph_nodes WHERE id = $1`,
      [graphNode.rows[0].id]
    );
    expect(node.rows[0].commit_sha).toBe(rewrittenHash);

    const rewrittenFiles = await admin.query<{
      path: string;
      status: string;
      additions: number | null;
      deletions: number | null;
    }>(
      `SELECT path, status, additions, deletions
       FROM commit_files WHERE commit_id = $1 ORDER BY path`,
      [rewrittenCommit.id]
    );
    expect(rewrittenFiles.rows).toEqual([
      { path: 'src/rewrite.ts', status: 'added', additions: 1, deletions: 0 },
    ]);
    expect(rewrittenFiles.rows.some((row) => row.path.startsWith('db/backups/'))).toBe(false);

    const sideEvidence = await admin.query<{
      parents: string[];
      path: string;
      status: string;
      additions: number | null;
      deletions: number | null;
    }>(
      `SELECT c.parents, f.path, f.status, f.additions, f.deletions
       FROM code_commits c JOIN commit_files f ON f.commit_id = c.id
       WHERE c.id = $1 ORDER BY f.path`,
      [sideCommit.id]
    );
    expect(sideEvidence.rows).toEqual([
      {
        parents: [base],
        path: 'src/side.ts',
        status: 'added',
        additions: 1,
        deletions: 0,
      },
    ]);

    const derivedTombstoneEdges = await admin.query<{ count: number }>(
      `SELECT COUNT(*)::int AS count FROM memory_edges
       WHERE project_id = $1 AND from_id = ANY($2::uuid[])`,
      [projectId, derivationDecisions.rows.map((row) => row.id)]
    );
    expect(derivedTombstoneEdges.rows[0].count).toBe(0);

    const total = await admin.query<{ total_commits: number; reachable: number }>(
      `SELECT p.total_commits,
              (SELECT COUNT(*)::int FROM code_commits c
               WHERE c.project_id = p.id AND NOT EXISTS (
                 SELECT 1 FROM git_history_rewrites r
                 WHERE r.commit_id = c.id AND r.new_hash IS NULL
               )) AS reachable
       FROM projects p WHERE p.id = $1`,
      [projectId]
    );
    expect(total.rows[0].total_commits).toBe(total.rows[0].reachable);

    const rewrittenShow = await gitShow({ hash: oldRewrittenHash, patch: true });
    expect(rewrittenShow).toContain(`# ${rewrittenHash}`);
    expect(rewrittenShow).toContain(`history rewrite aliases: ${oldRewrittenHash}`);
    expect(rewrittenShow).toContain('fix(sanitized): rewritten metadata');
    expect(rewrittenShow).not.toContain('feat(core): commit after backup');
    expect(rewrittenShow).toContain('+export const rewritten = true;');

    const prunedShow = await gitShow({ hash: prunedHash, patch: true });
    expect(prunedShow).toContain('intentionally pruned');
    expect(prunedShow).toContain('indexed metadata is retained for provenance');

    const context = await gitContext({});
    expect(context).not.toContain('chore(backup): pruned fixture');
    const trace = await gitTraceDecision({ decision_id: decision.rows[0].id });
    expect(trace).toContain(rewrittenHash.slice(0, 8));
    expect(trace).toContain('[pruned by recorded history rewrite]');

    const again = await remapGitHistory(repo, map, 'test: idempotent retry');
    expect(again.commitRowsUpdated).toBe(0);

    const sharedPrefix = 'abcdef0';
    const ambiguousOld1 = sharedPrefix + '1'.repeat(33);
    const ambiguousOld2 = sharedPrefix + '2'.repeat(33);
    const ambiguousFinding = await admin.query<{ id: string }>(
      `INSERT INTO code_findings
         (project_id, base_sha, head_sha, reviewer_agent, severity, title, location, issue, evidence, fix)
       VALUES ($1, $2, 'working-tree', 'rewrite-test', 'warning', 'ambiguous rewrite ref',
               'src/rewrite.ts:1', 'fixture', 'fixture', 'fixture')
       RETURNING id`,
      [projectId, sharedPrefix]
    );
    await expect(
      remapGitHistory(
        repo,
        [
          { oldHash: ambiguousOld1, newHash: base },
          { oldHash: ambiguousOld2, newHash: rewrittenHash },
        ],
        'test: ambiguous finding prefix'
      )
    ).rejects.toThrow("matches 2 old hashes");
    const ambiguousAliases = await admin.query<{ count: number }>(
      `SELECT COUNT(*)::int AS count FROM git_history_rewrites
       WHERE project_id = $1 AND old_hash = ANY($2::text[])`,
      [projectId, [ambiguousOld1, ambiguousOld2]]
    );
    expect(ambiguousAliases.rows[0].count).toBe(0);
    const unchangedAmbiguous = await admin.query<{ base_sha: string }>(
      `SELECT base_sha FROM code_findings WHERE id = $1`,
      [ambiguousFinding.rows[0].id]
    );
    expect(unchangedAmbiguous.rows[0].base_sha).toBe(sharedPrefix);
  });

  it('reports a committed remap as partial when its mandatory full sync fails', async () => {
    const { run } = await import('../scripts/remap-git-history.js');
    const oldHash = 'a'.repeat(40);
    const newHash = 'b'.repeat(40);
    await expect(
      run(
        [
          '--map',
          'fixture-map',
          '--repo',
          repo,
          '--reason',
          'test: injected sync failure',
          '--apply',
        ],
        {
          readMap: async () => `${oldHash} ${newHash}\n`,
          remap: async () => ({
            mappings: 1,
            rewritten: 1,
            pruned: 0,
            unchanged: 0,
            indexed: 1,
            unindexed: 0,
            commitRowsUpdated: 1,
            graphNodesUpdated: 0,
            findingRefsUpdated: 0,
            preservedCommitEdges: 0,
          }),
          sync: async (options) => {
            if (!options.failFast) return 'repo fixture: skipped (injected repo failure)';
            throw new Error('injected repo failure');
          },
        }
      )
    ).rejects.toThrow(/PARTIAL:.*rerun the same --apply.*idempotent/s);
  });

  it('adopts a newly indexed target on retry for an initially unindexed old mapping', async () => {
    const { remapGitHistory } = await import('../git/remap.js');
    const { syncGit } = await import('../git/sync.js');
    const { gitShow } = await import('../git/tools.js');

    fs.writeFileSync(path.join(repo, 'src/late-clean.ts'), 'export const lateClean = true;\n');
    git(['add', 'src/late-clean.ts'], repo);
    git(['commit', '-m', 'feat(late): clean target discovered after remap'], repo);
    const newHash = git(['rev-parse', 'HEAD'], repo).trim();
    const oldHash = '8'.repeat(40);
    const map = [{ oldHash, newHash }];

    const first = await remapGitHistory(repo, map, 'test: initially unindexed mapping');
    expect(first).toMatchObject({ indexed: 0, unindexed: 1, commitRowsUpdated: 0 });

    await syncGit({ full: true, failFast: true });
    const target = await admin.query<{ id: string }>(
      `SELECT id FROM code_commits WHERE project_id = $1 AND commit_hash = $2`,
      [projectId, newHash]
    );
    expect(target.rows).toHaveLength(1);

    const retry = await remapGitHistory(repo, map, 'test: initially unindexed retry');
    expect(retry).toMatchObject({ indexed: 1, unindexed: 0, commitRowsUpdated: 0 });
    const alias = await admin.query<{ commit_id: string; new_hash: string }>(
      `SELECT commit_id, new_hash FROM git_history_rewrites
       WHERE project_id = $1 AND old_hash = $2`,
      [projectId, oldHash]
    );
    expect(alias.rows[0]).toEqual({ commit_id: target.rows[0].id, new_hash: newHash });
    expect(await gitShow({ hash: oldHash })).toContain(`history rewrite aliases: ${oldHash}`);
  });
});
