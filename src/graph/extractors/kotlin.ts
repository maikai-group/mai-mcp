// mai-graph Kotlin extractor (plan 35) — first consumer of the shared
// two-pass core. Package-scoped declarations (php-namespace precedent:
// kotlin classes/functions are callable across files, so file-scoped qns
// would silently drop every cross-file edge); resolution ladder
// import-FQN → same-package → unique-short (php resolveClassName shape);
// ambiguity policy = DROP AND TALLY (php precedent — kotlin has real
// packages, so short-name fan-out would be noise). Calls always `inferred`
// (they resolve by simple name — an inference by construction; python
// precedent). `.kts` is STRUCTURE-ONLY (spec amendment 2026-08-25):
// never code-extracted; settings.gradle.kts is read in finalize for the
// Gradle module list. AndroidManifest components resolve against the Gradle
// `namespace`, NEVER applicationId — every real Android consumer checked has
// the two differ, and resolving against applicationId silently misses all
// relative component names. Node types verified by spike 2026-08-25 (plan 35
// header) — never inferred.
import fs from 'node:fs';
import path from 'node:path';
import type { Node } from 'web-tree-sitter';
import { owningRegisteredRepo } from '../contracts.js';
import { canonicalPhysicalPath } from '../roots.js';
import type { GraphExtractor, NodeRef } from '../types.js';
import { ensureDecl, makeTwoPassExtractor, mergeMeta, type LanguagePass, type RepoAcc } from './core/two-pass.js';

export const KT_EXT = new Set(['.kt']);

interface KtFileCtx {
  abs: string;
  qn: string;
  fileRef: NodeRef;
  /** package_header text, '' at default package. */
  pkg: string;
  /** import short/alias → dotted FQN. */
  imports: Map<string, string>;
}

type KtIntent =
  | { form: 'inherits'; fromQn: string; typeName: string; file: KtFileCtx; line: number }
  | { form: 'calls'; callerRef: NodeRef; callee: string; line: number }
  | { form: 'imports'; fileRef: NodeRef; fqn: string; line: number };

type Acc = RepoAcc<KtFileCtx, KtIntent>;

/** `import a.b.C` / `import a.b.C as D` — read from source text: the alias
 * shape was not probed, and a regex over the import node's own text is
 * shape-independent and exact. */
const IMPORT_RE = /^import\s+([\w.]+)(?:\s+as\s+(\w+))?/;

/** Dotted scope from package + class/object ancestors. */
function ktScope(node: Node, pkg: string): string {
  const parts: string[] = [];
  for (let p = node.parent; p; p = p.parent) {
    if (p.type === 'class_declaration' || p.type === 'object_declaration') {
      const name = p.childForFieldName('name')?.text;
      if (name) parts.unshift(name);
    }
    // companion_object members belong to the enclosing class — it has no name
    // of its own and contributes nothing to the scope path.
  }
  if (pkg !== '') parts.unshift(pkg);
  return parts.join('.');
}

/** declKind: enum body wins; `annotation` lives in modifiers (probe — the
 * keyword scan alone reports plain 'class'); else the unnamed keyword token
 * distinguishes interface from class. */
function ktDeclKind(node: Node): string {
  if (node.namedChildren.some((c) => c !== null && c.type === 'enum_class_body')) return 'enum';
  if (ktModifiers(node).includes('annotation')) return 'annotation';
  for (let i = 0; i < node.childCount; i++) {
    const c = node.child(i);
    if (c && !c.isNamed && (c.type === 'interface' || c.type === 'class')) {
      return c.type === 'interface' ? 'interface' : 'class';
    }
  }
  return 'class';
}

/** Parameter count: function_value_parameters > parameter for functions and
 * secondary constructors, class_parameters > class_parameter for primary
 * constructors (probe 2026-08-25). The overload disambiguator. */
function ktArity(node: Node): number {
  const params = node.namedChildren.find(
    (c): c is Node => c !== null && (c.type === 'function_value_parameters' || c.type === 'class_parameters')
  );
  if (!params) return 0;
  return params.namedChildren.filter(
    (c): c is Node => c !== null && (c.type === 'parameter' || c.type === 'class_parameter')
  ).length;
}

