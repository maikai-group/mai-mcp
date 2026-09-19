// mai-graph read-only query surface (spec §5): graphFind + graphNeighbors.
// Pinned exactly like every other read (getProjectId(); surfaces may pass an
// explicit projectId). No write-gate — these tools don't write.
import { getPool, getProjectId, getProjectRepos, loadProjectGraphRoots } from '../db.js';
import { readEdgeStrengths, readNodeMetrics } from './metrics.js';
import { readDbSchemaState, renderDbSchemaSection } from './freshness.js';
import { assessNodeStaleness, repoStaleness, type NodeStalenessInput } from './staleness.js';
import { SourceEvidence } from './source-evidence.js';
import { headlineField, MCP_READ_NARROWING, type ReadBudget } from '../read-budget.js';
import {
  GRAPH_QUERY_EDGE_CAP, GRAPH_QUERY_SEED_CAP, normalizeGraphDeadCode, normalizeGraphQuery,
  type NormalizedGraphQuery, type NormalizedGraphQueryStep,
} from './query-language.js';
import {
  DEAD_CODE_COVERAGE, DEAD_CODE_ROOT_KINDS, ROOT_RELATIONS, USE_RELATIONS, deadCodeCoverage,
} from './coverage.js';
import { owningRegisteredRepo } from './contracts.js';
import { classifyImpactRisk } from './risk.js';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

interface FoundNode {
  id: string;
  kind: string;
  name: string;
  qualified_name: string | null;
  file_path: string | null;
  line: number | null;
  score: number;
}

export async function graphFindRows(args: {
  query: string;
  kind?: string;
  limit?: number;
  projectId?: string;
}): Promise<FoundNode[]> {
  const projectId = args.projectId ?? (await getProjectId());
  const limit = Math.max(1, Math.min(args.limit ?? 20, 50));
  const r = await getPool().query<FoundNode>(
    `SELECT id, kind, name, qualified_name, file_path, line,
            GREATEST(similarity(name, $2), similarity(COALESCE(qualified_name, ''), $2)) AS score
     FROM graph_nodes
     WHERE project_id = $1
       AND ($3::text IS NULL OR kind = $3)
       AND (name % $2 OR name ILIKE '%' || $2 || '%' OR COALESCE(qualified_name, '') ILIKE '%' || $2 || '%')
     ORDER BY score DESC, kind, name
     LIMIT $4`,
    [projectId, args.query, args.kind ?? null, limit]
  );
  return r.rows;
}

// Function words + generic dev verbs that add no signal when matching a task
// description against node identifiers. Kept small on purpose — ranking by hit
// count handles the rest, so we only strip words that would never be a useful
// node-name substring.
const TASK_STOPWORDS = new Set([
  'the', 'and', 'for', 'with', 'this', 'that', 'from', 'into', 'your', 'you', 'our', 'its',
  'was', 'are', 'has', 'had', 'not', 'but', 'all', 'any', 'can', 'out', 'via', 'per', 'off',
  'add', 'use', 'fix', 'get', 'set', 'new', 'run', 'let', 'how', 'why', 'when', 'make', 'need',
  'want', 'should', 'would', 'could', 'then', 'than', 'also', 'only', 'just', 'work', 'flow',
]);

/** Split a task description into searchable tokens: lowercase, ≥3 chars, no
 * stopwords, deduped, capped. Exported for tests. */
export function tokenizeTask(text: string): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const raw of text.toLowerCase().split(/[^a-z0-9]+/)) {
    if (raw.length < 3 || TASK_STOPWORDS.has(raw) || seen.has(raw)) continue;
    seen.add(raw);
    out.push(raw);
    if (out.length >= 10) break;
  }
  return out;
}

/** Task-relevant node lookup for prime: tokenizes the task description and
 * ranks nodes by how many distinct task-words their name/qualified_name
 * contains. Unlike graphFindRows (single-term, for `mai graph find`), this
 * matches a whole sentence — feeding the raw sentence to an ILIKE/trigram
 * match surfaces nothing because no node name contains the full phrase. */
export async function graphFindForTask(args: {
  task: string;
  limit?: number;
  projectId?: string;
}): Promise<FoundNode[]> {
  const tokens = tokenizeTask(args.task);
  if (tokens.length === 0) return [];
  const projectId = args.projectId ?? (await getProjectId());
  const limit = Math.max(1, Math.min(args.limit ?? 5, 50));
  const r = await getPool().query<FoundNode>(
    `SELECT id, kind, name, qualified_name, file_path, line,
            (SELECT count(*) FROM unnest($2::text[]) tok
               WHERE name ILIKE '%' || tok || '%' OR COALESCE(qualified_name, '') ILIKE '%' || tok || '%')::float AS score
     FROM graph_nodes
     WHERE project_id = $1
       AND EXISTS (SELECT 1 FROM unnest($2::text[]) tok
                   WHERE name ILIKE '%' || tok || '%' OR COALESCE(qualified_name, '') ILIKE '%' || tok || '%')
     ORDER BY score DESC,
              CASE kind WHEN 'column' THEN 2 WHEN 'file' THEN 1 ELSE 0 END,
              kind, name
     LIMIT $3`,
    [projectId, tokens, limit]
  );
  return r.rows;
}

/** ` — file:line` when the node has a location, '' otherwise. One source for
 * every renderer (find / neighbors / impact) so the format cannot drift. */
function nodeLoc(n: { file_path: string | null; line: number | null }): string {
  return n.file_path ? ` — ${n.file_path}${n.line ? `:${n.line}` : ''}` : '';
}

export async function graphFind(args: {
  query: string;
  kind?: string;
  limit?: number;
  projectId?: string;
}): Promise<string> {
  const projectId = args.projectId ?? (await getProjectId());
  const rows = await graphFindRows({ ...args, projectId });
  const kindClause = args.kind ? ` (kind=${args.kind})` : '';
  if (rows.length === 0) {
    // B3 — one COUNT(*) decides never-built from built-but-no-match. Telling an
    // agent to build a graph that already holds thousands of nodes is the same
    // species of dishonesty as reporting one number for two axes.
    const c = await getPool().query<{ n: string }>(
      `SELECT COUNT(*)::text AS n FROM graph_nodes WHERE project_id = $1`,
      [projectId]
    );
    const total = Number(c.rows[0].n);
    if (total === 0) {
      return `No graph nodes match '${args.query}'${kindClause}. The graph has never been built for this project — run: mai graph build --project <slug>`;
    }
    return `No graph nodes match '${args.query}'${kindClause}. ${total} nodes in the graph, none match — try a shorter fragment${args.kind ? ` or drop kind=${args.kind}` : ''}.`;
  }
  // B1 — one line per hit. qualified_name is `repo/path#name`, so the separate
  // bolded name was duplicate text; the id stays verbatim because it is the
  // input to every other mai_graph_* tool.
  const lines = [`# Graph nodes matching '${args.query}'`, ''];
  for (const n of rows) {
    lines.push(`- [${n.kind}] ${n.qualified_name ?? n.name}${nodeLoc(n)} · ${n.id}`);
  }
  lines.push('', 'Pass an id to mai_graph_neighbors to explore connections.');
  return lines.join('\n');
}

