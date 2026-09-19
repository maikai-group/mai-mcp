import { beforeEach,afterEach,it,expect,vi } from 'vitest';
import { act,cleanup,fireEvent,render,screen } from '@testing-library/react';
import { NodeLessons } from './NodeLessons';
import type { NodeLessons as Advice,LessonAdvice } from './lesson-types';
const fake=vi.hoisted(()=>({project:'alpha',get:vi.fn(),post:vi.fn()}));
vi.mock('../../lib/api',()=>({apiGet:fake.get,apiPost:fake.post,getProject:()=>fake.project}));
vi.mock('../../shell/project',()=>({useProjects:()=>({project:fake.project})}));
const lesson:LessonAdvice={id:'lesson-one',context:'Original context',rule:'Preserve transactional state',why:'A failed write must roll back',how_to_apply:'Use one transaction',confidence:.5,confidence_label:'emerging',scope:'project',source_session_id:null};
const data:Advice={node_id:'node-a',identity:'stable',attached:[{...lesson,attachment_id:'attachment',attached_at:'2026-09-08',note:'applies here'}],attached_total:1,offset:0};
beforeEach(()=>{fake.project='alpha';fake.get.mockReset().mockImplementation(async path=>path.endsWith('/detail')?{lesson:{...lesson,why:'complete original rationale'}}:path.endsWith('/picker')?{lessons:[lesson]}:data);fake.post.mockReset().mockResolvedValue({changed:true});});
afterEach(()=>{cleanup();vi.useRealTimers();});
async function show(){await act(async()=>{render(<NodeLessons nodeId="node-a"/>);});}
it('shows attached advice and learned confidence without suggestions',async()=>{
  await show();expect(screen.getByText('Attached')).toBeDefined();expect(screen.queryByText('Suggested')).toBeNull();
  expect(screen.getAllByText('Confidence: emerging (0.5) · project')).toHaveLength(1);expect(screen.queryByText('95%')).toBeNull();
});
it('requires a reason and submits an exact removal once',async()=>{
  await show();fireEvent.click(screen.getByRole('button',{name:'Remove'}));fireEvent.click(screen.getByRole('button',{name:'Confirm removal'}));expect(fake.post).not.toHaveBeenCalled();
  fireEvent.change(screen.getByRole('textbox',{name:'Reason'}),{target:{value:'No longer applies'}});
  await act(async()=>{fireEvent.submit(screen.getByRole('textbox',{name:'Reason'}).closest('form')??document.body);});
  expect(fake.post).toHaveBeenCalledExactlyOnceWith('/graph/lessons/link',{action:'detach',node_id:'node-a',lesson_id:'lesson-one',reason:'No longer applies'});
});
it('opens full original detail and returns to advice',async()=>{
  await show();await act(async()=>fireEvent.click(screen.getAllByRole('button',{name:'View lesson'})[0]));expect(screen.getByText('complete original rationale')).toBeDefined();
  fireEvent.click(screen.getByRole('button',{name:'Back'}));expect(screen.getByText('Attached')).toBeDefined();
});
it('keeps attached advice and reports mutation failure',async()=>{
  fake.get.mockResolvedValue(data);fake.post.mockRejectedValue(new Error('Write failed'));
  await show();expect(screen.getByText('Preserve transactional state')).toBeDefined();fireEvent.click(screen.getByRole('button',{name:'Remove'}));fireEvent.change(screen.getByRole('textbox'),{target:{value:'Reason'}});
  await act(async()=>fireEvent.click(screen.getByRole('button',{name:'Confirm removal'})));expect(screen.getByRole('alert').textContent).toBe('Write failed');
});
it('discards pending advice across node and project replacement',async()=>{
  let done:(value:Advice)=>void=()=>{throw Error('not started');};fake.get.mockReturnValue(new Promise<Advice>(resolve=>{done=resolve;}));
  const view=render(<NodeLessons nodeId="node-a"/>);fake.project='beta';fake.get.mockResolvedValue({...data,node_id:'node-b',attached:[],attached_total:0});
  await act(async()=>view.rerender(<NodeLessons nodeId="node-b"/>));await act(async()=>done(data));expect(screen.queryByText('Preserve transactional state')).toBeNull();expect(fake.post).not.toHaveBeenCalled();
});

