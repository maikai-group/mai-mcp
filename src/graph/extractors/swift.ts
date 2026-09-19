// mai-graph Swift extractor (plan 35) — second consumer of the shared
// two-pass core. Swift has NO source-level namespaces, and a multi-platform
// repo routinely holds the SAME type names in parallel per-platform trees
// (one real consumer: 18 basenames × 3 copies, verified non-identical) — so
// symbols key on a MODULE SEGMENT: the file's SPM target source dir when a
// Package.swift governs it (nearest ancestor Sources/<T> or Tests/<T>), else
// the file's top-level tree directory. The segment is a repo-relative posix
// path, unique by construction, so parallel platform trees can never
// collapse into one false node (spec §4).
// Extensions: same-module extension members converge onto the extended type's
// scope by KEY construction (the dominant real-world idiom — 9 of 11
// extensions in the reference consumer extend a same-module type); an
// extension whose type is not declared in the same module keeps its members
// file-scoped with metadata.extends (external types like Foundation's String
// land here). Ambiguity policy = DROP AND
// TALLY; calls always `inferred`, with a constructor fallback: a bare callee
// that matches no function but exactly one class resolves as a `calls` edge
// to the class node (Swift inits are the cross-file link). Node types
// verified by spike 2026-08-25 (plan 35 header) — never inferred.
import path from 'node:path';
import type { Node } from 'web-tree-sitter';
import type { GraphExtractor, NodeRef } from '../types.js';
import { ensureDecl, makeTwoPassExtractor, type LanguagePass, type RepoAcc } from './core/two-pass.js';

export const SWIFT_EXT = new Set(['.swift']);

interface SwiftFileCtx {
  abs: string;
  qn: string;
  fileRef: NodeRef;
  /** module segment (repo-relative posix path — see header). */
  module: string;
}

type SwiftIntent =
  | { form: 'inherits'; fromQn: string; typeName: string; module: string; line: number }
  | { form: 'calls'; callerRef: NodeRef; callee: string; module: string; line: number };

type Acc = RepoAcc<SwiftFileCtx, SwiftIntent>;

/** Package.swift dirs discovered this pass — set in makeFileCtx via acc scan. */
const PKG_BASENAME = 'Package.swift';

/** Module segment for a repo-relative posix path. pkgDirs = repo-relative
 * posix dirs (''=root) that contain a Package.swift, longest first. */
export function moduleSegOf(relPosix: string, pkgDirs: readonly string[]): string {
  for (const pkgDir of pkgDirs) {
    const prefix = pkgDir === '' ? '' : pkgDir + '/';
    if (!relPosix.startsWith(prefix)) continue;
    const rest = relPosix.slice(prefix.length);
    const m = /^(Sources|Tests)\/([^/]+)\//.exec(rest);
    if (m) return `${prefix}${m[1]}/${m[2]}`;
    return pkgDir === '' ? '(root)' : pkgDir;
  }
  const top = relPosix.split('/')[0];
  return top === undefined || !relPosix.includes('/') ? '(root)' : top;
}

/** class_declaration keyword: class | struct | enum | actor | extension. */
function swiftDeclKind(node: Node): string {
  if (node.namedChildren.some((c) => c !== null && c.type === 'enum_class_body')) return 'enum';
  for (let i = 0; i < node.childCount; i++) {
    const c = node.child(i);
    if (c && !c.isNamed && ['class', 'struct', 'actor', 'extension'].includes(c.type)) return c.type;
  }
  return 'class';
}

/** Nominal ancestors' names (class_declaration/protocol_declaration chain). */
function swiftScope(node: Node): { path: string[]; extensionTarget: string | null } {
  const parts: string[] = [];
  let extensionTarget: string | null = null;
  for (let p = node.parent; p; p = p.parent) {
    if (p.type === 'class_declaration' || p.type === 'protocol_declaration') {
      const nameNode = p.childForFieldName('name');
      if (!nameNode) continue;
      if (nameNode.type === 'user_type') {
        // extension Foo — members belong to Foo's scope (same-module key
        // construction; header note). Qualified extensions take the last segment.
        const seg = nameNode.text.split('.').pop() ?? nameNode.text;
        parts.unshift(seg);
        extensionTarget = seg;
      } else {
        parts.unshift(nameNode.text);
      }
    }
  }
  return { path: parts, extensionTarget };
}

