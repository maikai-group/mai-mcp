# Harness wiring

How mai-mcp attaches to Claude Code, Codex, and any other MCP agent: server
registration, hook lifecycle, skills and reviewer agents, and multi-repo
layouts. Migrated sections keep their original repository-root-relative
links; resolve them from the repository root, not from this file's directory.
Skill installs use `mai skills install` — one stale-tools recovery:
if a harness shows stale tools after an upgrade, restart it. (The old manual
instructions used a `CODEX_SKILLS` shell variable for
`${CODEX_HOME:-$HOME/.codex}/skills`; the CLI resolves `CODEX_HOME` itself
now.)

## Works with

<!-- migrated-from-doc: README.md#Works with -->
- **Current-spec MCP:** speaks the 2026-07-28 protocol revision (cache hints, `resultType`)
  and transparently serves older 2025-era clients from the same handlers.

| Harness | Tools + write-gates (MCP) | Auto-capture |
|---|---|---|
| Claude Code / Cowork (desktop) | ✅ `.mcp.json` (installed by `mai init`) | ✅ full — SessionStart/SessionEnd/Stop + PreToolUse claim-warn hooks |
| Codex (CLI / desktop / VS Code) | ✅ repo-scoped `.codex/config.toml` (installed by `mai init --harness codex`) | ✅ rollout ingestion — `notify` hook + `mai ingest --scan` |
| Any other MCP agent (Cursor, Cline, …) | ✅ register mai-mcp in the tool's MCP config (manual) | ◐ rules-file priming (`mai init --harness generic [--rules-file <file>]`) + `mai ingest --transcript` |

### Windows caveats

Native Windows 11 (PowerShell 5.1+) is supported for both harnesses; the
support table in the README is the single source of truth. Claude Code needs no
dependency of its own on native Windows — Git for Windows is optional and
enables its Bash tool — but mai-mcp's installer requires Git for Windows to
clone the runtime. Codex runs in its vendor-documented native-Windows form; WSL2
is a distinct Linux-mode path (WSL1 unsupported since Codex 0.115), so a WSL2
workflow follows the Linux instructions inside the Linux filesystem. Every
managed command mai-mcp writes on Windows is a Node runner (below), never a
Bash invocation.

### Codex quickstart

```bash
MAI_PROJECT_SLUG=<slug> mai init <slug> --root <repo> --harness codex
```

This writes a repo-scoped `.codex/config.toml` (Codex merges it over `~/.codex/config.toml`
for trusted projects — the brain stays pinned per project), installs the brain block into
`AGENTS.md`, and wires Codex's global `notify` hook so every finished turn triggers
ingestion of that project's rollouts. Manual ingestion any time:

```bash
MAI_PROJECT_SLUG=<slug> mai ingest --scan --since-days 7
MAI_PROJECT_SLUG=<slug> mai ingest --transcript <path-to-session-log>
```

The same command is the one-time migration for a project that was previously
onboarded only for Claude Code. Harness selection is additive; `mai upgrade`
refreshes existing wiring but does not create missing Codex wiring. Restart
Codex after adding it, then run `mai verify <slug>`.

Codex sessions live in `~/.codex/sessions/**` as append-only rollouts; the brain routes
each one to its project by the `cwd` recorded on the rollout's first line. Rollouts keep
the full pre-compaction history, so ingestion survives Codex's in-chat auto-compaction.


## Client support matrix

<!-- migrated-from-doc: release/public/README.md#Works with -->
| Client | Support |
|---|---|
| Any MCP client | ✅ Full tool surface + write-gates |
| Claude Code | ✅ Full auto-capture via hooks (SessionStart prime, SessionEnd ingest, Stop nudge, PreToolUse claim-warn) |
| Codex | ✅ Transcript ingest + notify chain |
| Anything else | ✅ Rules-file block + generic transcript ingest |


## Register in a consumer project (.mcp.json)

<!-- migrated-from-doc: README.md#Register in a consumer project (.mcp.json) -->
```json
"mai-mcp": {
  "command": "node",
  "args": ["<path-to-mai-mcp>/build/index.js"],
  "env": {
    "MAI_PROJECT_SLUG": "<slug>",
    "MAI_PROJECT_ROOT": "/abs/path/to/project"
  }
}
```


## Hook lifecycle (installed by `mai init`)

