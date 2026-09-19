import { getProjectId, resolveProjectId, closePool } from '../../db.js';
import { object, text, uuid, SemanticError } from './validation.js';
import { normalizeSearch } from './service.js';
import { changePolicy } from './policy.js';
import { lexicalSearch, searchRuntime, runIndex, statusRuntime } from './runtime.js';
import { reserveJob, cancelJob } from './store.js';

async function readRequest():Promise<unknown> {
  let body='',bytes=0;
  for await(const chunk of process.stdin){
    bytes+=Buffer.byteLength(chunk);
    if(bytes>8192)throw new SemanticError('Worker request exceeds bound');
    body+=chunk.toString();
  }
  return JSON.parse(body);
}
async function projectScope(raw:unknown):Promise<string> {
  const scope=object(raw,['pin','projectId','slug']);
  if(Object.keys(scope).length!==1)throw new SemanticError('Ambiguous worker scope');
  if(scope.pin===true)return getProjectId();
  if(scope.projectId!==undefined)return uuid(scope.projectId);
  try{return await resolveProjectId(text(scope.slug,100));}
  catch{throw new SemanticError('Project not found',404);}
}
function reply(body:unknown):Promise<void> {
  const payload=JSON.stringify({ok:true,body})+'\n';
  if(Buffer.byteLength(payload)>256*1024)throw new SemanticError('Worker result exceeds bound',503);
  return new Promise((resolve,reject)=>process.stdout.write(payload,error=>error?reject(error):resolve()));
}
async function main():Promise<void> {
  const request=object(await readRequest(),['scope','action','input']),projectId=await projectScope(request.scope);
  switch(request.action){
    case 'search':await reply(await searchRuntime(projectId,normalizeSearch(request.input),()=>{}));break;
    case 'lexical':await reply(await lexicalSearch(projectId,normalizeSearch(request.input)));break;
    case 'status':object(request.input,[]);await reply(await statusRuntime(projectId));break;
    case 'policy':await reply(await changePolicy(projectId,request.input));break;
    case 'cancel':{
      const input=object(request.input,['job_id']);await reply(await cancelJob(projectId,uuid(input.job_id)));break;
    }
    case 'index':{
      object(request.input,[]);const reservation=await reserveJob(projectId);await reply(reservation.job);
      if(reservation.owned)await runIndex(projectId,reservation.job.id);break;
    }
    default:throw new SemanticError('Unknown worker action');
  }
}
try{await main();}
catch(error){
  const known=error instanceof SemanticError;
  process.stdout.write(JSON.stringify({ok:false,error:known?error.message:'Semantic operation unavailable',status:known?error.status:503})+'\n');
  process.exitCode=1;
}finally{await closePool();}
