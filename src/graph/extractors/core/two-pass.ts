// Shared two-pass extractor core (plan 35, spec 2026-08-25 §2). Pass 1 parses
// every file exactly once, emits file + declaration nodes and queues
// STRING-ONLY intents (no AST retained); pass 2 hands the completed per-repo
// index to the language's resolveIntents. The interface is the UNION of
// cpp.ts's and php.ts's requirements (spec §2.3) so both legacy extractors can
// converge here in a later maintenance plan; today's consumers are kotlin.ts
// and swift.ts.
//
// Resolution POLICY is a REQUIRED hook with NO default: cpp fans out ambiguous
// calls at `inferred` (cpp.ts:479-489), php drops them (php-ast.ts:328), and
// both behaviors are test-asserted — a core default would silently flip one.
//
// Splice is a REQUIRED per-language contract (spec §2.3 invariant 7):
// 'cpp-style' honours changedFiles (only changed files parse; the index holds
// only their symbols, cross-file targets in unchanged files drop at
// resolution — the accepted cpp tradeoff, healed by a full build).
// 'refuse' IGNORES changedFiles and always runs the full repo pass —
// php.ts:363-369 exact semantics: a full extraction is always correct, so a
// wrong enrolment in update.ts's `splices` cannot corrupt (an honoured
// partial parse would fabricate wrong identities for context-dependent
// languages — a changed Swift file cannot see its unchanged Package.swift).
// kotlin and swift are 'refuse' (amendment A6) and never register on update.
import fs from 'node:fs';
import path from 'node:path';
import { Query, type Node } from 'web-tree-sitter';
import { hashContent } from '../../engine.js';
import { loadLanguage, parserFor, type GrammarName } from '../../parsers.js';
import { canonicalRegisteredRoots } from '../../roots.js';
import { listOwnedRepoFiles } from '../../walk.js';
import type { ExtractorVocabulary } from '../../registry.js';
import type { ExtractedEdge, ExtractedNode, ExtractorOutput, GraphExtractor, NodeRef } from '../../types.js';

/** Per-repo symbol index. Generalises cpp RepoCtx.symbolTable/classTable/
 * nodeByNodeKey (cpp.ts:46-52) and php classByFqcn/classesByShort/
 * functionsByShort/methodQns (php-ast.ts:91-97). */
export interface SymbolIndex {
  /** identity key (kind-prefixed resolution key + optional disambiguator) →
   * node qn. Dedups a declaration and its definition onto ONE node. */
  byIdentity: Map<string, string>;
  /** function resolution key → node qns, one per distinct overload. */
  functionsByKey: Map<string, string[]>;
  /** class/type resolution key → node qn. */
  classesByKey: Map<string, string>;
  /** simple name → function node qns. */
  functionsByShort: Map<string, string[]>;
  /** simple name → class resolution keys. */
  classesByShort: Map<string, string[]>;
  /** decl qn → owning file qn (import-to-defining-file resolution). */
  declFileQn: Map<string, string>;
  /** every emitted decl qn — the existence gate (php.ts:335 precedent). */
  emitted: Set<string>;
}

/** Per-repo accumulator handed to every hook. */
export interface RepoAcc<FileCtx, Intent> {
  repo: string;
  registeredRoots?: readonly string[];
  repoBase: string;
  nodes: ExtractedNode[];
  edges: ExtractedEdge[];
  index: SymbolIndex;
  intents: Intent[];
  /** language drop counters, pre-seeded to 0 from pass.tallyKeys. */
  tally: Record<string, number>;
  /** repo-relative posix path → file qn. */
  fileByRelPath: Map<string, string>;
}

