// Incremental git ingestion: commits + per-file stats → code_commits +
// commit_files, then the decision auto-linker. Incremental via
// max(committed_at) per repo minus a 7-day overlap (clock skew / amends);
// NULL → full history (which is also the post-migration backfill, since the
// upsert is DO UPDATE for the new columns). branch_observed is write-once.
import { getPool, getProjectId, loadProjectGraphRoots } from '../db.js';
import type { Pool, PoolClient } from 'pg';
import { currentBranch, logCommits, type GitCommit } from './repo.js';
import { autoLinkDecisions } from './links.js';
import { advancePlanLifecycle } from './plan-lifecycle.js';
import { canonicalRegisteredRoots } from '../graph/roots.js';

const CONVENTIONAL = /^(\w+)(?:\(([^)]+)\))?:/;
const OVERLAP_DAYS = 7;

async function upsertCommit(
  projectId: string,
  repo: string,
  branch: string,
  c: GitCommit,
  db: Pool | PoolClient = getPool()
): Promise<{ id: string; inserted: boolean }> {
  const physicalRepo = canonicalRegisteredRoots([repo], {
    baseDir: process.cwd(),
    rejectRelative: true,
  })[0];
  const m = c.subject.match(CONVENTIONAL);
  const res = await db.query<{ id: string; inserted: boolean }>(
    `INSERT INTO code_commits
       (session_id, project_id, commit_hash, message, body, timestamp, committed_at,
        parents, branch_observed, repo_path, commit_type, scope, author)
     VALUES (NULL, $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)
     ON CONFLICT (project_id, commit_hash) DO UPDATE SET
       message = EXCLUDED.message,
       body = EXCLUDED.body,
       timestamp = EXCLUDED.timestamp,
       committed_at = EXCLUDED.committed_at,
       parents = EXCLUDED.parents,
       repo_path = EXCLUDED.repo_path,
       commit_type = EXCLUDED.commit_type,
       scope = EXCLUDED.scope,
       author = EXCLUDED.author
       -- branch_observed deliberately NOT updated: first observation wins
     RETURNING id, (xmax = 0) AS inserted`,
    [
      projectId,
      c.hash,
      c.subject,
      c.body || null,
      c.authoredAt || null,
      c.committedAt || null,
      c.parents,
      branch,
      physicalRepo,
      m ? m[1].toLowerCase() : null,
      m?.[2] ?? null,
      c.author || null,
    ]
  );
  return res.rows[0];
}

/** Sync the pinned project's git evidence. full=true is the repair path after
 * a history rewrite: every reachable commit is re-read so rewritten parent
 * arrays and metadata refresh even when their committed_at is old. */
export async function syncGit(
  options: { full?: boolean; failFast?: boolean } = {}
): Promise<string> {
  const pool = getPool();
  const projectId = await getProjectId();
  const repos = (await loadProjectGraphRoots(projectId)).repos;
  if (repos.length === 0) return 'No repos recorded for this project — nothing to sync.';

  const lines: string[] = [];
  for (const repo of repos) {
    let branch = '(unknown)';
    let commits: GitCommit[];
    try {
      branch = options.full ? '(all refs)' : await currentBranch(repo);
      let since: string | undefined;
      if (!options.full) {
        const sinceRow = await pool.query<{ since: string | null }>(
          `SELECT (MAX(c.committed_at) - INTERVAL '${OVERLAP_DAYS} days')::text AS since
           FROM code_commits c
           WHERE c.project_id = $1 AND c.repo_path = $2
             AND NOT EXISTS (
               SELECT 1 FROM git_history_rewrites r
               WHERE r.commit_id = c.id AND r.new_hash IS NULL
             )`,
          [projectId, repo]
        );
        since = sinceRow.rows[0]?.since ?? undefined;
      }
      commits = await logCommits(repo, since, options.full === true);
    } catch (err) {
      if (options.failFast) {
        const detail = err instanceof Error ? err.message.split('\n')[0] : String(err);
        throw new Error(`repo ${repo}: full sync failed (${detail})`);
      }
      lines.push(`repo ${repo}: skipped (${(err as Error).message.split('\n')[0]})`);
      continue;
    }

    let inserted = 0;
    let updated = 0;
    let filesIndexed = 0;
    const client = options.full ? await pool.connect() : null;
    const db = client ?? pool;
    try {
      if (client) await client.query('BEGIN');
      for (const c of commits) {
        if (!c.hash || !c.subject) continue;
        const row = await upsertCommit(projectId, repo, branch, c, db);
        if (row.inserted) inserted++;
        else updated++;
        if (options.full) {
          // The rewritten diff is authoritative. Delete first so removed paths,
          // changed statuses and changed stats cannot survive under the stable
          // commit UUID. The repo transaction makes replacement all-or-nothing.
          await db.query(`DELETE FROM commit_files WHERE commit_id = $1`, [row.id]);
        }
        for (const f of c.files) {
          const r = await db.query(
            `INSERT INTO commit_files
               (project_id, commit_id, path, status, old_path, additions, deletions, is_binary)
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
             ON CONFLICT (commit_id, path) DO NOTHING`,
            [projectId, row.id, f.path, f.status, f.oldPath ?? null, f.additions, f.deletions, f.isBinary]
          );
          if (r.rowCount && r.rowCount > 0) filesIndexed++;
        }
      }
      if (client) await client.query('COMMIT');
    } catch (error) {
      if (client) await client.query('ROLLBACK').catch(() => {});
      throw error;
    } finally {
      client?.release();
    }
    lines.push(`repo ${repo}: ${inserted} new, ${updated} refreshed, ${filesIndexed} file change(s) indexed`);
  }

  await pool.query(
    `UPDATE projects SET total_commits = (
       SELECT COUNT(*) FROM code_commits c
       WHERE c.project_id = $1 AND NOT EXISTS (
         SELECT 1 FROM git_history_rewrites r
         WHERE r.commit_id = c.id AND r.new_hash IS NULL
       )
     ) WHERE id = $1`,
    [projectId]
  );

  lines.push(await autoLinkDecisions(projectId));
  // Bridge B (plan 21 §4.1): a derivation pass that runs AFTER commits and
  // files are in the DB, with ids available — the same slot, and the same
  // contract (returns a summary line, never throws), as autoLinkDecisions.
  lines.push(await advancePlanLifecycle(projectId));
  return lines.join('\n');
}
