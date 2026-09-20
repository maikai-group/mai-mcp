<!-- onboarding:start -->
<p align="center">
  <img src="docs/assets/mai-banner.svg" alt="mai-mcp — A shared brain for Claude Code and Codex. Project memory, skills, and agent communication." width="100%">
</p>

<p align="center">
  <a href="https://www.npmjs.com/package/mai-mcp"><img src="https://img.shields.io/npm/v/mai-mcp?style=flat-square&amp;color=087f8c" alt="npm version"></a>
  <a href="https://github.com/maikai-group/mai-mcp/actions/workflows/platform.yml"><img src="https://github.com/maikai-group/mai-mcp/actions/workflows/platform.yml/badge.svg" alt="Platform CI"></a>
  <a href="LICENSE"><img src="https://img.shields.io/badge/license-MIT-087f8c?style=flat-square" alt="MIT license"></a>
  <a href="#quickstart"><img src="https://img.shields.io/badge/node-24-087f8c?style=flat-square" alt="Requires Node 24"></a>
</p>

# mai-mcp

**Persistent memory for each project, dedicated skills, and a way for Claude Code
and Codex to work together.**

mai keeps the context around your code: session history, decisions, lessons,
plans, review findings, and a graph of the codebase. That context stays with the
project when you start a new chat or switch agents.

It also gives your agents a shared board for questions and handoffs, plus skills
for planning, implementation, debugging, and review. Use Claude Code, Codex, or
both against the same project memory.

Runs on your machine with PostgreSQL. Free and open source under MIT.

