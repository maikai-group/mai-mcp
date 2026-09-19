/** Core two-pass helpers — pure unit tests + one toy end-to-end pass (no DB). */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { hashContent } from '../graph/engine.js';
import { ensureDecl, makeTwoPassExtractor, mergeMeta, simpleNameOf, type LanguagePass, type RepoAcc } from '../graph/extractors/core/two-pass.js';
import type { NodeRef } from '../graph/types.js';

function freshAcc(): RepoAcc<null, never> {
  return {
    repo: '/x/demo', repoBase: 'demo', nodes: [], edges: [],
    index: {
      byIdentity: new Map(), functionsByKey: new Map(), classesByKey: new Map(),
      functionsByShort: new Map(), classesByShort: new Map(),
      declFileQn: new Map(), emitted: new Set(),
    },
    intents: [], tally: {}, fileByRelPath: new Map(),
  };
}
const fileRef: NodeRef = { kind: 'file', qualifiedName: 'demo/a.kt' };

describe('two-pass core', () => {
  it('decl + def converge onto one node; metadata merges with later-wins', () => {
    const acc = freshAcc();
    const q1 = ensureDecl(acc, 'kotlin', { kind: 'function', resolutionKey: 'a.b::run', name: 'run', abs: '/x/demo/a.kt', line: 1, fileRef, meta: {} });
    const q2 = ensureDecl(acc, 'kotlin', { kind: 'function', resolutionKey: 'a.b::run', name: 'run', abs: '/x/demo/a.kt', line: 9, fileRef, meta: { composable: true } });
    expect(q1).toBe(q2);
    expect(acc.nodes.filter((n) => n.kind === 'function').length).toBe(1);
    expect(acc.nodes.find((n) => n.qualifiedName === q1)?.metadata).toMatchObject({ composable: true });
  });

  it('distinct disambiguators produce insertion-order overload qns (base, base/1)', () => {
    const acc = freshAcc();
    const q1 = ensureDecl(acc, 'swift', { kind: 'function', resolutionKey: 'M#T::go', disambiguator: '1', name: 'go', abs: '/x', line: 1, fileRef });
    const q2 = ensureDecl(acc, 'swift', { kind: 'function', resolutionKey: 'M#T::go', disambiguator: '2', name: 'go', abs: '/x', line: 2, fileRef });
    expect(q1).toBe('demo#M#T::go');
    expect(q2).toBe('demo#M#T::go/1');
    expect(acc.index.functionsByKey.get('M#T::go')).toEqual([q1, q2]);
  });

  it('classes register in classesByKey and classesByShort; defines edge defaults to fileRef', () => {
    const acc = freshAcc();
    const qn = ensureDecl(acc, 'kotlin', { kind: 'class', resolutionKey: 'a.b.Monitor', name: 'Monitor', abs: '/x', line: 3, fileRef });
    expect(acc.index.classesByKey.get('a.b.Monitor')).toBe(qn);
    expect(acc.index.classesByShort.get('Monitor')).toEqual(['a.b.Monitor']);
    expect(acc.edges).toEqual([{ from: fileRef, to: { kind: 'class', qualifiedName: qn }, relation: 'defines' }]);
  });

  it('ownerRef overrides the defines owner (class —defines→ method)', () => {
    const acc = freshAcc();
    const cls = ensureDecl(acc, 'kotlin', { kind: 'class', resolutionKey: 'a.C', name: 'C', abs: '/x', line: 1, fileRef });
    ensureDecl(acc, 'kotlin', { kind: 'function', resolutionKey: 'a.C::m', name: 'm', abs: '/x', line: 2, fileRef, ownerRef: { kind: 'class', qualifiedName: cls } });
    expect(acc.edges.some((e) => e.relation === 'defines' && e.from.qualifiedName === cls && e.to.qualifiedName === `demo#a.C::m`)).toBe(true);
  });

  it('refuses empty names at the producer (engine.ts:54 would abort the whole build)', () => {
    const acc = freshAcc();
    expect(() => ensureDecl(acc, 'kotlin', { kind: 'class', resolutionKey: ' ', name: '', abs: '/x', line: 1, fileRef })).toThrow(/empty/);
  });

  it('simpleNameOf handles every scope separator', () => {
    expect(simpleNameOf('a.b.C')).toBe('C');
    expect(simpleNameOf('Sources/App#Engine::run')).toBe('run');
    expect(simpleNameOf('Ns\\Sub\\Driver')).toBe('Driver');
    expect(simpleNameOf('plain')).toBe('plain');
  });

  it('mergeMeta on an unknown qn is a no-op', () => {
    const acc = freshAcc();
    mergeMeta(acc, 'demo#missing', { x: 1 });
    expect(acc.nodes.length).toBe(0);
  });

  it('abs/line null → the node carries NO filePath/line keys (spec §2.3 invariant 5 — the php rendezvous shape)', () => {
    const acc = freshAcc();
    const qn = ensureDecl(acc, 'php', { kind: 'class', resolutionKey: 'Ns\\Hook', name: 'Hook', abs: null, line: null, fileRef });
    const n = acc.nodes.find((x) => x.qualifiedName === qn);
    expect(n).toBeDefined();
    expect(n !== undefined && 'filePath' in n).toBe(false);
    expect(n !== undefined && 'line' in n).toBe(false);
  });
});

