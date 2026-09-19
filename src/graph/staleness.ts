// The single producer of code freshness: persisted defining text versus current source.
import { getPool } from '../db.js';
import { owningRegisteredRepo } from './contracts.js';
import { headSha } from './engine.js';
import { SourceEvidence, validSourceHash } from './source-evidence.js';

export type StalenessMethod = 'per-file' | 'whole-graph';
export interface SubsystemStaleness { subsystem: string; total: number; stale: number }
export interface RepoStaleness {
  repo: string;
  total: number;
  stale: number;
  bySubsystem: SubsystemStaleness[];
  method: StalenessMethod;
  fallbackReason: string | null;
  head: string | null;
}
export type NodeStaleness = 'fresh' | 'stale' | 'unattributed';
export interface NodeStalenessInput {
  file_path: string | null;
  content_hash: string | null;
  extracted_by: string | null;
}

function nestedExclusionSql(repoParam: number, reposParam: number): string {
  return `AND NOT EXISTS (
             SELECT 1 FROM unnest($${reposParam}::text[]) AS registered(root)
             WHERE length(registered.root) > length($${repoParam})
               AND starts_with(graph_nodes.file_path, registered.root || '/')
           )`;
}

interface Assessment { verdict: NodeStaleness; reason: string | null }

async function assess(
  node: NodeStalenessInput, repos: readonly string[], source: SourceEvidence,
): Promise<Assessment> {
  if (node.file_path === null) return { verdict: 'unattributed', reason: 'no source path' };
  const repo = owningRegisteredRepo(node.file_path, repos);
  if (repo === null) return { verdict: 'unattributed', reason: 'no registered source root' };
  if (!validSourceHash(node.content_hash) || node.extracted_by === null) {
    return { verdict: 'unattributed', reason: 'missing extraction evidence' };
  }
  const current = await source.read(node.file_path, node.extracted_by === 'ts' ? 'typescript' : 'utf8');
  if (current.state === 'unknown') {
    return { verdict: 'unattributed', reason: `source unverified (${current.reason})` };
  }
  return {
    verdict: current.state === 'verified' && current.hash === node.content_hash ? 'fresh' : 'stale',
    reason: null,
  };
}

export async function assessNodeStaleness(
  nodes: readonly NodeStalenessInput[],
  repos: readonly string[],
  source = new SourceEvidence(repos),
): Promise<NodeStaleness[]> {
  // Sequential requests share file promises; the reader also bounds concurrent callers.
  const out: NodeStaleness[] = [];
  for (const node of nodes) out.push((await assess(node, repos, source)).verdict);
  return out;
}

interface SourceGroup extends NodeStalenessInput { subsystem: string | null; total: string }

export async function repoStaleness(
  projectId: string,
  repo: string,
  repos: readonly string[],
  source = new SourceEvidence(repos),
): Promise<RepoStaleness> {
  const head = await headSha(repo); // Observed provenance only, including unborn repositories.
  const rows = await getPool().query<SourceGroup>(
    `SELECT file_path, content_hash, extracted_by,
            split_part(qualified_name, '/', 2) AS subsystem, COUNT(*)::text AS total
       FROM graph_nodes
      WHERE project_id = $1 AND starts_with(file_path, $2 || '/')
        ${nestedExclusionSql(2, 3)}
      GROUP BY file_path, content_hash, extracted_by, split_part(qualified_name, '/', 2)
      ORDER BY file_path, extracted_by, content_hash`,
    [projectId, repo, repos],
  );
  const by = new Map<string, SubsystemStaleness>();
  const reasons = new Set<string>();
  for (const row of rows.rows) {
    const result = await assess(row, repos, source);
    const subsystem = row.subsystem ?? '';
    const counts = by.get(subsystem) ?? { subsystem, total: 0, stale: 0 };
    counts.total += Number(row.total);
    if (result.verdict !== 'fresh') counts.stale += Number(row.total);
    if (result.reason !== null) reasons.add(result.reason);
    by.set(subsystem, counts);
  }
  const bySubsystem = [...by.values()].sort((a, b) => a.subsystem.localeCompare(b.subsystem));
  return {
    repo, head, bySubsystem,
    total: bySubsystem.reduce((sum, item) => sum + item.total, 0),
    stale: bySubsystem.reduce((sum, item) => sum + item.stale, 0),
    method: reasons.size > 0 ? 'whole-graph' : 'per-file',
    fallbackReason: reasons.size > 0 ? [...reasons].sort().join('; ') : null,
  };
}

export async function projectStaleness(
  projectId: string,
  repos: readonly string[],
  source = new SourceEvidence(repos),
): Promise<RepoStaleness[]> {
  const results: RepoStaleness[] = [];
  for (const repo of repos) results.push(await repoStaleness(projectId, repo, repos, source));
  return results;
}
