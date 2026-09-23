import { afterEach, describe, expect, it, vi } from 'vitest';
import { createServer, request } from 'node:http';
import type { Server } from 'node:http';
import fs from 'node:fs';import os from 'node:os';import path from 'node:path';import { randomBytes } from 'node:crypto';
import { createProviderHandler, withProviderRoutes } from '../providers/http.js';
import { createProviderRuntime } from '../providers/runtime.js';
import { ProviderStore } from '../providers/store.js';
import type { CheckResult } from '../providers/types.js';
const roots:string[]=[];const servers:Server[]=[];const projectId='00000000-0000-4000-8000-000000000001';
afterEach(async()=>{for(const server of servers.splice(0)){server.closeAllConnections();await new Promise<void>(resolve=>server.close(()=>resolve()));}for(const root of roots.splice(0))fs.rmSync(root,{recursive:true,force:true});vi.restoreAllMocks();});
async function fixture(options:{token?:string;bind?:string;env?:Record<string,string|undefined>;check?:(input:unknown,signal?:AbortSignal)=>Promise<CheckResult>}={}){
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'mai-providers-http-'));roots.push(root);const store=new ProviderStore(root);const master=randomBytes(32);const env=options.env??{};
  const readMaster=vi.fn(async()=>Buffer.from(master));const ensureMaster=vi.fn(async()=>Buffer.from(master));
  const runtime=createProviderRuntime({store,env:()=>env,readMaster});let port=0;
  const generic=vi.fn(async(_req,res:import('node:http').ServerResponse)=>{res.writeHead(200);res.end('generic');});
  const native=vi.fn(async()=>({claude:'installed_auth_unverified',codex:'unauthenticated'} as const));
  const handler=createProviderHandler({store,runtime,ensureMaster,check:options.check,native,bind:options.bind??'127.0.0.1',port:()=>port,token:()=>options.token??'fixture-token',env:()=>env,
    resolveProject:async slug=>{if(slug!=='fixture')throw Error('unknown');return projectId;}});
  const server=createServer(withProviderRoutes(handler,generic));servers.push(server);
  await new Promise<void>((resolve,reject)=>{server.once('error',reject);server.listen(0,'127.0.0.1',resolve);});
  const address=server.address();if(!address||typeof address==='string')throw Error('address');port=address.port;
  const origin=`http://127.0.0.1:${port}`;
  async function call(route='/api/providers',value?:unknown,headers:Record<string,string>={},method?:string){
    return new Promise<{status:number;body:unknown;headers:Headers}>((resolve,reject)=>{
      const client=request(origin+route,{method:method??(value===undefined?'GET':'POST'),headers:{'x-mai-brain-token':'fixture-token',Origin:origin,'Content-Type':'application/json',...headers}},response=>{
        const chunks:Buffer[]=[];response.on('data',(chunk:Buffer)=>chunks.push(chunk));response.once('error',reject);
        response.once('end',()=>{const raw=Buffer.concat(chunks).toString('utf8');let body:unknown;try{body=JSON.parse(raw);}catch{body=raw;}
          const received=new Headers();for(const [key,value]of Object.entries(response.headers)){if(typeof value==='string')received.set(key,value);}
          resolve({status:response.statusCode??0,body,headers:received});});
      });client.once('error',reject);client.end(value===undefined?undefined:typeof value==='string'?value:JSON.stringify(value));
    });
  }
  return {store,runtime,readMaster,ensureMaster,generic,native,call,origin,port};
}
describe('local provider route family',()=>{
  it.each([['codex-cli','MAI_CODEX_CLI_MODEL'],['claude-code','MAI_CLAUDE_CODE_MODEL']])('reports the effective model override for %s',async(provider,key)=>{
    const f=await fixture({env:{MAI_LLM_SUMMARY:'1',MAI_LLM_PROVIDER:provider,MAI_SUMMARY_MODEL:'generic-model',[key]:'native-model'}});
    expect((await f.call()).body).toMatchObject({routing:{activeSummary:{provider,model:'native-model'}}});
  });
  it.each(['codex-cli','claude-code'] as const)('uses defaults rather than saved model for explicitly empty %s overrides',async provider=>{
    const key=provider==='codex-cli'?'MAI_CODEX_CLI_MODEL':'MAI_CLAUDE_CODE_MODEL';
    const cases:Record<string,string|undefined>[]=[{[key]:''},{MAI_SUMMARY_MODEL:''},{[key]:'',MAI_SUMMARY_MODEL:'generic-model'},{[key]:'native-model'}];
    for(const env of cases){
      const f=await fixture({env});f.store.setSummary(0,{enabled:true,provider,model:'saved-model',fallback:null});
      expect((await f.call()).body).toMatchObject({routing:{activeSummary:{model:env[key]||env.MAI_SUMMARY_MODEL||null}}});
    }
  });
  it.each([['','fixture-token',503,'local_setup_required'],['fixture-token','',401,'unauthorized'],['fixture-token','wrong',401,'unauthorized'],['fixture-token','fixture-tokex',401,'unauthorized']] as const)('requires configured token even on loopback (%s/%s)',async(token,supplied,status,error)=>{
    const f=await fixture({token});const response=await f.call('/api/providers',undefined,{'x-mai-brain-token':supplied});expect(response).toMatchObject({status,body:{ok:false,error}});expect(response.headers.get('cache-control')).toBe('no-store');expect(response.headers.has('access-control-allow-origin')).toBe(false);expect(f.readMaster).not.toHaveBeenCalled();
  });
  it('rejects nonlocal binds, foreign hosts/origins and cross-site metadata before mutation',async()=>{
    const f=await fixture({bind:'0.0.0.0'});expect((await f.call()).status).toBe(403);
    const local=await fixture();const value={provider:'openai',action:'set',key:'synthetic',expectedRevision:0};
    const deniedHeaders:Record<string,string>[]=[{Host:'evil.example'},{Origin:'http://evil.example'},{Origin:''},{'Sec-Fetch-Site':'cross-site'}];
    for(const headers of deniedHeaders)expect((await local.call('/api/providers/credential',value,headers)).status,JSON.stringify(headers)).toBe(403);
    expect(local.ensureMaster).not.toHaveBeenCalled();expect(local.store.readState().revision).toBe(0);
  });
  it('composes every named child and unknown child inside the isolated boundary',async()=>{
    const f=await fixture();
    expect((await f.call()).body).toMatchObject({ok:true,revision:0});
    const saved=await f.call('/api/providers/credential',{provider:'openai',action:'set',key:'unique-http-secret',expectedRevision:0});
    expect(saved).toMatchObject({status:200,body:{ok:true,revision:1}});expect(JSON.stringify(saved.body)).not.toContain('unique-http-secret');
    expect((await f.call('/api/providers/routing',{target:'brain',value:{enabled:true,provider:'openai'},expectedRevision:1})).body).toMatchObject({ok:true,revision:2,routing:{restartRequired:true}});
    expect((await f.call('/api/providers/jev?project=fixture',{projectId,enabled:true,model:'jev-1.13.0',expectedRevision:2})).status).toBe(200);
    expect((await f.call('/api/providers/test',{provider:'voyage',allowUsage:false,expectedRevision:3})).status).toBe(400);
    expect((await f.call('/api/providers/unknown')).status).toBe(404);expect(f.generic).not.toHaveBeenCalled();
    expect((await f.call('/api/providers-extra')).body).toBe('generic');expect(f.generic).toHaveBeenCalledOnce();
  });
  it('rejects malformed/oversize/unknown fields and wrong methods without keyring',async()=>{
    const f=await fixture();
    for(const value of ['{',{},[],{provider:'openai',action:'set',key:'synthetic',expectedRevision:0,unexpected:true}])expect((await f.call('/api/providers/credential',value)).status).toBe(400);
    expect((await f.call('/api/providers/credential','x'.repeat(17000))).status).toBe(413);
    expect((await f.call('/api/providers',undefined,{},'PUT')).status).toBe(405);
    expect(f.ensureMaster).not.toHaveBeenCalled();expect(f.store.readState().revision).toBe(0);
  });
  it('allows exactly one concurrent revision writer and removal needs no master',async()=>{
    const f=await fixture();const input={provider:'openai',action:'set',key:'unique-http-secret',expectedRevision:0};
    const results=await Promise.all([f.call('/api/providers/credential',input),f.call('/api/providers/credential',input)]);
    expect(results.map(r=>r.status).sort()).toEqual([200,409]);expect(f.store.readState().revision).toBe(1);
    f.ensureMaster.mockClear();expect((await f.call('/api/providers/credential',{provider:'openai',action:'remove',expectedRevision:1})).status).toBe(200);expect(f.ensureMaster).not.toHaveBeenCalled();expect(f.readMaster).not.toHaveBeenCalled();
  });
  it('locks environment-managed writes and permits explicitly removing an overridden saved credential',async()=>{
    const env:Record<string,string|undefined>={};const f=await fixture({env});
    await f.call('/api/providers/credential',{provider:'openai',action:'set',key:'saved-canary',expectedRevision:0});env.OPENAI_API_KEY='';
    const status=await f.call();expect(status.body).toMatchObject({credentials:expect.arrayContaining([expect.objectContaining({provider:'openai',saved:true,configured:false,source:'environment'})])});
    expect((await f.call('/api/providers/credential',{provider:'openai',action:'set',key:'new-canary',expectedRevision:1})).body).toEqual({ok:false,error:'environment_managed'});
    expect((await f.call('/api/providers/credential',{provider:'openai',action:'remove',expectedRevision:1})).status).toBe(200);
  });
  it('resolves selected project and never tests or probes native clients on ordinary status reads',async()=>{
    const check=vi.fn(async()=>({state:'inconclusive',reason:'unavailable',operation:'evaluation',credentialRevision:null,checkedAt:new Date(0).toISOString()} as const));const f=await fixture({check});
    expect((await f.call()).body).toMatchObject({jev:null});expect(f.native).not.toHaveBeenCalled();expect(check).not.toHaveBeenCalled();
    expect((await f.call('/api/providers?native=1')).status).toBe(200);expect(f.native).toHaveBeenCalledOnce();
    expect((await f.call('/api/providers?project=unknown')).status).toBe(404);
    expect((await f.call('/api/providers/jev?project=fixture',{projectId:'00000000-0000-4000-8000-000000000002',enabled:true,model:'jev-1.13.0',expectedRevision:0})).status).toBe(404);
  });
  it('keeps vendor exceptions out of responses and generic logs',async()=>{
    const warn=vi.spyOn(console,'warn');const error=vi.spyOn(console,'error');const f=await fixture({check:async()=>{throw Error('unique-vendor-secret');}});
    const result=await f.call('/api/providers/test',{provider:'openai',allowUsage:false,expectedRevision:0});
    expect(result).toMatchObject({status:503,body:{ok:false,error:'store_unavailable'}});expect(JSON.stringify([result.body,warn.mock.calls,error.mock.calls])).not.toContain('unique-vendor-secret');
  });
  it('cancels an in-flight check on disconnect without persisting its result',async()=>{
    let started:()=>void=()=>{};const startedPromise=new Promise<void>(resolve=>{started=resolve;});let aborted=false;
    const f=await fixture({check:async(_input,signal)=>{started();await new Promise<void>(resolve=>signal?.addEventListener('abort',()=>{aborted=true;resolve();},{once:true}));return {state:'valid',reason:'accepted',operation:'auth',credentialRevision:1,checkedAt:new Date(0).toISOString()};}});
    await f.call('/api/providers/credential',{provider:'openai',action:'set',key:'synthetic',expectedRevision:0});
    const client=request(f.origin+'/api/providers/test',{method:'POST',headers:{Origin:f.origin,'Content-Type':'application/json','x-mai-brain-token':'fixture-token'}});client.on('error',()=>{});client.end(JSON.stringify({provider:'openai',allowUsage:false,expectedRevision:1}));
    await startedPromise;client.destroy();await vi.waitFor(()=>expect(aborted).toBe(true));
    expect(f.store.readState().credentials.find(c=>c.provider==='openai')?.check).toBeNull();
  });
});
