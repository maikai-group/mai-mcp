import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';
import { vectorIsValid, retainCurrent, supplementCurrent } from '../graph/semantic/ranking.js';
import { normalizeSearch } from '../graph/semantic/service.js';
import { decodePolicy, normalizePolicy } from '../graph/semantic/policy.js';
import { createCodeEmbedder } from '../graph/semantic/provider.js';
import { forbiddenSource } from '../graph/semantic/document.js';
import { declarationBody } from '../graph/semantic/declarations.js';
import type { StableNode } from '../graph/semantic/types.js';

const fake=vi.hoisted(()=>({infer:vi.fn(),pipeline:vi.fn(),dispose:vi.fn(),openai:vi.fn(),create:vi.fn(),
  reranker:vi.fn(),score:vi.fn(),rerankerClose:vi.fn(),env:{cacheDir:'',allowRemoteModels:true}}));
vi.mock('openai',()=>({default:fake.openai}));
vi.mock('@huggingface/transformers',()=>({env:fake.env,pipeline:fake.pipeline}));
vi.mock('../graph/semantic/reranker.js',()=>({createCodeReranker:fake.reranker}));
// Test the cached-only backend here; process orchestration and actual entries
// have separate lifecycle and transport tests.
vi.mock('../graph/semantic/local-model-process.js',async()=>({createLocalModelProcess:(await import('../graph/semantic/local-model.js')).createLocalModel}));
const node:StableNode={projectId:'00000000-0000-4000-8000-000000000001',identity:'a'.repeat(64),nodeId:'00000000-0000-4000-8000-000000000002',
  name:'save',kind:'function',qualifiedName:'a.ts#save',extractedBy:'typescript',physicalPath:'/a.ts',line:1,signature:null,language:'typescript'};