<!-- migrated-from-doc: README.md#Hooks (manual install until `mai init`) -->
Capture + prime are hook-driven. The current managed shape (installed by setup,
`mai init` and `mai upgrade`) is a Node runner with no shell and no inline
slug assignment — `node <checkout>/build/scripts/hook-runner.js <mode>
--project <slug>` for `session-start`, `session-end`, `session-stop` and
`pre-edit`, and `node <checkout>/build/scripts/hook-runner.js codex-notify` as
Codex's `notify` command — which is why the same wiring runs on native Windows.
The JSON below shows the legacy one-window Bash shape that older projects may
still carry; `mai verify <slug>` flags it and `mai upgrade` rewrites it.
Add to the consumer project's `.claude/settings.json`:

```json
{
  "hooks": {
    "SessionEnd": [
      { "hooks": [ { "type": "command", "command": "MAI_PROJECT_SLUG=<slug> bash <path-to-mai-mcp>/hooks/session-end-ingest.sh" } ] }
    ],
    "SessionStart": [
      { "matcher": "startup", "hooks": [ { "type": "command", "command": "MAI_PROJECT_SLUG=<slug> bash <path-to-mai-mcp>/hooks/session-start-prime.sh" } ] }
    ],
    "Stop": [
      { "hooks": [ { "type": "command", "command": "bash <path-to-mai-mcp>/hooks/session-stop-nudge.sh" } ] }
    ]
  }
}
```

The SessionEnd chain also runs an **orphan-transcript sweep**: a session that
crashed (power loss, `kill -9`) never ran its own SessionEnd hook, so the next
session's end recovers it — transcripts from the last 7 days with no watermark
(or new bytes past it) are ingested through the normal segmented path, max 5
attempts per run (failures consume budget), advisory-locked against concurrent sweeps. Every run logs to
`/tmp/mai-ingest.log`; the agent board hears about it only on recovery, failure
or backlog. `mai reingest` remains the unbounded manual path.


## Onboarding a project (`mai init`)

<!-- migrated-from-doc: README.md#Onboarding a project (`mai init`) -->
```bash
mai init <slug> --root <product-root> [--repo <abs-path>]... [--exclude <path>]... [--postgres <dev-db-url>] [--draft-topics] [--harness <name>] [--rules-file <file>]
```

- `--exclude <path>` (repeatable) — graph-exclude a directory relative to `--root` (e.g. a dead sub-app). Stored in `projects.metadata.graph_excludes`; excluded from graph extraction in both full builds and incremental updates. Re-runs union excludes, same as `--repo`.

Idempotent. For the given slug it: creates/updates the project row (unioning repos), creates `docs/context/<slug>/_drafts/` + `docs/tracking/<slug>/`, and **in each repo** merges:
- `.mcp.json` — adds the `mai-mcp` server (with `MAI_PROJECT_SLUG`); the structure graph is served by mai-mcp's own `mai_graph_*` tools
- `.claude/settings.json` — appends the SessionEnd (ingest) + SessionStart (prime) + Stop (capture nudge) hooks

It touches **nothing else** in those files — existing servers, hooks, and other keys are preserved, and re-running makes no change.

**Umbrella layouts** (sessions run from a root folder that *contains* the repos, e.g. <umbrella-root>, <sibling-repo>): if the umbrella root is itself a git repo with real code, pass it as a `--repo` alongside each sub-repo — enumeration is git-tracked per repo (nested repos, untracked junk, and `.gitignore`'d files never leak between them) and attribution is longest-prefix-wins, so each file is graphed once, owned by the right repo. If the root is a *plain folder* (no git), it can't be a `--repo`; wire it by hand instead: copy a sub-repo's `.mcp.json` (set `MAI_PROJECT_ROOT` to the umbrella path) and add the three hooks to the umbrella's `.claude/settings.json`. Re-runs must repeat the exact same `--repo` flags. Init then builds the structure graph in-process (`mai graph build` — local and key-less; never calls an LLM for code extraction). With `--draft-topics`, it runs `claude -p` to draft `overview/architecture/conventions` topics into `_drafts/` for your review (drafts are inert until you move them out of `_drafts/`).


## Memory brain block (consumer CLAUDE.md)

<!-- migrated-from-doc: README.md#Memory brain block (consumer CLAUDE.md) -->
Installed automatically by `mai init` into each repo's `CLAUDE.md` (created if
absent, appended if present, skipped if the `MEMORY BRAIN (mai-mcp)` marker is
already there). Source of truth: `templates/memory-brain-block.md` — edit it
there only.


