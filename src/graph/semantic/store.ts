import { getPool } from '../../db.js';
import type { QueryResult } from 'pg';
import { identityContext, fromStoredNode, type StoredNode } from './identity.js';
import { readPolicy } from './policy.js';
import { buildDocument } from './document.js';
import { resolveNode } from './identity.js';
import { currentVectors, type VectorEvidence } from './cache.js';
import type { CueEmbedding } from './cues.js';
import { modelFor } from './provider.js';
import { SemanticError } from './validation.js';
import { DOCUMENT_VERSION, LIMITS, type StableNode, type CodeDocument } from './types.js';

export interface IndexJob {
  id: string; state: 'running'|'completed'|'partial'|'cancelled'|'failed';
  scanned: number; written: number; reused: number; skipped: number; reason: string|null;
}
export interface CacheRow extends VectorEvidence {
  source_evidence?:unknown; identity: string; document_mode: 'declaration'|'metadata'; indexed_at: Date;
}
export interface RunningJob extends IndexJob { project_id: string; policy_revision: number; model: string; cancel_requested: boolean }
export async function candidateNodes(projectId: string, kind?: string): Promise<{nodes:StableNode[];capped:boolean;skipped:number}> {
  const roots = await identityContext(projectId);
  const found = new Map<string,StableNode>();
  const ambiguous = new Set<string>();
  let after: string|null = null, scanned = 0, skipped = 0, capped = false;
  while (scanned <= LIMITS.corpusNodes) {
    const page: QueryResult<StoredNode> = await getPool().query<StoredNode>(`SELECT id,project_id,kind,name,qualified_name,
      extracted_by,file_path,line,signature,lang FROM graph_nodes
      WHERE project_id=$1 AND ($2::text IS NULL OR kind=$2) AND ($3::uuid IS NULL OR id>$3)
      ORDER BY id LIMIT $4`,[projectId,kind??null,after,Math.min(LIMITS.indexPage,LIMITS.corpusNodes-scanned+1)]);
    if (!page.rows.length) break;
    for (const row of page.rows) {
      after=row.id;
      if (scanned === LIMITS.corpusNodes) { capped=true; break; }
      scanned++;
      const node = fromStoredNode(projectId,row,roots);
      if (!node) { skipped++; continue; }
      if (found.has(node.identity) || ambiguous.has(node.identity)) { skipped+=found.has(node.identity)?2:1;found.delete(node.identity);ambiguous.add(node.identity);continue; }
      found.set(node.identity,node);
    }
    if (capped) break;
  }
  return {nodes:[...found.values()].sort((a,b)=>a.identity.localeCompare(b.identity)),capped,skipped};
}
export async function cacheRows(projectId: string, identities: string[], model: string): Promise<CacheRow[]> {
  if (identities.length > LIMITS.vectorPage) throw new Error('Cache page exceeds bound');
  const result = await getPool().query<CacheRow>(`SELECT identity,model,document_version,fingerprint,source_hash,
    document_mode,source_evidence,embedding,cue_version,cue_fingerprint,cue_embedding,indexed_at FROM graph_code_embeddings WHERE project_id=$1
    AND identity=ANY($2::text[]) AND model=$3 AND document_version=$4`,[projectId,identities,model,DOCUMENT_VERSION]);
  return result.rows;
}
export async function recoverJobs(projectId: string): Promise<void> {
  await getPool().query(`UPDATE graph_code_jobs SET state=CASE WHEN cancel_requested THEN 'cancelled' ELSE 'failed' END,
    reason=CASE WHEN cancel_requested THEN 'cancelled' ELSE 'worker_lost' END,finished_at=now()
    WHERE project_id=$1 AND state='running' AND heartbeat_at<now()-interval '30 seconds'`,[projectId]);
}
export async function latestJob(projectId: string): Promise<IndexJob|null> {
  await recoverJobs(projectId);
  const result = await getPool().query<IndexJob>(`SELECT id,state,scanned,written,reused,skipped,reason
    FROM graph_code_jobs WHERE project_id=$1 ORDER BY created_at DESC,id DESC LIMIT 1`,[projectId]);
  return result.rows[0]??null;
}
export async function reserveJob(projectId: string): Promise<{job:IndexJob;owned:boolean}> {
  await recoverJobs(projectId);
  const client = await getPool().connect();
  try {
    await client.query('BEGIN');
    const projects = await client.query('SELECT id FROM projects WHERE id=$1 FOR UPDATE',[projectId]);
    if (!projects.rowCount) throw new SemanticError('Project not found',404);
    const existing = await client.query<IndexJob>(`SELECT id,state,scanned,written,reused,skipped,reason
      FROM graph_code_jobs WHERE project_id=$1 AND state='running'`,[projectId]);
    if (existing.rows[0]) { await client.query('COMMIT');return {job:existing.rows[0],owned:false}; }
    const policy = await readPolicy(projectId), model = modelFor(policy);
    if (!model) throw new SemanticError('Code embeddings are off',409);
    const result = await client.query<IndexJob>(`INSERT INTO graph_code_jobs(project_id,policy_revision,model,state)
      VALUES($1,$2,$3,'running') RETURNING id,state,scanned,written,reused,skipped,reason`,[projectId,policy.revision,model]);
    await client.query('COMMIT');return {job:result.rows[0],owned:true};
  } catch (error) { await client.query('ROLLBACK').catch(()=>{});throw error; }
  finally { client.release(); }
}
export async function readJob(projectId: string, jobId: string): Promise<RunningJob|null> {
  return (await getPool().query<RunningJob>('SELECT id,project_id,policy_revision,model,state,scanned,written,reused,skipped,reason,cancel_requested FROM graph_code_jobs WHERE project_id=$1 AND id=$2',[projectId,jobId])).rows[0]??null;
}
export async function cancelJob(projectId: string, jobId: string): Promise<IndexJob> {
  const result = await getPool().query<IndexJob>(`UPDATE graph_code_jobs SET cancel_requested=true,
    state=CASE WHEN state='running' THEN 'cancelled' ELSE state END,
    reason=CASE WHEN state='running' THEN 'cancelled' ELSE reason END,
    finished_at=CASE WHEN state='running' THEN now() ELSE finished_at END
    WHERE project_id=$1 AND id=$2 RETURNING id,state,scanned,written,reused,skipped,reason`,[projectId,jobId]);
  if (!result.rows[0]) throw new SemanticError('Job not found',404);
  return result.rows[0];
}
export async function finishJob(projectId: string, jobId: string, state: IndexJob['state'], reason: string|null): Promise<void> {
  await getPool().query(`UPDATE graph_code_jobs SET state=$3,reason=$4,finished_at=now(),heartbeat_at=now()
    WHERE project_id=$1 AND id=$2 AND state='running'`,[projectId,jobId,state,reason]);
}
export async function saveDocument(projectId: string, jobId: string, document: CodeDocument|null, vector: number[]|null, reused: boolean, cue: CueEmbedding|null=null): Promise<void> {
  const client = await getPool().connect();
  try {
    await client.query('BEGIN');
    await client.query('SELECT id FROM projects WHERE id=$1 FOR SHARE',[projectId]);
    const jobs = await client.query<RunningJob>('SELECT id,project_id,policy_revision,model,state,scanned,written,reused,skipped,reason,cancel_requested FROM graph_code_jobs WHERE project_id=$1 AND id=$2 FOR UPDATE',[projectId,jobId]);
    const job=jobs.rows[0], policy=await readPolicy(projectId);
    if (!job || job.state!=='running' || job.cancel_requested || policy.revision!==job.policy_revision || modelFor(policy)!==job.model) {
      throw new SemanticError('Index cancelled or policy changed',409);
    }
    if (document && vector) {
      // Graph replacement/deletion must wait until the current identity check and cache write commit.
      await client.query(`SELECT id FROM graph_nodes WHERE project_id=$1 AND
        (id=$2 OR (kind='file' AND extracted_by=$3 AND file_path=$4)) ORDER BY id FOR SHARE`,
        [projectId,document.node.nodeId,document.node.extractedBy,document.node.physicalPath]);
      const current=await resolveNode(projectId,document.node.nodeId);
      const verified=current?.identity===document.node.identity?await buildDocument(current):null;
      if (!verified || verified.fingerprint!==document.fingerprint || verified.sourceHash!==document.sourceHash
        || verified.mode!==document.mode || !currentVectors({model:job.model,document_version:document.version,
          fingerprint:document.fingerprint,source_hash:document.sourceHash,document_mode:document.mode,embedding:vector,
          cue_version:cue?.version??null,cue_fingerprint:cue?.fingerprint??null,cue_embedding:cue?.embedding??null},verified,job.model)) { document=null;vector=null; } else { document=verified; }
    }
    if (document && vector) {
      await client.query(`INSERT INTO graph_code_embeddings(project_id,identity,model,document_version,fingerprint,source_hash,document_mode,embedding,cue_version,cue_fingerprint,cue_embedding,source_evidence)
        VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12) ON CONFLICT(project_id,identity,model,document_version) DO UPDATE SET
        fingerprint=EXCLUDED.fingerprint,source_hash=EXCLUDED.source_hash,document_mode=EXCLUDED.document_mode,
        embedding=EXCLUDED.embedding,cue_version=EXCLUDED.cue_version,cue_fingerprint=EXCLUDED.cue_fingerprint,
        cue_embedding=EXCLUDED.cue_embedding,source_evidence=EXCLUDED.source_evidence,indexed_at=now()`,[projectId,document.node.identity,job.model,document.version,document.fingerprint,document.sourceHash,document.mode,vector,
          cue?.version??null,cue?.fingerprint??null,cue?.embedding??null,JSON.stringify(document.sourceEvidence)]);
    }
    await client.query(`UPDATE graph_code_jobs SET scanned=scanned+1,written=written+$3,reused=reused+$4,skipped=skipped+$5,heartbeat_at=now()
      WHERE project_id=$1 AND id=$2`,[projectId,jobId,document&&vector&&!reused?1:0,document&&vector&&reused?1:0,document&&vector?0:1]);
    await client.query('COMMIT');
  } catch (error) { await client.query('ROLLBACK').catch(()=>{});throw error; }
  finally { client.release(); }
}
