/** ue-module extractor over the committed cpp-repo fixture — pure, no DB. */
import { beforeAll, describe, expect, it } from 'vitest';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ueModuleExtractor, parseBuildCs, parseUplugin } from '../graph/extractors/ue-module.js';
import type { ExtractorOutput, ExtractedNode, ExtractedEdge } from '../graph/types.js';

const FIXTURE = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures', 'cpp-repo');
let out: ExtractorOutput;
beforeAll(async () => {
  out = await ueModuleExtractor.extract({ projectId: 'x', repoPaths: [FIXTURE] });
});
const B = 'cpp-repo';

describe('ue-module extractor', () => {
  it('keeps nested manifests and module configs with their longest-prefix owner', async () => {
    const parent = fs.mkdtempSync(path.join(os.tmpdir(), 'ue-owned-'));
    const child = path.join(parent, 'child');
    try {
      fs.mkdirSync(child, { recursive: true });
      fs.writeFileSync(path.join(parent, 'Parent.Build.cs'), 'PublicDependencyModuleNames.Add("Core");\n');
      fs.writeFileSync(path.join(child, 'Child.Build.cs'), 'PublicDependencyModuleNames.Add("UMG");\n');
      const forward = await ueModuleExtractor.extract({ projectId: 'x', repoPaths: [parent, child] });
      const reverse = await ueModuleExtractor.extract({ projectId: 'x', repoPaths: [child, parent] });
      const signature = (value: ExtractorOutput): string[] => value.nodes.map((entry) => entry.qualifiedName).sort();
      expect(signature(forward)).toEqual(signature(reverse));
      expect(forward.nodes.filter((entry) => entry.qualifiedName === 'child::Child')).toHaveLength(1);
      expect(forward.nodes.some((entry) => entry.qualifiedName === `${path.basename(parent)}::Child`)).toBe(false);
    } finally {
      fs.rmSync(parent, { recursive: true, force: true });
    }
  });
  it('emits module nodes from .Build.cs and .uplugin', () => {
    expect(out.nodes.find((n) => n.qualifiedName === `${B}::SampleUE`)).toBeDefined();
    expect(out.nodes.find((n) => n.qualifiedName === `${B}::SampleUEEditor`)?.metadata).toMatchObject({ type: 'Editor' });
  });
  it('emits depends_on edges for Public + Private deps across all three syntax forms', () => {
    const dep = (to: string) =>
      out.edges.find((e) => e.relation === 'depends_on' && e.from.qualifiedName === `${B}::SampleUE` && e.to.qualifiedName === `${B}::${to}`);
    expect(dep('Core')).toBeDefined(); // new[] { … } (implicitly typed — the real-world form)
    expect(dep('CoreUObject')).toBeDefined();
    expect(dep('Slate')).toBeDefined(); // new string[] { … }
    expect(dep('UMG')).toBeDefined(); // .Add("…")
  });
});

describe('UE defining text evidence', () => {
  const digest = (text: string): string => createHash('sha256').update(text).digest('hex');
  const makeSink = () => ({ nodes: new Array<ExtractedNode>(), edges: new Array<ExtractedEdge>(), seen: new Set<string>() });

  it('hashes supplied Build.cs and plugin text while dependencies remain fileless', () => {
    const sink = makeSink();
    const buildText = 'PublicDependencyModuleNames.Add("Core");\n';
    const pluginText = '{ "Modules": [{ "Name": "Editor", "Type": "Editor" }] }\n';
    parseBuildCs(buildText, 'Game.Build.cs', 'evidence', '/fictional-evidence-repo/Game.Build.cs', sink);
    parseUplugin(pluginText, 'evidence', '/fictional-evidence-repo/Game.uplugin', sink);
    expect(sink.nodes.find(entry => entry.name === 'Game')).toMatchObject({ contentHash: digest(buildText) });
    expect(sink.nodes.find(entry => entry.name === 'Editor')).toMatchObject({ contentHash: digest(pluginText), metadata: { type: 'Editor' } });
    const core = sink.nodes.find(entry => entry.name === 'Core');
    expect(core).toBeDefined();
    expect(core?.filePath).toBeUndefined();
    expect(core?.contentHash).toBeUndefined();
  });

  it('keeps the hash with the first emitted owner, including dependency-first modules', () => {
    const sink = makeSink();
    const pluginText = '{"Modules":[{"Name":"Game","Type":"Runtime"}]}';
    parseUplugin(pluginText, 'evidence', '/fictional-evidence-repo/Game.uplugin', sink);
    parseBuildCs('PublicDependencyModuleNames.Add("Later");', 'Game.Build.cs', 'evidence', '/fictional-evidence-repo/Game.Build.cs', sink);
    parseBuildCs('public class Later {}', 'Later.Build.cs', 'evidence', '/fictional-evidence-repo/Later.Build.cs', sink);
    expect(sink.nodes.filter(entry => entry.name === 'Game')).toHaveLength(1);
    expect(sink.nodes.find(entry => entry.name === 'Game')).toMatchObject({
      filePath: '/fictional-evidence-repo/Game.uplugin', contentHash: digest(pluginText), metadata: { type: 'Runtime' },
    });
    const later = sink.nodes.find(entry => entry.name === 'Later');
    expect(later).toBeDefined();
    expect(later?.filePath).toBeUndefined();
    expect(later?.contentHash).toBeUndefined();
  });

  it('matches the retained defining file for each fixture module', () => {
    const backed = out.nodes.filter(entry => entry.filePath !== undefined);
    expect(backed.length).toBeGreaterThanOrEqual(2);
    for (const entry of backed) {
      if (entry.filePath === undefined) throw new Error('missing fixture path');
      expect(entry.contentHash).toBe(digest(fs.readFileSync(entry.filePath, 'utf8')));
    }
  });
});
