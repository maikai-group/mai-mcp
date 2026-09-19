import { beforeEach, expect, it, vi } from 'vitest';
import { EventEmitter } from 'node:events';
const state=vi.hoisted(()=>({workers:new Array<EventEmitter>(),post:vi.fn(),terminate:vi.fn()}));
vi.mock('node:worker_threads',()=>({Worker:class extends EventEmitter{
  constructor(public url:URL,public options:unknown){super();state.workers.push(this);}
  postMessage(value:unknown){state.post(value);}
  terminate(){state.terminate();queueMicrotask(()=>this.emit('exit',1));return Promise.resolve(1);}
}}));
import { createLocalModelThread } from '../graph/semantic/local-model-thread.js';
beforeEach(()=>{state.workers.length=0;state.post.mockReset();state.terminate.mockReset();});
async function loaded(){
  const pending=createLocalModelThread('local:bge-small-en-v1.5');
  const worker=state.workers.at(-1);if(!worker)throw Error('Missing worker');worker.emit('message',{ready:true});
  const provider=await pending;if(!provider)throw Error('Missing provider');
  return {worker,provider};
}
it('routes one bounded in-flight operation, validates vectors and waits for real thread exit at close',async()=>{
  const {worker,provider}=await loaded();
  const vector=Array(384).fill(1),result=provider.query('question');
  expect(state.post).toHaveBeenLastCalledWith({id:1,operation:'query',text:'question'});
  expect(await provider.document('concurrent')).toBeNull();
  worker.emit('message',{id:1,value:vector});expect(await result).toEqual(vector);
  const ranks=provider.rerank?.('question',['one','two']);
  worker.emit('message',{id:2,value:[2,1]});expect(await ranks).toEqual([2,1]);
  let done=false;const closing=provider.close().then(()=>{done=true;});
  expect(await provider.query('closed')).toBeNull();await Promise.resolve();expect(done).toBe(false);
  expect(state.post).toHaveBeenLastCalledWith({operation:'close'});
  worker.emit('exit',0);await closing;expect(done).toBe(true);await provider.close();
  expect(state.terminate).not.toHaveBeenCalled();
});
it.each(['load','inference'])('settles failure during %s without leaving a pending promise',async phase=>{
  const loading=createLocalModelThread('local:bge-small-en-v1.5'),worker=state.workers[0];
  if(phase==='load'){worker.emit('error',Error('missing'));expect(await loading).toBeNull();}
  else{worker.emit('message',{ready:true});const p=await loading;if(!p)throw Error('missing');
    const pending=p.document('source');worker.emit('error',Error('native failure'));expect(await pending).toBeNull();await p.close();}
  expect(state.terminate).toHaveBeenCalledOnce();
});
it.each([{value:[1]},{value:Array(384).fill(0)},{value:Array(384).fill(NaN)}])('fails closed on an invalid vector',async({value})=>{
  const {worker,provider}=await loaded(),pending=provider.query('question');
  worker.emit('message',{id:1,value});expect(await pending).toBeNull();await provider.close();
  expect(state.terminate).toHaveBeenCalledOnce();
});
it('does not accept a reply for another operation or a late reply after close',async()=>{
  const {worker,provider}=await loaded(),pending=provider.document('source');
  const closing=provider.close();worker.emit('message',{id:1,value:Array(384).fill(1)});
  expect(await pending).toBeNull();worker.emit('exit',0);await closing;
  const next=await loaded(),result=next.provider.query('query');
  next.worker.emit('message',{id:2,value:Array(384).fill(1)});expect(await result).toBeNull();await next.provider.close();
});
