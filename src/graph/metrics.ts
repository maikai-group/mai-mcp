// Showcase metrics (spec §3.5) — additive, read-only, no migration. Every
// reader is one project-scoped aggregate, never an N+1 query.
//
// lastTouched joins git evidence to the graph. The join is the whole difficulty:
// graph_nodes.file_path is ABSOLUTE
// ('<repo-root>/src/db.ts') while commit_files.path is
// REPO-RELATIVE ('src/db.ts'), so a naive equi-join returns zero rows. The CTE
// strips the LONGEST matching registered repo prefix — the same longest-prefix
// rule moduleLabel already applies at overview.ts:23 — which is what takes the
// coverage from 0/1,062 to 1,062/1,062 on mai-mcp-self.
//
// confidence is decision-only, deliberately (plan 29 D6): the `lessons` table
// carries no file or node column and there are zero memory_edges rows with
// from_kind or to_kind 'lesson' anywhere in the database, so there is nothing to
// read for the lesson half. Inventing one would be a migration.
import { getPool, loadProjectGraphRoots } from '../db.js';

export interface NodeMetrics {
  /** node id → ISO timestamp of the newest commit touching its file. */
  lastTouched: Map<string, string>;
  /** node id → max confidence of the decisions linked to it, 0..1. */
  confidence: Map<string, number>;
}

/** Every structural relation the graph currently emits has a deliberate
 * baseline. Unknown/future relations remain visible at 1 rather than 0. */
const RELATION_BASELINE: Record<string, number> = {
  calls: 3, invokes: 3, serves_route: 3, references_table: 3,
  fk_to: 3, secured_by: 3, scheduled_by: 3,
  imports: 2, depends_on: 2, extends: 2, inherits: 2, reads_env: 2,
  defines: 1, exports: 1,
};

export function effectiveEdgeStrength(
  relation: string,
  weight: number | null,
  linkedMemorySignal: number,
): number {
  if (relation === 'co_changed_with' && weight !== null && Number.isFinite(weight) && weight > 0) {
    return weight;
  }
  const baseline = RELATION_BASELINE[relation] ?? 1;
  const signal = Number.isFinite(linkedMemorySignal) ? Math.max(0, linkedMemorySignal) : 0;
  return baseline + signal;
}

interface EdgeStrengthRow {
  id: string;
  relation: string;
  weight: number | null;
  memory_signal: string | number | null;
}

interface LastTouchedRow { id: string; last_touched: Date | null }
interface ConfidenceRow { id: string; confidence: number | null }

/** Newest commit per node, via the node's repo-relative path **within its own
 * repo**. Empty map when the project has no registered repos or no commit
 * evidence.
 *
 * The `repo_path` equality on `code_commits` is load-bearing, not defensive.
 * Without it, two repos in one project that share a relative path (`src/index.ts`,
 * `README.md`) cross-contaminate. Cross-project joins can also contaminate
 * timestamps: measured multi-repo data showed 107 nodes in one repository and
 * 15 in another receiving a timestamp from the wrong repository, overstating
 * recency by up to 81 and 107 days, respectively (§0.1). Overstatement is the
 * dangerous direction because it makes a stale node pulse as recent. The
 * constraint costs zero coverage on every project measured. */
export async function readLastTouched(projectId: string, repos: readonly string[]): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  if (repos.length === 0) return out;
  const roots = await loadProjectGraphRoots(projectId);
  const aliasRows = [...roots.aliases.rawToPhysical.entries()];
  const rows = await getPool().query<LastTouchedRow>(
    `WITH repo(path) AS (SELECT unnest($2::text[])),
     alias(raw_path, physical_path) AS (SELECT * FROM unnest($3::text[], $4::text[])),
     rel AS (
       SELECT n.id, m.repo_path, m.rel_path
         FROM graph_nodes n
         CROSS JOIN LATERAL (
           SELECT r.path AS repo_path,
                  substring(n.file_path from length(r.path) + 2) AS rel_path
             FROM repo r
            WHERE starts_with(n.file_path, r.path || '/')
            ORDER BY length(r.path) DESC
            LIMIT 1
         ) m
        WHERE n.project_id = $1 AND n.file_path IS NOT NULL
     )
     SELECT rel.id, max(COALESCE(c.committed_at, c.timestamp)) AS last_touched
       FROM rel
       JOIN commit_files cf ON cf.project_id = $1 AND cf.path = rel.rel_path
       JOIN code_commits c ON c.id = cf.commit_id
        AND c.project_id = $1 AND c.project_id = cf.project_id
        AND EXISTS (
          SELECT 1 FROM alias a
          WHERE a.physical_path = rel.repo_path AND a.raw_path = c.repo_path
        )
        AND NOT EXISTS (
          SELECT 1 FROM git_history_rewrites rw
          WHERE rw.commit_id = c.id AND rw.new_hash IS NULL
        )
      GROUP BY rel.id`,
    [projectId, [...repos], aliasRows.map(([raw]) => raw), aliasRows.map(([, physical]) => physical)]
  );
  for (const r of rows.rows) {
    if (r.last_touched !== null) out.set(r.id, r.last_touched.toISOString());
  }
  return out;
}

