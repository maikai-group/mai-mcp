// mai-graph landing aggregation (spec §5): the module-level "constellation"
// that powers the dashboard's zoomed-out graph view. Groups every node into a
// module label (repo-basename + first path segment), counts kinds per module,
// weights inter-module links, and surfaces the top-degree nodes per module.
// Pinned like every other read (getProjectId(); surfaces may pass projectId).
import { getPool, getProjectId, loadProjectGraphRoots } from '../db.js';
import path from 'node:path';
import { readEdgeStrengths, readNodeMetrics } from './metrics.js';
import { readGraphFreshness, renderFreshnessBanner, type FreshnessBannerPayload } from './freshness.js';
import { owningRegisteredRepo } from './contracts.js';

export interface OverviewModule { label: string; nodeCount: number; kinds: Record<string, number> }
export interface OverviewLink { a: string; b: string; weight: number }
export interface OverviewTopNode {
  id: string; kind: string; name: string; module: string; degree: number;
  qualified_name: string | null; file_path: string | null; line: number | null;
  /** ISO timestamp of the newest commit touching this node's file; null when
   * the node has no file (db/glue kinds) or no git evidence. */
  lastTouched: string | null;
  /** Max confidence of the decisions linked to this node; null when unlinked. */
  confidence: number | null;
}
export interface GraphOverview {
  modules: OverviewModule[]; links: OverviewLink[];
  topNodes: OverviewTopNode[];
  topEdges: { source: string; target: string; relation: string; strength: number }[];
  freshness: FreshnessBannerPayload;
}

const TOP_N_PER_MODULE = 8;

function moduleLabel(filePath: string | null, repos: string[]): string {
  if (!filePath) return 'db schema';
  const repo = owningRegisteredRepo(filePath, repos);
  if (!repo) return 'other';
  const rel = path.relative(repo, filePath);
  const seg = rel.split(path.sep)[0] ?? '';
  const base = path.basename(repo);
  return seg && seg !== rel ? `${base}/${seg}` : base;
}

export async function graphOverview(projectId?: string): Promise<GraphOverview> {
  const pid = projectId ?? (await getProjectId());
  const db = getPool();
  const repos = (await loadProjectGraphRoots(pid)).repos;
  const freshness = renderFreshnessBanner(await readGraphFreshness(pid));
  const metrics = await readNodeMetrics(pid, repos);
  const edgeStrengths = await readEdgeStrengths(pid);
  const nodes = await db.query<{
    id: string; kind: string; name: string; qualified_name: string | null;
    file_path: string | null; line: number | null; degree: string;
  }>(
    `SELECT n.id, n.kind, n.name, n.qualified_name, n.file_path, n.line,
            (SELECT COUNT(*) FROM graph_edges e
              WHERE e.project_id = n.project_id AND (e.from_node = n.id OR e.to_node = n.id)) AS degree
     FROM graph_nodes n WHERE n.project_id = $1`,
    [pid]
  );
  const byModule = new Map<string, { count: number; kinds: Record<string, number>; top: OverviewTopNode[] }>();
  const moduleOf = new Map<string, string>();
  for (const n of nodes.rows) {
    const label = moduleLabel(n.file_path, repos);
    moduleOf.set(n.id, label);
    const m = byModule.get(label) ?? { count: 0, kinds: {}, top: [] };
    m.count++;
    m.kinds[n.kind] = (m.kinds[n.kind] ?? 0) + 1;
    m.top.push({
      id: n.id, kind: n.kind, name: n.name, module: label, degree: Number(n.degree),
      qualified_name: n.qualified_name, file_path: n.file_path, line: n.line,
      lastTouched: metrics.lastTouched.get(n.id) ?? null,
      confidence: metrics.confidence.get(n.id) ?? null,
    });
    byModule.set(label, m);
  }
  const topNodes: OverviewTopNode[] = [...byModule.values()].flatMap((m) =>
    m.top.sort((a, b) => b.degree - a.degree).slice(0, TOP_N_PER_MODULE)
  );
  const topIds = new Set(topNodes.map((n) => n.id));
  const edges = await db.query<{ id: string; from_node: string; to_node: string; relation: string }>(
    `SELECT id, from_node, to_node, relation FROM graph_edges WHERE project_id = $1`,
    [pid]
  );
  // Module labels can contain spaces ('db schema'), so key the link map on a
  // stable joined string but carry the [a, b] pair as the value — never recover
  // it by splitting the key, which would corrupt any link touching 'db schema'.
  const linkWeight = new Map<string, OverviewLink>();
  const topEdges: GraphOverview['topEdges'] = [];
  for (const e of edges.rows) {
    const ma = moduleOf.get(e.from_node); const mb = moduleOf.get(e.to_node);
    if (ma && mb && ma !== mb) {
      const [a, b] = ma < mb ? [ma, mb] : [mb, ma];
      const key = `${a}\n${b}`;
      const existing = linkWeight.get(key);
      if (existing) existing.weight++;
      else linkWeight.set(key, { a, b, weight: 1 });
    }
    if (topIds.has(e.from_node) && topIds.has(e.to_node)) {
      topEdges.push({
        source: e.from_node, target: e.to_node, relation: e.relation,
        strength: edgeStrengths.get(e.id) ?? 1,
      });
    }
  }
  return {
    modules: [...byModule.entries()].map(([label, m]) => ({ label, nodeCount: m.count, kinds: m.kinds })),
    links: [...linkWeight.values()],
    topNodes, topEdges, freshness,
  };
}
