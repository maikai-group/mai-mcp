import { afterEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';import os from 'node:os';import path from 'node:path';import { randomBytes } from 'node:crypto';
import { createProviderRuntime, ENV_KEYS, JEV_ENV_KEYS } from '../providers/runtime.js';
import { ProviderStore } from '../providers/store.js';
import { API_PROVIDERS } from '../providers/types.js';
const roots:string[]=[];
afterEach(()=>{for(const root of roots.splice(0))fs.rmSync(root,{recursive:true,force:true});vi.unstubAllEnvs();vi.resetModules();});
const projectId='00000000-0000-4000-8000-000000000001';
function fixtureStore(){const root=fs.mkdtempSync(path.join(os.tmpdir(),'mai-providers-runtime-'));roots.push(root);return {root,db:new ProviderStore(root)};}
function fixture(env:Record<string,string|undefined>={}){
  const {root,db}=fixtureStore();const master=randomBytes(32);const readMaster=vi.fn(async()=>Buffer.from(master));
  return {root,db,master,readMaster,runtime:createProviderRuntime({env:()=>env,store:db,readMaster})};
}
describe('shared provider runtime',()=>{
  it.each(API_PROVIDERS)('preserves absent/empty/present environment precedence for %s',async provider=>{
    const env:Record<string,string|undefined>={};const f=fixture(env);
    expect(await f.runtime.resolveCredential(provider)).toBeNull();expect(f.readMaster).not.toHaveBeenCalled();
    f.db.replaceCredential(provider,0,'saved',f.master);
    expect(f.runtime.credentialConfigured(provider)).toBe(true);expect(f.readMaster).not.toHaveBeenCalled();
    expect(await f.runtime.resolveCredential(provider)).toBe('saved');
    f.readMaster.mockClear();env[ENV_KEYS[provider]]='';
    expect(f.runtime.credentialConfigured(provider)).toBe(false);expect(await f.runtime.resolveCredential(provider)).toBeNull();
    env[ENV_KEYS[provider]]=' env-key ';
    expect(await f.runtime.resolveCredential(provider)).toBe('env-key');expect(f.readMaster).not.toHaveBeenCalled();
  });
  it('uses the replacement credential on the next Jev resolution',async()=>{
    const f=fixture();f.db.replaceCredential('typesafe',0,'first-key',f.master);f.db.setJev(projectId,1,{enabled:true,model:'jev-1.13.0'});
    const first=await f.runtime.resolveJevConfig(projectId);expect(first.state).toBe('ready');if(first.state!=='ready')throw Error('expected ready');
    expect(first.config.key).toBe('first-key');f.db.replaceCredential('typesafe',2,'second-key',f.master);
    const second=await f.runtime.resolveJevConfig(projectId);if(second.state!=='ready')throw Error('expected ready');
    expect(second.config.key).toBe('second-key');expect(first.config.key).toBe('first-key');
    f.db.removeCredential('typesafe',3);expect(await f.runtime.resolveJevConfig(projectId)).toEqual({state:'disabled',reason:'missing_key'});
  });
  it('keeps summary and brain routes frozen in old instances while new instances see edits',()=>{
    const f=fixture();f.db.setBrain(0,{enabled:true,provider:'openai'});
    expect(f.runtime.routingSnapshot().brain?.provider).toBe('openai');
    f.db.setBrain(1,{enabled:true,provider:'voyage'});f.db.setSummary(2,{enabled:true,provider:'openai',model:null,fallback:null});
    expect(f.runtime.routingSnapshot()).toMatchObject({brain:{provider:'openai'},summary:null,revision:1});
    const next=createProviderRuntime({env:()=>({}),store:f.db,readMaster:f.readMaster});
    expect(next.routingSnapshot()).toMatchObject({brain:{provider:'voyage'},summary:{provider:'openai'},revision:3});
    const snapshot=next.routingSnapshot();if(snapshot.brain)snapshot.brain.provider='local';
    expect(next.routingSnapshot().brain?.provider).toBe('voyage');
  });
  it('does not enable another project or consult the master for disabled Jev',async()=>{
    const f=fixture();f.db.replaceCredential('typesafe',0,'unique-metadata-canary',f.master);
    f.db.setJev('00000000-0000-4000-8000-000000000002',1,{enabled:true,model:'jev-1.13.0'});
    expect(await f.runtime.resolveJevConfig(projectId)).toEqual({state:'disabled',reason:'not_enabled'});expect(f.readMaster).not.toHaveBeenCalled();
    expect(JSON.stringify(f.db.readState())).not.toContain('unique-metadata-canary');
  });
  it.each([
    ['TYPESAFE_API_KEY','missing_key'],[JEV_ENV_KEYS.enabled,'not_enabled'],[JEV_ENV_KEYS.model,'invalid_configuration'],
  ])('preserves an explicit empty %s without saved fallback/keyring lookup',async(key,reason)=>{
    const f=fixture({[key]:''});f.db.replaceCredential('typesafe',0,'saved',f.master);f.db.setJev(projectId,1,{enabled:true,model:'jev-1.13.0'});
    expect(await f.runtime.resolveJevConfig(projectId)).toMatchObject({reason});expect(f.readMaster).not.toHaveBeenCalled();
  });
  it('applies enabled and model overrides through the exported env keys',async()=>{
    const f=fixture({[JEV_ENV_KEYS.enabled]:'1',[JEV_ENV_KEYS.model]:'jev-override',TYPESAFE_API_KEY:'env'});
    expect(await f.runtime.resolveJevConfig(projectId)).toEqual({state:'ready',config:{key:'env',model:'jev-override'},revision:0,credentialSource:'environment'});
    expect(f.readMaster).not.toHaveBeenCalled();
  });
  it('fails closed for incompatible ciphertext, missing master and unreadable routing',async()=>{
    const f=fixture();f.db.replaceCredential('typesafe',0,'saved',f.master);f.db.setJev(projectId,1,{enabled:true,model:'jev-1.13.0'});
    f.readMaster.mockResolvedValue(Buffer.alloc(32));
    await expect(f.runtime.resolveCredential('typesafe')).rejects.toThrow('store_unavailable');
    expect(await f.runtime.resolveJevConfig(projectId)).toEqual({state:'unavailable',reason:'store_unavailable'});
    const missing=createProviderRuntime({env:()=>({}),store:f.db,readMaster:async()=>null});
    await expect(missing.resolveCredential('typesafe')).rejects.toThrow('recovery_required');
    fs.writeFileSync(path.join(f.root,'providers.sqlite'),'bad');
    expect(()=>missing.routingSnapshot()).toThrow('store_unavailable');expect(missing.credentialConfigured('typesafe')).toBe(false);
  });
  it('clears acquired master bytes on success and cancellation',async()=>{
    const f=fixture();f.db.replaceCredential('openai',0,'saved',f.master);let bytes=Buffer.from(f.master);
    const controller=new AbortController();
    const runtime=createProviderRuntime({env:()=>({}),store:f.db,readMaster:async()=>bytes});
    expect(await runtime.resolveCredential('openai')).toBe('saved');expect(bytes).toEqual(Buffer.alloc(32));
    bytes=Buffer.from(f.master);
    const aborting=createProviderRuntime({env:()=>({}),store:f.db,readMaster:async()=>{controller.abort();return bytes;}});
    await expect(aborting.resolveCredential('openai',controller.signal)).rejects.toThrow('cancelled');expect(bytes).toEqual(Buffer.alloc(32));
  });
  it('wires production lazily to an isolated root with no keyring access',async()=>{
    const {root}=fixtureStore();vi.stubEnv('MAI_STATE_HOME',root);vi.stubEnv('TYPESAFE_API_KEY','env');vi.stubEnv('MAI_JEV_ENABLED','1');vi.stubEnv('MAI_JEV_MODEL','jev-1.13.0');
    vi.resetModules();const runtime=await import('../providers/runtime.js');
    expect(fs.readdirSync(root)).toEqual([]);expect(await runtime.resolveCredential('typesafe')).toBe('env');
    expect((await runtime.resolveJevConfig(projectId)).state).toBe('ready');expect(fs.readdirSync(root)).toEqual([]);
  });
});
