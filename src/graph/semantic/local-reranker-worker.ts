import { parentPort } from 'node:worker_threads';
import { createCodeReranker } from './reranker.js';
import { object } from './validation.js';
import { LIMITS } from './types.js';

const port=parentPort;
if(!port)throw Error('Reranker requires an owned worker thread');
const reranker=await createCodeReranker();
let working=false,closing=false;
async function close():Promise<void>{if(closing)return;closing=true;try{await reranker.close();}finally{port?.close();}}
port.on('message',(raw:unknown)=>{
  void (async()=>{
    const message=object(raw,['operation','id','text','documents']);
    if(message.operation==='close'&&Object.keys(message).length===1){await close();return;}
    const documents:unknown=message.documents;
    if(working||closing||message.operation!=='rerank'||!Number.isSafeInteger(message.id)||typeof message.text!=='string'||message.text.length>LIMITS.queryChars||!Array.isArray(documents)||documents.length!==1||!documents.every((v:unknown)=>typeof v==='string'&&v.length<=LIMITS.documentChars))throw Error('Invalid reranker request');
    working=true;
    const value=await reranker.score(message.text,documents);
    if(!closing)port.postMessage({id:message.id,value});
    working=false;
  })().catch(async()=>{await close();});
});
port.postMessage({ready:true});
