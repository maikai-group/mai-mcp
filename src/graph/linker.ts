// Decisions→graph linker (spec §2 brain join): materializes memory_edges rows
// (decision —affects→ graph_node, confidence 'inferred') by suffix-matching
// code_decisions.files_affected paths against file nodes. Retroactive: the
// existing brain lights up against the graph on every build. Idempotent via
// the memory_edges UNIQUE constraint. suffix match uses right()/length — no
// LIKE wildcards, so paths containing % or _ are safe.
import { getPool } from '../db.js';
import {
  normalizeServiceAlias, readEndpointMetadata, readHttpCallMetadata, routeMatches,
  type EndpointMetadata, type HttpCallMetadata,
} from './contracts.js';

export interface ServiceContractLinkSummary {
  linked: number;
  unresolved: number;
  ambiguous: number;
}

interface ContractNodeRow {
  id: string;
  kind: string;
  qualified_name: string;
  metadata: unknown;
}

interface EndpointObservation {
  id: string;
  qualifiedName: string;
  metadata: EndpointMetadata;
}

interface CallObservation {
  id: string;
  qualifiedName: string;
  metadata: HttpCallMetadata | null;
}

function claimAlias(aliases: Map<string, string | null>, alias: string, serviceId: string): void {
  const existing = aliases.get(alias);
  if (existing === undefined) aliases.set(alias, serviceId);
  else if (existing !== serviceId) aliases.set(alias, null);
}

function targetServiceForCall(
  call: HttpCallMetadata,
  aliases: ReadonlyMap<string, string | null>,
): { kind: 'resolved'; serviceId: string } | { kind: 'unresolved' } | { kind: 'ambiguous' } {
  const fullHost = normalizeServiceAlias(call.target_host);
  const firstLabel = normalizeServiceAlias(call.target_host.split('.')[0] ?? '');
  const candidates = new Set<string>();
  let ambiguous = false;
  for (const alias of new Set([fullHost, firstLabel])) {
    if (alias === null || !aliases.has(alias)) continue;
    const serviceId = aliases.get(alias);
    if (serviceId === null) ambiguous = true;
    else if (serviceId !== undefined) candidates.add(serviceId);
  }
  if (ambiguous || candidates.size > 1) return { kind: 'ambiguous' };
  const [serviceId] = candidates;
  if (serviceId === undefined || serviceId === call.source_service) return { kind: 'unresolved' };
  return { kind: 'resolved', serviceId };
}

/**
 * Replace one project's literal HTTP-call relation set from privacy-bounded
 * call/provider observations. The whole delete+insert sequence is atomic so a
 * failed insert leaves the previous materialization intact.
 */
