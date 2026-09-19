import { EventEmitter } from 'node:events';
import { beforeEach, expect, it, vi } from 'vitest';
const state=vi.hoisted(()=>({children:new Array<EventEmitter>(),send:vi.fn(),kill:vi.fn()}));
vi.mock('node:child_process',()=>({fork:()=>{
  const child=Object.assign(new EventEmitter(),{send:(message:unknown,done:(error:null)=>void)=>{state.send(message);done(null);},
    kill:()=>{state.kill();return true;},stderr:{resume:()=>{}}});state.children.push(child);return child;
}}));
import { createModelProcess } from '../graph/semantic/model-process.js';
beforeEach(()=>{state.children.length=0;state.send.mockReset();state.kill.mockReset();});
async function loaded(stage:'embedding'|'rerank'='embedding'){
  const loading=createModelProcess('local:bge-small-en-v1.5',stage),child=state.children[0];child.emit('message',{ready:true});
  const provider=await loading;if(!provider)throw Error('Missing provider');return {child,provider};
}
it('rejects concurrent calls and waits for actual process close, not exit, before disposing',async()=>{
  const {child,provider}=await loaded(),pending=provider.document('source');
  expect(await provider.query('concurrent')).toBeNull();
  child.emit('message',{id:1,value:Array(384).fill(1)});expect(await pending).toHaveLength(384);
  let done=false;const closing=provider.close().then(()=>{done=true;});
  child.emit('exit',0);await Promise.resolve();expect(done).toBe(false);
  child.emit('close',0);await closing;expect(done).toBe(true);await provider.close();
  expect(await provider.query('closed')).toBeNull();expect(state.kill).not.toHaveBeenCalled();
});
it.each([{ready:false},{ready:true,extra:1},{id:1,value:[1]}])('reaps failed initialization before resolving it',async message=>{
  let done=false;const pending=createModelProcess('local:bge-small-en-v1.5','embedding').then(value=>{done=true;return value;});
  const child=state.children[0];child.emit('message',message);await Promise.resolve();expect(done).toBe(false);expect(state.kill).toHaveBeenCalledOnce();
  child.emit('close',1);expect(await pending).toBeNull();
});
it('preserves worker_busy while waiting for the refused child to close',async()=>{
  const pending=createModelProcess('local:bge-small-en-v1.5','embedding');
  const rejection=expect(pending).rejects.toThrow('worker_busy'),child=state.children[0];
  child.emit('message',{error:'worker_busy'});child.emit('close',0);await rejection;
});
it.each([{id:99,value:Array(384).fill(1)},{id:1,value:Array(384).fill(0)},{id:1,value:[Infinity]},{id:1,value:[1],extra:0}])('fails closed on invalid replies',async message=>{
  const {child,provider}=await loaded(),pending=provider.query('query');child.emit('message',message);
  expect(await pending).toBeNull();expect(state.kill).toHaveBeenCalledOnce();child.emit('close',1);await provider.close();
});
it('settles disconnect and process errors at startup or during a request',async()=>{
  const pending=createModelProcess('local:bge-small-en-v1.5','embedding'),child=state.children[0];
  child.emit('error',Error('spawn failed'));child.emit('close',1);expect(await pending).toBeNull();
  state.children.length=0;
  const next=await loaded(),result=next.provider.document('source');next.child.emit('disconnect');
  expect(await result).toBeNull();next.child.emit('close',1);await next.provider.close();
});
it('restricts each reranker process to a single bounded pair',async()=>{
  const {child,provider}=await loaded('rerank');
  expect(await provider.query('query')).toBeNull();expect(await provider.rerank?.('q',['a','b'])).toBeNull();
  const pending=provider.rerank?.('q',['a']);child.emit('message',{id:1,value:[0.25]});expect(await pending).toEqual([0.25]);
  const closing=provider.close();child.emit('close',0);await closing;
});
