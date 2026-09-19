# Architecture

The canonical design reference: what the brain stores, how writes are gated,
how sessions are captured, and how the code graph and coordination layers fit
together.

Migrated sections keep their original repository-root-relative links (for
example `docs/assets/graph.png`); resolve them from the repository root, not
from this file's directory.

<!-- migrated-from-doc: release/public/ARCHITECTURE.md#<preamble> -->
mai-mcp is a single Node process speaking MCP over stdio to one AI-agent client,
backed by one PostgreSQL database. Everything below is served through MCP tools
(read + write) and a zero-LLM-cost CLI.


## System diagram

<!-- migrated-from-doc: release/public/ARCHITECTURE.md#System diagram -->
```
      AI agent (any MCP client)
              │  MCP (stdio)
              ▼
        ┌───────────────┐        write-gate      ┌──────────────┐
        │   mai-mcp      │ ─── (search-before- ─▶ │  PostgreSQL   │
        │   MCP server   │      write, cited)      │  mai_brain    │
        └───────────────┘                          │  • decisions  │
              ▲                                     │  • lessons    │
   hooks:     │  ingest / prime / nudge             │  • sessions   │
   SessionEnd ─┤                                     │  • graph      │
   SessionStart┤        ┌──────────────┐             │    nodes/edges│
   Stop        └───────▶│ ingest →      │──▶ decisions│  • commits    │
                        │ summarize/    │             └──────────────┘
                        │ extract       │
                        └──────────────┘
        code graph:  tree-sitter extractors ─▶ nodes + edges
        git evidence: commits ↔ decisions ↔ files
```


## Project pinning

<!-- migrated-from-doc: release/public/ARCHITECTURE.md#Project pinning -->
Every server instance is pinned to exactly one project via `MAI_PROJECT_SLUG`,
read **from the environment only**. There is no agent-facing "project" parameter
on any tool and no slug fallback literal — an agent physically cannot read or
write another project's brain. This is a deliberate safety property, not a
limitation: one server instance = one project, isolated by construction.


## The write-gate

<!-- migrated-from-doc: release/public/ARCHITECTURE.md#The write-gate -->
Category-A writes (decisions, lessons) pass through a write-gate that enforces
**search-before-write**: the agent must have searched the brain (which mints a
short-lived read token) before it can write, and every write carries a
**structured citation** — one of:

- `novel` — new knowledge, with a justification;
- `extends` — builds on an existing record (by id), with *how*;
- `supersedes` — replaces an existing record (by id), with *why*.

The gate makes the brain self-curating: contradictions surface as supersessions
instead of silently accumulating.


## Capture tiers

<!-- migrated-from-doc: release/public/ARCHITECTURE.md#Capture tiers -->
How sessions get into the brain scales down gracefully by harness capability:

1. **Native hooks** (Claude Code) — SessionStart auto-primes the agent,
   SessionEnd ingests the transcript, Stop nudges an end-of-session sweep.
2. **Transcript ingest + notify** (Codex) — a notify chain triggers a scan of
   the harness's rollout files.
3. **Rules-file block + generic ingest** (anything else) — a memory-brain block
   in the agent's rules file teaches it to call `mai_prime`/`mai_search`
   manually, and transcripts are ingested on demand.


## The code graph

<!-- migrated-from-doc: release/public/ARCHITECTURE.md#The code graph -->
Per-language **tree-sitter** extractors turn each repo into a graph of nodes
(functions, classes, tables, routes, modules) and typed edges (calls, imports,
depends-on, foreign keys). Updates compare **tracked working-tree source** with
the defining text actually extracted, so staged and unstaged edits are visible
before a commit. TypeScript/JavaScript, Python and C++ changed files are spliced
into the graph; unchanged source does not need a new extraction just because
Git HEAD moved. PHP and the broad
Tier-2 Go/Rust/Java/C# extractors are exceptions and re-run in full on every
update. A WordPress `listens_to` edge originates at the callback's method node
but is created by an `add_action` in a different file, so a file-scoped splice
cannot keep PHP correct; Tier-2's fileless import-module rendezvous nodes are
also splice-invisible, and its shallow full passes are cheap.
Database schema is introspected from a read-only dev-DB connection — PostgreSQL
or MySQL, routed by URL scheme — and joined into the same graph, so "what code
touches this table" is one query. On WordPress projects the logical `wp_table`
references are linked to the physical introspected tables by the install's
table prefix, joining plan 33's hook-first code graph to the real schema.
(PostgreSQL additionally contributes row-level-security policy nodes; MySQL has
no RLS, so none exist there by construction.)

