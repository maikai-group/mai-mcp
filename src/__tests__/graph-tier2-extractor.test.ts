/** Tier-2 extractors over the committed fixtures — pure, no DB. */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { beforeAll, describe, expect, it, vi } from 'vitest';
import { makeTier2Extractor } from '../graph/extractors/core/tier2.js';
import {
  TIER2_CONFIGS,
  tier2CsharpExtractor, tier2GoExtractor, tier2JavaExtractor, tier2RustExtractor,
} from '../graph/extractors/tier2-languages.js';
import { DEEP_EXTENSIONS, TIER2_EXTENSIONS } from '../graph/extension-registry.js';
import type { ExtractorOutput } from '../graph/types.js';

const FIX = (repo: string): string =>
  path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures', 'tier2', repo);

let go: ExtractorOutput;
let rust: ExtractorOutput;
let java: ExtractorOutput;
let csharp: ExtractorOutput;

beforeAll(async () => {
  go = await tier2GoExtractor.extract({ projectId: 'x', repoPaths: [FIX('go-repo')] });
  rust = await tier2RustExtractor.extract({ projectId: 'x', repoPaths: [FIX('rust-repo')] });
  java = await tier2JavaExtractor.extract({ projectId: 'x', repoPaths: [FIX('java-repo')] });
  csharp = await tier2CsharpExtractor.extract({ projectId: 'x', repoPaths: [FIX('csharp-repo')] });
});

const node = (o: ExtractorOutput, kind: string, qn: string) =>
  o.nodes.find((n) => n.kind === kind && n.qualifiedName === qn);
const edge = (o: ExtractorOutput, rel: string, from: string, to: string) =>
  o.edges.find((e) => e.relation === rel && e.from.qualifiedName === from && e.to.qualifiedName === to);

describe('tier2-go', () => {
  it('emits file, function and folded type nodes with declKind', () => {
    expect(node(go, 'file', 'go-repo/main.go')?.contentHash).toMatch(/^[0-9a-f]{64}$/);
    expect(node(go, 'function', 'go-repo/main.go#Run')).toBeDefined();
    expect(node(go, 'class', 'go-repo/main.go#Engine')?.metadata).toMatchObject({ declKind: 'type', tier: 2 });
  });
  it('emits imports with quotes stripped', () => {
    expect(node(go, 'module', 'go-module:fmt')).toBeDefined();
    expect(edge(go, 'imports', 'go-repo/main.go', 'go-module:fmt')).toBeDefined();
  });
  it('resolves same-file calls function→function at inferred', () => {
    const e = edge(go, 'calls', 'go-repo/util.go#crossFileOnly', 'go-repo/util.go#otherRun');
    expect(e).toBeDefined();
    expect(e?.confidence).toBe('inferred');
  });
  it('does NOT resolve cross-file calls — the tier boundary (spec D5)', () => {
    // main.go's Run() calls helper(), defined in util.go: must be absent.
    expect(go.edges.find((e) => e.relation === 'calls' && e.to.qualifiedName === 'go-repo/util.go#helper')).toBeUndefined();
  });
  it('emits the machine-parseable per-repo tally on console.warn (R1)', async () => {
    const spy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      await tier2GoExtractor.extract({ projectId: 'x', repoPaths: [FIX('go-repo')] });
      const lines = spy.mock.calls.map((c) => c.join(' '));
      expect(lines.some((l) => /^tier2-go-tally go-repo unresolved_refs=\d+ unmapped_definitions=\d+$/.test(l))).toBe(true);
    } finally {
      spy.mockRestore();
    }
  });
});

describe('tier2-rust', () => {
  it('folds struct/trait/mod with declKind metadata', () => {
    expect(node(rust, 'class', 'rust-repo/lib.rs#Store')).toBeDefined();
    expect(node(rust, 'class', 'rust-repo/helper.rs#Sink')?.metadata).toMatchObject({ declKind: 'interface' });
    expect(node(rust, 'module', 'rust-repo/helper.rs#inner')).toBeDefined();
  });
  it('impl methods emit ONCE despite double-capture (precedence dedupe)', () => {
    const gets = rust.nodes.filter((n) => n.qualifiedName === 'rust-repo/lib.rs#get');
    expect(gets).toHaveLength(1);
    expect(gets[0]?.kind).toBe('function');
    expect(gets[0]?.metadata).toMatchObject({ declKind: 'method' });
  });
  it('same-file call get→depth resolves', () => {
    expect(edge(rust, 'calls', 'rust-repo/lib.rs#get', 'rust-repo/lib.rs#depth')).toBeDefined();
  });
  it('use declarations become module imports', () => {
    expect(node(rust, 'module', 'rust-module:std::collections::HashMap')).toBeDefined();
  });
});

