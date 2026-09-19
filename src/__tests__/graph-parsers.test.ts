/** WASM grammars load and answer queries — the foundation for shell/python. */
import { describe, expect, it } from 'vitest';
import { Query } from 'web-tree-sitter';
import { makeTier2Extractor } from '../graph/extractors/core/tier2.js';
import { TIER2_CONFIGS } from '../graph/extractors/tier2-languages.js';
import { loadLanguage, parserFor } from '../graph/parsers.js';

describe('graph parsers (WASM)', () => {
  it('tier-2 validates query node types before compiling supplementary queries', async () => {
    const base = TIER2_CONFIGS[0];
    if (!base) throw new Error('go config missing');
    const broken = makeTier2Extractor({
      ...base,
      importQuery: '(definitely_missing_node_type) @mod',
      importNodeTypes: ['definitely_missing_node_type'],
    });
    await expect(broken.extract({ projectId: 'x', repoPaths: [] }))
      .rejects.toThrow(/tier2-go: query node type 'definitely_missing_node_type' does not exist in the vendored grammar/);
  });

  it('bash: extracts command names and env-var references', async () => {
    const parser = await parserFor('bash');
    const lang = await loadLanguage('bash');
    const tree = parser.parse('#!/bin/bash\npg_dump "$MAI_DB_URL" > backup.sql\nnode build/index.js ${OTHER_VAR}\n');
    if (!tree) throw new Error('parse returned null');
    const q = new Query(
      lang,
      '(command name: (command_name (word) @cmd)) (expansion (variable_name) @var) (simple_expansion (variable_name) @var)'
    );
    const caps = q.captures(tree.rootNode).map((c) => `${c.name}:${c.node.text}`);
    expect(caps).toContain('cmd:pg_dump');
    expect(caps).toContain('cmd:node');
    expect(caps).toContain('var:MAI_DB_URL');
    expect(caps).toContain('var:OTHER_VAR');
  });

  it('python: extracts imports, defs, classes, calls', async () => {
    const parser = await parserFor('python');
    const lang = await loadLanguage('python');
    const tree = parser.parse('import os\nfrom lib.db import save\n\ndef main():\n    save()\n\nclass Foo:\n    pass\n');
    if (!tree) throw new Error('parse returned null');
    const q = new Query(
      lang,
      '(import_statement name: (dotted_name) @mod) (import_from_statement module_name: (dotted_name) @from) ' +
        '(function_definition name: (identifier) @fn) (class_definition name: (identifier) @cls) (call function: (identifier) @call)'
    );
    const caps = q.captures(tree.rootNode).map((c) => `${c.name}:${c.node.text}`);
    expect(caps).toEqual(expect.arrayContaining(['mod:os', 'from:lib.db', 'fn:main', 'cls:Foo', 'call:save']));
  });

  it('kotlin grammar links (external scanner) and parses', async () => {
    const lang = await loadLanguage('kotlin');
    const parser = await parserFor('kotlin');
    const tree = parser.parse(
      'package a.b\n\nimport a.c.D\n\nclass E(private val d: D) : F(), G {\n    fun run(): String {\n        return d.go("x${d.n}y")\n    }\n}\n\nfun String.ext(): Int = length\n'
    );
    expect(tree).not.toBeNull();
    expect(tree?.rootNode.hasError).toBe(false);
    const q = new Query(lang, '(class_declaration name: (identifier) @c) (function_declaration name: (identifier) @f)');
    const caps = tree ? q.captures(tree.rootNode) : [];
    expect(caps.some((c) => c.name === 'c' && c.node.text === 'E')).toBe(true);
    expect(caps.some((c) => c.name === 'f' && c.node.text === 'ext')).toBe(true);
  });

  it('swift grammar (vendored official release asset) links and parses', async () => {
    const lang = await loadLanguage('swift');
    const parser = await parserFor('swift');
    const tree = parser.parse(
      'import SwiftUI\n\nprotocol P {\n    func go()\n}\n\nclass C: NSObject, P {\n    func go() {\n        self.helper("a\\(1)b")\n    }\n    func helper(_ s: String) {}\n}\n\nextension C {\n    func stop() {}\n}\n'
    );
    expect(tree).not.toBeNull();
    expect(tree?.rootNode.hasError).toBe(false);
    // Structural pins: every node/field shape the swift extractor's query and
    // handlers rely on must exist in THIS wasm — a re-vendored grammar that
    // renamed any of them fails here, not silently at extraction.
    const q = new Query(
      lang,
      '(class_declaration) @c (protocol_declaration name: (type_identifier) @p) (function_declaration name: (simple_identifier) @f) (inheritance_specifier inherits_from: (user_type)) @inh (navigation_suffix suffix: (simple_identifier) @nav)'
    );
    const caps = tree ? q.captures(tree.rootNode) : [];
    expect(caps.filter((c) => c.name === 'c').length).toBe(2); // class C + extension C (both class_declaration — spike)
    expect(caps.some((c) => c.name === 'p' && c.node.text === 'P')).toBe(true);
    expect(caps.filter((c) => c.name === 'inh').length).toBe(2); // NSObject + P
    expect(caps.some((c) => c.name === 'nav' && c.node.text === 'helper')).toBe(true);
  });

  it('go grammar links and parses (raw string)', async () => {
    const parser = await parserFor('go');
    const bt = String.fromCharCode(96); // backtick, kept out of the template literal
    const tree = parser.parse('package m\n\nvar s = ' + bt + 'raw text' + bt + ' + "x"\n\nfunc F() {}\n');
    expect(tree?.rootNode.hasError).toBe(false);
  });

  it('rust grammar links and parses (raw string — external scanner)', async () => {
    const parser = await parserFor('rust');
    const tree = parser.parse('fn main() { let s = r#"raw "quoted" text"#; let _ = s; }\n');
    expect(tree?.rootNode.hasError).toBe(false);
  });

  it('java grammar links and parses (text block)', async () => {
    const parser = await parserFor('java');
    const tree = parser.parse('class T { String s = \"\"\"\n block\n \"\"\"; }\n');
    expect(tree?.rootNode.hasError).toBe(false);
  });

  it('csharp grammar links and parses (interpolated string — external scanner)', async () => {
    const parser = await parserFor('csharp');
    const tree = parser.parse('class T { string S() { return $"a{1 + 2}b"; } }\n');
    expect(tree?.rootNode.hasError).toBe(false);
  });
});