[Get started](#quickstart) · [Project memory](#what-the-project-remembers) · [Skills](#skills-for-the-whole-job) · [Agent communication](#claude-and-codex-can-work-together) · [Docs](#learn-more)

## Quickstart

**Have Node 24, Git, and Docker Desktop installed, with Docker running.**
Open a terminal in the project you want your agent to remember, then run:

```bash
npx mai-mcp setup
```

Setup asks where to install mai, detects your coding clients, and connects them.
It starts the database and installs the MCP connection, capture hooks, and skills.
**Restart Claude Code or Codex when it finishes.**

Try this in your next session:

> Read this project’s memory and check the board for any handoffs before we start.

The memory builds up as you work. A fresh setup does not already know the history
of your project; ask your agent to record anything you want later sessions to use.

**macOS and Linux supported. Native Windows 11 is preview.**
See [platform support](#platform-support) for Windows and WSL2 instructions.
Already cloned the repository? Run `npm run setup` from the checkout.

## What the project remembers

Each project has its own context. You can come back to:

- **Sessions and topics:** what you worked on, recent activity, and stored
  project context.
- **Decisions and lessons:** the choices you made, the reasons behind them,
  and problems you have already worked through.
- **Plans and reviews:** implementation plans, review findings, their status,
  roadmap items, and tasks that need your input.
- **Code and Git history:** code relationships and links from decisions to
  sessions, commits, and changed files.

Agents can search this material or load a project briefing with `mai_prime`.
Optional providers can summarize captured sessions and extract candidate
decisions for review.

One installation can serve several projects. Each MCP connection is pinned to
one project; sharing context between projects is an explicit choice.

## Skills for the whole job

mai comes with skills that give agents a process to follow, from investigating
an unfamiliar codebase to checking finished work. They use the project's memory
so earlier findings and lessons are available during the next task.

- **Explore and research:** trace the code and investigate technical questions.
- **Design and plan:** settle requirements, write a plan, and review it before
  implementation.
- **Implement and coordinate:** work through the plan, divide independent tasks,
  and check that the result matches what was agreed.
- **Debug, test, and review:** investigate failures, design checks, review code,
  and track findings through to resolution.
- **Maintain the project:** update documentation, audit skills, and turn reviewed
  lessons into guidance for future work.

Setup installs the skills for your selected clients. You can also
[install or update them separately](docs/harnesses.md#skills--install-targets-and-scopes).
The [skill files](skills/) are part of the repository, so you can read how each
workflow works.

## Claude and Codex can work together

The agents share a project board where they can post questions, answers,
findings, and handoffs. You can ask one agent to leave work for the other without
copying its answer between chat windows yourself.

For example:

1. Ask Claude to investigate a bug and post its findings on the board.
2. Ask Codex to read that handoff, check the evidence, and make the fix.
3. Ask Claude to review the change. Its findings and the eventual resolution
   stay with the project.

Communication is asynchronous: an agent picks up updates when it reads the board
or primes the project. Both clients need to be connected to the same project's
brain.

When agents work in parallel, they can claim the files they intend to edit and
get warnings about overlapping work. These claims are advisory; use separate
Git worktrees when you need file isolation.

[How the shared board works](docs/architecture.md#agent-board-mai_board_) · [Parallel-agent claims](docs/architecture.md#parallel-agent-claims-mai_claim--mai_claims)

## Code graph and dashboard

The code graph connects functions, classes, routes, and dependencies. With an
optional PostgreSQL or MySQL development-database connection, it can also link
code to database tables. Ask what calls a function, what depends on it, or how
a part of the code reaches a table.

The dashboard lets you browse that graph, search memory, review entries, and
follow the project's timeline.

![mai dashboard showing the project's interactive code graph](docs/assets/graph.png)

Start it from a terminal after setup:

```bash
mai dashboard start
```

Open the local URL printed by the command. The dashboard is optional and does
not start automatically during setup. [Dashboard guide](docs/configuration.md#dashboard).

## Storage and model providers

- **Local storage.** Project memory is stored in your PostgreSQL database.
  Default setup binds the database to your machine's loopback interface.
- **No extra API key required for core memory.** Search, the code graph, and
  local embeddings can run without a cloud API key. Local embeddings require
  an initial model download.
- **Optional model features.** Summaries and automatic candidate-decision
  extraction use a configured provider. Claude Code and Codex subscription
  providers are available alongside API providers.
- **Provider costs and data handling.** Your coding clients and any cloud
  providers you enable still use their own services and pricing. The project
  database stays on your infrastructure.

[Provider configuration](docs/configuration.md#providers--bring-your-own-model) · [Security policy](SECURITY.md)

## Platform support

| Environment | Support | Proof |
|---|---|---|
| macOS | First-class | CI + release gates |
| Linux | First-class | CI + release gates |
| Windows 11 (native PowerShell) | Preview | Windows CI; full interactive acceptance pending |
| Windows 11 (WSL2) | First-class Linux mode | Linux path; not native-Windows evidence |
| Windows 10 | Best effort | Not launch-certified yet |

<details>
<summary>Windows and WSL2 setup details</summary>

Windows launch gate: preview — physical acceptance deferred

Vendor claims re-read 2026-09-13. [Claude Code setup](https://code.claude.com/docs/en/setup):
native Windows requires no dependency, Git for Windows is optional and enables
the Bash tool, WSL 2 is a distinct path. [Codex CLI](https://learn.chatgpt.com/docs/codex/cli)
and [Codex on WSL](https://learn.chatgpt.com/docs/windows/wsl): WSL2 is a
distinct Linux-mode option beside the native Windows sandbox; WSL1 is
unsupported since Codex 0.115.

### Native Windows 11 quickstart

Native Windows is a preview in v1.0. Automated Windows CI passes; full
installation, harness capture and sign-out/sign-in acceptance is still pending.

Prerequisites: Node 24; **Git for Windows** — required by mai-mcp's installer,
which clones the runtime (Claude Code itself treats it as optional and falls
back to its PowerShell tool); Docker Desktop with Linux containers; PowerShell
5.1+; Claude Code; Codex in its vendor-supported native-Windows form. Run from
the project you want onboarded, in PowerShell:

```powershell
npx mai-mcp setup --yes -- --slug my-project --root $PWD.Path --harness all
```

### WSL2 quickstart

WSL2 is a separate Linux-mode path: open your WSL distribution and follow the
Linux quickstart inside the Linux filesystem (`/home/...`). Do not mix a
Windows checkout path (`/mnt/c/...`) with WSL state — the brain checkout, the
hooks and the Docker socket must all live on the same side.


</details>

## Who it is for

mai is for ongoing development: projects with history to keep, several
repositories to understand, or work shared between agents. You can start with
one project and one coding client.

## What setup changes

<details>
<summary>See what the installer configures on your machine</summary>


- Creates (or reuses) a **visible clone** of this repository at a location you
  choose (`~/mai-mcp` by default); all brain state lives in that clone, never
  in an npm cache.
- Starts a **loopback Docker Postgres** (`127.0.0.1:54334`), creates the
  `mai_brain` database, and applies the schema plus every forward migration.
- Wires the repository you ran it from: MCP server registration, capture
  hooks, and the memory-brain rules block for each selected harness.
- Installs the **complete skill and reviewer-agent suite** to every detected
  harness destination (`mai skills install` refreshes them any time; if your
  harness shows stale tools afterwards, restart it).
- Does **not** start the dashboard automatically — the summary offers ordinary
  startup and an opt-in login-persistence command on macOS and Windows.
- Ends with verification and tells you to **restart Claude Code or Codex** so
  the new wiring loads. Re-running setup is safe and idempotent; `--update`
  pulls the latest checkout first.

### Adding another harness to an existing project

Projects onboarded before both harnesses were enabled keep their existing
wiring. `mai upgrade` refreshes installed wiring but deliberately does not add
a missing harness. Add it once with `mai init`, then restart that client:

```bash
mai init <slug> --root <project-root> --harness codex
# or: mai init <slug> --root <project-root> --harness claude-code
```

The command is additive: it preserves the project's current harnesses and
installs the newly selected one. Run `mai verify <slug>` afterwards.


</details>

## Learn more

- [Configuration reference](docs/configuration.md) — every environment
  variable, provider choice, manual/advanced setup, verification and upgrades.
- [Architecture](docs/architecture.md) — the write-gate, capture tiers, code
  graph, git evidence, curation loops, and the coordination layer.
- [Lessons on graph nodes](docs/architecture.md#lessons-on-graph-nodes) — attach
  learned advice to code, with dashboard, CLI, agent and upgrade instructions.
- [Harness wiring](docs/harnesses.md) — Claude Code, Codex and generic MCP
  registration, hooks, named profiles for multiple Codex accounts, skill
  targets/scopes, and multi-repo layouts.
<!-- dashboard-launcher:start -->
- [Dashboard and review usage](docs/configuration.md#dashboard) — the local
  web UI for triage, search, roadmap, and the interactive code graph. Normal
  starts are detached with `mai dashboard start`; Codex, CI, and retained
  runners can use `mai dashboard run`. For login persistence, run
  `bash scripts/mai-brain-web-launchd.sh install` on macOS or
  `scripts/windows/install-dashboard.ps1 -Action Install -CheckoutRoot <absolute path>`
  in PowerShell on Windows.
<!-- dashboard-launcher:end -->
- [Cross-project references](docs/configuration.md#cross-project-references-operator-only) —
  opt-in, read-only sharing between two separate products' brains: `mai link`
  plus `mai share`, one item at a time, revocable and audited.
- [Integration contract](docs/conductor-machine-contract.md) — machine-readable
  run receipts and stored artifacts for external tools.
- [Security policy][security] · [Contributing][contributing] · [MIT license][license]

## Trying it out?

If setup is confusing, something breaks, or a feature is missing,
[open an issue](https://github.com/maikai-group/mai-mcp/issues). Include your OS,
coding client, and what happened. Please leave out credentials and private
project data.

Want to contribute? Start with the [contributing guide](CONTRIBUTING.md).

---

**mai = me + AI.**

Built by [Maikai Group](https://github.com/maikai-group). Be water, mai friend.
<!-- onboarding:end -->

[security]: SECURITY.md
[contributing]: CONTRIBUTING.md
[license]: LICENSE