beforeEach(()=>{
  vi.stubEnv('OPENAI_API_KEY','test-not-a-real-key');vi.stubEnv('VOYAGE_API_KEY','test-not-a-real-key');
  fake.openai.mockReset();fake.create.mockReset();fake.openai.mockImplementation(function(){return {embeddings:{create:fake.create}};});
  fake.infer.mockReset();fake.pipeline.mockReset();fake.dispose.mockReset();
  fake.infer.mockResolvedValue({data:new Float32Array(384).fill(1)});
  fake.pipeline.mockResolvedValue(Object.assign(fake.infer,{dispose:fake.dispose,tokenizer:{encode:(text:string)=>Array(text.length+2).fill(0)}}));
  fake.reranker.mockReset();fake.score.mockReset();fake.rerankerClose.mockReset();
  fake.score.mockResolvedValue([2,1]);fake.rerankerClose.mockResolvedValue(undefined);
  fake.reranker.mockResolvedValue({score:fake.score,close:fake.rerankerClose});
});
afterEach(()=>{vi.unstubAllEnvs();vi.unstubAllGlobals();});
describe('semantic source and provider boundaries',()=>{
  it('pins OpenAI payloads, dimensions, no retries, errors and disposal under valid consent',async()=>{
    fake.create.mockResolvedValue({data:[{embedding:Array(1536).fill(1)}]});
    const p=await createCodeEmbedder({provider:'openai',revision:1,consentVersion:'code-and-lessons/1'});if(!p)throw Error('provider absent');
    expect(p.model).toBe('text-embedding-3-small');expect(p.dimensions).toBe(1536);
    expect(await p.document('source')).toHaveLength(1536);expect(await p.query('question')).toHaveLength(1536);
    expect(fake.openai).toHaveBeenCalledWith({apiKey:'test-not-a-real-key',baseURL:'https://api.openai.com/v1',timeout:5000,maxRetries:0});
    expect(fake.create.mock.calls.map(call=>call[0])).toEqual(['source','question'].map(input=>({model:'text-embedding-3-small',input,dimensions:1536})));
    expect(fake.create.mock.calls[0][1].signal).toBeInstanceOf(AbortSignal);
    fake.create.mockResolvedValueOnce({data:[{embedding:[1]}]});expect(await p.document('bad shape')).toBeNull();
    fake.create.mockRejectedValueOnce(Error('offline'));expect(await p.query('failure')).toBeNull();
    const n=fake.create.mock.calls.length;await p.close();expect(await p.document('closed')).toBeNull();expect(fake.create).toHaveBeenCalledTimes(n);
  });
  it('pins Voyage document/query roles and refuses HTTP, transport and malformed-vector failures',async()=>{
    const fetch=vi.fn().mockResolvedValue(new Response(JSON.stringify({data:[{embedding:Array(1024).fill(1)}]})));vi.stubGlobal('fetch',fetch);
    const p=await createCodeEmbedder({provider:'voyage',revision:1,consentVersion:'code-and-lessons/1'});if(!p)throw Error('provider absent');
    expect(p.model).toBe('voyage-3');expect(p.dimensions).toBe(1024);
    // Response bodies are single-use; return a fresh body for each request.
    fetch.mockImplementation(async()=>new Response(JSON.stringify({data:[{embedding:Array(1024).fill(1)}]})));
    expect(await p.document('source')).toHaveLength(1024);expect(await p.query('question')).toHaveLength(1024);
    expect(fetch.mock.calls.map(call=>JSON.parse(call[1].body))).toEqual([{model:'voyage-3',input:['source'],input_type:'document'},{model:'voyage-3',input:['question'],input_type:'query'}]);
    expect(fetch.mock.calls[0][0]).toBe('https://api.voyageai.com/v1/embeddings');expect(fetch.mock.calls[0][1].signal).toBeInstanceOf(AbortSignal);
    fetch.mockResolvedValueOnce(new Response('{}',{status:429}));expect(await p.query('rate limited')).toBeNull();
    fetch.mockRejectedValueOnce(Error('offline'));expect(await p.query('offline')).toBeNull();
    fetch.mockResolvedValueOnce(new Response(JSON.stringify({data:[{embedding:Array(1024).fill(0)}]})));expect(await p.document('zero')).toBeNull();
    await p.close();expect(await p.query('closed')).toBeNull();expect(fetch).toHaveBeenCalledTimes(5);
  });
  it('uses local-only single-thread inference even with both cloud keys present',async()=>{
    const fetch=vi.fn();vi.stubGlobal('fetch',fetch);
    const provider=await createCodeEmbedder({provider:'local',revision:0,consentVersion:null});
    expect(provider).not.toBeNull();
    await provider?.document('document');await provider?.query('question');await provider?.close();
    expect(fake.env.allowRemoteModels).toBe(false);
    expect(fake.pipeline).toHaveBeenCalledWith('feature-extraction','Xenova/bge-small-en-v1.5',{
      dtype:'q8',local_files_only:true,session_options:{intraOpNumThreads:1,interOpNumThreads:1}});
    expect(fake.infer.mock.calls.map(call=>call[0])).toEqual(['document','Represent this sentence for searching relevant passages: question']);
    expect(fake.dispose).toHaveBeenCalledOnce();expect(fetch).not.toHaveBeenCalled();
  });
  it('missing local weights does not fetch or select a cloud provider',async()=>{
    const fetch=vi.fn();vi.stubGlobal('fetch',fetch);fake.pipeline.mockRejectedValue(new Error('missing weights'));
    expect(await createCodeEmbedder({provider:'local',revision:0,consentVersion:null})).toBeNull();expect(fetch).not.toHaveBeenCalled();
  });
  it('bounds cue input and disposes the embedder before loading the reranker',async()=>{
    const p=await createCodeEmbedder({provider:'local',revision:0,consentVersion:null});if(!p?.cue||!p.rerank)throw Error('missing local interface');
    await p.cue('x'.repeat(1000));expect(fake.infer.mock.calls[0][0]).toHaveLength(510);
    fake.reranker.mockImplementation(async()=>{expect(fake.dispose).toHaveBeenCalledOnce();return {score:fake.score,close:fake.rerankerClose};});
    expect(await p.rerank('query',['one','two'])).toEqual([2,1]);expect(await p.document('after rerank')).toBeNull();
    expect(fake.score).toHaveBeenCalledWith('query',['one','two']);await p.close();await p.close();
    expect(fake.dispose).toHaveBeenCalledOnce();expect(fake.rerankerClose).toHaveBeenCalledOnce();
  });
  it('closes a reranker that finishes loading after its provider was closed',async()=>{
    const p=await createCodeEmbedder({provider:'local',revision:0,consentVersion:null});if(!p?.rerank)throw Error('missing local interface');
    let complete:(()=>void)|undefined;
    fake.reranker.mockImplementation(()=>new Promise(resolve=>{complete=()=>resolve({score:fake.score,close:fake.rerankerClose});}));
    const pending=p.rerank('query',['one']);await vi.waitFor(()=>expect(complete).toBeDefined());
    const closing=p.close();if(!complete)throw Error('load was not started');complete();
    expect(await pending).toBeNull();await closing;expect(fake.score).not.toHaveBeenCalled();
    // The real CodeReranker owns idempotent close; both race participants may request cleanup.
    expect(fake.rerankerClose).toHaveBeenCalled();expect(fake.dispose).toHaveBeenCalledOnce();
  });
  it('returns unavailable on reranker failure and still closes every loaded model',async()=>{
    const p=await createCodeEmbedder({provider:'local',revision:0,consentVersion:null});if(!p?.rerank)throw Error('missing local interface');
    fake.score.mockRejectedValueOnce(Error('inference failed'));
    expect(await p.rerank('query',['one'])).toBeNull();await p.close();
    expect(fake.dispose).toHaveBeenCalledOnce();expect(fake.rerankerClose).toHaveBeenCalledOnce();
  });
  it.each(['openai','voyage'] as const)('rejects invalid persisted %s consent before provider construction',async provider=>{
    expect(()=>decodePolicy({provider,revision:1,consent_version:null})).toThrow();
    expect(()=>normalizePolicy({provider,expectedRevision:0})).toThrow();
    const fetch=vi.fn();vi.stubGlobal('fetch',fetch);
    await expect(createCodeEmbedder({provider,revision:1,consentVersion:null})).rejects.toThrow();
    expect(fake.pipeline).not.toHaveBeenCalled();expect(fetch).not.toHaveBeenCalled();
  });
  it.each([384,1024,1536])('validates %i dimensions and rejects zero/non-finite/mismatched vectors',dimensions=>{
    expect(vectorIsValid(Array(dimensions).fill(1),dimensions)).toBe(true);
    expect(vectorIsValid(Array(dimensions).fill(0),dimensions)).toBe(false);
    expect(vectorIsValid(Array(dimensions).fill(NaN),dimensions)).toBe(false);
    expect(vectorIsValid(Array(dimensions+1).fill(1),dimensions)).toBe(false);
  });
  it('refills two winners after three stale higher-scored records',async()=>{
    const candidates=[5,4,3,2,1].map(score=>({identity:String(score),nodeId:String(score),score}));
    const hydrate=vi.fn(async(candidate:{score:number})=>candidate.score>2?null:candidate.score);
    expect(await retainCurrent(candidates,2,hydrate,()=>false)).toEqual([2,1]);expect(hydrate).toHaveBeenCalledTimes(5);
  });
  it('cuts at declarations and excludes neighbors or sibling variables',()=>{
    expect(declarationBody('a.ts','function save(){return 1}\nfunction secret(){return 2}',node)).toBe('function save(){return 1}');
    expect(declarationBody('a.ts','const save=()=>1, secret=()=>2;',node)).toBe('save=()=>1');
    expect(declarationBody('a.ts','const save=()=>1;',node)).toBe('const save=()=>1');
    expect(declarationBody('a.ts','class save { method(){return 1} }\nclass Other{}',{...node,kind:'class'})).not.toContain('Other');
  });
  it('keeps exact declaration comments and rejects ambiguous or invalid spans',()=>{
    const source='/** saves atomically */\nfunction save(){return 1}\nfunction neighbor(){}';
    expect(declarationBody('a.ts',source,{...node,line:2})).toBe('/** saves atomically */\nfunction save(){return 1}');
    expect(declarationBody('a.ts',source,{...node,line:30})).toBeNull();
    expect(declarationBody('a.ts','function save( {',node)).toBeNull();
  });
  it.each(['/a/.env','/a/.env.local','/a/.git/config','/a/node_modules/a.ts','/a/private.key','/a/certs/a.ts'])('excludes sensitive/dependency path %s',file=>{
    expect(forbiddenSource(file)).toBe(true);
  });
  it('strictly rejects scope overrides and malformed search inputs',()=>{
    expect(normalizeSearch({query:'  save  '})).toEqual({query:'save',limit:10});
    for(const raw of [{query:'x',project:'foreign'},{query:'x',limit:0},{query:'x',limit:'3'},{query:' '},{query:'x'.repeat(1001)}])expect(()=>normalizeSearch(raw)).toThrow();
  });
});

describe('semantic result supplementation',()=>{
  it('preserves the fifth semantic hit when lexical coverage is current or unknown',async()=>{
    const semantic=[1,2,3,4,5].map(id=>({id:String(id)})),lexical=[{id:'6'}];
    expect(await supplementCurrent(semantic,lexical,5,async()=>true)).toEqual(semantic);
    expect(await supplementCurrent(semantic,lexical,5,async()=>null)).toEqual(semantic);
  });
  it('reserves lexical space only for proven unindexed rows and preserves zero-hit fallback',async()=>{
    const semantic=[1,2,3,4,5].map(id=>({id:String(id)})),lexical=[{id:'1'},{id:'6'},{id:'7'}];
    expect(await supplementCurrent(semantic,lexical,5,async hit=>hit.id==='7'?false:true)).toEqual([...semantic.slice(0,4),{id:'7'}]);
    expect(await supplementCurrent([],lexical,5,async()=>false)).toEqual(lexical);
    expect(await supplementCurrent(semantic,lexical,1,async()=>false)).toEqual([semantic[0]]);
  });
});
