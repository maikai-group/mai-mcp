/** kotlin extractor over the committed kotlin-repo fixture — pure, no DB. */
import { beforeAll, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { kotlinExtractor } from '../graph/extractors/kotlin.js';
import { GRAPH_RELATIONS, NODE_KINDS } from '../graph/registry.js';
import type { ExtractorOutput } from '../graph/types.js';

const FIXTURE = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures', 'kotlin-repo');
let out: ExtractorOutput;
let tallyLines: string[] = [];
beforeAll(async () => {
  // The tally line is emitted via console.warn (core report contract, R8) —
  // captured here so the suite asserts it EXACTLY, not just "printed".
  const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
  out = await kotlinExtractor.extract({ projectId: 'x', repoPaths: [FIXTURE] });
  tallyLines = warn.mock.calls.map((c) => String(c[0]));
  warn.mockRestore();
});

const node = (kind: string, qn: string) => out.nodes.find((n) => n.kind === kind && n.qualifiedName === qn);
const edge = (rel: string, fromQn: string, toQn: string) =>
  out.edges.find((e) => e.relation === rel && e.from.qualifiedName === fromQn && e.to.qualifiedName === toQn);
const B = 'kotlin-repo';

describe('kotlin extractor — language structure', () => {
  it('keeps nested source, settings, Gradle, and manifest context with the longest-prefix owner', async () => {
    const parent = fs.mkdtempSync(path.join(os.tmpdir(), 'kotlin-owned-'));
    const child = path.join(parent, 'child');
    try {
      fs.mkdirSync(path.join(parent, 'parent', 'src', 'main', 'kotlin'), { recursive: true });
      fs.mkdirSync(path.join(child, 'child', 'src', 'main', 'kotlin'), { recursive: true });
      fs.writeFileSync(path.join(child, 'settings.gradle.kts'), 'include(":child")\n');
      fs.symlinkSync(path.join(child, 'settings.gradle.kts'), path.join(parent, 'settings.gradle.kts'));
      fs.writeFileSync(path.join(parent, 'parent', 'src', 'main', 'kotlin', 'Parent.kt'), 'package owned.parent\nclass ParentOnly\n');
      fs.writeFileSync(path.join(child, 'child', 'src', 'main', 'kotlin', 'Child.kt'), 'package owned.child\nclass ChildOnly\n');
      const forward = await kotlinExtractor.extract({ projectId: 'x', repoPaths: [parent, child] });
      const reverse = await kotlinExtractor.extract({ projectId: 'x', repoPaths: [child, parent] });
      const signature = (value: ExtractorOutput): string[] => value.nodes.map((entry) => entry.qualifiedName).sort();
      expect(signature(forward)).toEqual(signature(reverse));
      expect(forward.nodes.filter((entry) => entry.filePath === fs.realpathSync.native(path.join(child, 'child', 'src', 'main', 'kotlin', 'Child.kt')) && entry.kind === 'file')).toHaveLength(1);
      expect(forward.nodes.some((entry) => entry.qualifiedName === `${path.basename(parent)}#owned.child.ChildOnly`)).toBe(false);
      expect(forward.nodes.some((entry) => entry.qualifiedName === 'child#owned.child.ChildOnly')).toBe(true);
      expect(forward.nodes.some((entry) => entry.qualifiedName === `${path.basename(parent)}#gradle:child`)).toBe(false);
      expect(forward.nodes.some((entry) => entry.qualifiedName === 'child#gradle:child')).toBe(true);
    } finally {
      fs.rmSync(parent, { recursive: true, force: true });
    }
  });
  it('emits file nodes with lang kotlin', () => {
    expect(node('file', `${B}/core/src/main/kotlin/com/fix/core/Loader.kt`)?.lang).toBe('kotlin');
  });
  it('package-scoped class qns with declKind metadata', () => {
    expect(node('class', `${B}#com.fix.app.MainActivity`)?.metadata?.declKind).toBe('class');
    expect(node('class', `${B}#com.fix.core.Refreshable`)?.metadata?.declKind).toBe('interface');
    expect(node('class', `${B}#com.fix.core.Loader`)?.metadata?.declKind).toBe('object');
    expect(node('class', `${B}#com.fix.core.Mode`)?.metadata?.declKind).toBe('enum');
  });
  it('data/sealed land in modifiers metadata', () => {
    expect(node('class', `${B}#com.fix.core.Circle`)?.metadata?.modifiers).toContain('data');
    expect(node('class', `${B}#com.fix.core.Shape`)?.metadata?.modifiers).toContain('sealed');
  });
  it('members use :: and are owned by their class; top-level functions use .', () => {
    expect(edge('defines', `${B}#com.fix.app.MainActivity`, `${B}#com.fix.app.MainActivity::boot`)).toBeDefined();
    expect(edge('defines', `${B}#com.fix.core.Loader`, `${B}#com.fix.core.Loader::warm`)).toBeDefined();
    expect(node('function', `${B}#com.fix.core.lookup`)).toBeDefined();
  });
  it('extension function: receiver metadata, file-owned, NO edge to receiver (spec §3)', () => {
    const slug = node('function', `${B}#com.fix.core.slugify`);
    expect(slug?.metadata?.receiver).toBe('String');
    expect(out.edges.some((e) => e.to.qualifiedName === slug?.qualifiedName && e.relation !== 'defines')).toBe(false);
  });
  it('companion members fold into the enclosing class scope (spec §3)', () => {
    // companion_object contributes nothing to the scope path — the key is
    // Registry::open, never Registry.Companion::open.
    expect(edge('defines', `${B}#com.fix.core.Registry`, `${B}#com.fix.core.Registry::open`)).toBeDefined();
    expect(out.nodes.some((n) => n.qualifiedName.includes('Companion'))).toBe(false);
  });
  it('annotation classes carry declKind annotation (spec §3, pass-2 repair)', () => {
    expect(node('class', `${B}#com.fix.core.Marker`)?.metadata?.declKind).toBe('annotation');
  });
  it('primary + secondary constructors are arity-disambiguated function nodes owned by the class (spec §3, pass-2 repair)', () => {
    expect(node('function', `${B}#com.fix.core.Widget::Widget`)?.metadata?.ctor).toBe('primary');
    expect(node('function', `${B}#com.fix.core.Widget::Widget/1`)?.metadata?.ctor).toBe('secondary');
    expect(edge('defines', `${B}#com.fix.core.Widget`, `${B}#com.fix.core.Widget::Widget`)).toBeDefined();
    expect(out.nodes.filter((n) => n.kind === 'function' && n.name === 'Widget').length).toBe(2);
    // Circle's primary constructor rides the same capture (data class with a
    // parameter list) — present, primary, class-owned.
    expect(node('function', `${B}#com.fix.core.Circle::Circle`)?.metadata?.ctor).toBe('primary');
    // Calls inside a secondary-constructor BODY originate from the ctor node,
    // not the file (pass-3 repair).
    expect(edge('calls', `${B}#com.fix.core.Widget::Widget/1`, `${B}#com.fix.core.lookup`)).toBeDefined();
  });
  it('ordinary overloads stay distinct nodes via the arity disambiguator (pass-2 repair)', () => {
    expect(node('function', `${B}#com.fix.core.fmt`)).toBeDefined();
    expect(node('function', `${B}#com.fix.core.fmt/1`)).toBeDefined();
  });
});

describe('kotlin extractor — semantics', () => {
  it('in-repo import resolves to the defining file; external imports drop', () => {
    expect(edge('imports', `${B}/app/src/main/kotlin/com/fix/app/MainActivity.kt`, `${B}/core/src/main/kotlin/com/fix/core/Loader.kt`)).toBeDefined();
    expect(out.edges.some((e) => e.relation === 'imports' && e.to.qualifiedName.includes('androidx'))).toBe(false);
  });
  it('an import of a TOP-LEVEL FUNCTION resolves to its defining file (pass-1 repair)', () => {
    expect(edge('imports', `${B}/app/src/main/kotlin/com/fix/app/MainActivity.kt`, `${B}/core/src/main/kotlin/com/fix/core/Util.kt`)).toBeDefined();
  });
  it('inherits ladder: same-package extracted; unique-short inferred; external dropped; AMBIGUOUS dropped', () => {
    const same = edge('inherits', `${B}#com.fix.core.Circle`, `${B}#com.fix.core.Shape`);
    expect(same?.confidence ?? 'extracted').toBe('extracted');
    const short = edge('inherits', `${B}#com.fix.app.MainActivity`, `${B}#com.fix.core.Refreshable`);
    expect(short?.confidence).toBe('inferred');
    expect(out.edges.some((e) => e.relation === 'inherits' && e.to.qualifiedName.includes('ComponentActivity'))).toBe(false);
    // Panel : Dup() has two short-name candidates and no import — NO edge to
    // either Dup, and the tally (asserted below) counts it. The negative
    // branch is real, not claimed (pass-2 repair).
    expect(out.edges.some((e) => e.relation === 'inherits' && e.from.qualifiedName === `${B}#com.fix.app.ui.Panel`)).toBe(false);
  });
  it('spec excludes hold on the GIT enumeration path; generated-marker files skip whole', () => {
    // Junk.kt is tracked under app/.gradle/ — only pass.exclude stops it
    // (build/ is repo-gitignored, so a build/ fixture could never discriminate).
    expect(out.nodes.some((n) => n.filePath?.includes('.gradle/gen'))).toBe(false);
    expect(out.nodes.some((n) => n.name === 'NeverExtracted')).toBe(false);
    // Gen.kt carries the @generated marker — no file node, no class node.
    expect(out.nodes.some((n) => n.filePath?.endsWith('Gen.kt'))).toBe(false);
    expect(out.nodes.some((n) => n.name === 'AlsoNeverExtracted')).toBe(false);
  });
  it('calls resolve at inferred by unique simple name, cross-file', () => {
    const call = edge('calls', `${B}#com.fix.core.Loader::warm`, `${B}#com.fix.core.lookup`);
    expect(call?.confidence).toBe('inferred');
    expect(edge('calls', `${B}#com.fix.app.StatusRow`, `${B}#com.fix.app.MainActivity::boot`)).toBeDefined();
  });
  it('@Composable is flagged', () => {
    expect(node('function', `${B}#com.fix.app.StatusRow`)?.metadata?.composable).toBe(true);
  });
  it('gradle modules emit with file membership', () => {
    expect(node('module', `${B}#gradle:app`)).toBeDefined();
    expect(node('module', `${B}#gradle:core`)).toBeDefined();
    expect(edge('depends_on', `${B}/core/src/main/kotlin/com/fix/core/Util.kt`, `${B}#gradle:core`)).toBeDefined();
  });
  it('manifest components resolve against NAMESPACE, never applicationId', () => {
    expect(node('class', `${B}#com.fix.app.MainActivity`)?.metadata?.androidComponent).toBe('activity');
    expect(node('class', `${B}#com.fix.app.svc.SyncService`)?.metadata?.androidComponent).toBe('service');
    expect(node('class', `${B}#com.fix.app.FixApp`)?.metadata?.androidComponent).toBe('application');
    // Nothing resolved under the applicationId namespace.
    expect(out.nodes.some((n) => n.qualifiedName.includes('com.fix.shipped'))).toBe(false);
  });
});

describe('kotlin extractor — invariants', () => {
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
  it('.kts files are never code-extracted (structure-only rule)', () => {
    expect(out.nodes.some((n) => n.filePath?.endsWith('.kts') && n.kind !== 'module')).toBe(false);
  });
  it('no self-edges', () => {
    for (const e of out.edges) expect(e.from.qualifiedName).not.toBe(e.to.qualifiedName);
  });
  it('emits the always-on machine-parseable tally line EXACTLY (R8)', () => {
    // Every counter is deterministic from the committed fixture: lowercase()
    // = the one unresolved call, ComponentActivity = the one external base,
    // Panel:Dup = the one ambiguous base, androidx.…Composable = the one
    // external import, Gen.kt = the one generated skip.
    expect(tallyLines).toContain(
      'kotlin-tally kotlin-repo unresolved_calls=1 ambiguous_calls=0 unresolved_inherits=1 ambiguous_inherits=1 unresolved_imports=1 dynamic_modules=0 extra_gradle_roots=0 generated_skipped=1'
    );
  });
});