interface EdgeRow {
  id: string;
  from_node: string;
  to_node: string;
  relation: string;
  confidence: string;
}
interface NodeRow {
  id: string;
  kind: string;
  name: string;
  qualified_name: string | null;
  file_path: string | null;
  line: number | null;
  degree: string;
  /** Provenance kept for wave-2 risk evidence; no existing renderer reads it. */
  commit_sha: string | null;
  content_hash: string | null;
  extracted_by: string | null;
}

interface Neighborhood {
  center: NodeRow;
  nodes: NodeRow[];
  edges: EdgeRow[];
  capped: boolean;
}

const EDGE_CAP = 100;

async function collectNeighborhood(
  projectId: string,
  nodeId: string,
  depth: number,
  relation: string | undefined,
  direction: 'both' | 'incoming'
): Promise<Neighborhood | null> {
  const pool = getPool();
  const center = await pool.query<NodeRow>(
    `SELECT n.id, n.kind, n.name, n.qualified_name, n.file_path, n.line,
            n.commit_sha, n.extracted_by, n.content_hash,
            (SELECT COUNT(*) FROM graph_edges d
              WHERE d.project_id = n.project_id
                AND (d.from_node = n.id OR d.to_node = n.id)) AS degree
       FROM graph_nodes n WHERE n.id = $1 AND n.project_id = $2`,
    [nodeId, projectId]
  );
  if (center.rows.length === 0) return null;

  const visited = new Set<string>([nodeId]);
  const seenEdges = new Set<string>();
  const collected: EdgeRow[] = [];
  let frontier = [nodeId];

  for (let d = 0; d < depth && frontier.length > 0 && collected.length < EDGE_CAP; d++) {
    const where =
      direction === 'incoming' ? `e.to_node = ANY($2)` : `(e.from_node = ANY($2) OR e.to_node = ANY($2))`;
    const r = await pool.query<EdgeRow>(
      `SELECT id, from_node, to_node, relation, confidence FROM graph_edges e
       WHERE e.project_id = $1 AND ${where} AND ($3::text IS NULL OR relation = $3)
       LIMIT $4`,
      [projectId, frontier, relation ?? null, EDGE_CAP + 1]
    );
    const next: string[] = [];
    for (const e of r.rows) {
      if (seenEdges.has(e.id) || collected.length >= EDGE_CAP) continue;
      seenEdges.add(e.id);
      collected.push(e);
      const candidates = direction === 'incoming' ? [e.from_node] : [e.from_node, e.to_node];
      for (const nid of candidates) {
        if (!visited.has(nid)) {
          visited.add(nid);
          next.push(nid);
        }
      }
    }
    frontier = next;
  }

  const nodeRows = await pool.query<NodeRow>(
    `SELECT n.id, n.kind, n.name, n.qualified_name, n.file_path, n.line,
            n.commit_sha, n.extracted_by, n.content_hash,
            (SELECT COUNT(*) FROM graph_edges d
              WHERE d.project_id = n.project_id
                AND (d.from_node = n.id OR d.to_node = n.id)) AS degree
       FROM graph_nodes n WHERE n.project_id = $1 AND n.id = ANY($2)`,
    [projectId, [...visited]]
  );
  return { center: center.rows[0], nodes: nodeRows.rows, edges: collected, capped: collected.length >= EDGE_CAP };
}

export async function graphNeighbors(args: {
  nodeId: string;
  depth?: number;
  relation?: string;
  projectId?: string;
}): Promise<string> {
  if (!UUID_RE.test(args.nodeId)) {
    return `'${args.nodeId}' is not a node id (UUID). Get ids from mai_graph_find.`;
  }
  const projectId = args.projectId ?? (await getProjectId());
  const depth = Math.max(1, Math.min(args.depth ?? 1, 3));
  const hood = await collectNeighborhood(projectId, args.nodeId, depth, args.relation, 'both');
  if (!hood) return `Graph node ${args.nodeId} not found in this project.`;
  const label = new Map(hood.nodes.map((n) => [n.id, `[${n.kind}] ${n.qualified_name ?? n.name}`]));
  const centerLabel = `[${hood.center.kind}] ${hood.center.qualified_name ?? hood.center.name}`;
  if (hood.edges.length === 0) {
    return `No edges touch ${centerLabel}${args.relation ? ` with relation '${args.relation}'` : ''}.`;
  }
  const lines = [`# Neighborhood of ${centerLabel} (depth ${depth})`, '', '## Nodes', ''];
  for (const n of hood.nodes) {
    lines.push(`- ${label.get(n.id) ?? n.id}${nodeLoc(n)} · ${n.id}`);
  }
  lines.push('', '## Edges', '');
  for (const e of hood.edges) {
    const conf = e.confidence === 'extracted' ? '' : ` (${e.confidence})`;
    lines.push(`- ${label.get(e.from_node) ?? e.from_node} —${e.relation}→ ${label.get(e.to_node) ?? e.to_node}${conf}`);
  }
  if (hood.capped) lines.push('', `(capped at ${EDGE_CAP} edges — narrow with relation= or a lower depth)`);
  return lines.join('\n');
}

export interface GraphJsonNode {
  id: string; kind: string; name: string;
  qualified_name: string | null; file_path: string | null; line: number | null;
  degree: number;
  lastTouched: string | null;
  confidence: number | null;
}
export interface GraphJsonEdge {
  source: string; target: string; relation: string; strength: number;
}
export interface GraphNeighborsJson {
  center: string; capped: boolean;
  nodes: GraphJsonNode[]; edges: GraphJsonEdge[];
}

/** JSON shape of a neighborhood (spec §5) — same traversal as
 * graphNeighborsMermaid, but returns rows (with file_path/line hydrated) for
 * the dashboard canvas instead of a mermaid fence. */