export async function linkServiceContracts(projectId: string): Promise<ServiceContractLinkSummary> {
  const client = await getPool().connect();
  try {
    await client.query('BEGIN');
    const selected = await client.query<ContractNodeRow>(
      `SELECT id, kind, qualified_name, metadata
       FROM graph_nodes
       WHERE project_id = $1 AND kind = ANY($2)
       ORDER BY qualified_name
       FOR UPDATE`,
      [projectId, ['http_call', 'endpoint']],
    );

    const endpoints: EndpointObservation[] = [];
    const calls: CallObservation[] = [];
    for (const row of selected.rows) {
      if (row.kind === 'endpoint') {
        const metadata = readEndpointMetadata(row.metadata);
        if (metadata !== null) endpoints.push({
          id: row.id, qualifiedName: row.qualified_name, metadata,
        });
      } else if (row.kind === 'http_call') {
        calls.push({
          id: row.id,
          qualifiedName: row.qualified_name,
          metadata: readHttpCallMetadata(row.metadata),
        });
      }
    }
    endpoints.sort((left, right) => left.qualifiedName.localeCompare(right.qualifiedName));
    calls.sort((left, right) => left.qualifiedName.localeCompare(right.qualifiedName));

    const aliases = new Map<string, string | null>();
    for (const endpoint of endpoints) {
      for (const alias of endpoint.metadata.service_aliases) {
        claimAlias(aliases, alias, endpoint.metadata.service_id);
      }
    }

    const summary: ServiceContractLinkSummary = { linked: 0, unresolved: 0, ambiguous: 0 };
    const resolved: Array<{ callId: string; endpointId: string }> = [];
    for (const call of calls) {
      const metadata = call.metadata;
      if (metadata === null) {
        summary.unresolved++;
        continue;
      }
      const target = targetServiceForCall(metadata, aliases);
      if (target.kind === 'ambiguous') {
        summary.ambiguous++;
        continue;
      }
      if (target.kind === 'unresolved') {
        summary.unresolved++;
        continue;
      }
      const routeCandidates = endpoints.filter((endpoint) =>
        endpoint.metadata.service_id === target.serviceId
        && routeMatches(endpoint.metadata.path, metadata.path));
      const candidates = metadata.method === 'ANY'
        ? routeCandidates.filter((endpoint) => endpoint.metadata.method === 'ANY')
        : (() => {
            const exact = routeCandidates.filter((endpoint) => endpoint.metadata.method === metadata.method);
            return exact.length > 0
              ? exact
              : routeCandidates.filter((endpoint) => endpoint.metadata.method === 'ANY');
          })();
      if (candidates.length === 0) {
        summary.unresolved++;
      } else if (candidates.length > 1) {
        summary.ambiguous++;
      } else {
        summary.linked++;
        resolved.push({ callId: call.id, endpointId: candidates[0].id });
      }
    }

    await client.query(
      `DELETE FROM graph_edges
       WHERE project_id = $1 AND relation = 'http_calls'`,
      [projectId],
    );
    for (const pair of resolved) {
      await client.query(
        `INSERT INTO graph_edges
           (project_id, from_node, to_node, relation, confidence, weight, metadata)
         SELECT $1, caller.id, endpoint.id, 'http_calls', 'extracted', 1,
                '{"matcher":"literal-v1"}'::jsonb
         FROM graph_nodes caller
         JOIN graph_nodes endpoint ON endpoint.id = $3 AND endpoint.project_id = $1
         WHERE caller.id = $2 AND caller.project_id = $1
         ON CONFLICT (project_id, from_node, to_node, relation) DO UPDATE SET
           confidence = EXCLUDED.confidence,
           weight = EXCLUDED.weight,
           metadata = EXCLUDED.metadata`,
        [projectId, pair.callId, pair.endpointId],
      );
    }
    await client.query('COMMIT');
    return summary;
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}

export async function linkDecisionsToFiles(projectId: string): Promise<number> {
  const r = await getPool().query<{ count: string }>(
    `WITH matches AS (
       SELECT DISTINCT d.id AS decision_id, n.id AS node_id
       FROM code_decisions d
       CROSS JOIN LATERAL unnest(d.files_affected) AS f(path)
       JOIN graph_nodes n
         ON n.project_id = d.project_id
        AND n.kind = 'file'
        AND (n.file_path = f.path
             OR right(n.file_path, length(f.path) + 1) = '/' || f.path)
       WHERE d.project_id = $1
         AND d.still_valid = true
         AND d.files_affected IS NOT NULL
         AND f.path <> ''
     ),
     ins AS (
       INSERT INTO memory_edges (project_id, from_kind, from_id, to_kind, to_id, relation, confidence, note)
       SELECT $1, 'decision', decision_id, 'graph_node', node_id, 'affects', 'inferred',
              'auto-linked from files_affected (mai graph build)'
       FROM matches
       ON CONFLICT (from_kind, from_id, to_kind, to_id, relation) DO NOTHING
       RETURNING 1
     )
     SELECT COUNT(*) AS count FROM ins`,
    [projectId]
  );
  return Number(r.rows[0].count);
}

/**
 * wp_table→table linker (plan 34, spec D3/D4): joins the php extractor's
 * logical WordPress table references (plan 33 R8 — `wptable:<suffix>`, no
 * file_path) to physically introspected tables by prefix:
 * table.name = prefix || wp_table.name, prefix from
 * projects.metadata->>'wp_table_prefix' (default 'wp_' — WordPress's own).
 * Reuses `references_table` (spec D4), confidence 'inferred' — the prefix is
 * install configuration, not something code can prove. Idempotent via the
 * graph_edges UNIQUE(project_id, from_node, to_node, relation) constraint
 * (db/schema.sql:462); retroactive on every build/update, a no-op when either
 * side is absent.
 */
export async function linkWpTablesToSchema(projectId: string): Promise<number> {
  const r = await getPool().query<{ count: string }>(
    `WITH prefix AS (
       SELECT COALESCE(metadata->>'wp_table_prefix', 'wp_') AS p
       FROM projects WHERE id = $1
     ),
     matches AS (
       SELECT w.id AS from_node, t.id AS to_node
       FROM graph_nodes w
       CROSS JOIN prefix
       JOIN graph_nodes t
         ON t.project_id = w.project_id
        AND t.kind = 'table'
        AND t.name = prefix.p || w.name
       WHERE w.project_id = $1
         AND w.kind = 'wp_table'
     ),
     ins AS (
       INSERT INTO graph_edges (project_id, from_node, to_node, relation, confidence, metadata)
       SELECT $1, from_node, to_node, 'references_table', 'inferred',
              '{"via": "wp-prefix-linker"}'::jsonb
       FROM matches
       ON CONFLICT (project_id, from_node, to_node, relation) DO NOTHING
       RETURNING 1
     )
     SELECT COUNT(*) AS count FROM ins`,
    [projectId]
  );
  return Number(r.rows[0].count);
}