/** Simple name of the nearest enclosing class/object declaration. */
function ktEnclosingClassName(node: Node): string | null {
  for (let p = node.parent; p; p = p.parent) {
    if (p.type === 'class_declaration' || p.type === 'object_declaration') {
      return p.childForFieldName('name')?.text ?? null;
    }
  }
  return null;
}

/** class_modifier keyword texts (data/sealed/annotation/…) on a declaration. */
function ktModifiers(node: Node): string[] {
  const out: string[] = [];
  const mods = node.namedChildren.find((c) => c !== null && c.type === 'modifiers');
  if (!mods) return out;
  for (const m of mods.namedChildren) {
    if (m && m.type === 'class_modifier') out.push(m.text);
  }
  return out;
}

/** annotation names (`@Composable` → 'Composable') on a declaration. */
function ktAnnotations(node: Node): string[] {
  const out: string[] = [];
  const mods = node.namedChildren.find((c) => c !== null && c.type === 'modifiers');
  if (!mods) return out;
  for (const m of mods.namedChildren) {
    if (m && m.type === 'annotation') {
      const ut = m.namedChildren.find((c) => c !== null && c.type === 'user_type');
      if (ut) out.push(ut.text);
    }
  }
  return out;
}

/** Simple type name from a user_type (last identifier of a dotted chain). */
function userTypeSimple(ut: Node): string {
  const ids = ut.namedChildren.filter((c): c is Node => c !== null && c.type === 'identifier');
  const last = ids[ids.length - 1];
  return last ? last.text : ut.text;
}

/** Nearest enclosing named function's node qn via the identity index, else null. */
function enclosingFunctionQn(acc: Acc, file: KtFileCtx, node: Node): string | null {
  for (let p = node.parent; p; p = p.parent) {
    if (p.type === 'function_declaration') {
      const name = p.childForFieldName('name')?.text;
      if (!name) return null;
      const scope = ktScope(p, file.pkg);
      const receiver = ktReceiver(p);
      const key = scope === '' ? name : ktIsTypeScope(p) ? `${scope}::${name}` : `${scope}.${name}`;
      // Disambiguator format must mirror the fn handler EXACTLY: receiver/arity.
      return acc.index.byIdentity.get(`function:${key}/${receiver ?? ''}/${ktArity(p)}`) ?? null;
    }
    // Constructor bodies (and primary-ctor default-value expressions) own
    // their calls too — mirror the ctor handler's identity exactly (pass-3
    // finding: this branch was missing, calls fell through to the file).
    if (p.type === 'secondary_constructor' || p.type === 'primary_constructor') {
      const clsName = ktEnclosingClassName(p);
      if (clsName === null) return null;
      const scope = ktScope(p, file.pkg);
      return acc.index.byIdentity.get(`function:${scope}::${clsName}/ctor/${ktArity(p)}`) ?? null;
    }
  }
  return null;
}

/** True when the function's nearest declaration ancestor is a class/object
 * (member → '::' separator) rather than the file (top-level → '.'). */
function ktIsTypeScope(fn: Node): boolean {
  for (let p = fn.parent; p; p = p.parent) {
    if (p.type === 'class_declaration' || p.type === 'object_declaration') return true;
  }
  return false;
}

/** Extension receiver: a user_type named child positioned BEFORE the name
 * field (spike: `fun String.slugify()` → function_declaration (user_type)
 * name: (identifier)). Return-type user_types sit AFTER the name. */
function ktReceiver(fn: Node): string | null {
  const nameNode = fn.childForFieldName('name');
  if (!nameNode) return null;
  const ut = fn.namedChildren.find(
    (c): c is Node => c !== null && c.type === 'user_type' && c.startIndex < nameNode.startIndex
  );
  return ut ? userTypeSimple(ut) : null;
}

