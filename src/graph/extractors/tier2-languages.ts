// Tier-2 language configs (plan 36, spec D1). Every capture name, import query
// and node type below is SPIKE-MEASURED against the vendored artifacts —
// vendor/grammars/README.md pins the exact bytes. Do not extend by guessing:
// the adoption ritual is a fresh spike + pin update in lockstep.
import { makeTier2Extractor, type Tier2Language } from './core/tier2.js';

const go: Tier2Language = {
  id: 'go', lang: 'go', grammar: 'go',
  extensions: new Set(['.go']),
  tagsFile: new URL('../../../vendor/grammars/go-tags.scm', import.meta.url),
  knownCaptures: new Set(['definition.function', 'definition.method', 'definition.type', 'reference.call', 'reference.type', 'name', 'doc']),
  importQuery: '(import_spec path: (interpreted_string_literal) @mod)',
  importNodeTypes: ['import_spec', 'interpreted_string_literal'],
  kindMap: { 'definition.function': 'function', 'definition.method': 'function', 'definition.type': 'class' },
  refCaptures: new Set(['reference.call']),
  precedence: ['definition.method', 'definition.function', 'definition.type'],
  importLabel: (t) => t.replace(/^"|"$/g, ''),
};

const rust: Tier2Language = {
  id: 'rust', lang: 'rust', grammar: 'rust',
  extensions: new Set(['.rs']),
  tagsFile: new URL('../../../vendor/grammars/rust-tags.scm', import.meta.url),
  knownCaptures: new Set(['definition.class', 'definition.method', 'definition.function', 'definition.interface', 'definition.module', 'definition.macro', 'reference.call', 'reference.implementation', 'name']),
  importQuery: '(use_declaration argument: (_) @mod)',
  importNodeTypes: ['use_declaration'],
  kindMap: {
    'definition.class': 'class', 'definition.interface': 'class', 'definition.module': 'module',
    'definition.method': 'function', 'definition.function': 'function', 'definition.macro': 'function',
  },
  refCaptures: new Set(['reference.call']),
  precedence: ['definition.method', 'definition.function', 'definition.macro', 'definition.class', 'definition.interface', 'definition.module'],
};

const java: Tier2Language = {
  id: 'java', lang: 'java', grammar: 'java',
  extensions: new Set(['.java']),
  tagsFile: new URL('../../../vendor/grammars/java-tags.scm', import.meta.url),
  knownCaptures: new Set(['definition.class', 'definition.method', 'definition.interface', 'reference.call', 'reference.class', 'reference.implementation', 'name']),
  importQuery: '(import_declaration (scoped_identifier) @mod)',
  importNodeTypes: ['import_declaration', 'scoped_identifier'],
  kindMap: { 'definition.class': 'class', 'definition.interface': 'class', 'definition.method': 'function' },
  refCaptures: new Set(['reference.call']),
  precedence: ['definition.method', 'definition.class', 'definition.interface'],
};

const csharp: Tier2Language = {
  id: 'csharp', lang: 'csharp', grammar: 'csharp',
  extensions: new Set(['.cs']),
  // *.Build.cs belongs to ue-module (ue-module.ts:12, module structure);
  // *.Target.cs is owned by NOTHING — deliberately zero-covered: UE target
  // rules are build configuration whose functions would pollute the call
  // graph (the plan-35 .kts structure-only ruling, applied to .cs).
  skipBasenames: new Set(['.Build.cs', '.Target.cs']),
  tagsFile: new URL('../../../vendor/grammars/csharp-tags.scm', import.meta.url),
  knownCaptures: new Set(['definition.class', 'definition.interface', 'definition.method', 'definition.module', 'reference.send', 'reference.class', 'reference.interface', 'name', 'module']),
  importQuery: '[(using_directive !name (identifier) @mod) (using_directive !name (qualified_name) @mod) (using_directive name: (_) (qualified_name) @mod)]',
  importNodeTypes: ['using_directive', 'identifier', 'qualified_name'],
  kindMap: {
    'definition.class': 'class', 'definition.interface': 'class',
    'definition.module': 'module', 'definition.method': 'function',
  },
  refCaptures: new Set(['reference.send']),
  // The shipped tags.scm captures reference.send ONLY for member-access
  // invocations (`this.Helper()`); a bare `Step();` is invisible to it
  // (measured — the pass-1 blocker). This supplementary query captures
  // exactly the bare form: `(invocation_expression function: (identifier))`
  // does not match member access, so no double-counting.
  extraRefQuery: '(invocation_expression function: (identifier) @name)',
  extraRefNodeTypes: ['invocation_expression', 'identifier'],
  precedence: ['definition.method', 'definition.class', 'definition.interface', 'definition.module'],
};

// Registry parity (pass-2 finding): the disjointness guard inspects
// TIER2_EXTENSIONS — assert here, at load, that the configs claim EXACTLY
// that set, so a config edit cannot silently drift past the guard.
import { TIER2_EXTENSIONS } from '../extension-registry.js';
{
  const claimed = new Set<string>();
  for (const c of [go, rust, java, csharp]) for (const e of c.extensions) claimed.add(e);
  const a = [...claimed].sort().join(',');
  const b = [...TIER2_EXTENSIONS].sort().join(',');
  if (a !== b) {
    throw new Error(`tier2-languages: configs claim [${a}] but extension-registry declares [${b}] — keep them in lockstep`);
  }
}

export const tier2GoExtractor = makeTier2Extractor(go);
export const tier2RustExtractor = makeTier2Extractor(rust);
export const tier2JavaExtractor = makeTier2Extractor(java);
export const tier2CsharpExtractor = makeTier2Extractor(csharp);
export const TIER2_CONFIGS: readonly Tier2Language[] = [go, rust, java, csharp];
