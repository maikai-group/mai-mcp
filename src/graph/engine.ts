// mai-graph engine (spec §3–4): runs extractors, validates their output against
// their registered vocabulary, dedupes, and splices results into graph_nodes /
// graph_edges in one transaction per extractor. Splice = delete this
// extractor's previous nodes (edges cascade) + upsert the new set — re-runs are
// idempotent via UNIQUE(project_id, kind, qualified_name). Extraction is always
// local and key-less: nothing in src/graph/ calls an LLM.
import crypto from 'node:crypto';
import path from 'node:path';
import { beginBulkTransaction, getPool } from '../db.js';
import { execBounded } from '../git/repo.js';
import { SHARED_KINDS } from './registry.js';
import { canonicalPhysicalPath } from './roots.js';
import type {
  ContractSkipTallies, ExtractedEdge, ExtractedNode, ExtractorInput, ExtractorOutput, GraphExtractor,
} from './types.js';

const exec = execBounded;
const CHUNK = 200;

/** sha256 hex of file content — graph_nodes.content_hash staleness marker. */
export function hashContent(content: string): string {
  return crypto.createHash('sha256').update(content).digest('hex');
}

/** HEAD sha of a repo (null outside git — staleness simply unavailable). */
export async function headSha(repoPath: string): Promise<string | null> {
  try {
    const { stdout } = await exec('git', ['rev-parse', 'HEAD'], { cwd: repoPath });
    return stdout.trim();
  } catch {
    return null;
  }
}

export interface ExtractorRunSummary {
  extractor: string;
  nodes: number;
  edges: number;
  /** Edges whose endpoint refs matched no node — dropped, never invented. */
  droppedEdges: number;
  contractSkips: ContractSkipTallies;
}

const ZERO_CONTRACT_SKIPS: ContractSkipTallies = {
  dynamic_http_url: 0,
  dynamic_http_method: 0,
  dynamic_http_route: 0,
  dynamic_event_channel: 0,
};

const refKey = (kind: string, qualifiedName: string): string => `${kind} ${qualifiedName}`;
const edgeKey = (e: ExtractedEdge): string =>
  `${refKey(e.from.kind, e.from.qualifiedName)} ${refKey(e.to.kind, e.to.qualifiedName)} ${e.relation}`;

function validateOutput(extractor: GraphExtractor, out: ExtractorOutput): void {
  if (!/^[a-z][a-z0-9_-]{0,31}$/.test(extractor.name)) {
    throw new Error(`extractor name '${extractor.name}' must be lowercase kebab/snake, ≤32 chars`);
  }
  const kinds = new Set<string>(extractor.vocabulary.kinds);
  const relations = new Set<string>(extractor.vocabulary.relations);
  for (const n of out.nodes) {
    if (!kinds.has(n.kind)) {
      throw new Error(`extractor '${extractor.name}' emitted unregistered node kind '${n.kind}'`);
    }
    if (!n.name.trim() || !n.qualifiedName.trim()) {
      throw new Error(`extractor '${extractor.name}' emitted a node with empty name/qualifiedName (kind '${n.kind}')`);
    }
  }
  for (const e of out.edges) {
    if (!relations.has(e.relation)) {
      throw new Error(`extractor '${extractor.name}' emitted unregistered relation '${e.relation}'`);
    }
  }
  if (out.contractSkips !== undefined) {
    const keys = Object.keys(out.contractSkips).sort();
    const expected = Object.keys(ZERO_CONTRACT_SKIPS).sort();
    if (keys.length !== expected.length || keys.some((key, index) => key !== expected[index])) {
      throw new Error(`extractor '${extractor.name}' emitted invalid contract skip keys`);
    }
    for (const [key, value] of Object.entries(out.contractSkips)) {
      if (!Number.isFinite(value) || value < 0 || !Number.isInteger(value)) {
        throw new Error(`extractor '${extractor.name}' emitted invalid contract skip tally '${key}'`);
      }
    }
  }
}

function contractSkips(out: ExtractorOutput): ContractSkipTallies {
  return out.contractSkips === undefined ? { ...ZERO_CONTRACT_SKIPS } : { ...out.contractSkips };
}

