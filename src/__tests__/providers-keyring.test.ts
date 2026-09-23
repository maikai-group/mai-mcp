import { describe, expect, it, vi } from 'vitest';
import { fileURLToPath } from 'node:url';
import { createKeyringHelper, createMasterService, keyringChildEnv, readMaster } from '../providers/keyring.js';
import { handleMasterRequest } from '../providers/keyring-worker.js';
const account='a'.repeat(64);
const helper=fileURLToPath(new URL('./fixtures/providers/keyring-fake.mjs',import.meta.url));
const signal=()=>new AbortController().signal;
const request=(operation: string)=>JSON.stringify({operation,account});
describe('isolated master service',()=>{
  it('creates and reads back a master with a fake Entry, preserving existing entries',async()=>{
    let stored: string|null=null; let writes=0;
    const entry=async()=>({getPassword:()=>stored,setPassword:(value:string)=>{stored=value;writes++;}});
    expect(await handleMasterRequest(request('read'),entry)).toBe('{"ok":true,"master":null}');
    const created: unknown=JSON.parse(await handleMasterRequest(request('create'),entry));
    expect(created).toMatchObject({ok:true}); expect(stored).toHaveLength(44); expect(writes).toBe(1);
    await handleMasterRequest(request('create'),entry); expect(writes).toBe(1);
  });
  it('rejects malformed/oversized requests before accessing Entry and redacts native failures',async()=>{
    const entry=vi.fn(async()=>{throw Error('synthetic-native-secret');});
    for(const raw of ['{}',request('delete'),'x'.repeat(1025),JSON.stringify({operation:'read',account,extra:true})]) {
      expect(await handleMasterRequest(raw,entry)).toBe('{"ok":false,"error":"store_unavailable"}');
    }
    expect(entry).not.toHaveBeenCalled();
    expect(await handleMasterRequest(request('read'),entry)).not.toContain('synthetic-native-secret');
  });
  it('rejects failed readback and invalid stored masters',async()=>{
    expect(await handleMasterRequest(request('create'),async()=>({getPassword:()=>null,setPassword:()=>{}}))).toContain('store_unavailable');
    expect(await handleMasterRequest(request('read'),async()=>({getPassword:()=> 'wrong',setPassword:()=>{}}))).toContain('store_unavailable');
  });
  it('never regenerates a missing master for existing encrypted rows',async()=>{
    const read=vi.fn<()=>Promise<Buffer|null>>().mockResolvedValue(null);
    const create=vi.fn<()=>Promise<Buffer>>();const release=vi.fn();
    const service=createMasterService({read,create,lock:async()=>({release})});
    await expect(service.ensure(1,signal())).rejects.toThrow('recovery_required');
    expect(create).not.toHaveBeenCalled();expect(release).toHaveBeenCalledOnce();
  });
  it('returns an existing master without create and initializes an empty store once',async()=>{
    const create=vi.fn(async()=>Buffer.alloc(32,9));
    const existing=createMasterService({read:async()=>Buffer.alloc(32,8),create,lock:async()=>({release(){}})});
    expect(await existing.ensure(2,signal())).toEqual(Buffer.alloc(32,8));expect(create).not.toHaveBeenCalled();
    const absent=createMasterService({read:async()=>null,create,lock:async()=>({release(){}})});
    expect(await absent.ensure(0,signal())).toEqual(Buffer.alloc(32,9));expect(create).toHaveBeenCalledOnce();
  });
  it('does not acquire a lock after cancellation and redacts release errors',async()=>{
    const lock=vi.fn(async()=>({release(){throw Error('private lock path');}}));
    const service=createMasterService({read:async()=>Buffer.alloc(32),create:async()=>Buffer.alloc(32),lock});
    const controller=new AbortController();controller.abort();
    await expect(service.ensure(0,controller.signal)).rejects.toThrow('cancelled');expect(lock).not.toHaveBeenCalled();
    await expect(service.ensure(0,signal())).rejects.toThrow('store_unavailable');
  });
  it('reconciles an ambiguous create once before returning',async()=>{
    const order:string[]=[];let reads=0;
    const service=createMasterService({read:async()=>{order.push('read');return reads++?Buffer.alloc(32,4):null;},
      create:async()=>{order.push('create');throw Error('timeout');},lock:async()=>({release(){order.push('release');}})});
    expect(await service.ensure(0,signal())).toEqual(Buffer.alloc(32,4));
    expect(order).toEqual(['read','create','read','release']);
  });
  it('redacts locked backend, releases lock, and never creates after failed read',async()=>{
    const create=vi.fn<()=>Promise<Buffer>>();const release=vi.fn();
    const service=createMasterService({read:async()=>{throw Error('private backend info');},create,lock:async()=>({release})});
    await expect(service.ensure(0,signal())).rejects.toThrow('store_unavailable');
    expect(create).not.toHaveBeenCalled();expect(release).toHaveBeenCalledOnce();
  });
  it('uses actual spawned helpers for success and absent responses',async()=>{
    expect(await createKeyringHelper({helper,args:['read-valid']})('read',account)).toEqual(Buffer.alloc(32,7));
    expect(await createKeyringHelper({helper,args:['absent']})('read',account)).toBeNull();
  });
  it.each(['malformed','oversized','stderr-secret','hang'])('rejects %s after child is reaped',async mode=>{
    let pid:number|undefined;
    const run=createKeyringHelper({helper,args:[mode],timeoutMs:150,onSpawn:p=>{pid=p;}});
    await expect(run('read',account)).rejects.toThrow('store_unavailable');
    const exitedPid=pid; if(exitedPid!==undefined) expect(()=>process.kill(exitedPid,0)).toThrow();
  });
  it('cancels before spawn and after input without leaving a live child',async()=>{
    const controller=new AbortController();controller.abort();const onSpawn=vi.fn();
    expect(()=>createKeyringHelper({helper,onSpawn})('read',account,controller.signal)).toThrow('cancelled');
    expect(onSpawn).not.toHaveBeenCalled();
    const active=new AbortController();let pid:number|undefined;
    const pending=createKeyringHelper({helper,args:['hang'],onSpawn:p=>{pid=p;setTimeout(()=>active.abort(),30);}})('read',account,active.signal);
    await expect(pending).rejects.toThrow('cancelled');
    const exitedPid=pid; if(exitedPid!==undefined)expect(()=>process.kill(exitedPid,0)).toThrow();
  });
  it('isolates child environment and does not create absent roots',async()=>{
    const env={HOME:'/tmp',PATH:process.env.PATH,OPENAI_API_KEY:'synthetic',MAI_BRAIN_WEB_TOKEN:'synthetic',NODE_OPTIONS:'--bad',LC_ALL:'C'};
    expect(keyringChildEnv(env)).toEqual({HOME:'/tmp',PATH:process.env.PATH,LC_ALL:'C'});
    expect(await createKeyringHelper({helper,args:['env'],env})('read',account)).toEqual(Buffer.alloc(32,7));
    expect(await readMaster(fileURLToPath(new URL('./fixtures/providers/absent-root',import.meta.url)))).toBeNull();
  });
});
