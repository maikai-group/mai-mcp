import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { createHash } from 'node:crypto';
import { mkdtemp, realpath, rm, writeFile, rename } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import type { StableNode } from '../graph/semantic/types.js';
import { LIMITS } from '../graph/semantic/types.js';

const state=vi.hoisted(()=>({file:'',hash:'',buffers:new Array<number>(),beforeRead:async()=>{},parses:0}));
vi.mock('../db.js',()=>({getPool:()=>({query:async()=>({rows:[{file_path:state.file,content_hash:state.hash}]})})}));
vi.mock('../graph/semantic/identity.js',()=>({identityContext:async()=>({}),eligiblePhysicalPath:(file:string)=>file}));
vi.mock('../graph/semantic/declarations.js',async importOriginal=>{
 const original=await importOriginal<typeof import('../graph/semantic/declarations.js')>();
 return {...original,declarationRange:(...args:Parameters<typeof original.declarationRange>)=>{state.parses++;return original.declarationRange(...args);}};
});
vi.mock('node:fs/promises',async importOriginal=>{
  const original=await importOriginal<typeof import('node:fs/promises')>();
  return {...original,open:async(...args:Parameters<typeof original.open>)=>{
    const handle=await original.open(...args);
    return {stat:()=>handle.stat(),close:()=>handle.close(),read:async(buffer:Buffer,offset:number,length:number,position:number)=>{
      state.buffers.push(buffer.length);const hook=state.beforeRead;state.beforeRead=async()=>{};await hook();
      return handle.read(buffer,offset,length,position);
    }};
  }};
});
const {buildDocument,buildCachedDocument,frameDocument,documentFingerprint}=await import('../graph/semantic/document.js');
let root='';
function node():StableNode{return {projectId:'00000000-0000-4000-8000-000000000001',identity:'a'.repeat(64),nodeId:'00000000-0000-4000-8000-000000000002',
  name:'save',kind:'function',qualifiedName:'code.ts#save',extractedBy:'typescript',physicalPath:state.file,line:1,signature:null,language:'typescript'};}
async function source(value:string|Buffer){await writeFile(state.file,value);state.hash=createHash('sha256').update(value).digest('hex');}
beforeEach(async()=>{root=await realpath(await mkdtemp(path.join(os.tmpdir(),'semantic-read-')));state.file=path.join(root,'code.ts');state.buffers=[];state.beforeRead=async()=>{};state.parses=0;});
afterEach(async()=>{await rm(root,{recursive:true,force:true});});
it('reads a tiny declaration with one growth byte and preserves its exact document',async()=>{
  const text='function save(){return 1}';await source(text);const result=await buildDocument(node());
  expect(result).toMatchObject({mode:'declaration',sourceHash:state.hash,text:frameDocument(node(),text),fingerprint:documentFingerprint(frameDocument(node(),text))});
  expect(state.buffers.length).toBeGreaterThan(0);expect(new Set(state.buffers)).toEqual(new Set([Buffer.byteLength(text)+1]));
});
it('accepts an empty stable file as metadata',async()=>{await source('');expect(await buildDocument(node())).toMatchObject({mode:'metadata',sourceHash:state.hash});expect(state.buffers).toEqual([1]);});
it('accepts the exact byte limit and rejects a file above it before allocation',async()=>{
  state.file=path.join(root,'code.txt');await source('x'.repeat(LIMITS.sourceBytes));expect(await buildDocument(node())).toMatchObject({mode:'metadata',sourceHash:state.hash});
  expect(new Set(state.buffers)).toEqual(new Set([LIMITS.sourceBytes+1]));state.buffers=[];
  await source('x'.repeat(LIMITS.sourceBytes+1));expect(await buildDocument(node())).toBeNull();expect(state.buffers).toEqual([]);
});
it.each(['grow','shrink','replace'])('rejects source %s between open and read',async mutation=>{
  await source('function save(){return 1}');
  state.beforeRead=async()=>{
    if(mutation==='replace'){await writeFile(state.file+'.new','function save(){return 1}');await rename(state.file+'.new',state.file);}
    else await writeFile(state.file,mutation==='grow'?'function save(){return 1}\n// larger':'short');
  };
  expect(await buildDocument(node())).toBeNull();
});
it('rejects malformed UTF-8 and content differing from the extracted hash',async()=>{
  await source(Buffer.from([0xc3,0x28]));expect(await buildDocument(node())).toBeNull();
  await source('function save(){return 1}');await writeFile(state.file,'function save(){return 2}');expect(await buildDocument(node())).toBeNull();
});

