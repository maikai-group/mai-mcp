// Tier-2 shallow extractor core (plan 36, spec §3): python.ts parameterized.
// One parse per file; the grammar's OWN tags.scm supplies definitions and
// references (standardized @definition.*/@name/@reference.* captures —
// Query.matches() pairs a @name with its @definition.* in the same match,
// measured 6000/6000 on a 148KB fixture); a tiny per-language importQuery
// supplies imports; enclosing-definition byte ranges turn same-file
// references into function→function `calls` at `inferred`.
//
// What tier-2 deliberately does NOT do (spec D5): cross-file call resolution,
// type resolution, framework awareness — that is the deep tier's definition.
// Unresolvable references are counted, never guessed.
//
// Identity (spec D6): every symbol qname is `${repoBase}/${relPosix}#${name}`
// — FILE-scoped, structurally collision-free against deep extractors'
// repo-scoped `${repoBase}#…` shape (a repo-scoped qname never contains '/'
// before '#'). Test-asserted invariant; do not "improve" it to repo scope —
// that is where ownership ping-pong starts (engine.ts:151-162).
import fs from 'node:fs';
import path from 'node:path';
import { Query, type Node } from 'web-tree-sitter';
import { hashContent } from '../../engine.js';
import { loadLanguage, parserFor, type GrammarName } from '../../parsers.js';
import { canonicalRegisteredRoots } from '../../roots.js';
import { listOwnedRepoFiles } from '../../walk.js';
import type { ExtractedEdge, ExtractedNode, ExtractorOutput, GraphExtractor, NodeRef } from '../../types.js';

export interface Tier2Language {
  /** 'go' → extractor name `tier2-go` (fits engine.ts:45's name regex). */
  id: string;
  /** ExtractedNode.lang label. */
  lang: string;
  grammar: GrammarName;
  extensions: ReadonlySet<string>;
  /** Basenames to skip entirely (csharp: UE build scripts — ue-module.ts:12). */
  skipBasenames?: ReadonlySet<string>;
  /** Vendored tags.scm path, resolved relative to this module. */
  tagsFile: URL;
  /** Complete allowed capture-name set for the tags query (R4 gate a). */
  knownCaptures: ReadonlySet<string>;
  /** Spike-verified import query (plan table); '' = no imports for this lang. */
  importQuery: string;
  /** Node types the importQuery names (validation gate b probes each at first
   * extract). */
  importNodeTypes: readonly string[];
  /** definition.* capture → registry kind. Folded kinds keep provenance in
   * metadata.declKind (the capture suffix). Unmapped definition captures are
   * counted (tally 'unmapped_definitions'), never guessed. */
  kindMap: Readonly<Record<string, 'function' | 'class' | 'module'>>;
  /** tags.scm capture names treated as call references (go/rust/java:
   * 'reference.call'; csharp: 'reference.send'). */
  refCaptures: ReadonlySet<string>;
  /** Supplementary reference query for call shapes the shipped tags.scm
   * misses — spike-required like importQuery. csharp NEEDS this: its tags
   * capture reference.send only for member-access invocations, so a bare
   * `Step();` is invisible to them (measured; `(invocation_expression
   * function: (identifier) @name)` captures exactly the bare form and
   * nothing member-accessed). Every capture must be named @name. */
  extraRefQuery?: string;
  /** Node types the extraRefQuery names (same validation gate). */
  extraRefNodeTypes?: readonly string[];
  /** When one node is captured under several definition kinds (rust: impl fns
   * are BOTH definition.method and definition.function — measured), the
   * earliest entry here wins. Every kindMap key MUST appear. */
  precedence: readonly string[];
  /** Normalize an import capture's text to a module label (go strips quotes). */
  importLabel?(text: string): string;
}

interface DefSpan {
  qn: string;
  start: number;
  end: number;
}

function assertQueryNodeTypes(cfg: Tier2Language, langImportTypes: (t: string) => boolean): void {
  // R4 gate (b): this MUST run before Query construction. Otherwise a grammar
  // node-type rename escapes as web-tree-sitter's generic QueryError instead
  // of the named tier2 diagnostic that tells operators how to repair the pin.
  for (const t of [...cfg.importNodeTypes, ...(cfg.extraRefNodeTypes ?? [])]) {
    if (!langImportTypes(t)) {
      throw new Error(`tier2-${cfg.id}: query node type '${t}' does not exist in the vendored grammar`);
    }
  }
}