/** attribute names on a declaration's modifiers (@main, property wrappers). */
function swiftAttributes(node: Node): string[] {
  const out: string[] = [];
  const mods = node.namedChildren.find((c) => c !== null && c.type === 'modifiers');
  if (!mods) return out;
  for (const m of mods.namedChildren) {
    if (m && m.type === 'attribute') {
      const ut = m.namedChildren.find((c) => c !== null && c.type === 'user_type');
      if (ut) out.push(ut.text);
    }
  }
  return out;
}

function swiftArity(fn: Node): number {
  return fn.namedChildren.filter((c): c is Node => c !== null && c.type === 'parameter').length;
}

function enclosingFunctionQn(acc: Acc, file: SwiftFileCtx, node: Node): string | null {
  for (let p = node.parent; p; p = p.parent) {
    if (p.type === 'function_declaration') {
      const nameNode = p.childForFieldName('name');
      if (!nameNode) return null;
      const { path: scopeParts } = swiftScope(p);
      const key = scopeParts.length === 0
        ? `${file.module}#${nameNode.text}`
        : `${file.module}#${scopeParts.join('.')}::${nameNode.text}`;
      return acc.index.byIdentity.get(`function:${key}/${swiftArity(p)}`) ?? null;
    }
    // Initializer bodies own their calls — mirror the init handler's identity
    // exactly (pass-3 finding: this branch was missing, calls fell through to
    // the file).
    if (p.type === 'init_declaration') {
      const { path: scopeParts } = swiftScope(p);
      if (scopeParts.length === 0) return null;
      const key = `${file.module}#${scopeParts.join('.')}::init`;
      return acc.index.byIdentity.get(`function:${key}/${swiftArity(p)}`) ?? null;
    }
  }
  return null;
}

