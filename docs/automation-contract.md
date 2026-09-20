# mai-automation-contract/1

A finite JSON CLI for external automation. Human commands keep their existing
interactive behavior. Build the checkout with the normal pipeline:

```sh
npm ci
npm run build
node build/entry.js capabilities --json
```

Consumers should pin both this contract and the returned build identity. Reads
continue to use [conductor-machine-contract/2](conductor-machine-contract.md):

```sh
node build/read-call.js ping '{}'
```

The caller owns PostgreSQL provisioning, credentials, orchestration and backups.
The three database operations require an explicit `MAI_DB_URL` pointing to an
already-existing PostgreSQL database. They do not provision a server or container.
Targeted ingest also requires `MAI_PROJECT_SLUG`. Supply credentials through the
process environment, never command arguments.

## Commands and results

### Discover capabilities

```sh
node build/entry.js capabilities --json
```

No database or project pin is required. The result has exactly these fields:

```ts
{
  ok: true,
  contract: 'mai-automation-contract/1',
  readContract: 'conductor-machine-contract/2',
  build: { version: string, sha: string, dirty: boolean, builtAt: string },
  operations: ['database_ensure', 'project_ensure', 'targeted_ingest']
}
```

`build` is the existing four-field build stamp. A missing or invalid stamp is an
infrastructure error; discovery never invents an identity.

### Ensure database schema

```sh
node build/entry.js database ensure --json
```

```ts
{
  ok: true,
  contract: 'mai-automation-contract/1',
  changed: boolean,
  schemaVersion: string
}
```

The command applies the shipped `db/schema.sql` to a fresh database and applies
the sorted forward migrations. On an existing schema it applies only the forward
migrations when the recorded source fingerprint differs. The SQL and fingerprint
update run in one transaction under an advisory lock. A SQL failure rolls back the
transaction. Whole-file transaction wrappers in the shipped migrations are
removed for this enclosing transaction; unexpected transaction boundaries fail
before mutation.

`schemaVersion` is `sha256:` followed by the SHA-256 digest of the
`mai-schema-source/1` prefix and JSON-encoded ordered filename/raw-SQL pairs for
the schema and forward migrations. The applied fingerprint is stored in the
singleton `public.mai_automation_schema` table. First adoption of an existing
schema reports `changed: true`; a repeat of the same sources reports `false`.
This is schema state, not an orchestration ledger. The human migration workflow
remains available; a later automation ensure reconciles its source fingerprint.

### Ensure a project

```sh
node build/entry.js projects ensure --slug example --root /absolute/canonical/repo --json
```

```ts
{
  ok: true,
  projectId: string,
  slug: string,
  root: string,
  changed: boolean,
  graph: 'deferred'
}
```

The root must be an existing canonical absolute directory: resolve symlinks and
path normalization before invoking the command. A new project uses the slug as
its name and stores the root in `path` and `metadata.repos`. An existing project
with a null path can be bound. A different non-null root is a project-mismatch
error; the command does not relocate the project.

Matching registrations retain their name, custom metadata and harness settings.
Missing or empty `metadata.repos` is filled with the root; malformed registered
roots are a validation error. An exact repeat returns the same ID with
`changed: false`. Registration writes only database state. It does not edit the
repository, harness configuration or hooks, invoke Git, or extract a graph.
`graph: 'deferred'` makes that last boundary explicit.

### Ingest one Codex transcript

```sh
node build/entry.js ingest --transcript /absolute/rollout.jsonl --harness codex --json
```

```ts
{
  ok: true,
  status: 'ingested' | 'unchanged',
  transcriptId: string,
  segmentsPersisted: number,
  fullReingest: boolean
}
```

The file must exist and be a regular file with valid first-line Codex
`session_meta`. Its canonical `cwd` must equal or descend from the pinned
project's registered root or one of its registered repository roots. An unknown
project is not found; a foreign root or a globally colliding session ID owned by
another project is a project mismatch.

The existing Codex adapter and segmented ingest engine process exactly that
file. No transcript scan, summary provider or embedding provider runs. Existing
watermarks make an unchanged repeat return `status: 'unchanged'`, zero persisted
segments and `fullReingest: false`. Empty input maps to `unchanged` while retaining
the engine's count and full-reingest flag. Rewritten/shrunk transcripts follow
the existing engine's full-reingest behavior. No repository or harness file is
written by this command.

## Process boundary

JSON mode is explicit. Only the four command families above opt in with `--json`.
Unknown flags, duplicates, extra positionals, valued `--json`, missing arguments,
and unsupported harnesses fail validation. Normal commands without `--json` keep
their existing behavior.

Each invocation emits exactly one JSON document on stdout, at most 16 KiB.
Diagnostics on stderr are capped at 16 KiB in aggregate. Error results have
exactly this shape, with fixed messages rather than raw exceptions:

```ts
{
  ok: false,
  contract: 'mai-automation-contract/1',
  error: 'validation' | 'not_found' | 'project_mismatch' | 'infrastructure',
  message: string
}
```

| Exit | Meaning |
| --- | --- |
| 0 | Success |
| 2 | Invalid arguments, configuration, metadata or inaccessible/invalid path |
| 3 | Requested file/directory or registered project not found |
| 4 | Project root or session ownership mismatch |
| 5 | Database, schema, build identity, output limit or deadline failure |

The operation deadline is 15 minutes. Database connections and transaction lock
waits have five-second limits; statements have a 60-second server limit and a
65-second client limit. After a result, the existing two-second process-exit
watchdog bounds owned-pool cleanup. A late operation cannot print a second result.
A timeout or connection failure around commit does not establish whether a
commit occurred; callers should reconcile by rerunning the idempotent operation
or reading state, rather than assuming rollback.

Automation skips checkout `.env` loading and selects its environment before
loading the runtime. It retains OS path/system/temp/locale keys, `MAI_DB_URL`,
`MAI_PROJECT_SLUG` and `MAI_BRAIN_ROOT`. It forces `MAI_LLM_PROVIDER=none`,
`MAI_LLM_SUMMARY=0` and `MAI_EMBEDDINGS=0`; provider, Git and home-related
credentials are not inherited. Schema and build identity always come from the
actual checkout, not `MAI_BRAIN_ROOT`.

Inputs are bounded: database URLs and paths at 4096 UTF-8 bytes; slugs at 255
lowercase ASCII kebab-case characters; transcript IDs at 200 characters. Control
characters are rejected in URLs, paths and transcript IDs. Schema loading allows
up to 512 forward migrations and 4 MiB per SQL file. There are no external SQL
inputs, new dependencies or new MCP tools in this contract.