PHP/WordPress coverage is hook-first: `add_action`/`add_filter` and
`do_action`/`apply_filters` become directed `listens_to`/`fires` edges through a
shared hook node, so "who fires this, and who listens" is one query. REST
routes, `wp_ajax_*`/`admin_post_*`, admin pages, cron events, shortcodes,
options, capabilities, enqueued assets and `$wpdb` table references are
extracted alongside.

`$wpdb` references become php-owned `wp_table` nodes keyed by the un-prefixed
table suffix, not database schema objects: `$wpdb->prefix` is
install-configurable, so the physical table name is not statically knowable.
They are useful immediately with no database configured, and when MySQL schema
introspection is wired (`--db-url mysql://…`) the prefix linker joins them to
the real introspected tables.

### Cross-service HTTP and event contracts

Cross-service graphing is deliberately project-local: it connects repositories
inside the same pinned project's registered repo union. It never joins two
project IDs, consults cross-project shares, or lets an agent select another
project.

Launch coverage is bounded to this literal-only matrix:

| Language | HTTP providers | HTTP clients | Events |
|---|---|---|---|
| TypeScript/JavaScript | Existing Express/Fastify-style literal registrations and Expo routes | Literal `fetch`, axios verb calls, and axios request objects | Literal KafkaJS `send`/`subscribe` topics |
| PHP/WordPress | Existing literal WordPress REST routes | Literal `wp_remote_get`, `wp_remote_post`, `wp_remote_request`, and Guzzle verb calls | Existing WordPress hook `fires`/`listens_to` graph remains authoritative; no duplicate event-channel nodes |
| Python | Literal FastAPI/APIRouter and Flask decorators, including a same-file literal router prefix | Literal `requests`, `httpx`, and `aiohttp` verb/request calls | Literal Celery task names and Kafka topic send/subscribe calls |

An `endpoint` is a provider-owned HTTP contract. An `http_call` is one literal
client call site, and `http_call —http_calls→ endpoint` is materialized only
after all language extractors finish. An `event_channel` is a literal shared
broker/task channel; publishers and listeners connect with `emits` and
`listens_on`. Endpoint and launch-language source identities are qualified by
their physical repository's service ID, so equal routes, basenames, and
relative paths in different services remain distinct.

Only absolute literal `http:` or `https:` client URLs participate. Credentials
are rejected, query and fragment data are discarded, and relative URLs remain
ordinary same-service code. Provider routes and event channels must also be
literal. Dynamic values are skipped and counted rather than guessed. A unique
provider alias, different source service, route match, and method match are all
required; duplicate aliases or multiple endpoint matches are ambiguous and
create no `http_calls` edge. Exact methods beat provider `ANY`, and a caller
whose method is `ANY` can match only provider `ANY`.

After upgrading to a release containing these identities, rebuild each upgraded
pinned project's derived structure graph once:

```bash
PROJECT_SLUG="replace-with-your-pinned-project-slug"
mai graph build --project "$PROJECT_SLUG"
```

The command must exit 0 and begin with `# mai graph build — <exact slug>`. This
one-time rebuild replaces derived `graph_nodes`/`graph_edges` identities only;
it does not rewrite decisions, lessons, notes, sessions, commits, or Git SHA
references.

Post-release extractor extensions may add Django URL tables, cross-file Python
router-prefix composition, RabbitMQ/Redis/SNS/SQS transports, PHP messenger
libraries, additional JavaScript brokers, and bounded environment/config
resolution. None of those are launch promises.

Arguments written as a string-valued `self::CONST` are resolved — on one consumer
plugin that was the difference between 4 and 30 of its 31 REST routes, because the
namespace is routinely a class constant. Two documented limits: a constant belonging to a
*different* class (`Foo::CONST`) is not resolved, because its value would have to
be deferred and a deferred value cannot form a node's identity; and callbacks
passed as a variable, along with fully-variable hook names, are skipped. All three
are counted in the build summary rather than guessed.


