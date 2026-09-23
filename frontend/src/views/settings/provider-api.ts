import {apiGet,apiPost} from '../../lib/api';
export type ApiProvider='typesafe'|'anthropic'|'openai'|'voyage';
export const PROVIDERS:readonly ApiProvider[]=['typesafe','anthropic','openai','voyage'];
export type SummaryProvider='anthropic'|'openai'|'claude-code'|'codex-cli';
export interface SummaryRoute {enabled:boolean;provider:SummaryProvider;model:string|null;fallback:'claude-code'|'codex-cli'|null}
export interface BrainRoute {enabled:boolean;provider:'local'|'openai'|'voyage'}
export interface CheckResult {state:'unchecked'|'valid'|'rejected'|'inconclusive';checkedAt:string;operation:'auth'|'embedding'|'evaluation';credentialRevision:number|null;reason:string}
export interface Credential {provider:ApiProvider;saved:boolean;configured:boolean;revision:number;source:'environment'|'saved'|'missing';check:CheckResult|null}
export interface ProviderStatus {
  revision:number;storage:'available'|'unconfigured'|'unavailable';credentials:Credential[];
  routing:{savedSummary:SummaryRoute|null;savedBrain:BrainRoute|null;activeSummary:SummaryRoute|null;activeBrain:BrainRoute|null;restartRequired:boolean;managed:{summary:string[];brain:string[]}};
  jev:{projectId:string;policy:{enabled:boolean;model:string};managed:string[]}|null;
  native?:{claude:'installed_auth_unverified'|'unavailable';codex:'authenticated'|'unauthenticated'|'unavailable'};
}
function invalid():never{throw new Error('invalid_provider_response');}
function isRecord(v:unknown):v is Record<string,unknown>{return typeof v==='object'&&v!==null&&!Array.isArray(v);}
function record(v:unknown):Record<string,unknown>{if(!isRecord(v))return invalid();return v;}
function string(v:unknown):string{if(typeof v!=='string'||v.length>256)return invalid();return v;}
function bool(v:unknown):boolean{if(typeof v!=='boolean')return invalid();return v;}
function revision(v:unknown):number{if(typeof v!=='number'||!Number.isSafeInteger(v)||v<0)return invalid();return v;}
function member<const T extends string>(v:unknown,allowed:readonly T[]):T{const found=allowed.find(item=>item===v);return found??invalid();}
function strings(v:unknown):string[]{if(!Array.isArray(v))return invalid();return v.map(item=>string(item));}
function summary(v:unknown):SummaryRoute|null{if(v===null)return null;const x=record(v);return {enabled:bool(x.enabled),provider:member(x.provider,['anthropic','openai','claude-code','codex-cli']),model:x.model===null?null:string(x.model),fallback:x.fallback===null?null:member(x.fallback,['claude-code','codex-cli'])};}
function brain(v:unknown):BrainRoute|null{if(v===null)return null;const x=record(v);return {enabled:bool(x.enabled),provider:member(x.provider,['local','openai','voyage'])};}
function check(v:unknown):CheckResult{const x=record(v);return {state:member(x.state,['unchecked','valid','rejected','inconclusive']),checkedAt:string(x.checkedAt),operation:member(x.operation,['auth','embedding','evaluation']),credentialRevision:x.credentialRevision===null?null:revision(x.credentialRevision),reason:member(x.reason,['accepted','rejected','network','rate_limit','provider_error','unavailable','invalid_response','configuration_changed'])};}
function decode(v:unknown):ProviderStatus{
  const x=record(v),routing=record(x.routing),managed=record(routing.managed);
  if(!Array.isArray(x.credentials))return invalid();
  const credentials=x.credentials.map((item:unknown):Credential=>{const c=record(item);return {provider:member(c.provider,PROVIDERS),saved:bool(c.saved),configured:bool(c.configured),revision:revision(c.revision),source:member(c.source,['environment','saved','missing']),check:c.check===null?null:check(c.check)};});
  if(credentials.length!==4||new Set(credentials.map(c=>c.provider)).size!==4)return invalid();
  const j=x.jev===null?null:record(x.jev),p=j?record(j.policy):null;
  const result:ProviderStatus={revision:revision(x.revision),storage:member(x.storage,['available','unconfigured','unavailable']),credentials,
    routing:{savedSummary:summary(routing.savedSummary),savedBrain:brain(routing.savedBrain),activeSummary:summary(routing.activeSummary),activeBrain:brain(routing.activeBrain),restartRequired:bool(routing.restartRequired),managed:{summary:strings(managed.summary),brain:strings(managed.brain)}},
    jev:j&&p?{projectId:string(j.projectId),policy:{enabled:bool(p.enabled),model:string(p.model)},managed:strings(j.managed)}:null};
  if(x.native!==undefined){const n=record(x.native);result.native={claude:member(n.claude,['installed_auth_unverified','unavailable']),codex:member(n.codex,['authenticated','unauthenticated','unavailable'])};}
  return result;
}
export async function getProviderStatus(native=false,signal?:AbortSignal):Promise<ProviderStatus>{return decode(await apiGet<unknown>('/providers',native?{native:1}:undefined,{signal}));}
export async function saveCredential(provider:ApiProvider,key:string,expectedRevision:number,signal?:AbortSignal):Promise<ProviderStatus>{return decode(await apiPost<unknown>('/providers/credential',{provider,action:'set',key,expectedRevision},{signal}));}
export async function removeCredential(provider:ApiProvider,expectedRevision:number,signal?:AbortSignal):Promise<ProviderStatus>{return decode(await apiPost<unknown>('/providers/credential',{provider,action:'remove',expectedRevision},{signal}));}
export async function testCredential(provider:ApiProvider,allowUsage:boolean,expectedRevision:number,signal?:AbortSignal):Promise<CheckResult>{return check(await apiPost<unknown>('/providers/test',{provider,allowUsage,expectedRevision},{signal}));}
export async function saveRouting(target:'summary'|'brain',value:SummaryRoute|BrainRoute,expectedRevision:number,signal?:AbortSignal):Promise<ProviderStatus>{return decode(await apiPost<unknown>('/providers/routing',{target,value,expectedRevision},{signal}));}
export async function saveJevPolicy(projectId:string,enabled:boolean,model:string,expectedRevision:number,signal?:AbortSignal):Promise<ProviderStatus>{return decode(await apiPost<unknown>('/providers/jev',{projectId,enabled,model,expectedRevision},{signal}));}
