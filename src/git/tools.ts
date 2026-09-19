// The three question-oriented git tools (spec §4). Read-only, bounded,
// project-pinned via getProjectId. DB answers the indexed questions; live git
// is touched only for worktree state and on-demand patch hydration — patch
// bytes are never persisted.
import { getPool, getProjectId, getProjectRepos, loadProjectGraphRoots } from '../db.js';
import { commitExists, showPatch, worktreeSummary } from './repo.js';

const CONTEXT_DEFAULT_LIMIT = 10;
const CONTEXT_MAX_LIMIT = 30;
const TRACE_COMMIT_CAP = 20;

interface CommitSummaryRow {
  id: string;
  commit_hash: string;
  message: string;
  committed_at: string | null;
  ts: string;
  author: string | null;
  repo_path: string | null;
  files: string[];
  additions: number | null;
  deletions: number | null;
  decisions: string[];
  old_hashes: string[];
  history_pruned: boolean;
}

/**
 * Commit summary with pre-aggregated LATERALs. The obvious double LEFT JOIN
 * (commit_files × memory_edges) cross-multiplies rows and inflates the SUMs by
 * the edge count — ×2/×3 on real decision-linked commits (review finding, 7d).
 * LATERAL subqueries aggregate each side independently; no GROUP BY needed.
 * extraCols lets gitShow pull body/parents/branch without string surgery.
 */
function commitSummarySelect(extraCols = ''): string {
  return `
  SELECT c.id, c.commit_hash, c.message, c.committed_at::text, c.timestamp::text AS ts,
         c.author, c.repo_path,${extraCols}
         COALESCE(cf.files, '{}') AS files, cf.additions, cf.deletions,
         COALESCE(e.decisions, '{}') AS decisions,
         COALESCE(hr.old_hashes, '{}') AS old_hashes,
         COALESCE(hr.history_pruned, false) AS history_pruned
  FROM code_commits c
  LEFT JOIN LATERAL (
    SELECT array_agg(path ORDER BY path) AS files,
           SUM(additions)::int AS additions, SUM(deletions)::int AS deletions
    FROM commit_files WHERE commit_id = c.id
  ) cf ON true
  LEFT JOIN LATERAL (
    SELECT array_agg(DISTINCT substr(from_id::text, 1, 8)) AS decisions
    FROM memory_edges
    WHERE to_kind = 'commit' AND to_id = c.id
      AND relation = 'implemented_by' AND from_kind = 'decision'
  ) e ON true
  LEFT JOIN LATERAL (
    SELECT array_agg(old_hash ORDER BY old_hash) AS old_hashes,
           bool_or(new_hash IS NULL) AS history_pruned
    FROM git_history_rewrites WHERE commit_id = c.id
  ) hr ON true`;
}

function fmtCommit(r: CommitSummaryRow): string {
  const when = (r.committed_at ?? r.ts).slice(0, 16).replace('T', ' ');
  const stats = r.additions !== null ? ` (+${r.additions}/-${r.deletions ?? 0})` : '';
  const files = r.files.length > 0 ? ` — ${r.files.length} file(s): ${r.files.slice(0, 5).join(', ')}${r.files.length > 5 ? ', …' : ''}` : '';
  const dec = r.decisions.length > 0 ? ` ← implements decision ${r.decisions.join(', ')}` : '';
  const rewrite = r.history_pruned ? ' [pruned by recorded history rewrite]' : '';
  return `- ${r.commit_hash.slice(0, 8)} ${when} ${r.message}${rewrite}${stats}${files}${dec}`;
}

