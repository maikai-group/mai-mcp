import { cueEmbedding } from '../graph/semantic/cues.js';
import { beforeAll, afterAll, describe, expect, it } from 'vitest';
import { mkdtemp, writeFile, symlink, rm, realpath } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { createHash } from 'node:crypto';
import { Pool } from 'pg';
import { requireDisposableTestDbUrl } from './test-db-url.js';
const dbUrl=requireDisposableTestDbUrl();process.env.MAI_DB_URL=dbUrl;process.env.MAI_PROJECT_SLUG='semantic-fixture';
const admin=new Pool({connectionString:dbUrl});let root='',projectA='',projectB='',fileId='',nodeId='';
const source='/** persist atomically */\nexport function save(){return "saved"}\nexport function unrelated(){return "private"}\n';
const hash=(text:string)=>createHash('sha256').update(text).digest('hex');
beforeAll(async()=>{
  root=await realpath(await mkdtemp(path.join(os.tmpdir(),'semantic-source-')));await writeFile(path.join(root,'a.ts'),source);
  for(const slug of ['semantic-fixture','semantic-foreign']){
    const result=await admin.query<{id:string}>('INSERT INTO projects(slug,name,path) VALUES($1,$1,$2) RETURNING id',[slug,root]);
    if(slug==='semantic-fixture')projectA=result.rows[0].id;else projectB=result.rows[0].id;
  }
  fileId=(await admin.query<{id:string}>(`INSERT INTO graph_nodes(project_id,kind,name,qualified_name,extracted_by,file_path,content_hash)
    VALUES($1,'file','a.ts','a.ts','typescript',$2,$3) RETURNING id`,[projectA,path.join(root,'a.ts'),hash(source)])).rows[0].id;
  nodeId=(await admin.query<{id:string}>(`INSERT INTO graph_nodes(project_id,kind,name,qualified_name,extracted_by,file_path,line,signature)
    VALUES($1,'function','save','a.ts#save','typescript',$2,2,'save(): string') RETURNING id`,[projectA,path.join(root,'a.ts')])).rows[0].id;
});
afterAll(async()=>{
  await admin.query('DELETE FROM projects WHERE id=ANY($1::uuid[])',[[projectA,projectB].filter(Boolean)]);
  await admin.end();const {closePool}=await import('../db.js');await closePool();if(root)await rm(root,{recursive:true,force:true});
});
describe('semantic identity, source and policy integration',()=>{
  it('resolves only the selected project and verifies the owning file hash',async()=>{
    const {resolveNode}=await import('../graph/semantic/identity.js');const {buildDocument}=await import('../graph/semantic/document.js');
    expect(await resolveNode(projectB,nodeId)).toBeNull();
    const node=await resolveNode(projectA,nodeId);if(!node)throw new Error('fixture node missing');
    const document=await buildDocument(node);expect(document?.mode).toBe('declaration');expect(document?.text).toContain('persist atomically');
    expect(document?.text).not.toContain('unrelated');expect(document?.sourceHash).toBe(hash(source));
    await writeFile(path.join(root,'a.ts'),source+'// changed');expect(await buildDocument(node)).toBeNull();await writeFile(path.join(root,'a.ts'),source);
  });
  it('preserves identity across UUID replacement and separates project/rename/remap',async()=>{
    const {resolveNode,stableIdentity}=await import('../graph/semantic/identity.js');const before=await resolveNode(projectA,nodeId);if(!before)throw new Error('missing fixture');
    const old=nodeId;
    nodeId=(await admin.query<{id:string}>('UPDATE graph_nodes SET id=gen_random_uuid() WHERE id=$1 RETURNING id',[nodeId])).rows[0].id;
    const after=await resolveNode(projectA,nodeId);expect(nodeId).not.toBe(old);expect(after?.identity).toBe(before.identity);
    for(const patch of [{projectId:projectB},{qualifiedName:'a.ts#renamed'},{physicalPath:path.join(root,'moved.ts')},{extractedBy:'other'}]){
      expect(stableIdentity({...before,...patch})).not.toBe(before.identity);
    }
  });
  it('rejects missing, escaped and oversized files without caching content',async()=>{
    const {resolveNode}=await import('../graph/semantic/identity.js');const {buildDocument}=await import('../graph/semantic/document.js');
    const node=await resolveNode(projectA,nodeId);if(!node)throw new Error('missing fixture');
    expect(await buildDocument({...node,physicalPath:path.join(root,'missing.ts')})).toBeNull();
    const outside=await mkdtemp(path.join(os.tmpdir(),'semantic-outside-'));
    try{
      await writeFile(path.join(outside,'secret.ts'),source);await symlink(path.join(outside,'secret.ts'),path.join(root,'escape.ts'));
      expect(await buildDocument({...node,physicalPath:path.join(root,'escape.ts')})).toBeNull();
    }finally{await rm(outside,{recursive:true,force:true});}
    await writeFile(path.join(root,'a.ts'),'x'.repeat(2*1024*1024+1));expect(await buildDocument(node)).toBeNull();await writeFile(path.join(root,'a.ts'),source);
  });
  it('will not use a foreign file hash or pathless signature as source authority',async()=>{
    const {resolveNode}=await import('../graph/semantic/identity.js');const {buildDocument}=await import('../graph/semantic/document.js');
    const node=await resolveNode(projectA,nodeId);if(!node)throw new Error('missing fixture');
    await admin.query('UPDATE graph_nodes SET project_id=$2 WHERE id=$1',[fileId,projectB]);expect(await buildDocument(node)).toBeNull();
    await admin.query('UPDATE graph_nodes SET project_id=$2 WHERE id=$1',[fileId,projectA]);
    const metadata=await buildDocument({...node,physicalPath:null,signature:'private arbitrary signature'});
    expect(metadata?.mode).toBe('metadata');expect(metadata?.text).not.toContain('private arbitrary');
  });
  it.each(['openai','voyage'])('SQL insert and update reject NULL consent for %s',async provider=>{
    await expect(admin.query('INSERT INTO graph_code_policy(project_id,provider,consent_version) VALUES($1,$2,NULL)',[projectB,provider])).rejects.toMatchObject({code:'23514'});
    await admin.query("INSERT INTO graph_code_policy(project_id,provider) VALUES($1,'local') ON CONFLICT(project_id) DO NOTHING",[projectB]);
    await expect(admin.query('UPDATE graph_code_policy SET provider=$2,consent_version=NULL WHERE project_id=$1',[projectB,provider])).rejects.toMatchObject({code:'23514'});
    await admin.query('DELETE FROM graph_code_policy WHERE project_id=$1',[projectB]);
  });
  it('commits only current documents, reuses vectors and distinguishes declaration coverage',async()=>{
    const {reserveJob,saveDocument,cancelJob}=await import('../graph/semantic/store.js');
    const {resolveNode}=await import('../graph/semantic/identity.js');const {buildDocument}=await import('../graph/semantic/document.js');
    const {currentCoverage}=await import('../graph/semantic/runtime.js');
    const node=await resolveNode(projectA,nodeId);if(!node)throw new Error('missing node');
    const document=await buildDocument(node);if(!document)throw new Error('missing document');
    const reservation=await reserveJob(projectA),vector=Array(384).fill(1);
    await saveDocument(projectA,reservation.job.id,document,vector,false,cueEmbedding(document,vector));
    await saveDocument(projectA,reservation.job.id,document,vector,true,cueEmbedding(document,vector));
    const coverage=await currentCoverage(projectA,'local:bge-small-en-v1.5',Infinity);
    expect(coverage.declaration).toEqual({eligible:1,current:1});expect(coverage.complete).toBe(true);
    await writeFile(path.join(root,'a.ts'),source+'// dirty');
    await saveDocument(projectA,reservation.job.id,document,vector,false,cueEmbedding(document,vector));
    const counts=await admin.query('SELECT written,reused,skipped FROM graph_code_jobs WHERE id=$1',[reservation.job.id]);
    expect(counts.rows[0]).toEqual({written:1,reused:1,skipped:1});
    expect((await currentCoverage(projectA,'local:bge-small-en-v1.5',Infinity)).declaration.current).toBe(0);
    await writeFile(path.join(root,'a.ts'),source);
    await admin.query('UPDATE graph_nodes SET id=gen_random_uuid() WHERE id=$1',[nodeId]);
    await saveDocument(projectA,reservation.job.id,document,vector,false,cueEmbedding(document,vector));
    nodeId=(await admin.query<{id:string}>("SELECT id FROM graph_nodes WHERE project_id=$1 AND kind='function'",[projectA])).rows[0].id;
    expect((await currentCoverage(projectA,'local:bge-small-en-v1.5',Infinity)).declaration.current).toBe(1);
    await cancelJob(projectA,reservation.job.id);
    await expect(saveDocument(projectA,reservation.job.id,document,vector,false,cueEmbedding(document,vector))).rejects.toMatchObject({status:409});
  });
  it('does not disguise an unknown selected project as provider fallback',async()=>{
    const {scopedSearch}=await import('../graph/semantic/service.js');
    await expect(scopedSearch({slug:'semantic-missing-project'},{query:'save'})).rejects.toMatchObject({status:404});
  });
  it('serializes job reservations and cancels an old policy revision',async()=>{
    const {reserveJob}=await import('../graph/semantic/store.js');const {changePolicy}=await import('../graph/semantic/policy.js');
    const [a,b]=await Promise.all([reserveJob(projectA),reserveJob(projectA)]);expect(a.job.id).toBe(b.job.id);expect([a.owned,b.owned].filter(Boolean)).toHaveLength(1);
    const changed=await changePolicy(projectA,{provider:'off',expectedRevision:0});expect(changed).toEqual({provider:'off',revision:1,consentVersion:null});
    const jobs=await admin.query<{cancel_requested:boolean}>('SELECT cancel_requested FROM graph_code_jobs WHERE id=$1',[a.job.id]);expect(jobs.rows[0].cancel_requested).toBe(true);
    await expect(changePolicy(projectA,{provider:'local',expectedRevision:0})).rejects.toMatchObject({status:409});
  });
  it('real child search preserves scoped lexical fallback while off',async()=>{
    const {searchCode}=await import('../graph/semantic/service.js');
    const result=await searchCode(projectA,{query:'save',limit:10});expect(result.reasons).toContain('off');expect(result.nodes.map(row=>row.id)).toContain(nodeId);
    expect(result.nodes.every(row=>row.method==='lexical'&&row.freshness.state==='unverified')).toBe(true);
  });
});

