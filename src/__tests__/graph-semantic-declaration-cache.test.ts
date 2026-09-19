import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { StableNode } from '../graph/semantic/types.js';

const parsing=vi.hoisted(()=>({calls:0,emits:0}));
vi.mock('typescript',async importOriginal=>{
  const original=await importOriginal<typeof import('typescript')>();
  return {...original,default:{...original,
    createSourceFile:(...args:Parameters<typeof original.createSourceFile>)=>{
      parsing.calls++;return original.createSourceFile(...args);
    },
    transpileModule:(...args:Parameters<typeof original.transpileModule>)=>{
      parsing.emits++;return original.transpileModule(...args);
    },
  }};
});
let declarationBody:typeof import('../graph/semantic/declarations.js').declarationBody;
const node:StableNode={projectId:'00000000-0000-4000-8000-000000000001',identity:'a'.repeat(64),nodeId:'00000000-0000-4000-8000-000000000002',
  name:'save',kind:'function',qualifiedName:'a.ts#save',extractedBy:'typescript',physicalPath:'/a.ts',line:1,signature:null,language:'typescript'};
beforeEach(async()=>{
  vi.resetModules();parsing.calls=0;parsing.emits=0;
  ({declarationBody}=await import('../graph/semantic/declarations.js'));
});

describe('bounded exact-content declaration reuse',()=>{
  it('validates source without emitting a second compiler output',()=>{
    const source='function save(){return 1}';
    expect(declarationBody('no-emit.ts',source,node)).toBe(source);
    expect(parsing.calls).toBe(1);expect(parsing.emits).toBe(0);
  });
  it('rejects TypeScript-only grammar in JavaScript files',()=>{
    const source='const save=(value:number)=>value;';
    expect(declarationBody('grammar.ts',source,node)).toBe('const save=(value:number)=>value');
    expect(declarationBody('grammar.js',source,node)).toBeNull();
  });
  it('parses once for multiple symbols but preserves separate exact spans',()=>{
    const source='/** note */\nfunction save(){return 1}\nfunction other(){return 2}';
    expect(declarationBody('a.ts',source,{...node,line:2})).toBe('/** note */\nfunction save(){return 1}');
    expect(declarationBody('a.ts',source,{...node,name:'other',line:3})).toBe('\nfunction other(){return 2}');
    expect(declarationBody('a.ts',source,{...node,line:3})).toBeNull();
    expect(parsing.calls).toBe(1);
  });
  it('separates content versions, including invalid source, without stale fallback',()=>{
    const old='function save(){return 1}',changed='function save(){return 2}',invalid='function save( {';
    expect(declarationBody('a.ts',old,node)).toBe(old);
    expect(declarationBody('a.ts',changed,node)).toBe(changed);
    expect(declarationBody('a.ts',invalid,node)).toBeNull();
    expect(declarationBody('a.ts',invalid,node)).toBeNull();
    expect(declarationBody('a.ts',old,node)).toBe(old);
    expect(parsing.calls).toBe(3);
  });
  it('keeps filename-sensitive syntax validation separate for identical source',()=>{
    const source='const save=()=> <div/>;';
    expect(declarationBody('a.ts',source,node)).toBeNull();
    expect(declarationBody('a.tsx',source,node)).toBe('const save=()=> <div/>');
    expect(declarationBody('a.ts',source,node)).toBeNull();
    expect(parsing.calls).toBe(2);
  });
  it('evicts the least recently used entry at the count bound',()=>{
    const source='function save(){return 1}';
    for(let i=0;i<256;i++)expect(declarationBody(`${i}.ts`,source,node)).toBe(source);
    expect(parsing.calls).toBe(256);
    declarationBody('0.ts',source,node);declarationBody('256.ts',source,node);
    expect(parsing.calls).toBe(257);
    declarationBody('0.ts',source,node);expect(parsing.calls).toBe(257);
    declarationBody('1.ts',source,node);expect(parsing.calls).toBe(258);
  });
  it('also evicts at the byte bound before reaching the entry count',()=>{
    const source='function save(){return 1}\n/*'+'x'.repeat(600000)+'*/';
    for(let i=0;i<16;i++)declarationBody(`${i}.ts`,source,node);
    expect(parsing.calls).toBe(16);
    expect(declarationBody('0.ts',source,node)).toBe('function save(){return 1}');
    expect(parsing.calls).toBe(17);
  });
});