export interface LanguagePass<FileCtx, Intent> {
  /** GraphExtractor.name — lands in graph_nodes.extracted_by. */
  name: string;
  /** ExtractedNode.lang label (keep consistent with src/ingest.ts:173-174). */
  lang: string;
  grammar: GrammarName;
  extensions: ReadonlySet<string>;
  vocabulary: ExtractorVocabulary;
  /** REQUIRED splice contract (spec §2.3 invariant 7 — no default):
   * 'cpp-style' honours changedFiles; 'refuse' ignores them and always runs
   * the full repo pass (php.ts:363-369 semantics). */
  splice: 'cpp-style' | 'refuse';
  /** Repo-relative-posix path exclusion, applied AFTER BOTH enumeration
   * paths — git ls-files does not consult walk.ts SKIP_DIRS, so tracked
   * build//.build//generated trees are only stopped here (spec excludes). */
  exclude?: RegExp;
  /** Generated-content marker (e.g. Kotlin `@generated` headers). A true
   * return skips the file and counts tally.generated_skipped when seeded. */
  isGeneratedText?(text: string): boolean;
  /** Called ONCE per repo with every enumerated repo-relative posix path,
   * BEFORE any file parses — for discovery that must be order-independent
   * (swift seeds its Package.swift dirs here; lazy discovery inside
   * makeFileCtx would depend on traversal order — pass-5 finding). */
  preEnumerate?(acc: RepoAcc<FileCtx, Intent>, relPaths: readonly string[]): void;
  /** Verified tree-sitter query; captures dispatch to handleCapture. */
  querySource: string;
  tallyKeys: readonly string[];
  /** Offset-preserving source rewrite before parse (cpp API_MACRO_RE shape).
   * MUST NOT change text length at any position. contentHash always uses the
   * ORIGINAL text (cpp.ts:221-226 precedent). */
  preparse?(text: string): string;
  /** Per-file context (package/namespace/import map), once per file. */
  makeFileCtx(root: Node, abs: string, relPosix: string, fileRef: NodeRef, acc: RepoAcc<FileCtx, Intent>): FileCtx;
  /** Optional pre-walk pass over the same tree (php prescanConstants shape). */
  prescan?(acc: RepoAcc<FileCtx, Intent>, file: FileCtx, root: Node): void;
  /** PASS 1, per query capture: emit via ensureDecl, queue intents. */
  handleCapture(acc: RepoAcc<FileCtx, Intent>, file: FileCtx, captureName: string, node: Node): void;
  /** Optional per-repo fixup after pass 1, before resolution (may read fs —
   * gradle/manifest layers live here). */
  finalize?(acc: RepoAcc<FileCtx, Intent>): void;
  /** PASS 2: resolve every queued intent; emit edges into acc.edges; count
   * drops into acc.tally. REQUIRED — no default policy (header note). */
  resolveIntents(acc: RepoAcc<FileCtx, Intent>): void;
  /** Tally line, ALWAYS emitted in a fixed machine-parseable shape
   * (php.ts:434-438 discipline); return null only if the language has no
   * drop counters at all. */
  report(acc: RepoAcc<FileCtx, Intent>): string | null;
}

export interface EnsureDeclOpts {
  kind: 'function' | 'class';
  /** Scope-qualified key WITHOUT the repoBase prefix; the language chooses its
   * separators and they are API — cpp keys on '#' presence (cpp.ts:480). */
  resolutionKey: string;
  /** Overload/variant disambiguator (cpp arity; kotlin extension receiver).
   * Distinct values under one resolutionKey → distinct nodes (base, base/1, …
   * — insertion-order numbering, cpp.ts:139-141 semantics preserved). */
  disambiguator?: string;
  name: string;
  /** null = a location-less declaration (php rendezvous nodes carry no
   * filePath/line — spec §2.3 invariant 5; the union interface must not
   * force one). kotlin/swift always pass real locations. */
  abs: string | null;
  line: number | null;
  meta?: Record<string, unknown>;
  fileRef: NodeRef;
  /** `defines` edge owner; defaults to fileRef. */
  ownerRef?: NodeRef;
}

