import { beforeAll, afterAll, expect, it, vi } from 'vitest';
import { Pool } from 'pg';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { requireDisposableTestDbUrl } from './test-db-url.js';
process.env.MAI_DB_URL=requireDisposableTestDbUrl();
const state=vi.hoisted(()=>({fail:false,calls:0,clock:0,tick:false}));
vi.mock('../graph/semantic/provider.js',async importOriginal=>{
  const original=await importOriginal<typeof import('../graph/semantic/provider.js')>();
  return {...original,createCodeEmbedder:async(policy:import('../graph/semantic/types.js').CodePolicy)=>{
    const model=original.modelFor(policy);if(!model)return null;const dimensions=policy.provider==='local'?384:policy.provider==='voyage'?1024:1536;
    const embed=async()=>{state.calls++;return state.fail?null:Array(dimensions).fill(1);};
    return {model,dimensions,document:embed,cue:embed,query:async()=>Array(dimensions).fill(1),
      rerank:async(_query:string,documents:readonly string[])=>documents.map((_,i)=>documents.length-i),close:async()=>{}};
  }};
});
vi.mock('../graph/semantic/document.js',async importOriginal=>{
  const original=await importOriginal<typeof import('../graph/semantic/document.js')>();
  return {...original,buildDocument:async(node:import('../graph/semantic/types.js').StableNode)=>{
    if(state.tick)state.clock+=400;
    return original.buildDocument(node);
  },buildCachedDocument:async(...args:Parameters<typeof original.buildCachedDocument>)=>{
    if(state.tick)state.clock+=400;
    return original.buildCachedDocument(...args);
  }};
});
const db=new Pool({connectionString:process.env.MAI_DB_URL});let root='',project='';
beforeAll(async()=>{root=await mkdtemp(path.join(os.tmpdir(),'semantic-lifecycle-'));await writeFile(path.join(root,'a.ts'),'export function keep(){return 1}\nexport function remove(){return 2}\n');project=(await db.query<{id:string}>('INSERT INTO projects(slug,name,path) VALUES($1,$1,$2) RETURNING id',['semantic-lifecycle',root])).rows[0].id;});
afterAll(async()=>{await db.query('DELETE FROM projects WHERE id=$1',[project]);await db.end();await (await import('../db.js')).closePool();await rm(root,{recursive:true,force:true});vi.unstubAllEnvs();});
it('indexes, reuses full rebuilds, invalidates source/model and excludes deleted current nodes',async()=>{
  const {runExtractor}=await import('../graph/engine.js'),{tsExtractor}=await import('../graph/extractors/ts.js');
  const {runIndex,currentCoverage,searchRuntime}=await import('../graph/semantic/runtime.js');
  const {reserveJob,readJob}=await import('../graph/semantic/store.js');const {changePolicy}=await import('../graph/semantic/policy.js');
  const extract=()=>runExtractor(tsExtractor,{projectId:project,repoPaths:[root]});
  const index=async()=>{const {job}=await reserveJob(project);await runIndex(project,job.id);return readJob(project,job.id);};
  await extract();const first=await index();expect(first?.state).toBe('completed');expect(first?.written).toBeGreaterThanOrEqual(3);
  const ids=(await db.query<{id:string}>('SELECT id FROM graph_nodes WHERE project_id=$1 ORDER BY id',[project])).rows.map(row=>row.id);const calls=state.calls;
  await extract();const newIds=(await db.query<{id:string}>('SELECT id FROM graph_nodes WHERE project_id=$1 ORDER BY id',[project])).rows.map(row=>row.id);expect(newIds).not.toEqual(ids);
  const rebuilt=await index();expect(rebuilt?.state).toBe('completed');expect(rebuilt?.written).toBe(0);expect(rebuilt?.reused).toBe(first?.written);expect(state.calls).toBe(calls);
  await writeFile(path.join(root,'a.ts'),'export function keep(){return 99}\nexport function remove(){return 2}\n');expect((await currentCoverage(project,'local:bge-small-en-v1.5',Infinity)).current).toBeLessThan(first?.written??0);
  await extract();expect((await index())?.written).toBeGreaterThan(0);
  vi.stubEnv('VOYAGE_API_KEY','fixture-only-never-sent');await changePolicy(project,{provider:'voyage',expectedRevision:0,acknowledgeCodeUpload:true});expect((await currentCoverage(project,'voyage-3',Infinity)).current).toBe(0);
  const switched=await index();expect(switched?.state).toBe('completed');expect(switched?.reused).toBe(0);expect(switched?.written).toBeGreaterThan(0);
  const deleted=(await db.query<{id:string}>('DELETE FROM graph_nodes WHERE project_id=$1 AND name=$2 RETURNING id',[project,'remove'])).rows[0].id;
  const found=await searchRuntime(project,{query:'remove',limit:10},()=>{});expect(found.nodes.some(row=>row.id===deleted)).toBe(false);expect(found.nodes.some(row=>row.name==='remove')).toBe(false);
});
it('resumes retained partial work after provider failure, cancellation and an expired worker job',async()=>{
  const {runIndex}=await import('../graph/semantic/runtime.js');const {reserveJob,readJob,cancelJob,saveDocument,candidateNodes,latestJob}=await import('../graph/semantic/store.js');const {buildDocument}=await import('../graph/semantic/document.js');
  await db.query('DELETE FROM graph_code_embeddings WHERE project_id=$1',[project]);state.fail=true;let reservation=await reserveJob(project);await runIndex(project,reservation.job.id);expect((await readJob(project,reservation.job.id))?.state).toBe('partial');state.fail=false;
  reservation=await reserveJob(project);const node=(await candidateNodes(project)).nodes[0],doc=await buildDocument(node);if(!doc)throw Error('document absent');await saveDocument(project,reservation.job.id,doc,Array(1024).fill(1),false);
  expect((await cancelJob(project,reservation.job.id)).state).toBe('cancelled');await runIndex(project,reservation.job.id);expect((await readJob(project,reservation.job.id))?.scanned).toBe(1);
  reservation=await reserveJob(project);await runIndex(project,reservation.job.id);const resumed=await readJob(project,reservation.job.id);expect(resumed?.state).toBe('completed');expect(resumed?.reused).toBeGreaterThanOrEqual(1);
  reservation=await reserveJob(project);await db.query("UPDATE graph_code_jobs SET heartbeat_at=now()-interval '31 seconds' WHERE id=$1",[reservation.job.id]);expect((await latestJob(project))?.state).toBe('failed');
  reservation=await reserveJob(project);await runIndex(project,reservation.job.id);expect((await readJob(project,reservation.job.id))?.state).toBe('completed');
});