/** One-call task context: branch + worktree + relevant recent commits + links. */
export async function gitContext(args: { task?: string; paths?: string[]; limit?: number }): Promise<string> {
  const pool = getPool();
  const projectId = await getProjectId();
  const repos = await getProjectRepos(projectId);
  const limit = Math.min(Math.max(args.limit ?? CONTEXT_DEFAULT_LIMIT, 1), CONTEXT_MAX_LIMIT);

  const lines: string[] = ['# git context', ''];
  for (const repo of repos) {
    try {
      const w = await worktreeSummary(repo);
      lines.push(
        `repo ${repo} — branch ${w.branch}: ${w.staged} staged, ${w.unstaged} unstaged, ${w.untracked} untracked` +
          (w.topPaths.length > 0 ? ` (top: ${w.topPaths.slice(0, 5).join(', ')})` : '')
      );
    } catch {
      lines.push(`repo ${repo} — worktree unreadable (not a git repo here?)`);
    }
  }

  const where: string[] = ['c.project_id = $1'];
  const params: unknown[] = [projectId];
  if (args.paths && args.paths.length > 0) {
    params.push(args.paths.map((p) => p + '%'));
    where.push(`EXISTS (SELECT 1 FROM commit_files x WHERE x.commit_id = c.id AND x.path LIKE ANY($${params.length}))`);
  }
  if (args.task && args.task.trim()) {
    params.push(
      args.task
        .split(/\s+/)
        .filter((w2) => w2.length > 2)
        .map((w2) => `%${w2}%`)
    );
    where.push(`(c.message ILIKE ANY($${params.length}) OR c.body ILIKE ANY($${params.length}))`);
  }
  where.push(`NOT EXISTS (
    SELECT 1 FROM git_history_rewrites r
    WHERE r.commit_id = c.id AND r.new_hash IS NULL
  )`);
  params.push(limit);
  const commits = await pool.query<CommitSummaryRow>(
    `${commitSummarySelect()}
     WHERE ${where.join(' AND ')}
     ORDER BY COALESCE(c.committed_at, c.timestamp) DESC
     LIMIT $${params.length}`,
    params
  );
  lines.push('', `## recent commits${args.paths?.length ? ' (path-filtered)' : ''}${args.task ? ' (task-filtered)' : ''}`);
  lines.push(...(commits.rows.length > 0 ? commits.rows.map(fmtCommit) : ['(none match)']));
  return lines.join('\n');
}

/** Commit metadata + stats from the index; live-hydrated patch on request. */
export async function gitShow(args: { hash: string; patch?: boolean; paths?: string[] }): Promise<string> {
  const pool = getPool();
  const projectId = await getProjectId();
  const hash = args.hash.trim();
  if (!/^[0-9a-f]{7,40}$/i.test(hash)) throw new Error(`'${args.hash}' is not a commit hash (7-40 hex chars).`);

  const rows = await pool.query<CommitSummaryRow & { body: string | null; parents: string[]; branch_observed: string | null }>(
    `${commitSummarySelect(' c.body, c.parents, c.branch_observed,')}
     WHERE c.project_id = $1 AND (
       c.commit_hash LIKE $2 OR EXISTS (
         SELECT 1 FROM git_history_rewrites r
         WHERE r.commit_id = c.id AND r.old_hash LIKE $2
       )
     )
     LIMIT 5`,
    [projectId, hash + '%']
  );
  if (rows.rows.length === 0) return `No indexed commit matching '${hash}' in this project (run sync-commits?).`;
  if (rows.rows.length > 1) {
    return `Ambiguous prefix '${hash}' — matches: ${rows.rows.map((r) => r.commit_hash.slice(0, 12)).join(', ')}`;
  }
  const c = rows.rows[0];

  const lines = [
    `# ${c.commit_hash}`,
    ...(c.history_pruned
      ? ['history rewrite: this commit was intentionally pruned; indexed metadata and UUID links are retained']
      : c.old_hashes.length > 0
        ? [`history rewrite aliases: ${c.old_hashes.join(', ')}`]
        : []),
    `author: ${c.author ?? 'unknown'}  authored: ${c.ts}  committed: ${c.committed_at ?? 'unknown'}`,
    `parents: ${c.parents.length > 0 ? c.parents.map((p) => p.slice(0, 8)).join(', ') : '(root)'}${c.parents.length > 1 ? ' [merge]' : ''}`,
    `first seen on branch: ${c.branch_observed ?? 'unknown'} (observation, not identity)`,
    '',
    c.message,
    ...(c.body ? ['', c.body] : []),
    '',
    `## files (${c.files.length})`,
    ...c.files.map((f) => `- ${f}`),
    ...(c.decisions.length > 0 ? ['', `implements decision(s): ${c.decisions.join(', ')}`] : []),
  ];

  if (args.patch) {
    if (c.history_pruned) {
      lines.push(
        '',
        '## patch',
        'This commit was pruned because its complete diff was removed by the recorded history rewrite; indexed metadata is retained for provenance.'
      );
      return lines.join('\n');
    }
    const roots = await loadProjectGraphRoots(projectId);
    const evidenceRepo = c.repo_path === null ? null : roots.aliases.rawToPhysical.get(c.repo_path) ?? null;
    const repos = evidenceRepo
      ? [evidenceRepo, ...roots.repos.filter((repo) => repo !== evidenceRepo)]
      : roots.repos;
    let hydrated = false;
    for (const repo of repos) {
      if (await commitExists(repo, c.commit_hash)) {
        const patch = await showPatch(repo, c.commit_hash, args.paths);
        lines.push('', '## patch (live from git — bounded, not stored)', patch || '(empty diff)');
        hydrated = true;
        break;
      }
    }
    if (!hydrated) {
      lines.push('', '## patch', `Commit ${c.commit_hash.slice(0, 12)} is no longer reachable in any registered repo (rebased away or GC'd). The indexed metadata above is what survives.`);
    }
  }
  return lines.join('\n');
}

