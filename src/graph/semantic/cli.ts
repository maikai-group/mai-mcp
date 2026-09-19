import type { ParsedArgs } from '../../cli-util.js';
import { scopedSearch, workerRequest, updateCodePolicy, type WorkerScope } from './service.js';
import { decodeJob, decodeStatus } from './codec.js';
import { numericFlag } from './http.js';
import { text, integer, SemanticError, uuid } from './validation.js';
export function strictFlags(args:ParsedArgs,allowed:readonly string[]):void {
  for(const key of Object.keys(args.flags))if(!allowed.includes(key))throw new SemanticError(`Unknown flag: ${key}`);
  const names=(args.argv??[]).filter(arg=>arg.startsWith('--')).map(arg=>arg.slice(2).split('=')[0]);
  if(new Set(names).size!==names.length)throw new SemanticError('Duplicate flags are not allowed');
}
export function cliScope(args:ParsedArgs):WorkerScope {
  return args.flags.project===undefined?{pin:true}:{slug:text(args.flags.project,100)};
}
export async function semanticCli(args:ParsedArgs):Promise<string> {
  const [group,action,...positionals]=args.positional;
  if(group!=='semantic')throw new SemanticError('Expected semantic subcommand');
  const scope=cliScope(args);
  const finish=(result:unknown)=>JSON.stringify(result,null,2);
  switch(action){
    case 'setup-local':{
      strictFlags(args,[]);if(positionals.length)throw new SemanticError('Setup takes no operands');
      const {setupCodeModels}=await import('./setup.js');
      return finish(await setupCodeModels());
    }
    case 'search':{
      strictFlags(args,['project','kind','limit']);
      if(positionals.length!==1)throw new SemanticError('Provide one quoted search query');
      return finish(await scopedSearch(scope,{query:positionals[0],kind:args.flags.kind,limit:numericFlag(args.flags.limit)}));
    }
    case 'status':{
      strictFlags(args,['project']);if(positionals.length)throw new SemanticError('Status takes no operands');
      return finish(decodeStatus(await workerRequest(scope,'status',{})));
    }
    case 'cancel':{
      strictFlags(args,['project','job']);if(positionals.length)throw new SemanticError('Cancel takes no positional operands');
      return finish(decodeJob(await workerRequest(scope,'cancel',{job_id:uuid(args.flags.job)},5000)));
    }
    case 'provider':{
      strictFlags(args,['project','revision','acknowledge-code-upload']);
      if(positionals.length!==1)throw new SemanticError('Provide one provider');
      const input={provider:positionals[0],expectedRevision:integer(numericFlag(args.flags.revision),0,2147483646),
        ...(args.flags['acknowledge-code-upload']===undefined?{}:{acknowledgeCodeUpload:args.flags['acknowledge-code-upload']})};
      return finish(await updateCodePolicy(scope,input));
    }
    case 'index':{
      strictFlags(args,['project']);if(positionals.length)throw new SemanticError('Index takes no operands');
      let job=decodeJob(await workerRequest(scope,'index',{},5000));
      let cancelled:Promise<unknown>|null=null;
      const interrupt=()=>{cancelled=workerRequest(scope,'cancel',{job_id:job.id},5000);void cancelled.catch(()=>{});};
      process.once('SIGINT',interrupt);
      try{
        process.stdout.write(finish(job)+'\n');
        while(job.state==='running'&&!cancelled){
          await new Promise(resolve=>setTimeout(resolve,1000));
          const status=decodeStatus(await workerRequest(scope,'status',{},5000));
          if(!status.job||status.job.id!==job.id)throw new SemanticError('Index job changed; inspect status',409);
          job=status.job;process.stdout.write(finish(job)+'\n');
        }
        if(cancelled)job=decodeJob(await cancelled);
        process.exitCode=job.state==='completed'?0:job.state==='failed'?1:2;
        return finish(job);
      }finally{process.removeListener('SIGINT',interrupt);}
    }
    default:throw new SemanticError('Expected semantic search, status, index, cancel, provider or setup-local');
  }
}
