// WASM tree-sitter loader (spec §3.2–3.3). web-tree-sitter ~0.25 pin is
// load-bearing (0.26's loader rejects these grammars). Grammars come from the
// OFFICIAL per-language packages (tree-sitter-bash / tree-sitter-python), which
// ship a .wasm built with current tree-sitter — the third-party tree-sitter-wasms
// bundle is 0.20-era and its external scanners (heredocs, [[ ]], ${VAR:-x},
// python indentation/f-strings) fail to link under any web-tree-sitter; the
// official 0.25 wasm parses them correctly (verified 2026-06-12). 0.25.10 ships
// ESM named exports — `Parser`/`Language` are classes (`Parser.init()` +
// `Language.load()` are statics), `Node`/`Query` are the AST/query types. One
// cached Language per grammar. Local-only, no network, no LLM.
import { Language, Parser } from 'web-tree-sitter';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const require_ = createRequire(import.meta.url);

export type GrammarName = 'bash' | 'python' | 'cpp' | 'php' | 'kotlin' | 'swift' | 'go' | 'rust' | 'java' | 'csharp';

// Official grammar packages publish their wasm at <pkg>/tree-sitter-<name>.wasm.
const WASM_PACKAGE: Partial<Record<GrammarName, string>> = {
  bash: 'tree-sitter-bash/tree-sitter-bash.wasm',
  python: 'tree-sitter-python/tree-sitter-python.wasm',
  // tree-sitter-cpp lags at 0.23 but its prebuilt wasm links cleanly under the
  // pinned web-tree-sitter ~0.25.10 (spike 2026-06-20, lesson bf9c1d12).
  cpp: 'tree-sitter-cpp/tree-sitter-cpp.wasm',
  // tree-sitter-php 0.24 links cleanly under the pinned web-tree-sitter
  // ~0.25.10 (spike 2026-08-19): loads and parses a WP-shaped fixture with
  // hasError false. Use the HTML-aware grammar, NOT tree-sitter-php_only —
  // WP view templates interleave HTML and PHP in one file.
  php: 'tree-sitter-php/tree-sitter-php.wasm',
  // Official package ships the wasm; external scanner links under ~0.25.10
  // (spike 2026-08-25: 122 real fleet files parsed, hasError false on all).
  kotlin: '@tree-sitter-grammars/tree-sitter-kotlin/tree-sitter-kotlin.wasm',
};

// Swift's npm package ships no wasm in any version; the grammar's official
// binary distribution is the upstream GitHub release asset, vendored
// checksum-pinned (vendor/grammars/README.md has provenance + the
// re-vendoring rule). Same relative depth from src/graph/ and build/graph/,
// so the URL resolves in both the vitest (src) and compiled (build) trees.
const VENDORED_WASM: Partial<Record<GrammarName, URL>> = {
  swift: new URL('../../vendor/grammars/tree-sitter-swift.wasm', import.meta.url),
  // Tier-2 grammars (plan 36): vendored byte-for-byte from the official npm
  // packages — provenance + pins in vendor/grammars/README.md. Only the wasm
  // ships; the packages are not dependencies.
  go: new URL('../../vendor/grammars/tree-sitter-go.wasm', import.meta.url),
  rust: new URL('../../vendor/grammars/tree-sitter-rust.wasm', import.meta.url),
  java: new URL('../../vendor/grammars/tree-sitter-java.wasm', import.meta.url),
  // upstream ships the wasm with an underscore; the vendored name keeps it.
  csharp: new URL('../../vendor/grammars/tree-sitter-c_sharp.wasm', import.meta.url),
};

let initialized = false;
const languages = new Map<GrammarName, Language>();

export async function loadLanguage(name: GrammarName): Promise<Language> {
  if (!initialized) {
    await Parser.init();
    initialized = true;
  }
  const cached = languages.get(name);
  if (cached) return cached;
  const vendored = VENDORED_WASM[name];
  let wasmPath: string;
  if (vendored) {
    wasmPath = fileURLToPath(vendored);
  } else {
    const pkg = WASM_PACKAGE[name];
    if (pkg === undefined) {
      throw new Error(`${name} grammar wasm missing from vendor/grammars — see vendor/grammars/README.md`);
    }
    wasmPath = require_.resolve(pkg);
  }
  const lang = await Language.load(wasmPath);
  languages.set(name, lang);
  return lang;
}

export async function parserFor(name: GrammarName): Promise<Parser> {
  const lang = await loadLanguage(name);
  const parser = new Parser();
  parser.setLanguage(lang);
  return parser;
}
