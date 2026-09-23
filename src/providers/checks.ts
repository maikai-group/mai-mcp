import { findExecutable, spawnArgv } from '../platform/commands.js';
import { subscriptionChildEnv } from '../llm/child-env.js';
import { resolveCredential as resolveRuntimeCredential } from './runtime.js';
import { ProviderConfigError, isRecord } from './types.js';
import type { ApiProvider, CheckResult, NativeStatus } from './types.js';
export interface CheckInput {provider:ApiProvider;allowUsage:boolean;model?:string}
export interface CheckDeps {
  fetch:typeof fetch;
  resolveCredential:typeof resolveRuntimeCredential;
  credentialRevision(provider:ApiProvider):string;
  now():number;
}
// Also shared by the fixed-endpoint embedding adapters. Never decode an
// unbounded vendor body; cancellation is tied to the caller's request deadline.
export async function readProviderJson(response:Response,limit:number,signal?:AbortSignal):Promise<unknown> {
  const reader=response.body?.getReader();if(!reader)throw new ProviderConfigError('invalid_input');
  const chunks:Uint8Array[]=[];let size=0;
  const abort=()=>{void reader.cancel().catch(()=>{});};signal?.addEventListener('abort',abort,{once:true});
  try {
    if(signal?.aborted)throw new ProviderConfigError('cancelled');
    for(;;){const {done,value}=await reader.read();if(done)break;size+=value.length;if(size>limit)throw new ProviderConfigError('invalid_input');chunks.push(value);}
    if(signal?.aborted)throw new ProviderConfigError('cancelled');
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } finally {signal?.removeEventListener('abort',abort);await reader.cancel().catch(()=>{});reader.releaseLock();}
}
export async function checkConnection(input:CheckInput,deps:CheckDeps,signal?:AbortSignal):Promise<CheckResult> {
  const paid=input.provider==='typesafe'||input.provider==='voyage';
  if(paid&&!input.allowUsage)throw new ProviderConfigError('invalid_input');
  if(input.provider==='typesafe'&&(!input.model?.trim()||input.model.length>100))throw new ProviderConfigError('invalid_input');
  const operation=input.provider==='typesafe'?'evaluation':input.provider==='voyage'?'embedding':'auth';
  const controller=new AbortController();const timer=setTimeout(()=>controller.abort(),10000);
  const active=signal?AbortSignal.any([signal,controller.signal]):controller.signal;
  let revision:string='missing';
  let state:CheckResult['state']='inconclusive';let reason:CheckResult['reason']='unavailable';
  let response:Response|undefined;
  try {
    if(active.aborted)throw new ProviderConfigError('cancelled');
    let key:string|null=null;
    for(let attempt=0;attempt<2;attempt++) {
      revision=deps.credentialRevision(input.provider);
      key=await deps.resolveCredential(input.provider,active);
      if(revision===deps.credentialRevision(input.provider))break;
      key=null;reason='configuration_changed';
    }
    if(!key)return {state,reason,operation,checkedAt:new Date(deps.now()).toISOString(),credentialRevision:revision.startsWith('saved:')?Number(revision.slice(6)):null};
    const headers:Record<string,string>={};let url:string;let body:string|undefined;
    if(input.provider==='anthropic'){url='https://api.anthropic.com/v1/models?limit=1';headers['x-api-key']=key;headers['anthropic-version']='2023-06-01';}
    else {
      headers.Authorization=`Bearer ${key}`;
      if(input.provider==='openai')url='https://api.openai.com/v1/models';
      else {
        headers['Content-Type']='application/json';
        if(input.provider==='voyage'){url='https://api.voyageai.com/v1/embeddings';body=JSON.stringify({input:['mai connection check'],model:'voyage-3'});}
        else {url='https://api.typesafe.ai/v1/systemone';body=JSON.stringify({model:input.model,state:{text:'mai connection check'},questions:{connection:{type:'noul',instructions:'Does state.text contain a connection check?'}}});}
      }
    }
    response=await deps.fetch(url,{method:body?'POST':'GET',headers,body,redirect:'error',signal:active});
    if(response.status===401||response.status===403){state='rejected';reason='rejected';}
    else if(response.status===429)reason='rate_limit';
    else if(response.status>=500)reason='provider_error';
    else if(!response.ok)reason='invalid_response';
    else {
      let valid=!paid;
      if(paid){
        try {
          const value=await readProviderJson(response,65536,active);
          if(input.provider==='voyage'&&isRecord(value)&&Array.isArray(value.data)&&value.data.length===1){
            const row:unknown=value.data[0];valid=isRecord(row)&&Array.isArray(row.embedding)&&row.embedding.length>0&&row.embedding.every((n:unknown)=>typeof n==='number'&&Number.isFinite(n));
          }else if(input.provider==='typesafe'&&isRecord(value)&&isRecord(value.answers)&&isRecord(value.answers.connection)){
            const answer=value.answers.connection;valid=answer.type==='noul'&&typeof answer.noul==='number'&&Number.isFinite(answer.noul)&&answer.noul>=0&&answer.noul<=1;
          }
        }catch{valid=false;}
      }
      if(valid){state='valid';reason='accepted';}else reason='invalid_response';
    }
    if(revision!==deps.credentialRevision(input.provider)){state='inconclusive';reason='configuration_changed';}
    if(active.aborted){state='inconclusive';reason='network';}
  }catch(error){state='inconclusive';reason=error instanceof ProviderConfigError&&error.code!=='cancelled'?'unavailable':'network';}
  finally{clearTimeout(timer);await response?.body?.cancel().catch(()=>{});}
  return {state,reason,operation,checkedAt:new Date(deps.now()).toISOString(),credentialRevision:revision.startsWith('saved:')?Number(revision.slice(6)):null};
}
export interface NativeDeps {
  find(name:string):string|null;
  run(executable:string,args:readonly string[],env:NodeJS.ProcessEnv,signal?:AbortSignal):Promise<number|null>;
}
export function runNativeProbe(executable:string,args:readonly string[],env:NodeJS.ProcessEnv,signal?:AbortSignal):Promise<number|null> {
  if(signal?.aborted)return Promise.resolve(null);
  return new Promise(resolve=>{
    const child=spawnArgv(executable,args,{env,stdio:['ignore','pipe','pipe'],windowsHide:true});
    let bytes=0;let failed=false;
    const kill=()=>{failed=true;child.kill('SIGKILL');};
    const timer=setTimeout(kill,5000);
    const data=(chunk:Buffer)=>{bytes+=chunk.length;if(bytes>8192)kill();};
    child.stdout?.on('data',data);child.stderr?.on('data',data);
    child.once('error',()=>{failed=true;});
    child.once('close',code=>{clearTimeout(timer);signal?.removeEventListener('abort',kill);resolve(failed?null:code);});
    signal?.addEventListener('abort',kill,{once:true});if(signal?.aborted)kill();
  });
}
export async function checkNativeClients(signal?:AbortSignal,deps:NativeDeps={find:findExecutable,run:runNativeProbe}):Promise<NativeStatus> {
  const probe=async(name:'claude'|'codex')=>{
    try {const executable=deps.find(name);if(!executable)return null;return await deps.run(executable,name==='claude'?['--version']:['login','status'],subscriptionChildEnv(['CODEX_HOME','CLAUDE_CONFIG_DIR']),signal);}
    catch{return null;}
  };
  const [claude,codex]=await Promise.all([probe('claude'),probe('codex')]);
  return {claude:claude===0?'installed_auth_unverified':'unavailable',codex:codex===0?'authenticated':codex===1?'unauthenticated':'unavailable'};
}
