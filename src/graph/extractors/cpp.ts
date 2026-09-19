// mai-graph C++ extractor (spec 2026-06-21) — tree-sitter-cpp via WASM.
// Two-pass: pass 1 parses every file, emits file/class/function nodes and
// records raw edge intents keyed by C++ symbol; pass 2 resolves includes,
// inheritance, and cross-TU calls against per-repo indexes. Functions/methods
// are SYMBOL-keyed (repoBase#Scope::Name) so a .h declaration and its .cpp
// definition are one node. In-repo resolution only; engine/system symbols drop
// (counted at the engine). Local-only, no LLM. AST node types verified against
// tree-sitter-cpp@0.23.4 (probe 2026-06-21).
import fs from 'node:fs';
import path from 'node:path';
import { Query, type Node } from 'web-tree-sitter';
import { hashContent } from '../engine.js';
import { loadLanguage, parserFor } from '../parsers.js';
import { canonicalRegisteredRoots } from '../roots.js';
import { listOwnedRepoFiles } from '../walk.js';
import type { ExtractedEdge, ExtractedNode, ExtractorOutput, GraphExtractor, NodeRef } from '../types.js';

export const CPP_EXT = new Set(['.cpp', '.cc', '.cxx', '.h', '.hpp', '.hh']);

// UE's UBT-generated DLL-export macros (`class GAMEUE_API FThing : …`) sit
// between `class` and the name; tree-sitter-cpp then takes the MACRO as the
// class name and loses the real name, bases, and methods in ERROR nodes
// (UE acceptance finding, 2026-07-10). Blank them out with EQUAL-LENGTH
// spaces before parsing so every line/column position stays true.
const API_MACRO_RE = /\b[A-Z][A-Z0-9_]*_API\b/g;

// JUCE's body-terminal member macros (semicolon-less, argument-taking) leave
// tree-sitter unable to close the class body in SOME contexts — proven live:
// InputChannelStrip.h parses to 0 classes / 4 ERROR nodes and its 3 classes'
// methods land in the graph as scope-less free functions (plan 35 recon,
// 2026-08-25). Blank them with equal-length spaces, same offset-preserving
// mechanism as API_MACRO_RE. Longest alternation first. JUCE_API needs no
// entry — the generic *_API rule above already covers it (verified: zero
// macro-mangled names in either JUCE project's live graph).
const JUCE_MACRO_RE =
  /\b(?:JUCE_DECLARE_NON_COPYABLE_WITH_LEAK_DETECTOR|JUCE_HEAVYWEIGHT_LEAK_DETECTOR|JUCE_DECLARE_WEAK_REFERENCEABLE|JUCE_DECLARE_SINGLETON_SINGLETHREADED_MINIMAL|JUCE_DECLARE_SINGLETON_SINGLETHREADED|JUCE_DECLARE_SINGLETON|JUCE_DECLARE_NON_COPYABLE|JUCE_LEAK_DETECTOR)\s*\([^)]*\)|\bJUCE_PREVENT_HEAP_ALLOCATION\b/g;

// Captures verified against tree-sitter-cpp@0.23.4 (see probe).
const QUERY_SRC = [
  '(preproc_include path: (string_literal (string_content) @include))',
  '(class_specifier name: (type_identifier) @class.name) @class',
  '(struct_specifier name: (type_identifier) @class.name) @class',
  '(function_definition) @func.def',
  '(field_declaration declarator: (function_declarator)) @method.decl',
  '(field_declaration declarator: (pointer_declarator (function_declarator))) @method.decl',
  '(field_declaration declarator: (reference_declarator (function_declarator))) @method.decl',
  '(declaration declarator: (function_declarator)) @free.decl',
  '(declaration declarator: (pointer_declarator (function_declarator))) @free.decl',
  '(declaration declarator: (reference_declarator (function_declarator))) @free.decl',
  '(field_declaration) @field',
  '(call_expression) @call',
  '(base_class_clause) @bases',
].join(' ');