function evidence(document:NonNullable<Awaited<ReturnType<typeof buildDocument>>>){return {source_evidence:document.sourceEvidence,source_hash:document.sourceHash,fingerprint:document.fingerprint,document_mode:document.mode};}
it.each([
 ['function save(){return 1}\nfunction neighbor(){return 2}',1],
 ['/** Unicode é😀 comment */\nfunction save(){return "😀"}',2],
 ['const save=()=>1,neighbor=()=>2;',1],
 ['const save=()=>1;',1],
 ['class save { method(){return 1} }',1],
])('reuses compiler evidence without parsing and preserves exact document bytes: %s',async(text,line)=>{
 if(typeof text!=='string'||typeof line!=='number')throw Error('Invalid fixture');
 await source(text);const current={...node(),line};const indexed=await buildDocument(current);if(!indexed)throw Error('Missing indexed document');
 expect(indexed.mode).toBe('declaration');expect(state.parses).toBe(1);state.parses=0;
 expect(await buildCachedDocument(current,evidence(indexed))).toEqual(indexed);expect(state.parses).toBe(0);
});
it('rejects malformed, missing and mismatched cached evidence without parsing',async()=>{
 await source('function save(){return 1}');const indexed=await buildDocument(node());if(!indexed)throw Error('Missing indexed document');state.parses=0;
 const row=evidence(indexed);
 for(const change of [undefined,null,{}, {...indexed.sourceEvidence,version:'old'}, {...indexed.sourceEvidence,name:'other'},
  {...indexed.sourceEvidence,line:2},{...indexed.sourceEvidence,start:-1},{...indexed.sourceEvidence,end:Infinity},
  {...indexed.sourceEvidence,end:LIMITS.sourceBytes+1},{...indexed.sourceEvidence,end:900},
  {...indexed.sourceEvidence,start:1},{...indexed.sourceEvidence,extra:true}]){
  expect(await buildCachedDocument(node(),{...row,source_evidence:change})).toBeNull();
 }
 expect(await buildCachedDocument(node(),undefined)).toBeNull();
 expect(await buildCachedDocument(node(),{...row,fingerprint:'f'.repeat(64)})).toBeNull();
 expect(await buildCachedDocument(node(),{...row,source_hash:'f'.repeat(64)})).toBeNull();
 expect(await buildCachedDocument(node(),{...row,document_mode:'metadata'})).toBeNull();expect(state.parses).toBe(0);
});
it.each(['grow','shrink','replace','hash-change'])('retains live-source protections on cached reads: %s',async mutation=>{
 await source('function save(){return 1}');const indexed=await buildDocument(node());if(!indexed)throw Error('Missing indexed document');state.parses=0;
 if(mutation==='hash-change')await source('function save(){return 2}');
 else state.beforeRead=async()=>{if(mutation==='replace'){await writeFile(state.file+'.new','function save(){return 1}');await rename(state.file+'.new',state.file);}else await writeFile(state.file,mutation==='grow'?'function save(){return 1} //grow':'short');};
 expect(await buildCachedDocument(node(),evidence(indexed))).toBeNull();expect(state.parses).toBe(0);
});
it('keeps metadata evidence separate from compiler ranges',async()=>{
 state.file=path.join(root,'code.txt');await source('plain text');const indexed=await buildDocument(node());if(!indexed)throw Error('Missing metadata');state.parses=0;
 expect(await buildCachedDocument(node(),evidence(indexed))).toEqual(indexed);
 expect(await buildCachedDocument(node(),{...evidence(indexed),source_evidence:{...indexed.sourceEvidence,start:0,end:5}})).toBeNull();expect(state.parses).toBe(0);
});