it('attaches a searched lesson and prevents duplicate submissions while pending',async()=>{
  vi.useFakeTimers();await show();fireEvent.click(screen.getByRole('button',{name:'Add lesson'}));
  fireEvent.change(screen.getByRole('textbox',{name:'Find an eligible lesson'}),{target:{value:'transaction'}});
  await act(()=>vi.advanceTimersByTimeAsync(200));
  fireEvent.click(screen.getByRole('button',{name:'Attach'}));
  expect(screen.getByRole('button',{name:'Confirm attachment'}).hasAttribute('disabled')).toBe(true);
  fireEvent.change(screen.getByRole('textbox',{name:'Reason'}),{target:{value:'Applies to this function'}});
  let done:()=>void=()=>{throw Error('not started');};fake.post.mockReturnValue(new Promise<void>(resolve=>{done=resolve;}));
  const form=screen.getByRole('textbox',{name:'Reason'}).closest('form');if(!form)throw Error('missing form');
  await act(async()=>{fireEvent.submit(form);fireEvent.submit(form);});
  expect(fake.post).toHaveBeenCalledExactlyOnceWith('/graph/lessons/link',{action:'attach',node_id:'node-a',lesson_id:'lesson-one',reason:'Applies to this function'});
  await act(async()=>done());expect(screen.queryByRole('textbox',{name:'Reason'})).toBeNull();
});
it('rejects an action after the selected project changes before rerender',async()=>{
  await show();fireEvent.click(screen.getByRole('button',{name:'Remove'}));fireEvent.change(screen.getByRole('textbox',{name:'Reason'}),{target:{value:'Old project'}});
  fake.project='beta';await act(async()=>fireEvent.click(screen.getByRole('button',{name:'Confirm removal'})));expect(fake.post).not.toHaveBeenCalled();
});
it('pages attached lessons and exposes loading, empty and failed reads',async()=>{
  fake.get.mockImplementation(async(_path,params)=>params.offset===10?{...data,attached:[],attached_total:11,offset:10}:{...data,attached_total:11});
  await show();await act(async()=>fireEvent.click(screen.getByRole('button',{name:'Next'})));
  expect(fake.get).toHaveBeenLastCalledWith('/graph/lessons',{node_id:'node-a',limit:10,offset:10});expect(screen.getByText('No attached lessons on this page.')).toBeDefined();
  fake.get.mockRejectedValue(new Error('Read failed'));await act(async()=>fireEvent.click(screen.getByRole('button',{name:'Previous'})));expect(screen.getByRole('alert').textContent).toBe('Read failed');
});
it.each(['detail','picker','mutation'])('discards stale %s results on project replacement',async kind=>{
  vi.useFakeTimers();let view:ReturnType<typeof render>|undefined;
  await act(async()=>{view=render(<NodeLessons nodeId="node-a"/>);});
  let finish:()=>void=()=>{throw Error('not started');};
  if(kind==='mutation'){
    fake.post.mockReturnValue(new Promise<void>(resolve=>{finish=resolve;}));
    fireEvent.click(screen.getByRole('button',{name:'Remove'}));fireEvent.change(screen.getByRole('textbox',{name:'Reason'}),{target:{value:'Old action'}});
    await act(async()=>fireEvent.click(screen.getByRole('button',{name:'Confirm removal'})));
  }else if(kind==='detail'){
    fake.get.mockReturnValue(new Promise<{lesson:LessonAdvice}>(resolve=>{finish=()=>resolve({lesson:{...lesson,rule:'Stale original'}});}));
    fireEvent.click(screen.getByRole('button',{name:'View lesson'}));
  }else{
    fake.get.mockReturnValue(new Promise<{lessons:LessonAdvice[]}>(resolve=>{finish=()=>resolve({lessons:[{...lesson,rule:'Stale picker'}]});}));
    fireEvent.click(screen.getByRole('button',{name:'Add lesson'}));fireEvent.change(screen.getByRole('textbox',{name:'Find an eligible lesson'}),{target:{value:'query'}});
    await act(()=>vi.advanceTimersByTimeAsync(200));
  }
  fake.project='beta';fake.get.mockResolvedValue({...data,node_id:'node-b',attached:[],attached_total:0});
  await act(async()=>view?.rerender(<NodeLessons nodeId="node-b"/>));const reads=fake.get.mock.calls.length;
  await act(async()=>finish());expect(fake.get).toHaveBeenCalledTimes(reads);expect(screen.queryByText('Stale original')).toBeNull();expect(screen.queryByText('Stale picker')).toBeNull();expect(screen.getByText('No attached lessons on this page.')).toBeDefined();
});
