import { beforeEach, expect, it, vi } from 'vitest';
import type { CodeEmbedder } from '../graph/semantic/provider.js';
const state=vi.hoisted(()=>({create:vi.fn()}));
vi.mock('../graph/semantic/model-process.js',()=>({createModelProcess:state.create}));
import { createLocalModelProcess } from '../graph/semantic/local-model-process.js';
const model='local:bge-small-en-v1.5';
function child(score=1):CodeEmbedder{return {model,dimensions:384,document:vi.fn(async()=>Array(384).fill(1)),
  query:vi.fn(async()=>Array(384).fill(2)),cue:vi.fn(async()=>Array(384).fill(3)),rerank:vi.fn(async()=>[score]),close:vi.fn(async()=>{})};}
beforeEach(()=>{state.create.mockReset();});
it('reuses BGE for indexing and fully reaps each model before the next pair starts',async()=>{
  const embedding=child(),first=child(2),second=child(-1);let finished=false;
  state.create.mockResolvedValueOnce(embedding).mockImplementationOnce(async()=>{expect(finished).toBe(true);return first;})
    .mockImplementationOnce(async()=>{expect(first.close).toHaveBeenCalledOnce();return second;});
  const p=await createLocalModelProcess(model);if(!p)throw Error('Missing provider');
  await p.document('a');await p.document('b');await p.cue?.('c');expect(state.create).toHaveBeenCalledTimes(1);
  let reap:()=>void=()=>{};embedding.close=vi.fn(()=>new Promise<void>(resolve=>{reap=()=>{finished=true;resolve();};}));
  const pending=p.rerank?.('q',['one','two']);await Promise.resolve();expect(state.create).toHaveBeenCalledTimes(1);
  reap();expect(await pending).toEqual([2,-1]);expect(second.close).toHaveBeenCalledOnce();
  expect(state.create.mock.calls).toEqual([[model,'embedding'],[model,'rerank'],[model,'rerank']]);
  expect(await p.document('after rerank')).toBeNull();await p.close();await p.close();
});
it('waits for a starting child when close races initialization and skips its inference',async()=>{
  const embedding=child(),reranker=child();let loaded:(p:CodeEmbedder)=>void=()=>{};
  state.create.mockResolvedValueOnce(embedding).mockImplementationOnce(()=>new Promise<CodeEmbedder>(resolve=>{loaded=resolve;}));
  const p=await createLocalModelProcess(model);if(!p)throw Error('Missing provider');
  const pending=p.rerank?.('q',['one']);await vi.waitFor(()=>expect(state.create).toHaveBeenCalledTimes(2));
  let closed=false;const closing=p.close().then(()=>{closed=true;});await Promise.resolve();expect(closed).toBe(false);
  loaded(reranker);expect(await pending).toBeNull();await closing;expect(reranker.rerank).not.toHaveBeenCalled();expect(reranker.close).toHaveBeenCalledOnce();
});
it('reaps failed pairs, stops the remaining batch, and preserves native lease busy errors',async()=>{
  const embedding=child(),reranker=child();reranker.rerank=vi.fn(async()=>null);
  state.create.mockResolvedValueOnce(embedding).mockResolvedValueOnce(reranker);
  const p=await createLocalModelProcess(model);expect(await p?.rerank?.('q',['one','two'])).toBeNull();
  expect(reranker.close).toHaveBeenCalledOnce();expect(state.create).toHaveBeenCalledTimes(2);await p?.close();
  state.create.mockRejectedValueOnce(Error('worker_busy'));await expect(createLocalModelProcess(model)).rejects.toThrow('worker_busy');
});
