# Vendored grammar wasms

## tree-sitter-swift.wasm
- Source: OFFICIAL upstream release asset — alex-pinkus/tree-sitter-swift,
  tag 0.7.3 (https://github.com/alex-pinkus/tree-sitter-swift/releases/download/0.7.3/tree-sitter-swift.wasm).
  The npm package ships no wasm in any version (verified 2026-08-25); the
  release asset is the grammar's official binary distribution. Vendored
  byte-for-byte, never rebuilt or modified.
- sha256: 0258a7ef17303a8079ffe0748b3583d59656b5c3e8653fca7b6451b3e6689eb2
- bytes: 3825025 · tree-sitter language ABI 15
- Re-vendoring rule: a new grammar version requires a fresh link-and-parse
  spike under the pinned web-tree-sitter (parsers.ts rule) and an error-rate
  sweep on a real Swift repo before adoption; then update this checksum and
  the pin in Task-1-style lockstep. At adoption (2026-08-25) the sweep over a
  real 151-file consumer repo yielded exactly 5 files with hasError (3.3%).

Kotlin needs no vendoring: `@tree-sitter-grammars/tree-sitter-kotlin@1.1.0`
ships `tree-sitter-kotlin.wasm` (sha256
7009d69453bc8735e438b2818a633efb21c88f99782769abba60dffedfab73f7).

## Tier-2 grammars (plan 36) — four wasms + their tags.scm
All eight fetched from the official npm packages (versions in the table) and
vendored byte-for-byte; only the wasm + queries/tags.scm are used, so the
packages are NOT dependencies. Re-vendoring rule: a new version requires a
fresh link-and-parse spike under the pinned web-tree-sitter AND a
capture-conformance run (the tier-2 core's load-time gates), then update these
pins in lockstep.

| file | source pkg | sha256 |
|---|---|---|
| tree-sitter-go.wasm | tree-sitter-go@0.25.0 | 9504573f352b20be7f2f1911754d710622aedc15afff16d5ed8fb5645681aee7 |
| go-tags.scm | tree-sitter-go@0.25.0 | d1a9b1f678fe0278b85054e2dc56a28ef26aa478b8c88fb2b0dd83cdcdb9db35 |
| tree-sitter-rust.wasm | tree-sitter-rust@0.24.0 | f65f354215611fd94ad34134b3427eb3d58cbb745df7b6509ba722184db73d57 |
| rust-tags.scm | tree-sitter-rust@0.24.0 | f22867fdebde5cb091861c08d34690dc2540f4318068bf81be9f6b0d348ab8c1 |
| tree-sitter-java.wasm | tree-sitter-java@0.23.5 | 4fdeac4ca6ca089f06c6f7e562abcac1733cd465728cc7031ebb73c2019122c4 |
| java-tags.scm | tree-sitter-java@0.23.5 | bcb22147b8582d92743fc973864cefb894a4c12b3957f16f3d472b2ec7cd4c49 |
| tree-sitter-c_sharp.wasm | tree-sitter-c-sharp@0.23.5 | 6f69e1cae44e1c32c1eccc170dc5a9778fb94ff716f71113fe1f8c4299aa2f40 |
| csharp-tags.scm | tree-sitter-c-sharp@0.23.5 | 4ed08da0162ecd48206ac34bebe7ea9757a8c7b617f6ad8f70c168d685d514fe |
