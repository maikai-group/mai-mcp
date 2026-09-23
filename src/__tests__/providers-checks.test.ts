import { describe, expect, it, vi, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { checkConnection, checkNativeClients, readProviderJson, runNativeProbe } from '../providers/checks.js';
import type { CheckDeps } from '../providers/checks.js';
import { ProviderConfigError } from '../providers/types.js';
function deps(response:()=>Promise<Response>):CheckDeps {return {fetch:vi.fn(response),resolveCredential:vi.fn(async()=>'unique-secret'),credentialRevision:()=> 'saved:1',now:()=>0};}
afterEach(()=>{vi.unstubAllEnvs();vi.useRealTimers();});
describe('explicit provider checks',()=>{
  it.each([200,401])('cannot retain a definitive result after late metadata failure (%s)',async status=>{
    let calls=0;const d=deps(async()=>new Response('',{status}));
    d.credentialRevision=()=>{if(++calls===3)throw new ProviderConfigError('store_unavailable');return 'saved:1';};
    expect(await checkConnection({provider:'openai',allowUsage:false},d)).toMatchObject({state:'inconclusive',reason:'unavailable'});
  });
  it('aborts a transport at the ten-second deadline',async()=>{
    vi.useFakeTimers();let aborted=false;
    const d=deps(async()=>new Response(''));
    d.fetch=async(_input,init)=>new Promise((_resolve,reject)=>init?.signal?.addEventListener('abort',()=>{aborted=true;reject(Error('aborted'));},{once:true}));
    const pending=checkConnection({provider:'openai',allowUsage:false},d);
    await vi.advanceTimersByTimeAsync(10000);
    expect(await pending).toMatchObject({reason:'network',state:'inconclusive'});expect(aborted).toBe(true);
  });
  it('reaps both timed-out native CLI probes before reporting unavailable',async()=>{
    const root=fs.mkdtempSync(path.join(os.tmpdir(),'mai-provider-native-'));
    const pids:number[]=[];
    try{
      const result=await checkNativeClients(undefined,{find:()=>process.execPath,run:async(executable,args,env,signal)=>{
        const file=path.join(root,args[0]==='--version'?'claude':'codex');
        const result=await runNativeProbe(executable,['-e',"require('node:fs').writeFileSync(process.argv[1],String(process.pid));setInterval(()=>{},1000)",file],env,signal);
        const pid=Number(fs.readFileSync(file,'utf8'));pids.push(pid);expect(()=>process.kill(pid,0)).toThrow();return result;
      }});
      expect(result).toEqual({claude:'unavailable',codex:'unavailable'});expect(pids).toHaveLength(2);
    }finally{for(const pid of pids){try{process.kill(pid,'SIGKILL');}catch{}}fs.rmSync(root,{recursive:true,force:true});}
  });
  it.each(['openai','anthropic'] as const)('pins %s endpoint and checks authentication only',async provider=>{
    let request:Request|undefined;
    const d=deps(async()=>new Response('not JSON',{status:200}));
    d.fetch=vi.fn(async(input,init)=>{request=new Request(input,init);return new Response('not JSON');});
    const result=await checkConnection({provider,allowUsage:false},d);
    expect(result).toMatchObject({state:'valid',operation:'auth',credentialRevision:1,reason:'accepted'});
    expect(request?.url).toBe(provider==='openai'?'https://api.openai.com/v1/models':'https://api.anthropic.com/v1/models?limit=1');expect(request?.redirect).toBe('error');
    expect(JSON.stringify(result)).not.toContain('unique-secret');
  });
  it.each(['typesafe','voyage'] as const)('requires explicit usage consent for %s before lookup',async provider=>{
    const d=deps(async()=>new Response('{}'));
    await expect(checkConnection({provider,allowUsage:false,model:'jev-1.13.0'},d)).rejects.toThrow('invalid_input');
    expect(d.resolveCredential).not.toHaveBeenCalled();expect(d.fetch).not.toHaveBeenCalled();
  });
  it.each([[401,'rejected'],[403,'rejected'],[429,'rate_limit'],[500,'provider_error'],[302,'invalid_response']] as const)('classifies status %s without echoing body',async(code,reason)=>{
    const d=deps(async()=>new Response('unique-secret',{status:code}));
    const result=await checkConnection({provider:'openai',allowUsage:false},d);expect(result.reason).toBe(reason);expect(JSON.stringify(result)).not.toContain('unique-secret');
  });
  it('validates the paid inference/embedding shapes',async()=>{
    const typesafe=deps(async()=>Response.json({answers:{connection:{type:'noul',noul:0.8}}}));
    expect(await checkConnection({provider:'typesafe',allowUsage:true,model:'jev-1.13.0'},typesafe)).toMatchObject({state:'valid',operation:'evaluation'});
    const voyage=deps(async()=>Response.json({data:[{embedding:[1,2,3]}]}));
    expect(await checkConnection({provider:'voyage',allowUsage:true},voyage)).toMatchObject({state:'valid',operation:'embedding'});
    expect(await checkConnection({provider:'voyage',allowUsage:true},deps(async()=>Response.json({data:[{embedding:['bad']}]})))).toMatchObject({reason:'invalid_response'});
  });
  it('cancels oversized streams and redacts thrown transport diagnostics',async()=>{
    const cancel=vi.fn();const response=new Response(new ReadableStream({start(c){c.enqueue(new Uint8Array(65537));},cancel}));
    expect(await checkConnection({provider:'voyage',allowUsage:true},deps(async()=>response))).toMatchObject({reason:'invalid_response'});expect(cancel).toHaveBeenCalled();
    const result=await checkConnection({provider:'openai',allowUsage:false},deps(async()=>{throw Error('unique-secret');}));expect(result.reason).toBe('network');expect(JSON.stringify(result)).not.toContain('unique-secret');
  });
  it('does not stamp replaced credentials valid and retries acquisition once',async()=>{
    let revision='saved:1';const d=deps(async()=>{revision='saved:2';return new Response('');});d.credentialRevision=()=>revision;
    expect(await checkConnection({provider:'openai',allowUsage:false},d)).toMatchObject({reason:'configuration_changed',state:'inconclusive',credentialRevision:1});
    let reads=0;d.resolveCredential=vi.fn(async()=>{revision=`saved:${++reads+2}`;return 'unique-secret';});d.fetch=vi.fn(async()=>new Response(''));
    expect(await checkConnection({provider:'openai',allowUsage:false},d)).toMatchObject({reason:'configuration_changed'});expect(d.fetch).not.toHaveBeenCalled();expect(reads).toBe(2);
  });
  it('cancels body reads through caller cancellation',async()=>{
    const controller=new AbortController();const cancel=vi.fn();const pending=readProviderJson(new Response(new ReadableStream({cancel})),64,controller.signal);
    controller.abort();await expect(pending).rejects.toThrow('cancelled');expect(cancel).toHaveBeenCalled();
  });
  it('reports native status honestly using scrubbed environments',async()=>{
    vi.stubEnv('OPENAI_API_KEY','unique-secret');vi.stubEnv('MAI_BRAIN_WEB_TOKEN','token');
    const run=vi.fn(async(_exe:string,args:readonly string[],env:NodeJS.ProcessEnv)=>{expect(env.OPENAI_API_KEY).toBeUndefined();expect(env.MAI_BRAIN_WEB_TOKEN).toBeUndefined();return args[0]==='--version'?0:1;});
    expect(await checkNativeClients(undefined,{find:name=>name,run})).toEqual({claude:'installed_auth_unverified',codex:'unauthenticated'});
    expect(await checkNativeClients(undefined,{find:()=>null,run})).toEqual({claude:'unavailable',codex:'unavailable'});
  });
});