## Skills — install targets and scopes

<!-- migrated-from-doc: README.md#Skills -->
The repo ships the complete workflow skill suite:

| Skill | What it does |
|---|---|
| `write-plan` | Turns a spec into a locked-in implementation plan and registers it with `mai_plan`. |
| `plan-review` | Reviews a plan against the codebase; recalls what past reviews found, posts findings with `mai_review_post`. |
| `plan-review-cycle` | Repeats isolated review and repair passes until one frozen plan revision earns clearance. |
| `receiving-plan-review` | Reconciles and repairs findings without revision drift, and sweeps the plan for every other instance of each defect's shape. |
| `plan-execute` | Executes a plan task-by-task with audits; closes findings with `mai_finding_update` as they are fixed. |
| `plan-compliance` | Audits a completed task against the plan — fidelity, not quality. |
| `subagent-rules` | The rules block every subagent dispatch carries. The others mandate it. |
| `mai-code-review` | Reviews a diff against the codebase and files durable findings with stable UUIDs. |
| `mai-receiving-code-review` | Verifies, repairs and closes code findings — sweeping each defect's shape, not just its cited site. |
| `mai-subagent-execute` | Dispatches independent tasks to parallel agents with lane claiming and verified results. |
| `mai-debug` | Debugs brain-first — searches what's known, proves the cause, and records the lesson. |

They share one shape (`skills/SPINE.md`) and name no harness's tools, so they run wherever your agent does.

**Claude Code:**

```bash
mai skills install --target claude
```

**Codex** — user-level (all projects):

```bash
mai skills install --target codex --codex-scope user
```

Codex discovers user skills from `$CODEX_HOME/skills` (default `~/.codex/skills`). Do not install a
second copy of the same skill name in another discovery scope; Codex does not merge duplicates.

### Multiple Codex accounts and identities

Codex keeps login state under `CODEX_HOME`. mai can create named launchers that select a distinct
Codex home and inject a stable mai identity into the project MCP server:

```bash
mai codex profile add codex-business \
  --codex-home ~/.codex-business \
  --agent-id business@codex

codex-business
```

Use `mai codex profile list` to inspect configured aliases and `mai codex profile remove <name>` to
remove one. Profiles never read, copy, or delete Codex authentication; authenticate each home using
Codex itself. The alias is reported near the top of every `mai_prime` response, so an agent learns its
configured identity on the first required brain call instead of inferring CLI versus desktop from
terminal environment variables. The alias identifies the intended runtime/account context; it is not
a verified ChatGPT email or login name.

Findings are stored in your brain, not in markdown, so a review in one session is readable from
another — and `mai_findings {similar_to: "..."}` surfaces mistakes that have recurred across plans.

### Automatic plan/spec recall

`mai_plan` chunks a registered plan when it is created or refreshed. The existing Claude Code
SessionEnd and Codex notify chains also sweep plan/spec directories under the project root and
every registered `metadata.repos` root. Review documents and trailing `-finding(s)` reports are
excluded unless the tracker explicitly registers that file as a plan.

`mai_search` and `mai_prime` return at most three compact `path:line` pointers with heading and
excerpt — never whole document bodies. The sweep/register path creates missing chunks.
`mai embed --rebuild` only refreshes vectors for chunks that already exist.

### Bounded brain reads

MCP reads have a 6,000-character final budget. Small results keep full bodies; large results return as many complete headline rows as fit plus an exact shown/total narrowing pointer. The CLI is not budgeted.

`mai_plan` defaults to the latest review. Use `pass: "N"` for one review; if it spans parts, follow the returned `pass: "N:2"` pointer. `passes: "all"` remains bounded and is for history orientation, not an unbounded dump.

Use `mai_findings {finding:"UUID"}` for one complete finding and follow a returned `UUID:2` part pointer. Oversized context/report/recall/search/violation bodies point to their existing unbudgeted `mai` CLI read; board messages are write-capped and recoverable by message id (`limit:1` for a root).


## Skills — Codex scopes and the plan workflow

*(the public README's earlier wording of the same guidance, preserved
verbatim — the table above, including `plan-review-cycle`, is the current
inventory; `mai skills status` is authoritative at runtime)*

