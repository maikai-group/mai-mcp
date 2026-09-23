import {beforeEach,afterEach,expect,it,vi} from 'vitest';
import fs from 'node:fs';import os from 'node:os';import path from 'node:path';import {randomBytes} from 'node:crypto';
import {ProviderStore} from '../providers/store.js';
const fake=vi.hoisted(()=>({master:Buffer.alloc(32),readMaster:vi.fn(),openai:vi.fn(),anthropic:vi.fn(),chat:vi.fn(),messages:vi.fn(),embeddings:vi.fn()}));
vi.mock('../providers/keyring.js',()=>({readMaster:fake.readMaster}));
vi.mock('openai',()=>({default:fake.openai}));
vi.mock('@anthropic-ai/sdk',()=>({default:fake.anthropic}));
let root:string;let store:ProviderStore;
const request={prompt:'input-canary',schema:{type:'object' as const,properties:{}},schemaName:'result',maxTokens:10};
beforeEach(async()=>{
  vi.resetModules();await import('../env.js');
  for(const key of ['ANTHROPIC_API_KEY','OPENAI_API_KEY','VOYAGE_API_KEY','TYPESAFE_API_KEY','MAI_LLM_SUMMARY','MAI_LLM_PROVIDER','MAI_LLM_FALLBACK_PROVIDER','MAI_SUMMARY_MODEL','MAI_EMBEDDINGS'])vi.stubEnv(key,undefined);
  root=fs.mkdtempSync(path.join(os.tmpdir(),'mai-consumers-'));vi.stubEnv('MAI_STATE_HOME',root);store=new ProviderStore(root);fake.master=randomBytes(32);
  fake.readMaster.mockReset().mockImplementation(async()=>Buffer.from(fake.master));
  fake.openai.mockReset().mockImplementation(function(){return {chat:{completions:{create:fake.chat}},embeddings:{create:fake.embeddings}};});
  fake.anthropic.mockReset().mockImplementation(function(){return {messages:{create:fake.messages}};});
  fake.chat.mockReset().mockResolvedValue({choices:[{message:{content:'{}'}}]});
  fake.messages.mockReset().mockResolvedValue({content:[{type:'tool_use',input:{}}]});
  fake.embeddings.mockReset().mockResolvedValue({data:[{embedding:Array(1536).fill(1)}]});
});
afterEach(()=>{vi.restoreAllMocks();vi.unstubAllGlobals();vi.unstubAllEnvs();vi.resetModules();fs.rmSync(root,{recursive:true,force:true});});
it.each(['anthropic','openai'] as const)('%s rotates on the next completion and pins the official endpoint',async provider=>{
  store.replaceCredential(provider,0,'first-synthetic',fake.master);
  vi.stubEnv('OPENAI_BASE_URL','https://invalid.example');vi.stubEnv('ANTHROPIC_BASE_URL','https://invalid.example');vi.stubEnv('MAI_LLM_BASE_URL','https://invalid.example');
  const adapter=provider==='openai'?new (await import('../llm/openai.js')).OpenAIProvider({model:'test'}):new (await import('../llm/anthropic.js')).AnthropicProvider('test');
  expect(await adapter.completeJSON(request)).toEqual({});store.replaceCredential(provider,1,'second-synthetic',fake.master);expect(await adapter.completeJSON(request)).toEqual({});
  const ctor=provider==='openai'?fake.openai:fake.anthropic;
  expect(ctor.mock.calls.map(call=>call[0])).toEqual(['first-synthetic','second-synthetic'].map(apiKey=>({apiKey,baseURL:provider==='openai'?'https://api.openai.com/v1':'https://api.anthropic.com'})));
});
it.each([undefined,''])('compatible endpoints never receive the saved credential (env %s)',async value=>{
  store.replaceCredential('openai',0,'saved-never-forward',fake.master);vi.stubEnv('OPENAI_API_KEY',value);
  const adapter=new (await import('../llm/openai.js')).OpenAIProvider({model:'test',baseURL:'http://localhost:1234'});await adapter.completeJSON(request);
  expect(JSON.stringify(fake.openai.mock.calls)).not.toContain('saved-never-forward');
});
it('freezes routing until a new module instance and never enables from a key alone',async()=>{
  store.replaceCredential('openai',0,'saved',fake.master);
  let llm=await import('../llm/provider.js');expect(llm.detectLLMProviderId()).toBeNull();
  store.setSummary(1,{enabled:true,provider:'openai',model:'saved-model',fallback:null});expect(llm.detectLLMProviderId()).toBeNull();
  vi.resetModules();llm=await import('../llm/provider.js');expect(llm.detectLLMProviderId()).toBe('openai');expect(llm.summaryModel('openai')).toBe('saved-model');
  store.setSummary(2,{enabled:true,provider:'anthropic',model:'other',fallback:null});expect(llm.detectLLMProviderId()).toBe('openai');
});
it('explicit automation zero flags defeat saved enablement',async()=>{
  store.replaceCredential('openai',0,'saved',fake.master);store.setSummary(1,{enabled:true,provider:'openai',model:null,fallback:null});store.setBrain(2,{enabled:true,provider:'openai'});
  vi.stubEnv('MAI_LLM_SUMMARY','0');vi.stubEnv('MAI_EMBEDDINGS','0');
  expect((await import('../llm/provider.js')).getLLMProvider()).toBeNull();expect(await (await import('../embeddings.js')).embed('input')).toBeNull();expect(fake.openai).not.toHaveBeenCalled();
});
it('keeps the brain model identity after removal and clears old-key cooldown after replacement',async()=>{
  store.replaceCredential('openai',0,'old',fake.master);store.setBrain(1,{enabled:true,provider:'openai'});
  const emb=await import('../embeddings.js');expect(emb.currentEmbeddingModelId()).toBe('openai:text-embedding-3-small');
  fake.embeddings.mockRejectedValue(Error('synthetic-secret input-canary'));const log=vi.spyOn(console,'warn').mockImplementation(()=>{});
  expect(await emb.embed('input-canary1')).toBeNull();expect(await emb.embed('input-canary2')).toBeNull();expect(await emb.embed('input-canary3')).toBeNull();expect(fake.embeddings).toHaveBeenCalledTimes(2);
  store.replaceCredential('openai',2,'new',fake.master);fake.embeddings.mockResolvedValue({data:[{embedding:[1,2]}]});expect(await emb.embed('fresh')).toEqual([1,2]);
  store.removeCredential('openai',3);expect(await emb.embed('after-remove')).toBeNull();expect(emb.currentEmbeddingModelId()).toBe('openai:text-embedding-3-small');
  expect(JSON.stringify(log.mock.calls)).not.toMatch(/synthetic-secret|input-canary/);
});
it('resolves credentials for each batch of an existing code embedder',async()=>{
  store.replaceCredential('openai',0,'first',fake.master);
  const embedder=await (await import('../graph/semantic/provider.js')).createCodeEmbedder({provider:'openai',revision:3,consentVersion:'code-and-lessons/1'});
  expect(await embedder?.document('one')).toHaveLength(1536);store.replaceCredential('openai',1,'second',fake.master);expect(await embedder?.query('two')).toHaveLength(1536);
  expect(fake.openai.mock.calls.map(call=>call[0].apiKey)).toEqual(['first','second']);expect(embedder?.model).toBe('text-embedding-3-small');await embedder?.close();
});
it('cancels oversized Voyage success and unread error bodies without logging their contents',async()=>{
  store.replaceCredential('voyage',0,'synthetic-secret',fake.master);store.setBrain(1,{enabled:true,provider:'voyage'});
  const log=vi.spyOn(console,'warn').mockImplementation(()=>{});const cancels=[vi.fn(),vi.fn()];let index=0;
  vi.stubGlobal('fetch',vi.fn(async()=>{const i=index++;return new Response(new ReadableStream({pull(controller){controller.enqueue(new TextEncoder().encode('synthetic-secret input-canary'.repeat(20000)));},cancel:cancels[i]}),{status:i===0?200:401});}));
  const emb=await import('../embeddings.js');expect(await emb.embed('one')).toBeNull();expect(await emb.embed('two')).toBeNull();expect(cancels[0]).toHaveBeenCalled();expect(cancels[1]).toHaveBeenCalled();expect(JSON.stringify(log.mock.calls)).not.toMatch(/synthetic-secret|input-canary/);
});
it('isolates absent-environment availability from operator state and subscription child environments',async()=>{
  expect(root).toContain('mai-consumers-');vi.stubEnv('MAI_LLM_SUMMARY','1');expect((await import('../llm/provider.js')).detectLLMProviderId()).toBeNull();
  for(const [i,provider] of (['openai','anthropic','voyage','typesafe'] as const).entries())store.replaceCredential(provider,i,'saved-canary',fake.master);
  const child=(await import('../llm/child-env.js')).subscriptionChildEnv();expect(JSON.stringify(child)).not.toContain('saved-canary');
  for(const key of ['OPENAI_API_KEY','ANTHROPIC_API_KEY','VOYAGE_API_KEY','TYPESAFE_API_KEY'])expect(Object.hasOwn(child,key)).toBe(false);
});