// Per-repo accumulation across pass 1.
interface RepoCtx {
  repo: string;
  repoBase: string;
  nodes: ExtractedNode[];
  currentFileQn: string | null; // set per file in pass 1; caller fallback for calls
  // RESOLUTION key (Scope::Name, no arity) -> node qns (one per distinct overload).
  // Used by resolveCalls / resolveOwnership, which need clean simple names.
  symbolTable: Map<string, string[]>;
  // NODE-IDENTITY key (Scope::Name/arity) -> node qn. Dedups a .h declaration
  // and its .cpp definition (same scope+name+arity) onto ONE node.
  nodeByNodeKey: Map<string, string>;
  // class symbol key (Scope::ClassName) -> class node qn
  classTable: Map<string, string>;
  // repo-relative posix path -> file qn (for include resolution)
  fileByRelPath: Map<string, string>;
  rawIncludes: Array<{ fromFileQn: string; includePath: string }>;
  rawInherits: Array<{ derivedClassQn: string; baseName: string }>;
  rawCalls: Array<{ callerQn: string; calleeName: string }>;
  // class symbol key -> UPROPERTY field names (spec §4.4: recorded on the
  // owning class's metadata as a property list; fields are not nodes in v1).
  classProps: Map<string, string[]>;
  defines: ExtractedEdge[];
}

/** Parameter count of a function_declarator (overload disambiguator). */
function arityOf(funcDeclarator: Node | null): number {
  const params = funcDeclarator?.childForFieldName('parameters');
  if (!params) return 0;
  // parameter_list namedChildren are parameter_declaration nodes.
  return params.namedChildren.filter((c): c is Node => c !== null && c.type === 'parameter_declaration').length;
}

/** Unwrap pointer/reference declarators to the function_declarator they wrap.
 * `int* f()` → declaration declarator: (pointer_declarator declarator:
 * (function_declarator …)); the reference form nests WITHOUT a field name
 * (probe 2026-08-25). Without this, every function returning a pointer or
 * reference is silently dropped — 30 definitions + 174 declarations across the
 * two JUCE repos alone. */
function unwrapDeclarator(d: Node | null): Node | null {
  let cur = d;
  while (cur && (cur.type === 'pointer_declarator' || cur.type === 'reference_declarator')) {
    cur = cur.childForFieldName('declarator')
      ?? cur.namedChildren.find((c): c is Node => c !== null && c.type === 'function_declarator')
      ?? null;
  }
  return cur;
}

/** Build the `Scope::` prefix from namespace + class ancestors of a node. */
function scopeOf(n: Node): string {
  const parts: string[] = [];
  for (let p = n.parent; p; p = p.parent) {
    if (p.type === 'namespace_definition') {
      const name = p.childForFieldName('name')?.text;
      if (name) parts.unshift(name);
    } else if (p.type === 'class_specifier' || p.type === 'struct_specifier') {
      const name = p.childForFieldName('name')?.text;
      if (name) parts.unshift(name);
    }
  }
  return parts.join('::');
}

/** Extract the declared name + scope from a function_declarator's declarator.
 * Handles identifier (free), field_identifier (in-class), qualified_identifier
 * (out-of-line). Returns { scope, name } where scope is '' for plain ids. */
function declName(decl: Node | null): { scope: string; name: string } | null {
  if (!decl) return null;
  const d = decl.childForFieldName('declarator');
  if (!d) return null;
  if (d.type === 'identifier' || d.type === 'field_identifier') {
    return { scope: '', name: d.text };
  }
  if (d.type === 'qualified_identifier') {
    // Collect the chain: all namespace_identifier scopes + final identifier.
    const segs: string[] = [];
    let cur: Node | null = d;
    while (cur && cur.type === 'qualified_identifier') {
      const s = cur.childForFieldName('scope');
      if (s) segs.push(s.text);
      cur = cur.childForFieldName('name');
    }
    if (cur) segs.push(cur.text);
    const name = segs.pop();
    if (!name) return null;
    return { scope: segs.join('::'), name };
  }
  return null;
}

/** Merge reflection metadata into an already-emitted node (order-independent:
 * a .cpp definition may create the node before the header's UCLASS/UFUNCTION
 * declaration is seen, so the later, richer metadata must win). */
function mergeMeta(ctx: RepoCtx, qn: string, meta: Record<string, unknown>): void {
  if (Object.keys(meta).length === 0) return;
  const node = ctx.nodes.find((n) => n.qualifiedName === qn);
  if (node) node.metadata = { ...(node.metadata ?? {}), ...meta };
}

/** Create-or-reuse a function/method node. Identity is (scope, name, arity):
 * a declaration and its definition share it → ONE node; distinct overloads
 * (different arity) get distinct node qns (base, base/1, …). The RESOLUTION key
 * (scope::name, no arity) maps to all overload qns for call resolution. */