## The coordination seam

<!-- migrated-from-doc: release/public/ARCHITECTURE.md#The coordination seam -->
The multi-agent coordination layer (agent board, advisory path claims) plugs in
behind one compile-time interface, `src/coordination-api.ts`
(`CoordinationFacade`). The live implementation ships in this repo —
`src/coordination/index.ts` — and the core still only imports the interface,
never the implementation directly. The seam survives as architecture: it keeps
the coordination layer independently testable and the core loosely coupled.


## One brain, many projects

<!-- migrated-from-doc: README.md#<preamble> -->
Multi-project brain MCP server. One Postgres database (`mai_brain`), many projects,
**one pinned project per server instance** — agents cannot reach across projects.

Spec: `docs/superpowers/specs/2026-06-10-mai-mcp-design.md`
*(internal design notes — the `docs/superpowers/` tree ships only with the
private checkout, not the public release)*



## Cross-project references

Two layers, deliberately separate: **repo unions** (many repos, one product,
one brain — `projects.metadata.repos`) and **cross-project links** (two
products, two brains, an operator-approved read-only window). A reference is
visible in a target project only when BOTH keys agree:

1. the target's env carries `MAI_LINKED_PROJECTS=<source-slugs>` (written by
   `mai link`, generated from `projects.metadata.linked_projects` — the same
   metadata-driven pattern as repos/harnesses), and
2. an active per-artifact grant row exists (`project_shares`, created by
   `mai share` or the dashboard Sharing page).

Grants snapshot the artifact at share time and every read re-checks the
source: `ok` / `updated` / `retracted` (headline + reason, body withheld
from agents) / `deleted` / `moved`. A renamed or deleted source goes dark —
fail closed — while the FK-free, denormalized `share_events` table keeps the
audit trail alive under stable project UUIDs and event-time display slugs;
linking the renamed source's current slug restores visibility because the
stable source UUID still owns the grant. Non-doc snapshots are complete;
handoff refs remain structured, docs retain one first-chunk excerpt, and long
`mai_shared` detail uses the common framed `part` protocol rather than
truncating semantic content. Operator API/UI payloads include every captured
kind field. Grant/revoke audit labels come from current locked project rows
inside the mutation transaction, never process-lifetime slug caches. The
dashboard retrieves the audit with stable cursor pagination. Shareable kinds:
decisions, spec/plan doc pointers, board
handoffs, roadmap ideas. Lessons stay with the global layer.

The MCP surface gains exactly one read-only tool (`mai_shared`) and zero
project-selecting parameters: agents cannot name a project, cannot create or widen shares, and
cannot cite foreign ids (share output never mints write-gate tokens, so
`extends`/`supersedes` across the boundary is rejected mechanically).
Ownership is checked at grant time — a project can only share rows it owns,
which makes transitive re-sharing structurally impossible.

## What mai-mcp is

<!-- migrated-from-doc: release/public/README.md#<preamble> -->
*"A persistent memory brain for AI coding agents. Be water, mai friend."*

mai-mcp is a Model Context Protocol (MCP) server that gives AI coding agents a
persistent, project-pinned brain: **write-gated decisions and lessons**, a
**code graph** of your repositories (functions, tables, routes, and how they
connect), and **git evidence links** that tie decisions to the commits and files
that carried them out — all served over MCP to any agent, and pinned to exactly
one project per server instance.


## Why "mai" — be water

<!-- migrated-from-doc: README.md#Why "mai" — be water -->
**mai = me + AI** — human and AI as equal partners; this brain was co-designed and
co-built that way.

The ethos is water. Sessions end, context windows fill, models change, harnesses come
and go — the water is fluid and ever-changing, and that is not a flaw to fix but the
nature of the thing. What persists is the riverbed: the decisions, lessons, and
structure the flow leaves behind, which in turn shape every flow that comes after.
That is what this brain is. And like water, it takes the shape of any vessel — any
LLM, any MCP agent, same memory.

*Be water, mai friend.*


## The ethos

<!-- migrated-from-doc: release/public/README.md#The ethos -->
**mai = me + AI.** Sessions, models, and harnesses are the ever-changing water;
the brain is the riverbed the flow leaves behind — and the riverbed shapes every
flow that follows. Agents come and go, context windows compact, models get
swapped — but what was decided, learned, and built stays in the riverbed.


