import type { PoolClient } from 'pg';
import { getPool, getProjectId, loadProjectGraphRoots } from '../db.js';
import { canonicalRegisteredRoots } from '../graph/roots.js';
import { allReachableCommitHashes } from './repo.js';

const HASH = /^[0-9a-f]{40}$/;
const ZERO_HASH = '0'.repeat(40);

export interface CommitRewrite {
  oldHash: string;
  /** null means filter-repo pruned the entire commit. */
  newHash: string | null;
}

export interface RemapResult {
  mappings: number;
  rewritten: number;
  pruned: number;
  unchanged: number;
  indexed: number;
  unindexed: number;
  commitRowsUpdated: number;
  graphNodesUpdated: number;
  findingRefsUpdated: number;
  preservedCommitEdges: number;
}

/** Parse git-filter-repo's two-column commit-map. The zero hash is an explicit
 * pruned tombstone, not a commit identity. */
export function parseCommitMap(text: string): CommitRewrite[] {
  const rows: CommitRewrite[] = [];
  const seen = new Set<string>();
  for (const [index, raw] of text.split(/\r?\n/).entries()) {
    const line = raw.trim();
    if (!line || line === 'old                                      new') continue;
    const parts = line.split(/\s+/);
    if (parts.length !== 2 || !HASH.test(parts[0]) || !HASH.test(parts[1])) {
      throw new Error(`Invalid commit-map row ${index + 1}: expected two lowercase 40-character hashes`);
    }
    const [oldHash, rawNew] = parts;
    if (seen.has(oldHash)) throw new Error(`Duplicate old hash in commit-map: ${oldHash}`);
    seen.add(oldHash);
    rows.push({ oldHash, newHash: rawNew === ZERO_HASH ? null : rawNew });
  }
  if (rows.length === 0) throw new Error('Commit map contains no mappings');
  return rows;
}

async function validateCleanedRepo(repo: string, mappings: CommitRewrite[]): Promise<void> {
  const roots = await loadProjectGraphRoots(await getProjectId());
  const physicalRepo = canonicalRegisteredRoots([repo], {
    baseDir: roots.productRoot,
    rejectRelative: true,
  })[0];
  if (!roots.repos.includes(physicalRepo)) {
    throw new Error(`Refusing history remap: ${repo} is not a registered repo for the pinned project`);
  }

  const reachable = await allReachableCommitHashes(physicalRepo);
  const missingNew = mappings.filter(
    (row) => row.newHash !== null && row.newHash !== row.oldHash && !reachable.has(row.newHash)
  );
  if (missingNew.length > 0) {
    throw new Error(
      `Refusing history remap: ${missingNew.length} rewritten hash(es) are not reachable in the registered repo`
    );
  }

  const oldStillReachable = mappings.filter(
    (row) => row.newHash !== row.oldHash && reachable.has(row.oldHash)
  );
  if (oldStillReachable.length > 0) {
    throw new Error(
      `Refusing history remap: ${oldStillReachable.length} superseded/pruned old hash(es) are still reachable`
    );
  }
}

async function loadMap(client: PoolClient, mappings: CommitRewrite[]): Promise<void> {
  await client.query(
    `CREATE TEMP TABLE mai_git_history_map (
       old_hash text PRIMARY KEY,
       new_hash text
     ) ON COMMIT DROP`
  );
  await client.query(
    `INSERT INTO mai_git_history_map (old_hash, new_hash)
     SELECT * FROM unnest($1::text[], $2::text[])`,
    [mappings.map((row) => row.oldHash), mappings.map((row) => row.newHash)]
  );
}

/**
 * Atomically translate persisted Git identities while preserving code_commits
 * UUIDs. Rewritten rows move to their reachable new hash. Fully-pruned rows
 * retain their old indexed commit row and gain a NULL-new_hash tombstone, so
 * historical decision links remain explainable and old SHA lookup still works.
 */
