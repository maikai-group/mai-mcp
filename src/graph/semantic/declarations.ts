import ts from 'typescript';
import { createHash } from 'node:crypto';
import type { StableNode } from './types.js';
interface DeclarationSpan { name: string; line: number; start: number; end: number }
interface DeclarationEntry { spans: readonly DeclarationSpan[] | null; cost: number }
// Store positions and names, never compiler nodes/programs. Charging the full
// source size accounts for strings which a JS engine may retain as substrings.
const declarationCache = new Map<string,DeclarationEntry>();
const DECLARATION_CACHE_ENTRIES = 256;
const DECLARATION_CACHE_BYTES = 16 * 1024 * 1024;
let declarationCacheBytes = 0;

function declarationSpans(file: string, source: string): readonly DeclarationSpan[] | null {
  const key = `${file}\0${createHash('sha256').update(source).digest('hex')}`;
  const cached = declarationCache.get(key);
  if (cached) {
    declarationCache.delete(key);
    declarationCache.set(key,cached);
    return cached.spans;
  }
  const sf = ts.createSourceFile(file,source,ts.ScriptTarget.Latest,true);
  const options:ts.CompilerOptions={target:ts.ScriptTarget.ESNext,jsx:ts.JsxEmit.Preserve,noLib:true,noResolve:true,allowJs:true};
  const host:ts.CompilerHost={getSourceFile:name=>name===file?sf:undefined,writeFile:()=>{throw new Error('Syntax validation must not emit');},
    getDefaultLibFileName:()=>'',useCaseSensitiveFileNames:()=>true,getCanonicalFileName:name=>name,getCurrentDirectory:()=>'',
    getNewLine:()=>'\n',fileExists:name=>name===file,readFile:name=>name===file?source:undefined};
  const program=ts.createProgram([file],options,host);
  const parsed={diagnostics:program.getSyntacticDiagnostics(sf)};
  const spans: DeclarationSpan[] = [];
  const invalid = parsed.diagnostics?.some(d => d.category === ts.DiagnosticCategory.Error) ?? false;
  function add(decl: ts.Node, name: string, start: number): void {
    spans.push({name,line:sf.getLineAndCharacterOfPosition(decl.getStart(sf)).line+1,start,end:decl.end});
  }
  if (!invalid) for (const stmt of sf.statements) {
    if ((ts.isFunctionDeclaration(stmt) || ts.isClassDeclaration(stmt)) && stmt.name) add(stmt,stmt.name.text,stmt.getFullStart());
    if (ts.isVariableStatement(stmt)) {
      for (const decl of stmt.declarationList.declarations) {
        if (ts.isIdentifier(decl.name) && decl.initializer && (ts.isArrowFunction(decl.initializer) || ts.isFunctionExpression(decl.initializer))) {
          add(decl,decl.name.text,stmt.declarationList.declarations.length === 1 ? stmt.getFullStart() : decl.getStart(sf));
        }
      }
    }
  }
  const result = invalid ? null : spans;
  const cost = source.length*2 + key.length*2 + 256 + spans.reduce((total,span)=>total+96+span.name.length*2,0);
  if (cost <= DECLARATION_CACHE_BYTES) {
    while (declarationCache.size >= DECLARATION_CACHE_ENTRIES || declarationCacheBytes+cost > DECLARATION_CACHE_BYTES) {
      const oldest = declarationCache.entries().next().value;
      if (!oldest) break;
      declarationCache.delete(oldest[0]);
      declarationCacheBytes -= oldest[1].cost;
    }
    declarationCache.set(key,{spans:result,cost});
    declarationCacheBytes += cost;
  }
  return result;
}

export function declarationRange(file: string, source: string, node: StableNode): {start:number;end:number} | null {
  if (!/\.(?:tsx?|jsx?|mts|cts|mjs|cjs)$/i.test(file)) return null;
  const spans = declarationSpans(file,source);
  if (spans === null) return null;
  const matches = spans.filter(span=>span.name===node.name && span.line===node.line);
  return matches.length === 1 ? {start:matches[0].start,end:matches[0].end} : null;
}

export function declarationBody(file:string,source:string,node:StableNode):string|null {
 const range=declarationRange(file,source,node);return range?source.slice(range.start,range.end):null;
}
