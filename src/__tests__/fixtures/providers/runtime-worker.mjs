import readline from 'node:readline';
import {ProviderStore} from '../../../../build/providers/store.js';
import {createProviderRuntime} from '../../../../build/providers/runtime.js';
let store,runtime,master;
for await(const line of readline.createInterface({input:process.stdin,crlfDelay:Infinity})){
  if(Buffer.byteLength(line)>4096)process.exit(2);
  try{
    const message=JSON.parse(line);
    if(message.op==='init'){
      store=new ProviderStore(message.root);master=Buffer.from(message.master,'base64');
      runtime=createProviderRuntime({env:()=>({}),store,readMaster:async()=>Buffer.from(master)});
      process.stdout.write('{}\n');
    }else if(message.op==='save'){
      store.replaceCredential('openai',store.readState().revision,message.key,master);
      store.setBrain(store.readState().revision,{enabled:true,provider:message.provider});
      process.stdout.write('{}\n');
    }else if(message.op==='read')process.stdout.write(JSON.stringify({key:await runtime.resolveCredential('openai'),route:runtime.routingSnapshot().brain})+'\n');
    else process.exit(2);
  }catch{process.stdout.write('{"error":"worker_failed"}\n');}
}
master?.fill(0);
