import { useEffect,useRef,useState } from 'react';
import { apiGet,apiPost,getProject } from '../../lib/api';
import { useProjects } from '../../shell/project';
import type { NodeLessons as Advice,LessonAdvice,AttachedLesson } from './lesson-types';
const button='rounded-md border border-[var(--graph-border)] px-2 py-1 text-xs disabled:opacity-40';
export function NodeLessons({nodeId}:{nodeId:string}){
  const {project}=useProjects();return <LessonsBody key={project+':'+nodeId} project={project} nodeId={nodeId}/>;
}
function LessonsBody({project,nodeId}:{project:string;nodeId:string}){
  const [data,setData]=useState<Advice|null>(null),[error,setError]=useState(''),[offset,setOffset]=useState(0),[refresh,setRefresh]=useState(0);
  const [picker,setPicker]=useState(false),[query,setQuery]=useState(''),[choices,setChoices]=useState<LessonAdvice[]>([]);
  const [selected,setSelected]=useState<{lesson:LessonAdvice;action:'attach'|'detach'}|null>(null),[reason,setReason]=useState(''),[busy,setBusy]=useState(false);
  const [detail,setDetail]=useState<LessonAdvice|null>(null),[loadingDetail,setLoadingDetail]=useState(false);
  const life=useRef(0),read=useRef(0),pick=useRef(0),detailRead=useRef(0),submitting=useRef(false);
  useEffect(()=>{const generation=++life.current;return()=>{if(life.current===generation)life.current++;};},[]);
  const current=(generation:number)=>life.current===generation&&getProject()===project;
  useEffect(()=>{
    const generation=life.current,request=++read.current;setData(null);setError('');
    apiGet<Advice>('/graph/lessons',{node_id:nodeId,limit:10,offset}).then(value=>{if(current(generation)&&read.current===request)setData(value);})
      .catch(e=>{if(current(generation)&&read.current===request)setError(e instanceof Error?e.message:'Advice unavailable');});
    return()=>{read.current++;};
  },[project,nodeId,offset,refresh]);
  useEffect(()=>{
    const generation=life.current,request=++pick.current;setChoices([]);
    if(!picker||!query.trim())return;
    const timer=setTimeout(()=>{apiGet<{lessons:LessonAdvice[]}>('/graph/lessons/picker',{q:query,limit:10})
      .then(value=>{if(current(generation)&&pick.current===request)setChoices(value.lessons);})
      .catch(e=>{if(current(generation)&&pick.current===request)setError(e instanceof Error?e.message:'Picker unavailable');});},200);
    return()=>{clearTimeout(timer);pick.current++;};
  },[project,nodeId,picker,query]);
  async function showDetail(id:string){
    const generation=life.current,request=++detailRead.current;setLoadingDetail(true);setError('');
    try{const value=await apiGet<{lesson:LessonAdvice}>('/graph/lessons/detail',{lesson_id:id});if(current(generation)&&detailRead.current===request)setDetail(value.lesson);}
    catch(e){if(current(generation)&&detailRead.current===request)setError(e instanceof Error?e.message:'Lesson unavailable');}
    finally{if(current(generation)&&detailRead.current===request)setLoadingDetail(false);}
  }
  async function submit(){
    if(!selected||!reason.trim()||submitting.current||getProject()!==project)return;
    const generation=life.current;submitting.current=true;setBusy(true);setError('');
    try{await apiPost('/graph/lessons/link',{action:selected.action,node_id:nodeId,lesson_id:selected.lesson.id,reason:reason.trim()});
      if(current(generation)){setSelected(null);setReason('');setPicker(false);setOffset(0);setRefresh(n=>n+1);}}
    catch(e){if(current(generation))setError(e instanceof Error?e.message:'Action failed');}
    finally{if(current(generation)){submitting.current=false;setBusy(false);}}
  }
  function row(lesson:LessonAdvice,attached?:AttachedLesson){return <article key={lesson.id} className="my-3 space-y-1 rounded border border-[var(--graph-border)] p-2">
    <p className="whitespace-pre-wrap text-sm">{lesson.rule}</p><p>{lesson.why}</p><p>{lesson.how_to_apply}</p>
    <p className="text-[var(--graph-text-dim)]">Confidence: {lesson.confidence_label} ({lesson.confidence}) · {lesson.scope}</p>
    {attached&&<p>Attachment note: {attached.note}</p>}
    <div className="flex gap-2"><button type="button" className={button} disabled={busy} onClick={()=>{setSelected({lesson,action:attached?'detach':'attach'});setReason('');}}>{attached?'Remove':'Attach'}</button>
    <button type="button" className={button} disabled={loadingDetail} onClick={()=>void showDetail(lesson.id)}>View lesson</button></div>
  </article>;}
  return <section aria-label="Node lessons" className="space-y-3 text-xs">
    {error&&<p role="alert">{error.includes('404')||error.includes('node')?'This graph node changed. Select it again from the graph.':error}</p>}
    {loadingDetail&&<p role="status">Loading original lesson…</p>}
    {detail?<><button type="button" className={button} onClick={()=>{detailRead.current++;setDetail(null);}}>Back</button><h3>Original lesson</h3>{detail.context&&<p className="whitespace-pre-wrap">{detail.context}</p>}<p className="whitespace-pre-wrap">{detail.rule}</p><p className="whitespace-pre-wrap">{detail.why}</p><p className="whitespace-pre-wrap">{detail.how_to_apply}</p><p>Confidence: {detail.confidence_label} ({detail.confidence}) · {detail.scope}</p>{detail.source_session_id&&<p>Source session: {detail.source_session_id}</p>}</>:<>
      {!data&&!error&&<p role="status">Loading advice…</p>}
      {data&&<><h3>Attached</h3>{data.attached.length?data.attached.map(lesson=>row(lesson,lesson)):<p>No attached lessons on this page.</p>}
        <div className="flex gap-2"><button type="button" className={button} disabled={offset===0||busy} onClick={()=>setOffset(n=>Math.max(0,n-10))}>Previous</button>
          <button type="button" className={button} disabled={offset+10>=data.attached_total||busy} onClick={()=>setOffset(n=>n+10)}>Next</button></div>
      </>}
      <button type="button" className={button} disabled={busy} onClick={()=>setPicker(value=>!value)}>Add lesson</button>
      {picker&&<div><label>Find an eligible lesson<input aria-label="Find an eligible lesson" maxLength={300} value={query} onChange={e=>setQuery(e.target.value)} className="w-full border border-[var(--graph-border)] bg-transparent p-2"/></label>{choices.map(lesson=>row(lesson))}</div>}
      {selected&&<form onSubmit={e=>{e.preventDefault();void submit();}}><p>{selected.action==='attach'?'Attach':'Remove'}: {selected.lesson.rule}</p>
        <label>Reason<textarea aria-label="Reason" required maxLength={1000} value={reason} onChange={e=>setReason(e.target.value)} className="w-full border border-[var(--graph-border)] bg-transparent p-2"/></label>
        <button type="submit" className={button} disabled={busy||!reason.trim()}>Confirm {selected.action==='attach'?'attachment':'removal'}</button>
        <button type="button" className={button} disabled={busy} onClick={()=>setSelected(null)}>Cancel</button></form>}
    </>}
  </section>;
}
