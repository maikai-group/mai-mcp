import {act,cleanup,fireEvent,render,screen,waitFor,within} from '@testing-library/react';
import {beforeEach,afterEach,expect,it,vi} from 'vitest';
import {Providers} from './Providers';
import {ToastProvider} from '../../shell/toast';
import {setProject} from '../../lib/api';
import type {ProviderStatus} from './provider-api';
const project=vi.hoisted(()=>({value:'one'}));
vi.mock('../../shell/project',()=>({useProjects:()=>({project:project.value})}));
let state:ProviderStatus;let requests:{url:string;body:Record<string,unknown>|null;signal:AbortSignal|null|undefined}[];
let handler:(url:string,body:Record<string,unknown>|null)=>Promise<Response>;
const success=(body:unknown)=>new Response(JSON.stringify({ok:true,...(typeof body==='object'&&body!==null?body:{})}));
const failure=(status:number,error:string)=>new Response(JSON.stringify({ok:false,error}),{status});
function fixture():ProviderStatus{return {revision:0,storage:'unconfigured',credentials:(['typesafe','anthropic','openai','voyage'] as const).map(provider=>({provider,saved:false,configured:false,revision:0,source:'missing',check:null})),routing:{savedSummary:null,savedBrain:null,activeSummary:null,activeBrain:null,restartRequired:false,managed:{summary:[],brain:[]}},jev:{projectId:'00000000-0000-4000-8000-000000000001',policy:{enabled:false,model:'jev-1.13.0'},managed:[]}};}
function renderView(){return render(<ToastProvider><Providers/></ToastProvider>);}
function card(name:string){return within(screen.getByRole('region',{name:`${name} connection`}));}
async function loaded(){await screen.findByLabelText('OpenAI API key');}
beforeEach(()=>{
  state=fixture();requests=[];project.value='one';setProject('one');localStorage.clear();
  handler=async(url,body)=>{
    if(url.includes('/graph/semantic/status'))return success({policy:{provider:'off',revision:5,consentVersion:null},model:null,job:null,coverage:{complete:false,capped:false,declaration:{current:0,eligible:0},metadata:{current:0,eligible:0}}});
    if(url.includes('/graph/semantic/policy'))return success({});
    if(body?.action==='set'||body?.action==='remove'){
      state={...state,revision:state.revision+1,credentials:state.credentials.map(c=>c.provider===body.provider?{...c,saved:body.action==='set',configured:body.action==='set',source:body.action==='set'?'saved':'missing',revision:c.revision+1}:c)};
    }
    return success(state);
  };
  vi.stubGlobal('fetch',vi.fn(async(input:RequestInfo|URL,init?:RequestInit)=>{
    const url=String(input);const body=typeof init?.body==='string'?JSON.parse(init.body):null;requests.push({url,body,signal:init?.signal});return handler(url,body);
  }));
});
afterEach(()=>{cleanup();vi.unstubAllGlobals();vi.restoreAllMocks();localStorage.clear();});
it('loads and saves through the real API envelope; clears secrets and never enables a feature',async()=>{
  renderView();await loaded();fireEvent.change(screen.getByLabelText('OpenAI API key'),{target:{value:'unique-secret'}});fireEvent.click(screen.getByRole('button',{name:'Save OpenAI key'}));
  await waitFor(()=>expect(screen.getByLabelText('OpenAI API key')).toHaveProperty('value',''));
  expect(requests.filter(r=>r.body?.key==='unique-secret')).toHaveLength(1);expect(requests.filter(r=>r.body)).toHaveLength(1);
  expect(document.body.textContent).not.toContain('unique-secret');expect(JSON.stringify(localStorage)).not.toContain('unique-secret');expect(requests.map(r=>r.url).join()).not.toContain('unique-secret');expect(state.routing.savedSummary).toBeNull();
  expect(screen.getByLabelText('Enable summaries')).toHaveProperty('checked',false);
});
it.each([400,409])('clears a failed secret and never resubmits it (%s)',async status=>{
  const base=handler;handler=async(url,body)=>body?.action==='set'?failure(status,'synthetic-error'):base(url,body);
  renderView();await loaded();fireEvent.change(screen.getByLabelText('OpenAI API key'),{target:{value:'failed-secret'}});fireEvent.click(screen.getByRole('button',{name:'Save OpenAI key'}));
  await screen.findByText(status===409?/Configuration changed/:/Change failed/);expect(screen.getByLabelText('OpenAI API key')).toHaveProperty('value','');expect(requests.filter(r=>r.body?.action==='set')).toHaveLength(1);expect(document.body.textContent).not.toContain('failed-secret');
  if(status===409)expect(requests.filter(r=>r.url.startsWith('/api/providers?')&&!r.body)).toHaveLength(2);
});
it('shows locked setup guidance and refuses missing-ok success shapes',async()=>{
  handler=async()=>failure(503,'local_setup_required');const view=renderView();await screen.findByText('Local setup required');expect(screen.queryByLabelText('OpenAI API key')).toBeNull();view.unmount();
  handler=async()=>new Response(JSON.stringify(state));renderView();await screen.findByText(/Connection settings are unavailable/);
});
it('locks environment credentials while allowing explicit removal of an overridden saved key',async()=>{
  state.credentials[2]={...state.credentials[2],saved:true,configured:true,source:'environment'};
  renderView();await loaded();expect(screen.getByLabelText('OpenAI API key')).toHaveProperty('readOnly',true);expect(card('OpenAI').getByText('OPENAI_API_KEY')).toBeDefined();
  fireEvent.click(screen.getByRole('button',{name:'Remove overridden saved OpenAI key'}));expect(requests.filter(r=>r.body)).toHaveLength(0);
  fireEvent.click(screen.getByRole('button',{name:'Confirm remove OpenAI'}));await waitFor(()=>expect(requests.some(r=>r.body?.action==='remove')).toBe(true));
});
it('requires explicit paid-test consent and describes auth-only tests truthfully',async()=>{
  state.credentials[0]={...state.credentials[0],configured:true,source:'environment'};const base=handler;handler=async(url,body)=>url.includes('/providers/test')?success({state:'valid',checkedAt:'2026-09-20T00:00:00Z',operation:'evaluation',credentialRevision:null,reason:'accepted'}):base(url,body);
  renderView();await loaded();fireEvent.click(screen.getByRole('button',{name:'Test TypeSafe connection'}));expect(requests.some(r=>r.url.includes('/providers/test'))).toBe(false);
  fireEvent.click(screen.getByLabelText(/Makes a small API request.*TypeSafe/));fireEvent.click(screen.getByRole('button',{name:'Test TypeSafe connection'}));await screen.findByText(/Last test: valid/);
  expect(requests.find(r=>r.url.includes('/providers/test'))?.body?.allowUsage).toBe(true);expect(card('OpenAI').getByText(/authentication only/)).toBeDefined();
});
it('discards a stale test after credential replacement',async()=>{
  state.credentials[2]={...state.credentials[2],saved:true,configured:true,source:'saved',revision:1};
  let finish:(response:Response)=>void=()=>{};const base=handler;handler=(url,body)=>url.includes('/providers/test')?new Promise(resolve=>{finish=resolve;}):base(url,body);
  renderView();await loaded();fireEvent.click(screen.getByRole('button',{name:'Test OpenAI connection'}));
  fireEvent.change(screen.getByLabelText('OpenAI API key'),{target:{value:'replacement'}});fireEvent.click(screen.getByRole('button',{name:'Replace OpenAI key'}));
  await screen.findByText(/OpenAI credential saved/);
  await act(async()=>finish(success({state:'rejected',checkedAt:'2026-09-20T00:00:00Z',operation:'auth',credentialRevision:1,reason:'rejected'})));
  expect(card('OpenAI').getByText('Last test: unchecked')).toBeDefined();expect(requests.find(r=>r.url.includes('/providers/test'))?.signal?.aborted).toBe(true);
});
it('clears secrets and ignores the previous project response on project switch',async()=>{
  let finish:(response:Response)=>void=()=>{};const base=handler;handler=(url,body)=>url.includes('/providers/jev')?new Promise(resolve=>{finish=resolve;}):base(url,body);
  const view=renderView();await loaded();fireEvent.change(screen.getByLabelText('OpenAI API key'),{target:{value:'project-secret'}});fireEvent.click(screen.getByLabelText('Enable Jev for this project'));fireEvent.click(screen.getByRole('button',{name:'Save Jev policy'}));
  project.value='two';setProject('two');view.rerender(<ToastProvider><Providers/></ToastProvider>);await loaded();expect(screen.getByLabelText('OpenAI API key')).toHaveProperty('value','');
  const old=fixture();if(old.jev)old.jev.policy.enabled=true;await act(async()=>finish(success(old)));
  expect(screen.getByLabelText('Enable Jev for this project')).toHaveProperty('checked',false);expect(screen.queryByText('Project Jev policy saved.')).toBeNull();expect(requests.find(r=>r.url.includes('/providers/jev'))?.signal?.aborted).toBe(true);
});
it('shows restart requirements, separate code consent, and only explicitly probes native sessions',async()=>{
  const base=handler;handler=(url,body)=>url.includes('native=1')?Promise.resolve(success({...state,native:{claude:'installed_auth_unverified',codex:'unauthenticated'}})):base(url,body);
  renderView();await loaded();expect(screen.getByText(/Summary and brain routing changes require restarting/)).toBeDefined();expect(requests.some(r=>r.url.includes('native=1'))).toBe(false);
  await screen.findByLabelText('Embedding provider');fireEvent.change(screen.getByLabelText('Embedding provider'),{target:{value:'openai'}});fireEvent.click(screen.getByRole('button',{name:'Save provider'}));expect(requests.some(r=>r.url.includes('/semantic/policy'))).toBe(false);
  fireEvent.click(screen.getByLabelText(/Use this provider for this project's semantic code search/));fireEvent.click(screen.getByRole('button',{name:'Save provider'}));await waitFor(()=>expect(requests.find(r=>r.url.includes('/semantic/policy'))?.body).toEqual({provider:'openai',expectedRevision:5,acknowledgeCodeUpload:true}));
  fireEvent.click(screen.getByRole('button',{name:'Refresh native CLI status'}));await screen.findByText('Installed; authentication unverified');expect(screen.getByText('Unauthenticated')).toBeDefined();
});
it('cancels a key draft without making a request',async()=>{
  renderView();await loaded();fireEvent.change(screen.getByLabelText('OpenAI API key'),{target:{value:'cancel-secret'}});fireEvent.click(screen.getByRole('button',{name:'Cancel OpenAI'}));expect(screen.getByLabelText('OpenAI API key')).toHaveProperty('value','');expect(requests.filter(r=>r.body)).toHaveLength(0);
});
it('saves summary and brain routing with the global revision and locks environment-owned targets',async()=>{
  renderView();await loaded();fireEvent.click(screen.getByLabelText('Enable summaries'));fireEvent.click(screen.getByRole('button',{name:'Save summary routing'}));
  await screen.findByText('Summary routing saved. Restart affected MCP and ingest processes.');
  expect(requests.find(r=>r.body?.target==='summary')?.body).toEqual({target:'summary',value:{enabled:true,provider:'anthropic',model:null,fallback:null},expectedRevision:0});
  fireEvent.change(screen.getByLabelText('Brain embedding provider'),{target:{value:'openai'}});fireEvent.click(screen.getByRole('button',{name:'Save brain routing'}));
  await screen.findByText('Brain routing saved. Restart affected MCP and ingest processes.');expect(requests.find(r=>r.body?.target==='brain')?.body).toEqual({target:'brain',value:{enabled:true,provider:'openai'},expectedRevision:0});
  cleanup();state.routing.managed.summary=['MAI_LLM_SUMMARY'];state.routing.managed.brain=['MAI_EMBEDDINGS'];if(state.jev)state.jev.managed=['MAI_JEV_ENABLED'];renderView();await loaded();
  expect(screen.getByRole('group',{name:'Summaries'})).toHaveProperty('disabled',true);expect(screen.getByRole('group',{name:'Brain embeddings'})).toHaveProperty('disabled',true);expect(screen.getByRole('group',{name:'Project Jev policy'})).toHaveProperty('disabled',true);
});
it('rejects malformed provider metadata before presenting configured state',async()=>{
  const base=handler;handler=(url,body)=>url.startsWith('/api/providers')?Promise.resolve(success({...state,credentials:[{provider:'openai',configured:true}]})):base(url,body);
  renderView();await screen.findByText(/Connection settings are unavailable/);expect(screen.queryByLabelText('OpenAI API key')).toBeNull();
});
it.each(['environment','saved'] as const)('refresh replaces a transient check result for %s even at the same revision',async source=>{
  state.credentials[2]={...state.credentials[2],source,saved:source==='saved',configured:true,revision:1};
  const base=handler;handler=(url,body)=>url.includes('/providers/test')?Promise.resolve(success({state:'valid',checkedAt:'2026-09-20T00:00:00Z',operation:'auth',credentialRevision:source==='saved'?1:null,reason:'accepted'})):base(url,body);
  renderView();await loaded();fireEvent.click(screen.getByRole('button',{name:'Test OpenAI connection'}));await screen.findByText(/Last test: valid/);
  state.credentials[2]={...state.credentials[2],check:source==='saved'?{state:'rejected',checkedAt:'2026-09-20T01:00:00Z',operation:'auth',credentialRevision:1,reason:'rejected'}:null};
  fireEvent.click(screen.getByRole('button',{name:'Refresh connections'}));
  await waitFor(()=>expect(card('OpenAI').getByText(source==='saved'?/Last test: rejected/:'Last test: unchecked')).toBeDefined());
  expect(card('OpenAI').queryByText(/Last test: valid/)).toBeNull();
});
