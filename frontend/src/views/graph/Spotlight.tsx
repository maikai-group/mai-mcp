import { useEffect, useRef, useState } from 'react';
import { apiGet, getProject } from '../../lib/api';
import { kindStyle } from '../../lib/kinds';
import { useProjects } from '../../shell/project';
import type { GraphFoundNode } from '../../lib/types';
import type { CodeSearch } from './semantic-types';
import { SemanticControls } from './SemanticControls';
const kinds=['function','file','table','class','endpoint'];
const button='rounded-full border border-[var(--graph-border)] px-2.5 py-1 text-xs aria-pressed:border-[var(--graph-accent)]';
export function Spotlight({onPick}:{onPick:(id:string)=>void}) {
  const {project}=useProjects();
  return <SpotlightBody key={project} project={project} onPick={onPick}/>;
}
function SpotlightBody({project,onPick}:{project:string;onPick:(id:string)=>void}) {
  const [open,setOpen]=useState(false),[query,setQuery]=useState(''),[kind,setKind]=useState(''),[mode,setMode]=useState<'lexical'|'semantic'>('lexical');
  const [result,setResult]=useState<{key:string;nodes:GraphFoundNode[];semantic:CodeSearch|null}|null>(null);
  const [error,setError]=useState(''),[loading,setLoading]=useState(false);
  const [meaningRequest,setMeaningRequest]=useState<{key:string;sequence:number}|null>(null);
  const [meaningBusy,setMeaningBusy]=useState(false);
  const meaningInFlight=useRef(false),requestSequence=useRef(0),dispatchedSequence=useRef(0);
  const input=useRef<HTMLInputElement>(null),generation=useRef(0);
  const key=JSON.stringify([project,open,mode,query,kind]);
  const liveKey=useRef(key);liveKey.current=key;
  useEffect(()=>{
    const onKey=(e:KeyboardEvent)=>{
      const typing=e.target instanceof HTMLElement&&(e.target.isContentEditable||['INPUT','TEXTAREA','SELECT'].includes(e.target.tagName));
      if(e.key==='/'&&!typing){e.preventDefault();setOpen(true);}
      if(e.key==='Escape')setOpen(false);
    };
    window.addEventListener('keydown',onKey);return()=>window.removeEventListener('keydown',onKey);
  },[]);
  useEffect(()=>{if(open)input.current?.focus();},[open]);
  useEffect(()=>{
    const current=++generation.current;setResult(null);setError('');setLoading(false);
    if(!open||!query.trim()||getProject()!==project)return;
    if(mode==='semantic'){
      if(!meaningRequest||meaningRequest.key!==key||meaningRequest.sequence===dispatchedSequence.current||meaningInFlight.current)return;
      dispatchedSequence.current=meaningRequest.sequence;
    }
    setLoading(true);
    const active=()=>generation.current===current&&liveKey.current===key&&getProject()===project;
    const timer=setTimeout(async()=>{
      try{
        if(mode==='semantic'){
          meaningInFlight.current=true;setMeaningBusy(true);
          const semantic=await apiGet<CodeSearch>('/graph/semantic/search',{q:query.trim(),kind:kind||undefined,limit:15});
          if(active())setResult({key,nodes:semantic.nodes,semantic});
        }else{
          const named=await apiGet<{nodes:GraphFoundNode[]}>('/graph/find',{q:query.trim(),kind:kind||undefined,limit:15});
          if(active())setResult({key,nodes:named.nodes,semantic:null});
        }
      }catch(e){if(active())setError(e instanceof Error?e.message:'Search unavailable');}
      finally{
        if(mode==='semantic'){meaningInFlight.current=false;setMeaningBusy(false);}
        if(active())setLoading(false);
      }
    },mode==='semantic'?0:200);
    return()=>{clearTimeout(timer);generation.current++;};
  },[key,project,open,mode,query,kind,meaningRequest]);
  const current=result?.key===key?result:null;
  function submitMeaning(){
    if(!query.trim()||meaningInFlight.current||getProject()!==project)return;
    setMeaningRequest({key,sequence:++requestSequence.current});
  }
  function pick(id:string){
    if(getProject()!==project||!current?.nodes.some(node=>node.id===id))return;
    onPick(id);setOpen(false);setQuery('');setResult(null);
  }
  return <>
    <button type="button" onClick={()=>setOpen(true)} className="absolute left-4 top-16 z-10 rounded-full border border-[var(--graph-border)] bg-[var(--graph-panel)] px-4 py-1.5 font-mono text-xs text-[var(--graph-accent)]">⌕ search the graph… /</button>
    {open&&<div className="fixed inset-0 z-30 flex items-start justify-center p-4 pt-[12vh] backdrop-blur-sm" onClick={()=>setOpen(false)}>
      <div role="dialog" aria-label="Search the graph" aria-modal="true" data-graph-spotlight="dialog" onClick={e=>e.stopPropagation()}
        className="max-h-[80vh] w-full max-w-xl overflow-y-auto rounded-xl border border-[var(--graph-border)] bg-[var(--graph-panel)] text-[var(--graph-text)] shadow-2xl">
        <div className="flex gap-2 px-4 pt-3"><button type="button" className={button} aria-pressed={mode==='lexical'} onClick={()=>setMode('lexical')}>Name</button>
          <button type="button" className={button} aria-pressed={mode==='semantic'} onClick={()=>setMode('semantic')}>Meaning</button>
          <button type="button" className={button} aria-label="Close search" onClick={()=>setOpen(false)}>×</button></div>
        <input ref={input} aria-label="Graph query" value={query} maxLength={1000} onChange={e=>setQuery(e.target.value)}
          onKeyDown={e=>{if(e.key==='Enter'){if(current?.nodes[0])pick(current.nodes[0].id);else if(mode==='semantic')submitMeaning();}}} placeholder={mode==='semantic'?'Describe what the code does…':'Search names…'}
          className="w-full bg-transparent px-4 py-3.5 text-sm outline-none"/>
        {mode==='semantic'&&<div className="px-4 pb-2"><button type="button" className={button} disabled={!query.trim()||meaningBusy} onClick={submitMeaning}>
          {meaningBusy?'Searching…':'Search by meaning'}</button><p className="pt-1 text-xs text-[var(--graph-text-dim)]">Write your query, then press Enter or search.</p></div>}
        <div className="flex flex-wrap gap-2 px-4 pb-2">{kinds.map(value=><button key={value} type="button" className={button}
          aria-pressed={kind===value} onClick={()=>setKind(old=>old===value?'':value)}>{value}</button>)}</div>
        <div aria-live="polite" className="px-4 py-2 text-xs">
          {loading||meaningBusy?'Searching…':current?.semantic?<>{current.semantic.state}: {current.semantic.reasons.join(', ')||'meaning matches'};
            {current.semantic.coverage.complete?' complete':' partial'} coverage — declarations {current.semantic.coverage.declaration.current}/{current.semantic.coverage.declaration.eligible},
            metadata {current.semantic.coverage.metadata.current}/{current.semantic.coverage.metadata.eligible}</>:current?current.nodes.length+' results':''}
        </div>
        {error&&<p role="alert" className="px-4 py-2">{error}</p>}
        {current&&!current.nodes.length&&<p className="px-4 py-2 text-sm">No matches in this search.</p>}
        <ul className="max-h-72 overflow-y-auto">{current?.nodes.map(node=>{
          const semantic=current.semantic?.nodes.find(hit=>hit.id===node.id);
          return <li key={node.id}><button type="button" onClick={()=>pick(node.id)} className="w-full px-4 py-2 text-left hover:bg-[var(--graph-border)]">
            <span style={{color:kindStyle(node.kind).color}}>{node.kind}</span>{' '}<strong>{node.name}</strong>
            <span className="block break-all text-xs text-[var(--graph-text-dim)]">{node.file_path}{node.line?':'+node.line:''}</span>
            {semantic&&<span className="block text-xs">{semantic.method} · {semantic.document_mode??'name match'} · {semantic.freshness.state}
              {semantic.freshness.indexed_at?' · indexed '+semantic.freshness.indexed_at:''}</span>}
            {semantic?.excerpt&&<span className="block truncate text-xs">{semantic.excerpt}</span>}
          </button></li>;
        })}</ul>
        {mode==='semantic'&&<SemanticControls key={project} project={project}/>}
      </div>
    </div>}
  </>;
}
