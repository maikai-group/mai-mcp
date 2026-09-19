import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { Spotlight } from './Spotlight';
import type { CodeSearch, SemanticStatus } from './semantic-types';
const fake=vi.hoisted(()=>({project:'alpha',get:vi.fn(),post:vi.fn()}));
vi.mock('../../lib/api',()=>({apiGet:fake.get,apiPost:fake.post,getProject:()=>fake.project}));
vi.mock('../../shell/project',()=>({useProjects:()=>({project:fake.project})}));
const coverage={eligible:1,current:1,skipped:0,capped:false,declaration:{eligible:1,current:1},metadata:{eligible:0,current:0},complete:true};
const status:SemanticStatus={policy:{provider:'local',revision:0,consentVersion:null},model:'local:bge-small-en-v1.5',coverage,job:null};
const node={id:'11111111-1111-4111-8111-111111111111',name:'save',kind:'function',qualified_name:'a.ts#save',file_path:'/a.ts',line:1,score:1};
const semantic:CodeSearch={state:'ready',reasons:[],model:'local:bge-small-en-v1.5',coverage,nodes:[{...node,identity:'a'.repeat(64),method:'semantic',document_mode:'declaration',excerpt:'saves a record',
  freshness:{state:'verified',source_hash:'b'.repeat(64),document_fingerprint:'c'.repeat(64),document_version:'code-symbol/1',indexed_at:'2026-09-08T12:00:00Z',verified_at:'2026-09-08T12:00:01Z'}}]};
function deferred<T>(){let resolve:(value:T)=>void=()=>{throw new Error('not initialized');};const promise=new Promise<T>(done=>{resolve=done;});return {promise,resolve};}
beforeEach(()=>{vi.useFakeTimers();fake.project='alpha';fake.get.mockReset();fake.post.mockReset();fake.get.mockImplementation(async path=>path.endsWith('/status')?status:path.endsWith('/semantic/search')?semantic:{nodes:[node]});});
afterEach(()=>{cleanup();vi.useRealTimers();});
function open(){fireEvent.click(screen.getByRole('button',{name:/search the graph/}));}
async function query(value:string){fireEvent.change(screen.getByRole('textbox',{name:'Graph query'}),{target:{value}});await act(()=>vi.advanceTimersByTimeAsync(250));}
it('keeps Name mode and selects only a completed current result with Enter',async()=>{
  const pick=vi.fn();render(<Spotlight onPick={pick}/>);open();await query('save');
  fireEvent.change(screen.getByRole('textbox'),{target:{value:'other'}});fireEvent.keyDown(screen.getByRole('textbox'),{key:'Enter'});expect(pick).not.toHaveBeenCalled();
  await act(()=>vi.advanceTimersByTimeAsync(250));fireEvent.keyDown(screen.getByRole('textbox'),{key:'Enter'});expect(pick).toHaveBeenCalledWith(node.id);
  expect(screen.queryByRole('dialog')).toBeNull();
});
it('renders meaning, source and coverage labels and picks the current UUID',async()=>{
  const pick=vi.fn();render(<Spotlight onPick={pick}/>);open();fireEvent.click(screen.getByRole('button',{name:'Meaning'}));await query('persist a record');fireEvent.keyDown(screen.getByRole('textbox'),{key:'Enter'});await act(()=>vi.advanceTimersByTimeAsync(1));
  expect(screen.getByText(/semantic · declaration · verified/)).toBeDefined();expect(screen.getByText('/a.ts:1')).toBeDefined();
  fireEvent.click(screen.getByRole('button',{name:/function save/}));expect(pick).toHaveBeenCalledWith(node.id);
});
it('discards old query, mode and closed-dialog responses',async()=>{
  const old=deferred<{nodes:typeof node[]}>();fake.get.mockImplementation(path=>path.endsWith('/status')?Promise.resolve(status):old.promise);
  render(<Spotlight onPick={()=>{}}/>);open();await query('old');fireEvent.click(screen.getByRole('button',{name:'Meaning'}));
  fireEvent.keyDown(window,{key:'Escape'});await act(async()=>old.resolve({nodes:[node]}));open();expect(screen.queryByRole('button',{name:/function save/})).toBeNull();
});
it('project replacement invalidates pending responses and selection',async()=>{
  const pending=deferred<{nodes:typeof node[]}>();fake.get.mockReturnValue(pending.promise);
  const pick=vi.fn(),view=render(<Spotlight onPick={pick}/>);open();await query('old');
  fake.project='beta';view.rerender(<Spotlight onPick={pick}/>);await act(async()=>pending.resolve({nodes:[node]}));
  open();expect(screen.queryByRole('button',{name:/function save/})).toBeNull();expect(pick).not.toHaveBeenCalled();
});
it('reports failures instead of displaying an empty success',async()=>{
  fake.get.mockRejectedValue(new Error('database unavailable'));render(<Spotlight onPick={()=>{}}/>);open();await query('save');expect(screen.getByRole('alert').textContent).toContain('database unavailable');
});


