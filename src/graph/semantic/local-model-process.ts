import type { CodeEmbedder } from './provider.js';
import { createModelProcess } from './model-process.js';
import { LIMITS } from './types.js';

export async function createLocalModelProcess(model:string):Promise<CodeEmbedder|null> {
  let embedding=await createModelProcess(model,'embedding');
  if(!embedding)return null;
  let disposed=false,working=false;
  let active:CodeEmbedder|null=embedding;
  let closing:Promise<void>|undefined;
  let operation:Promise<number[]|null>|undefined;
  function run(body:()=>Promise<number[]|null>):Promise<number[]|null> {
    if(disposed||working)return Promise.resolve(null);
    working=true;
    return operation=body().finally(()=>{working=false;});
  }
  return {model,dimensions:384,
    document:text=>run(()=>embedding?.document(text)??Promise.resolve(null)),
    query:text=>run(()=>embedding?.query(text)??Promise.resolve(null)),
    cue:text=>run(()=>embedding?.cue?.(text)??Promise.resolve(null)),
    rerank:(query,documents)=>run(async()=>{
      if(query.length>LIMITS.queryChars||documents.length>8||documents.some(text=>text.length>LIMITS.documentChars))return null;
      if(embedding){await embedding.close();embedding=null;active=null;}
      const scores:number[]=[];
      for(const text of documents){
        if(disposed)return null;
        const child=await createModelProcess(model,'rerank');
        active=child;
        if(!child)return null;
        try{
          if(disposed)return null;
          const value=await child.rerank?.(query,[text]);
          if(!value||value.length!==1)return null;
          scores.push(value[0]);
        }finally{await child.close();active=null;}
      }
      return disposed?null:scores;
    }),
    close:()=>{
      disposed=true;
      return closing??=(async()=>{
        await active?.close();
        // A child may still be starting. The operation observes disposed and
        // reaps that child before the owning request can release its lease.
        await operation?.catch(()=>{});
        await active?.close();embedding=null;active=null;
      })();
    },
  };
}