const pass: LanguagePass<KtFileCtx, KtIntent> = {
  name: 'kotlin',
  lang: 'kotlin',
  grammar: 'kotlin',
  extensions: KT_EXT,
  splice: 'refuse', // A6: full-build-only — structure files are invisible to a partial parse
  // Spec excludes on BOTH enumeration paths (git ls-files ignores SKIP_DIRS).
  exclude: /(^|\/)(build|\.gradle|\.kotlin)\//,
  // Generated-marker files (spec §3): `// @generated` headers and Expo
  // prebuild sync markers. Fleet is codegen-free; this is the contract, not
  // an active need.
  isGeneratedText: (text) => /^\s*\/\/\s*@generated\b/.test(text) || text.includes('@expo prebuild'),
  vocabulary: {
    kinds: ['file', 'function', 'class', 'module'],
    relations: ['imports', 'defines', 'calls', 'inherits', 'depends_on'],
  },
  querySource: [
    '(class_declaration name: (identifier) @class.name) @class',
    '(object_declaration name: (identifier) @object.name) @object',
    '(function_declaration name: (identifier) @fn.name) @fn',
    '(primary_constructor) @ctor.primary',
    '(secondary_constructor) @ctor.secondary',
    '(import) @import',
    '(call_expression) @call',
  ].join(' '),
  tallyKeys: ['unresolved_inherits', 'ambiguous_inherits', 'unresolved_calls', 'ambiguous_calls', 'unresolved_imports', 'dynamic_modules', 'extra_gradle_roots', 'generated_skipped'],

  makeFileCtx(root, abs, relPosix, fileRef): KtFileCtx {
    let pkg = '';
    const imports = new Map<string, string>();
    for (const child of root.namedChildren) {
      if (!child) continue;
      if (child.type === 'package_header') {
        const qi = child.namedChildren.find((c) => c !== null && c.type === 'qualified_identifier');
        if (qi) pkg = qi.text;
      } else if (child.type === 'import') {
        const m = IMPORT_RE.exec(child.text);
        if (m && m[1]) {
          const fqn = m[1];
          const short = m[2] ?? (fqn.split('.').pop() ?? fqn);
          imports.set(short, fqn);
        }
      }
    }
    return { abs, qn: fileRef.qualifiedName, fileRef, pkg, imports };
  },

  handleCapture(acc, file, captureName, node): void {
    const line = node.startPosition.row + 1;
    switch (captureName) {
      case 'class':
      case 'object': {
        const nameNode = node.childForFieldName('name');
        if (!nameNode) break;
        const scope = ktScope(node, file.pkg);
        const key = scope === '' ? nameNode.text : `${scope}.${nameNode.text}`;
        const declKind = captureName === 'object' ? 'object' : ktDeclKind(node);
        const mods = ktModifiers(node);
        const meta: Record<string, unknown> = { declKind };
        if (mods.length > 0) meta.modifiers = mods;
        const qn = ensureDecl(acc, 'kotlin', {
          kind: 'class', resolutionKey: key, name: nameNode.text,
          abs: file.abs, line, meta, fileRef: file.fileRef,
        });
        // extends/implements → deferred inherits (delegation_specifiers).
        for (const child of node.namedChildren) {
          if (!child || child.type !== 'delegation_specifiers') continue;
          for (const spec of child.namedChildren) {
            if (!spec || spec.type !== 'delegation_specifier') continue;
            const ci = spec.namedChildren.find((c) => c !== null && c.type === 'constructor_invocation');
            const ut = (ci ?? spec).namedChildren.find((c) => c !== null && c.type === 'user_type');
            if (ut) acc.intents.push({ form: 'inherits', fromQn: qn, typeName: userTypeSimple(ut), file, line });
          }
        }
        break;
      }
      case 'fn': {
        const nameNode = node.childForFieldName('name');
        if (!nameNode) break;
        const scope = ktScope(node, file.pkg);
        const receiver = ktReceiver(node);
        const inType = ktIsTypeScope(node);
        const key = scope === '' ? nameNode.text : inType ? `${scope}::${nameNode.text}` : `${scope}.${nameNode.text}`;
        const annos = ktAnnotations(node);
        const meta: Record<string, unknown> = {};
        if (annos.includes('Composable')) meta.composable = true;
        if (receiver !== null) meta.receiver = receiver; // NO edge to the receiver in v1 (spec §3)
        const ownerRef: NodeRef | undefined = inType
          ? { kind: 'class', qualifiedName: `${acc.repoBase}#${scope}` }
          : undefined;
        ensureDecl(acc, 'kotlin', {
          // receiver + arity: ordinary overloads and same-receiver extension
          // overloads each get their own node (pass-2 repair — receiver alone
          // collapsed fun open()/open(mode) into one).
          kind: 'function', resolutionKey: key, disambiguator: `${receiver ?? ''}/${ktArity(node)}`,
          name: nameNode.text, abs: file.abs, line, meta, fileRef: file.fileRef, ownerRef,
        });
        break;
      }
      case 'ctor.primary':
      case 'ctor.secondary': {
        // Constructors are function nodes named like their class (cpp
        // precedent: App::Widget::Widget), keyed Class::Class, arity-
        // disambiguated exactly like every other function (spec §3).
        const clsName = ktEnclosingClassName(node);
        if (clsName === null) break;
        const scope = ktScope(node, file.pkg); // enclosing class contributes itself
        const key = `${scope}::${clsName}`;
        ensureDecl(acc, 'kotlin', {
          // 'ctor/' prefix keeps a constructor from ever colliding with a
          // member function that shares the class's name and arity.
          kind: 'function', resolutionKey: key, disambiguator: `ctor/${ktArity(node)}`,
          name: clsName, abs: file.abs, line,
          // key is `ctor`, NOT `constructor` — a bare `constructor` key
          // collides with Object.prototype on plain-object reads.
          meta: { ctor: captureName === 'ctor.primary' ? 'primary' : 'secondary' },
          fileRef: file.fileRef,
          ownerRef: { kind: 'class', qualifiedName: `${acc.repoBase}#${scope}` },
        });
        break;
      }
      case 'import': {
        const m = IMPORT_RE.exec(node.text);
        if (m && m[1]) acc.intents.push({ form: 'imports', fileRef: file.fileRef, fqn: m[1], line });
        break;
      }
      case 'call': {
        const first = node.namedChild(0);
        if (!first) break;
        let callee: string | null = null;
        if (first.type === 'identifier') {
          callee = first.text;
        } else if (first.type === 'navigation_expression') {
          const ids = first.namedChildren.filter((c): c is Node => c !== null && c.type === 'identifier');
          const last = ids[ids.length - 1];
          callee = last ? last.text : null;
        }
        if (!callee) break;
        const callerQn = enclosingFunctionQn(acc, file, node);
        const callerRef: NodeRef = callerQn
          ? { kind: 'function', qualifiedName: callerQn }
          : file.fileRef;
        acc.intents.push({ form: 'calls', callerRef, callee, line });
        break;
      }
      default:
        break; // *.name captures ride along with their parent capture
    }
  },

  finalize(acc): void {
    gradleModules(acc);
    manifestComponents(acc);
  },

  resolveIntents(acc): void {
    for (const intent of acc.intents) {
      if (intent.form === 'imports') {
        // import FQN → the declaration's defining FILE (file→file imports,
        // php/ts shape). Kotlin imports name classes AND top-level functions
        // by the same dotted FQN, so both indexes are consulted — a
        // classes-only lookup silently mis-tallies every `import pkg.topFn`
        // as external (pass-1 finding).
        const classQn = acc.index.classesByKey.get(intent.fqn);
        const fnOverloads = acc.index.functionsByKey.get(intent.fqn);
        const firstFn = fnOverloads !== undefined && fnOverloads.length > 0 ? fnOverloads[0] : undefined;
        const declQn = classQn ?? firstFn;
        const targetFileQn = declQn !== undefined ? acc.index.declFileQn.get(declQn) : undefined;
        if (targetFileQn !== undefined && targetFileQn !== intent.fileRef.qualifiedName) {
          acc.edges.push({
            from: intent.fileRef, to: { kind: 'file', qualifiedName: targetFileQn },
            relation: 'imports', metadata: { line: intent.line },
          });
        } else if (declQn === undefined) {
          acc.tally.unresolved_imports = (acc.tally.unresolved_imports ?? 0) + 1; // external (androidx etc.)
        }
        continue;
      }
      if (intent.form === 'inherits') {
        // Ladder: import-FQN → same-package → unique-short (php resolveClassName shape).
        const viaImport = intent.file.imports.get(intent.typeName);
        let key: string | null = null;
        let confidence: 'extracted' | 'inferred' = 'extracted';
        if (viaImport !== undefined && acc.index.classesByKey.has(viaImport)) {
          key = viaImport;
        } else {
          const samePkg = intent.file.pkg === '' ? intent.typeName : `${intent.file.pkg}.${intent.typeName}`;
          if (acc.index.classesByKey.has(samePkg)) {
            key = samePkg;
          } else {
            const candidates = acc.index.classesByShort.get(intent.typeName) ?? [];
            if (candidates.length === 1 && candidates[0] !== undefined) {
              key = candidates[0];
              confidence = 'inferred';
            } else if (candidates.length > 1) {
              acc.tally.ambiguous_inherits = (acc.tally.ambiguous_inherits ?? 0) + 1;
            } else {
              acc.tally.unresolved_inherits = (acc.tally.unresolved_inherits ?? 0) + 1; // external base (ViewModel etc.)
            }
          }
        }
        if (key !== null) {
          const toQn = acc.index.classesByKey.get(key);
          if (toQn !== undefined && toQn !== intent.fromQn) {
            acc.edges.push({
              from: { kind: 'class', qualifiedName: intent.fromQn },
              to: { kind: 'class', qualifiedName: toQn },
              relation: 'inherits', confidence, metadata: { line: intent.line },
            });
          }
        }
        continue;
      }
      // calls: unique short name → inferred; ambiguous/zero → drop + tally.
      // A SELF-call (recursion) is deliberately neither edged (no-self-edges
      // invariant) nor tallied (recursion carries no cross-file information).
      const candidates = acc.index.functionsByShort.get(intent.callee) ?? [];
      if (candidates.length === 1) {
        const target = candidates[0];
        if (target !== undefined && target !== intent.callerRef.qualifiedName) {
          acc.edges.push({
            from: intent.callerRef, to: { kind: 'function', qualifiedName: target },
            relation: 'calls', confidence: 'inferred', metadata: { line: intent.line },
          });
        }
      } else if (candidates.length > 1) {
        acc.tally.ambiguous_calls = (acc.tally.ambiguous_calls ?? 0) + 1;
      } else {
        acc.tally.unresolved_calls = (acc.tally.unresolved_calls ?? 0) + 1;
      }
    }
  },

  report(acc): string {
    // ALWAYS emitted, fixed machine-parseable shape (php.ts:434-438 discipline).
    return (
      `kotlin-tally ${acc.repoBase} unresolved_calls=${acc.tally.unresolved_calls ?? 0} ` +
      `ambiguous_calls=${acc.tally.ambiguous_calls ?? 0} ` +
      `unresolved_inherits=${acc.tally.unresolved_inherits ?? 0} ` +
      `ambiguous_inherits=${acc.tally.ambiguous_inherits ?? 0} ` +
      `unresolved_imports=${acc.tally.unresolved_imports ?? 0} ` +
      `dynamic_modules=${acc.tally.dynamic_modules ?? 0} ` +
      `extra_gradle_roots=${acc.tally.extra_gradle_roots ?? 0} ` +
      `generated_skipped=${acc.tally.generated_skipped ?? 0}`
    );
  },
};

