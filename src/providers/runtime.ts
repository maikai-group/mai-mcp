import { maiStateRoot } from '../platform/paths.js';
import { decryptKey } from './crypto.js';
import { readMaster as readProductionMaster } from './keyring.js';
import { ProviderStore } from './store.js';
import { ProviderConfigError, isModel, isProjectId } from './types.js';
import type { ApiProvider, BrainRoute, SummaryRoute } from './types.js';
export type { ApiProvider, CredentialSource } from './types.js';
export type ResolvedJevConfig =
  | {state:'disabled';reason:'not_enabled'|'missing_key'}
  | {state:'unavailable';reason:'store_unavailable'|'invalid_configuration'}
  | {state:'ready';config:{key:string;model:string};revision:number;credentialSource:'environment'|'saved'};
export const ENV_KEYS: Record<ApiProvider,string> = {
  typesafe:'TYPESAFE_API_KEY',anthropic:'ANTHROPIC_API_KEY',openai:'OPENAI_API_KEY',voyage:'VOYAGE_API_KEY',
};
export const JEV_ENV_KEYS = {enabled:'MAI_JEV_ENABLED',model:'MAI_JEV_MODEL'} as const;
export const DEFAULT_JEV_POLICY = {enabled:false,model:'jev-1.13.0'};
export function envCredential(env: Record<string,string|undefined>,provider:ApiProvider):
  {managed:false}|{managed:true;key:string|null} {
  const raw=env[ENV_KEYS[provider]];
  return raw===undefined ? {managed:false} : {managed:true,key:raw.trim()||null};
}
interface RoutingSnapshot {summary:SummaryRoute|null;brain:BrainRoute|null;revision:number}
interface RuntimeDependencies {
  env():Record<string,string|undefined>;
  store:ProviderStore;
  readMaster(signal?:AbortSignal):Promise<Buffer|null>;
}
function checkAbort(signal?:AbortSignal):void { if(signal?.aborted)throw new ProviderConfigError('cancelled'); }
export function createProviderRuntime({env,store,readMaster}:RuntimeDependencies) {
  let snapshot:RoutingSnapshot|undefined;
  let snapshotFailed=false;
  function routingSnapshot():RoutingSnapshot {
    if(snapshotFailed)throw new ProviderConfigError('store_unavailable');
    if(!snapshot) {
      try {const state=store.readState();snapshot={summary:state.summary,brain:state.brain,revision:state.revision};}
      catch {snapshotFailed=true;throw new ProviderConfigError('store_unavailable');}
    }
    return {revision:snapshot.revision,summary:snapshot.summary?{...snapshot.summary}:null,brain:snapshot.brain?{...snapshot.brain}:null};
  }
  function credentialConfigured(provider:ApiProvider):boolean {
    const configured=envCredential(env(),provider);
    if(configured.managed)return configured.key!==null;
    try {return store.readState().credentials.some(item=>item.provider===provider&&item.saved);}
    catch{return false;}
  }
  function credentialRevision(provider:ApiProvider):string {
    if(envCredential(env(),provider).managed)return 'environment';
    const row=store.readState().credentials.find(item=>item.provider===provider&&item.saved);
    return row?`saved:${row.revision}`:'missing';
  }
  async function resolveCredential(provider:ApiProvider,signal?:AbortSignal):Promise<string|null> {
    checkAbort(signal);
    const configured=envCredential(env(),provider);
    if(configured.managed)return configured.key;
    let master:Buffer|null=null;
    try {
      const saved=store.readCiphertext(provider);
      if(!saved)return null;
      master=await readMaster(signal);checkAbort(signal);
      if(!master)throw new ProviderConfigError('recovery_required');
      return decryptKey(saved.box,master,provider,saved.revision);
    } catch(error) {
      if(error instanceof ProviderConfigError)throw error;
      throw new ProviderConfigError('store_unavailable');
    } finally {master?.fill(0);}
  }
  async function resolveJevConfig(projectId:string,signal?:AbortSignal):Promise<ResolvedJevConfig> {
    checkAbort(signal);
    if(!isProjectId(projectId))return {state:'unavailable',reason:'invalid_configuration'};
    try {
      const state=store.readState();
      const policy=state.jev[projectId]??DEFAULT_JEV_POLICY;
      const environment=env();
      const enabled=environment[JEV_ENV_KEYS.enabled]===undefined?policy.enabled:environment[JEV_ENV_KEYS.enabled]==='1';
      const model=environment[JEV_ENV_KEYS.model]??policy.model;
      if(!isModel(model))return {state:'unavailable',reason:'invalid_configuration'};
      if(!enabled)return {state:'disabled',reason:'not_enabled'};
      const key=await resolveCredential('typesafe',signal);
      if(!key)return {state:'disabled',reason:'missing_key'};
      return {state:'ready',config:{key,model},revision:state.revision,
        credentialSource:envCredential(environment,'typesafe').managed?'environment':'saved'};
    } catch(error) {
      if(error instanceof ProviderConfigError&&error.code==='cancelled')throw error;
      return {state:'unavailable',reason:'store_unavailable'};
    }
  }
  return {credentialConfigured,credentialRevision,resolveCredential,resolveJevConfig,routingSnapshot};
}
let production:ReturnType<typeof createProviderRuntime>|undefined;
function runtime():ReturnType<typeof createProviderRuntime> {
  if(!production){const root=maiStateRoot();production=createProviderRuntime({env:()=>process.env,store:new ProviderStore(root),readMaster:signal=>readProductionMaster(root,signal)});}
  return production;
}
export function credentialConfigured(provider:ApiProvider):boolean{return runtime().credentialConfigured(provider);}
export function resolveCredential(provider:ApiProvider,signal?:AbortSignal):Promise<string|null>{return runtime().resolveCredential(provider,signal);}
export function resolveJevConfig(projectId:string,signal?:AbortSignal):Promise<ResolvedJevConfig>{return runtime().resolveJevConfig(projectId,signal);}
export function routingSnapshot():RoutingSnapshot{return runtime().routingSnapshot();}

export function credentialRevision(provider:ApiProvider):string{return runtime().credentialRevision(provider);}
