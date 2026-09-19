import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import path from 'node:path';
import os from 'node:os';

const fake=vi.hoisted(()=>({directory:'',embedding:vi.fn(),fetch:vi.fn()}));
vi.mock('../embeddings.js',()=>({downloadLocalModel:fake.embedding,LOCAL_EMBED_MODEL:'Xenova/bge-small-en-v1.5'}));
vi.mock('../graph/semantic/reranker-assets.js',async()=>{
  const {createHash}=await import('node:crypto');
  return {RERANKER_ID:'cross-encoder/ettin-reranker-150m-v1',RERANKER_REVISION:'025501c4e0f9bbeb4c5b198318e0089ff061cc14',
    rerankerDirectory:()=>fake.directory,RERANKER_FILES:[{file:'config.json',bytes:6,sha256:createHash('sha256').update('config').digest('hex')},
      {file:'onnx/model_qint8_arm64.onnx',bytes:7,sha256:createHash('sha256').update('weights').digest('hex')}]};
});
const {downloadCodeReranker,setupCodeModels}=await import('../graph/semantic/setup.js');
const {verifyArtifact}=await import('../graph/semantic/artifact.js');
beforeEach(async()=>{
  fake.directory=await mkdtemp(path.join(os.tmpdir(),'semantic-setup-'));fake.embedding.mockReset();fake.embedding.mockResolvedValue(true);
  fake.fetch.mockReset();fake.fetch.mockImplementation(async(url:string)=>new Response(url.endsWith('config.json')?'config':'weights'));
  vi.stubGlobal('fetch',fake.fetch);
});
afterEach(async()=>{vi.unstubAllGlobals();await rm(fake.directory,{recursive:true,force:true});});
async function noPartial(){
  const paths=await readdir(fake.directory,{recursive:true});expect(paths.filter(name=>name.includes('.partial-'))).toEqual([]);
}
it('downloads only pinned public artifact URLs and reuses a fully verified cache',async()=>{
  await downloadCodeReranker();expect(fake.fetch).toHaveBeenCalledTimes(2);
  for(const call of fake.fetch.mock.calls){expect(call[0]).toMatch(/^https:\/\/huggingface\.co\/cross-encoder\/ettin-reranker-150m-v1\/resolve\/025501c4e0f9bbeb4c5b198318e0089ff061cc14\//);expect(Object.keys(call[1])).toEqual(['signal']);expect(call[1].signal).toBeInstanceOf(AbortSignal);}
  expect(await readFile(path.join(fake.directory,'onnx/model_qint8_arm64.onnx'),'utf8')).toBe('weights');
  await downloadCodeReranker();expect(fake.fetch).toHaveBeenCalledTimes(2);await noPartial();
});
it('repairs same-size corrupt bytes while retaining other verified artifacts',async()=>{
  await downloadCodeReranker();await writeFile(path.join(fake.directory,'config.json'),'broken');fake.fetch.mockClear();
  await downloadCodeReranker();expect(fake.fetch).toHaveBeenCalledOnce();expect(await readFile(path.join(fake.directory,'config.json'),'utf8')).toBe('config');await noPartial();
});
it.each(['checksum','oversized','truncated','http','transport'])('does not publish a %s download and cleans owned temporary files',async failure=>{
  await writeFile(path.join(fake.directory,'config.json'),'broken');
  fake.fetch.mockImplementationOnce(async()=>{
    if(failure==='transport')throw new Error('offline');
    return new Response(failure==='checksum'?'xxxxxx':failure==='oversized'?'too long':failure==='truncated'?'tiny':'denied',{status:failure==='http'?403:200});
  });
  await expect(downloadCodeReranker()).rejects.toThrow();expect(await readFile(path.join(fake.directory,'config.json'),'utf8')).toBe('broken');await noPartial();
});
it('cleans a partial file when the response stream fails after its first chunk',async()=>{
  let chunks=0;
  fake.fetch.mockImplementationOnce(async()=>new Response(new ReadableStream<Uint8Array>({pull(controller){if(chunks++===0)controller.enqueue(new TextEncoder().encode('con'));else controller.error(new Error('connection lost'));}})));
  await expect(downloadCodeReranker()).rejects.toThrow('connection lost');expect(await readdir(fake.directory)).toEqual([]);
});
it('allows concurrent setup to publish only identical verified bytes',async()=>{
  await Promise.all([downloadCodeReranker(),downloadCodeReranker()]);expect(await readFile(path.join(fake.directory,'config.json'),'utf8')).toBe('config');
  expect(await readFile(path.join(fake.directory,'onnx/model_qint8_arm64.onnx'),'utf8')).toBe('weights');await noPartial();
});
it('requires a working local embedding setup and never selects a cloud provider',async()=>{
  fake.embedding.mockResolvedValueOnce(false);await expect(setupCodeModels()).rejects.toThrow('Local embedding setup failed');expect(fake.fetch).not.toHaveBeenCalled();
  expect(await setupCodeModels()).toMatchObject({state:'ready',embeddingModel:'Xenova/bge-small-en-v1.5',reranker:'cross-encoder/ettin-reranker-150m-v1',directory:fake.directory});
});
it('verifies exact file length and digest independently of the setup writer',async()=>{
  const file=path.join(fake.directory,'fixture');await writeFile(file,'config');
  await expect(verifyArtifact(file,{file:'fixture',bytes:6,sha256:createHash('sha256').update('config').digest('hex')})).resolves.toBeUndefined();
  await expect(verifyArtifact(file,{file:'fixture',bytes:5,sha256:'a'.repeat(64)})).rejects.toThrow('size');
  await expect(verifyArtifact(file,{file:'fixture',bytes:6,sha256:'a'.repeat(64)})).rejects.toThrow('checksum');
});
