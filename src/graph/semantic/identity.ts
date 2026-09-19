import type { Pool } from 'pg';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { getPool, loadProjectGraphRoots, type ProjectGraphRoots } from '../../db.js';
import { canonicalPhysicalPath } from '../roots.js';
import type { StableNode } from './types.js';

export interface StoredNode {
  id: string; project_id: string; kind: string; name: string;
  qualified_name: string | null; extracted_by: string; file_path: string | null;
  line: number | null; signature: string | null; lang: string | null;
}
export function stableIdentity(input: {
  projectId: string; kind: string; qualifiedName: string; extractedBy: string; physicalPath: string | null;
}): string {
  return createHash('sha256').update(JSON.stringify(['graph-symbol/1', input.projectId,
    input.kind, input.qualifiedName, input.extractedBy, input.physicalPath])).digest('hex');
}
export function pathWithin(file: string, root: string): boolean {
  const relative = path.relative(root,file);
  return relative === '' || (!path.isAbsolute(relative) && relative !== '..' && !relative.startsWith(`..${path.sep}`));
}
export function eligiblePhysicalPath(raw: string, roots: ProjectGraphRoots): string | null {
  if (!path.isAbsolute(raw)) return null;
  const physical = canonicalPhysicalPath(raw,roots.productRoot);
  if (!roots.repos.some(root => pathWithin(physical,root)) || roots.excludes.some(root => pathWithin(physical,root))) return null;
  return physical;
}
export function fromStoredNode(projectId: string, row: StoredNode, roots: ProjectGraphRoots): StableNode | null {
  if (row.project_id !== projectId || !row.qualified_name?.trim()) return null;
  const physicalPath = row.file_path === null ? null : eligiblePhysicalPath(row.file_path,roots);
  if (row.file_path !== null && physicalPath === null) return null;
  return {
    projectId, identity: stableIdentity({projectId,kind:row.kind,qualifiedName:row.qualified_name,extractedBy:row.extracted_by,physicalPath}),
    nodeId:row.id,kind:row.kind,name:row.name,qualifiedName:row.qualified_name,extractedBy:row.extracted_by,
    physicalPath,line:row.line,signature:row.signature,language:row.lang,
  };
}
export async function identityContext(projectId: string, executor: Pick<Pool, 'query'> = getPool()): Promise<ProjectGraphRoots> {
  return loadProjectGraphRoots(projectId,executor);
}
export async function resolveNode(projectId: string, nodeId: string, executor: Pick<Pool, 'query'> = getPool()): Promise<StableNode | null> {
  const result = await executor.query<StoredNode>(`SELECT id,project_id,kind,name,qualified_name,
    extracted_by,file_path,line,signature,lang FROM graph_nodes WHERE project_id=$1 AND id=$2`, [projectId,nodeId]);
  if (!result.rows[0]) return null;
  const roots = await identityContext(projectId,executor);
  const node = fromStoredNode(projectId,result.rows[0],roots);
  if (!node) return null;
  const siblings = await executor.query<StoredNode>(`SELECT id,project_id,kind,name,qualified_name,
    extracted_by,file_path,line,signature,lang FROM graph_nodes
    WHERE project_id=$1 AND kind=$2 AND qualified_name=$3`, [projectId,node.kind,node.qualifiedName]);
  const matches = siblings.rows.map(row => fromStoredNode(projectId,row,roots)).filter(row => row?.identity === node.identity);
  return matches.length === 1 ? node : null;
}
