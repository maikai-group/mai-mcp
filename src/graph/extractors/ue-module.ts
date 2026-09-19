// mai-graph UE module extractor (spec 2026-06-21) — no code parser. Reads
// *.Build.cs (C#) for Public/PrivateDependencyModuleNames and *.uplugin (JSON)
// for module membership; emits `module` nodes + module—depends_on→module edges.
// Engine modules (Core, CoreUObject, Slate, …) are emitted as module nodes too
// so deps land somewhere (they ARE part of the dependency picture). Local-only,
// no LLM.
import fs from 'node:fs';
import path from 'node:path';
import { hashContent } from '../engine.js';
import { canonicalRegisteredRoots } from '../roots.js';
import { listOwnedRepoFiles } from '../walk.js';
import type { ExtractedEdge, ExtractedNode, ExtractorOutput, GraphExtractor, NodeRef } from '../types.js';

const BUILD_EXT = new Set(['.cs', '.uplugin']);
// Real UE code writes BOTH `new string[] { … }` and the implicitly-typed
// `new[] { … }` (UE acceptance finding, 2026-07-10) — and single deps via
// `.Add("X")`. Match all three.
const DEP_RE = /(Public|Private)DependencyModuleNames\s*\.\s*AddRange\s*\(\s*new(?:\s+string\s*\[\s*\]|\s*\[\s*\])\s*\{([^}]*)\}/g;
const ADD_RE = /(Public|Private)DependencyModuleNames\s*\.\s*Add\s*\(\s*"([^"]+)"\s*\)/g;
const STRING_RE = /"([^"]+)"/g;

interface Sink {
  nodes: ExtractedNode[];
  edges: ExtractedEdge[];
  seen: Set<string>;
}

function moduleQn(repoBase: string, name: string): string {
  return `${repoBase}::${name}`;
}

export function parseBuildCs(text: string, fileName: string, repoBase: string, abs: string, sink: Sink): void {
  // Module name = the .Build.cs basename (UE convention: Foo.Build.cs → Foo).
  const moduleName = path.basename(fileName).replace(/\.Build\.cs$/i, '');
  const fromQn = moduleQn(repoBase, moduleName);
  ensureModule(sink, repoBase, moduleName, abs, undefined, hashContent(text));
  const fromRef: NodeRef = { kind: 'module', qualifiedName: fromQn };
  const addDep = (dep: string): void => {
    ensureModule(sink, repoBase, dep, undefined);
    sink.edges.push({ from: fromRef, to: { kind: 'module', qualifiedName: moduleQn(repoBase, dep) }, relation: 'depends_on' });
  };
  let m: RegExpExecArray | null;
  DEP_RE.lastIndex = 0;
  while ((m = DEP_RE.exec(text)) !== null) {
    const body = m[2];
    let s: RegExpExecArray | null;
    STRING_RE.lastIndex = 0;
    while ((s = STRING_RE.exec(body)) !== null) addDep(s[1]);
  }
  ADD_RE.lastIndex = 0;
  while ((m = ADD_RE.exec(text)) !== null) addDep(m[2]);
}

export function parseUplugin(text: string, repoBase: string, abs: string, sink: Sink): void {
  let cfg: { Modules?: Array<{ Name?: string; Type?: string }> };
  try {
    cfg = JSON.parse(text) as typeof cfg;
  } catch {
    return;
  }
  for (const mod of cfg.Modules ?? []) {
    if (!mod.Name) continue;
    ensureModule(sink, repoBase, mod.Name, abs, mod.Type, hashContent(text));
  }
}

function ensureModule(
  sink: Sink, repoBase: string, name: string, abs?: string, type?: string, contentHash?: string,
): void {
  const qn = moduleQn(repoBase, name);
  if (sink.seen.has(qn)) return;
  sink.seen.add(qn);
  sink.nodes.push({
    kind: 'module', name, qualifiedName: qn, filePath: abs, contentHash,
    metadata: type ? { type } : {},
  });
}

export const ueModuleExtractor: GraphExtractor = {
  name: 'ue-module',
  vocabulary: { kinds: ['module'], relations: ['depends_on'] },
  async extract({ repoPaths, excludes }): Promise<ExtractorOutput> {
    const sink: Sink = { nodes: [], edges: [], seen: new Set<string>() };
    const resolvedRepos = canonicalRegisteredRoots(repoPaths, { baseDir: process.cwd(), rejectRelative: true });
    for (const repo of resolvedRepos) {
      const repoBase = path.basename(repo);
      for (const abs of listOwnedRepoFiles(repo, resolvedRepos, BUILD_EXT, excludes ?? [])) {
        const base = path.basename(abs);
        let text: string;
        try {
          text = fs.readFileSync(abs, 'utf8');
        } catch {
          continue;
        }
        // BUILD_EXT includes .cs; gate on the .Build.cs suffix so non-UE C#
        // files are ignored (no nodes emitted for them).
        if (base.endsWith('.Build.cs')) parseBuildCs(text, base, repoBase, abs, sink);
        else if (base.endsWith('.uplugin')) parseUplugin(text, repoBase, abs, sink);
      }
    }
    return { nodes: sink.nodes, edges: sink.edges };
  },
};