function ensureFunctionNode(
  ctx: RepoCtx, scope: string, name: string, arity: number,
  abs: string, line: number, meta: Record<string, unknown>, fileRef: NodeRef
): string {
  const resolutionKey = [scope, name].filter(Boolean).join('::');
  const nodeKey = `${resolutionKey}/${arity}`;
  const existing = ctx.nodeByNodeKey.get(nodeKey);
  if (existing) {
    mergeMeta(ctx, existing, meta); // decl+def converge; richer metadata wins
    return existing;
  }
  const base = `${ctx.repoBase}#${resolutionKey}`;
  const overloads = ctx.symbolTable.get(resolutionKey) ?? [];
  const qn = overloads.length === 0 ? base : `${base}/${overloads.length}`;
  ctx.symbolTable.set(resolutionKey, [...overloads, qn]);
  ctx.nodeByNodeKey.set(nodeKey, qn);
  ctx.nodes.push({ kind: 'function', name, qualifiedName: qn, filePath: abs, line, lang: 'cpp', metadata: meta });
  ctx.defines.push({ from: fileRef, to: { kind: 'function', qualifiedName: qn }, relation: 'defines' });
  return qn;
}

/** Create-or-reuse a class node (forward decl + definition converge; reflection
 * metadata merged so a UCLASS seen later still tags an earlier bare node). */
function ensureClassNode(ctx: RepoCtx, key: string, name: string, abs: string, line: number, meta: Record<string, unknown>, fileRef: NodeRef): string {
  const classQn = `${ctx.repoBase}#${key}`;
  const existing = ctx.classTable.get(key);
  if (existing) {
    mergeMeta(ctx, existing, meta);
    return existing;
  }
  ctx.classTable.set(key, classQn);
  ctx.nodes.push({ kind: 'class', name, qualifiedName: classQn, filePath: abs, line, lang: 'cpp', metadata: meta });
  ctx.defines.push({ from: fileRef, to: { kind: 'class', qualifiedName: classQn }, relation: 'defines' });
  return classQn;
}

