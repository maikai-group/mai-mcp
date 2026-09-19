/** cpp extractor over the committed cpp-repo fixture — pure, no DB. */
import { beforeAll, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { cppExtractor } from '../graph/extractors/cpp.js';
import type { ExtractorOutput } from '../graph/types.js';

const FIXTURE = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures', 'cpp-repo');
let out: ExtractorOutput;
beforeAll(async () => {
  out = await cppExtractor.extract({ projectId: 'x', repoPaths: [FIXTURE] });
});

const node = (kind: string, qn: string) => out.nodes.find((n) => n.kind === kind && n.qualifiedName === qn);
const edge = (rel: string, fromQn: string, toQn: string) =>
  out.edges.find((e) => e.relation === rel && e.from.qualifiedName === fromQn && e.to.qualifiedName === toQn);
const B = 'cpp-repo';

describe('cpp extractor', () => {
  it('partitions nested registered repos independent of metadata order', async () => {
    const parent = fs.mkdtempSync(path.join(os.tmpdir(), 'cpp-owned-'));
    const child = path.join(parent, 'child');
    try {
      fs.mkdirSync(child, { recursive: true });
      fs.writeFileSync(path.join(parent, 'Parent.cpp'), 'class ParentOnly {};\n');
      fs.writeFileSync(path.join(child, 'Child.cpp'), 'class ChildOnly {};\n');
      const forward = await cppExtractor.extract({ projectId: 'x', repoPaths: [parent, child] });
      const reverse = await cppExtractor.extract({ projectId: 'x', repoPaths: [child, parent] });
      const signature = (value: ExtractorOutput): string[] => value.nodes
        .filter((entry) => entry.kind === 'file' || entry.kind === 'class')
        .map((entry) => entry.qualifiedName)
        .sort();
      expect(signature(forward)).toEqual(signature(reverse));
      expect(forward.nodes.filter((entry) => entry.filePath === fs.realpathSync.native(path.join(child, 'Child.cpp')) && entry.kind === 'file')).toHaveLength(1);
      expect(forward.nodes.some((entry) => entry.qualifiedName === `${path.basename(parent)}#ChildOnly`)).toBe(false);
      expect(forward.nodes.some((entry) => entry.qualifiedName === 'child#ChildOnly')).toBe(true);
    } finally {
      fs.rmSync(parent, { recursive: true, force: true });
    }
  });
  it('emits file nodes', () => {
    expect(node('file', `${B}/Foo.cpp`)).toBeDefined();
    expect(node('file', `${B}/Foo.h`)).toBeDefined();
  });
  it('resolves quoted includes to file→file imports; drops system + generated', () => {
    expect(edge('imports', `${B}/Foo.cpp`, `${B}/Foo.h`)).toBeDefined();
  });
  it('emits class nodes with namespace-scoped qns', () => {
    expect(node('class', `${B}#App::AMyActor`)).toBeDefined();
    expect(node('class', `${B}#App::ABaseThing`)).toBeDefined();
  });
  it('maps .h declaration and .cpp definition to ONE method node', () => {
    // Tick(float) declared in Foo.h, defined in Foo.cpp → single node.
    const ticks = out.nodes.filter((n) => n.kind === 'function' && n.name === 'Tick');
    // one base + one overload variant = 2 distinct symbol nodes, not 4.
    expect(ticks.length).toBe(2);
  });
  it('emits class→method ownership defines', () => {
    expect(edge('defines', `${B}#App::AMyActor`, `${B}#App::AMyActor::Tick`)).toBeDefined();
  });
  it('emits inherits to in-repo base, drops external base (AActor)', () => {
    expect(edge('inherits', `${B}#App::AMyActor`, `${B}#App::ABaseThing`)).toBeDefined();
    expect(out.edges.some((e) => e.relation === 'inherits' && e.to.qualifiedName.includes('AActor'))).toBe(false);
  });
  it('resolves cross-TU calls; overloaded callee → inferred', () => {
    // Foo.cpp Tick(float) calls Count() and Helper(); the second Tick calls Tick.
    expect(out.edges.some((e) => e.relation === 'calls')).toBe(true);
    const overloadCalls = out.edges.filter((e) => e.relation === 'calls' && e.to.qualifiedName.includes('Tick'));
    expect(overloadCalls.some((e) => e.confidence === 'inferred')).toBe(true);
  });
  it('free-function declarations become nodes so calls to them resolve', () => {
    expect(node('function', `${B}#App::Helper`)).toBeDefined();
    expect(edge('calls', `${B}#App::AMyActor::Tick`, `${B}#App::Helper`)).toBeDefined();
  });
  it('UPROPERTY fields aggregate on the owning class metadata (spec §4.4)', () => {
    const props = node('class', `${B}#App::AMyActor`)?.metadata?.properties;
    expect(props).toEqual(['n']);
  });
  it('parses through UE *_API export macros — real name, bases, methods survive', () => {
    expect(node('class', `${B}#App::FExported`)).toBeDefined();
    expect(node('class', `${B}#App::GAMEUE_API`)).toBeUndefined();
    expect(edge('inherits', `${B}#App::FExported`, `${B}#App::ABaseThing`)).toBeDefined();
    expect(edge('defines', `${B}#App::FExported`, `${B}#App::FExported::Pump`)).toBeDefined();
  });
  it('tags UE reflection metadata', () => {
    expect(node('class', `${B}#App::AMyActor`)?.metadata).toMatchObject({ reflected: true });
    const bp = out.nodes.find((n) => n.kind === 'function' && n.name === 'Tick' && n.metadata?.blueprintCallable === true);
    expect(bp).toBeDefined();
  });
  it('pointer/reference return types no longer drop the function (plan 35 R5)', () => {
    // .h declaration + fully-qualified .cpp definition of sibling() converge on ONE node.
    expect(node('function', `${B}#App::WidgetHost::sibling`)).toBeDefined();
    expect(node('function', `${B}#App::WidgetHost::self`)).toBeDefined();
    expect(node('function', `${B}#App::makeHost`)).toBeDefined();
    expect(out.nodes.filter((n) => n.kind === 'function' && n.name === 'sibling').length).toBe(1);
    expect(out.nodes.filter((n) => n.kind === 'function' && n.name === 'makeHost').length).toBe(1);
  });
  it('JUCE body-terminal macros are blanked — both file-scope classes survive (plan 35 R6)', () => {
    // Raw, Juce.h parses to 0 classes (grammar-probed); these assertions can
    // only pass through the blanking path.
    expect(node('class', `${B}#MacroPanelA`)).toBeDefined();
    expect(node('class', `${B}#MacroPanelB`)).toBeDefined();
    expect(edge('defines', `${B}#MacroPanelA`, `${B}#MacroPanelA::pump`)).toBeDefined();
    expect(edge('defines', `${B}#MacroPanelB`, `${B}#MacroPanelB::go`)).toBeDefined();
    // The macro token itself must never become a node.
    expect(out.nodes.some((n) => n.name.includes('JUCE'))).toBe(false);
  });
});