function assertValidated(cfg: Tier2Language, query: Query): void {
  // R4 gate (a): capture conformance — a grammar bump that renames captures
  // must fail loudly here, never silently emit nothing.
  for (const cap of query.captureNames) {
    if (!cfg.knownCaptures.has(cap)) {
      throw new Error(
        `tier2-${cfg.id}: tags.scm capture '@${cap}' is not in the known set — ` +
        `the vendored grammar/tags changed; re-run the adoption spike and update the config`
      );
    }
  }
  // precedence completeness: every kindMap key must be ranked.
  for (const key of Object.keys(cfg.kindMap)) {
    if (!cfg.precedence.includes(key)) {
      throw new Error(`tier2-${cfg.id}: kindMap capture '${key}' missing from precedence`);
    }
  }
}

export function makeTier2Extractor(cfg: Tier2Language): GraphExtractor {
  return {
    name: `tier2-${cfg.id}`,
    vocabulary: {
      kinds: ['file', 'function', 'class', 'module'],
      relations: ['defines', 'imports', 'calls'],
    },
    async extract({ repoPaths, excludes }): Promise<ExtractorOutput> {
      const parser = await parserFor(cfg.grammar);
      const grammarLang = await loadLanguage(cfg.grammar);
      const tagsSource = fs.readFileSync(cfg.tagsFile, 'utf8');
      const tagsQuery = new Query(grammarLang, tagsSource);
      assertQueryNodeTypes(cfg, (t) => grammarLang.idForNodeType(t, true) !== null);
      const importQuery = cfg.importQuery === '' ? null : new Query(grammarLang, cfg.importQuery);
      const extraRefQuery = cfg.extraRefQuery === undefined ? null : new Query(grammarLang, cfg.extraRefQuery);
      assertValidated(cfg, tagsQuery);

      // `changedFiles` is deliberately NOT honored (spec A3, php.ts's pattern):
      // tier-2 always re-runs fully. A partial walk would leave removed-import
      // module rendezvous nodes (fileless, splice-invisible) permanently stale;
      // a full run replaces the whole extracted_by set every time.
      const nodes: ExtractedNode[] = [];
      const edges: ExtractedEdge[] = [];
      const resolvedRepos = canonicalRegisteredRoots(repoPaths, { baseDir: process.cwd(), rejectRelative: true });

      for (const repo of resolvedRepos) {
        const repoBase = path.basename(repo);
        let unresolvedRefs = 0;
        let unmappedDefs = 0;
        for (const abs of listOwnedRepoFiles(repo, resolvedRepos, cfg.extensions, excludes ?? [])) {
          // DOTTED-suffix match: UE build scripts are `<Module>.Build.cs`. The
          // leading dot in the config values is load-bearing (pass-2 finding):
          // without it, an ordinary `ScriptBuild.cs` would be silently dropped.
          // With it: Probe.Build.cs skipped; ScriptBuild.cs and CodeBuilder.cs kept.
          if (cfg.skipBasenames && [...cfg.skipBasenames].some((sfx) => path.basename(abs).endsWith(sfx))) continue;
          let text: string;
          try {
            text = fs.readFileSync(abs, 'utf8');
          } catch {
            continue;
          }
          const relPosix = path.relative(repo, abs).split(path.sep).join('/');
          const fileQn = `${repoBase}/${relPosix}`;
          const fileRef: NodeRef = { kind: 'file', qualifiedName: fileQn };
          nodes.push({
            kind: 'file', name: path.basename(abs), qualifiedName: fileQn,
            filePath: abs, lang: cfg.lang, contentHash: hashContent(text),
          });
          let root: Node;
          try {
            const tree = parser.parse(text);
            if (!tree) continue;
            root = tree.rootNode;
          } catch {
            continue; // unparseable file skipped, never fatal (php.ts precedent)
          }

          // --- definitions: matches() pairs @definition.* with its @name ----
          // Per-node precedence dedupe FIRST (rust double-captures impl fns as
          // method AND function — measured): key by the definition node's span,
          // keep the highest-precedence capture kind.
          const bestByNode = new Map<string, { defCap: string; name: string; nameNode: Node; defNode: Node }>();
          for (const m of tagsQuery.matches(root)) {
            let defCap: string | null = null;
            let defNode: Node | null = null;
            let nameNode: Node | null = null;
            for (const c of m.captures) {
              if (c.name.startsWith('definition.')) { defCap = c.name; defNode = c.node; }
              else if (c.name === 'name') nameNode = c.node;
            }
            if (!defCap || !defNode || !nameNode) continue;
            if (!(defCap in cfg.kindMap)) { unmappedDefs++; continue; }
            const spanKey = `${defNode.startIndex}:${defNode.endIndex}`;
            const prev = bestByNode.get(spanKey);
            if (!prev || cfg.precedence.indexOf(defCap) < cfg.precedence.indexOf(prev.defCap)) {
              bestByNode.set(spanKey, { defCap, name: nameNode.text, nameNode, defNode });
            }
          }

          const spans: DefSpan[] = [];
          const emitted = new Set<string>();
          for (const { defCap, name, nameNode, defNode } of bestByNode.values()) {
            if (name.trim() === '') continue; // engine.ts:54 aborts on empty names
            const kind = cfg.kindMap[defCap];
            if (kind === undefined) continue; // unreachable after the gate; keeps tsc strict
            const qn = `${fileQn}#${name}`;
            if (!emitted.has(`${kind}:${qn}`)) {
              emitted.add(`${kind}:${qn}`);
              nodes.push({
                kind, name, qualifiedName: qn, filePath: abs,
                line: nameNode.startPosition.row + 1, lang: cfg.lang,
                metadata: { declKind: defCap.slice('definition.'.length), tier: 2 },
              });
              edges.push({ from: fileRef, to: { kind, qualifiedName: qn }, relation: 'defines' });
            }
            if (kind === 'function') spans.push({ qn, start: defNode.startIndex, end: defNode.endIndex });
          }

          // --- same-file calls: innermost enclosing definition (spec D5) ----
          spans.sort((a, b) => a.start - b.start || b.end - a.end);
          const enclosing = (idx: number): string | null => {
            let best: DefSpan | null = null;
            for (const s of spans) {
              if (s.start <= idx && idx < s.end && (!best || s.start >= best.start)) best = s;
            }
            return best ? best.qn : null;
          };
          const fnByName = new Map<string, string[]>();
          for (const s of spans) {
            const short = s.qn.slice(s.qn.lastIndexOf('#') + 1);
            fnByName.set(short, [...(fnByName.get(short) ?? []), s.qn]);
          }
          // Duplicate short names in this file (overloads, shadowing) make
          // fnByName ambiguous — the `targets.length !== 1` check below then
          // counts them as unresolved. Deliberate: tier-2 never guesses
          // (spec D5); the deep tier owns disambiguation.
          const callEdges = new Set<string>();
          const refSites: Array<{ refNode: Node; nameNode: Node }> = [];
          for (const m of tagsQuery.matches(root)) {
            let refCap: Node | null = null;
            let refName: Node | null = null;
            for (const c of m.captures) {
              if (cfg.refCaptures.has(c.name)) refCap = c.node;
              else if (c.name === 'name') refName = c.node;
            }
            if (refCap && refName) refSites.push({ refNode: refCap, nameNode: refName });
          }
          if (extraRefQuery) {
            for (const cap of extraRefQuery.captures(root)) {
              refSites.push({ refNode: cap.node, nameNode: cap.node });
            }
          }
          for (const { refNode: refCap, nameNode: refName } of refSites) {
            const targets = fnByName.get(refName.text);
            if (!targets || targets.length !== 1) { unresolvedRefs++; continue; } // ambiguous/absent: count, never guess (see note above)
            const target = targets[0];
            if (target === undefined) continue;
            const from = enclosing(refCap.startIndex);
            if (from === null || from === target) { unresolvedRefs++; continue; }
            const key = `${from}→${target}`;
            if (callEdges.has(key)) continue;
            callEdges.add(key);
            edges.push({
              from: { kind: 'function', qualifiedName: from },
              to: { kind: 'function', qualifiedName: target },
              relation: 'calls', confidence: 'inferred',
              metadata: { line: refName.startPosition.row + 1 },
            });
          }

          // --- imports ----------------------------------------------------
          if (importQuery) {
            const seen = new Set<string>();
            for (const cap of importQuery.captures(root)) {
              const label = (cfg.importLabel ? cfg.importLabel(cap.node.text) : cap.node.text).trim();
              if (label === '' || seen.has(label)) continue;
              seen.add(label);
              const modQn = `${cfg.id}-module:${label}`;
              nodes.push({ kind: 'module', name: label, qualifiedName: modQn, lang: cfg.lang });
              edges.push({
                from: fileRef, to: { kind: 'module', qualifiedName: modQn },
                relation: 'imports', metadata: { line: cap.node.startPosition.row + 1 },
              });
            }
          }
        }

        // ALWAYS emitted PER REPO, fixed machine-parseable shape (php.ts
        // discipline — the repo dimension matters for multi-repo projects).
        console.warn(
          `tier2-${cfg.id}-tally ${repoBase} unresolved_refs=${unresolvedRefs} unmapped_definitions=${unmappedDefs}`
        );
      }

      return { nodes, edges };
    },
  };
}
