import { beforeAll, afterAll, afterEach, expect, it, vi } from 'vitest';
import { Pool } from 'pg';
import { mkdtemp, realpath, writeFile, rm } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { createHash } from 'node:crypto';
import { requireDisposableTestDbUrl } from './test-db-url.js';
process.env.MAI_DB_URL=requireDisposableTestDbUrl();
const state=vi.hoisted(()=>({rerank:vi.fn(),close:vi.fn()}));
vi.mock('../graph/semantic/provider.js',async importOriginal=>{
  const original=await importOriginal<typeof import('../graph/semantic/provider.js')>();
  return {...original,createCodeEmbedder:async()=>({model:'local:bge-small-en-v1.5',dimensions:384,
    document:async()=>Array(384).fill(1),cue:async()=>Array(384).fill(1),query:async()=>Array(384).fill(1),
    rerank:state.rerank,close:state.close})};
});
const db=new Pool({connectionString:process.env.MAI_DB_URL});let project='',root='';
const source='export function readOne(){return 1}\nexport function readTwo(){return 2}\n';
beforeAll(async()=>{
  root=await realpath(await mkdtemp(path.join(os.tmpdir(),'semantic-local-')));await writeFile(path.join(root,'code.ts'),source);
  project=(await db.query<{id:string}>('INSERT INTO projects(slug,name,path) VALUES($1,$1,$2) RETURNING id',['semantic-local-ranking',root])).rows[0].id;
  await db.query(`INSERT INTO graph_nodes(project_id,kind,name,qualified_name,extracted_by,file_path,content_hash)
    VALUES($1,'file','code.ts','code.ts','typescript',$2,$3)`,[project,path.join(root,'code.ts'),createHash('sha256').update(source).digest('hex')]);
  for(const [index,name] of ['readOne','readTwo'].entries())await db.query(`INSERT INTO graph_nodes(project_id,kind,name,qualified_name,extracted_by,file_path,line)
    VALUES($1,'function',$2,$2,'typescript',$3,$4)`,[project,name,path.join(root,'code.ts'),index+1]);
  for(let i=0;i<35;i++)await db.query(`INSERT INTO graph_nodes(project_id,kind,name,qualified_name,extracted_by)
    VALUES($1,'class',$2,$2,'fixture')`,[project,'class_'+i]);
  const {reserveJob}=await import('../graph/semantic/store.js'),{runIndex}=await import('../graph/semantic/runtime.js');
  await runIndex(project,(await reserveJob(project)).job.id);
  state.rerank.mockImplementation(async(_query:string,documents:readonly string[])=>documents.map((_,i)=>documents.length-i));
});
afterEach(async()=>{await writeFile(path.join(root,'code.ts'),source);state.rerank.mockClear();state.close.mockReset();state.rerank.mockImplementation(async(_query:string,documents:readonly string[])=>documents.map((_,i)=>documents.length-i));});
afterAll(async()=>{await db.query('DELETE FROM projects WHERE id=$1',[project]);await db.end();await (await import('../db.js')).closePool();await rm(root,{recursive:true,force:true});});
it.each([1,5,10,30])('returns %i current results while keeping the local reranker bounded at eight',async limit=>{
  const {searchRuntime}=await import('../graph/semantic/runtime.js');
  const result=await searchRuntime(project,{query:'load saved state',kind:'class',limit},()=>{});
  expect(result.nodes).toHaveLength(limit);expect(result.nodes.every(hit=>hit.method==='semantic')).toBe(true);
  expect(result.state).toBe('ready');expect(result.coverage.current).toBe(35);
  expect(state.rerank).toHaveBeenCalledOnce();expect(state.rerank.mock.calls[0][1]).toHaveLength(8);
});
it('treats a missing cue as incomplete and preserves the labelled lexical result',async()=>{
  const {searchRuntime}=await import('../graph/semantic/runtime.js'),{candidateNodes,cacheRows}=await import('../graph/semantic/store.js');
  const node=(await candidateNodes(project,'class')).nodes[0],old=(await cacheRows(project,[node.identity],'local:bge-small-en-v1.5'))[0];
  try{
    await db.query('UPDATE graph_code_embeddings SET cue_version=NULL,cue_fingerprint=NULL,cue_embedding=NULL WHERE project_id=$1 AND identity=$2',[project,node.identity]);
    const result=await searchRuntime(project,{query:node.name,kind:'class',limit:5},()=>{});
    expect(result.coverage.current).toBe(34);expect(result.reasons).toContain('stale_source');
    expect(result.nodes.find(hit=>hit.identity===node.identity)).toMatchObject({method:'lexical'});
    expect(result.nodes.filter(hit=>hit.method==='semantic')).toHaveLength(4);
  }finally{await db.query('UPDATE graph_code_embeddings SET cue_version=$3,cue_fingerprint=$4,cue_embedding=$5 WHERE project_id=$1 AND identity=$2',[project,node.identity,old.cue_version,old.cue_fingerprint,old.cue_embedding]);}
});
it('rechecks source after reranking instead of returning a now-dirty declaration',async()=>{
  const {searchRuntime}=await import('../graph/semantic/runtime.js');
  state.rerank.mockImplementationOnce(async()=>{await writeFile(path.join(root,'code.ts'),source+'// changed during inference');return [2,1];});
  const result=await searchRuntime(project,{query:'retrieve a number',kind:'function',limit:5},()=>{});
  expect(state.rerank).toHaveBeenCalledOnce();expect(result.nodes).toEqual([]);
  expect(result.state).toBe('partial');expect(result.reasons).toContain('stale_source');
});
it('returns explicit fallback when the local reranker is unavailable',async()=>{
  const {searchRuntime}=await import('../graph/semantic/runtime.js');state.rerank.mockResolvedValueOnce(null);
  const result=await searchRuntime(project,{query:'readOne',kind:'function',limit:5},()=>{});
  expect(result.state).toBe('fallback');expect(result.reasons).toContain('provider_unavailable');
  expect(result.nodes.every(hit=>hit.method==='lexical')).toBe(true);expect(result.nodes.some(hit=>hit.name==='readOne')).toBe(true);
});

it('closes inference before final source checks while retaining the advisory lease',async()=>{
  const {searchRuntime,acquireLease}=await import('../graph/semantic/runtime.js');
  state.close.mockImplementationOnce(async()=>{
    const lease=await acquireLease(()=>{throw Error('unexpected lease loss');});
    if(lease)await lease.close();expect(lease).toBeNull();
    await writeFile(path.join(root,'code.ts'),source+'// source changed at disposal barrier');
  });
  const result=await searchRuntime(project,{query:'retrieve a number',kind:'function',limit:5},()=>{});
  expect(state.rerank).toHaveBeenCalledOnce();expect(state.close).toHaveBeenCalled();
  expect(result.nodes).toEqual([]);expect(result.state).toBe('partial');expect(result.reasons).toContain('stale_source');
});