describe('tier2-java', () => {
  it('class/interface/method extraction + import', () => {
    expect(node(java, 'class', 'java-repo/App.java#App')).toBeDefined();
    expect(node(java, 'class', 'java-repo/Util.java#Renderer')?.metadata).toMatchObject({ declKind: 'interface' });
    expect(node(java, 'function', 'java-repo/App.java#boot')).toBeDefined();
    expect(node(java, 'module', 'java-module:java.util.List')).toBeDefined();
  });
  it('same-file call boot→step resolves', () => {
    expect(edge(java, 'calls', 'java-repo/App.java#boot', 'java-repo/App.java#step')).toBeDefined();
  });
});

describe('tier2-csharp', () => {
  it('extracts classes/interfaces/methods and alias-free imports', () => {
    expect(node(csharp, 'class', 'csharp-repo/App.cs#App')).toBeDefined();
    expect(node(csharp, 'class', 'csharp-repo/App.cs#IRenderer')?.metadata).toMatchObject({ declKind: 'interface' });
    expect(node(csharp, 'module', 'csharp-module:System')).toBeDefined();
    expect(node(csharp, 'module', 'csharp-module:System.Text')).toBeDefined();
    // The alias NAME must not become a module.
    expect(node(csharp, 'module', 'csharp-module:Alias')).toBeUndefined();
  });
  it('skips *.Build.cs by DOTTED suffix only — ScriptBuild.cs and CodeBuilder.cs survive', () => {
    expect(csharp.nodes.find((n) => n.qualifiedName.includes('Probe.Build.cs'))).toBeUndefined();
    expect(node(csharp, 'class', 'csharp-repo/CodeBuilder.cs#CodeBuilder')).toBeDefined();
    expect(node(csharp, 'class', 'csharp-repo/ScriptBuild.cs#ScriptBuild')).toBeDefined();
  });
  it('the supplementary bare-call query resolves same-file Boot→Step', () => {
    expect(edge(csharp, 'calls', 'csharp-repo/App.cs#Boot', 'csharp-repo/App.cs#Step')).toBeDefined();
  });
  it('reference.send resolves same-file member access without the bare-call fallback', async () => {
    const cfg = TIER2_CONFIGS.find((candidate) => candidate.id === 'csharp');
    if (!cfg) throw new Error('csharp config missing');
    const { extraRefQuery: _extraRefQuery, extraRefNodeTypes: _extraRefNodeTypes, ...tagsOnlyCfg } = cfg;
    const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'tier2-csharp-send-'));
    try {
      const source = fs.readFileSync(path.join(FIX('csharp-repo'), 'App.cs'), 'utf8')
        .replace('Step();', 'this.Step();');
      fs.writeFileSync(path.join(repo, 'App.cs'), source);
      const out = await makeTier2Extractor(tagsOnlyCfg).extract({ projectId: 'x', repoPaths: [repo] });
      const repoBase = path.basename(repo);
      expect(edge(out, 'calls', `${repoBase}/App.cs#Boot`, `${repoBase}/App.cs#Step`)).toBeDefined();
    } finally {
      fs.rmSync(repo, { recursive: true, force: true });
    }
  });
});