/** Gradle module structure from settings.gradle.kts (STATIC includes only —
 * Expo-generated settings files build their include list dynamically and are
 * explicitly unsupported: tallied as dynamic_modules and skipped, spec §3).
 * Kotlin-DSL settings files at the repo root or one level down (Android
 * consumers commonly keep theirs under android/). ONE Gradle root per repo is
 * the supported shape: candidates are checked in deterministic order (root
 * first, then top-level dirs sorted) and only the FIRST settings file found
 * is processed — module names like `:app` recur across roots, and processing
 * two roots would collide their module qns (pass-1 finding). Additional
 * roots are counted in extra_gradle_roots so the boundary is observable. */
function gradleModules(acc: Acc): void {
  const candidates = ['settings.gradle.kts', ...topLevelDirs(acc.repo).sort().map((d) => `${d}/settings.gradle.kts`)];
  let processed = false;
  for (const rel of candidates) {
    const abs = canonicalPhysicalPath(path.join(acc.repo, ...rel.split('/')), acc.repo);
    if (owningRegisteredRepo(abs, acc.registeredRoots ?? [acc.repo]) !== acc.repo) continue;
    let text: string;
    try {
      text = fs.readFileSync(abs, 'utf8');
    } catch {
      continue;
    }
    if (processed) {
      acc.tally.extra_gradle_roots = (acc.tally.extra_gradle_roots ?? 0) + 1;
      continue;
    }
    processed = true;
    const settingsDirRel = rel.includes('/') ? rel.slice(0, rel.lastIndexOf('/')) : '';
    if (/useExpoModules|require\(/.test(text)) {
      acc.tally.dynamic_modules = (acc.tally.dynamic_modules ?? 0) + 1;
      continue;
    }
    for (const m of text.matchAll(/include\(([^)]*)\)/g)) {
      const args = m[1] ?? '';
      for (const g of args.matchAll(/"(:[^"]+)"/g)) {
        const gradlePath = g[1];
        if (gradlePath === undefined) continue;
        const dirRel = [settingsDirRel, gradlePath.replace(/^:/, '').split(':').join('/')]
          .filter((s) => s !== '')
          .join('/');
        const moduleQn = `${acc.repoBase}#gradle${gradlePath}`;
        acc.nodes.push({
          kind: 'module', name: gradlePath, qualifiedName: moduleQn,
          filePath: abs, lang: 'kotlin', metadata: { dir: dirRel },
        });
        // file —depends_on→ module for every kotlin file under the module dir.
        for (const [fileRel, fileQn] of acc.fileByRelPath) {
          if (fileRel.startsWith(dirRel + '/')) {
            acc.edges.push({
              from: { kind: 'file', qualifiedName: fileQn },
              to: { kind: 'module', qualifiedName: moduleQn },
              relation: 'depends_on',
            });
          }
        }
      }
    }
  }
}