it('keeps five verified winners through coverage timeout but reserves for an actually missing lexical cache row',async()=>{
  const {runIndex,searchRuntime}=await import('../graph/semantic/runtime.js');
  const {reserveJob,candidateNodes}=await import('../graph/semantic/store.js');
  const {changePolicy}=await import('../graph/semantic/policy.js');
  await changePolicy(project,{provider:'local',expectedRevision:1});
  await db.query('DELETE FROM graph_nodes WHERE project_id=$1',[project]);
  for(let i=0;i<6;i++)await db.query(`INSERT INTO graph_nodes(project_id,kind,name,qualified_name,extracted_by)
    VALUES($1,'function',$2,$2,'fixture')`,[project,i===5?'needle':'winner'+i]);
  const {job}=await reserveJob(project);await runIndex(project,job.id);
  const nodes=(await candidateNodes(project)).nodes;
  for(const node of nodes){
    const value=Array(384).fill(0);value[0]=node.name==='needle'?.01:1;value[1]=node.name==='needle'?1:.1;
    // Both first-stage channels use this controlled vector: all five winners outrank needle.
    if(node.name!=='needle')value.fill(1);
    await db.query('UPDATE graph_code_embeddings SET embedding=$3,cue_embedding=$3 WHERE project_id=$1 AND identity=$2',[project,node.identity,value]);
  }
  const clock=vi.spyOn(performance,'now').mockImplementation(()=>state.clock);state.tick=true;
  try{
    const complete=await searchRuntime(project,{query:'needle',limit:5},()=>{});
    expect(complete.coverage.complete).toBe(false);expect(complete.reasons).toContain('coverage_incomplete');
    expect(complete.reasons).not.toContain('stale_source');
    expect(complete.nodes).toHaveLength(5);expect(complete.nodes.every(hit=>hit.method==='semantic'&&hit.name.startsWith('winner'))).toBe(true);
    const needle=nodes.find(node=>node.name==='needle');if(!needle)throw Error('missing needle');
    await db.query('DELETE FROM graph_code_embeddings WHERE project_id=$1 AND identity=$2',[project,needle.identity]);
    const partial=await searchRuntime(project,{query:'needle',limit:5},()=>{});
    expect(partial.nodes).toHaveLength(5);expect(partial.nodes.filter(hit=>hit.method==='semantic')).toHaveLength(4);
    expect(partial.nodes[4]).toMatchObject({name:'needle',method:'lexical'});
  }finally{state.tick=false;clock.mockRestore();}
});
