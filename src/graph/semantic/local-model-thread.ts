import { Worker } from 'node:worker_threads';
import type { CodeEmbedder } from './provider.js';
import { object } from './validation.js';
import { vectorIsValid } from './ranking.js';

// The owning process keeps the lease and hard timers. Killing that process
// also stops native calls that cannot be interrupted by Worker.terminate().
export async function createLocalModelThread(model: string, stage: 'embedding' | 'rerank' = 'embedding'): Promise<CodeEmbedder|null> {
  const worker=new Worker(new URL(stage==='embedding'?'./local-model-worker.js':'./local-reranker-worker.js',import.meta.url),{workerData:{model}});
  let disposed=false,initialized=false,sequence=0;
  let pending:{id:number;count:number|null;resolve:(value:number[]|null)=>void}|undefined;
  let readyResolve:(provider:CodeEmbedder|null)=>void=()=>{};
  const ready=new Promise<CodeEmbedder|null>(resolve=>{readyResolve=resolve;});
  let exitResolve:()=>void=()=>{};
  const exited=new Promise<void>(resolve=>{exitResolve=resolve;});
  function fail():void {
    disposed=true;readyResolve(null);pending?.resolve(null);pending=undefined;
    void worker.terminate();
  }
  function request(operation:'document'|'query'|'cue'|'rerank',text:string,documents?:readonly string[]):Promise<number[]|null> {
    if(disposed||pending)return Promise.resolve(null);
    return new Promise(resolve=>{
      const id=++sequence;pending={id,count:documents?.length??null,resolve};
      try{worker.postMessage({id,operation,text,...(documents?{documents}: {})});}catch{fail();}
    });
  }
  const provider:CodeEmbedder={model,dimensions:384,
    document:text=>request('document',text),query:text=>request('query',text),cue:text=>request('cue',text),
    rerank:(query,documents)=>request('rerank',query,documents),
    close:()=>{
      if(!disposed){
        disposed=true;pending?.resolve(null);pending=undefined;
        try{worker.postMessage({operation:'close'});}catch{fail();}
      }
      // Disposal must include actual thread exit before releasing the lease.
      return exited;
    },
  };
  worker.on('message',(raw:unknown)=>{
    if(disposed)return;
    try{
      const message=object(raw,['ready','id','value']);
      if(message.ready===true&&!initialized&&Object.keys(message).length===1){initialized=true;readyResolve(provider);return;}
      if(!pending||message.id!==pending.id||Object.keys(message).length!==2)throw Error('Invalid model reply');
      const value:unknown=message.value;
      if(value!==null&&!(pending.count===null?vectorIsValid(value,384):
        Array.isArray(value)&&value.length===pending.count&&value.every(v=>typeof v==='number'&&Number.isFinite(v))))throw Error('Invalid model result');
      const resolve=pending.resolve;pending=undefined;
      resolve(Array.isArray(value)?value:null);
    }catch{fail();}
  });
  worker.once('error',fail);
  worker.once('exit',()=>{disposed=true;readyResolve(null);pending?.resolve(null);pending=undefined;exitResolve();});
  const result=await ready;
  if(!result)await exited;
  return result;
}