export async function graphNeighborsRows(args: {
  nodeId: string; depth?: number; relation?: string; projectId?: string;
}): Promise<GraphNeighborsJson | null> {
  if (!UUID_RE.test(args.nodeId)) return null;
  const projectId = args.projectId ?? (await getProjectId());
  const depth = Math.max(1, Math.min(args.depth ?? 1, 3));
  const hood = await collectNeighborhood(projectId, args.nodeId, depth, args.relation, 'both');
  if (!hood) return null;
  const repos = await getProjectRepos(projectId);
  const metrics = await readNodeMetrics(projectId, repos);
  const edgeStrengths = await readEdgeStrengths(projectId);
  return {
    center: hood.center.id,
    capped: hood.capped,
    nodes: hood.nodes.map((n) => ({
      id: n.id,
      kind: n.kind,
      name: n.name,
      qualified_name: n.qualified_name,
      file_path: n.file_path,
      line: n.line,
      degree: Number(n.degree),
      lastTouched: metrics.lastTouched.get(n.id) ?? null,
      confidence: metrics.confidence.get(n.id) ?? null,
    })),
    edges: hood.edges.map((e) => ({
      source: e.from_node,
      target: e.to_node,
      relation: e.relation,
      strength: edgeStrengths.get(e.id) ?? 1,
    })),
  };
}

/** Shortest path between two nodes (spec §5) — undirected BFS with parent
 * pointers, ≤10 hops, frontier-batched SQL. The full-stack trace query. */
export async function graphTrace(args: { fromId: string; toId: string; projectId?: string }): Promise<string> {
  if (!UUID_RE.test(args.fromId) || !UUID_RE.test(args.toId)) {
    return `trace needs two node ids (UUIDs) from mai_graph_find.`;
  }
  const projectId = args.projectId ?? (await getProjectId());
  const pool = getPool();
  const endpoints = await pool.query<NodeRow>(
    `SELECT id, kind, name, qualified_name, file_path, line FROM graph_nodes WHERE project_id = $1 AND id = ANY($2)`,
    [projectId, [args.fromId, args.toId]]
  );
  if (endpoints.rows.length < 2) {
    return `One or both nodes not found in this project.`;
  }
  if (args.fromId === args.toId) return `Those are the same node.`;

  const MAX_HOPS = 10;
  const parent = new Map<string, { prev: string; edge: EdgeRow }>();
  const visited = new Set<string>([args.fromId]);
  let frontier = [args.fromId];
  let found = false;

  for (let d = 0; d < MAX_HOPS && frontier.length > 0 && !found; d++) {
    const r = await pool.query<EdgeRow>(
      `SELECT id, from_node, to_node, relation, confidence FROM graph_edges
       WHERE project_id = $1 AND (from_node = ANY($2) OR to_node = ANY($2))
       LIMIT 5000`,
      [projectId, frontier]
    );
    const next: string[] = [];
    for (const e of r.rows) {
      for (const [a, b] of [
        [e.from_node, e.to_node],
        [e.to_node, e.from_node],
      ] as const) {
        if (visited.has(a) && !visited.has(b)) {
          visited.add(b);
          parent.set(b, { prev: a, edge: e });
          next.push(b);
          if (b === args.toId) found = true;
        }
      }
    }
    frontier = next;
  }

  if (!found) return `No path between those nodes within ${MAX_HOPS} hops.`;

  const pathIds: string[] = [args.toId];
  const steps: Array<{ edge: EdgeRow; forward: boolean }> = [];
  let cur = args.toId;
  while (cur !== args.fromId) {
    const p = parent.get(cur);
    if (!p) break;
    steps.unshift({ edge: p.edge, forward: p.edge.to_node === cur });
    pathIds.unshift(p.prev);
    cur = p.prev;
  }

  const nodeRows = await pool.query<NodeRow>(
    `SELECT id, kind, name, qualified_name, file_path, line FROM graph_nodes WHERE project_id = $1 AND id = ANY($2)`,
    [projectId, pathIds]
  );
  const label = new Map(nodeRows.rows.map((n) => [n.id, `[${n.kind}] ${n.qualified_name ?? n.name}`]));

  const lines = [`# Trace (${steps.length} hop${steps.length === 1 ? '' : 's'})`, ''];
  lines.push(`1. ${label.get(pathIds[0]) ?? pathIds[0]}`);
  steps.forEach((s, i) => {
    const arrow = s.forward ? `—${s.edge.relation}→` : `←${s.edge.relation}—`;
    lines.push(`${i + 2}. ${arrow} ${label.get(pathIds[i + 1]) ?? pathIds[i + 1]}`);
  });
  return lines.join('\n');
}

/** Reverse dependencies + the recorded reasoning behind them (spec §5) — the
 * temporal differentiator: incoming-edge traversal joined to decisions/lessons
 * via memory_edges (the 4a linker + any manual links). */
