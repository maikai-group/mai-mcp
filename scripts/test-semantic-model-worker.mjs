import fs from 'node:fs/promises';
import path from 'node:path';
import {spawn} from 'node:child_process';
import {Pool} from 'pg';
import assert from 'node:assert/strict';
import os from 'node:os';
import {fileURLToPath} from 'node:url';
const repo=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const url=new URL(process.env.MAI_TEST_DB_URL??'http://invalid');
if(!['localhost','127.0.0.1','::1','[::1]'].includes(url.hostname)||!/^\/mai_plan23_[a-z0-9_]+$/.test(url.pathname))throw Error('Disposable local database required');
const db=new Pool({connectionString:url.href}),reports=[],owned=new Set();
const root=await fs.mkdtemp(path.join(os.tmpdir(),'mai-model-worker-'));
const fixture=path.join(root,'repo'),dir=path.join(fixture,'build/graph/semantic');
try{
await fs.cp(path.join(repo,'build'),path.join(fixture,'build'),{recursive:true});
await fs.writeFile(path.join(fixture,'package.json'),JSON.stringify({type:'module'}));
await fs.symlink(path.join(repo,'node_modules'),path.join(fixture,'node_modules'),'dir');
await fs.writeFile(path.join(dir,'local-model.js'),`
import fs from 'node:fs';
function block(stage){fs.appendFileSync(process.env.CONTROL_MARKER,JSON.stringify({stage:'blocked',operation:stage,pid:process.pid})+String.fromCharCode(10));Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0);}
export async function createLocalModel(model){
 fs.appendFileSync(process.env.CONTROL_MARKER,JSON.stringify({stage:'loaded',pid:process.pid})+String.fromCharCode(10));
 if(process.env.CONTROL_PHASE==='missing')return null;
 if(process.env.CONTROL_PHASE==='load')block('load');
 const infer=async(text,offset)=>{if(process.env.CONTROL_PHASE==='inference')block('inference');return Array(384).fill(text.length+offset);};
 return {model,dimensions:384,document:text=>infer(text,10),query:text=>infer(text,20),cue:text=>infer(text,30),rerank:async(query,documents)=>documents.map(text=>query.length+text.length),close:async()=>{if(process.env.CONTROL_PHASE==='close')block('close');fs.appendFileSync(process.env.DISPOSE_MARKER,'closed\\n');}};
}`);
// Test-only export gives direct coverage to the actual owner disposal deadline.
// The worker entry and transport remain byte-identical to the built product.
await fs.writeFile(path.join(dir,'reranker.js'),`
import fs from 'node:fs';
export async function createCodeReranker(){
 fs.appendFileSync(process.env.CONTROL_MARKER,JSON.stringify({stage:'reranker',pid:process.pid})+String.fromCharCode(10));
 return {score:async(query,documents)=>documents.map(text=>query.length+text.length),close:async()=>fs.appendFileSync(process.env.DISPOSE_MARKER,'closed'+String.fromCharCode(10))};
}
`);
const runtime=path.join(dir,'runtime.js');
await fs.appendFile(runtime,'\nexport {withProvider};\n');
if(process.argv.includes('--mutate-worker-entry'))await fs.writeFile(path.join(dir,'model-process-worker.js'),"throw new Error('Mutated worker entry');\n");
const protocol=path.join(root,'protocol.mjs');
await fs.writeFile(protocol,`import assert from 'node:assert/strict';import fs from 'node:fs/promises';const {createLocalModelProcess}=await import('./repo/build/graph/semantic/local-model-process.js');const p=await createLocalModelProcess('local:bge-small-en-v1.5');assert(p,'Actual worker failed to initialize');try{assert.deepEqual(await p.document('a'),Array(384).fill(11));assert.deepEqual(await p.query('ab'),Array(384).fill(22));assert.deepEqual(await p.cue('abc'),Array(384).fill(33));assert.deepEqual(await p.rerank('q',['a','bb']),[2,3]);}finally{await p.close();}await p.close();assert.equal(await p.query('closed'),null);assert.equal(await fs.readFile(process.env.DISPOSE_MARKER,'utf8'),'closed\\nclosed\\nclosed\\n');console.log('protocol-ok');`);
const protocolChild=spawn(process.execPath,[protocol],{env:{...process.env,MAI_DB_URL:url.href,CONTROL_MARKER:path.join(root,'protocol-events'),DISPOSE_MARKER:path.join(root,'disposed')},stdio:['ignore','pipe','pipe']});
owned.add(protocolChild);let protocolOutput='',protocolError='';
protocolChild.stdout.on('data',b=>protocolOutput+=b);protocolChild.stderr.on('data',b=>protocolError+=b);
const protocolGuard=setTimeout(()=>protocolChild.kill('SIGKILL'),5000);
const protocolExit=await new Promise((resolve,reject)=>{protocolChild.once('error',reject);protocolChild.once('close',(code,signal)=>resolve({code,signal}));});
clearTimeout(protocolGuard);owned.delete(protocolChild);
assert.equal(protocolExit.code,0,'Actual model worker protocol failed: '+protocolError);assert.equal(protocolOutput.trim(),'protocol-ok');
const entry=path.join(root,'thread-control-child.mjs');
await fs.writeFile(entry,`const {runIndex,withProvider}=await import('./repo/build/graph/semantic/runtime.js');const {reserveJob}=await import('./repo/build/graph/semantic/store.js');const {closePool}=await import('./repo/build/db.js');try{const {job}=await reserveJob(process.argv[2]);console.log(JSON.stringify({job:job.id}));if(process.env.CONTROL_PHASE==='close')await withProvider({provider:'local',revision:0,consentVersion:null},async p=>p.document('metadata'));else await runIndex(process.argv[2],job.id);}finally{await closePool();}`);
 for(const [phase,action] of [['load','deadline'],['inference','deadline'],['close','deadline'],['inference','lease-loss'],['inference','native-lease-loss'],['inference','parent-death'],['inference','cancel']]){
  const project=(await db.query("INSERT INTO projects(slug,name,path) VALUES($1,$1,$2) RETURNING id",['control-'+phase+'-'+action,repo])).rows[0].id;
  await db.query("INSERT INTO graph_nodes(project_id,kind,name,qualified_name,extracted_by) VALUES($1,'function','control','control','fixture')",[project]);
  const start=performance.now(),child=spawn(process.execPath,[entry,project],{env:{...process.env,MAI_DB_URL:url.href,CONTROL_PHASE:phase,PGAPPNAME:'semantic-thread-control-probe',CONTROL_MARKER:path.join(root,'events-'+phase+'-'+action),DISPOSE_MARKER:path.join(root,'disposed-'+phase+'-'+action)},stdio:['ignore','pipe','pipe']});
  owned.add(child);
  let stdout='',stderr='',blockedAt=null,actionAt=null,guardFired=false,checking=false,actionDone=false,samplingError=null;const samples=[];
  child.stdout.on('data',b=>stdout+=b);child.stderr.on('data',b=>{stderr+=b;if(blockedAt===null&&stderr.includes('"stage":"blocked"'))blockedAt=performance.now()-start;});
  const guard=setTimeout(()=>{guardFired=true;child.kill('SIGKILL');},30000);
  const poll=setInterval(async()=>{
   if(checking)return;checking=true;
   try{
    const events=await fs.readFile(path.join(root,'events-'+phase+'-'+action),'utf8').catch(()=> '');if(blockedAt===null&&events.includes('\"stage\":\"blocked\"'))blockedAt=performance.now()-start;
    const result=await db.query("SELECT a.pid,a.state,(SELECT l.objid::int FROM pg_locks l WHERE l.pid=a.pid AND l.locktype='advisory' AND l.granted LIMIT 1) AS lane,EXISTS(SELECT 1 FROM pg_locks l WHERE l.pid=a.pid AND l.locktype='advisory' AND l.granted) AS held FROM pg_stat_activity a WHERE a.datname=current_database() AND a.application_name='semantic-thread-control-probe'");
    samples.push({ms:performance.now()-start,rows:result.rows});
    if(blockedAt!==null&&!actionDone&&action!=='deadline'){
     actionDone=true;actionAt=performance.now()-start;
     assert(result.rows.some(row=>row.lane===2),'Native lease must be held during blocked work');
     if(action==='parent-death'){child.kill('SIGKILL');}
     else if(action==='lease-loss'||action==='native-lease-loss'){
      const pid=result.rows.find(row=>row.lane===(action==='lease-loss'?1:2))?.pid;assert(pid,'Expected owned lease backend');await db.query('SELECT pg_terminate_backend($1)',[pid]);
     }else await db.query("UPDATE graph_code_jobs SET cancel_requested=true,state='cancelled' WHERE project_id=$1 AND state='running'",[project]);
    }
   }catch(error){samplingError=String(error);child.kill('SIGKILL');}finally{checking=false;}
  },100);
  const exit=await new Promise((resolve,reject)=>{child.once('error',reject);child.once('close',(code,signal)=>resolve({code,signal}));});
  owned.delete(child);clearInterval(poll);clearTimeout(guard);while(checking)await new Promise(resolve=>setTimeout(resolve,10));
  const elapsedMs=performance.now()-start;let alive=true;try{process.kill(child.pid,0);}catch(error){if(error.code==='ESRCH')alive=false;else throw error;}
  let locks=(await db.query("SELECT l.pid FROM pg_locks l JOIN pg_stat_activity a ON a.pid=l.pid WHERE a.datname=current_database() AND l.locktype='advisory' AND l.granted")).rows;
  const initialLocks=locks,releaseDeadline=performance.now()+2000;
  while(locks.length&&performance.now()<releaseDeadline){
    await new Promise(resolve=>setTimeout(resolve,25));
    locks=(await db.query("SELECT l.pid FROM pg_locks l JOIN pg_stat_activity a ON a.pid=l.pid WHERE a.datname=current_database() AND l.locktype='advisory' AND l.granted")).rows;
  }
  const leaseReleasedMs=performance.now()-start;
  const eventText=await fs.readFile(path.join(root,'events-'+phase+'-'+action),'utf8').catch(()=> '');
  const nativePids=[...new Set(eventText.trim().split('\n').filter(Boolean).map(line=>JSON.parse(line).pid))];
  const nativeAlive=nativePids.filter(pid=>{try{process.kill(pid,0);return true;}catch(error){if(error.code==='ESRCH')return false;throw error;}});
  assert.equal(nativeAlive.length,0,'Native children must be gone before lease release');
  const result={phase,action,blockedAt,actionAt,elapsedMs,leaseReleasedMs,initialLocks,...exit,guardFired,samplingError,alive,locks,stdout,stderr,samples};
  const passed=blockedAt!==null&&(action==='native-lease-loss'?exit.code===0:exit.signal==='SIGKILL')&&!guardFired&&!samplingError&&!alive&&!locks.length&&(action==='deadline'?elapsedMs-blockedAt>=19000&&elapsedMs-blockedAt<23000:elapsedMs-actionAt<2000);
  reports.push({...result,passed});
  assert(passed,JSON.stringify({phase,action,blockedAt,elapsedMs,signal:exit.signal,guardFired,alive,locks,samplingError}));
  await db.query('DELETE FROM projects WHERE id=$1',[project]);
 }
 console.log(JSON.stringify({protocolPassed:true,controls:reports.map(({phase,action,elapsedMs,leaseReleasedMs,passed})=>({phase,action,elapsedMs,leaseReleasedMs,passed})),passed:reports.every(r=>r.passed)}));
}finally{
 await Promise.all([...owned].map(child=>new Promise(resolve=>{child.once('close',resolve);child.kill('SIGKILL');})));
 await db.end();await fs.rm(root,{recursive:true,force:true});
}
