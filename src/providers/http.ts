import type { IncomingMessage, ServerResponse } from 'node:http';
import { createHash, timingSafeEqual } from 'node:crypto';
import { isIP } from 'node:net';
import { ProviderStore } from './store.js';
import { createProviderRuntime, ENV_KEYS, JEV_ENV_KEYS, DEFAULT_JEV_POLICY, envCredential } from './runtime.js';
import { checkConnection, checkNativeClients } from './checks.js';
import { ensureMaster } from './keyring.js';
import { API_PROVIDERS, ProviderConfigError, exactKeys, isRecord, isProvider, isRevision, isProjectId, isSummaryRoute, isBrainRoute, isJevPolicy, validateKey } from './types.js';
import type { CheckResult, ProviderStatus, StoredState, SummaryRoute, BrainRoute } from './types.js';

type Runtime=ReturnType<typeof createProviderRuntime>;
export interface ProviderHandlerDependencies {
  store:ProviderStore;runtime:Runtime;
  resolveProject(slug:string):Promise<string>;
  bind:string;port():number;token():string;
  env?():Record<string,string|undefined>;
  ensureMaster?:typeof ensureMaster;
  check?: (input:Parameters<typeof checkConnection>[0],signal?:AbortSignal)=>Promise<CheckResult>;
  native?:typeof checkNativeClients;
  now?():number;
}
class HttpFailure extends Error {constructor(readonly status:number,readonly code:string){super(code);}}
function failure(status:number,code='invalid_input'):never{throw new HttpFailure(status,code);}
function send(res:ServerResponse,status:number,payload:unknown):void {
  if(res.destroyed||res.writableEnded)return;
  res.writeHead(status,{'Content-Type':'application/json; charset=utf-8','Cache-Control':'no-store'});res.end(JSON.stringify(payload));
}
export function isProviderPath(pathname:string):boolean{return pathname==='/api/providers'||pathname.startsWith('/api/providers/');}
export function withProviderRoutes(providerHandler:(req:IncomingMessage,res:ServerResponse,url:URL)=>Promise<boolean>,genericHandler:(req:IncomingMessage,res:ServerResponse)=>Promise<void>) {
  return async(req:IncomingMessage,res:ServerResponse):Promise<void>=>{
    let url:URL;try{url=new URL(req.url??'/','http://localhost');}catch{send(res,400,{ok:false,error:'invalid_input'});return;}
    if(!isProviderPath(url.pathname)){await genericHandler(req,res);return;}
    try{await providerHandler(req,res,url);}catch{send(res,503,{ok:false,error:'store_unavailable'});}
  };
}
function loopback(address:string):boolean {
  if(isIP(address)===4)return address.split('.')[0]==='127';
  if(isIP(address)!==6)return false;
  const host=new URL(`http://[${address}]/`).hostname;
  return host==='[::1]'||/^\[::ffff:7f[0-9a-f]{2}:[0-9a-f]{1,4}\]$/.test(host);
}
function authorize(req:IncomingMessage,deps:ProviderHandlerDependencies):void {
  if(!loopback(deps.bind)||!loopback(req.socket.remoteAddress??''))failure(403,'local_only');
  const host=req.headers.host;
  if(typeof host!=='string'||!new RegExp(`^(localhost|127\\.0\\.0\\.1|\\[::1\\]):${deps.port()}$`,'i').test(host))failure(403,'local_only');
  const configured=deps.token();const supplied=typeof req.headers['x-mai-brain-token']==='string'?req.headers['x-mai-brain-token']:'';
  const equal=timingSafeEqual(createHash('sha256').update(supplied).digest(),createHash('sha256').update(configured).digest());
  if(!configured)failure(503,'local_setup_required');
  if(!equal||Buffer.byteLength(supplied)!==Buffer.byteLength(configured))failure(401,'unauthorized');
  if(req.headers['sec-fetch-site']==='cross-site')failure(403,'local_only');
  if(req.method!=='GET'&&req.method!=='POST')failure(405);
  if(req.method==='POST'){
    if(req.headers.origin!==`http://${host}`)failure(403,'local_only');
    if(!/^application\/json(?:\s*;\s*charset=utf-8)?$/i.test(req.headers['content-type']??''))failure(400);
  }
}
async function body(req:IncomingMessage):Promise<Record<string,unknown>> {
  return new Promise((resolve,reject)=>{
    const chunks:Buffer[]=[];let size=0;let done=false;
    const cleanup=()=>{req.removeListener('data',data);req.removeListener('end',end);req.removeListener('error',error);};
    const error=()=>{if(done)return;done=true;cleanup();reject(new HttpFailure(400,'invalid_input'));};
    const data=(chunk:Buffer)=>{size+=chunk.length;if(size>16384){done=true;cleanup();req.resume();reject(new HttpFailure(413,'invalid_input'));}else chunks.push(chunk);};
    const end=()=>{if(done)return;done=true;cleanup();try{const value:unknown=JSON.parse(Buffer.concat(chunks).toString('utf8'));if(!isRecord(value))throw Error();resolve(value);}catch{reject(new HttpFailure(400,'invalid_input'));}};
    req.on('data',data);req.once('end',end);req.once('error',error);
  });
}
export const SUMMARY_ENV_KEYS=['MAI_LLM_SUMMARY','MAI_LLM_PROVIDER','MAI_LLM_FALLBACK_PROVIDER','MAI_SUMMARY_MODEL','MAI_CLAUDE_CODE_MODEL','MAI_CODEX_CLI_MODEL','MAI_LLM_BASE_URL'] as const;
export const BRAIN_ENV_KEYS=['MAI_EMBEDDINGS','OPENAI_API_KEY','VOYAGE_API_KEY'] as const;
function effectiveSummary(saved:SummaryRoute|null,env:Record<string,string|undefined>):SummaryRoute|null {
  if(!saved&&!SUMMARY_ENV_KEYS.some(key=>env[key]!==undefined))return null;
  const provider=env.MAI_LLM_PROVIDER??saved?.provider??'anthropic';
  if(provider!=='anthropic'&&provider!=='openai'&&provider!=='claude-code'&&provider!=='codex-cli')return null;
  const fallback=env.MAI_LLM_FALLBACK_PROVIDER??saved?.fallback??null;
  const providerModel=provider==='claude-code'?env.MAI_CLAUDE_CODE_MODEL:provider==='codex-cli'?env.MAI_CODEX_CLI_MODEL:undefined;
  const modelManaged=providerModel!==undefined||env.MAI_SUMMARY_MODEL!==undefined;
  return {enabled:env.MAI_LLM_SUMMARY===undefined?saved?.enabled??false:env.MAI_LLM_SUMMARY==='1',provider,
    model:modelManaged?providerModel||env.MAI_SUMMARY_MODEL||null:(provider===saved?.provider?saved.model:null),fallback:fallback==='claude-code'||fallback==='codex-cli'?fallback:null};
}
function effectiveBrain(saved:BrainRoute|null,env:Record<string,string|undefined>):BrainRoute|null {
  if(!saved&&!BRAIN_ENV_KEYS.some(key=>env[key]!==undefined))return null;
  const managed=env.OPENAI_API_KEY!==undefined||env.VOYAGE_API_KEY!==undefined;
  return {enabled:env.MAI_EMBEDDINGS===undefined?saved?.enabled??false:env.MAI_EMBEDDINGS==='1',
    provider:managed?(env.OPENAI_API_KEY?.trim()?'openai':env.VOYAGE_API_KEY?.trim()?'voyage':'local'):saved?.provider??'local'};
}
export function createProviderHandler(deps:ProviderHandlerDependencies) {
  const environment=deps.env??(()=>process.env);
  const native=deps.native??checkNativeClients;
  const test=deps.check??((input,signal)=>checkConnection(input,{fetch,resolveCredential:deps.runtime.resolveCredential,credentialRevision:deps.runtime.credentialRevision,now:deps.now??Date.now},signal));
  async function selected(url:URL):Promise<string|null>{
    const slug=url.searchParams.get('project');if(!slug)return null;
    if(!/^[a-z0-9][a-z0-9-]{0,99}$/.test(slug))failure(404);
    try{const id=await deps.resolveProject(slug);if(!isProjectId(id))failure(404);return id;}catch{failure(404);}
  }
  function jevPolicy(state:StoredState,projectId:string){const env=environment();const saved=state.jev[projectId]??DEFAULT_JEV_POLICY;return {enabled:env[JEV_ENV_KEYS.enabled]===undefined?saved.enabled:env[JEV_ENV_KEYS.enabled]==='1',model:env[JEV_ENV_KEYS.model]??saved.model};}
  async function status(projectId:string|null,withNative:boolean,signal:AbortSignal):Promise<ProviderStatus>{
    const env=environment();let storage:ProviderStatus['storage']='available';let state:StoredState;
    try{state=deps.store.readState();if(state.revision===0)storage='unconfigured';}
    catch{storage='unavailable';state={revision:0,credentials:API_PROVIDERS.map(provider=>({provider,saved:false,configured:false,revision:0,source:'missing',check:null})),summary:null,brain:null,jev:{}};}
    let snapshot:{summary:SummaryRoute|null;brain:BrainRoute|null}={summary:null,brain:null};
    try{snapshot=deps.runtime.routingSnapshot();}catch{storage='unavailable';}
    const managed={summary:SUMMARY_ENV_KEYS.filter(key=>env[key]!==undefined),brain:BRAIN_ENV_KEYS.filter(key=>env[key]!==undefined)};
    const activeSummary=effectiveSummary(snapshot.summary,env),activeBrain=effectiveBrain(snapshot.brain,env);
    const desiredSummary=effectiveSummary(state.summary,env),desiredBrain=effectiveBrain(state.brain,env);
    const result:ProviderStatus={revision:state.revision,storage,credentials:state.credentials.map(item=>{
      const override=envCredential(env,item.provider);return override.managed?{...item,source:'environment',configured:override.key!==null,check:null}:item;
    }),routing:{savedSummary:state.summary,savedBrain:state.brain,activeSummary,activeBrain,
      restartRequired:JSON.stringify([activeSummary,activeBrain])!==JSON.stringify([desiredSummary,desiredBrain]),managed},
      jev:projectId?{projectId,policy:jevPolicy(state,projectId),managed:Object.values(JEV_ENV_KEYS).filter(key=>env[key]!==undefined)}:null};
    if(withNative)result.native=await native(signal);return result;
  }
  return async(req:IncomingMessage,res:ServerResponse,url:URL):Promise<boolean>=>{
    if(!isProviderPath(url.pathname))return false;
    const controller=new AbortController();const abort=()=>controller.abort();const close=()=>{if(!res.writableFinished)abort();};
    req.once('aborted',abort);res.once('close',close);
    try{
      authorize(req,deps);
      const keys=new Set<string>();for(const [key,value]of url.searchParams){if(!['project','native'].includes(key)||keys.has(key)||value.length>100)failure(400);keys.add(key);}
      if(url.searchParams.has('native')&&url.searchParams.get('native')!=='1')failure(400);
      const projectId=await selected(url);
      if(req.method==='GET'){
        if(url.pathname!=='/api/providers')failure(404);
        send(res,200,{ok:true,...await status(projectId,url.searchParams.get('native')==='1',controller.signal)});return true;
      }
      if(!['/api/providers/credential','/api/providers/test','/api/providers/routing','/api/providers/jev'].includes(url.pathname))failure(404);
      const input=await body(req);if(!isRevision(input.expectedRevision))failure(400);
      const state=deps.store.readState();if(state.revision!==input.expectedRevision)failure(409,'conflict');
      deps.runtime.routingSnapshot();
      if(controller.signal.aborted)throw new ProviderConfigError('cancelled');
      if(url.pathname==='/api/providers/credential'){
        if(!isProvider(input.provider))failure(400);
        if(input.action==='remove'&&exactKeys(input,['provider','action','expectedRevision']))deps.store.removeCredential(input.provider,input.expectedRevision);
        else if(input.action==='set'&&exactKeys(input,['provider','action','key','expectedRevision'])){
          const key=validateKey(input.key);if(envCredential(environment(),input.provider).managed)failure(409,'environment_managed');
          const master=await (deps.ensureMaster??ensureMaster)(deps.store.root,deps.store.credentialCount(),controller.signal);
          try{if(controller.signal.aborted)throw new ProviderConfigError('cancelled');deps.store.replaceCredential(input.provider,input.expectedRevision,key,master);}finally{master.fill(0);}
        }else failure(400);
      }else if(url.pathname==='/api/providers/routing'){
        if(!exactKeys(input,['target','value','expectedRevision']))failure(400);
        if(input.target==='summary'&&isSummaryRoute(input.value)){
          if(SUMMARY_ENV_KEYS.some(key=>environment()[key]!==undefined))failure(409,'environment_managed');deps.store.setSummary(input.expectedRevision,input.value);
        }else if(input.target==='brain'&&isBrainRoute(input.value)){
          if(BRAIN_ENV_KEYS.some(key=>environment()[key]!==undefined))failure(409,'environment_managed');deps.store.setBrain(input.expectedRevision,input.value);
        }else failure(400);
      }else if(url.pathname==='/api/providers/jev'){
        if(!exactKeys(input,['projectId','enabled','model','expectedRevision'])||!isProjectId(input.projectId)||projectId!==input.projectId)failure(404);
        const policy={enabled:input.enabled,model:input.model};if(!isJevPolicy(policy))failure(400);
        if(Object.values(JEV_ENV_KEYS).some(key=>environment()[key]!==undefined))failure(409,'environment_managed');deps.store.setJev(projectId,input.expectedRevision,policy);
      }else{
        if(!exactKeys(input,['provider','allowUsage','expectedRevision'])||!isProvider(input.provider)||typeof input.allowUsage!=='boolean')failure(400);
        if(input.provider==='typesafe'&&!projectId)failure(404);
        const result=await test({provider:input.provider,allowUsage:input.allowUsage,...(projectId?{model:jevPolicy(state,projectId).model}:{})},controller.signal);
        if(!controller.signal.aborted&&result.credentialRevision!==null)deps.store.recordCheck(input.provider,result.credentialRevision,result);
        send(res,200,{ok:true,...result});return true;
      }
      send(res,200,{ok:true,...await status(projectId,false,controller.signal)});
    }catch(error){
      if(error instanceof HttpFailure)send(res,error.status,{ok:false,error:error.code});
      else if(error instanceof ProviderConfigError){const code=error.code;send(res,code==='conflict'?409:code==='invalid_input'?400:503,{ok:false,error:code==='recovery_required'||code==='cancelled'?'store_unavailable':code});}
      else send(res,503,{ok:false,error:'store_unavailable'});
    }finally{req.removeListener('aborted',abort);res.removeListener('close',close);}
    return true;
  };
}