export const cppExtractor: GraphExtractor = {
  name: 'cpp',
  vocabulary: {
    // 'inherits' added in Tier A (Task 4); harmless to declare now since the
    // engine validates emitted output, not the declared union. Declared here so
    // later tiers need no registry-of-vocabulary churn in this file.
    kinds: ['file', 'function', 'class'],
    relations: ['imports', 'defines', 'calls', 'inherits'],
  },
  async extract({ repoPaths, changedFiles, excludes }): Promise<ExtractorOutput> {
    const resolvedRepos = canonicalRegisteredRoots(repoPaths, { baseDir: process.cwd(), rejectRelative: true });
    const changed = changedFiles ? new Set(changedFiles.map((p) => path.resolve(p))) : null;

    const parser = await parserFor('cpp');
    const lang = await loadLanguage('cpp');
    const query = new Query(lang, QUERY_SRC);

    const allNodes: ExtractedNode[] = [];
    const allEdges: ExtractedEdge[] = [];

    for (const repo of resolvedRepos) {
      const ctx: RepoCtx = {
        repo,
        repoBase: path.basename(repo),
        nodes: [],
        currentFileQn: null,
        symbolTable: new Map(),
        nodeByNodeKey: new Map(),
        classTable: new Map(),
        fileByRelPath: new Map(),
        rawIncludes: [],
        rawInherits: [],
        rawCalls: [],
        classProps: new Map(),
        defines: [],
      };

      // Canonical enumeration (decision c6c84cbf, 2026-07-10): git-tracked +
      // exclude-aware; UE build output is typically gitignored so Intermediate/
      // Binaries never even enumerate on git repos (SKIP_DIRS covers non-git).
      const files = listOwnedRepoFiles(repo, resolvedRepos, CPP_EXT, excludes ?? []).filter((f) => !f.endsWith('.generated.h'));

      // ---- PASS 1: parse every file, emit nodes + raw edge intents ----
      for (const abs of files) {
        if (changed && !changed.has(path.resolve(abs))) continue; // splice mode
        let text: string;
        try {
          text = fs.readFileSync(abs, 'utf8');
        } catch {
          continue;
        }
        const relPosix = path.relative(repo, abs).split(path.sep).join('/');
        const fileQn = `${ctx.repoBase}/${relPosix}`;
        ctx.fileByRelPath.set(relPosix, fileQn);
        ctx.currentFileQn = fileQn; // caller-fallback for calls in this file
        const fileRef: NodeRef = { kind: 'file', qualifiedName: fileQn };
        ctx.nodes.push({
          kind: 'file', name: path.basename(abs), qualifiedName: fileQn,
          filePath: abs, lang: 'cpp', contentHash: hashContent(text),
        });

        // contentHash stays on the ORIGINAL text (file identity); only the
        // parse input is macro-blanked (offsets preserved by construction).
        const tree = parser.parse(
          text.replace(API_MACRO_RE, (m) => ' '.repeat(m.length)).replace(JUCE_MACRO_RE, (m) => ' '.repeat(m.length))
        );
        if (!tree) continue;
        const lines = text.split('\n');

        for (const cap of query.captures(tree.rootNode)) {
          const n = cap.node;
          const line = n.startPosition.row + 1;
          switch (cap.name) {
            case 'include':
              ctx.rawIncludes.push({ fromFileQn: fileQn, includePath: n.text });
              break;
            case 'class': {
              const nameNode = n.childForFieldName('name');
              if (!nameNode) break;
              const key = [scopeOf(n), nameNode.text].filter(Boolean).join('::');
              ensureClassNode(ctx, key, nameNode.text, abs, line, reflectionMeta(lines, n.startPosition.row, 'class'), fileRef);
              break;
            }
            case 'func.def': {
              emitFunction(ctx, n, abs, line, lines, fileRef);
              break;
            }
            case 'method.decl': {
              // Declaration-only method inside a class (header). Same key path
              // as the out-of-line definition so they share a node.
              emitMethodDecl(ctx, n, abs, line, lines, fileRef);
              break;
            }
            case 'free.decl': {
              // Free-function PROTOTYPE at namespace/TU scope (`void Helper();`)
              // — same (scope,name,arity) key as a definition, so calls resolve
              // even when only the declaration is in-repo (retro gap, 2026-07-10).
              emitMethodDecl(ctx, n, abs, line, lines, fileRef);
              break;
            }
            case 'field': {
              recordProperty(ctx, n, lines);
              break;
            }
            case 'call':
              recordCall(ctx, n);
              break;
            case 'bases':
              recordBases(ctx, n);
              break;
          }
        }
      }

      // UPROPERTY lists attach to their class nodes once pass 1 has seen
      // everything (a .cpp may emit the class before the header's fields).
      for (const [classKey, props] of ctx.classProps) {
        const qn = ctx.classTable.get(classKey);
        if (qn) mergeMeta(ctx, qn, { properties: props });
      }

      // ---- PASS 2: resolve raw intents ----
      const dIncludes = resolveIncludes(ctx, allEdges);
      resolveOwnership(ctx, allEdges); // class —defines→ method for class-scoped symbols
      const dInherits = resolveInherits(ctx, allEdges);
      const dCalls = resolveCalls(ctx, allEdges);
      // Drop-count report (spec §6.3: "reported and sane — not silently zero").
      // These drop PRE-emission (precision-favoring), so the engine's resolver
      // never sees them — report here, stderr, like the codex parser does.
      if (dIncludes + dInherits + dCalls > 0) {
        console.error(
          `mai-cpp-extract: ${ctx.repoBase}: dropped (engine/system/ambiguous) — includes ${dIncludes}/${ctx.rawIncludes.length}, inherits ${dInherits}/${ctx.rawInherits.length}, calls ${dCalls}/${ctx.rawCalls.length}`
        );
      }
      allNodes.push(...ctx.nodes);
      allEdges.push(...ctx.defines);
    }

    return { nodes: allNodes, edges: allEdges };
  },
};

// ----- Tier 0 helpers -----

function emitFunction(ctx: RepoCtx, defNode: Node, abs: string, line: number, lines: string[], fileRef: NodeRef): void {
  const declarator = unwrapDeclarator(defNode.childForFieldName('declarator')); // function_declarator
  const dn = declName(declarator);
  if (!dn) return;
  // Out-of-line defs carry their scope in the qualified name (dn.scope); inline/
  // free defs get it from ancestors. Prefer dn.scope when present.
  const fullScope = dn.scope || scopeOf(defNode);
  // ensureFunctionNode dedups decl+def by (scope,name,arity) → one node.
  ensureFunctionNode(ctx, fullScope, dn.name, arityOf(declarator), abs, line, reflectionMeta(lines, defNode.startPosition.row, 'func'), fileRef);
}