it('observes cross-process replacement while retaining the reader route snapshot',async()=>{
  const {spawn}=await import('node:child_process');
  const fixture=new URL('./fixtures/providers/runtime-worker.mjs',import.meta.url);
  const children=[spawn(process.execPath,[fixture.pathname],{stdio:['pipe','pipe','pipe'],env:{PATH:process.env.PATH}}),spawn(process.execPath,[fixture.pathname],{stdio:['pipe','pipe','pipe'],env:{PATH:process.env.PATH}})];
  const exits=children.map(child=>new Promise<void>(resolve=>child.once('close',()=>resolve())));
  async function ask(index:number,message:unknown):Promise<unknown>{
    const child=children[index];return new Promise((resolve,reject)=>{
      let data='';const timer=setTimeout(()=>done(Error('worker timeout')),5000);
      const receive=(chunk:Buffer)=>{data+=chunk.toString();if(data.length>4096)done(Error('worker overflow'));else if(data.includes('\n')){try{done(null,JSON.parse(data));}catch{done(Error('worker frame'));}}};
      const fail=()=>done(Error('worker exited'));
      function done(error:Error|null,value?:unknown){clearTimeout(timer);child.stdout.off('data',receive);child.off('exit',fail);if(error)reject(error);else resolve(value);}
      child.stdout.on('data',receive);child.once('exit',fail);child.stdin.write(JSON.stringify(message)+'\n');
    });
  }
  try{
    await Promise.all(children.map((_,index)=>ask(index,{op:'init',root,master:fake.master.toString('base64')})));
    await ask(0,{op:'save',key:'child-key-one',provider:'openai'});
    expect(await ask(1,{op:'read'})).toEqual({key:'child-key-one',route:{enabled:true,provider:'openai'}});
    await ask(0,{op:'save',key:'child-key-two',provider:'voyage'});
    expect(await ask(1,{op:'read'})).toEqual({key:'child-key-two',route:{enabled:true,provider:'openai'}});
  }finally{for(const child of children)child.kill('SIGKILL');await Promise.all(exits);}
});
it('saved keys alone do not suppress local setup; enabled saved cloud routing does',async()=>{
  store.replaceCredential('openai',0,'saved',fake.master);
  const io={isTTY:false,ask:async()=>'',print:vi.fn()};
  let consent=await import('../scripts/llm-consent.js');
  expect(await consent.maybeOfferLocalEmbeddings(io,undefined,path.join(root,'test.env'))).toContain('hint');
  store.setBrain(1,{enabled:true,provider:'openai'});vi.resetModules();
  consent=await import('../scripts/llm-consent.js');
  expect(await consent.maybeOfferLocalEmbeddings(io,undefined,path.join(root,'test.env'))).toBeNull();
});
it.each([false,true])('does not claim local setup changed an existing saved route (enabled %s)',async enabled=>{
  store.setBrain(0,{enabled,provider:enabled?'openai':'local'});
  const io={isTTY:false,ask:async()=>'',print:vi.fn()};const envFile=path.join(root,'consent.env');
  const result=await (await import('../scripts/llm-consent.js')).maybeOfferLocalEmbeddings(io,'local',envFile);
  expect(result).toContain('Providers & Connections');expect(result).not.toContain('local semantic search enabled');expect(fs.existsSync(envFile)).toBe(false);
});
it('surfaces fixed code-embedding credential errors instead of silently skipping every batch',async()=>{
  const p=await (await import('../graph/semantic/provider.js')).createCodeEmbedder({provider:'openai',revision:1,consentVersion:'code-and-lessons/1'});
  await expect(p?.document('input-canary')).rejects.toThrow('Selected provider key is missing');
  store.replaceCredential('openai',0,'saved',fake.master);fake.master=randomBytes(32);
  await expect(p?.query('input-canary')).rejects.toThrow('Selected provider key is unavailable');await p?.close();
});

