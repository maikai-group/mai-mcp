import { beforeAll, afterAll, expect, it } from 'vitest';
import { Pool } from 'pg';
import { mkdtemp, rm } from 'node:fs/promises';
import { spawn, execFile } from 'node:child_process';
import { once } from 'node:events';
import { promisify } from 'node:util';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { requireDisposableTestDbUrl } from './test-db-url.js';
process.env.MAI_DB_URL=requireDisposableTestDbUrl();process.env.MAI_PROJECT_SLUG='semantic-adapter-a';process.env.MAI_EMBEDDINGS='0';
const root=await mkdtemp(path.join(os.tmpdir(),'semantic-adapters-'));process.env.MAI_BRAIN_ROOT=root;
const db=new Pool({connectionString:process.env.MAI_DB_URL});let a='',b='',nodeA='',nodeB='';
beforeAll(async()=>{
  for(const [slug,suffix] of [['semantic-adapter-a','A'],['semantic-adapter-b','B']]){
    const id=(await db.query<{id:string}>('INSERT INTO projects(slug,name,path) VALUES($1,$1,$2) RETURNING id',[slug,root])).rows[0].id;
    const node=(await db.query<{id:string}>("INSERT INTO graph_nodes(project_id,kind,name,qualified_name,extracted_by) VALUES($1,'function',$2,$2,'fixture') RETURNING id",[id,'needle'+suffix])).rows[0].id;
    await db.query("INSERT INTO graph_code_policy(project_id,provider) VALUES($1,'off')",[id]);
    if(suffix==='A'){a=id;nodeA=node;}else{b=id;nodeB=node;}
  }
});
afterAll(async()=>{await db.query('DELETE FROM projects WHERE id=ANY($1::uuid[])',[[a,b]]);await db.end();await (await import('../db.js')).closePool();await rm(root,{recursive:true,force:true});});
it('uses the actual MCP graph-find dispatch, preserves lexical default and rejects scope overrides',async()=>{
  const {buildServer}=await import('../index.js');const {Client,InMemoryTransport}=await import('@modelcontextprotocol/client');
  const client=new Client({name:'semantic-boundary',version:'1'}),server=buildServer(async()=>''),[ct,st]=InMemoryTransport.createLinkedPair();
  try{
    await Promise.all([server.connect(st),client.connect(ct)]);
    const result=await client.callTool({name:'mai_graph_find',arguments:{query:'needle',mode:'semantic',limit:1}});
    const wire=JSON.stringify(result);expect(wire).toContain(nodeA);expect(wire).not.toContain(nodeB);expect(wire).toContain('off');expect(wire.length).toBeLessThan(6500);
    const lexical=await client.callTool({name:'mai_graph_find',arguments:{query:'needle',limit:1}});expect(JSON.stringify(lexical)).toContain(nodeA);expect(JSON.stringify(lexical)).not.toContain('Semantic search');
    const bad=await client.callTool({name:'mai_graph_find',arguments:{query:'needle',mode:'semantic',project:'semantic-adapter-b'}});expect(bad.isError).toBe(true);expect(JSON.stringify(bad)).not.toContain(nodeB);
  }finally{await client.close();await server.close();}
});
it('invokes semanticCli and the real CLI registry with explicit project scope and strict operands',async()=>{
  const {semanticCli}=await import('../graph/semantic/cli.js');
  const args={verb:'graph',positional:['semantic','search','needle'],flags:{project:'semantic-adapter-b',limit:'1'}};
  const result=JSON.parse(await semanticCli(args));expect(result.nodes.map((r:{id:string})=>r.id)).toEqual([nodeB]);expect(result.reasons).toEqual(['off']);
  for(const flags of [{...args.flags,unknown:true as const},{...args.flags,limit:'0'}])await expect(semanticCli({...args,flags})).rejects.toThrow();
  const command=await promisify(execFile)(process.execPath,['build/entry.js','graph','semantic','search','needle','--project','semantic-adapter-b','--limit','1'],{cwd:process.cwd(),env:process.env,timeout:10000});
  const publicResult=JSON.parse(command.stdout);expect(publicResult.nodes.map((r:{id:string})=>r.id)).toEqual([nodeB]);
});
it('invokes registered HTTP GET/POST handlers and the mounted server routes',async()=>{
  const {createSemanticGetHandlers,createSemanticPostHandlers}=await import('../graph/semantic/http.js');
  const get=createSemanticGetHandlers(),post=createSemanticPostHandlers();
  expect(Object.keys(get).sort()).toEqual(['/api/graph/semantic/search','/api/graph/semantic/status']);
  expect(Object.keys(post).sort()).toEqual(['/api/graph/semantic/cancel','/api/graph/semantic/index','/api/graph/semantic/policy']);
  const url=new URL('http://127.0.0.1/api/graph/semantic/search?project=semantic-adapter-b&q=needle&limit=1');
  const direct=await get[url.pathname](url);expect(JSON.stringify(direct)).toContain(nodeB);expect(JSON.stringify(direct)).not.toContain(nodeA);
  await expect(get[url.pathname](new URL(url.href+'&project=semantic-adapter-a'))).rejects.toThrow();
  const allocation=net.createServer();allocation.listen(0,'127.0.0.1');await once(allocation,'listening');const address=allocation.address();if(!address||typeof address==='string')throw Error('port absent');const port=address.port;await new Promise<void>((resolve,reject)=>allocation.close(error=>error?reject(error):resolve()));
  const child=spawn(process.execPath,['build/web-server.js'],{env:{...process.env,MAI_BRAIN_WEB_PORT:String(port),MAI_BRAIN_WEB_BIND:'127.0.0.1'},stdio:['ignore','pipe','pipe']});const closed=once(child,'close');
  try{
    await new Promise<void>((resolve,reject)=>{const timer=setTimeout(()=>reject(Error('server startup deadline')),5000);child.once('exit',()=>{clearTimeout(timer);reject(Error('server exited before ready'));});child.stdout.on('data',chunk=>{if(String(chunk).includes('listening on')){clearTimeout(timer);resolve();}});});
    const base='http://127.0.0.1:'+port;
    const response=await fetch(base+url.pathname+url.search);expect(response.status).toBe(200);expect(await response.json()).toEqual({ok:true,...direct});
    const status=await fetch(base+'/api/graph/semantic/status?project=semantic-adapter-b');expect(status.status).toBe(200);expect((await status.json()).policy.revision).toBe(1);
    const policy=await fetch(base+'/api/graph/semantic/policy?project=semantic-adapter-b',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({provider:'off',expectedRevision:1})});expect(policy.status).toBe(200);
    for(const action of ['index','cancel']){const response=await fetch(base+'/api/graph/semantic/'+action+'?project=semantic-adapter-b',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(action==='cancel'?{job_id:'not-uuid'}:{})});expect(response.status).toBe(action==='index'?409:400);}
    expect((await fetch(base+'/api/graph/semantic/search?project=missing&q=needle')).status).toBe(404);
  }finally{child.kill('SIGKILL');await closed;}
});