describe('tier-2 invariants', () => {
  it('partitions nested repos for every tier-2 engine independent of metadata order', async () => {
    const engines = [
      { ext: '.go', extractor: tier2GoExtractor, parent: 'package main\nfunc ParentOnly() {}\n', child: 'package main\nfunc ChildOnly() {}\n' },
      { ext: '.rs', extractor: tier2RustExtractor, parent: 'fn parent_only() {}\n', child: 'fn child_only() {}\n' },
      { ext: '.java', extractor: tier2JavaExtractor, parent: 'class ParentOnly {}\n', child: 'class ChildOnly {}\n' },
      { ext: '.cs', extractor: tier2CsharpExtractor, parent: 'class ParentOnly {}\n', child: 'class ChildOnly {}\n' },
    ];
    for (const engine of engines) {
      const parent = fs.mkdtempSync(path.join(os.tmpdir(), 'tier2-owned-'));
      const child = path.join(parent, 'child');
      try {
        fs.mkdirSync(child, { recursive: true });
        fs.writeFileSync(path.join(parent, `Parent${engine.ext}`), engine.parent);
        fs.writeFileSync(path.join(child, `Child${engine.ext}`), engine.child);
        const forward = await engine.extractor.extract({ projectId: 'x', repoPaths: [parent, child] });
        const reverse = await engine.extractor.extract({ projectId: 'x', repoPaths: [child, parent] });
        const signature = (value: ExtractorOutput): string[] => value.nodes.map((entry) => entry.qualifiedName).sort();
        expect(signature(forward)).toEqual(signature(reverse));
        expect(forward.nodes.filter((entry) => entry.kind === 'file' && entry.filePath === fs.realpathSync.native(path.join(child, `Child${engine.ext}`)))).toHaveLength(1);
        expect(forward.nodes.some((entry) => entry.qualifiedName.startsWith(`${path.basename(parent)}/child/`))).toBe(false);
      } finally {
        fs.rmSync(parent, { recursive: true, force: true });
      }
    }
  });
  it('every file-scoped symbol has a defines edge from its file', () => {
    for (const o of [go, rust, java, csharp]) {
      for (const n of o.nodes.filter((candidate) => candidate.filePath && candidate.qualifiedName.includes('#'))) {
        const fileQn = n.qualifiedName.slice(0, n.qualifiedName.indexOf('#'));
        expect(edge(o, 'defines', fileQn, n.qualifiedName), n.qualifiedName).toBeDefined();
      }
    }
  });
  it('every symbol qname is FILE-scoped (R5 — collision-free vs deep repo-scope)', () => {
    for (const o of [go, rust, java, csharp]) {
      for (const n of o.nodes) {
        if (n.kind === 'file' || n.kind === 'module') continue;
        // file-scoped shape: repoBase/<path with slash>#name
        expect(n.qualifiedName, n.qualifiedName).toMatch(/^[^#]+\/[^#]+#.+$/);
      }
    }
  });
  it('module nodes carry no filePath (external labels, many files meet at them)', () => {
    for (const o of [go, rust, java, csharp]) {
      for (const n of o.nodes.filter((x) => x.kind === 'module' && x.qualifiedName.includes('-module:'))) {
        expect(n.filePath).toBeUndefined();
      }
    }
  });
  it('registry sets are disjoint and tier-2 covers exactly the four extensions', () => {
    for (const ext of TIER2_EXTENSIONS) expect(DEEP_EXTENSIONS.has(ext)).toBe(false);
    expect([...TIER2_EXTENSIONS].sort()).toEqual(['.cs', '.go', '.java', '.rs']);
  });
  it('a renamed known capture makes the first extract throw the named error (R4a)', async () => {
    const base = TIER2_CONFIGS[0];
    if (!base) throw new Error('go config missing');
    const broken = makeTier2Extractor({ ...base, knownCaptures: new Set(['name']) });
    await expect(broken.extract({ projectId: 'x', repoPaths: [FIX('go-repo')] }))
      .rejects.toThrow(/not in the known set/);
  });
  it('a bogus import node type makes the first extract throw the named error (R4b)', async () => {
    const base = TIER2_CONFIGS[0];
    if (!base) throw new Error('go config missing');
    const broken = makeTier2Extractor({ ...base, importNodeTypes: ['no_such_node_type'] });
    await expect(broken.extract({ projectId: 'x', repoPaths: [FIX('go-repo')] }))
      .rejects.toThrow(/does not exist in the vendored grammar/);
  });
  it('changedFiles is deliberately ignored — full-rerun semantics (spec A3)', async () => {
    const only = path.join(FIX('go-repo'), 'util.go');
    const out = await tier2GoExtractor.extract({ projectId: 'x', repoPaths: [FIX('go-repo')], changedFiles: [only] });
    // BOTH files extracted despite the narrowed changedFiles — the full-rerun
    // guarantee that keeps fileless module labels from going permanently stale.
    expect(out.nodes.find((n) => n.qualifiedName === 'go-repo/util.go')).toBeDefined();
    expect(out.nodes.find((n) => n.qualifiedName === 'go-repo/main.go')).toBeDefined();
  });
});
