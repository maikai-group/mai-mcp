import { describe, expect, it } from 'vitest';
import { fuseRanks, fuseReranked } from '../graph/semantic/ranking.js';
import { codeCues } from '../graph/semantic/code-cues.js';
import { cueEmbedding, cueFingerprint, boundCue } from '../graph/semantic/cues.js';
import { currentVectors, type VectorEvidence } from '../graph/semantic/cache.js';
import { DOCUMENT_VERSION, type CodeDocument } from '../graph/semantic/types.js';
const document:CodeDocument={version:DOCUMENT_VERSION,mode:'declaration',sourceHash:'b'.repeat(64),fingerprint:'a'.repeat(64),truncated:false,
  text:'Kind: function\nSymbol: file#saveHTTPResult\nLanguage: typescript\n/** Persist safely */\nfunction saveHTTPResult(cacheKey) { return writeValue(cacheKey, "saved"); }',
  node:{projectId:'project',identity:'c'.repeat(64),nodeId:'node',kind:'function',name:'saveHTTPResult',qualifiedName:'file#saveHTTPResult',
    extractedBy:'typescript',physicalPath:'/repo/file.ts',line:2,signature:null,language:'typescript'}};
function row():VectorEvidence {
  const cue=cueEmbedding(document,Array(384).fill(1));
  return {model:'local:bge-small-en-v1.5',document_version:DOCUMENT_VERSION,fingerprint:document.fingerprint,
    source_hash:document.sourceHash,document_mode:document.mode,embedding:Array(384).fill(1),
    cue_version:cue.version,cue_fingerprint:cue.fingerprint,cue_embedding:cue.embedding};
}
describe('local search evidence fusion',()=>{
  it('keeps a strong first-stage result when a conflicting reranker would eject it',()=>{
    const first=Array.from({length:8},(_,i)=>({identity:String(i+1)}));
    const scores=[7.3,9.45,8.76,8.84,6.99,9.33,7.17,7.78];
    expect(fuseReranked(first,scores).slice(0,5).map(item=>item.identity)).toContain('1');
    expect(first.map((item,i)=>({...item,score:scores[i]})).sort((a,b)=>b.score-a.score).slice(0,5).map(item=>item.identity)).not.toContain('1');
  });
  it('reranks eight while retaining the entire thirty-result tail and deterministic ties',()=>{
    const first=Array.from({length:30},(_,i)=>({identity:String(i+1)}));
    const result=fuseReranked(first,[1,2,3,4,5,6,7,8]);
    expect(result.slice(0,8).map(item=>item.identity)).toEqual(['1','8','2','7','3','6','4','5']);
    expect(result.slice(8)).toEqual(first.slice(8));expect(new Set(result.map(item=>item.identity)).size).toBe(30);
    expect(fuseReranked(first.slice(0,1),[1])).toEqual(first.slice(0,1));
  });
  it('rejects missing, duplicated and nonfinite evidence instead of treating it as a rank',()=>{
    expect(()=>fuseRanks([{identity:'a'}],[{identity:'b'}])).toThrow();
    expect(()=>fuseRanks([{identity:'a'},{identity:'a'}],[{identity:'a'},{identity:'a'}])).toThrow();
    expect(()=>fuseReranked([{identity:'a'}],[])).toThrow();
    expect(()=>fuseReranked([{identity:'a'}],[NaN])).toThrow();
  });
  it('projects source cues while keeping raw source and metadata evidence separate',()=>{
    expect(codeCues(document)).toBe('Function: save HTTP Result\nComments: Persist safely\nNames: save HTTP Result cache Key write Value\nMessages: saved');
    const metadata:CodeDocument={...document,mode:'metadata'};
    expect(codeCues(metadata)).toBe(document.text);
    expect(cueFingerprint({...document,node:{...document.node,name:'different'}})).not.toBe(cueFingerprint(document));
    expect(document.text).toContain('function saveHTTPResult');
  });
  it('clips cue input to its tokenizer bound without leaving half a surrogate pair',()=>{
    const text='a'.repeat(509)+'😀zz';
    const bounded=boundCue(text,value=>Array(value.length+2).fill(0));
    expect(bounded).toBe('a'.repeat(509));
    expect(boundCue('small',value=>Array(value.length+2).fill(0))).toBe('small');
  });
  it('requires matching raw and cue evidence for a complete local entry',()=>{
    const good=row();expect(currentVectors(good,document,good.model)).toBe(true);
    for(const patch of [{cue_version:null},{cue_fingerprint:null},{cue_embedding:null},{cue_version:'code-cues/old'},
      {cue_fingerprint:'d'.repeat(64)},{cue_embedding:Array(384).fill(0)},{embedding:Array(384).fill(0)},
      {source_hash:'c'.repeat(64)},{document_version:'old'},{document_mode:'metadata'}]) {
      expect(currentVectors({...good,...patch},document,good.model)).toBe(false);
    }
    expect(currentVectors(good,{...document,node:{...document.node,name:'changed'}},good.model)).toBe(false);
    const cloud={...good,model:'voyage-3',embedding:Array(1024).fill(1),cue_version:null,cue_fingerprint:null,cue_embedding:null};
    expect(currentVectors(cloud,document,cloud.model)).toBe(true);
  });
});
