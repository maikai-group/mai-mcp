// Whole-graph payload for the hero render (spec 2026-08-31-graph-hero-render-design.md).
//
// graphOverview already runs BOTH of these queries (overview.ts:49-58, 79-82) and
// then aggregates the result into modules, returning TOP_N_PER_MODULE = 8 nodes
// per module. This module runs the same reads and skips the aggregation.
//
// It does NOT replace the overview: exploration wants a summary, the hero view
// wants the graph. Two questions, two budgets, one storage layer.
import { getPool, getProjectId, loadProjectGraphRoots } from '../db.js';
import { readEdgeStrengths, readNodeMetrics } from './metrics.js';

/** Identical to lib/types.ts OverviewTopNode minus `module`, which is a
 * summary-only concept. Kept field-for-field so the frontend mapper for hero
 * mode is a sibling of overviewToElements, not a different shape. */
export interface FullNode {
  id: string;
  kind: string;
  name: string;
  degree: number;
  qualified_name: string | null;
  file_path: string | null;
  line: number | null;
  /** Required by ZNode (model.ts:247-252) — without these the time and
   * confidence Z-modes grey out in hero mode, which is exactly the view that
   * most needs them. */
  lastTouched: string | null;
  confidence: number | null;
  /** 1 for the top-degree slice, so labelPolicy (model.ts:67-70) labels hubs and
   * nothing else at hero density. No second label rule (R4). */
  isLanding: 0 | 1;
}

export interface FullEdge {
  source: string;
  target: string;
  relation: string;
  strength: number;
}

export interface GraphFull {
  nodes: FullNode[];
  edges: FullEdge[];
  /** Explicit, never silent: a truncated graph that looks complete is the
   * failure mode this field exists to prevent. */
  truncated: {
    nodes: boolean;
    edges: boolean;
    /** Totals BEFORE the cap, so the UI can say what it is not showing. */
    nodeTotal: number;
    edgeTotal: number;
  };
}

export const MAX_HERO_NODES = 25_000;
export const MAX_HERO_EDGES = 60_000;
/** How many top-degree nodes carry a label at hero density. */
export const HERO_LANDING_COUNT = 64;

/** Injectable cap seam, declared WITH the function that reads it. Task 2's cap
 * assertions drive it with tiny values so no test seeds 25,000 rows; production
 * callers never pass it, and a Task 2 assertion pins the defaults to the
 * exported constants so this seam cannot silently change what production uses. */
export interface GraphFullLimits {
  nodes: number;
  edges: number;
}

export async function graphFull(
  projectId?: string,
  limits: GraphFullLimits = { nodes: MAX_HERO_NODES, edges: MAX_HERO_EDGES },
): Promise<GraphFull> {
  const pid = projectId ?? (await getProjectId());
  const db = getPool();
  const repos = (await loadProjectGraphRoots(pid)).repos;
  const metrics = await readNodeMetrics(pid, repos);
  const edgeStrengths = await readEdgeStrengths(pid);

  // Highest-degree first so the cap keeps the structurally important nodes
  // rather than an arbitrary slice, and so the landing set is the first N rows.
  const nodeRows = await db.query<{
    id: string; kind: string; name: string; qualified_name: string | null;
    file_path: string | null; line: number | null; degree: string; total: string;
  }>(
    `SELECT n.id, n.kind, n.name, n.qualified_name, n.file_path, n.line,
            (SELECT COUNT(*) FROM graph_edges e
              WHERE e.project_id = n.project_id AND (e.from_node = n.id OR e.to_node = n.id)) AS degree,
            COUNT(*) OVER () AS total
       FROM graph_nodes n
      WHERE n.project_id = $1
      ORDER BY degree DESC, n.id
      LIMIT $2`,
    [pid, limits.nodes]
  );

  const nodeTotal = Number(nodeRows.rows[0]?.total ?? '0');
  const nodes: FullNode[] = nodeRows.rows.map((n, index) => ({
    id: n.id,
    kind: n.kind,
    name: n.name,
    degree: Number(n.degree),
    qualified_name: n.qualified_name,
    file_path: n.file_path,
    line: n.line,
    lastTouched: metrics.lastTouched.get(n.id) ?? null,
    confidence: metrics.confidence.get(n.id) ?? null,
    isLanding: index < HERO_LANDING_COUNT ? 1 : 0,
  }));

  // Only edges whose BOTH endpoints survived the node cap — a dangling edge
  // would be dropped by the renderer anyway, and counting it would inflate the
  // reported edge total into a number the view never draws.
  const kept = new Set(nodes.map((n) => n.id));
  // The project's TRUE edge total, counted separately.
  //
  // COUNT(*) OVER () cannot do this job: window functions run AFTER WHERE, so a
  // window count inside the filtered query would report edges that survived the
  // endpoint filter, not the project's edges — and `truncated.edges` would then
  // read false precisely when the node cap had silently dropped edges, which is
  // the silence R1 exists to prevent.
  const edgeTotalRow = await db.query<{ total: string }>(
    `SELECT COUNT(*)::text AS total FROM graph_edges WHERE project_id = $1`,
    [pid]
  );
  const edgeTotal = Number(edgeTotalRow.rows[0]?.total ?? '0');

  // The cap is applied in SQL, not after the fact: on a large project the
  // unbounded form materialises every edge row into Node before discarding most
  // of them. `kept` is passed down so the endpoint filter and the LIMIT act in
  // one pass.
  const edgeRows = await db.query<{
    id: string; from_node: string; to_node: string; relation: string;
  }>(
    `SELECT id, from_node, to_node, relation
       FROM graph_edges
      WHERE project_id = $1
        AND from_node = ANY($2::uuid[]) AND to_node = ANY($2::uuid[])
      -- Deterministic under the cap: without an ORDER BY, WHICH edges survive a
      -- truncating LIMIT is up to the planner, so the same project could render
      -- a different graph run to run and the cap tests would be flaky.
      ORDER BY id
      LIMIT $3`,
    [pid, [...kept], limits.edges]
  );
  const edges: FullEdge[] = [];
  for (const e of edgeRows.rows) {
    edges.push({
      source: e.from_node,
      target: e.to_node,
      relation: e.relation,
      strength: edgeStrengths.get(e.id) ?? 1,
    });
  }

  return {
    nodes,
    edges,
    truncated: {
      nodes: nodeTotal > nodes.length,
      // True whenever the drawn set is smaller than the project's, for EITHER
      // reason — the edge cap biting, or the node cap having dropped an
      // endpoint. Both are "you are not seeing all of it", and conflating only
      // the first with truncation is how a partial graph looks complete.
      edges: edgeTotal > edges.length,
      nodeTotal,
      edgeTotal,
    },
  };
}