describe('makeTwoPassExtractor end-to-end (toy bash pass — the preparse/prescan coverage)', () => {
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'two-pass-toy-'));
  afterAll(() => {
    fs.rmSync(scratch, { recursive: true, force: true });
  });

  it('preparse feeds the parser, contentHash stays on the original, prescan/resolve ordering holds, and splice:refuse ignores changedFiles', async () => {
    // 'zzfnzz' → 'renam3': same length (the preparse contract), and the
    // emitted node name can only be 'renam3' if the PARSER saw the rewrite.
    // Removing the preparse hook makes this test fail with name 'zzfnzz' —
    // the mutation discriminator for the hook's wiring.
    const original = 'zzfnzz() {\n  true\n}\n';
    fs.writeFileSync(path.join(scratch, 'a.sh'), original);
    const seen: string[] = [];
    const toy: LanguagePass<NodeRef, never> = {
      name: 'toy',
      lang: 'shell',
      grammar: 'bash',
      extensions: new Set(['.sh']),
      splice: 'refuse',
      vocabulary: { kinds: ['file', 'function'], relations: ['defines'] },
      // Probe-verified 2026-08-25: `renam3() { true; }` parses to
      // (function_definition name: (word)) under the repo's tree-sitter-bash.
      querySource: '(function_definition name: (word) @fn)',
      tallyKeys: ['noop'],
      preparse: (text) => text.replace('zzfnzz', 'renam3'),
      makeFileCtx: (_root, _abs, _rel, fileRef) => fileRef,
      prescan: () => {
        seen.push('prescan');
      },
      handleCapture: (acc, fileRef, _cap, node) => {
        seen.push(`cap:${node.text}`);
        ensureDecl(acc, 'shell', {
          kind: 'function', resolutionKey: node.text, name: node.text,
          abs: path.join(scratch, 'a.sh'), line: node.startPosition.row + 1, fileRef,
        });
      },
      resolveIntents: () => {
        seen.push('resolve');
      },
      report: () => null,
    };
    const out = await makeTwoPassExtractor(toy).extract({ projectId: 'x', repoPaths: [scratch] });
    const fn = out.nodes.find((n) => n.kind === 'function');
    expect(fn?.name).toBe('renam3'); // parser saw the preparse rewrite
    const file = out.nodes.find((n) => n.kind === 'file');
    expect(file?.contentHash).toBe(hashContent(original)); // hash from the ORIGINAL text (core contract)
    expect(seen[0]).toBe('prescan');
    expect(seen[seen.length - 1]).toBe('resolve');
    expect(seen).toContain('cap:renam3');

    // splice: 'refuse' — changedFiles is IGNORED, the full pass runs anyway
    // (php.ts:363-369 semantics; a changed set naming NO real file would
    // otherwise produce an empty output).
    const spliced = await makeTwoPassExtractor(toy).extract({
      projectId: 'x', repoPaths: [scratch], changedFiles: [path.join(scratch, 'not-a-real-file.sh')],
    });
    expect(spliced.nodes.filter((n) => n.kind === 'function').length).toBe(1);
  });
});
