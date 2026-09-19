import { beforeAll,afterAll,expect,it } from 'vitest';
import { Pool } from 'pg';
import { mkdtemp,rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { requireDisposableTestDbUrl } from './test-db-url.js';
process.env.MAI_DB_URL=requireDisposableTestDbUrl();process.env.MAI_PROJECT_SLUG='node-lessons-test';process.env.MAI_EMBEDDINGS='0';
const root=await mkdtemp(path.join(os.tmpdir(),'lesson-source-'));process.env.MAI_BRAIN_ROOT=root;
const admin=new Pool({connectionString:process.env.MAI_DB_URL});let project='',foreign='',node='',privateLesson='',globalLesson='',foreignLesson='';
async function lesson(scope:string|null,rule:string){return (await admin.query<{id:string}>('INSERT INTO lessons(project_id,rule,why,how_to_apply,confidence_score) VALUES($1,$2,$3,$4,0.1) RETURNING id',[scope,rule,'why '.repeat(400),'apply '.repeat(400)])).rows[0].id;}
beforeAll(async()=>{
  project=(await admin.query<{id:string}>('INSERT INTO projects(slug,name,path) VALUES($1,$1,$2) RETURNING id',['node-lessons-test',root])).rows[0].id;
  foreign=(await admin.query<{id:string}>('INSERT INTO projects(slug,name,path) VALUES($1,$1,$2) RETURNING id',['node-lessons-foreign',root])).rows[0].id;
  node=(await admin.query<{id:string}>("INSERT INTO graph_nodes(project_id,kind,name,qualified_name,extracted_by) VALUES($1,'function','save','source#save','fixture') RETURNING id",[project])).rows[0].id;
  privateLesson=await lesson(project,'Always validate before saving.');globalLesson=await lesson(null,'Keep transactions atomic.');foreignLesson=await lesson(foreign,'Private foreign rule.');
});
afterAll(async()=>{await admin.query('DELETE FROM projects WHERE id=ANY($1::uuid[])',[[project,foreign]]);await admin.query('DELETE FROM lessons WHERE id=$1',[globalLesson]);await admin.end();await (await import('../db.js')).closePool();await rm(root,{recursive:true,force:true});});
const input=(lessonId:string,action='attach')=>({node_id:node,lesson_id:lessonId,action,reason:'Operator verified this advice applies here.'});
it('allows project/global active low-confidence advice and blocks foreign scope',async()=>{
  const {mutateOperatorAttachment,readNodeLessons,readLessonDetail}=await import('../graph/lessons/service.js');
  await mutateOperatorAttachment(project,input(privateLesson),'cli');await mutateOperatorAttachment(project,input(globalLesson),'dashboard');
  await expect(mutateOperatorAttachment(project,input(foreignLesson),'cli')).rejects.toMatchObject({status:404});
  await expect(mutateOperatorAttachment(foreign,input(privateLesson),'cli')).rejects.toMatchObject({status:404});
  const result=await readNodeLessons(project,node);expect(result.attached.map(row=>row.id).sort()).toEqual([privateLesson,globalLesson].sort());expect(result.offset).toBe(0);expect('suggested' in result).toBe(false);
  const full=await readLessonDetail(project,privateLesson);expect(full?.why).toHaveLength(1600);expect(full?.how_to_apply).toHaveLength(2400);expect(full?.confidence).toBe(.1);
  expect(await readLessonDetail(project,foreignLesson)).toBeNull();
});
it('serializes duplicate attaches and keeps event history through detach/reactivation',async()=>{
  const {mutateOperatorAttachment}=await import('../graph/lessons/service.js');
  const id=await lesson(project,'Concurrent attachment rule');
  const [a,b]=await Promise.all([mutateOperatorAttachment(project,input(id),'cli'),mutateOperatorAttachment(project,input(id),'dashboard')]);
  expect(a.attachment_id).toBe(b.attachment_id);expect([a.changed,b.changed].filter(Boolean)).toHaveLength(1);
  await mutateOperatorAttachment(project,input(id,'detach'),'cli');await mutateOperatorAttachment(project,input(id),'cli');
  const events=await admin.query('SELECT action FROM graph_lesson_attachment_events WHERE attachment_id=$1 ORDER BY created_at,id',[a.attachment_id]);expect(events.rows.map(row=>row.action)).toEqual(['attach','detach','attach']);
});
it('hides retired/superseded/moved advice while allowing owned removal without content',async()=>{
  const {mutateOperatorAttachment,readNodeLessons}=await import('../graph/lessons/service.js');
  for(const mutation of ['retired_at=now()','superseded_by=$2','project_id=$2']){
    const id=await lesson(project,'Advice that becomes hidden');await mutateOperatorAttachment(project,input(id),'cli');
    await admin.query(`UPDATE lessons SET ${mutation} WHERE id=$1`,mutation.includes('$2')?[id,mutation.startsWith('project')?foreign:privateLesson]:[id]);
    expect((await readNodeLessons(project,node)).attached.some(row=>row.id===id)).toBe(false);
    await expect(mutateOperatorAttachment(project,input(id),'cli')).rejects.toMatchObject({status:404});
    const removal=await mutateOperatorAttachment(project,input(id,'detach'),'cli');expect(removal).toEqual({attachment_id:removal.attachment_id,state:'detached',changed:true});
  }
});
it('survives UUID rebuild but never follows a rename, and supports unresolved removal',async()=>{
  const {readNodeLessons,mutateOperatorAttachment}=await import('../graph/lessons/service.js');
  const before=await readNodeLessons(project,node);const attached=before.attached.find(row=>row.id===privateLesson);if(!attached)throw Error('missing attachment');
  const old=node;await admin.query('DELETE FROM graph_nodes WHERE id=$1',[node]);node=(await admin.query<{id:string}>("INSERT INTO graph_nodes(project_id,kind,name,qualified_name,extracted_by) VALUES($1,'function','save','source#save','fixture') RETURNING id",[project])).rows[0].id;
  const after=await readNodeLessons(project,node);expect(after.identity).toBe(before.identity);expect(after.attached.find(row=>row.id===privateLesson)?.attachment_id).toBe(attached.attachment_id);
  await expect(readNodeLessons(project,old)).rejects.toMatchObject({status:404});
  await admin.query("UPDATE graph_nodes SET qualified_name='source#renamed' WHERE id=$1",[node]);expect((await readNodeLessons(project,node)).attached).toEqual([]);
  await expect(mutateOperatorAttachment(foreign,{action:'detach',attachment_id:attached.attachment_id,reason:'Remove old symbol'},'cli')).rejects.toMatchObject({status:404});
  expect((await mutateOperatorAttachment(project,{action:'detach',attachment_id:attached.attachment_id,reason:'Remove old symbol'},'cli')).changed).toBe(true);
  await admin.query("UPDATE graph_nodes SET qualified_name='source#save' WHERE id=$1",[node]);
});
it('rolls back an attachment when its event write fails',async()=>{
  const {mutateOperatorAttachment}=await import('../graph/lessons/service.js');const id=await lesson(project,'Rollback rule');
  await admin.query(`CREATE FUNCTION pg_temp.fail_event() RETURNS trigger LANGUAGE plpgsql AS 'BEGIN RAISE EXCEPTION ''injected event failure''; END';
    CREATE TRIGGER lesson_test_fail BEFORE INSERT ON graph_lesson_attachment_events FOR EACH ROW EXECUTE FUNCTION pg_temp.fail_event()`);
  try{await expect(mutateOperatorAttachment(project,input(id),'cli')).rejects.toThrow('injected event failure');expect((await admin.query('SELECT id FROM graph_lesson_attachments WHERE lesson_id=$1',[id])).rowCount).toBe(0);}
  finally{await admin.query('DROP TRIGGER lesson_test_fail ON graph_lesson_attachment_events');}
});
it('strictly rejects mismatched citations, unknown scope and malformed IDs',async()=>{
  const {attachmentInput}=await import('../graph/lessons/service.js');
  for(const raw of [{...input(privateLesson),project_id:foreign},{...input(privateLesson),node_id:'partial'},{...input(privateLesson),reason:' '}, {...input(privateLesson),citation:{kind:'novel',justification:'not applicable'}}])expect(()=>attachmentInput(raw,true)).toThrow();
  expect(()=>attachmentInput({...input(privateLesson),citation:{kind:'extends',extends_id:globalLesson,how:'Wrong lesson'}},true)).toThrow();
});
it.each([510,10000])('mints only whole lesson rows present on actual MCP wire with %i-character nudge',async nudgeSize=>{
  const {mutateOperatorAttachment}=await import('../graph/lessons/service.js');
  const wireNode=(await admin.query<{id:string}>("INSERT INTO graph_nodes(project_id,kind,name,qualified_name,extracted_by) VALUES($1,'function','wire','wire#'||gen_random_uuid()::text,'fixture') RETURNING id",[project])).rows[0].id;
  const ids=[];for(let i=0;i<8;i++){const id=await lesson(project,`Wire lesson ${i}: `+'rule '.repeat(95));await admin.query('UPDATE lessons SET why=$2,how_to_apply=$3 WHERE id=$1',[id,'why '.repeat(50),'apply '.repeat(35)]);ids.push(id);await mutateOperatorAttachment(project,{...input(id),node_id:wireNode},'cli');}
  const {buildServer}=await import('../index.js');const {Client,InMemoryTransport}=await import('@modelcontextprotocol/client');
  const server=buildServer(async()=>'n'.repeat(nudgeSize)),client=new Client({name:'lesson-wire',version:'1'});const [ct,st]=InMemoryTransport.createLinkedPair();
  try{
    await Promise.all([server.connect(st),client.connect(ct)]);
    const {ensureSessionToken}=await import('../write-gate.js');const token=await ensureSessionToken();await admin.query("UPDATE write_session_tokens SET result_set_ids='{}'::jsonb WHERE id=$1",[token]);
    const result=await client.callTool({name:'mai_graph_neighbors',arguments:{node_id:wireNode,view:'lessons',limit:30}});
    const body=(Array.isArray(result.content)?result.content:[]).map(block=>'text' in block?block.text:'').join('\n');expect(body.length).toBeLessThanOrEqual(6000);expect(body).not.toContain('_Truncated:');
    const minted=(await admin.query<{ids:string[]}>('SELECT result_set_ids->\'lessons\' ids FROM write_session_tokens WHERE id=$1',[token])).rows[0].ids;
    const visible=[...body.matchAll(/Lesson ([0-9a-f-]{36})/g)].map(match=>match[1]);expect([...new Set(minted)].sort()).toEqual(visible.sort());expect(visible.length).toBeGreaterThan(0);expect(visible.length).toBeLessThan(8);
    for(const id of visible)expect(body).toContain('Lesson '+id+'\n');
  }finally{await client.close();await server.close();for(const id of ids)await admin.query('DELETE FROM lessons WHERE id=$1',[id]);await admin.query('DELETE FROM graph_nodes WHERE id=$1',[wireNode]);}
});
it('suppresses retired gate previews on actual MCP rejection and preserves violation auditing',async()=>{
  const unread=await lesson(project,'gate preview exact matching rule'),retired=await lesson(project,'gate preview exact matching rule retired');await admin.query('UPDATE lessons SET retired_at=now() WHERE id=$1',[retired]);
  const {buildServer}=await import('../index.js');const {Client,InMemoryTransport}=await import('@modelcontextprotocol/client');const server=buildServer(async()=>''),client=new Client({name:'gate-wire',version:'1'});const [ct,st]=InMemoryTransport.createLinkedPair();
  try{await Promise.all([server.connect(st),client.connect(ct)]);const result=await client.callTool({name:'mai_link',arguments:{from_kind:'lesson',from_id:unread,to_kind:'graph_node',to_id:node,relation:'applies_to',note:'gate preview exact matching rule',citation:{kind:'extends',extends_id:unread,how:'Applies here'}}});
    const wire=JSON.stringify(result);expect(wire).toContain('first read the eligible lesson');expect(wire).not.toContain(retired);expect(wire).not.toContain('matching rule retired');
    const violations=await admin.query('SELECT preview_results FROM write_violations WHERE project_id=$1 AND tool_name=\'mai_link\' ORDER BY rejected_at DESC LIMIT 1',[project]);expect(JSON.stringify(violations.rows)).toContain(retired);
  }finally{await client.close();await server.close();}
});

it('keeps current-node paging and operator CLI/HTTP scope consistent',async()=>{
  const {lessonCli}=await import('../graph/lessons/cli.js');
  const {createLessonGetHandlers,createLessonPostHandlers}=await import('../graph/lessons/http.js');
  const {readNodeLessons}=await import('../graph/lessons/service.js');
  const before=await readNodeLessons(project,node,30);
  const get=createLessonGetHandlers(),post=createLessonPostHandlers();
  const url=(route:string,query:string)=>new URL('http://localhost/api/graph/lessons'+route+'?project=node-lessons-test&'+query);
  const page=await get['/api/graph/lessons'](url('',`node_id=${node}&limit=1&offset=1`));
  expect(page).toMatchObject({offset:1,attached:before.attached.slice(1,2)});
  expect(JSON.parse(await lessonCli({verb:'graph',positional:['lessons','show'],flags:{project:'node-lessons-test',node,limit:'1',offset:'1'}}))).toEqual(page);
  await expect(get['/api/graph/lessons'](url('',`node_id=${node}&limit=1&limit=2`))).rejects.toThrow();
  await expect(lessonCli({verb:'graph',positional:['lessons','show'],flags:{node,limit:'bad'}})).rejects.toThrow();
  await expect(post['/api/graph/lessons/link'](input(privateLesson),new URL('http://localhost/api/graph/lessons/link?project=node-lessons-foreign'))).rejects.toMatchObject({status:404});
  const id=await lesson(project,'HTTP operator rule');
  const result=await post['/api/graph/lessons/link'](input(id),url('/link',''));
  expect(result).toMatchObject({state:'attached',changed:true});
  const events=await admin.query('SELECT actor_surface,cited_lesson_id FROM graph_lesson_attachment_events WHERE attachment_id=$1',[result.attachment_id]);
  expect(events.rows).toEqual([{actor_surface:'dashboard',cited_lesson_id:null}]);
  const picker=await get['/api/graph/lessons/picker'](url('/picker','q=HTTP%20operator'));
  expect(picker).toMatchObject({lessons:[{id}]});
  const detail=await get['/api/graph/lessons/detail'](url('/detail',`lesson_id=${id}`));
  expect(detail).toMatchObject({lesson:{id,why:'why '.repeat(400)}});
  expect(JSON.parse(await lessonCli({verb:'graph',positional:['lessons','detach'],flags:{project:'node-lessons-test',attachment:String(result.attachment_id),reason:'No longer applies'}}))).toMatchObject({state:'detached',changed:true});
});
it('never returns or reattaches advice through remapped or ambiguous nodes',async()=>{
  const {mutateOperatorAttachment,readNodeLessons}=await import('../graph/lessons/service.js');
  const row=(await admin.query<{id:string}>("INSERT INTO graph_nodes(project_id,kind,name,qualified_name,extracted_by,file_path) VALUES($1,'function','mapped','mapped#save','fixture',$2) RETURNING id",[project,path.join(root,'mapped.ts')])).rows[0];
  const id=await lesson(project,'Remap rule');const args={...input(id),node_id:row.id};
  await mutateOperatorAttachment(project,args,'cli');
  await admin.query('UPDATE graph_nodes SET file_path=$2 WHERE id=$1',[row.id,path.join(root,'other.ts')]);
  expect((await readNodeLessons(project,row.id)).attached).toEqual([]);
  await admin.query('UPDATE graph_nodes SET file_path=$2 WHERE id=$1',[row.id,path.join(root,'mapped.ts')]);
  await expect(admin.query("INSERT INTO graph_nodes(project_id,kind,name,qualified_name,extracted_by,file_path) SELECT project_id,kind,name,qualified_name,extracted_by,file_path FROM graph_nodes WHERE id=$1",[row.id])).rejects.toMatchObject({code:'23505'});
  await admin.query("UPDATE projects SET metadata=jsonb_build_object('graph_excludes',jsonb_build_array($2::text)) WHERE id=$1",[project,root]);
  try{await expect(readNodeLessons(project,row.id)).rejects.toMatchObject({status:404});await expect(mutateOperatorAttachment(project,args,'cli')).rejects.toMatchObject({status:404});}
  finally{await admin.query("UPDATE projects SET metadata='{}'::jsonb WHERE id=$1",[project]);}
  expect((await readNodeLessons(project,row.id)).attached.map(x=>x.id)).toEqual([id]);
});
it('accepts an exact previously delivered citation on MCP and retains ordinary memory links',async()=>{
  const {mutateOperatorAttachment}=await import('../graph/lessons/service.js');
  const id=await lesson(project,'Exact agent citation');await mutateOperatorAttachment(project,input(id),'cli');
  const {buildServer}=await import('../index.js');const {Client,InMemoryTransport}=await import('@modelcontextprotocol/client');
  const server=buildServer(async()=>''),client=new Client({name:'attachment-citation',version:'1'});const [ct,st]=InMemoryTransport.createLinkedPair();
  try{
    await Promise.all([server.connect(st),client.connect(ct)]);
    const {ensureSessionToken}=await import('../write-gate.js');const token=await ensureSessionToken();
    await admin.query("UPDATE write_session_tokens SET result_set_ids='{}'::jsonb WHERE id=$1",[token]);
    const seen=new Set<string>();let offset=0;
    for(let page=0;page<30;page++){
      const result=await client.callTool({name:'mai_graph_neighbors',arguments:{node_id:node,view:'lessons',limit:30,offset}});
      const wire=JSON.stringify(result);expect(result.isError).not.toBe(true);
      const ids=[...wire.matchAll(/Lesson ([0-9a-f-]{36})/g)].map(m=>m[1]);
      for(const value of ids)seen.add(value);
      if(!wire.includes('Next:'))break;
      expect(ids.length).toBeGreaterThan(0);offset+=ids.length;
    }
    expect(seen.has(id)).toBe(true);
    const link={from_kind:'lesson',from_id:id,to_kind:'graph_node',to_id:node,relation:'applies_to',note:'Remove advice after checking full rule',action:'detach',citation:{kind:'extends',extends_id:id,how:'This exact rule no longer applies'}};
    expect((await client.callTool({name:'mai_link',arguments:link})).isError).not.toBe(true);
    const event=(await admin.query('SELECT actor_surface,cited_lesson_id,citation_how,session_token_id FROM graph_lesson_attachment_events WHERE cited_lesson_id=$1',[id])).rows[0];
    expect(event).toEqual({actor_surface:'mcp',cited_lesson_id:id,citation_how:link.citation.how,session_token_id:token});
    expect((await client.callTool({name:'mai_link',arguments:{...link,citation:{...link.citation,extends_id:globalLesson}}})).isError).toBe(true);
    const normal=await client.callTool({name:'mai_link',arguments:{from_kind:'lesson',from_id:id,to_kind:'lesson',to_id:globalLesson,relation:'relates_to',note:'Related advice'}});
    expect(normal.isError).not.toBe(true);expect(JSON.stringify(normal)).toContain('Linked lesson');
    const defaultRead=await client.callTool({name:'mai_graph_neighbors',arguments:{node_id:node}});
    expect(defaultRead.isError).not.toBe(true);expect(JSON.stringify(defaultRead)).not.toContain('Attached:');
  }finally{await client.close();await server.close();}
});

it('rechecks lesson eligibility after waiting for concurrent retirement',async()=>{
  const {mutateOperatorAttachment}=await import('../graph/lessons/service.js');const id=await lesson(project,'Retirement race');
  const blocker=await admin.connect();let pending:Promise<unknown>|undefined;
  try{
    await blocker.query('BEGIN');await blocker.query('SELECT id FROM lessons WHERE id=$1 FOR UPDATE',[id]);
    const pid=(await blocker.query<{pid:number}>('SELECT pg_backend_pid() pid')).rows[0].pid;
    pending=mutateOperatorAttachment(project,input(id),'cli').then(value=>value,error=>error);
    let blocked=false;
    for(let attempt=0;attempt<100;attempt++){
      blocked=(await admin.query<{blocked:boolean}>('SELECT EXISTS(SELECT 1 FROM pg_stat_activity WHERE $1=ANY(pg_blocking_pids(pid))) blocked',[pid])).rows[0].blocked;
      if(blocked)break;await new Promise(resolve=>setTimeout(resolve,20));
    }
    expect(blocked).toBe(true);
    await blocker.query('UPDATE lessons SET retired_at=now() WHERE id=$1',[id]);await blocker.query('COMMIT');
    expect(await pending).toMatchObject({status:404});
    expect((await admin.query('SELECT id FROM graph_lesson_attachments WHERE lesson_id=$1',[id])).rows).toEqual([]);
  }finally{await blocker.query('ROLLBACK');blocker.release();if(pending)await pending;}
});

it('completes concurrent idempotent mutations with a single pool connection',async()=>{
  const {getPool,closePool}=await import('../db.js');
  const {mutateOperatorAttachment}=await import('../graph/lessons/service.js');
  const id=await lesson(project,'Constrained pool attachment');
  await closePool();const pool=getPool();pool.options.max=1;
  try{
    const outcomes=await Promise.allSettled(Array.from({length:10},()=>mutateOperatorAttachment(project,input(id),'cli')));
    const successful=outcomes.flatMap(result=>result.status==='fulfilled'?[result.value]:[]);
    expect(successful).toHaveLength(10);expect(successful.filter(result=>result.changed)).toHaveLength(1);
    expect(new Set(successful.map(result=>result.attachment_id)).size).toBe(1);
    expect((await admin.query('SELECT id FROM graph_lesson_attachment_events WHERE attachment_id=$1',[successful[0].attachment_id])).rows).toHaveLength(1);
    expect(pool.waitingCount).toBe(0);
  }finally{await closePool();}
});
