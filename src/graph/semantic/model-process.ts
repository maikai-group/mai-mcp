import { fork } from 'node:child_process';
import type { CodeEmbedder } from './provider.js';
import { object, SemanticError } from './validation.js';
import { vectorIsValid } from './ranking.js';
import { LIMITS } from './types.js';

export type ModelStage = 'embedding' | 'rerank';

// The caller owns the request lease. The child holds a second lease until
// process exit, including native disposal and its final IPC flush.
export async function createModelProcess(model: string, stage: ModelStage): Promise<CodeEmbedder|null> {
  const child=fork(new URL('./model-process-worker.js',import.meta.url),[stage,model],{
    stdio:['ignore','ignore','pipe','ipc'],execArgv:[],
  });
  // Drain diagnostics without retaining unbounded native-runtime output.
  child.stderr?.resume();
  let disposed=false,initialized=false,sequence=0,busy=false;
  let pending:{id:number;count:number|null;resolve:(value:number[]|null)=>void}|undefined;
  let readyResolve:(value:CodeEmbedder|null)=>void=()=>{};
  const ready=new Promise<CodeEmbedder|null>(resolve=>{readyResolve=resolve;});
  let exitResolve:()=>void=()=>{};
  const exited=new Promise<void>(resolve=>{exitResolve=resolve;});
  function fail():void {
    disposed=true;readyResolve(null);pending?.resolve(null);pending=undefined;
    child.kill('SIGKILL');
  }
  function send(value:object):void {
    try{child.send(value,error=>{if(error)fail();});}catch{fail();}
  }
  function request(operation:'document'|'query'|'cue'|'rerank',text:string,documents?:readonly string[]):Promise<number[]|null> {
    if(disposed||pending)return Promise.resolve(null);
    if(operation!=='cue'&&text.length>(operation==='query'||operation==='rerank'?LIMITS.queryChars:LIMITS.documentChars))return Promise.resolve(null);
    if(stage==='rerank'?(operation!=='rerank'||documents?.length!==1):operation==='rerank')return Promise.resolve(null);
    const message={id:sequence+1,operation,text,...(documents?{documents}:{})};
    if(Buffer.byteLength(JSON.stringify(message))>64*1024)return Promise.resolve(null);
    return new Promise(resolve=>{
      pending={id:++sequence,count:documents?.length??null,resolve};send(message);
    });
  }
  const provider:CodeEmbedder={model,dimensions:384,
    document:text=>request('document',text),query:text=>request('query',text),cue:text=>request('cue',text),
    rerank:(query,documents)=>request('rerank',query,documents),
    close:()=>{
      if(!disposed){disposed=true;pending?.resolve(null);pending=undefined;send({operation:'close'});}
      return exited;
    },
  };
  child.on('message',(raw:unknown)=>{
    if(disposed)return;
    try{
      const message=object(raw,['ready','id','value','error']);
      if(!initialized&&message.error==='worker_busy'&&Object.keys(message).length===1){busy=true;fail();return;}
      if(!initialized&&message.ready===true&&Object.keys(message).length===1){initialized=true;readyResolve(provider);return;}
      if(!initialized||!pending||message.id!==pending.id||Object.keys(message).length!==2)throw Error('Invalid model process reply');
      const value:unknown=message.value;
      if(value!==null&&!(pending.count===null?vectorIsValid(value,384):Array.isArray(value)&&value.length===pending.count&&value.every(v=>typeof v==='number'&&Number.isFinite(v))))throw Error('Invalid model process result');
      const resolve=pending.resolve;pending=undefined;resolve(Array.isArray(value)?value:null);
    }catch{fail();}
  });
  child.once('error',fail);
  child.once('disconnect',()=>{if(!disposed)fail();});
  child.once('close',()=>{disposed=true;readyResolve(null);pending?.resolve(null);pending=undefined;exitResolve();});
  const result=await ready;
  if(!result)await exited;
  if(busy)throw new SemanticError('worker_busy',409);
  return result;
}
