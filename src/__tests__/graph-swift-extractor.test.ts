/** swift extractor over the committed swift-repo fixture — pure, no DB. */
import { beforeAll, describe, expect, it, vi } from 'vitest';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { moduleSegOf, swiftExtractor } from '../graph/extractors/swift.js';
import { GRAPH_RELATIONS, NODE_KINDS } from '../graph/registry.js';
import type { ExtractorOutput } from '../graph/types.js';

const FIXTURE = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures', 'swift-repo');
let out: ExtractorOutput;
let tallyLines: string[] = [];
beforeAll(async () => {
  const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
  out = await swiftExtractor.extract({ projectId: 'x', repoPaths: [FIXTURE] });
  tallyLines = warn.mock.calls.map((c) => String(c[0]));
  warn.mockRestore();
});

const node = (kind: string, qn: string) => out.nodes.find((n) => n.kind === kind && n.qualifiedName === qn);
const edge = (rel: string, fromQn: string, toQn: string) =>
  out.edges.find((e) => e.relation === rel && e.from.qualifiedName === fromQn && e.to.qualifiedName === toQn);
const B = 'swift-repo';
const MAC = 'mac/Sources/FixtureKit';

describe('swift extractor — module keying (the triplicate-tree protection)', () => {
  it('partitions nested registered repos independent of metadata order', async () => {
    const fs = await import('node:fs');
    const os = await import('node:os');
    const parent = fs.mkdtempSync(path.join(os.tmpdir(), 'swift-owned-'));
    const child = path.join(parent, 'child');
    try {
      fs.mkdirSync(child, { recursive: true });
      fs.writeFileSync(path.join(parent, 'Parent.swift'), 'class ParentOnly {}\n');
      fs.writeFileSync(path.join(child, 'Child.swift'), 'class ChildOnly {}\n');
      const forward = await swiftExtractor.extract({ projectId: 'x', repoPaths: [parent, child] });
      const reverse = await swiftExtractor.extract({ projectId: 'x', repoPaths: [child, parent] });
      const signature = (value: ExtractorOutput): string[] => value.nodes
        .filter((entry) => entry.kind === 'file' || entry.kind === 'class')
        .map((entry) => entry.qualifiedName)
        .sort();
      expect(signature(forward)).toEqual(signature(reverse));
      expect(forward.nodes.filter((entry) => entry.filePath === fs.realpathSync.native(path.join(child, 'Child.swift')) && entry.kind === 'file')).toHaveLength(1);
      expect(forward.nodes.some((entry) => entry.name === 'ChildOnly' && entry.qualifiedName.startsWith(`${path.basename(parent)}#`))).toBe(false);
      expect(forward.nodes.some((entry) => entry.name === 'ChildOnly' && entry.qualifiedName.startsWith('child#'))).toBe(true);
    } finally {
      fs.rmSync(parent, { recursive: true, force: true });
    }
  });
  it('NON-GIT fs-walk path: sibling SPM targets stay distinct modules (pass-3 repair — sorted enumeration)', async () => {
    // A scratch dir is NOT a git repo → listRepoFiles takes the fs-walk
    // fallback whose readdir order is arbitrary; the core's sort guarantees
    // pkg/Package.swift is seen before pkg/Sources/{A,B}/… regardless.
    const fs = await import('node:fs');
    const os = await import('node:os');
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'swift-walk-'));
    try {
      fs.mkdirSync(path.join(dir, 'pkg', 'Sources', 'A'), { recursive: true });
      fs.mkdirSync(path.join(dir, 'pkg', 'Sources', 'B'), { recursive: true });
      fs.writeFileSync(path.join(dir, 'pkg', 'Package.swift'), '// swift-tools-version:5.9\nimport PackageDescription\nlet package = Package(name: "P", targets: [.target(name: "A"), .target(name: "B")])\n');
      fs.writeFileSync(path.join(dir, 'pkg', 'Sources', 'A', 'Engine.swift'), 'class Engine {\n}\n');
      fs.writeFileSync(path.join(dir, 'pkg', 'Sources', 'B', 'Engine.swift'), 'class Engine {\n}\n');
      const o = await swiftExtractor.extract({ projectId: 'x', repoPaths: [dir] });
      const engines = o.nodes.filter((n) => n.kind === 'class' && n.name === 'Engine').map((n) => n.qualifiedName).sort();
      const base = path.basename(dir);
      expect(engines).toEqual([`${base}#pkg/Sources/A#Engine`, `${base}#pkg/Sources/B#Engine`]);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
  it('ROOT Package.swift: every non-target file shares ONE module segment regardless of sort position (pass-5 repair)', async () => {
    const fs = await import('node:fs');
    const os = await import('node:os');
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'swift-rootpkg-'));
    try {
      // Base/ sorts BEFORE Package.swift, Views/ after — preEnumerate must
      // make that difference invisible.
      fs.mkdirSync(path.join(dir, 'Base'), { recursive: true });
      fs.mkdirSync(path.join(dir, 'Views'), { recursive: true });
      fs.writeFileSync(path.join(dir, 'Package.swift'), '// swift-tools-version:5.9\nimport PackageDescription\nlet package = Package(name: "P")\n');
      fs.writeFileSync(path.join(dir, 'Base', 'A.swift'), 'class Alpha {\n}\n');
      fs.writeFileSync(path.join(dir, 'Views', 'B.swift'), 'class Beta {\n}\n');
      const o = await swiftExtractor.extract({ projectId: 'x', repoPaths: [dir] });
      const mods = o.nodes
        .filter((n) => n.kind === 'class')
        .map((n) => n.qualifiedName.split('#')[1]);
      expect(new Set(mods).size).toBe(1); // one governed module, never split by the alphabet
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
  it('moduleSegOf: SPM target dir when governed, top dir otherwise, longest pkg first', () => {
    expect(moduleSegOf('mac/Sources/FixtureKit/Engine.swift', ['mac'])).toBe('mac/Sources/FixtureKit');
    expect(moduleSegOf('mac/Tests/FixtureKitTests/T.swift', ['mac'])).toBe('mac/Tests/FixtureKitTests');
    expect(moduleSegOf('ios/Engine.swift', ['mac'])).toBe('ios');
    expect(moduleSegOf('mac/Other.swift', ['mac'])).toBe('mac');
    expect(moduleSegOf('Lone.swift', [])).toBe('(root)');
  });
  it('the two Engine classes stay TWO nodes', () => {
    expect(node('class', `${B}#${MAC}#Engine`)).toBeDefined();
    expect(node('class', `${B}#ios#Engine`)).toBeDefined();
    expect(out.nodes.filter((n) => n.kind === 'class' && n.name === 'Engine').length).toBe(2);
  });
  it('resolution never crosses trees when the same-module symbol exists', () => {
    // ios DemoApp.main calls Engine() and e.start() — both must stay in ios.
    expect(edge('calls', `${B}#ios#DemoApp::main`, `${B}#ios#Engine`)).toBeDefined();
    expect(edge('calls', `${B}#ios#DemoApp::main`, `${B}#${MAC}#Engine`)).toBeUndefined();
  });
});

describe('swift extractor — language structure', () => {
  it('declKind metadata across the variety', () => {
    expect(node('class', `${B}#${MAC}#Discovering`)?.metadata?.declKind).toBe('protocol');
    expect(node('class', `${B}#${MAC}#Payload`)?.metadata?.declKind).toBe('struct');
    expect(node('class', `${B}#${MAC}#Mode`)?.metadata?.declKind).toBe('enum');
    expect(node('class', `${B}#ios#DemoApp`)?.metadata?.declKind).toBe('struct');
  });
  it('class —defines→ method ownership; arity is the overload disambiguator', () => {
    expect(edge('defines', `${B}#${MAC}#Engine`, `${B}#${MAC}#Engine::start`)).toBeDefined();
    // The spec-mandated overload pair: same name, arities 0 and 1 → two nodes
    // with insertion-order qns (spec §4; core overload semantics).
    expect(node('function', `${B}#${MAC}#render`)).toBeDefined();
    expect(node('function', `${B}#${MAC}#render/1`)).toBeDefined();
    expect(out.nodes.filter((n) => n.kind === 'function' && n.name === 'render').length).toBe(2);
  });
  it('@main and main.swift entrypoints are flagged; property wrappers land in metadata.wrappers', () => {
    expect(node('class', `${B}#ios#DemoApp`)?.metadata?.entrypoint).toBe('main');
    expect(node('file', `${B}/ios/main.swift`)?.metadata?.entrypoint).toBe('main');
    expect(node('class', `${B}#ios#DemoApp`)?.metadata?.wrappers).toEqual(['State']);
  });
  it('initializers are arity-disambiguated function nodes owned by their type (spec §4, pass-2 repair)', () => {
    const init = node('function', `${B}#${MAC}#Engine::init`);
    expect(init?.metadata?.initializer).toBe(true);
    expect(edge('defines', `${B}#${MAC}#Engine`, `${B}#${MAC}#Engine::init`)).toBeDefined();
    // Calls inside the initializer BODY originate from the init node, not
    // the file (pass-3 repair).
    expect(edge('calls', `${B}#${MAC}#Engine::init`, `${B}#${MAC}#helper`)).toBeDefined();
  });
  it('spec excludes hold on the GIT enumeration path (.build/ vendored tree)', () => {
    expect(out.nodes.some((n) => n.filePath?.includes('/.build/'))).toBe(false);
    expect(out.nodes.some((n) => n.name === 'VendoredDep')).toBe(false);
  });
  it('Package.swift emits a file node but NO declarations', () => {
    expect(node('file', `${B}/mac/Package.swift`)).toBeDefined();
    expect(out.nodes.some((n) => n.kind !== 'file' && n.filePath?.endsWith('Package.swift'))).toBe(false);
  });
});

describe('swift extractor — semantics', () => {
  it('conformance and superclass resolve same-module at extracted; REAL external bases drop', () => {
    expect(edge('inherits', `${B}#${MAC}#Engine`, `${B}#${MAC}#Base`)).toBeDefined();
    expect(edge('inherits', `${B}#${MAC}#Engine`, `${B}#${MAC}#Discovering`)).toBeDefined();
    // Legacy: NSObject — the external drop is a real branch now, not a
    // vacuous Foundation-substring check (pass-2 repair); tallied below.
    expect(out.edges.some((e) => e.relation === 'inherits' && e.from.qualifiedName === `${B}#${MAC}#Legacy`)).toBe(false);
  });
  it('protocol inheritance queues like class inheritance; external parents drop + tally (pass-2 repair)', () => {
    expect(out.edges.some((e) => e.relation === 'inherits' && e.from.qualifiedName === `${B}#${MAC}#Discovering`)).toBe(false); // Codable is external
  });
  it('same-module extension members converge onto the extended type', () => {
    expect(edge('defines', `${B}#${MAC}#Engine`, `${B}#${MAC}#Engine::stop`)).toBeDefined();
    expect(node('function', `${B}#${MAC}#Engine::stop`)?.metadata?.viaExtension).toBe(true);
    expect(node('function', `${B}#${MAC}#Engine::stop`)?.metadata?.extends).toBeUndefined();
  });
  it('unique-in-repo extension members RE-KEY onto the one matching type and JOIN its overload list (spec §4 ladder, pass-2 + pass-7 repairs)', () => {
    // The target declares tag() (base qn); the ios extension declares
    // tag(_ count:) (arity 1) — a valid overload pair split across type and
    // extension. Identity-aware re-key allocates /1 with ensureDecl's rule;
    // qn-occupancy rejection would have wrongly externalized it (pass-7).
    const base = node('function', `${B}#${MAC}#Payload::tag`);
    expect(base).toBeDefined();
    expect(base?.metadata?.viaExtension).toBeUndefined(); // the type's own method
    // TWO different-arity extension overloads — the second's own qn already
    // carries an insertion-order /1 before re-key, the exact shape whose
    // suffix must never leak into the semantic key (pass-8 repair).
    for (const suffix of ['/1', '/2']) {
      const ext = node('function', `${B}#${MAC}#Payload::tag${suffix}`);
      expect(ext).toBeDefined();
      expect(ext?.metadata?.viaExtension).toBe(true);
      expect(ext?.metadata?.extends).toBeUndefined(); // converged, not external
      expect(edge('defines', `${B}#${MAC}#Payload`, `${B}#${MAC}#Payload::tag${suffix}`)).toBeDefined();
    }
    // Nothing remains under the ios key they were first emitted with.
    expect(out.nodes.some((n) => n.qualifiedName.startsWith(`${B}#ios#Payload`))).toBe(false);
  });
  it('re-key moves QUEUED intents too: the extension conformance and member calls use the converged qn (pass-3 repair)', () => {
    // Both endpoints exist; the source is the converged class, never the
    // synthetic ios#Payload that has no node.
    const conf = edge('inherits', `${B}#${MAC}#Payload`, `${B}#${MAC}#Discovering`);
    expect(conf?.confidence).toBe('inferred'); // cross-module unique-short
    expect(out.edges.some((e) => e.from.qualifiedName === `${B}#ios#Payload` || e.to.qualifiedName === `${B}#ios#Payload`)).toBe(false);
  });
  it('CONFORMANCE-ONLY extensions ladder their intents without any member node (pass-5/6 converged finding)', () => {
    // `extension Mode: Discovering {}` in ios has zero members — the intent
    // sweep alone must land the edge on the real MAC enum.
    expect(edge('inherits', `${B}#${MAC}#Mode`, `${B}#${MAC}#Discovering`)).toBeDefined();
    expect(out.edges.some((e) => e.from.qualifiedName === `${B}#ios#Mode` || e.to.qualifiedName === `${B}#ios#Mode`)).toBe(false);
  });
  it('same-module MULTI-overload calls drop-and-tally, never guess the first overload (pass-6 repair)', () => {
    // Base.ping calls render() — two same-module overloads → no edge.
    expect(out.edges.some((e) => e.relation === 'calls' && e.from.qualifiedName === `${B}#${MAC}#Base::ping`)).toBe(false);
  });
  it('external-type extension members stay file-scoped with metadata.extends', () => {
    const slug = node('function', `${B}#${MAC}#String::slugified`);
    expect(slug?.metadata?.extends).toBe('String');
  });
  it('cross-module constructor call resolves by unique short name at inferred', () => {
    const call = edge('calls', `${B}#ios#Engine::start`, `${B}#${MAC}#Payload`);
    expect(call?.confidence).toBe('inferred');
  });
  it('free-function calls resolve (helper from Engine.start)', () => {
    expect(edge('calls', `${B}#${MAC}#Engine::start`, `${B}#${MAC}#helper`)).toBeDefined();
  });
});

describe('swift extractor — invariants', () => {
  it('never emits an empty name or qualifiedName', () => {
    for (const n of out.nodes) {
      expect(n.name.trim()).not.toBe('');
      expect(n.qualifiedName.trim()).not.toBe('');
    }
  });
  it('emits only registered kinds and relations', () => {
    for (const n of out.nodes) expect(NODE_KINDS).toContain(n.kind);
    for (const e of out.edges) expect(GRAPH_RELATIONS).toContain(e.relation);
  });
  it('no self-edges', () => {
    for (const e of out.edges) expect(e.from.qualifiedName).not.toBe(e.to.qualifiedName);
  });
  it('emits the always-on machine-parseable tally line EXACTLY (R8)', () => {
    // Deterministic from the fixture: lowercased() = the unresolved call;
    // e.start() (three short-name candidates) + Base.ping's render() (two
    // same-module overloads) = the two ambiguous calls; Codable + NSObject
    // = the two external bases; String = the one external extension
    // (Payload and Mode both ladder, so neither is counted);
    // mac/Package.swift = the one manifest.
    expect(tallyLines).toContain(
      'swift-tally swift-repo unresolved_calls=1 ambiguous_calls=2 unresolved_inherits=2 ambiguous_inherits=0 external_extensions=1 package_manifests=1'
    );
  });
});
