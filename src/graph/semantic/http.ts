import { scopedSearch, workerRequest, updateCodePolicy } from './service.js';
import { decodeJob, decodeStatus } from './codec.js';
import { object, text, SemanticError, uuid } from './validation.js';
export function checkedQuery(url:URL,keys:readonly string[]):Record<string,string> {
  const out:Record<string,string>={};
  for(const [key,value] of url.searchParams){
    if(!keys.includes(key)||key in out)throw new SemanticError(`Invalid query parameter: ${key}`);
    out[key]=value;
  }
  text(out.project,100);return out;
}
export function numericFlag(value:unknown):number|undefined {
  if(value===undefined)return undefined;
  if(typeof value!=='string'||!/^\d+$/.test(value))throw new SemanticError('Expected an integer operand');
  return Number(value);
}
type GetHandler=(url:URL)=>Promise<Record<string,unknown>>;
type PostHandler=(body:Record<string,unknown>,url:URL)=>Promise<Record<string,unknown>>;
export function createSemanticGetHandlers():Record<string,GetHandler> {
  return {
    '/api/graph/semantic/search':async url=>{
      const q=checkedQuery(url,['project','q','kind','limit']);
      return {...await scopedSearch({slug:q.project},{query:q.q,kind:q.kind,limit:numericFlag(q.limit)})};
    },
    '/api/graph/semantic/status':async url=>{
      const q=checkedQuery(url,['project']);
      return {...decodeStatus(await workerRequest({slug:q.project},'status',{}))};
    },
  };
}
export function createSemanticPostHandlers():Record<string,PostHandler> {
  return {
    '/api/graph/semantic/policy':async(body,url)=>{
      const q=checkedQuery(url,['project']);return {policy:await updateCodePolicy({slug:q.project},body)};
    },
    '/api/graph/semantic/index':async(body,url)=>{
      const q=checkedQuery(url,['project']);object(body,[]);
      return {job:decodeJob(await workerRequest({slug:q.project},'index',{},5000))};
    },
    '/api/graph/semantic/cancel':async(body,url)=>{
      const q=checkedQuery(url,['project']),r=object(body,['job_id']);
      return {job:decodeJob(await workerRequest({slug:q.project},'cancel',{job_id:uuid(r.job_id)},5000))};
    },
  };
}