it('budgets ten full semantic hits atomically and preserves JSON under escaped coordination nudges',async()=>{
  const {budgetSearchResult}=await import('../graph/semantic/service.js');
  const {pageBudget,finalizeToolResult,READ_CHAR_BUDGET}=await import('../read-budget.js');
  const {emptySearch}=await import('../graph/semantic/response.js');
  const hit:import('../graph/semantic/types.js').CodeHit={id:nodeA,identity:'i'.repeat(64),name:'quoted"name',kind:'function',qualified_name:'qualified.'.repeat(35),file_path:'/repository/'+('path/'.repeat(50))+'file.ts',line:2147483647,method:'semantic',document_mode:'declaration',score:.123456789,excerpt:'"\\\n'.repeat(120),freshness:{state:'verified',source_hash:'s'.repeat(64),document_fingerprint:'f'.repeat(64),document_version:'code-symbol/1',indexed_at:'2026-09-09T12:00:00.000Z',verified_at:'2026-09-09T12:00:01.000Z'}};
  const result={...emptySearch('coverage_incomplete'),nodes:Array.from({length:10},(_,i)=>({...hit,name:hit.name+i}))};
  for(const nudge of ['', 'board update', '\u0001"\\'.repeat(1000)]){
    const prepared=budgetSearchResult(result,pageBudget());
    const wire=finalizeToolResult('mai_graph_find',prepared,nudge);
    const text=wire.content.map(block=>block.text).join('\n\n');
    const parsed=JSON.parse(text);
    expect(text.length).toBeLessThanOrEqual(READ_CHAR_BUDGET);expect(parsed).toEqual(wire.structuredContent);
    expect(parsed.output).toMatchObject({available:10,truncated:true});
    expect(parsed.nodes.length).toBeGreaterThan(0);expect(parsed.nodes.length).toBeLessThan(10);
    expect(parsed.nodes).toEqual(result.nodes.slice(0,parsed.output.shown));
    expect(parsed.coverage).toEqual(result.coverage);expect(parsed.reasons).toEqual(result.reasons);
    if(nudge)expect(parsed.coordination_nudge).toBeTruthy();else expect(parsed).not.toHaveProperty('coordination_nudge');
  }
});
it('rejects an impossible JSON budget and fails closed on oversized or mismatched structured producers',async()=>{
  const {budgetSearchResult}=await import('../graph/semantic/service.js');
  const {pageBudget,finalizeToolResult}=await import('../read-budget.js');
  const {emptySearch}=await import('../graph/semantic/response.js');
  expect(()=>budgetSearchResult(emptySearch('off'),{fullRows:3,charBudget:1})).toThrow('semantic_response_budget_too_small');
  const complete=budgetSearchResult(emptySearch('off'),pageBudget());expect(JSON.parse(complete.content[0].text).output).toEqual({shown:0,available:0,truncated:false,recovery:null});
  for(const raw of [{big:'x'.repeat(6000)},{ok:true}]){
    const result=finalizeToolResult('mai_graph_find',{content:[{type:'text',text:raw.big?JSON.stringify(raw):'wrong'}],structuredContent:raw,isError:false},'board');
    expect(result.isError).toBe(true);expect(JSON.parse(result.content[0].text)).toEqual(result.structuredContent);
    expect(result.structuredContent).toMatchObject({error:'structured_read_budget_contract'});
  }
});
it('returns complete bounded JSON through the actual MCP adapter with ten large hits and a live nudge',async()=>{
  const ids:string[]=[];
  try{
    for(let i=0;i<10;i++){
      const row=await db.query<{id:string}>("INSERT INTO graph_nodes(project_id,kind,name,qualified_name,file_path,line,extracted_by) VALUES($1,'function',$2,$3,$4,100,'fixture') RETURNING id",[a,'wirebudget'+i,'qualified.'.repeat(80)+i,root+'/'+('directory/'.repeat(60))+'file.ts']);ids.push(row.rows[0].id);
    }
    const {buildServer}=await import('../index.js');const {Client,InMemoryTransport}=await import('@modelcontextprotocol/client');
    const server=buildServer(async()=>'[agent board: '+ '\u0001"\\'.repeat(1000)+']'),client=new Client({name:'semantic-json',version:'1'}),[ct,st]=InMemoryTransport.createLinkedPair();
    try{
      await Promise.all([server.connect(st),client.connect(ct)]);
      const result=await client.callTool({name:'mai_graph_find',arguments:{query:'wirebudget',mode:'semantic'}});
      expect(result.isError).not.toBe(true);
      const blocks=Array.isArray(result.content)?result.content:[];
      expect(blocks).toHaveLength(1);
      const text=blocks.map(block=>'text' in block&&typeof block.text==='string'?block.text:'').join('\n\n');
      const parsed=JSON.parse(text);expect(text.length).toBeLessThanOrEqual(6000);expect(parsed).toEqual(result.structuredContent);
      expect(parsed.output).toMatchObject({available:10,truncated:true});expect(parsed.nodes.length).toBeGreaterThan(0);expect(parsed.nodes.length).toBeLessThan(10);
      const {scopedSearch}=await import('../graph/semantic/service.js');const expected=await scopedSearch({pin:true},{query:'wirebudget'});
      expect(parsed.nodes).toEqual(expected.nodes.slice(0,parsed.output.shown));expect(parsed.reasons).toEqual(['off']);expect(parsed.coordination_nudge).toContain('mai_board_read');
    }finally{await client.close();await server.close();}
  }finally{await db.query('DELETE FROM graph_nodes WHERE id=ANY($1::uuid[])',[ids]);}
});