/** Enrich only from this extraction, never from later disk contents or old rows. */
function withExtractedSourceHashes(nodes: readonly ExtractedNode[]): ExtractedNode[] {
  const physicalPaths = new Map<string, string>();
  const physical = (file: string): string => {
    const cached = physicalPaths.get(file);
    if (cached !== undefined) return cached;
    const resolved = canonicalPhysicalPath(file, process.cwd());
    physicalPaths.set(file, resolved);
    return resolved;
  };
  const witnesses = new Map<string, string>();
  const fileHashes = new Map<string, string>();
  for (const node of nodes) {
    if (node.filePath === undefined || node.contentHash === undefined) continue;
    if (!/^[0-9a-f]{64}$/.test(node.contentHash)) {
      throw new Error('extractor emitted an invalid defining-source hash');
    }
    const file = physical(node.filePath);
    const prior = witnesses.get(file);
    if (prior !== undefined && prior !== node.contentHash) {
      throw new Error('extractor emitted conflicting defining-source hashes');
    }
    witnesses.set(file, node.contentHash);
    if (node.kind === 'file') fileHashes.set(file, node.contentHash);
  }
  return nodes.map(node => {
    if (node.filePath === undefined || node.contentHash !== undefined) return node;
    const hash = fileHashes.get(physical(node.filePath));
    return hash === undefined ? node : { ...node, contentHash: hash };
  });
}

/** First occurrence wins; intra-batch duplicates would break multi-row ON CONFLICT. */
function dedupe(out: { nodes: ExtractedNode[]; edges: ExtractedEdge[] }): {
  nodes: ExtractedNode[];
  edges: ExtractedEdge[];
} {
  const nodeSeen = new Set<string>();
  const nodes: ExtractedNode[] = [];
  for (const n of out.nodes) {
    const k = refKey(n.kind, n.qualifiedName);
    if (nodeSeen.has(k)) continue;
    nodeSeen.add(k);
    nodes.push(n);
  }
  const edgeSeen = new Set<string>();
  const edges: ExtractedEdge[] = [];
  for (const e of out.edges) {
    const k = edgeKey(e);
    if (edgeSeen.has(k)) continue;
    edgeSeen.add(k);
    edges.push(e);
  }
  return { nodes, edges };
}

/** commit_sha resolver: HEAD of the LONGEST registered repo prefix containing
 * the file — when an umbrella root and its sub-repos are both registered, the
 * sub-repo (longer path) owns its files. Exported for tests. */
export function shaForFactory(repoShas: Map<string, string | null>): (filePath?: string) => string | null {
  const repos = [...repoShas.keys()].sort((a, b) => b.length - a.length);
  return (filePath?: string): string | null => {
    if (!filePath) return null;
    for (const repo of repos) {
      if (filePath === repo || filePath.startsWith(repo + path.sep)) return repoShas.get(repo) ?? null;
    }
    return null;
  };
}

