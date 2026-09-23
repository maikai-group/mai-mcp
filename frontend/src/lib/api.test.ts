import {afterEach,expect,it,vi} from 'vitest';
import {apiGet,apiPost,setProject} from './api';
afterEach(()=>{vi.unstubAllGlobals();localStorage.clear();setProject('');});
it('preserves true envelopes, project/token handling and supplied GET/POST signals',async()=>{
  const fetch=vi.fn(async()=>new Response(JSON.stringify({ok:true,revision:2})));vi.stubGlobal('fetch',fetch);setProject('one');localStorage.setItem('mai-brain-token','test-token');
  const signal=new AbortController().signal;
  expect(await apiGet('/providers',undefined,{signal})).toEqual({ok:true,revision:2});
  expect(await apiPost('/providers/credential',{key:'synthetic'},{signal})).toEqual({ok:true,revision:2});
  expect(fetch.mock.calls).toHaveLength(2);
  for(const call of vi.mocked(globalThis.fetch).mock.calls){expect(String(call[0])).toContain('project=one');expect(call[1]?.signal).toBe(signal);expect(call[1]?.headers).toMatchObject({'x-mai-brain-token':'test-token'});}
});
it.each([{revision:2},{ok:false,error:'denied'}])('rejects a false or missing success envelope',async body=>{
  vi.stubGlobal('fetch',vi.fn(async()=>new Response(JSON.stringify(body))));await expect(apiGet('/providers')).rejects.toThrow();await expect(apiPost('/providers',{})).rejects.toThrow();
});
it.each(['GET','POST'])('propagates cancellation during %s JSON handling',async method=>{
  const controller=new AbortController();const response=new Response('{}');let rejectJson:(reason:unknown)=>void=()=>{};
  vi.spyOn(response,'json').mockImplementation(()=>new Promise((_resolve,reject)=>{rejectJson=reject;}));
  vi.stubGlobal('fetch',vi.fn(async()=>response));const pending=method==='GET'?apiGet('/providers',undefined,{signal:controller.signal}):apiPost('/providers',{}, {signal:controller.signal});
  await Promise.resolve();controller.abort();rejectJson(controller.signal.reason);await expect(pending).rejects.toHaveProperty('name','AbortError');
});