const pass: LanguagePass<SwiftFileCtx, SwiftIntent> = {
  name: 'swift',
  lang: 'swift',
  grammar: 'swift',
  extensions: SWIFT_EXT,
  splice: 'refuse', // A6: a changed file cannot see its unchanged Package.swift — splice would derive WRONG module segments
  // Spec excludes on BOTH enumeration paths (tracked .build/ trees exist in
  // the wild; git ls-files ignores walk.ts SKIP_DIRS).
  exclude: /(^|\/)(\.build|\.swiftpm|DerivedData|build|Preview Content)\/|\.xcassets\//,
  vocabulary: {
    // NO 'imports' relation: swift import statements name SDK modules, not
    // in-repo files, so the extractor never emits one — declaring it would be
    // a vocabulary lie (pass-1 finding). Kotlin differs deliberately: its
    // imports name in-repo FQNs and resolve to defining files.
    kinds: ['file', 'function', 'class'],
    relations: ['defines', 'calls', 'inherits'],
  },
  querySource: [
    '(class_declaration) @decl',
    '(protocol_declaration name: (type_identifier) @proto.name) @proto',
    '(function_declaration) @fn',
    '(init_declaration) @init',
    '(call_expression) @call',
  ].join(' '),
  tallyKeys: ['unresolved_inherits', 'ambiguous_inherits', 'unresolved_calls', 'ambiguous_calls', 'external_extensions', 'package_manifests'],

  preEnumerate(acc, relPaths): void {
    // Seed EVERY Package.swift dir before any file parses — module identity
    // must never depend on traversal order (pass-5 finding: with a ROOT
    // Package.swift, files sorting before the manifest took per-dir fallback
    // segments while later files took the governed branch, splitting one
    // logical module by the alphabet).
    const pkgDirs = pkgDirsOf(acc);
    for (const rel of relPaths) {
      if (path.basename(rel) !== PKG_BASENAME) continue;
      const dir = rel.includes('/') ? rel.slice(0, rel.lastIndexOf('/')) : '';
      if (!pkgDirs.includes(dir)) pkgDirs.push(dir);
    }
    pkgDirs.sort((a, b) => b.length - a.length);
  },

  makeFileCtx(root, abs, relPosix, fileRef, acc): SwiftFileCtx {
    // pkgDirs are fully seeded by preEnumerate; the manifest tally below
    // still records each Package.swift as it flows through the loop.
    const pkgDirs = pkgDirsOf(acc);
    if (path.basename(relPosix) === PKG_BASENAME) {
      const dir = relPosix.includes('/') ? relPosix.slice(0, relPosix.lastIndexOf('/')) : '';
      if (!pkgDirs.includes(dir)) {
        pkgDirs.push(dir);
        pkgDirs.sort((a, b) => b.length - a.length);
      }
      acc.tally.package_manifests = (acc.tally.package_manifests ?? 0) + 1;
    }
    return { abs, qn: fileRef.qualifiedName, fileRef, module: moduleSegOf(relPosix, pkgDirs) };
  },

  handleCapture(acc, file, captureName, node): void {
    // Package.swift is a module manifest, not module code.
    if (path.basename(file.abs) === PKG_BASENAME) return;
    const line = node.startPosition.row + 1;
    switch (captureName) {
      case 'decl': {
        const declKind = swiftDeclKind(node);
        const nameNode = node.childForFieldName('name');
        if (!nameNode) break;
        if (declKind === 'extension') {
          // The extension itself is not a node. Its members were/will be keyed
          // into the extended type's scope by swiftScope; whether that type
          // exists in this module is only knowable after pass 1, so external
          // extensions are detected and tallied in finalize, not here.
          const seg = nameNode.text.split('.').pop() ?? nameNode.text;
          // Conformances added by the extension still queue.
          for (const child of node.namedChildren) {
            if (!child || child.type !== 'inheritance_specifier') continue;
            const ut = child.childForFieldName('inherits_from');
            if (ut) {
              acc.intents.push({
                form: 'inherits',
                fromQn: `${acc.repoBase}#${file.module}#${seg}`,
                typeName: ut.text.split('.').pop() ?? ut.text,
                module: file.module, line,
              });
            }
          }
          break;
        }
        const { path: scopeParts } = swiftScope(node);
        const key = `${file.module}#${[...scopeParts, nameNode.text].join('.')}`;
        const attrs = swiftAttributes(node);
        const meta: Record<string, unknown> = { declKind };
        if (attrs.includes('main')) meta.entrypoint = 'main';
        // Property wrappers used inside the body → metadata.wrappers.
        const body = node.namedChildren.find((c) => c !== null && (c.type === 'class_body' || c.type === 'enum_class_body'));
        if (body) {
          const wrappers = new Set<string>();
          for (const memberRaw of body.namedChildren) {
            if (!memberRaw || memberRaw.type !== 'property_declaration') continue;
            for (const a of swiftAttributes(memberRaw)) wrappers.add(a);
          }
          if (wrappers.size > 0) meta.wrappers = [...wrappers].sort();
        }
        const qn = ensureDecl(acc, 'swift', {
          kind: 'class', resolutionKey: key, name: nameNode.text,
          abs: file.abs, line, meta, fileRef: file.fileRef,
        });
        for (const child of node.namedChildren) {
          if (!child || child.type !== 'inheritance_specifier') continue;
          const ut = child.childForFieldName('inherits_from');
          if (ut) {
            acc.intents.push({
              form: 'inherits', fromQn: qn,
              typeName: ut.text.split('.').pop() ?? ut.text,
              module: file.module, line,
            });
          }
        }
        break;
      }
      case 'proto': {
        // protocol_declaration — captured via @proto with @proto.name riding along.
        const nameNode = node.childForFieldName('name');
        if (!nameNode) break;
        const key = `${file.module}#${nameNode.text}`;
        const protoQn = ensureDecl(acc, 'swift', {
          kind: 'class', resolutionKey: key, name: nameNode.text,
          abs: file.abs, line, meta: { declKind: 'protocol' }, fileRef: file.fileRef,
        });
        // Protocol INHERITANCE (`protocol Child: Parent`) — the same direct
        // inheritance_specifier children as class_declaration (probe, pass-2
        // repair: this branch was missing entirely).
        for (const child of node.namedChildren) {
          if (!child || child.type !== 'inheritance_specifier') continue;
          const ut = child.childForFieldName('inherits_from');
          if (ut) {
            acc.intents.push({
              form: 'inherits', fromQn: protoQn,
              typeName: ut.text.split('.').pop() ?? ut.text,
              module: file.module, line,
            });
          }
        }
        // Protocol REQUIREMENTS (protocol_function_declaration) are pure
        // signatures — no function nodes (precision rule). Deliberate
        // asymmetry with kotlin: Kotlin interface methods routinely carry
        // default bodies, so kotlin emits them; Swift protocol requirements
        // cannot, so swift does not (pass-1 note, documented boundary).
        break;
      }
      case 'init': {
        // Initializers are function nodes named `init` (spec §4: "funcs/
        // methods/initializers"), keyed Type::init, arity-disambiguated —
        // init_declaration has direct `parameter` children and no name field
        // (probe, pass-2 repair).
        const { path: scopeParts, extensionTarget } = swiftScope(node);
        if (scopeParts.length === 0) break; // grammar puts inits only in type bodies
        const key = `${file.module}#${scopeParts.join('.')}::init`;
        const meta: Record<string, unknown> = { initializer: true };
        // Inits declared inside `extension X { init(...) }` ride the SAME
        // finalize convergence ladder as extension methods.
        if (extensionTarget !== null) meta.viaExtension = true;
        ensureDecl(acc, 'swift', {
          kind: 'function', resolutionKey: key, disambiguator: String(swiftArity(node)),
          name: 'init', abs: file.abs, line, meta,
          fileRef: file.fileRef,
          ownerRef: { kind: 'class', qualifiedName: `${acc.repoBase}#${file.module}#${scopeParts.join('.')}` },
        });
        break;
      }
      case 'fn': {
        const nameNode = node.childForFieldName('name');
        if (!nameNode || nameNode.type !== 'simple_identifier') break;
        const { path: scopeParts, extensionTarget } = swiftScope(node);
        const inType = scopeParts.length > 0;
        const key = inType
          ? `${file.module}#${scopeParts.join('.')}::${nameNode.text}`
          : `${file.module}#${nameNode.text}`;
        const meta: Record<string, unknown> = {};
        if (extensionTarget !== null) meta.viaExtension = true;
        const ownerRef: NodeRef | undefined = inType
          ? { kind: 'class', qualifiedName: `${acc.repoBase}#${file.module}#${scopeParts.join('.')}` }
          : undefined;
        ensureDecl(acc, 'swift', {
          kind: 'function', resolutionKey: key, disambiguator: String(swiftArity(node)),
          name: nameNode.text, abs: file.abs, line, meta, fileRef: file.fileRef, ownerRef,
        });
        break;
      }
      case 'call': {
        const first = node.namedChild(0);
        if (!first) break;
        let callee: string | null = null;
        if (first.type === 'simple_identifier') {
          callee = first.text;
        } else if (first.type === 'navigation_expression') {
          // Last navigation_suffix's simple_identifier (spike shape).
          let lastSuffix: Node | null = null;
          const stack: Node[] = [first];
          while (stack.length > 0) {
            const n = stack.pop();
            if (!n) continue;
            if (n.type === 'navigation_suffix') {
              const id = n.namedChildren.find((c) => c !== null && c.type === 'simple_identifier');
              if (id && (!lastSuffix || id.startIndex > lastSuffix.startIndex)) lastSuffix = id;
            }
            for (const c of n.namedChildren) if (c) stack.push(c);
          }
          callee = lastSuffix ? lastSuffix.text : null;
        }
        if (!callee) break;
        const callerQn = enclosingFunctionQn(acc, file, node);
        const callerRef: NodeRef = callerQn
          ? { kind: 'function', qualifiedName: callerQn }
          : file.fileRef;
        acc.intents.push({ form: 'calls', callerRef, callee, module: file.module, line });
        break;
      }
      default:
        break; // proto.name rides along with @proto
    }
  },

  finalize(acc): void {
    // main.swift = top-level-code entrypoint (python __main__ precedent).
    for (const n of acc.nodes) {
      if (n.kind === 'file' && n.name === 'main.swift') {
        n.metadata = { ...(n.metadata ?? {}), entrypoint: 'main' };
      }
    }
    // Extension convergence ladder, spec §4: same-module (already converged
    // by KEY construction in pass 1) → UNIQUE-IN-REPO (re-key onto the one
    // matching type — pass-2 repair: this rung was missing) → external
    // (metadata.extends + file-owned defines fallback).
    for (const n of acc.nodes) {
      if (n.kind !== 'function' || n.metadata?.viaExtension !== true) continue;
      // The SEMANTIC resolution key is the functionsByKey entry whose
      // overload list contains this node — NEVER parsed from the qn: a qn's
      // /N suffix is insertion-order ALLOCATION, not semantics, and parsing
      // it leaked the suffix into the key so a second extension overload was
      // externalized (pass-8 finding, the same family one rung deeper).
      let semanticOldKey: string | undefined;
      for (const [k, qns] of acc.index.functionsByKey) {
        if (qns.includes(n.qualifiedName)) {
          semanticOldKey = k;
          break;
        }
      }
      if (semanticOldKey === undefined) continue;
      const typeKey = semanticOldKey.includes('::') ? semanticOldKey.slice(0, semanticOldKey.lastIndexOf('::')) : null;
      if (typeKey === null || acc.index.classesByKey.has(typeKey)) continue; // same-module: already right
      const member = semanticOldKey.slice(semanticOldKey.lastIndexOf('::') + 2);
      const typeName = typeKey.split('#').pop() ?? typeKey;
      const candidates = acc.index.classesByShort.get(typeName) ?? [];
      const uniqueTargetKey = candidates.length === 1 ? candidates[0] : undefined;
      const uniqueTargetQn = uniqueTargetKey !== undefined ? acc.index.classesByKey.get(uniqueTargetKey) : undefined;
      // Duplicates are decided on SEMANTIC IDENTITY (resolution key + arity
      // disambiguator), never on qn occupancy — the target may legitimately
      // hold OTHER overloads of the same name, and the extension member then
      // joins its overload list with ensureDecl's exact base-or-/N rule
      // (pass-7 finding: qn-occupancy rejection externalized a valid
      // different-arity extension overload). Only an already-present
      // IDENTICAL identity (invalid Swift redeclaration) falls through to
      // the external branch.
      let oldIdentity: string | undefined;
      for (const [ident, qn] of acc.index.byIdentity) {
        if (qn === n.qualifiedName) {
          oldIdentity = ident;
          break;
        }
      }
      const oldKey = semanticOldKey;
      const newKey = uniqueTargetKey !== undefined ? `${uniqueTargetKey}::${member}` : undefined;
      const newIdentity = oldIdentity !== undefined && newKey !== undefined ? oldIdentity.replace(oldKey, newKey) : undefined;
      if (
        uniqueTargetKey !== undefined && uniqueTargetQn !== undefined &&
        newKey !== undefined && oldIdentity !== undefined && newIdentity !== undefined &&
        !acc.index.byIdentity.has(newIdentity)
      ) {
        // Unique in repo: re-key the member onto the real type — node qn,
        // identity/index entries, and the ownership edge all move together
        // (a re-keyed qn with stale indexes would corrupt call resolution).
        const targetKey = uniqueTargetKey;
        const targetQn = uniqueTargetQn;
        const oldQn = n.qualifiedName;
        const targetOverloads = acc.index.functionsByKey.get(newKey) ?? [];
        const newQn = targetOverloads.length === 0
          ? `${acc.repoBase}#${newKey}`
          : `${acc.repoBase}#${newKey}/${targetOverloads.length}`;
        n.qualifiedName = newQn;
        acc.index.byIdentity.delete(oldIdentity);
        acc.index.byIdentity.set(newIdentity, newQn);
        // APPEND to the target's overload list — never overwrite it.
        acc.index.functionsByKey.set(newKey, [...targetOverloads, newQn]);
        const oldList = acc.index.functionsByKey.get(oldKey);
        if (oldList !== undefined) {
          const remaining = oldList.filter((q) => q !== oldQn);
          if (remaining.length === 0) acc.index.functionsByKey.delete(oldKey);
          else acc.index.functionsByKey.set(oldKey, remaining);
        }
        for (const [short, qns] of acc.index.functionsByShort) {
          acc.index.functionsByShort.set(short, qns.map((q) => (q === oldQn ? newQn : q)));
        }
        const fq = acc.index.declFileQn.get(oldQn);
        if (fq !== undefined) {
          acc.index.declFileQn.delete(oldQn);
          acc.index.declFileQn.set(newQn, fq);
        }
        acc.index.emitted.delete(oldQn);
        acc.index.emitted.add(newQn);
        const oldOwner = `${acc.repoBase}#${typeKey}`; // pass-1 ownerRef — a class that does not exist
        for (const e of acc.edges) {
          if (e.to.qualifiedName === oldQn) e.to = { ...e.to, qualifiedName: newQn };
          if (e.from.qualifiedName === oldQn) e.from = { ...e.from, qualifiedName: newQn };
          if (e.relation === 'defines' && e.from.qualifiedName === oldOwner && e.to.qualifiedName === newQn) {
            e.from = { kind: 'class', qualifiedName: targetQn }; // repoint onto the real owner
          }
        }
        // QUEUED INTENTS move too (pass-3/4 finding — finalize runs BEFORE
        // resolveIntents, so an unmoved intent resolves against the dead qn):
        // conformances the extension declared come from the synthetic type,
        // calls inside its members come from the member's old qn.
        for (const intent of acc.intents) {
          if (intent.form === 'inherits' && intent.fromQn === oldOwner) intent.fromQn = targetQn;
          if (intent.form === 'calls' && intent.callerRef.qualifiedName === oldQn) {
            intent.callerRef = { kind: 'function', qualifiedName: newQn };
          }
        }
        continue;
      }
      // External (or ambiguous — drop-and-tally): metadata.extends + a
      // file-owned defines edge, because the pass-1 ownerRef edge targets a
      // class node that does not exist and will drop at the engine's
      // endpoint resolver (engine.ts:190).
      n.metadata = { ...n.metadata, extends: typeName };
      acc.tally.external_extensions = (acc.tally.external_extensions ?? 0) + 1;
      const fileQn = acc.index.declFileQn.get(n.qualifiedName);
      if (fileQn !== undefined) {
        acc.edges.push({
          from: { kind: 'file', qualifiedName: fileQn },
          to: { kind: 'function', qualifiedName: n.qualifiedName },
          relation: 'defines',
        });
      }
    }
    // CONFORMANCE-ONLY (or property-only) extensions produce NO member
    // function nodes, so the per-member re-key above never reaches them —
    // ladder their queued conformance intents directly: unique-in-repo →
    // rewrite the source onto the real type; still-unemitted sources fall
    // to resolveIntents' guard and are tallied (pass-5/6 converged finding:
    // `extension Mode: Discovering {}` lost its inherits edge silently).
    for (const intent of acc.intents) {
      if (intent.form !== 'inherits' || acc.index.emitted.has(intent.fromQn)) continue;
      const key = intent.fromQn.slice(acc.repoBase.length + 1);
      const typeName = key.split('#').pop() ?? key;
      const candidates = acc.index.classesByShort.get(typeName) ?? [];
      if (candidates.length === 1 && candidates[0] !== undefined) {
        const qn = acc.index.classesByKey.get(candidates[0]);
        if (qn !== undefined) intent.fromQn = qn;
      }
    }
  },

  resolveIntents(acc): void {
    for (const intent of acc.intents) {
      if (intent.form === 'inherits') {
        // A conformance whose SOURCE never became a node (an extension of an
        // external type, e.g. `extension String: Codable`) cannot emit — the
        // engine would drop the edge silently; count it instead (pass-3
        // finding: unique-repo sources are re-keyed in finalize, external
        // sources land here).
        if (!acc.index.emitted.has(intent.fromQn)) {
          acc.tally.unresolved_inherits = (acc.tally.unresolved_inherits ?? 0) + 1;
          continue;
        }
        // Same-module exact → extracted; unique-in-repo short → inferred; else drop.
        const sameModule = `${intent.module}#${intent.typeName}`;
        let toQn: string | undefined;
        let confidence: 'extracted' | 'inferred' = 'extracted';
        if (acc.index.classesByKey.has(sameModule)) {
          toQn = acc.index.classesByKey.get(sameModule);
        } else {
          const candidates = acc.index.classesByShort.get(intent.typeName) ?? [];
          if (candidates.length === 1 && candidates[0] !== undefined) {
            toQn = acc.index.classesByKey.get(candidates[0]);
            confidence = 'inferred';
          } else if (candidates.length > 1) {
            acc.tally.ambiguous_inherits = (acc.tally.ambiguous_inherits ?? 0) + 1;
          } else {
            acc.tally.unresolved_inherits = (acc.tally.unresolved_inherits ?? 0) + 1; // NSObject, Codable, …
          }
        }
        if (toQn !== undefined && toQn !== intent.fromQn) {
          acc.edges.push({
            from: { kind: 'class', qualifiedName: intent.fromQn },
            to: { kind: 'class', qualifiedName: toQn },
            relation: 'inherits', confidence, metadata: { line: intent.line },
          });
        }
        continue;
      }
      // calls: functions first (same-module exact key beats short-name), then
      // the constructor fallback to a unique class. Always `inferred` — a
      // simple-name match is an inference by construction.
      const sameModuleFns = acc.index.functionsByKey.get(`${intent.module}#${intent.callee}`) ?? [];
      let emitted = false;
      const emitCall = (target: string, kind: 'function' | 'class'): void => {
        // SELF-call (recursion): deliberately neither edged (no-self-edges
        // invariant) nor tallied (recursion carries no cross-file information).
        if (target === intent.callerRef.qualifiedName) return;
        acc.edges.push({
          from: intent.callerRef, to: { kind, qualifiedName: target },
          relation: 'calls', confidence: 'inferred', metadata: { line: intent.line },
        });
        emitted = true;
      };
      if (sameModuleFns.length === 1 && sameModuleFns[0] !== undefined) {
        emitCall(sameModuleFns[0], 'function');
      } else if (sameModuleFns.length > 1) {
        // Multi-overload key: the call site's callee name cannot pick an
        // overload — drop-and-tally (spec ambiguity policy; pass-6 finding:
        // picking sameModuleFns[0] invented a resolution).
        acc.tally.ambiguous_calls = (acc.tally.ambiguous_calls ?? 0) + 1;
      } else {
        const fnCandidates = acc.index.functionsByShort.get(intent.callee) ?? [];
        if (fnCandidates.length === 1 && fnCandidates[0] !== undefined) {
          emitCall(fnCandidates[0], 'function');
        } else if (fnCandidates.length > 1) {
          acc.tally.ambiguous_calls = (acc.tally.ambiguous_calls ?? 0) + 1;
        } else {
          // constructor fallback: TypeName() — same-module exact, else unique short.
          const sameModuleCls = acc.index.classesByKey.get(`${intent.module}#${intent.callee}`);
          if (sameModuleCls !== undefined) {
            emitCall(sameModuleCls, 'class');
          } else {
            const clsCandidates = acc.index.classesByShort.get(intent.callee) ?? [];
            if (clsCandidates.length === 1 && clsCandidates[0] !== undefined) {
              const qn = acc.index.classesByKey.get(clsCandidates[0]);
              if (qn !== undefined) emitCall(qn, 'class');
            } else if (clsCandidates.length > 1) {
              acc.tally.ambiguous_calls = (acc.tally.ambiguous_calls ?? 0) + 1;
            }
          }
        }
      }
      if (!emitted && (acc.index.functionsByShort.get(intent.callee) ?? []).length === 0 && (acc.index.classesByShort.get(intent.callee) ?? []).length === 0) {
        acc.tally.unresolved_calls = (acc.tally.unresolved_calls ?? 0) + 1; // SDK symbol — counted, never invented
      }
    }
  },

  report(acc): string {
    return (
      `swift-tally ${acc.repoBase} unresolved_calls=${acc.tally.unresolved_calls ?? 0} ` +
      `ambiguous_calls=${acc.tally.ambiguous_calls ?? 0} ` +
      `unresolved_inherits=${acc.tally.unresolved_inherits ?? 0} ` +
      `ambiguous_inherits=${acc.tally.ambiguous_inherits ?? 0} ` +
      `external_extensions=${acc.tally.external_extensions ?? 0} ` +
      `package_manifests=${acc.tally.package_manifests ?? 0}`
    );
  },
};

/** Per-repo Package.swift dir cache, stored on the acc via a WeakMap so the
 * pass object stays stateless across repos/runs. */
const pkgDirsCache = new WeakMap<object, string[]>();
function pkgDirsOf(acc: Acc): string[] {
  let dirs = pkgDirsCache.get(acc);
  if (!dirs) {
    dirs = [];
    pkgDirsCache.set(acc, dirs);
  }
  return dirs;
}

export const swiftExtractor: GraphExtractor = makeTwoPassExtractor(pass);
