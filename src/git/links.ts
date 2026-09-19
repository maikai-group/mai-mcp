// Decision↔commit auto-linker. Every link carries provenance: confidence
// 'inferred' — agents must be able to distrust machine guesses (spec §3.3-3.4,
// the quarantine lesson applied to links). Idempotent via the memory_edges
// unique constraint. Never links across projects.
import { getPool } from '../db.js';

const WINDOW_DAYS = 14;
const SESSION_BUFFER_MS = 30 * 60 * 1000;
const SMALL_SESSION_COMMITS = 3;

interface DecisionRow {
  id: string;
  session_id: string | null;
  timestamp: string;
  files_affected: string[] | null;
}

interface SessionRow {
  id: string;
  started_at: string;
  ended_at: string | null;
}

interface CommitRow {
  id: string;
  committed_at: string | null;
  timestamp: string;
  paths: string[];
}

function pathsOverlap(filesAffected: string[], commitPaths: string[]): boolean {
  // Slash-boundary matches only — bare endsWith matched "foo/bar.ts" vs
  // "ar.ts" (review finding).
  return filesAffected.some((f) =>
    commitPaths.some((p) => p === f || p.endsWith('/' + f) || f.endsWith('/' + p))
  );
}

/** Link recent decisions to their implementing commits. Returns a summary line. */
export async function autoLinkDecisions(projectId: string): Promise<string> {
  const pool = getPool();
  const decisions = await pool.query<DecisionRow>(
    `SELECT id, session_id, timestamp::text, files_affected
     FROM code_decisions
     WHERE project_id = $1 AND retracted_at IS NULL
       AND timestamp > NOW() - INTERVAL '${WINDOW_DAYS} days'`,
    [projectId]
  );

  let linked = 0;
  for (const d of decisions.rows) {
    // Resolve the decision's session: direct id, else timestamp containment
    // (mai_remember decisions carry no session_id — spec §3.4).
    let session: SessionRow | undefined;
    if (d.session_id) {
      const r = await pool.query<SessionRow>(
        `SELECT id, started_at::text, ended_at::text FROM code_sessions WHERE id = $1 AND project_id = $2`,
        [d.session_id, projectId]
      );
      session = r.rows[0];
    } else {
      const r = await pool.query<SessionRow>(
        `SELECT id, started_at::text, ended_at::text FROM code_sessions
         WHERE project_id = $1 AND started_at <= $2::timestamptz
           AND COALESCE(ended_at, started_at + INTERVAL '6 hours') >= $2::timestamptz
         ORDER BY started_at DESC LIMIT 1`,
        [projectId, d.timestamp]
      );
      session = r.rows[0];
    }
    if (!session) continue;

    const windowEnd = new Date(
      new Date(session.ended_at ?? session.started_at).getTime() + SESSION_BUFFER_MS
    ).toISOString();
    const commits = await pool.query<CommitRow>(
      `SELECT c.id, c.committed_at::text, c.timestamp::text,
              COALESCE(array_agg(cf.path) FILTER (WHERE cf.path IS NOT NULL), '{}') AS paths
       FROM code_commits c
       LEFT JOIN commit_files cf ON cf.commit_id = c.id
       WHERE c.project_id = $1
         AND NOT EXISTS (
           SELECT 1 FROM git_history_rewrites r
           WHERE r.commit_id = c.id AND r.new_hash IS NULL
         )
         AND COALESCE(c.committed_at, c.timestamp) >= $2::timestamptz
         AND COALESCE(c.committed_at, c.timestamp) <= $3::timestamptz
       GROUP BY c.id`,
      [projectId, session.started_at, windowEnd]
    );

    const smallSession = commits.rows.length > 0 && commits.rows.length <= SMALL_SESSION_COMMITS;
    for (const c of commits.rows) {
      const overlap =
        d.files_affected && d.files_affected.length > 0 && pathsOverlap(d.files_affected, c.paths);
      if (!overlap && !smallSession) continue;
      const note = overlap ? 'auto-linked: session window + file overlap' : 'auto-linked: session window (small session)';
      const res = await pool.query(
        `INSERT INTO memory_edges (project_id, from_kind, from_id, to_kind, to_id, relation, note, confidence)
         VALUES ($1, 'decision', $2, 'commit', $3, 'implemented_by', $4, 'inferred')
         ON CONFLICT (from_kind, from_id, to_kind, to_id, relation) DO NOTHING`,
        [projectId, d.id, c.id, note]
      );
      if (res.rowCount && res.rowCount > 0) linked++;
    }
  }
  return `auto-linker: ${decisions.rows.length} recent decision(s) examined, ${linked} new link(s)`;
}
