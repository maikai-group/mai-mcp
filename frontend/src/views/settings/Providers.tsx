import {useEffect,useRef,useState} from 'react';
import {ApiError,getProject} from '../../lib/api';
import {ViewHeader} from '../../components/ViewHeader';
import {useProjects} from '../../shell/project';
import {useToast} from '../../shell/toast';
import {SemanticControls} from '../graph/SemanticControls';
import {getProviderStatus,saveCredential,removeCredential,testCredential,saveRouting,saveJevPolicy} from './provider-api';
import type {ApiProvider,ProviderStatus,Credential,CheckResult,SummaryRoute,BrainRoute} from './provider-api';
const names:Record<ApiProvider,string>={typesafe:'TypeSafe',anthropic:'Anthropic',openai:'OpenAI',voyage:'Voyage'};
const variables:Record<ApiProvider,string>={typesafe:'TYPESAFE_API_KEY',anthropic:'ANTHROPIC_API_KEY',openai:'OPENAI_API_KEY',voyage:'VOYAGE_API_KEY'};
const button='rounded-md border border-deep-700 px-3 py-2 text-sm hover:border-flow-400 disabled:opacity-40';
const input='rounded-md border border-deep-700 bg-deep-900 px-3 py-2 text-sm';
const panel='space-y-3 rounded-lg border border-deep-700 bg-deep-900/50 p-5';
type Mutation=(signal:AbortSignal)=>Promise<ProviderStatus>;
interface Actions {busy:boolean;mutate:(operation:Mutation,message:string)=>Promise<void>;test:(provider:ApiProvider,allowUsage:boolean)=>Promise<CheckResult|null>}
export function Providers(){const {project}=useProjects();return <ProviderPanel key={project} project={project}/>;}
function ProviderPanel({project}:{project:string}){
  const toast=useToast();const [status,setStatus]=useState<ProviderStatus|null>(null),[error,setError]=useState(''),[busy,setBusy]=useState(false);
  const generation=useRef(0),controller=useRef<AbortController|null>(null),submitting=useRef(false),mounted=useRef(true);
  function begin(){controller.current?.abort();const next=new AbortController();controller.current=next;return {signal:next.signal,id:++generation.current};}
  function active(id:number){return mounted.current&&generation.current===id&&getProject()===project;}
  function accept(next:ProviderStatus){setStatus(previous=>({...next,...(!next.native&&previous?.native?{native:previous.native}:{})}));setError('');}
  async function refresh(native=false){
    if(submitting.current)return;const operation=begin();
    try{const next=await getProviderStatus(native,operation.signal);if(active(operation.id))accept(next);}
    catch(e){if(active(operation.id)&&!operation.signal.aborted){setStatus(null);setError(e instanceof ApiError&&(e.status===401||e.message==='local_setup_required')?'locked':e instanceof ApiError&&e.status===403?'local':'unavailable');}}
  }
  useEffect(()=>{mounted.current=true;void refresh();return()=>{mounted.current=false;generation.current++;controller.current?.abort();};},[project]);
  async function mutate(operation:Mutation,message:string){
    if(submitting.current)return;submitting.current=true;setBusy(true);const request=begin();
    try{const next=await operation(request.signal);if(active(request.id)){accept(next);toast.push('success',message);}}
    catch(e){if(active(request.id)&&!request.signal.aborted){
      if(e instanceof ApiError&&e.status===409){toast.push('error','Configuration changed. Review the refreshed settings and retry; re-enter any key.');try{const next=await getProviderStatus(false,request.signal);if(active(request.id))accept(next);}catch{if(active(request.id))setError('unavailable');}}
      else toast.push('error','Change failed. Re-enter the key if needed and try again.');
    }}finally{if(active(request.id)){submitting.current=false;setBusy(false);}}
  }
  async function test(provider:ApiProvider,allowUsage:boolean){
    if(!status||submitting.current)return null;const credential=status.credentials.find(c=>c.provider===provider);if(!credential)return null;
    const request=begin();
    try{const result=await testCredential(provider,allowUsage,status.revision,request.signal);
      if(!active(request.id))return null;
      const matches=credential.source==='saved'?result.credentialRevision===credential.revision:credential.source==='environment'&&result.credentialRevision===null;
      return matches?result:null;
    }catch(e){if(active(request.id)&&!request.signal.aborted){toast.push('error','Connection test unavailable. Refresh and try again.');if(e instanceof ApiError&&e.status===409)void refresh();}return null;}
  }
  const actions={busy,mutate,test};
  return <div className="mx-auto max-w-5xl space-y-6 px-8 py-8">
    <ViewHeader title="Providers & Connections" subtitle={`Credentials are shared across this installation. Current project: ${project||'none selected'}.`}>
      <button className={button} onClick={()=>void refresh()} disabled={busy}>Refresh connections</button>
    </ViewHeader>
    {error==='locked'?<section className={panel} role="alert"><h2>Local setup required</h2><p>Set MAI_BRAIN_WEB_TOKEN for the dashboard, use its existing token URL mechanism (?token=…), then reopen the built same-origin dashboard. A token is required even on localhost.</p></section>
      :error==='local'?<p role="alert">Version 1 manages connections only through the local dashboard on a loopback address.</p>
      :error?<p role="alert">Connection settings are unavailable. Refresh to retry; no provider validity can be inferred.</p>:!status?<p role="status">Loading connections…</p>:<>
      {status.storage==='unavailable'&&<p role="alert">Saved storage is unavailable. Environment credentials remain managed outside this page.</p>}
      <div className="grid gap-4 md:grid-cols-2">{status.credentials.map(credential=><CredentialCard key={credential.provider} credential={credential} revision={status.revision} disabled={status.storage==='unavailable'} {...actions}/>)}</div>
      <section className={panel}><h2 className="text-lg font-semibold">Feature configuration</h2><p>Saving a key does not enable any feature.</p>
        <FeatureForms key={JSON.stringify([status.revision,status.routing,status.jev])} status={status} {...actions}/>
        <h3 className="font-semibold">Project code embeddings</h3>
        {project?<SemanticControls key={project} project={project}/>:<p>Select a project to configure code embeddings.</p>}
      </section>
      <section className={panel}><h2 className="text-lg font-semibold">Native CLI sessions</h2><p>Claude Code and Codex use their own subscription sessions. Anthropic and OpenAI API keys are separate credentials.</p>
        <div><h3>Claude Code</h3><p>{status.native?.claude==='installed_auth_unverified'?'Installed; authentication unverified':status.native?.claude==='unavailable'?'Unavailable':'Not checked'}</p><p>Set up in your terminal: <code>claude</code></p></div>
        <div><h3>Codex</h3><p>{status.native?.codex==='authenticated'?'Authenticated':status.native?.codex==='unauthenticated'?'Unauthenticated':status.native?.codex==='unavailable'?'Unavailable':'Not checked'}</p><p>Set up in your terminal: <code>codex login</code></p></div>
        <button className={button} disabled={busy} onClick={()=>void refresh(true)}>Refresh native CLI status</button>
      </section>
    </>}
  </div>;
}
function CredentialCard({credential,revision,disabled,busy,mutate,test}:Actions&{credential:Credential;revision:number;disabled:boolean}){
  const {provider}=credential;const [key,setKey]=useState(''),[confirm,setConfirm]=useState(false),[ack,setAck]=useState(false),[testing,setTesting]=useState(false),[result,setResult]=useState<CheckResult|null>(null);
  const live=useRef(true);const checkGeneration=useRef(0);
  useEffect(()=>{setKey('');setConfirm(false);setResult(null);checkGeneration.current++;},[revision,credential]);
  useEffect(()=>{live.current=true;return()=>{live.current=false;checkGeneration.current++;};},[]);
  const managed=credential.source==='environment',paid=provider==='typesafe'||provider==='voyage';
  const shown=result??credential.check;
  async function save(){checkGeneration.current++;setResult(null);try{await mutate(signal=>saveCredential(provider,key,revision,signal),`${names[provider]} credential saved. Features are unchanged.`);}finally{if(live.current)setKey('');}}
  async function check(){if(paid&&!ack)return;const current=++checkGeneration.current;setTesting(true);try{const next=await test(provider,ack);if(live.current&&current===checkGeneration.current)setResult(next);}finally{if(live.current)setTesting(false);}}
  return <section className={panel} aria-label={`${names[provider]} connection`}>
    <h2 className="text-lg font-semibold">{names[provider]}</h2>
    <p>{credential.configured?'Configured':'Missing'} · Source: {credential.source} · Saved credential: {credential.saved?'present':'absent'}</p>
    <p>Last test: {shown?`${shown.state} · ${shown.checkedAt}`:'unchecked'}</p>
    {!paid&&<p>Tests check authentication only; they do not confirm inference capability.</p>}
    {managed?<p>Managed by <code>{variables[provider]}</code>. Change the environment to replace this credential.</p>:null}
    <label className="block">{names[provider]} API key<input className={`${input} mt-1 block w-full`} type="password" aria-label={`${names[provider]} API key`} autoComplete="new-password" spellCheck={false} readOnly={managed} disabled={busy||disabled} value={key} onChange={e=>setKey(e.target.value)}/></label>
    <div className="flex flex-wrap gap-2"><button className={button} disabled={busy||disabled||managed||!key.trim()} onClick={()=>void save()}>{credential.saved?'Replace':'Save'} {names[provider]} key</button>
      <button className={button} disabled={busy} onClick={()=>{setKey('');setConfirm(false);}}>Cancel {names[provider]}</button>
      {credential.saved&&<button className={button} disabled={busy||disabled} onClick={()=>{setKey('');setConfirm(true);}}>{managed?'Remove overridden saved':'Remove saved'} {names[provider]} key</button>}</div>
    {confirm&&<div><p>Remove the saved {names[provider]} credential? Features using it may become unavailable.{managed?' The environment credential will remain effective.':''}</p><button className={button} disabled={busy} onClick={()=>void mutate(signal=>removeCredential(provider,revision,signal),`${names[provider]} saved credential removed.`)}>Confirm remove {names[provider]}</button></div>}
    {paid&&<label className="block"><input type="checkbox" checked={ack} onChange={e=>setAck(e.target.checked)}/> Makes a small API request and may incur usage ({names[provider]})</label>}
    <button className={button} disabled={busy||testing||disabled||!credential.configured||(paid&&!ack)} onClick={()=>void check()}>Test {names[provider]} connection</button>
  </section>;
}
function FeatureForms({status,busy,mutate}:Pick<Actions,'busy'|'mutate'>&{status:ProviderStatus}){
  const [summary,setSummary]=useState<SummaryRoute>((status.routing.managed.summary.length?status.routing.activeSummary:status.routing.savedSummary)??status.routing.activeSummary??{enabled:false,provider:'anthropic',model:null,fallback:null});
  const [brain,setBrain]=useState<BrainRoute>((status.routing.managed.brain.length?status.routing.activeBrain:status.routing.savedBrain)??status.routing.activeBrain??{enabled:false,provider:'local'});
  const [jev,setJev]=useState(status.jev?.policy??{enabled:false,model:'jev-1.13.0'});
  const disabled=busy||status.storage==='unavailable';
  function summaryProvider(v:string){if(v==='anthropic'||v==='openai'||v==='claude-code'||v==='codex-cli')setSummary({...summary,provider:v});}
  function brainProvider(v:string){if(v==='off')setBrain({...brain,enabled:false});else if(v==='local'||v==='openai'||v==='voyage')setBrain({enabled:true,provider:v});}
  return <div className="space-y-5">
    <p>Summary and brain routing changes require restarting all affected MCP and ingest processes. This page observes only the web process.{status.routing.restartRequired?' The web process is using an earlier routing snapshot.':''}</p>
    <fieldset disabled={disabled||status.routing.managed.summary.length>0} className="space-y-2"><legend>Summaries</legend>
      {status.routing.managed.summary.length>0&&<p>Managed by {status.routing.managed.summary.join(', ')}</p>}
      <label className="block"><input type="checkbox" checked={summary.enabled} onChange={e=>setSummary({...summary,enabled:e.target.checked})}/> Enable summaries</label>
      <label>Summary provider <select className={input} value={summary.provider} onChange={e=>summaryProvider(e.target.value)}><option value="anthropic">Anthropic</option><option value="openai">OpenAI</option><option value="claude-code">Claude Code</option><option value="codex-cli">Codex</option></select></label>
      <label className="block">Summary model <input className={input} value={summary.model??''} placeholder="Provider default" onChange={e=>setSummary({...summary,model:e.target.value||null})}/></label>
      <label className="block">Subscription fallback <select className={input} value={summary.fallback??''} onChange={e=>{const v=e.target.value;setSummary({...summary,fallback:v==='claude-code'||v==='codex-cli'?v:null});}}><option value="">None</option><option value="claude-code">Claude Code</option><option value="codex-cli">Codex</option></select></label>
      <button className={button} onClick={()=>void mutate(signal=>saveRouting('summary',summary,status.revision,signal),'Summary routing saved. Restart affected MCP and ingest processes.')}>Save summary routing</button>
    </fieldset>
    <fieldset disabled={disabled||status.routing.managed.brain.length>0} className="space-y-2"><legend>Brain embeddings</legend>
      {status.routing.managed.brain.length>0&&<p>Managed by {status.routing.managed.brain.join(', ')}</p>}
      <label>Brain embedding provider <select className={input} value={brain.enabled?brain.provider:'off'} onChange={e=>brainProvider(e.target.value)}><option value="off">Off</option><option value="local">Local</option><option value="openai">OpenAI</option><option value="voyage">Voyage</option></select></label>
      <button className={button} onClick={()=>void mutate(signal=>saveRouting('brain',brain,status.revision,signal),'Brain routing saved. Restart affected MCP and ingest processes.')}>Save brain routing</button>
    </fieldset>
    {status.jev?<fieldset disabled={disabled||status.jev.managed.length>0} className="space-y-2"><legend>Project Jev policy</legend>
      <p>Enabling permits selected questions, code, graph, memory and context to be sent externally. Navigation is optional and depends on the separate Jev implementation. Policy changes apply to subsequent calls.</p>
      {status.jev.managed.length>0&&<p>Managed by {status.jev.managed.join(', ')}</p>}
      <label className="block"><input type="checkbox" checked={jev.enabled} onChange={e=>setJev({...jev,enabled:e.target.checked})}/> Enable Jev for this project</label>
      <label className="block">Jev model <input className={input} value={jev.model} onChange={e=>setJev({...jev,model:e.target.value})}/></label>
      <button className={button} disabled={!jev.model.trim()} onClick={()=>{const policy=status.jev;if(policy)void mutate(signal=>saveJevPolicy(policy.projectId,jev.enabled,jev.model,status.revision,signal),'Project Jev policy saved.');}}>Save Jev policy</button>
    </fieldset>:<p>Select a project to configure Jev.</p>}
  </div>;
}