it('reports a stalled Voyage response as timeout rather than unavailable credential storage',async()=>{
  store.replaceCredential('voyage',0,'saved',fake.master);store.setBrain(1,{enabled:true,provider:'voyage'});
  const original=AbortSignal.timeout.bind(AbortSignal);vi.spyOn(AbortSignal,'timeout').mockImplementation(()=>original(10));
  const cancelled=vi.fn();vi.stubGlobal('fetch',vi.fn(async()=>new Response(new ReadableStream({cancel:cancelled}))));
  const log=vi.spyOn(console,'warn').mockImplementation(()=>{});const emb=await import('../embeddings.js');
  expect(await emb.embed('one')).toBeNull();expect(await emb.embed('two')).toBeNull();expect(cancelled).toHaveBeenCalledTimes(2);
  expect(JSON.stringify(log.mock.calls)).toContain('timeout');expect(JSON.stringify(log.mock.calls)).not.toContain('store_unavailable');expect(emb.embeddingsStatus()).toContain('timeout');
});

it('closing a code embedder cancels pending credential acquisition without reporting storage failure',async()=>{
  store.replaceCredential('openai',0,'saved',fake.master);
  let finish:(()=>void)|undefined;fake.readMaster.mockImplementation(()=>new Promise<Buffer>(resolve=>{finish=()=>resolve(Buffer.from(fake.master));}));
  const p=await (await import('../graph/semantic/provider.js')).createCodeEmbedder({provider:'openai',revision:1,consentVersion:'code-and-lessons/1'});
  const pending=p?.document('input');await vi.waitFor(()=>expect(finish).toBeDefined());await p?.close();finish?.();
  expect(await pending).toBeNull();expect(fake.openai).not.toHaveBeenCalled();
});