export async function graphImpact(args: { nodeId: string; depth?: number; projectId?: string }): Promise<string> {
  if (!UUID_RE.test(args.nodeId)) {
    return `'${args.nodeId}' is not a node id (UUID). Get ids from mai_graph_find.`;
  }
  const projectId = args.projectId ?? (await getProjectId());
  const depth = Math.max(1, Math.min(args.depth ?? 2, 3));
  const hood = await collectNeighborhood(projectId, args.nodeId, depth, undefined, 'incoming');
  if (!hood) return `Graph node ${args.nodeId} not found in this project.`;
  const label = new Map(hood.nodes.map((n) => [n.id, `[${n.kind}] ${n.qualified_name ?? n.name}`]));
  const locById = new Map(hood.nodes.map((n) => [n.id, nodeLoc(n)]));
  const centerLabel = `[${hood.center.kind}] ${hood.center.qualified_name ?? hood.center.name}`;

  const affectedIds = hood.nodes.map((n) => n.id);
  const pool = getPool();
  // The FROZEN valid-reasoning predicates (plan 39, shared with dead-code):
  // the memory-edge scope alone is not enough — the joined row must also be
  // this project's and still valid. Global lessons are deliberately visible.
  const decisions = await pool.query<{ description: string; source: string; timestamp: Date }>(
    `SELECT DISTINCT d.description, d.source, d.timestamp
     FROM memory_edges me JOIN code_decisions d ON d.id = me.from_id
     WHERE me.project_id = $1 AND me.to_kind = 'graph_node' AND me.to_id = ANY($2)
       AND me.from_kind = 'decision'
       AND d.project_id = $1 AND d.still_valid = true AND d.retracted_at IS NULL
     ORDER BY d.timestamp DESC LIMIT 20`,
    [projectId, affectedIds]
  );
  const lessons = await pool.query<{ rule: string }>(
    `SELECT DISTINCT l.rule
     FROM memory_edges me JOIN lessons l ON l.id = me.from_id
     WHERE me.project_id = $1 AND me.to_kind = 'graph_node' AND me.to_id = ANY($2)
       AND me.from_kind = 'lesson'
       AND (l.project_id = $1 OR l.project_id IS NULL)
       AND l.superseded_by IS NULL AND l.retired_at IS NULL
     LIMIT 20`,
    [projectId, affectedIds]
  );

  // Evidence for the pure classifier — collected from what was ALREADY read.
  const dependents = hood.nodes.filter((n) => n.id !== hood.center.id);
  const repos = await getProjectRepos(projectId);
  const repoSet = new Set<string>();
  for (const n of hood.nodes) {
    if (n.file_path === null) continue;
    const repo = longestRepoPrefix(n.file_path, repos);
    if (repo !== null) repoSet.add(repo);
  }
  const returnedFreshness = await assessReturnedGraphFreshness(projectId, hood.nodes);
  const assessment = classifyImpactRisk({
    dependentCount: dependents.length,
    kinds: [hood.center.kind, ...dependents.map((n) => n.kind)],
    relations: hood.edges.map((e) => e.relation),
    edgeConfidences: hood.edges.map((e) => e.confidence),
    repoCount: repoSet.size,
    edgeCapHit: hood.capped,
    validReasoningCount: decisions.rows.length + lessons.rows.length,
    staleReturnedNodes: returnedFreshness.stale,
    unresolvedFreshness: returnedFreshness.unresolved,
    schemaParticipates: returnedFreshness.schemaParticipates,
    schemaStale: returnedFreshness.schemaStale,
  });

  const lines = [
    `# Impact of changing ${centerLabel} (reverse deps, depth ${depth})`,
    '',
    `Risk: ${assessment.risk} · assessment confidence: ${assessment.confidence}`,
    `Why: ${assessment.reasons.join('; ')}`,
    '',
    returnedFreshness.line,
    '',
  ];
  if (hood.edges.length === 0) {
    lines.push(`Nothing in the graph depends on this node.`);
  } else {
    lines.push('## Dependents', '');
    for (const e of hood.edges) {
      lines.push(
        `- ${label.get(e.from_node) ?? e.from_node}${locById.get(e.from_node) ?? ''} —${e.relation}→ ${label.get(e.to_node) ?? e.to_node}`
      );
    }
    if (hood.capped) lines.push('', `(capped at ${EDGE_CAP} edges)`);
  }
  lines.push('', '## Recorded reasoning (decisions/lessons touching the affected nodes)', '');
  if (decisions.rows.length === 0 && lessons.rows.length === 0) {
    lines.push(`None linked yet — links materialize from code_decisions.files_affected on each graph build.`);
  } else {
    for (const d of decisions.rows) {
      lines.push(`- [decision/${d.source}] ${d.description} (${new Date(d.timestamp).toISOString().slice(0, 10)})`);
    }
    for (const l of lessons.rows) lines.push(`- [lesson] ${l.rule}`);
  }
  return lines.join('\n');
}

/** Staleness report (spec §4-5). TWO independent axes: per repo/subsystem code
 * nodes vs their extracted defining source, and the DB-schema layer vs its last
 * introspection. The schema section renders for EVERY state — including
 * not-configured, and including projects with no repos recorded — because
 * silence about the schema layer is the bug this replaced. */
export async function graphStale(args: { projectId?: string }): Promise<string> {
  const projectId = args.projectId ?? (await getProjectId());
  const pool = getPool();
  const { repos, excludes } = await loadProjectGraphRoots(projectId);
  const source = new SourceEvidence(repos, excludes);

  const dbState = await readDbSchemaState(projectId);
  const lines = [`# Graph staleness`, ''];

  if (repos.length === 0) {
    lines.push(`## Code`, '', `No repos recorded for this project — no code freshness to report.`, '');
  } else {
    for (const repo of repos) {
      const st = await repoStaleness(projectId, repo, repos, source);
      const last = await pool.query<{ at: Date | null }>(
        `SELECT MAX(extracted_at) AS at
           FROM graph_nodes
          WHERE project_id = $1 AND starts_with(file_path, $2 || '/')
            AND NOT EXISTS (
              SELECT 1 FROM unnest($3::text[]) AS registered(root)
              WHERE length(registered.root) > length($2)
                AND starts_with(graph_nodes.file_path, registered.root || '/')
            )`,
        [projectId, repo, repos]
      );
      const lastAt = last.rows[0]?.at ? new Date(last.rows[0].at).toISOString().slice(0, 16).replace('T', ' ') : 'never';
      const method = st.method === 'whole-graph'
        ? ` — whole-graph count: ${st.fallbackReason}`
        : '';
      lines.push(
        `## ${repo.split('/').pop()} — ${st.stale}/${st.total} stale (HEAD ${st.head?.slice(0, 7) ?? 'no-git'}, last extraction ${lastAt})${method}`
      );
      for (const row of st.bySubsystem) {
        if (row.stale > 0) lines.push(`- ${row.subsystem}: ${row.stale}/${row.total} stale`);
      }
      lines.push('');
    }
  }

  lines.push(...renderDbSchemaSection(dbState), '');
  lines.push(
    `_Two independent axes: code freshness compares tracked working-tree text with extracted source; stale counts include unverified evidence; DB-schema freshness is measured against the last introspection. They move separately and either can be stale alone. Refresh: mai graph update (incremental) or mai graph build (full)._`
  );
  return lines.join('\n');
}