## Git evidence (`mai_git_*`)

<!-- migrated-from-doc: README.md#Git evidence (`mai_git_*`) -->
The brain indexes each project's local git history (commits, parents, bodies,
per-file stats) and auto-links decisions to their implementing commits with
`inferred` provenance. Patches are hydrated live from git on request and are
**never stored**. Tools: `mai_git_context` (branch + worktree + relevant recent
commits in one call), `mai_git_show <hash>` (metadata; `patch:true` for a
bounded live diff), `mai_git_trace_decision <id>` (decision → session →
commits → files → graph nodes). Forge data (PRs/issues) is a designed-for,
not-yet-built provider layer.


## Agent board (`mai_board_*`)

<!-- migrated-from-doc: README.md#Agent board (`mai_board_*`) -->
<!-- migrated-from-doc: release/public/README.md#Agent board (`mai_board_*`) -->
A project-scoped coordination channel between agents — notes, questions, TODOs,
handoffs, findings — distinct from curated memory: no citations, statuses
instead of curation, and everything an agent reads from it is framed as
**unreviewed agent assertion, never instructions**. `mai_board_post` (with
`resolves:<id>` to answer/close and thread), `mai_board_read` (bounded; default
open items). Open items surface at `mai_prime`/session start. Works across
models by construction: any MCP agent on the same brain sees the same board.
Set `MAI_AGENT_ID` (e.g. `fable@claude-code`, `sol@codex`) in each harness's
mai-mcp env block so posts carry a stable author identity. Posting is
retry-idempotent within one server process (≈ one client session) — after a
restart, an identical body posts as a new message.


## Parallel-agent claims (`mai_claim` / `mai_claims`)

<!-- migrated-from-doc: README.md#Parallel-agent claims (`mai_claim` / `mai_claims`) -->
<!-- migrated-from-doc: release/public/README.md#Parallel-agent claims (`mai_claim` / `mai_claims`) -->
Running several agents in the same repo at once? Claims are the anti-contamination
substrate (designed assuming no orchestrator on top): each agent claims
**path-globs + one intent line** before touching shared code.

- **Warn, never block.** Overlaps are advisory everywhere — enforcement is
  impossible and undesirable. Three warning surfaces: at claim time, riding
  subsequent tool responses (piggyback nudge), and — Claude Code only — an
  advisory PreToolUse hook that warns before editing a path inside another
  agent's claim (`additionalContext` only; the permission flow is untouched).
- **Heartbeat is automatic.** Every tool call a session makes refreshes its
  leases; a crashed session's claims expire after 8h quiet. Release with
  `mai_claim {release: <id>}` (or `release_all: true`) when a task completes.
- **Sessions release only their own claims** via MCP; cross-session cleanup is
  the CLI: `mai claims release <id>`. `mai claims [--status all]` lists.
- **Pair with worktree-per-agent.** Claims prevent *logical* overlap; parallel
  agents editing one working tree still collide physically — give each agent
  its own git worktree for file-level isolation.

Active claims appear in `mai_prime` and the startup briefing (untrusted-framed —
intents are free text from other agents).


## Code-review findings

<!-- migrated-from-doc: README.md#Code-review findings -->
<!-- migrated-from-doc: release/public/README.md#Code-review findings -->
Code review findings are rows, not markdown — stable UUIDs, a status you can close, and
`mai_findings {similar_to: "..."}` recall that spans **both** plan findings and code findings. A
defect found while reviewing a diff today is findable by a debugging session months from now.

Persistence is an operator path — `mai code-findings add` reads JSON from stdin or `--file <path>`,
and `mai code-findings close <uuid> --status … --note …` closes one — because the agent-facing tool
surface is a budget, and CRUD for a table is not worth an agent's context. Recall is the capability;
storage administration is not. Note that `mai_finding_update` closes *plan* findings only; a code
finding closes with `mai code-findings close <uuid> --status … --note … --project …`, and the tool
will tell you so if you try. Finding bodies are capped at 16,000 characters — a sanity bound, not a
content limit: trim and re-file rather than dropping the finding. The command reports typed exit
codes so a caller never parses prose: 0 ok, 2 validation, 3 finding exists nowhere, 4 project
mismatch, 5 database failure.


