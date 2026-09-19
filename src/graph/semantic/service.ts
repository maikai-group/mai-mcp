import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { type ReadBudget } from '../../read-budget.js';
import { object, text, integer, uuid, SemanticError } from './validation.js';
import { decodeSearch, decodeJob, decodeStatus } from './codec.js';
import { decodePolicy } from './policy.js';
import type { SemanticStatus } from './runtime.js';
import { emptySearch } from './response.js';
import type { SearchInput, CodeSearch, CodePolicy } from './types.js';
import type { IndexJob } from './store.js';

export type WorkerScope={pin:true}|{projectId:string}|{slug:string};
export type WorkerAction='search'|'lexical'|'status'|'index'|'cancel'|'policy';
export function normalizeSearch(raw:unknown):SearchInput {
  const r=object(raw,['query','kind','limit']);
  return {query:text(r.query,1000),limit:integer(r.limit,1,30,10),...(r.kind===undefined?{}:{kind:text(r.kind,64)})};
}
export function workerRequest(scope:WorkerScope,action:WorkerAction,input:unknown,timeoutMs=24000):Promise<unknown> {
  return new Promise((resolve,reject)=>{
    const child=spawn(process.execPath,[fileURLToPath(new URL('../../../build/graph/semantic/worker.js',import.meta.url))],{stdio:['pipe','pipe','ignore']});
    let settled=false,buffer='',bytes=0;
    const finish=(error:Error|null,value?:unknown)=>{
      if(settled)return;settled=true;clearTimeout(timer);
      child.stdin.destroy();child.stdout.destroy();
      const deliver=()=>{if(error)reject(error);else resolve(value);};
      if(action==='index'&&!error){child.unref();deliver();return;}
      if(child.exitCode!==null||child.signalCode!==null){deliver();return;}
      // This parent owns only this handle. Reap it before releasing the RPC result.
      child.once('close',deliver);child.kill('SIGKILL');
    };
    const timer=setTimeout(()=>finish(new SemanticError('query_timeout',504)),timeoutMs);
    child.on('error',()=>finish(new SemanticError('worker_unavailable',503)));
    child.on('close',()=>{if(!settled)finish(new SemanticError('worker_unavailable',503));});
    child.stdin.on('error',()=>finish(new SemanticError('worker_unavailable',503)));
    child.stdout.on('data',(chunk:Buffer)=>{
      bytes+=chunk.length;
      if(bytes>256*1024){finish(new SemanticError('worker_output_limit',503));return;}
      buffer+=chunk.toString('utf8');
      const newline=buffer.indexOf('\n');if(newline<0)return;
      try{
        const raw:unknown=JSON.parse(buffer.slice(0,newline)),message=object(raw,['ok','body','error','status']);
        if(message.ok===true)finish(null,message.body);
        else finish(new SemanticError(text(message.error,300),integer(message.status,400,599)));
      }catch{finish(new SemanticError('worker_protocol_error',503));}
    });
    child.stdin.end(JSON.stringify({scope,action,input}));
  });
}
export async function scopedSearch(scope:WorkerScope,raw:unknown):Promise<CodeSearch> {
  const input=normalizeSearch(raw),started=performance.now();
  try{return decodeSearch(await workerRequest(scope,'search',input,21000));}
  catch(error){
    if(error instanceof SemanticError&&[400,404,409].includes(error.status))throw error;
    const remaining=Math.max(1,24500-(performance.now()-started));
    try{
      const result=decodeSearch(await workerRequest(scope,'lexical',input,Math.min(3000,remaining)));
      result.state='fallback';result.reasons=[error instanceof SemanticError&&error.message==='query_timeout'?'query_timeout':'provider_unavailable'];
      return result;
    }catch(fallbackError){if(fallbackError instanceof SemanticError&&[400,404,409].includes(fallbackError.status))throw fallbackError;return emptySearch('database_unavailable');}
  }
}
export async function searchCode(projectId:string,input:SearchInput):Promise<CodeSearch> {return scopedSearch({projectId:uuid(projectId)},input);}
export async function semanticStatus(projectId:string):Promise<SemanticStatus> {return decodeStatus(await workerRequest({projectId:uuid(projectId)},'status',{}));}
export async function startIndex(projectId:string):Promise<IndexJob> {return decodeJob(await workerRequest({projectId:uuid(projectId)},'index',{},5000));}
export async function cancelIndex(projectId:string,jobId:string):Promise<IndexJob> {return decodeJob(await workerRequest({projectId:uuid(projectId)},'cancel',{job_id:uuid(jobId)},5000));}
export async function updateCodePolicy(scope:WorkerScope,input:unknown):Promise<CodePolicy> {
  const result=object(await workerRequest(scope,'policy',input,5000),['provider','revision','consentVersion']);
  return decodePolicy({provider:result.provider,revision:result.revision,consent_version:result.consentVersion});
}
/** Select a prefix of complete hits; never slice serialized JSON or provenance. */
export function budgetSearchResult(result:CodeSearch,budget:ReadBudget) {
  const envelope=(shown:number)=>({...result,nodes:result.nodes.slice(0,shown),output:{
    shown,available:result.nodes.length,truncated:shown<result.nodes.length,
    recovery:shown<result.nodes.length?'Narrow query/kind, or run mai graph semantic search in the CLI for all requested hits.':null,
  }});
  let shown=result.nodes.length,structuredContent=envelope(shown),text=JSON.stringify(structuredContent);
  while(text.length>budget.charBudget&&shown>0){structuredContent=envelope(--shown);text=JSON.stringify(structuredContent);}
  if(!Number.isInteger(budget.charBudget)||budget.charBudget<1||text.length>budget.charBudget)throw new SemanticError('semantic_response_budget_too_small',500);
  const content:{type:'text';text:string}[]=[{type:'text',text}];
  return {content,structuredContent};
}
export async function semanticSearchResult(raw:unknown,budget:ReadBudget) {
  return budgetSearchResult(await scopedSearch({pin:true},raw),budget);
}