it.each([
  ['python',true],['python',false],['ts',true],['ts',false],
] as const)('preserves %s extractor hash conventions with BOM=%s through indexing and cached reads',async(extractorName,bom)=>{
  const {runExtractor}=await import('../graph/engine.js');
  const {pythonExtractor}=await import('../graph/extractors/python.js');
  const {tsExtractor}=await import('../graph/extractors/ts.js');
  const {candidateNodes,reserveJob,saveDocument,cacheRows,cancelJob}=await import('../graph/semantic/store.js');
  const {buildDocument,buildCachedDocument}=await import('../graph/semantic/document.js');
  const directory=await realpath(await mkdtemp(path.join(os.tmpdir(),'semantic-bom-')));
  const isTs=extractorName==='ts',file=path.join(directory,isTs?'source.ts':'source.py');
  const body=isTs?'export function bomSave(){return 1}\n':'def bomSave():\n    return 1\n';
  const contents=(bom?'\ufeff':'')+body;
  const project=(await admin.query<{id:string}>('INSERT INTO projects(slug,name,path) VALUES($1,$1,$2) RETURNING id',
    [`semantic-bom-${extractorName}-${bom}`,directory])).rows[0].id;
  try{
    await writeFile(file,contents);
    await runExtractor(isTs?tsExtractor:pythonExtractor,{projectId:project,repoPaths:[directory]});
    const node=(await candidateNodes(project)).nodes.find(node=>node.name==='bomSave'&&node.kind==='function');
    if(!node)throw Error('Extracted BOM fixture missing');
    expect(node.extractedBy).toBe(extractorName);
    const document=await buildDocument(node);
    expect(document).not.toBeNull();
    if(!document)throw Error('Unchanged source rejected');
    expect(document.sourceHash).toBe(hash(isTs?body:contents));
    expect(document.mode).toBe(isTs?'declaration':'metadata');
    const {job}=await reserveJob(project),vector=Array(384).fill(1);
    await saveDocument(project,job.id,document,vector,false,cueEmbedding(document,vector));
    const cached=(await cacheRows(project,[node.identity],'local:bge-small-en-v1.5'))[0];
    expect(cached).toBeDefined();
    expect(await buildCachedDocument(node,cached)).toEqual(document);
    await writeFile(file,contents.replace('return 1','return 2'));
    expect(await buildDocument(node)).toBeNull();
    expect(await buildCachedDocument(node,cached)).toBeNull();
    await cancelJob(project,job.id);
  }finally{
    await admin.query('DELETE FROM projects WHERE id=$1',[project]);
    await rm(directory,{recursive:true,force:true});
  }
});
