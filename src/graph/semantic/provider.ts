import OpenAI from 'openai';
import { resolveCredential } from '../../providers/runtime.js';
import { readProviderJson } from '../../providers/checks.js';
import { LOCAL_EMBED_MODEL } from '../../embeddings.js';
import { validCodePolicy } from './policy.js';
import { object, SemanticError } from './validation.js';
import { vectorIsValid } from './ranking.js';
import { LIMITS, type CodePolicy } from './types.js';
import { createLocalModelProcess } from './local-model-process.js';

export interface CodeEmbedder {
  model: string; dimensions: 384 | 1024 | 1536;
  document(text: string): Promise<number[] | null>;
  query(text: string): Promise<number[] | null>;
  cue?(text: string): Promise<number[] | null>;
  rerank?(query: string, documents: readonly string[]): Promise<number[] | null>;
  close(): Promise<void>;
}
export function modelFor(policy: CodePolicy): string | null {
  if (!validCodePolicy(policy)) throw new SemanticError('Invalid code provider policy',409);
  switch (policy.provider) {
    case 'off': return null;
    case 'local': return `local:${LOCAL_EMBED_MODEL.split('/')[1]}`;
    case 'openai': return 'text-embedding-3-small';
    case 'voyage': return 'voyage-3';
  }
}
export async function createCodeEmbedder(policy: CodePolicy): Promise<CodeEmbedder | null> {
  const model = modelFor(policy);
  if (!model) return null;
  const controller = new AbortController();
  let disposed = false;
  if (policy.provider === 'local') return createLocalModelProcess(model);
  if(policy.provider!=='openai'&&policy.provider!=='voyage')return null;
  const cloudProvider=policy.provider;
  const dimensions=cloudProvider==='openai'?1536:1024;
  async function embed(text: string, inputType: 'document'|'query'): Promise<number[] | null> {
    if (disposed) return null;
    let response:Response|undefined;
      let key:string|null;
      try{key=await resolveCredential(cloudProvider,controller.signal);}catch{if(disposed||controller.signal.aborted)return null;throw new SemanticError('Selected provider key is unavailable',409);}
      if(disposed||controller.signal.aborted)return null;
      if(!key)throw new SemanticError('Selected provider key is missing',409);
    try {
      const openai=cloudProvider==='openai'?new OpenAI({apiKey:key,baseURL:'https://api.openai.com/v1',timeout:LIMITS.cloudMs,maxRetries:0}):null;
      let value: unknown;
      if (openai) {
        const response = await openai.embeddings.create({model:'text-embedding-3-small',input:text,dimensions:1536},
          {signal:AbortSignal.any([controller.signal,AbortSignal.timeout(LIMITS.cloudMs)])});
        value = response.data.length === 1 ? response.data[0].embedding : null;
      } else {
        const signal=AbortSignal.any([controller.signal,AbortSignal.timeout(LIMITS.cloudMs)]);
        response = await fetch('https://api.voyageai.com/v1/embeddings',{
          method:'POST',headers:{Authorization:`Bearer ${key}`,'Content-Type':'application/json'},
          body:JSON.stringify({model:'voyage-3',input:[text],input_type:inputType}),
          signal,redirect:'error',
        });
        if (!response.ok) return null;
        const raw: unknown = await readProviderJson(response,262144,signal);
        const parsed = object(raw,['object','data','model','usage']);
        if (!Array.isArray(parsed.data) || parsed.data.length !== 1) return null;
        value = object(parsed.data[0],['object','embedding','index']).embedding;
      }
      return !disposed && vectorIsValid(value,dimensions) ? value : null;
    } catch { return null; }
    finally{await response?.body?.cancel().catch(()=>{});}
  }
  return {model,dimensions,document:text=>embed(text,'document'),query:text=>embed(text,'query'),
    close:async()=>{disposed=true;controller.abort();}};
}