/** Merge metadata into an already-emitted node — later, richer metadata wins
 * (cpp.ts:114-121 semantics, order-independent decl/def convergence). */
export function mergeMeta<FileCtx, Intent>(acc: RepoAcc<FileCtx, Intent>, qn: string, meta: Record<string, unknown>): void {
  if (Object.keys(meta).length === 0) return;
  const node = acc.nodes.find((n) => n.qualifiedName === qn);
  if (node) node.metadata = { ...(node.metadata ?? {}), ...meta };
}

/** Create-or-reuse a declaration node; identity is (kind, resolutionKey,
 * disambiguator). Declaration + definition converge onto ONE node; distinct
 * disambiguators get overload-suffixed qns. Empty names are refused at the
 * producer — engine.ts:54 would abort the entire multi-extractor build. */
export function ensureDecl<FileCtx, Intent>(acc: RepoAcc<FileCtx, Intent>, lang: string, opts: EnsureDeclOpts): string {
  if (opts.name.trim() === '' || opts.resolutionKey.trim() === '') {
    throw new Error(`${lang} extractor: refusing to emit an empty ${opts.kind} decl (key '${opts.resolutionKey}')`);
  }
  const identity = `${opts.kind}:${opts.resolutionKey}/${opts.disambiguator ?? ''}`;
  const existing = acc.index.byIdentity.get(identity);
  if (existing) {
    mergeMeta(acc, existing, opts.meta ?? {});
    return existing;
  }
  const base = `${acc.repoBase}#${opts.resolutionKey}`;
  let qn: string;
  if (opts.kind === 'class') {
    qn = base;
    acc.index.classesByKey.set(opts.resolutionKey, qn);
    const short = simpleNameOf(opts.resolutionKey);
    acc.index.classesByShort.set(short, [...(acc.index.classesByShort.get(short) ?? []), opts.resolutionKey]);
  } else {
    const overloads = acc.index.functionsByKey.get(opts.resolutionKey) ?? [];
    qn = overloads.length === 0 ? base : `${base}/${overloads.length}`;
    acc.index.functionsByKey.set(opts.resolutionKey, [...overloads, qn]);
    const short = opts.name;
    acc.index.functionsByShort.set(short, [...(acc.index.functionsByShort.get(short) ?? []), qn]);
  }
  acc.index.byIdentity.set(identity, qn);
  acc.index.emitted.add(qn);
  acc.index.declFileQn.set(qn, opts.fileRef.qualifiedName);
  acc.nodes.push({
    kind: opts.kind, name: opts.name, qualifiedName: qn,
    ...(opts.abs !== null ? { filePath: opts.abs } : {}),
    ...(opts.line !== null ? { line: opts.line } : {}),
    lang, metadata: opts.meta ?? {},
  });
  acc.edges.push({
    from: opts.ownerRef ?? opts.fileRef,
    to: { kind: opts.kind, qualifiedName: qn },
    relation: 'defines',
  });
  return qn;
}

