import { LOCAL_EMBED_MODEL, LOCAL_MODEL_DIR, LOCAL_QUERY_PREFIX } from '../../embeddings.js';
import { vectorIsValid } from './ranking.js';
import { boundCue } from './cues.js';
import { createCodeReranker, type CodeReranker } from './reranker.js';
import type { CodeEmbedder } from './provider.js';

// Called only in the model thread. Native ONNX calls can block its event loop.
export async function createLocalModel(model: string): Promise<CodeEmbedder|null> {
  let disposed=false;
    try {
      const t = await import('@huggingface/transformers');
      t.env.cacheDir = LOCAL_MODEL_DIR();
      t.env.allowRemoteModels = false;
      let pipeline: import('@huggingface/transformers').FeatureExtractionPipeline|null = await t.pipeline('feature-extraction',LOCAL_EMBED_MODEL,{
        dtype:'q8',local_files_only:true,session_options:{intraOpNumThreads:1,interOpNumThreads:1},
      });
      async function embed(text: string): Promise<number[] | null> {
        if (disposed||!pipeline) return null;
        try {
          const output = await pipeline(text,{pooling:'mean',normalize:true});
          const vector = Array.from(output.data);
          return !disposed && vectorIsValid(vector,384) ? vector : null;
        } catch { return null; }
      }
      let embeddingClose:Promise<void>|undefined,reranker:Promise<CodeReranker>|undefined,closing:Promise<void>|undefined;
      function closeEmbedding():Promise<void> {
        if(embeddingClose)return embeddingClose;
        const active=pipeline;pipeline=null;
        return embeddingClose=active?active.dispose():Promise.resolve();
      }
      return {model,dimensions:384,document:embed,query:text=>embed(LOCAL_QUERY_PREFIX+text),
        cue:async text=>{const active=pipeline;if(disposed||!active)return null;
          return embed(boundCue(text,value=>active.tokenizer.encode(value)));},
        rerank:async(query,documents)=>{
          if(disposed)return null;
          try{
            await closeEmbedding();if(disposed)return null;
            const active=await (reranker??=createCodeReranker());
            if(disposed){await active.close();return null;}
            return await active.score(query,documents);
          }catch{return null;}
        },
        close:()=>{disposed=true;return closing??=(async()=>{
          try{await closeEmbedding();}finally{if(reranker)await reranker.then(active=>active.close(),()=>{});}
        })();}};
    } catch { return null; }

}