function emitMethodDecl(ctx: RepoCtx, fieldDecl: Node, abs: string, line: number, lines: string[], fileRef: NodeRef): void {
  const fdecl = unwrapDeclarator(fieldDecl.childForFieldName('declarator')); // function_declarator
  const dn = declName(fdecl);
  if (!dn) return;
  // In-class declaration: scope from ancestors (the enclosing class/namespace).
  // Same (scope,name,arity) as the out-of-line definition → converges to one
  // node via ensureFunctionNode (order-independent, metadata merged).
  ensureFunctionNode(ctx, scopeOf(fieldDecl), dn.name, arityOf(fdecl), abs, line, reflectionMeta(lines, fieldDecl.startPosition.row, 'func'), fileRef);
}

/** UPROPERTY field → the owning class's `properties` metadata list (spec §4.4;
 * v1 creates no field nodes). Non-function fields only — method decls have
 * their own capture. */
function recordProperty(ctx: RepoCtx, fieldDecl: Node, lines: string[]): void {
  const decl = unwrapDeclarator(fieldDecl.childForFieldName('declarator'));
  if (!decl || decl.type === 'function_declarator') return; // method — handled elsewhere
  const meta = reflectionMeta(lines, fieldDecl.startPosition.row, 'func');
  if (meta.reflected !== true) return; // only UPROPERTY-tagged fields
  // First identifier in the declarator subtree (handles pointer/array wraps).
  let name: string | null = null;
  const stack: Node[] = [decl];
  while (stack.length > 0) {
    const cur = stack.pop();
    if (!cur) continue;
    if (cur.type === 'field_identifier' || cur.type === 'identifier') {
      name = cur.text;
      break;
    }
    for (const c of cur.namedChildren) if (c) stack.push(c);
  }
  if (!name) return;
  const classKey = scopeOf(fieldDecl);
  if (!classKey) return; // field outside any class — not a UPROPERTY target
  ctx.classProps.set(classKey, [...(ctx.classProps.get(classKey) ?? []), name]);
}

const REFLECT_RE = /^\s*(UCLASS|USTRUCT|UENUM|UFUNCTION|UPROPERTY)\b(.*)$/;

/** UE reflection tagging (Tier B): the nearest preceding non-blank line decides.
 * Detection is line-local, so the ~6% of UE files where macros produce
 * tree-sitter error nodes still tag correctly (spec §4.4). */
function reflectionMeta(lines: string[], row: number, _kind: 'class' | 'func'): Record<string, unknown> {
  // Scan upward from the declaration's line for the nearest non-blank line.
  for (let i = row - 1; i >= 0 && i >= row - 3; i--) {
    const line = lines[i];
    if (line === undefined) break;
    if (line.trim() === '') continue;
    const m = REFLECT_RE.exec(line);
    if (!m) break; // nearest preceding code line isn't a reflection macro
    const macro = m[1];
    const args = m[2] ?? '';
    if (macro === 'UFUNCTION') {
      return { reflected: true, blueprintCallable: /Blueprint(Callable|Pure)/.test(args) };
    }
    return { reflected: true };
  }
  return {};
}

function recordCall(ctx: RepoCtx, call: Node): void {
  const fn = call.childForFieldName('function');
  if (!fn) return;
  let calleeName: string | null = null;
  if (fn.type === 'identifier') {
    calleeName = fn.text;
  } else if (fn.type === 'field_expression') {
    calleeName = fn.childForFieldName('field')?.text ?? null;
  } else if (fn.type === 'qualified_identifier') {
    let cur: Node | null = fn;
    while (cur && cur.type === 'qualified_identifier') cur = cur.childForFieldName('name');
    calleeName = cur?.text ?? null;
  }
  if (!calleeName) return;
  // Caller = nearest enclosing function_definition's node qn, else the file.
  const callerQn = enclosingFunctionQn(ctx, call) ?? ctx.currentFileQn;
  if (!callerQn) return;
  ctx.rawCalls.push({ callerQn, calleeName });
}

/** Resolve the EXACT enclosing overload via nodeByNodeKey (scope+name+arity),
 * not just the first overload. */
function enclosingFunctionQn(ctx: RepoCtx, n: Node): string | null {
  for (let p = n.parent; p; p = p.parent) {
    if (p.type === 'function_definition') {
      const declarator = unwrapDeclarator(p.childForFieldName('declarator'));
      const dn = declName(declarator);
      if (!dn) return null;
      const scope = dn.scope || scopeOf(p);
      const resolutionKey = [scope, dn.name].filter(Boolean).join('::');
      const nodeKey = `${resolutionKey}/${arityOf(declarator)}`;
      return ctx.nodeByNodeKey.get(nodeKey) ?? null;
    }
  }
  return null;
}