/** AndroidManifest components → metadata on the class node. Relative
 * `android:name` values resolve against the Gradle `namespace` (NEVER
 * applicationId — both fleet repos differ between the two). */
function manifestComponents(acc: Acc): void {
  for (const moduleNode of acc.nodes.filter((n) => n.kind === 'module')) {
    const dirRel = typeof moduleNode.metadata?.dir === 'string' ? moduleNode.metadata.dir : '';
    if (dirRel === '') continue;
    const manifestAbs = canonicalPhysicalPath(path.join(acc.repo, ...dirRel.split('/'), 'src', 'main', 'AndroidManifest.xml'), acc.repo);
    const gradleAbs = canonicalPhysicalPath(path.join(acc.repo, ...dirRel.split('/'), 'build.gradle.kts'), acc.repo);
    if (owningRegisteredRepo(manifestAbs, acc.registeredRoots ?? [acc.repo]) !== acc.repo) continue;
    let manifest: string;
    try {
      manifest = fs.readFileSync(manifestAbs, 'utf8');
    } catch {
      continue;
    }
    let namespace = '';
    try {
      if (owningRegisteredRepo(gradleAbs, acc.registeredRoots ?? [acc.repo]) !== acc.repo) continue;
      const gradle = fs.readFileSync(gradleAbs, 'utf8');
      const nm = /namespace\s*=\s*"([^"]+)"/.exec(gradle);
      if (nm && nm[1] !== undefined) namespace = nm[1];
    } catch {
      /* no gradle file — only absolute manifest names will resolve */
    }
    for (const m of manifest.matchAll(/<(activity|service|receiver|provider|application)\b[^>]*android:name="([^"]+)"/g)) {
      const componentKind = m[1];
      const rawName = m[2];
      if (componentKind === undefined || rawName === undefined) continue;
      const fqn = rawName.startsWith('.')
        ? `${namespace}${rawName}`
        : rawName.includes('.')
          ? rawName
          : namespace === '' ? rawName : `${namespace}.${rawName}`;
      const classQn = acc.index.classesByKey.get(fqn);
      if (classQn !== undefined) mergeMeta(acc, classQn, { androidComponent: componentKind });
    }
  }
}

function topLevelDirs(repo: string): string[] {
  try {
    return fs.readdirSync(repo, { withFileTypes: true })
      .filter((e) => e.isDirectory() && !e.name.startsWith('.') && e.name !== 'node_modules')
      .map((e) => e.name);
  } catch {
    return [];
  }
}

export const kotlinExtractor: GraphExtractor = makeTwoPassExtractor(pass);