## Run receipts + machine read surface

External machine consumers (first: the M-AI5 conductor) get an append-only
`run_receipts` ledger and a content-addressed `run_artifacts` store, written
through `mai_receipt_add` / `mai_artifact_put` and read one-shot through
`build/read-call.js` (`ping`, `plan_state`, `findings`, `receipts`,
`review_state`, `board_thread`, `artifact`) — so no external consumer ever
regex-parses prose tool output. Receipts are idempotent by
`(project, receiptKey)` with byte-conflict detection: identical replay is a
no-op, divergent replay is a typed conflict. Artifact identity is the SHA-256
of the UTF-8 bytes — any client computes the address independently, and the
store is immutable (no release/delete exists). Domain failures on these tools
return a machine-JSON envelope, never prose. The authoritative contract —
shapes, cursor semantics, exit codes, caps, non-guarantees — is
[docs/conductor-machine-contract.md](conductor-machine-contract.md).


## Curation loops (`mai_review` → the dashboard)

<!-- migrated-from-doc: README.md#Curation loops (`mai_review` → the dashboard) -->
<!-- migrated-from-doc: release/public/README.md#Curation loops (`mai_review` → the dashboard) -->
The brain measures whether an entry ever helped, and proposes — never applies — corrections.

**Two tiers of usage.** Every decision and lesson carries `surfaced_count` (a read verb returned
it) and `cited_count` (a later write actually cited it). Surfaced is written on the existing read
piggyback, so every present and future read verb is covered by construction; cited is written
inside the citing write's own transaction, so a rejected or failed write never manufactures a
signal.

**Prune candidates.** An entry that is still valid, older than the 90-day curation window, and has
never been cited becomes a candidate in `mai_review`. Global lessons are included and carry a
**GLOBAL** badge plus the consequence in plain words: retiring one removes it from *every* project.
The window is a constant, not a setting — a tunable threshold is a mute button that looks like a
preference.

**Proposals.** A session that proves an entry wrong records the replacement with a `supersedes`
citation, or calls `mai_retract` with `propose: true`. Both file into the same queue with the
agent's evidence attached. `mai_retract` is **propose-only for agents**: direct retraction lives on
the operator surfaces (the dashboard triage, `mai retract`, `/api/curation/retire`).

**Nothing is ever applied automatically.** No confidence threshold, no "obviously stale" heuristic,
no batch approve-all, and no decay from non-use — age is not wrongness. Every content, liveness,
retirement or supersession change comes from an operator action. Automatic telemetry only increments
usage counters and, for cited lessons, the documented reinforcement score; it never applies a verdict.
The review card labels its own actions because
approve/deny *invert* between queue kinds: on a prune candidate, approve means **keep**.

### Lesson graduation (plan 27)

A lesson the dedup path catches being **relearned** 5+ times (`relearned_count`,
distinct from citation reinforcement) is proposed in the review queue as a
project rule. **Promote** writes the verdict and renders the rule into a
`GRADUATED RULES (mai-mcp)` managed block in each registered repo's `CLAUDE.md`
/ `AGENTS.md`; **Not a rule** declines it for one curation window. The block is
a **projection of the brain, never stored state** — promote, `mai init` and
`mai upgrade` all re-render it from the DB, so upgrades can't destroy rules and
hand-edits inside the block are overwritten. Remove the rendered rule without
destroying its lesson with `mai curation unpromote --lesson <id> --note-file
<path> --project <slug>`; it may be proposed again after the normal curation
window. Project-local lessons only; globals never graduate.


## Structure graph (`mai graph`)

<!-- migrated-from-doc: README.md#Structure graph (`mai graph`) -->
```bash
mai graph build [--project <slug>] [--db-url <dev-db-url>]     # full extraction (--postgres = alias; postgresql:// or mysql://)
mai graph update [--project <slug>]                            # incremental (runs automatically at SessionEnd)
mai graph watch [--project <slug>] [--db-url <dev-db-url>]      # opt-in foreground watcher; Ctrl+C to stop
mai graph find <query> | neighbors <id> | trace <a> <b> | impact <id> | stale
```