/** Last segment after the language's scope separators ('.', '::', '#', '\\'). */
export function simpleNameOf(key: string): string {
  const parts = key.split(/::|[.#\\]/);
  const last = parts[parts.length - 1];
  return last === undefined || last === '' ? key : last;
}

export function makeTwoPassExtractor<FileCtx, Intent>(pass: LanguagePass<FileCtx, Intent>): GraphExtractor {
  return {
    name: pass.name,
    vocabulary: pass.vocabulary,
    async extract({ repoPaths, changedFiles, excludes }): Promise<ExtractorOutput> {
      const resolvedRepos = canonicalRegisteredRoots(repoPaths, { baseDir: process.cwd(), rejectRelative: true });
      // 'refuse' languages ignore changedFiles entirely — full pass always
      // (php.ts:363-369): correctness cannot depend on who called us.
      const changed = pass.splice === 'refuse' || !changedFiles
        ? null
        : new Set(changedFiles.map((p) => path.resolve(p)));

      const parser = await parserFor(pass.grammar);
      const grammarLang = await loadLanguage(pass.grammar);
      const query = new Query(grammarLang, pass.querySource);

      const allNodes: ExtractedNode[] = [];
      const allEdges: ExtractedEdge[] = [];

      for (const repo of resolvedRepos) {
        const acc: RepoAcc<FileCtx, Intent> = {
          repo,
          registeredRoots: resolvedRepos,
          repoBase: path.basename(repo),
          nodes: [],
          edges: [],
          index: {
            byIdentity: new Map(), functionsByKey: new Map(), classesByKey: new Map(),
            functionsByShort: new Map(), classesByShort: new Map(),
            declFileQn: new Map(), emitted: new Set(),
          },
          intents: [],
          tally: Object.fromEntries(pass.tallyKeys.map((k) => [k, 0])),
          fileByRelPath: new Map(),
        };

        // SORTED enumeration: git ls-files is path-sorted but the fs-walk
        // fallback returns raw readdir order (walk.ts). Sorting makes file
        // order deterministic on BOTH paths — overload numbering is
        // insertion-order (API), and swift's lazy Package.swift discovery
        // requires every manifest to precede its Sources/Tests descendants
        // ('Package.swift' < 'Sources/…' < 'Tests/…' byte-wise; pass-3
        // finding: unsorted fs-walk order broke module identity).
        const enumerated = [...listOwnedRepoFiles(repo, resolvedRepos, pass.extensions, excludes ?? [])].sort();
        if (pass.preEnumerate) {
          pass.preEnumerate(
            acc,
            enumerated.map((abs) => path.relative(repo, abs).split(path.sep).join('/'))
          );
        }
        for (const abs of enumerated) {
          if (changed && !changed.has(path.resolve(abs))) continue; // splice mode (cpp.ts:207)
          const relPosix = path.relative(repo, abs).split(path.sep).join('/');
          // Language excludes run on BOTH enumeration paths — git ls-files
          // returns tracked build//.build/ files that SKIP_DIRS never sees.
          if (pass.exclude?.test(relPosix)) continue;
          let text: string;
          try {
            text = fs.readFileSync(abs, 'utf8');
          } catch {
            continue;
          }
          if (pass.isGeneratedText?.(text)) {
            if ('generated_skipped' in acc.tally) acc.tally.generated_skipped += 1;
            continue;
          }
          const fileQn = `${acc.repoBase}/${relPosix}`;
          acc.fileByRelPath.set(relPosix, fileQn);
          const fileRef: NodeRef = { kind: 'file', qualifiedName: fileQn };
          acc.nodes.push({
            kind: 'file', name: path.basename(abs), qualifiedName: fileQn,
            filePath: abs, lang: pass.lang, contentHash: hashContent(text),
          });

          // contentHash stays on the ORIGINAL text; only the parse input is
          // rewritten, and preparse must preserve every offset (cpp precedent).
          const parseInput = pass.preparse ? pass.preparse(text) : text;
          let root: Node;
          try {
            const tree = parser.parse(parseInput);
            if (!tree) continue;
            root = tree.rootNode;
          } catch {
            continue; // unparseable file is skipped, never fatal (php.ts:398-405)
          }

          const file = pass.makeFileCtx(root, abs, relPosix, fileRef, acc);
          if (pass.prescan) pass.prescan(acc, file, root);
          for (const cap of query.captures(root)) {
            pass.handleCapture(acc, file, cap.name, cap.node);
          }
        }

        if (pass.finalize) pass.finalize(acc);
        pass.resolveIntents(acc);
        const line = pass.report(acc);
        if (line !== null) console.warn(line);
        allNodes.push(...acc.nodes);
        allEdges.push(...acc.edges);
      }

      return { nodes: allNodes, edges: allEdges };
    },
  };
}
