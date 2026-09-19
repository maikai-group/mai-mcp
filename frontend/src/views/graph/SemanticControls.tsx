import { useEffect, useRef, useState } from 'react';
import { apiGet, apiPost, getProject } from '../../lib/api';
import type { CodeProvider, SemanticStatus } from './semantic-types';
const button='rounded-md border border-[var(--graph-border)] px-2 py-1 text-xs disabled:opacity-40';
function providerName(value:string):CodeProvider {
  if(value==='off'||value==='local'||value==='openai'||value==='voyage')return value;
  return 'local';
}
export function SemanticControls({project}:{project:string}) {
  const [status,setStatus]=useState<SemanticStatus|null>(null),[provider,setProvider]=useState<CodeProvider>('local');
  const [ack,setAck]=useState(false),[error,setError]=useState(''),[busy,setBusy]=useState(false),[revision,setRevision]=useState(0);
  const generation=useRef(0),submitting=useRef(false);
  useEffect(()=>{
    const current=++generation.current;let timer:ReturnType<typeof setTimeout>|undefined;let first=true;
    const active=()=>generation.current===current&&getProject()===project;
    async function refresh(){
      try{
        const result=await apiGet<SemanticStatus>('/graph/semantic/status');
        if(!active())return;
        setStatus(result);if(first)setProvider(result.policy.provider);first=false;
        if(result.job?.state==='running')timer=setTimeout(refresh,2000);
      }catch(e){if(active())setError(e instanceof Error?e.message:'Status unavailable');}
    }
    if(getProject()===project)void refresh();
    return()=>{generation.current++;clearTimeout(timer);};
  },[project,revision]);
  async function mutate(route:string,body:Record<string,unknown>){
    if(submitting.current||getProject()!==project)return;
    const current=generation.current;submitting.current=true;setBusy(true);setError('');
    try{
      await apiPost(route,body);
      if(generation.current===current&&getProject()===project){setAck(false);setRevision(r=>r+1);}
    }catch(e){if(generation.current===current&&getProject()===project)setError(e instanceof Error?e.message:'Action failed');}
    finally{if(generation.current===current){submitting.current=false;setBusy(false);}}
  }
  const cloud=provider==='openai'||provider==='voyage';
  return <section aria-label="Semantic search settings" className="space-y-2 border-t border-[var(--graph-border)] px-4 py-3 text-xs">
    <label>Embedding provider <select aria-label="Embedding provider" value={provider} disabled={!status||busy}
      onChange={e=>{setProvider(providerName(e.target.value));setAck(false);}} className={button}>
      <option value="off">Off</option><option value="local">Local</option><option value="openai">OpenAI</option><option value="voyage">Voyage</option>
    </select></label>
    {cloud?<label className="block"><input type="checkbox" checked={ack} onChange={e=>setAck(e.target.checked)}/>{' '}
      Use this provider for this project's semantic code search and lesson suggestions? Bounded source excerpts, search text and eligible lesson text will be sent to the provider. Provider charges may apply. API keys remain on your machine.
    </label>:provider==='local'?<p>Runs on this machine using a downloaded model. Indexing uses one CPU thread and can be cancelled and resumed.</p>:<p>Meaning search uses labelled text fallback while embeddings are off.</p>}
    <div className="flex gap-2">
      <button type="button" className={button} disabled={!status||busy||(cloud&&!ack)} onClick={()=>status&&void mutate('/graph/semantic/policy',{
        provider,expectedRevision:status.policy.revision,...(cloud?{acknowledgeCodeUpload:true}:{}),
      })}>Save provider</button>
      <button type="button" className={button} disabled={!status||busy||status.policy.provider==='off'||status.job?.state==='running'}
        onClick={()=>void mutate('/graph/semantic/index',{})}>Build / Resume index</button>
      <button type="button" className={button} disabled={busy||status?.job?.state!=='running'}
        onClick={()=>status?.job&&void mutate('/graph/semantic/cancel',{job_id:status.job.id})}>Cancel indexing</button>
    </div>
    <p role="status">{!status?'Loading index status…':status.job?`${status.job.state}: ${status.job.scanned} scanned, ${status.job.written} written, ${status.job.reused} reused, ${status.job.skipped} skipped`:'Index has not been built.'}</p>
    {status&&<p>{status.coverage.complete?'Verified coverage':'Coverage checked so far'}: declarations {status.coverage.declaration.current}/{status.coverage.declaration.eligible}; metadata {status.coverage.metadata.current}/{status.coverage.metadata.eligible}{status.coverage.capped?' (corpus limit)':''}.</p>}
    <p>Set up local models with <code>mai graph semantic setup-local</code>, then build the index. Searches never download weights.</p>
    {error&&<p role="alert">{error}</p>}
  </section>;
}
