import { afterAll, expect, it, vi } from 'vitest';
import { Pool } from 'pg';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { requireDisposableTestDbUrl } from './test-db-url.js';
process.env.MAI_DB_URL=requireDisposableTestDbUrl();
const state=vi.hoisted(()=>({documents:0}));
vi.mock('../graph/semantic/provider.js',async importOriginal=>{
  const original=await importOriginal<typeof import('../graph/semantic/provider.js')>();
  return {...original,createCodeEmbedder:async(policy:import('../graph/semantic/types.js').CodePolicy)=>{
    const model=original.modelFor(policy);if(!model)return null;
    const dimensions=policy.provider==='local'?384:1024;
    const embed=async()=>{state.documents++;return Array(dimensions).fill(1);};
    return {model,dimensions,document:embed,cue:embed,query:async()=>Array(dimensions).fill(1),
      rerank:async(_query:string,documents:readonly string[])=>documents.map((_,i)=>documents.length-i),close:async()=>{}};
  }};
});
const db=new Pool({connectionString:process.env.MAI_DB_URL});
afterAll(async()=>{await db.end();await (await import('../db.js')).closePool();vi.unstubAllEnvs();});
it.each(['local','voyage'] as const)('treats rejected %s cache evidence as stale and repairs it by reindexing without redundant embeddings',async provider=>{
  const {runIndex,currentCoverage,searchRuntime}=await import('../graph/semantic/runtime.js');
  const {reserveJob,readJob,candidateNodes,cacheRows}=await import('../graph/semantic/store.js');
  const {buildCachedDocument}=await import('../graph/semantic/document.js');
  const {changePolicy}=await import('../graph/semantic/policy.js');
  const root=await mkdtemp(path.join(os.tmpdir(),'span-evidence-'));
  const project=(await db.query<{id:string}>('INSERT INTO projects(slug,name,path) VALUES($1,$1,$2) RETURNING id',['span-evidence-'+provider,root])).rows[0].id;
  try{
    if(provider==='voyage'){
      vi.stubEnv('VOYAGE_API_KEY','fixture-only-never-sent');
      await changePolicy(project,{provider,expectedRevision:0,acknowledgeCodeUpload:true});
    }
    const dimensions=provider==='local'?384:1024,model=provider==='local'?'local:bge-small-en-v1.5':'voyage-3';
    for(let i=0;i<6;i++)await db.query(`INSERT INTO graph_nodes(project_id,kind,name,qualified_name,extracted_by)
      VALUES($1,'function',$2,$2,'fixture')`,[project,i===5?'needle':'winner'+i]);
    const index=async()=>{const {job}=await reserveJob(project);await runIndex(project,job.id);return readJob(project,job.id);};
    expect((await index())?.state).toBe('completed');
    const nodes=(await candidateNodes(project)).nodes,needle=nodes.find(node=>node.name==='needle');
    if(!needle)throw Error('needle missing');
    const initial=(await cacheRows(project,[needle.identity],model))[0];
    const low=Array(dimensions).fill(0);low[0]=1;
    await db.query('UPDATE graph_code_embeddings SET embedding=$3,cue_embedding=CASE WHEN cue_embedding IS NULL THEN NULL ELSE $3::double precision[] END WHERE project_id=$1 AND identity=$2',[project,needle.identity,low]);
    for(const bad of [null,{version:'source-span/0'}, {version:'source-span/1',name:'wrong',line:null,start:null,end:null}]){
      await db.query('UPDATE graph_code_embeddings SET source_evidence=$3::jsonb WHERE project_id=$1 AND identity=$2',[project,needle.identity,JSON.stringify(bad)]);
      expect(await buildCachedDocument(needle,(await cacheRows(project,[needle.identity],model))[0])).toBeNull();
      const coverage=await currentCoverage(project,model,Infinity);
      expect(coverage).toMatchObject({complete:true,eligible:6,current:5,metadata:{eligible:6,current:5}});
      const result=await searchRuntime(project,{query:'needle',limit:5},()=>{});
      expect(result.state).toBe('partial');expect(result.reasons).toContain('stale_source');
      expect(result.nodes).toHaveLength(5);
      expect(result.nodes.filter(node=>node.method==='semantic')).toHaveLength(4);
      expect(result.nodes[4]).toMatchObject({name:'needle',method:'lexical'});
      const before=state.documents,repaired=await index();
      expect(repaired).toMatchObject({state:'completed',written:0,reused:6});expect(state.documents).toBe(before);
      expect((await currentCoverage(project,model,Infinity)).current).toBe(6);
      const restored=(await cacheRows(project,[needle.identity],model))[0];
      expect(restored.source_evidence).toEqual(initial.source_evidence);
      expect(await buildCachedDocument(needle,restored)).not.toBeNull();
    }
  }finally{await db.query('DELETE FROM projects WHERE id=$1',[project]);await rm(root,{recursive:true,force:true});}
});