function recordBases(ctx: RepoCtx, bases: Node): void {
  // base_class_clause's enclosing class.
  const cls = bases.parent; // class_specifier / struct_specifier
  if (!cls) return;
  const nameNode = cls.childForFieldName('name');
  if (!nameNode) return;
  const derivedKey = [scopeOf(cls), nameNode.text].filter(Boolean).join('::');
  const derivedQn = `${ctx.repoBase}#${derivedKey}`;
  for (const child of bases.namedChildren) {
    if (!child) continue; // namedChildren is (Node | null)[]
    if (child.type === 'type_identifier') {
      ctx.rawInherits.push({ derivedClassQn: derivedQn, baseName: child.text });
    } else if (child.type === 'qualified_identifier') {
      // Walk the chain to the final identifier; resolve by simple name.
      let cur: Node | null = child;
      while (cur && cur.type === 'qualified_identifier') cur = cur.childForFieldName('name');
      if (cur) ctx.rawInherits.push({ derivedClassQn: derivedQn, baseName: cur.text });
    }
  }
}

function resolveOwnership(ctx: RepoCtx, out: ExtractedEdge[]): void {
  for (const [key, qns] of ctx.symbolTable) {
    const lastSep = key.lastIndexOf('::');
    if (lastSep < 0) continue; // free function, no class owner
    const ownerKey = key.slice(0, lastSep);
    const classQn = ctx.classTable.get(ownerKey);
    if (!classQn) continue; // owner is a namespace, not a class
    for (const qn of qns) {
      out.push({ from: { kind: 'class', qualifiedName: classQn }, to: { kind: 'function', qualifiedName: qn }, relation: 'defines' });
    }
  }
}

/** Returns the number of dropped (external/ambiguous) inherits. */
function resolveInherits(ctx: RepoCtx, out: ExtractedEdge[]): number {
  let dropped = 0;
  for (const inh of ctx.rawInherits) {
    const matches: string[] = [];
    for (const [key, qn] of ctx.classTable) {
      const simple = key.includes('::') ? key.slice(key.lastIndexOf('::') + 2) : key;
      if (simple === inh.baseName) matches.push(qn);
    }
    if (matches.length === 1) {
      out.push({ from: { kind: 'class', qualifiedName: inh.derivedClassQn }, to: { kind: 'class', qualifiedName: matches[0] }, relation: 'inherits' });
    } else {
      dropped++; // 0 (engine base like AActor) or >1 ambiguous — precision-favoring.
    }
  }
  return dropped;
}

/** Returns the number of dropped (external/engine) call sites. */
function resolveCalls(ctx: RepoCtx, out: ExtractedEdge[]): number {
  // Index symbols by simple name for resolution.
  const bySimple = new Map<string, string[]>();
  for (const [key, qns] of ctx.symbolTable) {
    const simple = key.includes('::') ? key.slice(key.lastIndexOf('::') + 2) : key;
    bySimple.set(simple, [...(bySimple.get(simple) ?? []), ...qns]);
  }
  let dropped = 0;
  for (const c of ctx.rawCalls) {
    const candidates = bySimple.get(c.calleeName) ?? [];
    if (candidates.length === 0) {
      dropped++; // external/engine symbol — counted, never invented.
      continue;
    }
    const confidence = candidates.length === 1 ? 'extracted' : 'inferred';
    const fromKind = c.callerQn.includes('#') ? 'function' : 'file';
    for (const target of candidates) {
      if (target === c.callerQn) continue;
      out.push({
        from: { kind: fromKind, qualifiedName: c.callerQn },
        to: { kind: 'function', qualifiedName: target },
        relation: 'calls',
        confidence,
      });
    }
  }
  return dropped;
}

/** Returns the number of dropped (unresolved/ambiguous) includes. */
function resolveIncludes(ctx: RepoCtx, out: ExtractedEdge[]): number {
  let dropped = 0;
  for (const inc of ctx.rawIncludes) {
    if (inc.includePath.endsWith('.generated.h')) continue; // codegen noise
    const matches: string[] = [];
    for (const [rel, qn] of ctx.fileByRelPath) {
      if (rel === inc.includePath || rel.endsWith('/' + inc.includePath)) matches.push(qn);
    }
    if (matches.length === 1 && matches[0] !== inc.fromFileQn) {
      out.push({ from: { kind: 'file', qualifiedName: inc.fromFileQn }, to: { kind: 'file', qualifiedName: matches[0] }, relation: 'imports' });
    } else {
      dropped++; // 0 or >1 matches — precision-favoring per locked decision 5.
    }
  }
  return dropped;
}