Complete graph builds and updates allow one writer per project. If another
build/update is active, the command exits with a retry message before extraction;
read commands and other projects remain available. SessionEnd and notify updates
use the same guard. Use the same upgraded version for all writers: older binaries
do not participate in this coordination. A lost writer-database connection stops
the writer process; rerun the graph command after restoring the connection.
Each extractor still commits independently, so a failed pass can leave partial
progress that the next update repairs. This does not start a watcher automatically.

Each complete pass routes its brain queries and extractor transactions through the same PostgreSQL session that owns the writer lock. Its private one-connection pool cannot replace that session. A lost database session therefore also loses its ability to write, including while the client has not yet detected the disconnect. Detected session loss terminates the writer process; retry the complete command.

### Keeping the graph current while you work

Run `mai graph build --project <slug>` once, then leave `mai graph watch --project <slug>`
running in a terminal. The watcher installs subscriptions before an initial catch-up update,
then waits for two seconds of quiet activity and at least 60 seconds between update starts.
It updates tracked working-tree content, including uncommitted edits and reverts. Stage a
new file with Git to include it; removing a file from the index removes its graph source even
when the file remains on disk. Git index subscriptions also cover linked worktrees.
Tracked hidden files and build directories follow the same source/exclude rules as updates.

The command stays in the foreground; it does not install a service or start automatically.
Ctrl+C or SIGTERM closes subscriptions, waits for an active update, then drains the CLI.
Windows forced process termination cannot provide that graceful wait. Busy writers and
recoverable census/update errors retry after at least 60 seconds with bounded diagnostics.
A lost writer database session exits the process under the existing writer safety rule.
Subscription failures warn and leave healthy roots running; losing every source subscription
exits nonzero. Restart after a subscription failure, root move or registration/exclude change.
Subscriptions use the roots/excludes captured at startup; each update reloads its own roots.
Native filesystem notifications can be coalesced or unavailable, particularly on network or
virtualized filesystems; use an explicit update when notification coverage is uncertain.

The watcher uses incremental extraction. It reports a missing graph instead of building one,
and Kotlin/Swift changes still require `mai graph build`. It does not push dashboard updates.
`--db-url` and its `--postgres` alias use the same project-scoped resolution as build/update.