/** Decision → session → commits → files (+ graph nodes): the lineage story. */
export async function gitTraceDecision(args: { decision_id: string }): Promise<string> {
  const pool = getPool();
  const projectId = await getProjectId();

  const d = await pool.query<{
    id: string; description: string; source: string; timestamp: string; session_id: string | null;
  }>(
    `SELECT id, description, source, timestamp::text, session_id
     FROM code_decisions WHERE id = $1 AND project_id = $2`,
    [args.decision_id, projectId]
  );
  if (d.rows.length === 0) return `No decision ${args.decision_id} in this project.`;
  const dec = d.rows[0];

  const lines = [
    `# trace: decision ${dec.id.slice(0, 8)}`,
    `${dec.description}`,
    `source: ${dec.source} — ${dec.timestamp}`,
    '',
  ];

  const session = await pool.query<{ id: string; original_session_id: string | null; started_at: string; summary: string | null }>(
    dec.session_id
      ? `SELECT id, original_session_id, started_at::text, summary FROM code_sessions WHERE id = $1`
      : `SELECT id, original_session_id, started_at::text, summary FROM code_sessions
         WHERE project_id = $2 AND started_at <= $1::timestamptz
           AND COALESCE(ended_at, started_at + INTERVAL '6 hours') >= $1::timestamptz
         ORDER BY started_at DESC LIMIT 1`,
    dec.session_id ? [dec.session_id] : [dec.timestamp, projectId]
  );
  if (session.rows.length > 0) {
    const s = session.rows[0];
    lines.push(`## session ${s.original_session_id ?? s.id.slice(0, 8)} (${s.started_at.slice(0, 16)})`);
    if (s.summary) lines.push(s.summary.split('\n')[0]);
    lines.push('');
  } else {
    lines.push('## session: none resolvable (no session_id and no timestamp-containing session)', '');
  }

  const commits = await pool.query<CommitSummaryRow>(
    `${commitSummarySelect()}
     WHERE c.project_id = $1 AND c.id IN (
       SELECT to_id FROM memory_edges
       WHERE project_id = $1 AND from_kind = 'decision' AND from_id = $2
         AND to_kind = 'commit' AND relation = 'implemented_by')
     ORDER BY COALESCE(c.committed_at, c.timestamp) ASC
     LIMIT ${TRACE_COMMIT_CAP}`,
    [projectId, dec.id]
  );
  lines.push(`## implementing commits (${commits.rows.length}${commits.rows.length === TRACE_COMMIT_CAP ? '+, capped' : ''})`);
  if (commits.rows.length === 0) {
    lines.push('(no linked commits — links are provenance-gated; add one explicitly with mai_link decision→commit implemented_by)');
  } else {
    lines.push(...commits.rows.map(fmtCommit));
    const allPaths = Array.from(new Set(commits.rows.flatMap((c) => c.files))).slice(0, 20);
    if (allPaths.length > 0) {
      const nodes = await pool.query<{ id: string; kind: string; name: string; file_path: string | null }>(
        `SELECT id, kind, name, file_path FROM graph_nodes
         WHERE project_id = $1 AND file_path IS NOT NULL AND file_path LIKE ANY($2)
         LIMIT 30`,
        [projectId, allPaths.map((p) => '%' + p)]
      );
      if (nodes.rows.length > 0) {
        lines.push('', '## graph nodes touched');
        lines.push(...nodes.rows.slice(0, 15).map((n) => `- [${n.kind}] ${n.name} — ${n.file_path} (${n.id.slice(0, 8)})`));
      }
    }
  }
  return lines.join('\n');
}
