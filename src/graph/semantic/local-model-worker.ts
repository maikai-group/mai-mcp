import { parentPort, workerData } from 'node:worker_threads';
import { createLocalModel } from './local-model.js';
import { object } from './validation.js';
import { LIMITS } from './types.js';

const port=parentPort;
if(!port)throw Error('Local model requires an owned worker thread');
const data=object(workerData,['model']);
if(typeof data.model!=='string')throw Error('Invalid local model identity');
const provider=await createLocalModel(data.model);
if(!provider){port.close();}else{
  let queue=Promise.resolve(),closing=false;
  async function close():Promise<void>{closing=true;try{await provider?.close();}finally{port?.close();}}
  port.on('message',(raw:unknown)=>{
    queue=queue.then(async()=>{
      if(closing)return;
      const message=object(raw,['operation','id','text','documents']);
      if(message.operation==='close'&&Object.keys(message).length===1){await close();return;}
      if(!Number.isSafeInteger(message.id)||typeof message.text!=='string'||Buffer.byteLength(JSON.stringify(message))>64*1024)throw Error('Invalid model request');
      const text=message.text;
      let value:number[]|null=null;
      switch(message.operation){
        case 'document':if(text.length>LIMITS.documentChars)throw Error('Document exceeds bound');value=await provider.document(text);break;
        case 'query':if(text.length>LIMITS.queryChars)throw Error('Query exceeds bound');value=await provider.query(text);break;
        case 'cue':value=await provider.cue?.(text)??null;break;
        case 'rerank':{
          const documents:unknown=message.documents;
          if(text.length>LIMITS.queryChars||!Array.isArray(documents)||documents.length>8||!documents.every((v:unknown)=>typeof v==='string'&&v.length<=LIMITS.documentChars))throw Error('Invalid reranker inputs');
          value=await provider.rerank?.(text,documents)??null;break;
        }
        default:throw Error('Unknown model operation');
      }
      port.postMessage({id:message.id,value});
    }).catch(async()=>{await close();});
  });
  port.postMessage({ready:true});
}