export async function remapGitHistory(
  repo: string,
  mappings: CommitRewrite[],
  reason: string
): Promise<RemapResult> {
  if (!reason.trim()) throw new Error('History rewrite reason is required');
  await validateCleanedRepo(repo, mappings);

  const projectId = await getProjectId();
  const client = await getPool().connect();
  try {
    await client.query('BEGIN');
    await loadMap(client, mappings);

    const ambiguousFinding = await client.query<{
      id: string;
      field: string;
      value: string;
      matches: number;
    }>(
      `WITH candidates AS (
         SELECT f.id, 'base_sha'::text AS field, f.base_sha AS value,
                COUNT(*)::int AS matches
         FROM code_findings f
         JOIN mai_git_history_map m ON m.old_hash LIKE lower(f.base_sha) || '%'
         WHERE f.project_id = $1 AND f.base_sha ~* '^[0-9a-f]{7,40}$'
         GROUP BY f.id, f.base_sha
         UNION ALL
         SELECT f.id, 'head_sha'::text AS field, f.head_sha AS value,
                COUNT(*)::int AS matches
         FROM code_findings f
         JOIN mai_git_history_map m ON m.old_hash LIKE lower(f.head_sha) || '%'
         WHERE f.project_id = $1 AND f.head_sha ~* '^[0-9a-f]{7,40}$'
         GROUP BY f.id, f.head_sha
       )
       SELECT id, field, value, matches FROM candidates WHERE matches > 1 LIMIT 1`,
      [projectId]
    );
    if (ambiguousFinding.rows.length > 0) {
      const row = ambiguousFinding.rows[0];
      throw new Error(
        `Refusing history remap: code finding ${row.id} ${row.field} prefix '${row.value}' matches ${row.matches} old hashes`
      );
    }

    const collision = await client.query<{ old_hash: string; new_hash: string }>(
      `SELECT m.old_hash, m.new_hash
       FROM mai_git_history_map m
       JOIN code_commits target
         ON target.project_id = $1 AND target.commit_hash = m.new_hash
       LEFT JOIN code_commits source
         ON source.project_id = $1 AND source.commit_hash = m.old_hash
       LEFT JOIN git_history_rewrites prior
         ON prior.project_id = $1 AND prior.old_hash = m.old_hash
       WHERE m.new_hash IS NOT NULL AND m.new_hash <> m.old_hash
         AND COALESCE(source.id, prior.commit_id) IS NOT NULL
         AND target.id IS DISTINCT FROM COALESCE(source.id, prior.commit_id)
       LIMIT 1`,
      [projectId]
    );
    if (collision.rows.length > 0) {
      throw new Error(
        `Refusing history remap: new hash ${collision.rows[0].new_hash} already belongs to another indexed commit`
      );
    }

    const aliases = await client.query(
      `WITH targets AS (
         SELECT m.old_hash, m.new_hash,
                COALESCE(source.id, prior.commit_id, target.id) AS commit_id
         FROM mai_git_history_map m
         LEFT JOIN code_commits source
           ON source.project_id = $1 AND source.commit_hash = m.old_hash
         LEFT JOIN git_history_rewrites prior
           ON prior.project_id = $1 AND prior.old_hash = m.old_hash
         LEFT JOIN code_commits target
           ON target.project_id = $1 AND target.commit_hash = m.new_hash
         WHERE m.new_hash IS DISTINCT FROM m.old_hash
       )
       INSERT INTO git_history_rewrites
         (project_id, commit_id, old_hash, new_hash, reason)
       SELECT $1, commit_id, old_hash, new_hash, $2
       FROM targets WHERE commit_id IS NOT NULL
       ON CONFLICT (project_id, old_hash) DO UPDATE SET
         new_hash = EXCLUDED.new_hash,
         reason = EXCLUDED.reason
       RETURNING commit_id`,
      [projectId, reason.trim()]
    );

    const commits = await client.query(
      `UPDATE code_commits c
       SET commit_hash = m.new_hash
       FROM mai_git_history_map m
       WHERE c.project_id = $1 AND c.commit_hash = m.old_hash
         AND m.new_hash IS NOT NULL AND m.new_hash <> m.old_hash`,
      [projectId]
    );

    const graph = await client.query(
      `UPDATE graph_nodes n
       SET commit_sha = m.new_hash
       FROM mai_git_history_map m
       WHERE n.project_id = $1 AND n.commit_sha = m.old_hash
         AND m.new_hash IS NOT NULL AND m.new_hash <> m.old_hash`,
      [projectId]
    );

    const findingBase = await client.query(
      `UPDATE code_findings f
       SET base_sha = m.new_hash
       FROM mai_git_history_map m
       WHERE f.project_id = $1 AND f.base_sha ~* '^[0-9a-f]{7,40}$'
         AND m.old_hash LIKE lower(f.base_sha) || '%'
         AND m.new_hash IS NOT NULL AND m.new_hash <> m.old_hash`,
      [projectId]
    );
    const findingHead = await client.query(
      `UPDATE code_findings f
       SET head_sha = m.new_hash
       FROM mai_git_history_map m
       WHERE f.project_id = $1 AND f.head_sha ~* '^[0-9a-f]{7,40}$'
         AND m.old_hash LIKE lower(f.head_sha) || '%'
         AND m.new_hash IS NOT NULL AND m.new_hash <> m.old_hash`,
      [projectId]
    );

    const preserved = await client.query<{ count: number }>(
      `SELECT COUNT(*)::int AS count
       FROM memory_edges e
       WHERE e.project_id = $1 AND e.to_kind = 'commit'
         AND EXISTS (
           SELECT 1 FROM git_history_rewrites r WHERE r.commit_id = e.to_id
         )`,
      [projectId]
    );

    await client.query('COMMIT');

    const rewritten = mappings.filter(
      (row) => row.newHash !== null && row.newHash !== row.oldHash
    ).length;
    const pruned = mappings.filter((row) => row.newHash === null).length;
    const unchanged = mappings.length - rewritten - pruned;
    return {
      mappings: mappings.length,
      rewritten,
      pruned,
      unchanged,
      indexed: aliases.rowCount ?? 0,
      unindexed: rewritten + pruned - (aliases.rowCount ?? 0),
      commitRowsUpdated: commits.rowCount ?? 0,
      graphNodesUpdated: graph.rowCount ?? 0,
      findingRefsUpdated: (findingBase.rowCount ?? 0) + (findingHead.rowCount ?? 0),
      preservedCommitEdges: preserved.rows[0]?.count ?? 0,
    };
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {});
    throw error;
  } finally {
    client.release();
  }
}