/** Max confidence of the still-valid, non-retracted decisions linked to each node through
 * the first-class memory edge decision --affects--> graph_node. */
export async function readNodeConfidence(projectId: string): Promise<Map<string, number>> {
  const out = new Map<string, number>();
  const rows = await getPool().query<ConfidenceRow>(
    `SELECT me.to_id AS id, max(d.confidence) AS confidence
       FROM memory_edges me
       JOIN code_decisions d
         ON d.id = me.from_id AND d.project_id = me.project_id
        AND d.still_valid = true AND d.retracted_at IS NULL
      WHERE me.project_id = $1 AND me.from_kind = 'decision' AND me.to_kind = 'graph_node'
      GROUP BY me.to_id`,
    [projectId]
  );
  for (const r of rows.rows) {
    if (r.confidence !== null && Number.isFinite(r.confidence)) out.set(r.id, r.confidence);
  }
  return out;
}

/** Effective strength for every graph edge. Behavioral/co-change evidence uses
 * its measured graph_edges.weight. Structural relations use the exhaustive
 * baseline above, then add live citation + reinforcement telemetry for active
 * decisions/lessons linked to either endpoint. */
export async function readEdgeStrengths(projectId: string): Promise<Map<string, number>> {
  const out = new Map<string, number>();
  const rows = await getPool().query<EdgeStrengthRow>(
    `WITH linked_memory AS (
       SELECT DISTINCT me.to_id AS node_id, d.id AS memory_id,
              (d.cited_count + d.reinforcement_count)::bigint AS signal
         FROM memory_edges me
         JOIN code_decisions d ON d.id = me.from_id AND d.project_id = me.project_id
        WHERE me.project_id = $1
          AND me.from_kind = 'decision' AND me.to_kind = 'graph_node'
          AND d.still_valid = true AND d.retracted_at IS NULL
       UNION ALL
       SELECT DISTINCT me.to_id AS node_id, l.id AS memory_id,
              (l.cited_count + l.reinforcement_count)::bigint AS signal
         FROM memory_edges me
         JOIN lessons l ON l.id = me.from_id
          AND (l.project_id = me.project_id OR l.project_id IS NULL)
        WHERE me.project_id = $1
          AND me.from_kind = 'lesson' AND me.to_kind = 'graph_node'
          AND l.superseded_by IS NULL AND l.retired_at IS NULL
     ), node_signal AS (
       SELECT node_id, sum(signal)::bigint AS signal FROM linked_memory GROUP BY node_id
     )
     SELECT e.id, e.relation, e.weight,
            COALESCE(a.signal, 0) + COALESCE(b.signal, 0) AS memory_signal
       FROM graph_edges e
       LEFT JOIN node_signal a ON a.node_id = e.from_node
       LEFT JOIN node_signal b ON b.node_id = e.to_node
      WHERE e.project_id = $1`,
    [projectId]
  );
  for (const r of rows.rows) {
    out.set(r.id, effectiveEdgeStrength(r.relation, r.weight, Number(r.memory_signal ?? 0)));
  }
  return out;
}

export async function readNodeMetrics(projectId: string, repos: readonly string[]): Promise<NodeMetrics> {
  const [lastTouched, confidence] = await Promise.all([
    readLastTouched(projectId, repos),
    readNodeConfidence(projectId),
  ]);
  return { lastTouched, confidence };
}