export async function runExtractor(extractor: GraphExtractor, input: ExtractorInput): Promise<ExtractorRunSummary> {
  const raw = await extractor.extract(input);
  validateOutput(extractor, raw);
  const { nodes, edges } = dedupe({
    nodes: withExtractedSourceHashes(raw.nodes), edges: raw.edges,
  });

  const repoShas = new Map<string, string | null>();
  for (const r of input.repoPaths) {
    const resolved = path.resolve(r);
    repoShas.set(resolved, await headSha(resolved));
  }
  const shaFor = shaForFactory(repoShas);

  const client = await getPool().connect();
  try {
    await beginBulkTransaction(client);

    // Splice: this extractor's previous subgraph goes away (edges touching its
    // nodes cascade via FK); other extractors' subgraphs are untouched. SHARED
    // kinds (command) are never deleted here — a delete would cascade away
    // OTHER extractors' edges through them; the orphan sweep handles staleness.
    await client.query(
      `DELETE FROM graph_nodes WHERE project_id = $1 AND extracted_by = $2 AND kind <> ALL($3)`,
      [input.projectId, extractor.name, [...SHARED_KINDS]]
    );

    for (let i = 0; i < nodes.length; i += CHUNK) {
      const chunk = nodes.slice(i, i + CHUNK);
      const values: unknown[] = [];
      const rows = chunk.map((n, j) => {
        const b = j * 12;
        values.push(
          input.projectId,
          n.kind,
          n.name,
          n.qualifiedName,
          n.filePath ?? null,
          n.line ?? null,
          n.lang ?? null,
          n.signature ?? null,
          n.contentHash ?? null,
          shaFor(n.filePath),
          extractor.name,
          JSON.stringify(n.metadata ?? {})
        );
        return `($${b + 1}, $${b + 2}, $${b + 3}, $${b + 4}, $${b + 5}, $${b + 6}, $${b + 7}, $${b + 8}, $${b + 9}, $${b + 10}, $${b + 11}, $${b + 12}::jsonb)`;
      });
      // Conflicts are cross-extractor only (this extractor's rows were deleted):
      // refresh in place and take ownership.
      await client.query(
        `INSERT INTO graph_nodes
           (project_id, kind, name, qualified_name, file_path, line, lang, signature, content_hash, commit_sha, extracted_by, metadata)
         VALUES ${rows.join(', ')}
         ON CONFLICT (project_id, kind, qualified_name) DO UPDATE SET
           name = EXCLUDED.name, file_path = EXCLUDED.file_path, line = EXCLUDED.line,
           lang = EXCLUDED.lang, signature = EXCLUDED.signature,
           content_hash = EXCLUDED.content_hash, commit_sha = EXCLUDED.commit_sha,
           extracted_by = EXCLUDED.extracted_by, metadata = EXCLUDED.metadata,
           extracted_at = NOW()`,
        values
      );
    }

    // Resolve edge refs against ALL of the project's nodes — cross-extractor
    // edges (ts → db's table nodes) resolve when db ran earlier in this build.
    const byKind = new Map<string, Set<string>>();
    for (const e of edges) {
      for (const ref of [e.from, e.to]) {
        const set = byKind.get(ref.kind) ?? new Set<string>();
        set.add(ref.qualifiedName);
        byKind.set(ref.kind, set);
      }
    }
    const ids = new Map<string, string>();
    for (const [kind, qnames] of byKind) {
      const r = await client.query<{ id: string; qualified_name: string }>(
        `SELECT id, qualified_name FROM graph_nodes
         WHERE project_id = $1 AND kind = $2 AND qualified_name = ANY($3)`,
        [input.projectId, kind, [...qnames]]
      );
      for (const row of r.rows) ids.set(refKey(kind, row.qualified_name), row.id);
    }

    let dropped = 0;
    const resolved: Array<{ fromId: string; toId: string; e: ExtractedEdge }> = [];
    for (const e of edges) {
      const fromId = ids.get(refKey(e.from.kind, e.from.qualifiedName));
      const toId = ids.get(refKey(e.to.kind, e.to.qualifiedName));
      if (!fromId || !toId || fromId === toId) {
        dropped++;
        continue;
      }
      resolved.push({ fromId, toId, e });
    }

    for (let i = 0; i < resolved.length; i += CHUNK) {
      const chunk = resolved.slice(i, i + CHUNK);
      const values: unknown[] = [];
      const rows = chunk.map((r, j) => {
        const b = j * 7;
        values.push(
          input.projectId,
          r.fromId,
          r.toId,
          r.e.relation,
          r.e.confidence ?? 'extracted',
          r.e.weight ?? 1.0,
          JSON.stringify(r.e.metadata ?? {})
        );
        return `($${b + 1}, $${b + 2}, $${b + 3}, $${b + 4}, $${b + 5}, $${b + 6}, $${b + 7}::jsonb)`;
      });
      await client.query(
        `INSERT INTO graph_edges (project_id, from_node, to_node, relation, confidence, weight, metadata)
         VALUES ${rows.join(', ')}
         ON CONFLICT (project_id, from_node, to_node, relation) DO UPDATE SET
           confidence = EXCLUDED.confidence, weight = EXCLUDED.weight, metadata = EXCLUDED.metadata`,
        values
      );
    }

    await client.query('COMMIT');
    return {
      extractor: extractor.name, nodes: nodes.length, edges: resolved.length, droppedEdges: dropped,
      contractSkips: contractSkips(raw),
    };
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

/** Sequential on purpose: later extractors resolve edges against earlier output. */
export async function runExtractors(
  extractors: GraphExtractor[],
  input: ExtractorInput
): Promise<ExtractorRunSummary[]> {
  const summaries: ExtractorRunSummary[] = [];
  for (const ex of extractors) summaries.push(await runExtractor(ex, input));
  return summaries;
}

/** Delete shared-kind nodes (command, …) that no edge touches any more — the
 * staleness companion to the shared-kind splice exemption. Run AFTER all
 * extractors in a build/update. Returns the number removed. */
export async function sweepOrphanSharedNodes(projectId: string): Promise<number> {
  const r = await getPool().query(
    `DELETE FROM graph_nodes n
     WHERE n.project_id = $1 AND n.kind = ANY($2)
       AND (
         (n.kind = 'endpoint' AND NOT EXISTS (
           SELECT 1 FROM graph_edges e
           WHERE e.project_id = n.project_id AND e.project_id = $1
             AND e.to_node = n.id AND e.relation = 'serves_route'
         ))
         OR
         (n.kind <> 'endpoint' AND NOT EXISTS (
           SELECT 1 FROM graph_edges e
           WHERE e.project_id = n.project_id AND e.project_id = $1
             AND (e.from_node = n.id OR e.to_node = n.id)
         ))
       )`,
    [projectId, [...SHARED_KINDS]]
  );
  return r.rowCount ?? 0;
}

export interface SpliceInput extends ExtractorInput {
  /** Absolute paths of files changed since the last extraction. */
  changedFiles: string[];
  /** Absolute paths of files deleted since the last extraction. */
  deletedFiles: string[];
}

export interface SpliceSummary extends ExtractorRunSummary {
  removedNodes: number;
}

/**
 * File-scoped incremental splice (spec §4). The invariant that matters: nodes
 * are UPSERTED by (project, kind, qualified_name), so survivors keep their ids
 * and incoming edges from UNCHANGED files survive. What gets deleted: nodes of
 * deleted files; nodes of changed files that the new extraction no longer
 * emits (removed functions); and changed files' OUTGOING edges (rebuilt below).
 */
export async function spliceExtractor(extractor: GraphExtractor, input: SpliceInput): Promise<SpliceSummary> {
  const raw = await extractor.extract(input);
  validateOutput(extractor, raw);
  const { nodes, edges } = dedupe({
    nodes: withExtractedSourceHashes(raw.nodes), edges: raw.edges,
  });

  const repoShas = new Map<string, string | null>();
  for (const r of input.repoPaths) {
    const resolved = path.resolve(r);
    repoShas.set(resolved, await headSha(resolved));
  }
  const shaFor = shaForFactory(repoShas);

  const client = await getPool().connect();
  try {
    await beginBulkTransaction(client);

    let removed = 0;
    if (input.deletedFiles.length > 0) {
      const r = await client.query(
        `DELETE FROM graph_nodes WHERE project_id = $1 AND file_path = ANY($2)`,
        [input.projectId, input.deletedFiles]
      );
      removed += r.rowCount ?? 0;
    }

    if (input.changedFiles.length > 0) {
      // Outgoing edges of changed files' nodes are rebuilt from the new output.
      await client.query(
        `DELETE FROM graph_edges e USING graph_nodes n
         WHERE e.project_id = $1 AND e.from_node = n.id
           AND n.project_id = $1 AND n.file_path = ANY($2)`,
        [input.projectId, input.changedFiles]
      );

      // Vanished nodes: previously extracted from these files (by this
      // extractor), no longer emitted. Their incoming edges cascade — correct.
      const existing = await client.query<{ id: string; kind: string; qualified_name: string }>(
        `SELECT id, kind, qualified_name FROM graph_nodes
         WHERE project_id = $1 AND extracted_by = $2 AND file_path = ANY($3)`,
        [input.projectId, extractor.name, input.changedFiles]
      );
      const emitted = new Set(nodes.map((n) => refKey(n.kind, n.qualifiedName)));
      const vanished = existing.rows.filter((r) => !emitted.has(refKey(r.kind, r.qualified_name))).map((r) => r.id);
      if (vanished.length > 0) {
        const r = await client.query(`DELETE FROM graph_nodes WHERE id = ANY($1)`, [vanished]);
        removed += r.rowCount ?? 0;
      }
    }

    // Upsert + edge resolution: identical mechanics to the full path.
    for (let i = 0; i < nodes.length; i += CHUNK) {
      const chunk = nodes.slice(i, i + CHUNK);
      const values: unknown[] = [];
      const rows = chunk.map((n, j) => {
        const b = j * 12;
        values.push(
          input.projectId, n.kind, n.name, n.qualifiedName, n.filePath ?? null, n.line ?? null,
          n.lang ?? null, n.signature ?? null, n.contentHash ?? null, shaFor(n.filePath),
          extractor.name, JSON.stringify(n.metadata ?? {})
        );
        return `($${b + 1}, $${b + 2}, $${b + 3}, $${b + 4}, $${b + 5}, $${b + 6}, $${b + 7}, $${b + 8}, $${b + 9}, $${b + 10}, $${b + 11}, $${b + 12}::jsonb)`;
      });
      await client.query(
        `INSERT INTO graph_nodes
           (project_id, kind, name, qualified_name, file_path, line, lang, signature, content_hash, commit_sha, extracted_by, metadata)
         VALUES ${rows.join(', ')}
         ON CONFLICT (project_id, kind, qualified_name) DO UPDATE SET
           name = EXCLUDED.name, file_path = EXCLUDED.file_path, line = EXCLUDED.line,
           lang = EXCLUDED.lang, signature = EXCLUDED.signature,
           content_hash = EXCLUDED.content_hash, commit_sha = EXCLUDED.commit_sha,
           extracted_by = EXCLUDED.extracted_by, metadata = EXCLUDED.metadata,
           extracted_at = NOW()`,
        values
      );
    }

    const byKind = new Map<string, Set<string>>();
    for (const e of edges) {
      for (const ref of [e.from, e.to]) {
        const set = byKind.get(ref.kind) ?? new Set<string>();
        set.add(ref.qualifiedName);
        byKind.set(ref.kind, set);
      }
    }
    const ids = new Map<string, string>();
    for (const [kind, qnames] of byKind) {
      const r = await client.query<{ id: string; qualified_name: string }>(
        `SELECT id, qualified_name FROM graph_nodes
         WHERE project_id = $1 AND kind = $2 AND qualified_name = ANY($3)`,
        [input.projectId, kind, [...qnames]]
      );
      for (const row of r.rows) ids.set(refKey(kind, row.qualified_name), row.id);
    }

    let dropped = 0;
    const resolved: Array<{ fromId: string; toId: string; e: ExtractedEdge }> = [];
    for (const e of edges) {
      const fromId = ids.get(refKey(e.from.kind, e.from.qualifiedName));
      const toId = ids.get(refKey(e.to.kind, e.to.qualifiedName));
      if (!fromId || !toId || fromId === toId) {
        dropped++;
        continue;
      }
      resolved.push({ fromId, toId, e });
    }
    for (let i = 0; i < resolved.length; i += CHUNK) {
      const chunk = resolved.slice(i, i + CHUNK);
      const values: unknown[] = [];
      const rows = chunk.map((r, j) => {
        const b = j * 7;
        values.push(
          input.projectId, r.fromId, r.toId, r.e.relation,
          r.e.confidence ?? 'extracted', r.e.weight ?? 1.0, JSON.stringify(r.e.metadata ?? {})
        );
        return `($${b + 1}, $${b + 2}, $${b + 3}, $${b + 4}, $${b + 5}, $${b + 6}, $${b + 7}::jsonb)`;
      });
      await client.query(
        `INSERT INTO graph_edges (project_id, from_node, to_node, relation, confidence, weight, metadata)
         VALUES ${rows.join(', ')}
         ON CONFLICT (project_id, from_node, to_node, relation) DO UPDATE SET
           confidence = EXCLUDED.confidence, weight = EXCLUDED.weight, metadata = EXCLUDED.metadata`,
        values
      );
    }

    await client.query('COMMIT');
    return {
      extractor: extractor.name, nodes: nodes.length, edges: resolved.length, droppedEdges: dropped,
      removedNodes: removed, contractSkips: contractSkips(raw),
    };
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}