function mermaidLabel(s: string): string {
  return s.replace(/["`|{}[\]<>]/g, "'").slice(0, 60);
}

/** Neighborhood as a mermaid flowchart inside a ```mermaid fence (PWA Graph
 * tab renders it through the existing vendored pipeline), plus a node-id list. */
export async function graphNeighborsMermaid(args: {
  nodeId: string;
  depth?: number;
  relation?: string;
  projectId?: string;
}): Promise<string> {
  if (!UUID_RE.test(args.nodeId)) {
    return `'${args.nodeId}' is not a node id (UUID).`;
  }
  const projectId = args.projectId ?? (await getProjectId());
  const depth = Math.max(1, Math.min(args.depth ?? 1, 3));
  const hood = await collectNeighborhood(projectId, args.nodeId, depth, args.relation, 'both');
  if (!hood) return `Graph node ${args.nodeId} not found in this project.`;
  if (hood.edges.length === 0) return `No edges touch this node — nothing to draw.`;

  const alias = new Map<string, string>();
  hood.nodes.forEach((n, i) => alias.set(n.id, `n${i}`));
  const lines = ['```mermaid', 'flowchart LR'];
  for (const n of hood.nodes) {
    const a = alias.get(n.id) ?? 'x';
    const shape = n.id === hood.center.id ? [`{{"`, `"}}`] : ['["', '"]'];
    lines.push(`  ${a}${shape[0]}${mermaidLabel(`${n.kind}: ${n.name}`)}${shape[1]}`);
  }
  for (const e of hood.edges) {
    lines.push(`  ${alias.get(e.from_node) ?? '?'} -->|${e.relation}| ${alias.get(e.to_node) ?? '?'}`);
  }
  lines.push('```', '', '## Nodes');
  for (const n of hood.nodes) {
    lines.push(`- [${n.kind}] ${n.qualified_name ?? n.name}`);
    lines.push(`  id: ${n.id}`);
  }
  if (hood.capped) lines.push('', `(capped at ${EDGE_CAP} edges)`);
  return lines.join('\n');
}

// ---------------------------------------------------------------------------
// Wave 2 (plan 39): the bounded ordered traversal, its shared returned-node
// freshness seam, and the `mai_graph_query` producer. Everything below is
// project-scoped by construction — every seed, edge, endpoint node, reasoning
// row and freshness read carries the pinned project id.
// ---------------------------------------------------------------------------

/** ONE authority for both narrowing routes — the read partition's own map. */
const QUERY_NARROWING = MCP_READ_NARROWING.mai_graph_query;

export interface TraversalNode {
  id: string;
  kind: string;
  name: string;
  qualified_name: string | null;
  file_path: string | null;
  line: number | null;
  commit_sha: string | null;
  content_hash: string | null;
  extracted_by: string | null;
  hop: number;
}
export interface TraversalEdge {
  id: string;
  from_node: string;
  to_node: string;
  relation: string;
  confidence: string;
  hop: number;
}
export interface TraversalResult {
  nodes: TraversalNode[];
  edges: TraversalEdge[];
  /** Candidate rows charged against the global allowance, before de-duplication. */
  examinedEdges: number;
  /** Candidate rows actually fetched — never more than the cap plus one sentinel. */
  fetchedRows: number;
  edgeCapHit: boolean;
  resultCapHit: boolean;
}

interface TraversalCandidate {
  id: string;
  from_node: string;
  to_node: string;
  relation: string;
  confidence: string;
  discovered: string;
}

/** Injected only by tests, to count the rows each traversal query really asks
 * for. Production leaves it undefined. */
export type TraversalRowObserver = (info: { step: number; limit: number; rows: number }) => void;

/**
 * One ordered, capped traversal. The examined-edge allowance is charged BEFORE
 * de-duplication — a duplicate rediscovered by a later step still consumes
 * capacity — and each step fetches at most `remaining + 1` rows, the extra one
 * being a truncation sentinel. Repeated nodes are never re-expanded.
 */
export async function collectOrderedTraversal(
  projectId: string,
  seedIds: readonly string[],
  steps: readonly NormalizedGraphQueryStep[],
  resultLimit: number,
  observe?: TraversalRowObserver,
): Promise<TraversalResult> {
  const pool = getPool();
  const hopById = new Map<string, number>(seedIds.map((id) => [id, 0]));
  const discoveryOrder: string[] = [...seedIds];
  const collected: TraversalEdge[] = [];
  const seenEdges = new Set<string>();
  let examinedEdges = 0;
  let fetchedRows = 0;
  let edgeCapHit = false;
  let frontier: string[] = [...seedIds];

  for (let index = 0; index < steps.length; index++) {
    if (frontier.length === 0) break;
    const remaining = GRAPH_QUERY_EDGE_CAP - examinedEdges;
    if (remaining <= 0) {
      // Capacity is gone while a step and a frontier remain: that IS the cap.
      edgeCapHit = true;
      break;
    }
    const step = steps[index];
    const rows = await pool.query<TraversalCandidate>(
      `SELECT e.id, e.from_node, e.to_node, e.relation, e.confidence,
              CASE WHEN $5::text = 'incoming' THEN e.from_node
                   WHEN $5::text = 'outgoing' THEN e.to_node
                   WHEN e.from_node = ANY($2::uuid[]) THEN e.to_node
                   ELSE e.from_node END AS discovered
         FROM graph_edges e
         JOIN graph_nodes source ON source.id = e.from_node AND source.project_id = $1
         JOIN graph_nodes target ON target.id = e.to_node AND target.project_id = $1
        WHERE e.project_id = $1
          AND (($5::text = 'outgoing' AND e.from_node = ANY($2::uuid[]))
            OR ($5::text = 'incoming' AND e.to_node = ANY($2::uuid[]))
            OR ($5::text = 'both' AND (e.from_node = ANY($2::uuid[]) OR e.to_node = ANY($2::uuid[]))))
          AND ($3::text[] IS NULL OR e.relation = ANY($3::text[]))
          AND ($4::text[] IS NULL OR
               (CASE WHEN $5::text = 'incoming' THEN source.kind
                     WHEN $5::text = 'outgoing' THEN target.kind
                     WHEN e.from_node = ANY($2::uuid[]) THEN target.kind
                     ELSE source.kind END) = ANY($4::text[]))
        ORDER BY e.relation, e.from_node, e.to_node, e.id
        LIMIT $6`,
      [
        projectId, frontier,
        step.relations.length > 0 ? step.relations : null,
        step.targetKinds.length > 0 ? step.targetKinds : null,
        step.direction, remaining + 1,
      ],
    );
    fetchedRows += rows.rows.length;
    if (observe) observe({ step: index, limit: remaining + 1, rows: rows.rows.length });
    // The (remaining + 1)-th row proves there was more to see; it is never used.
    if (rows.rows.length > remaining) edgeCapHit = true;
    const charged = rows.rows.slice(0, remaining);
    const next: string[] = [];
    for (const candidate of charged) {
      examinedEdges += 1;                       // charged before de-duplication
      if (seenEdges.has(candidate.id)) continue;
      seenEdges.add(candidate.id);
      collected.push({
        id: candidate.id, from_node: candidate.from_node, to_node: candidate.to_node,
        relation: candidate.relation, confidence: candidate.confidence, hop: index + 1,
      });
      if (!hopById.has(candidate.discovered)) {
        hopById.set(candidate.discovered, index + 1);
        discoveryOrder.push(candidate.discovered);
        next.push(candidate.discovered);
      }
    }
    frontier = next;
  }

  const keptIds = discoveryOrder.slice(0, resultLimit);
  const resultCapHit = discoveryOrder.length > resultLimit;
  const hydrated: { rows: Omit<TraversalNode, 'hop'>[] } = keptIds.length === 0
    ? { rows: [] }
    : await pool.query<Omit<TraversalNode, 'hop'>>(
      `SELECT id, kind, name, qualified_name, file_path, line, commit_sha, extracted_by, content_hash
         FROM graph_nodes WHERE project_id = $1 AND id = ANY($2::uuid[])`,
      [projectId, keptIds],
    );
  const byId = new Map(hydrated.rows.map((row) => [row.id, row]));
  const nodes: TraversalNode[] = [];
  for (const id of keptIds) {
    const row = byId.get(id);
    if (row === undefined) continue;            // vanished between queries
    nodes.push({ ...row, hop: hopById.get(id) ?? 0 });
  }
  const returned = new Set(nodes.map((n) => n.id));
  const edges = collected.filter((e) => returned.has(e.from_node) && returned.has(e.to_node));
  return { nodes, edges, examinedEdges, fetchedRows, edgeCapHit, resultCapHit };
}

// ---------- returned-node freshness (shared by query / dead-code / impact) ----------

export interface ReturnedFreshness {
  /** A returned code node has changed or removed defining source. */
  stale: boolean;
  /** Missing extraction evidence, authority, or a stable bounded source read. */
  unresolved: boolean;
  schemaParticipates: boolean;
  schemaStale: boolean;
  line: string;
}

const SCHEMA_KINDS = new Set(['table', 'column', 'policy']);

/** Longest configured repository prefix, on a path BOUNDARY (never a substring). */
export function longestRepoPrefix(filePath: string, repos: readonly string[]): string | null {
  return owningRegisteredRepo(filePath, repos);
}

/**
 * Freshness of exactly the nodes being RETURNED. Unrelated graph rows and
 * unrelated repositories are never consulted, and the DB-schema layer is read
 * only when a returned node is a table/column/policy.
 */
export async function assessReturnedGraphFreshness(
  projectId: string,
  nodes: readonly (NodeStalenessInput & { kind: string })[],
  suppliedSource?: SourceEvidence,
): Promise<ReturnedFreshness> {
  const { repos, excludes } = await loadProjectGraphRoots(projectId);
  const roots = suppliedSource ?? new SourceEvidence(repos, excludes);
  // The same evidence context is shared with dead-code confidence when supplied.
  const codeRows = nodes.filter((node) => !SCHEMA_KINDS.has(node.kind) && node.file_path !== null);
  const verdicts = await assessNodeStaleness(codeRows, repos, roots);
  const codeNodes = codeRows.length;
  const fresh = verdicts.filter((v) => v === 'fresh').length;
  const stale = verdicts.filter((v) => v === 'stale').length;
  const unattributed = verdicts.filter((v) => v === 'unattributed').length;

  const schemaParticipates = nodes.some((node) => SCHEMA_KINDS.has(node.kind));
  let schemaStale = false;
  let schemaClause = 'schema not consulted';
  if (schemaParticipates) {
    const state = await readDbSchemaState(projectId);
    schemaStale = state.state !== 'fresh';
    schemaClause =
      state.state === 'fresh' ? 'schema fresh as of its last introspection'
        : state.state === 'never-extracted' ? 'schema never introspected'
          : state.state === 'not-configured' ? 'schema not configured'
            : `schema STALE (${state.reason})`;
  }

  const codeClause = codeNodes === 0
    ? 'no code nodes returned'
    : [`${fresh}/${codeNodes} code nodes source verified`,
      ...(stale > 0 ? [`${stale} stale`] : []),
      ...(unattributed > 0 ? [`${unattributed} unverified/unattributed`] : [])].join(', ');

  return {
    stale: stale > 0,
    unresolved: unattributed > 0,
    schemaParticipates,
    schemaStale,
    line: `_Returned-node freshness: ${codeClause}; ${schemaClause}._`,
  };
}

// ---------- the bounded query producer ----------

interface SeedRow extends Omit<TraversalNode, 'hop'> { exact: boolean; score: number }

function nodeLine(node: TraversalNode): string {
  return `- [${node.kind}] ${node.qualified_name ?? node.name}${nodeLoc(node)} · hop ${node.hop} · ${node.id}`;
}
function nodeHeadline(node: TraversalNode): string {
  return `- [${node.kind}] ${headlineField(node.qualified_name ?? node.name, 120)} · hop ${node.hop} · ${node.id}`;
}
function edgeLine(edge: TraversalEdge, label: ReadonlyMap<string, string>): string {
  const confidence = edge.confidence === 'extracted' ? '' : ` (${edge.confidence})`;
  return `- ${label.get(edge.from_node) ?? edge.from_node} —${edge.relation}→ ${label.get(edge.to_node) ?? edge.to_node}${confidence} · hop ${edge.hop}`;
}

/**
 * Pack as many complete rows as `room` allows. Every row costs its own leading
 * newline — including the first, because the shell it is appended to already
 * ends with a line: charging the first row less is exactly how a fitted render
 * overshoots the budget it was fitted to.
 */
function fitRows(rows: readonly string[], room: number): string[] {
  const kept: string[] = [];
  let used = 0;
  for (const row of rows) {
    const cost = row.length + 1;
    if (used + cost > room) break;
    kept.push(row);
    used += cost;
  }
  return kept;
}

/**
 * `mai_graph_query` — one seed, up to three ordered traversal steps, hard caps
 * on seeds, examined edges and returned nodes. Read-only and project-pinned.
 * The MCP path supplies a budget; the CLI passes none and gets the complete
 * producer output.
 */
export async function graphQuery(
  input: unknown, projectIdOverride?: string, budget?: ReadBudget,
): Promise<string> {
  const parsed = normalizeGraphQuery(input);
  if (!parsed.ok) return `Invalid graph query: ${parsed.message}`;
  const query: NormalizedGraphQuery = parsed.value;
  const projectId = projectIdOverride ?? (await getProjectId());
  const pool = getPool();

  const seedLimit = Math.min(GRAPH_QUERY_SEED_CAP, query.limit);
  let seeds: SeedRow[] = [];
  let seedCapHit = false;
  if (query.seed.nodeId !== null) {
    const row = await pool.query<Omit<TraversalNode, 'hop'>>(
      `SELECT id, kind, name, qualified_name, file_path, line, commit_sha, extracted_by, content_hash
         FROM graph_nodes WHERE id = $1 AND project_id = $2`,
      [query.seed.nodeId, projectId],
    );
    if (row.rows.length === 0) return `Graph node ${query.seed.nodeId} not found in this project.`;
    seeds = row.rows.map((node) => ({ ...node, exact: true, score: 1 }));
  } else {
    const text = query.seed.query ?? '';
    // Literal, case-insensitive containment: strpos has no wildcard or escape
    // semantics, so %, _, backslash and quotes are ordinary characters.
    const found = await pool.query<SeedRow>(
      `SELECT id, kind, name, qualified_name, file_path, line, commit_sha, extracted_by, content_hash,
              (lower(name) = lower($2) OR lower(COALESCE(qualified_name, '')) = lower($2)) AS exact,
              GREATEST(similarity(name, $2), similarity(COALESCE(qualified_name, ''), $2)) AS score
         FROM graph_nodes
        WHERE project_id = $1
          AND (strpos(lower(name), lower($2)) > 0
            OR strpos(lower(COALESCE(qualified_name, '')), lower($2)) > 0)
          AND ($3::text[] IS NULL OR kind = ANY($3::text[]))
          AND ($4::text IS NULL OR starts_with(file_path, $4::text))
        ORDER BY exact DESC, score DESC, kind, COALESCE(qualified_name, name), id
        LIMIT $5`,
      [
        projectId, text,
        query.seed.kinds.length > 0 ? query.seed.kinds : null,
        query.seed.pathPrefix,
        seedLimit + 1,
      ],
    );
    seedCapHit = found.rows.length > seedLimit;
    seeds = found.rows.slice(0, seedLimit);
    if (seeds.length === 0) {
      const count = await pool.query<{ n: string }>(
        `SELECT COUNT(*)::text AS n FROM graph_nodes WHERE project_id = $1`, [projectId]);
      return Number(count.rows[0].n) === 0
        ? `No graph nodes match '${text}'. The graph has never been built for this project — run: mai graph build --project <slug>`
        : `No graph nodes match '${text}'. ${count.rows[0].n} nodes in the graph, none match — try a shorter fragment or fewer filters.`;
    }
  }

  const traversal = await collectOrderedTraversal(
    projectId, seeds.map((s) => s.id), query.steps, query.limit);
  const freshness = await assessReturnedGraphFreshness(projectId, traversal.nodes);

  const label = new Map(traversal.nodes.map(
    (node) => [node.id, `[${node.kind}] ${node.qualified_name ?? node.name}`]));
  const seedDescription = query.seed.nodeId !== null
    ? `node ${query.seed.nodeId}`
    : `"${query.seed.query ?? ''}"`;
  const title = `# Graph query — seed ${seedDescription}`;

  const capLines: string[] = [];
  if (seedCapHit) capLines.push(`_Seed cap: only the first ${seedLimit} matching seeds were used._`);
  if (traversal.edgeCapHit) {
    capLines.push(`_Edge cap: traversal examined ${GRAPH_QUERY_EDGE_CAP} edges and stopped early._`);
  }
  if (traversal.resultCapHit) {
    capLines.push(`_Result cap: only the first ${query.limit} reached nodes were hydrated._`);
  }

  const nodeRows = traversal.nodes.map(nodeLine);
  const edgeRows = traversal.edges.map((edge) => edgeLine(edge, label));
  const summary = (shownNodes: number, shownEdges: number): string =>
    `Steps: ${query.steps.length} · limit: ${query.limit} · seeds: ${seeds.length} · ` +
    `nodes: ${shownNodes}/${traversal.nodes.length} · edges: ${shownEdges}/${traversal.edges.length}`;

  const render = (
    nodes: readonly string[], edges: readonly string[],
    counts: { nodes: number; edges: number } = { nodes: nodes.length, edges: edges.length },
  ): string => {
    const lines = [title, '', summary(counts.nodes, counts.edges), '', '## Nodes', '', ...nodes];
    if (query.steps.length > 0) lines.push('', '## Edges', '', ...(edges.length > 0 ? edges : ['(none)']));
    lines.push('', ...capLines, freshness.line);
    return lines.join('\n');
  };

  if (budget === undefined) return render(nodeRows, edgeRows);

  // Budgeted: the immutable shell — summary, every fired cap receipt, the
  // freshness disclosure and the literal narrowing route — is reserved BEFORE
  // any row is fitted, so a shortened answer can never lose them.
  // The route rides in the immutable shell, so it prints on complete answers
  // too: the label states the BOUND, never an effect that may not have happened.
  const narrowing = `_Bounded read: ${QUERY_NARROWING}._`;
  // Reserve the WORST-CASE summary: the shown/total counts grow by a digit as
  // rows are fitted, and a shell measured at 0/0 would under-reserve by exactly
  // those digits — enough to overshoot the budget and throw.
  const shell = render([], [], {
    nodes: traversal.nodes.length, edges: traversal.edges.length,
  }).length + narrowing.length + 1;
  if (shell > budget.charBudget) {
    throw new Error(`graph query shell ${shell} exceeds budget ${budget.charBudget}`);
  }
  const room = budget.charBudget - shell;
  const nodeHeadlines = traversal.nodes.map(nodeHeadline);
  const keptNodes = fitRows(nodeHeadlines, room);
  const keptEdges = fitRows(edgeRows, room - keptNodes.reduce((n, row) => n + row.length + 1, 0));
  const body = `${render(keptNodes, keptEdges)}\n${narrowing}`;
  if (body.length > budget.charBudget) {
    throw new Error(`graph query render ${body.length} exceeds budget ${budget.charBudget}`);
  }
  return body;
}

// ---------- conservative dead-code candidates ----------

const DEAD_CODE_NARROWING = MCP_READ_NARROWING.mai_graph_dead_code;
const DEAD_CODE_CAVEAT =
  '_These are static-analysis CANDIDATES, not proof: verify source/runtime behavior before removing anything._';

interface DeadCodeRow {
  id: string;
  kind: string;
  name: string;
  qualified_name: string | null;
  file_path: string;
  line: number;
  commit_sha: string | null;
  content_hash: string | null;
  extracted_by: string;
}

/** The literal supported `extractor:kind` pairs, straight from the frozen table. */
const supportedCoveragePairs = (kinds: readonly string[]): string[] =>
  Object.keys(DEAD_CODE_COVERAGE).filter((pair) => kinds.some((kind) => pair.endsWith(`:${kind}`)));

/**
 * `mai_graph_dead_code` — nodes with a source location, supported extractor
 * coverage, and NO use/export/root/reasoning evidence anywhere in the pinned
 * project. Every exclusion is one bounded set predicate; there is no per-row
 * query, and nothing here ever claims a node is safe to delete.
 */
export async function graphDeadCode(
  input: unknown, projectIdOverride?: string, budget?: ReadBudget,
): Promise<string> {
  const parsed = normalizeGraphDeadCode(input);
  if (!parsed.ok) return `Invalid dead-code request: ${parsed.message}`;
  const request = parsed.value;
  const projectId = projectIdOverride ?? (await getProjectId());

  const pairs = supportedCoveragePairs(request.kinds);
  const heading = '# Dead-code candidates';
  if (pairs.length === 0) {
    return [heading, '', `No supported extractor coverage for kinds: ${request.kinds.join(', ')}. ` +
      'Absence of edges from an unsupported extractor is not evidence.', '', DEAD_CODE_CAVEAT].join('\n');
  }

  const rows = await getPool().query<DeadCodeRow>(
    `SELECT n.id, n.kind, n.name, n.qualified_name, n.file_path, n.line, n.commit_sha, n.extracted_by, n.content_hash
       FROM graph_nodes n
      WHERE n.project_id = $1
        AND n.kind = ANY($2::text[])
        AND n.file_path IS NOT NULL
        AND n.line IS NOT NULL
        AND ($3::text IS NULL OR starts_with(n.file_path, $3::text))
        AND (n.extracted_by || ':' || n.kind) = ANY($4::text[])
        AND NOT EXISTS (
          SELECT 1 FROM graph_edges use_edge
           WHERE use_edge.project_id = $1 AND use_edge.to_node = n.id
             AND use_edge.relation = ANY($5::text[]))
        AND NOT EXISTS (
          SELECT 1 FROM graph_edges export_edge
           WHERE export_edge.project_id = $1 AND export_edge.relation = 'exports'
             AND (export_edge.from_node = n.id OR export_edge.to_node = n.id))
        AND NOT EXISTS (
          SELECT 1 FROM graph_edges root_edge
            JOIN graph_nodes root_node
              ON root_node.project_id = $1
             AND root_node.id = CASE WHEN root_edge.from_node = n.id
                                     THEN root_edge.to_node ELSE root_edge.from_node END
           WHERE root_edge.project_id = $1
             AND root_edge.relation = ANY($6::text[])
             AND (root_edge.from_node = n.id OR root_edge.to_node = n.id)
             AND root_node.kind = ANY($7::text[]))
        AND NOT EXISTS (
          SELECT 1 FROM memory_edges me JOIN code_decisions d ON d.id = me.from_id
           WHERE me.project_id = $1 AND me.to_kind = 'graph_node' AND me.to_id = n.id
             AND me.from_kind = 'decision'
             AND d.project_id = $1 AND d.still_valid = true AND d.retracted_at IS NULL)
        AND NOT EXISTS (
          SELECT 1 FROM memory_edges me JOIN lessons l ON l.id = me.from_id
           WHERE me.project_id = $1 AND me.to_kind = 'graph_node' AND me.to_id = n.id
             AND me.from_kind = 'lesson'
             AND (l.project_id = $1 OR l.project_id IS NULL)
             AND l.superseded_by IS NULL AND l.retired_at IS NULL)
      ORDER BY n.file_path, n.line, COALESCE(n.qualified_name, n.name), n.id
      LIMIT $8`,
    [
      projectId, request.kinds, request.pathPrefix, pairs,
      USE_RELATIONS, ROOT_RELATIONS, DEAD_CODE_ROOT_KINDS, request.limit,
    ],
  );

  const { repos, excludes } = await loadProjectGraphRoots(projectId);
  const source = new SourceEvidence(repos, excludes);
  const freshness = await assessReturnedGraphFreshness(projectId, rows.rows, source);
  // `strong` needs BOTH complete coverage and a current node — "current" by the
  // ONE producer's per-file predicate (plan 46 R3), not by HEAD equality. No
  // launch pair is complete, so every launch candidate is limited — deliberately.
  const verdicts = await assessNodeStaleness(rows.rows, repos, source);
  const confidenceOf = (row: DeadCodeRow, index: number): 'strong' | 'limited' => {
    const coverage = deadCodeCoverage(row.extracted_by, row.kind);
    if (coverage !== 'complete') return 'limited';
    return verdicts[index] === 'fresh' ? 'strong' : 'limited';
  };

  const scored: { row: DeadCodeRow; confidence: 'strong' | 'limited' }[] =
    rows.rows.map((row, index) => ({ row, confidence: confidenceOf(row, index) }));
  scored.sort((a, b) => {
    if (a.confidence !== b.confidence) return a.confidence === 'strong' ? -1 : 1;
    return 0;   // the SQL already ordered by path/line/qualified-name/id
  });

  const checkedUse = `checked incoming use relations: ${USE_RELATIONS.join(', ')}`;
  const checkedExclusions =
    `checked exclusions: exports (either direction), root kinds via ${ROOT_RELATIONS.join('/')}, ` +
    'still-valid decisions and lessons';
  const summary = `Kinds: ${request.kinds.join(', ')} · limit: ${request.limit}` +
    (request.pathPrefix === null ? '' : ` · path: ${request.pathPrefix}`);

  const candidateRows = scored.map(({ row, confidence }) =>
    `- [${row.kind}] ${row.qualified_name ?? row.name} — ${row.file_path}:${row.line} · ` +
    `${row.extracted_by} · ${confidence} · ${row.id}`);

  const render = (shown: readonly string[]): string => {
    const lines = [heading, '', summary, ''];
    if (candidateRows.length === 0) {
      lines.push('No candidates: every node with supported coverage shows use, export, root or reasoning evidence.');
    } else {
      lines.push(...shown);
    }
    lines.push('', `_${checkedUse}._`, `_${checkedExclusions}._`, freshness.line, DEAD_CODE_CAVEAT);
    return lines.join('\n');
  };

  if (budget === undefined) return render(candidateRows);

  const narrowing = `_Bounded read: ${DEAD_CODE_NARROWING}._`;
  const shell = render([]).length + narrowing.length + 1;
  if (shell > budget.charBudget) {
    throw new Error(`dead-code shell ${shell} exceeds budget ${budget.charBudget}`);
  }
  const kept = fitRows(candidateRows, budget.charBudget - shell);
  const body = `${render(kept)}\n${narrowing}`;
  if (body.length > budget.charBudget) {
    throw new Error(`dead-code render ${body.length} exceeds budget ${budget.charBudget}`);
  }
  return body;
}
