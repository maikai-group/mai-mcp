import { mkdir, open, rename, rm } from 'node:fs/promises';
import { createHash, randomUUID } from 'node:crypto';
import path from 'node:path';
import { downloadLocalModel, LOCAL_EMBED_MODEL } from '../../embeddings.js';
import { RERANKER_ID, RERANKER_REVISION, RERANKER_FILES, rerankerDirectory } from './reranker-assets.js';
import { verifyArtifact, type ModelArtifact } from './artifact.js';

async function downloadArtifact(directory:string,artifact:ModelArtifact,signal:AbortSignal):Promise<void> {
  const destination=path.join(directory,artifact.file);
  try{await verifyArtifact(destination,artifact);return;}catch{/* Explicit setup repairs missing or corrupt cached files. */}
  signal.throwIfAborted();
  await mkdir(path.dirname(destination),{recursive:true});
  const url=`https://huggingface.co/${RERANKER_ID}/resolve/${RERANKER_REVISION}/${artifact.file}`;
  const response=await fetch(url,{signal});
  if(!response.ok||!response.body){await response.body?.cancel();throw new Error(`Model download failed (${response.status}): ${artifact.file}`);}
  const temporary=destination+`.partial-${randomUUID()}`;
  const reader=response.body.getReader();
  let handle:Awaited<ReturnType<typeof open>>|undefined;
  try{
    handle=await open(temporary,'wx',0o600);
    const hash=createHash('sha256');let size=0;
    while(true){
      signal.throwIfAborted();
      const part=await reader.read();if(part.done)break;
      size+=part.value.byteLength;
      if(size>artifact.bytes)throw new Error(`Model download exceeds pinned size: ${artifact.file}`);
      hash.update(part.value);
      let offset=0;
      while(offset<part.value.length){
        const written=await handle.write(part.value,offset,part.value.length-offset);
        if(written.bytesWritten===0)throw new Error('Model cache write made no progress');
        offset+=written.bytesWritten;
      }
    }
    if(size!==artifact.bytes||hash.digest('hex')!==artifact.sha256)throw new Error(`Model download checksum mismatch: ${artifact.file}`);
    signal.throwIfAborted();
    await handle.close();handle=undefined;
    // Concurrent setups publish only the same verified pinned bytes. A query
    // seeing an incomplete collection fails local verification and falls back.
    await rename(temporary,destination);
  }finally{
    await reader.cancel().catch(()=>{});reader.releaseLock();
    try{await handle?.close();}finally{await rm(temporary,{force:true});}
  }
}

export async function downloadCodeReranker(directory=rerankerDirectory()):Promise<void> {
  const signal=AbortSignal.timeout(300000);
  for(const artifact of RERANKER_FILES)await downloadArtifact(directory,artifact,signal);
  for(const artifact of RERANKER_FILES)await verifyArtifact(path.join(directory,artifact.file),artifact);
}

/** Explicit CLI setup only. Search and indexing never import this download path. */
export async function setupCodeModels():Promise<{state:'ready';embeddingModel:string;reranker:string;revision:string;directory:string}> {
  if(!await downloadLocalModel())throw new Error('Local embedding setup failed; install optional dependencies and retry setup-local');
  const directory=rerankerDirectory();
  await downloadCodeReranker(directory);
  return {state:'ready',embeddingModel:LOCAL_EMBED_MODEL,reranker:RERANKER_ID,revision:RERANKER_REVISION,directory};
}