it('waits for explicit Meaning submission while Name remains live',async()=>{
  render(<Spotlight onPick={()=>{}}/>);open();fireEvent.click(screen.getByRole('button',{name:'Meaning'}));
  await query('persist');await query('persist a record');
  expect(fake.get.mock.calls.filter(([path])=>path.endsWith('/semantic/search'))).toHaveLength(0);
  fireEvent.click(screen.getByRole('button',{name:'Search by meaning'}));await act(()=>vi.advanceTimersByTimeAsync(1));
  expect(screen.getByRole('button',{name:/function save/})).toBeDefined();
  expect(fake.get.mock.calls.filter(([path])=>path.endsWith('/semantic/search'))).toHaveLength(1);
});
it('owns one pending Meaning request and lets the edited query be submitted after it ends',async()=>{
  const old=deferred<CodeSearch>();
  fake.get.mockImplementation((path:string)=>path.endsWith('/status')?Promise.resolve(status):old.promise);
  render(<Spotlight onPick={()=>{}}/>);open();fireEvent.click(screen.getByRole('button',{name:'Meaning'}));await query('persist');
  fireEvent.keyDown(screen.getByRole('textbox'),{key:'Enter'});await act(()=>vi.advanceTimersByTimeAsync(1));
  await query('persist a record');fireEvent.keyDown(screen.getByRole('textbox'),{key:'Enter'});
  expect(screen.getByRole('button',{name:'Searching…'}).hasAttribute('disabled')).toBe(true);
  expect(fake.get.mock.calls.filter(([path])=>path.endsWith('/semantic/search'))).toHaveLength(1);
  await act(async()=>old.resolve(semantic));expect(screen.queryByRole('button',{name:/function save/})).toBeNull();
  fake.get.mockImplementation(async (path:string)=>path.endsWith('/status')?status:semantic);
  fireEvent.keyDown(screen.getByRole('textbox'),{key:'Enter'});await act(()=>vi.advanceTimersByTimeAsync(1));
  expect(fake.get).toHaveBeenLastCalledWith('/graph/semantic/search',{q:'persist a record',kind:undefined,limit:15});
  expect(screen.getByRole('button',{name:/function save/})).toBeDefined();
});
it('can retry unchanged text after worker_busy and select a completed Meaning result with Enter',async()=>{
  const busy:CodeSearch={...semantic,state:'fallback',reasons:['worker_busy'],nodes:[]};let requests=0;
  fake.get.mockImplementation(async (path:string)=>path.endsWith('/status')?status:++requests===1?busy:semantic);
  const pick=vi.fn();render(<Spotlight onPick={pick}/>);open();fireEvent.click(screen.getByRole('button',{name:'Meaning'}));await query('persist a record');
  fireEvent.keyDown(screen.getByRole('textbox'),{key:'Enter'});await act(()=>vi.advanceTimersByTimeAsync(1));expect(screen.getByText(/worker_busy/)).toBeDefined();
  fireEvent.click(screen.getByRole('button',{name:'Search by meaning'}));await act(()=>vi.advanceTimersByTimeAsync(1));
  fireEvent.keyDown(screen.getByRole('textbox'),{key:'Enter'});expect(pick).toHaveBeenCalledWith(node.id);expect(requests).toBe(2);
});
