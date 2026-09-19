import { acquireLease, terminateInference } from './lease.js';
import { createLocalModelThread } from './local-model-thread.js';
import { object } from './validation.js';
import { LIMITS } from './types.js';

// Install ownership checks before the first asynchronous initialization. Native
// calls run in a thread so IPC disconnect and lease heartbeat stay responsive.
process.once('disconnect',terminateInference);
if(!process.connected||!process.send)terminateInference();
const stage=process.argv[2],model=process.argv[3];
if((stage!=='embedding'&&stage!=='rerank')||typeof model!=='string')terminateInference();
async function send(message:object):Promise<void> {
  await new Promise<void>((resolve,reject)=>{
    if(!process.send){reject(Error('Missing owning process'));return;}
    process.send(message,error=>error?reject(error):resolve());
  });
}
const lease=await acquireLease(terminateInference,2);
if(!lease){await send({error:'worker_busy'});process.exit(0);}
const provider=await createLocalModelThread(model,stage);
if(!provider)process.exit(1);
let working=false,closing=false;
async function close():Promise<void> {
  if(closing)return;
  closing=true;
  await provider?.close();
  // Deliberately retain the native lease: process death releases both native
  // allocation and the database socket. Never unlock while this PID can work.
  process.exit(0);
}
process.on('message',(raw:unknown)=>{
  void (async()=>{
    const message=object(raw,['operation','id','text','documents']);
    if(message.operation==='close'&&Object.keys(message).length===1){await close();return;}
    if(closing||working)throw Error('Concurrent model operation');
    if(!Number.isSafeInteger(message.id)||typeof message.text!=='string'||Buffer.byteLength(JSON.stringify(message))>64*1024)throw Error('Invalid model request');
    working=true;
    const text=message.text;
    let value:number[]|null=null;
    if(stage==='embedding'){
      if(message.operation!=='cue'&&text.length>(message.operation==='query'?LIMITS.queryChars:LIMITS.documentChars))throw Error('Embedding input exceeds bound');
      switch(message.operation){
        case 'document':value=await provider.document(text);break;
        case 'query':value=await provider.query(text);break;
        case 'cue':value=await provider.cue?.(text)??null;break;
        default:throw Error('Invalid embedding operation');
      }
    }else{
      const documents:unknown=message.documents;
      if(message.operation!=='rerank'||text.length>LIMITS.queryChars||!Array.isArray(documents)||documents.length!==1||!documents.every((v:unknown)=>typeof v==='string'&&v.length<=LIMITS.documentChars))throw Error('Invalid reranker inputs');
      value=await provider.rerank?.(text,documents)??null;
    }
    if(!closing)await send({id:message.id,value});
    working=false;
  })().catch(terminateInference);
});
await send({ready:true});