Extractors: TypeScript/JS (compiler API), shell (tree-sitter-bash WASM), python
(tree-sitter-python WASM), C++ (tree-sitter-cpp WASM — files/classes/functions,
`#include` graph, in-repo inheritance, cross-TU call resolution via a two-pass
symbol table, UE reflection metadata `reflected`/`blueprintCallable`; `*_API`
export macros handled; engine/system symbols drop, counted on stderr), Kotlin
(official `@tree-sitter-grammars/tree-sitter-kotlin` WASM — package-scoped
classes/objects/functions/constructors, extension functions, Gradle `module`
nodes from static `settings.gradle.kts` includes, AndroidManifest components
resolved against the Gradle `namespace`, `@Composable` flagged; `.kts` is
structure-only, never code-extracted; full-build-only), Swift (vendored
official release-asset WASM in `vendor/grammars/` — module-segment symbol
keying so parallel platform trees never collapse, initializers, extension
members converging onto their type same-module-first then unique-in-repo,
protocol conformance/inheritance edges, `@main`/`main.swift` entrypoint and
property-wrapper metadata; full-build-only). A second, broad tier — tier2-go,
tier2-rust, tier2-java, tier2-csharp — covers Go, Rust, Java and C# at reduced
fidelity from each grammar's own tags.scm (symbols,
imports, same-file calls at inferred confidence; vendored checksum-pinned wasms
under vendor/grammars/). Broad tier answers "is my code in the graph"; the
deep tier answers "who calls this and why" — the boundary is a feature, not an
apology, and a language graduates tiers by the extension-registry migration
rule (a load-time disjointness assertion — every graph build/update and the full
test suite hit it — makes the hand-off impossible to forget). UE modules
(`.Build.cs`/`.uplugin` → `module` nodes + `depends_on` edges), glue (package.json scripts, `.mcp.json`,
`.claude/settings.json` hooks, launchd plists, crontab — "what runs
automatically and what does it touch"), and DB schema introspection when a
dev-DB URL is supplied. Agents query via `mai_graph_find`, `mai_graph_neighbors`,
`mai_graph_trace`, `mai_graph_impact`, `mai_graph_stale` (all read-only, pinned).
The decisions linker joins `code_decisions.files_affected` to file nodes as
`inferred` memory edges — `mai_graph_impact` returns the recorded reasoning
behind affected code. Incremental updates run from the SessionEnd hook (tracked-source
comparison; glue always re-runs). To keep the **schema layer** fresh after
migrations, set `MAI_GRAPH_DB_URL` in the **consumer project's own gitignored
`.env`** (a read-only role is plenty — extraction only reads `information_schema`):
the SessionEnd hook sources it and re-introspects the schema on each session end.
It belongs in the consumer's `.env`, never mai-mcp's shared `.env` (one value can't
serve multiple projects) and never inline in `.claude/settings.json` (that would
commit a DB password). Extraction is local and key-less — no LLM
calls. The dev-DB URL is **never persisted** to the brain; `MAI_GRAPH_DB_URL`
applies only to the project it's set for. The dashboard's **Graph tab** renders neighborhoods as
mermaid diagrams. Dependency note: grammars come from the official
`tree-sitter-bash` / `tree-sitter-python` / `tree-sitter-cpp` / `tree-sitter-php` /
`@tree-sitter-grammars/tree-sitter-kotlin` packages (they ship a prebuilt `.wasm`);
Swift's npm package ships none in any version, so its wasm is the official
upstream GitHub release asset, vendored checksum-pinned in `vendor/grammars/`
(provenance + re-vendoring rule in its README);
`web-tree-sitter` is pinned `~0.25` (0.26's loader rejects these grammars).


### Lessons on graph nodes

Attach an existing lesson to the code it applies to. For example, attach “Reuse
the transaction connection for related reads” to the function that performs a
transaction. The next person or agent inspecting that node can read the advice
and the reason it was attached.

#### In the dashboard

1. Select your project, open the graph, and select a code node.
2. Open **Lessons**. Attached advice shows its confidence and attachment note.
3. Use **View lesson** to read the original context, rule, rationale and
   application advice.
4. Choose **Add lesson**, search for an existing lesson, then choose **Attach**.
   Enter a reason and select **Confirm attachment**.
5. To unlink advice, choose **Remove**, enter a reason, and select
   **Confirm removal**. This removes the attachment, not the original lesson.

The picker includes active lessons from the selected project and global lessons.
Retired, superseded and other projects' private lessons are hidden. Explicitly
chosen low-confidence lessons are allowed and labelled. An empty list means no
eligible advice is attached to this node; it does not mean no lessons exist.

Attachments survive graph rebuilds that replace node UUIDs. They do not follow
renamed or remapped symbols. If the drawer says the node changed, select it again
from the graph. No embedding model or index is required. Automatic lesson
suggestions are deferred; every attachment is an explicit choice.

#### CLI

Replace the angle-bracket placeholders with your project slug and UUIDs. Use
`mai graph find <symbol-name> --project <slug>` to find the node UUID.

```sh
mai graph lessons show --node <node-uuid> --project <slug> --limit 10 --offset 0
mai graph lessons detail --lesson <lesson-uuid> --project <slug>
mai graph lessons attach --node <node-uuid> --lesson <lesson-uuid> --reason 'Applies here' --project <slug>
mai graph lessons detach --attachment <attachment-uuid> --reason 'Symbol removed' --project <slug>
```

Save the attachment ID returned by attach/show. It lets you remove an attachment
after its symbol disappears. For a current node, you can also use
`detach --node <node-uuid> --lesson <lesson-uuid> --reason <reason> --project <slug>`.

#### Agent instructions

Call `mai_graph_neighbors` with `view:"lessons"`, `limit` and `offset` to read
attached advice. Follow the returned next-page pointer: the renderer advances by
complete delivered rows. The CLI detail command returns the full original lesson.

Before attaching or detaching, read the eligible lesson through `mai_search` or
a graph lesson page. Then call `mai_link` with `from_kind:"lesson"`,
`from_id:<lesson UUID>`, `to_kind:"graph_node"`, `to_id:<node UUID>`,
`relation:"applies_to"`, `action:"attach"` or `"detach"`, `note:<reason>`, and
`citation:{kind:"extends",extends_id:<same lesson UUID>,how:<why it applies>}`.
Agent writes require a prior read and an extends citation to that exact lesson.
Removal by saved attachment ID is operator-only. CLI and dashboard actions record
their operator surface separately from agent citation provenance.

#### Install or upgrade

Fresh setup includes the attachment tables automatically. For an existing
installation, start from an updated checkout containing this feature. If you use
a custom database, set `MAI_DB_URL` to that database's connection string in the
checkout's `.env` or export it in your shell before `db:init`. An existing shell
value takes precedence over `.env`.
Run from the installed mai-mcp checkout:

```sh
npm ci
npm run build
npm run db:init
npm run build:web
```

`db:init` applies forward migrations in order, excluding rollback files, including
`db/migrations/2026-09-08-graph-node-lessons.sql`. The matching rollback removes
attachment data and events while leaving semantic-search tables intact.

If dashboard login persistence is installed, run `mai dashboard persist restart`.
Otherwise run `mai dashboard stop` followed by `mai dashboard start` (or your
usual supervised `mai dashboard run`). Confirm `mai dashboard status` reports
`Health: OK`, refresh the dashboard, and reconnect your MCP clients so they load
the new build. A Mac or Windows reboot is not required for this feature.

### Reading graph freshness

`mai_graph_stale`, `mai graph stale` and the graph lines in `mai_prime` report
**two independent axes**. They move separately, and either can be stale while the
other is perfectly current:

- **Code** — compares current tracked working-tree text with each node's extracted
  source hash. Edit a tracked file → its nodes become stale → run `mai graph
  update` → its new source is indexed. A later edit or revert becomes stale again;
  an unrelated commit does not. Staged new files are eligible; untracked, ignored
  and explicitly excluded files are not added. Removing a file from Git's index
  removes its graph source even if the physical file remains.
  Missing legacy hashes, unreadable files, merge conflicts and bounded-read limits
  are reported conservatively as unverified; they never certify current source.
  Status reads are limited to 16 MiB per file and 128 MiB per operation. A graph
  update still refreshes supported source it cannot prove unchanged within those
  verification limits. Existing rows without hashes acquire evidence through
  re-extraction, not a hash of today's disk attached to old graph output.
  Kotlin and Swift require `mai graph build`; incremental update reports their
  stale or newly staged source without claiming to refresh it. Git commits remain provenance,
  not proof of indexed bytes. Source freshness does not prove every cross-file
  edge or runtime behavior. Background watcher scheduling is a separate feature;
  this behavior applies to manual and SessionEnd updates.
- **DB schema** — measured against the last time your dev database was
  introspected. Schema nodes have no file path at all, so they are invisible to
  the code axis: a graph can have verified code source while every `table` and `column`
  node in it is months old.

The schema axis reports one of four states (`stale` has two possible causes):

| State | What it means | What to do |
|---|---|---|
| **not configured** | No `MAI_GRAPH_DB_URL` resolves for this project and no schema was ever introspected. `kind:'table'` questions will find nothing. | Set `MAI_GRAPH_DB_URL` (postgresql:// or mysql://) in the project's own gitignored `.env`, or run `mai graph build --db-url <dev-db-url>`. |
| **never extracted** | A dev-DB URL resolves, but no schema nodes exist yet. | Run `mai graph update`. |
| **stale — no URL** | Schema nodes exist, but no URL resolves now, so every `mai graph update` is skipping the schema layer. Schema answers may be missing or wrong. | Restore `MAI_GRAPH_DB_URL` in the project's `.env`. |
| **stale — behind code** | A newer code extraction ran without refreshing the schema, so the schema layer trails the code layer. | Run `mai graph update` with the project's `.env` sourced — the SessionEnd hook does this for you. |
| **fresh** | The schema was introspected during the most recent extraction pass. | Nothing. |

**"Fresh" means "introspected as of `<timestamp>`", not "matches the live
database right now."** Proving the latter would mean opening a connection to your
database on every status call, which mai-mcp deliberately does not do — so every
schema report carries its `as of` timestamp, and migrations applied after that
timestamp are not yet reflected in the graph.

The dev-DB URL is only ever consumed as a yes/no. It is never rendered into any
output, never logged, and never stored in the brain.
