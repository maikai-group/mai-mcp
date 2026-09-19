# Contributing to mai-mcp

Thanks for wanting to help. mai-mcp is built to a high bar — the rules below are
the same ones the core is held to.

## Dev setup

Follow the [README](README.md) quickstart (Postgres via the compose file,
`npm ci && npm ci --prefix frontend && npm run build && npm run db:init`,
apply the migrations), then:

```bash
scripts/run-with-disposable-db.sh scripts/run-with-disposable-mysql.sh npm test
```

(The wrappers provide the disposable Postgres and MySQL the DB-backed suites
require. The full suite needs Bash, Docker and the PostgreSQL client `psql` on
your PATH. Either suite invoked without its wrapper fails with a named pointer
to this command.)

Both `npm run build` and
`scripts/run-with-disposable-db.sh scripts/run-with-disposable-mysql.sh npm test`
must be green before you open a PR.

## Iron rules (these bind contributions)

- **No type-safety bypasses.** No `any`, no `as unknown as`, no `@ts-ignore`.
  Write the specific type.
- **Never weaken the write-gate.** No bypass flags, no "skip validation" params.
- **Project pinning is env-only.** Never add a project/slug parameter to an
  agent-facing tool; never add a slug fallback literal.
- **Migrations are dated SQL** in `db/migrations/` with a paired
  `.rollback.sql`.
- **`.env*` files are never committed.** Document new env vars in the README.
- `npm run build && scripts/run-with-disposable-db.sh scripts/run-with-disposable-mysql.sh npm test`
  green before every PR.

## Contributor License Agreement

All contributions require signing the Maikai Group Inc. Contributor License
Agreement (one-time, via the CLA-assistant bot on your first PR). The project
is MIT-licensed; the CLA simply lets Maikai Group Inc. keep stewarding the
project's licensing over time (including any future commercial offerings that
fund development).

## A good first contribution

**Add a language extractor.** The code graph is powered by per-language
tree-sitter extractors — adding one for a language we don't cover yet is a
self-contained, high-value contribution. See the graph section of
[ARCHITECTURE.md](ARCHITECTURE.md) for how extractors produce nodes and edges.