<!-- migrated-from-doc: release/public/README.md#Skills -->
The repo ships the complete workflow skill suite:

| Skill | What it does |
|---|---|
| `write-plan` | Turns a spec into a locked-in implementation plan and registers it with `mai_plan`. |
| `plan-review` | Reviews a plan against the codebase; recalls what past reviews found, posts findings with `mai_review_post`. |
| `receiving-plan-review` | Reconciles and repairs findings without revision drift, and sweeps the plan for every other instance of each defect's shape. |
| `plan-execute` | Executes a plan task-by-task with audits; closes findings with `mai_finding_update` as they are fixed. |
| `plan-compliance` | Audits a completed task against the plan — fidelity, not quality. |
| `subagent-rules` | The rules block every subagent dispatch carries. The others mandate it. |
| `mai-code-review` | Reviews a diff against the codebase and files durable findings with stable UUIDs. |
| `mai-receiving-code-review` | Verifies, repairs and closes code findings — sweeping each defect's shape, not just its cited site. |
| `mai-subagent-execute` | Dispatches independent tasks to parallel agents with lane claiming and verified results. |
| `mai-debug` | Debugs brain-first — searches what's known, proves the cause, and records the lesson. |

They share one shape (`skills/SPINE.md`) and name no harness's tools, so they run wherever your agent does.

**Claude Code:**

```bash
mai skills install --target claude
```

**Codex** — repo-level, user-level, or admin:

```bash
mai skills install --target codex --codex-scope repo
mai skills install --target codex --codex-scope user
mai skills install --target codex --codex-scope admin
```

Codex user scope installs to ${CODEX_HOME:-$HOME/.codex}/skills; do not install duplicate copies of the same skill name in multiple discovery scopes.

Findings are stored in your brain, not in markdown, so a review in one session is readable from
another — and `mai_findings {similar_to: "..."}` surfaces mistakes that have recurred across plans.

### Automatic plan/spec recall

`mai_plan` chunks a registered plan when it is created or refreshed. The existing Claude Code
SessionEnd and Codex notify chains also sweep plan/spec directories under the project root and
every registered `metadata.repos` root. Review documents and trailing `-finding(s)` reports are
excluded unless the tracker explicitly registers that file as a plan.

`mai_search` and `mai_prime` return at most three compact `path:line` pointers with heading and
excerpt — never whole document bodies. The sweep/register path creates missing chunks.
`mai embed --rebuild` only refreshes vectors for chunks that already exist.

The SessionEnd chain also runs an **orphan-transcript sweep**: a session that
crashed (power loss, `kill -9`) never ran its own SessionEnd hook, so the next
session's end recovers it — transcripts from the last 7 days with no watermark
(or new bytes past it) are ingested through the normal segmented path, max 5
attempts per run (failures consume budget), advisory-locked against concurrent sweeps. Every run logs to
`/tmp/mai-ingest.log`; the agent board hears about it only on recovery, failure
or backlog. `mai reingest` remains the unbounded manual path.

### Bounded brain reads

MCP reads have a 6,000-character final budget. Small results keep full bodies; large results return as many complete headline rows as fit plus an exact shown/total narrowing pointer. The CLI is not budgeted.

`mai_plan` defaults to the latest review. Use `pass: "N"` for one review; if it spans parts, follow the returned `pass: "N:2"` pointer. `passes: "all"` remains bounded and is for history orientation, not an unbounded dump.

Use `mai_findings {finding:"UUID"}` for one complete finding and follow a returned `UUID:2` part pointer. Oversized context/report/recall/search/violation bodies point to their existing unbudgeted `mai` CLI read; board messages are write-capped and recoverable by message id (`limit:1` for a root).

## Stateful brain access for headless workers

`scripts/mai-review-bridge.mjs` remains suitable for individual reviewer calls.
For a worker holding a lane, give it a persistent session: separate one-shot
calls have different process ownership, even when they use the same agent name.

The dispatcher creates a private scratch parent under the current user's temp
directory, chooses a **nonexistent** child directory, and sets
`MAI_PROJECT_SLUG` and an absolute `MAI_PROJECT_ROOT` for that worker. Run:

```sh
node /absolute/mai-mcp/scripts/mai-worker-session.mjs serve /absolute/private-scratch/session
```

Keep that command in the harness's retained foreground process facility and
wait for its JSON `state: ready` line. Do not detach it with `nohup`. One worker
owns one session; independent workers get separate directories. On Windows,
create the scratch parent beneath the current user's private `%TEMP%`; the
channel relies on that directory's user ACL. On POSIX it checks owner and
0700 permissions. This protects against other OS users, not a malicious process
already running under your account. Never put session files in Git or publish
them: they can contain tool arguments and results.

Pass `MAI_BRIDGE_SESSION_DIR=/absolute/private-scratch/session`, the same project
slug/root, and the absolute bridge path to the worker. Every brain call uses
the bridge, including its first prime and final release:

```sh
node /absolute/mai-mcp/scripts/mai-review-bridge.mjs mai_prime --file /absolute/private-scratch/prime.json
node /absolute/mai-mcp/scripts/mai-review-bridge.mjs mai_claim --file /absolute/private-scratch/claim.json
```

Payload files contain the normal tool argument objects. Include only the
worker's own native chat ID in its prime when the harness exposes that ID;
otherwise omit chat attribution. Do not copy the parent's ID. Do not switch
between this channel and another MCP connection while the worker owns a lane.

**The claim barrier is required.** Dispatch a claim-only prompt first: prime,
read project instructions, claim the exact lane, report the claim ID, then
pause. The parent verifies that claim through its own `mai_claims`, checking
the expected worker identity and exact lane. Only then resume that same logical
worker with the implementation prompt. For Codex, retain the actual thread ID
from `codex exec --json`; do not use `--ephemeral` for a flow needing resume.
Keep the same session environment, working directory, and permission to write
the channel on both invocations. Do not assume resume inherits the sandbox:
for an initial `codex exec --sandbox workspace-write`, resume with
`codex exec --sandbox workspace-write resume <thread-id>`. A bare resume can
select read-only mode and prevent channel writes. This channel is brain continuity; the dispatcher still owns
model invocation and prompt delivery. If the host cannot preserve this barrier,
perform the task sequentially instead.

The worker releases its own exact claim before returning. A missing/foreign
specific release is an error in persistent mode. The parent checks that the
claim is gone, waits for the worker to exit, and closes the channel:

```sh
node /absolute/mai-mcp/scripts/mai-worker-session.mjs close /absolute/private-scratch/session
node /absolute/mai-mcp/scripts/mai-worker-session.mjs status /absolute/private-scratch/session
```

Success requires the server process to exit 0 and the retained descriptor to
say `state: closed` and `cleanupVerified: true`. `status` reports recorded
state, not live health or successful worker completion. The dispatcher owns
removing its scratch directory after reading the result. Closing also releases
forgotten claims through that same server; it cannot release other sessions'
claims. Always close in the dispatcher's cleanup path.

The channel calls a keepalive every 30 seconds while idle after prime; stored
claim renewal follows the server's existing 60-second throttle. It processes
requests serially and has a four-hour lifetime. Explicit `close` is the portable
graceful cleanup path. Catchable POSIX SIGTERM/SIGINT also request bounded cleanup.
On Windows, Node process.kill/subprocess.kill with these signals forcibly terminates
the target; it cannot establish cleanup success. See [Node signal behavior](https://nodejs.org/docs/latest-v24.x/api/process.html#signal-events). A killed/crashed server or timed-out write can leave an uncertain
outcome; stop the worker and inspect actual claim state. Never automatically
retry the write, reconnect, or fall back to one-shot execution. A force kill
cannot guarantee cleanup; existing claim expiry/operator cleanup still applies.
`MAI_BRIDGE_TIMEOUT_MS` can lower the persistent call budget within 100..120000
milliseconds, including output delivery. A deadline exits nonzero without writing
a potentially blocking diagnostic; a timed-out write still has an uncertain outcome.
Payloads are limited to 1 MiB, JSON wire frames to 4 MiB excluding the newline (private responses allow another
1 KiB for their correlation envelope), and the pending
queue to 32 requests. Budget or permission failures retain the sequential fallback.

For native subagents, discover deferred tools before concluding they are
missing. Exercise the same child-owned prime/claim/pause/resume/release protocol.
A successful native probe establishes that host/session only; neither old
reports of headless MCP cancellation nor a passing wire-level test establish
every Codex host's current capabilities.
