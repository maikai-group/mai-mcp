---
name: write-plan
description: Creates a complete, locked-in implementation plan from an existing spec. Use after mai-design, optional brainstorming, or another settled spec design. Produces a plan an execution agent with zero context can follow literally. Required before plan-execute. Triggers on "create a plan", "write the plan", "plan the feature", or "turn this spec into a plan".
---

<!-- SPDX-License-Identifier: MIT — Copyright © 2026 Maikai Group Inc.
     Part of mai-mcp (MIT — the whole project; see LICENSE). Copy freely. -->

# Plan Creator

Your job is to produce a complete, unambiguous implementation plan. The plan must be detailed enough that an execution agent (or subagent) with zero codebase context can follow it literally — no improvising, no additions, no omissions. Every decision must be made HERE, not deferred to execution.

---

## Invocation

**Announce at start:** "I'm using the write-plan skill to build the implementation plan."

**Save plans to:** `docs/superpowers/plans/YYYY-MM-DD-<feature-name>.md`
- User preferences for plan location override this default

---

## When to use

**Prerequisite:** the scope, requirements, and key decisions are already established in a written
spec before this skill runs. If they are not, establish them with `mai-design`, the first-party
design workflow, or another design process. Optional `superpowers:brainstorming` is also valid.
A settled spec written any other way is equally valid input. This skill starts from the spec, and
a plan built on an unsettled design is the expensive thing to redo.

Do NOT use this skill while scope, requirements, or key decisions are unsettled; stop and establish a written spec first.

---

## Non-negotiable rules

1. **Read every existing file that will be touched or referenced.** Verify exact paths from the repository; do not infer directory layouts, filenames, or exports. Mark genuinely new files as `Create` and inspect their destination directory and nearest relevant examples.

2. **Wait for user answers before proceeding to Phase 2.**

3. **Do not assume. Do not defer to the execution agent.**

4. **No Placeholders.** Every step must contain the actual content an engineer needs. These are **plan failures** — never write them:
   - "TBD", "TODO", "implement later", "fill in details"
   - "Add appropriate error handling" / "add validation" / "handle edge cases"
   - "Write tests for the above" (without actual test code)
   - "Similar to Task N" (repeat the code — the agent may be reading tasks out of order)
   - Steps that describe what to do without showing how (code blocks required for code steps)
   - References to types, functions, or methods not defined in any task

5. **Open every target test suite and copy its real helper, prefix, and mock structure before writing a single assertion in the plan.** None of that structure is inferable from the production file. Follow the test-suite inventory below; an unread suite is not a valid basis for test code.

<!-- mai:shared:cleanup start — synced from skill-blocks/cleanup.md.
     Do NOT hand-edit inside this block; the sync rewrites it wholesale and the
     edit disappears silently (lesson 420dbda2). -->
### Mandatory temporary-artifact cleanup

**Cleanup is part of completion, including failed or cancelled runs.** If this workflow creates no temporary artifacts, report cleanup as not applicable; do not allocate scratch just to satisfy this rule.

- **Track ownership when allocating.** Record each exact task-owned scratch/worktree path and its cleanup owner, including child-agent allocations. This covers dependency copies, build output, caches, logs and probes under `/tmp`, `/private/tmp`, `$TMPDIR`, `/private/var/folders/.../T`, `%TEMP%` or elsewhere. Use OS temp only for disposable work; place implementation work that must survive the task in the project's designated durable workspace. Reuse suitable existing environments and evidence instead of creating another dependency tree for each check.
- **Clean before returning.** Stop and await owned processes/reviewers using the paths. Preserve deliverables, unique changes and necessary compact evidence outside disposable roots; verify that preservation before deletion. Remove completed task-owned dependency/build/cache trees, even on failure. Moving bulky disposable builds elsewhere, leaving them for the OS, or relying on an age-based janitor does not satisfy cleanup.
- **Delete only verified owned paths.** Recheck exact resolved paths and ownership; never sweep a temp parent, use broad deletion globs, follow a symlink into an unowned tree, or delete another agent's files. Inspect tracked, untracked and ignored contents before removing an owned Git worktree with `git -C <surviving-repo> worktree remove <owned-path>`; preserve unique work and never force-remove unknown changes. Use the existing managed cleanup helper for marked review scratch. Keep linked worktrees outside recursively deleted scratch roots.
- **Close the ownership chain.** Children report cleanup and any supplied environment still in use; its named owner must accept the handoff and clean it after its final consumer stops. The parent reconciles all child paths before task closeout. Active or frozen user work is preserved, with its owner and next action recorded; it is not silently reclassified as disposable.
- **Verify and report.** Check that removed paths no longer exist and removed worktrees are absent from Git's registry. Include `Cleanup: removed <paths>; retained <path, owner, reason, next action>` in the existing completion report. Report failed or permission-blocked removal as incomplete cleanup with the exact path and error; do not claim full completion while disposable artifacts remain. On resumption after an interrupted run, reconcile its recorded paths first.
<!-- mai:shared:cleanup end -->

---

## Dependencies

| Dependency | What it is | Without it | Harness-native fallback |
|---|---|---|---|
| `mai-design` | Ships in this suite. Establishes a written spec from an unsettled request | The first-party design procedure is unavailable | Settle requirements and key choices in a written spec before planning |
| `mai-research` | Ships in this suite. Resolves consequential technical unknowns with source evidence | Its research procedure is unavailable | Inspect project/dependency sources and authoritative documentation; state unresolved evidence gaps |
| `mai-test-design` | Ships in this suite. Designs behavioral coverage from actual suites and requirements | Its test-design procedure is unavailable | Build the requirement-to-test matrix from the real suite inventory below |
| `plan-review` | Ships in this suite. Validates the finished plan against the codebase | The plan has no independent approval | None — stop; an unreviewed plan does not proceed to execution |
| `plan-execute` | Ships in this suite. The recommended execution workflow named in the handoff | The packaged executor is unavailable | Execute task-by-task with the approved plan and its verification gates |
| `subagent-rules` | Ships in this suite. The rules injected when the handoff selects subagent execution | Subagent execution lacks its required prompt discipline | Do not dispatch subagents; use sequential execution |
| `superpowers:brainstorming` | Optional external. Interactive design exploration before planning | Its design workflow is unavailable | Establish scope, requirements and key decisions in a written spec by any means before starting this skill |
| `superpowers:subagent-driven-development` | Optional external. Named in the execution-options handoff | That dispatch workflow is unavailable | Offer plan-execute, which ships in this suite |
| `superpowers:executing-plans` | Optional external. Named in the inline-execution handoff | That inline workflow is unavailable | Offer plan-execute, which ships in this suite |

---

## Phase 1: Analysis

Use `mai-research` only when a consequential external or version-specific unknown remains.
Use `mai-test-design` when requirements need a behavioral verification matrix; carry its real
fixtures, discriminators and commands into the tasks. Neither is a mandatory pass for every plan.
Resolve their material unknowns before freezing the plan, preserving the prerequisite settled spec.

### Step 1: Read and Audit the Codebase

Read every existing file that will be touched or referenced. Then catalogue:

<!-- mai:shared:navigation-preflight start — synced from skill-blocks/navigation-preflight.md.
     Do NOT hand-edit inside this block; the sync rewrites it wholesale and the
     edit disappears silently (lesson 420dbda2). -->
### Conditional navigation preflight

At this discovery checkpoint, make one automatic `mai_navigate` call when the tool is exposed, the work is substantive, and a concrete unresolved question could change the current artifact's constraints, affected consumers or verification. Use the adjacent intent guidance. Skip trivial edits, already-resolved questions and questions requiring unsuitable sensitive evidence.

Before calling, state the bounded question and that an enabled Jev call sends selected project evidence to TypeSafe. Existing project opt-in is sufficient; do not enable a provider, obtain credentials or ask for repeated confirmation. If enablement is unknown, a disabled response is a harmless capability check, not permission to change configuration.

Use known terms/node IDs and only relevant labelled excerpts. Keep expected answers, hidden evaluation labels and credentials out of input. For `family`, first verify the causal mechanism; similarity alone never establishes a defect.

One automatic call per invocation is the default. At most one additional call is allowed for a newly discovered, specific high-risk uncertainty; explain that uncertainty before calling. Do not retry at the skill layer. One tool call can contain multiple provider evaluations and retries, so tool-call count alone is not a cost measurement.

Inspect status, omissions, freshness and provenance. Verify every material reference against current source or its authoritative record before using it. Preserve contrary evidence and distinguish caller-supplied excerpts from source-verified material.

Disabled, absent, busy, unavailable, empty, insufficient, cancelled or partial navigation continues through ordinary graph/search/source tools. Navigation never proves completeness or replaces a required consumer/family sweep. Do not reduce required review breadth, approve work, file or close findings, amend an approved plan, or expand scope because of a ranking.

When material, report the verified addition, rejected lead or remaining gap in the existing artifact/report. Carry source-backed constraints and verification requirements into the plan; execution remains governed by that approved plan. Do not claim reliability or token savings without complete-workflow measurements.
<!-- mai:shared:navigation-preflight end -->

Navigation intent: choose layout, impact or decisions for one implementation dependency, affected-consumer or historical constraint question. Carry verified answers into concrete task steps and verification; do not leave the executor to rediscover them.

#### 1.1 Existing Code Inventory
- What files already exist that relate to this work?
- What patterns, conventions, and abstractions does the project use?
- What utilities, helpers, or shared code can be reused?
- Read the project's instructions file (`CLAUDE.md`, `AGENTS.md`, or your harness's equivalent) for rules and constraints

#### 1.2 Dependency Map
- What does this feature depend on? (other modules, APIs, database tables, external services)
- What depends on this feature? (other code that imports/calls what we're changing)
- Are all required packages installed?

#### 1.3 Interface Inventory
For every function, component, class, or API endpoint the plan will create or modify:
- Define the exact interface (parameters, return types, props)
- **No `any` types or type-safety bypasses.** If the type can't be determined, flag it for user decision.
- Check that interfaces match what callers/consumers expect

#### 1.4 Data Model Check
If the feature involves database changes:
- What tables/collections are affected?
- What columns/fields need adding or changing?
- Does the schema migration need to happen before or after code changes?
- Are there existing queries that need updating?

#### 1.5 Style/UI Check (if applicable)
If the feature has a UI component:
- What design system/theme does the project use?
- What existing components can be reused?
- Are there style conventions to follow? (tokens, CSS variables, component library)

#### 1.6 Test-Suite Inventory (when adding or changing tests)

For **each** target suite, open the file and any helper, fixture, or test configuration it relies on before authoring assertions. Record:

- Exact suite path, imports, and the enclosing test group/insertion point.
- Real helper names, signatures, and representative calls, including required fixture fields.
- Actual prefixes and identifiers used for test data, isolation, and cleanup.
- Mock declarations, factories, hoisting/import order, and reset/restore behavior.
- Setup/teardown hooks, cleanup ownership, and the configured command or wrapper that runs this suite.

Copy the relevant existing scaffold into the task's **Test basis**, with `file:line` citations. Keep excerpts focused on what the planned tests use; record verified absences explicitly (for example, no mocks). Do not substitute a neighboring suite's conventions for an existing target suite's own structure.

For a new suite, verify that the target path is absent, inspect the destination directory, test discovery configuration, and closest relevant existing suite. Cite that suite as the source pattern and explicitly specify adaptations and any new helpers in the plan. If no relevant suite exists, derive the scaffold from the actual test configuration and define it fully as new code. Missing evidence must be resolved before test authoring; never invent an existing helper or leave discovery to execution.

### Step 2: Flag All Ambiguities

Before writing the plan, list every open decision — anything with more than one valid answer. Ask the user to resolve ALL of them now.

Examples of things that must be decided here:
- Architecture choices with trade-offs (e.g., polling vs. WebSocket)
- Error handling strategy (fail silently, show toast, redirect)
- Edge cases with no obvious answer
- Types you cannot infer from context
- Whether to refactor existing code or work around it
- Performance vs. simplicity trade-offs

### Step 3: Resolve the roadmap card

Read the roadmap with `mai_ideas {include_closed:true}` when that surface is available. Link the
plan only when the source spec/brief names a card UUID, or when one exact title matches exactly one
card. Never fuzzy-match a title, create a duplicate card, or move a card merely because planning
started.

Every plan carries exactly one roadmap-card identity header. Record one of these exact header shapes in Phase 2:

- `**Roadmap card:** \`<uuid>\` — <title>`
- `**Roadmap card:** none — user-directed work has no existing roadmap card`
- `**Roadmap card:** unresolved — <specific ambiguity>`

An unresolved card is an ambiguity under Step 2 and must be settled before the plan is frozen.
`idea → planned` remains operator curation. This skill records the identity; `plan-execute` owns the
two evidence-backed agent transitions, `planned → building` at execution start and
`building → shipped` after verified completion.

### Step 4: Audit operator-owned work

After requirements are frozen and before authoring the plan, enumerate every action that only the
operator can perform: manual smoke tests, external authorization, service or device restarts,
publishing, production confirmation, and any other user-only step. If the inventory is empty, omit the Operator Checklist section entirely. If any such action exists, emit exactly one level-two
section in this form:

````markdown
## Operator Checklist

```operator-checklist
[
  {
    "key": "O1",
    "kind": "blocking",
    "title": "Short operator-facing action",
    "instructions": "Complete, executable instructions including the success condition."
  }
]
```
````

The wire contract is self-contained:

- The checklist array contains 1–100 entries.
- Each entry contains exactly the four fields `key`, `kind`, `title`, and `instructions`, with no extras.
- Keys are stable, unique, contiguous `O1`…`On`: `O` followed by a nonzero decimal digit and then zero or more decimal digits.
- `kind` is exactly `blocking` when execution cannot close until the operator completes the action, otherwise `follow-up` for post-ship work.
- Titles are non-blank strings of at most 300 characters and contain no C0 or DEL control characters.
- Instructions are non-blank strings of at most 4,000 characters, are complete enough to execute without duplicate prose, and contain no C0 or DEL controls except tab, line feed, and carriage return.

The sole `## Operator Checklist` heading contains the sole `operator-checklist` fence as its only content: only blank lines may appear between the heading and fence or after the fence before the next level-two heading.

Operator checklist bodies appear once: never repeat them in an operator-run section, ordinary plan prose, chat handoff, or board handoff.

The plan's normal `- [ ]` execution boxes track agent implementation only; they never represent operator completion.

---

## Phase 2: Implementation Plan

Only after all ambiguities are resolved, write the implementation plan.

### Scope Check

If the spec covers multiple independent subsystems, suggest breaking into separate plans — one per subsystem. Each plan should produce working, testable software on its own.

### File Structure

Before defining tasks, map out which files will be created or modified and what each one is responsible for. This is where decomposition decisions get locked in.

- Design units with clear boundaries and well-defined interfaces
- Prefer smaller, focused files over large ones that do too much
- Files that change together should live together
- Follow established patterns in the existing codebase

### Plan Document Format

Every plan MUST start with this header:

```markdown
# [Feature Name] — Implementation Plan

> **For agentic workers:** Use plan-execute skill (recommended) or superpowers:subagent-driven-development to implement this plan task-by-task. Invoke subagent-rules before dispatching any subagent. Steps use checkbox syntax for tracking.

**Goal:** [One sentence describing what this builds/fixes/changes]

**Roadmap card:** `<uuid>` — [exact existing title, or `none — user-directed work has no existing roadmap card`]

**Requirements:**
- R1: [requirement]
- R2: [requirement]
- R3: [requirement]

**Architecture:** [2-3 sentences about approach and key decisions]

**Tech Stack:** [languages, frameworks, key libraries]

---

## File Map

| Action | File | Responsibility |
|--------|------|---------------|
| Create | `exact/path/to/file.ext` | ... |
| Modify | `exact/path/to/existing.ext` | ... |

---
```

### Task Structure

Break the work into discrete tasks. Each task is one coherent unit of work:

````markdown
### Task N: [Name]

**Files:**
- Create: `exact/path/to/file.ext`
- Modify: `exact/path/to/existing.ext`

**Depends on:** Task M (if applicable)
**Can parallel with:** Task P, Task Q (if applicable)

- [ ] **Step 1: [Action description]**

```language
// Complete code — no placeholders, no "add appropriate handling"
```

- [ ] **Step 2: Verify**

Run: `[exact build/test command]`
Expected: [What should happen — specific, verifiable output]

- [ ] **Step 3: Commit**

```bash
git add [specific files]
git commit -m "feat: [description]"
```
````

For each task that adds or changes tests, place a **Test basis** before its test code: include the per-suite citations and scaffold from Phase 1.6, identify what remains in place versus what is inserted or changed, and show the complete new test code. Any new helper must be defined in this task or an explicit prerequisite task. Include a first execution step to reopen the cited suite and helpers and check that the scaffold still matches before applying the tests; a mismatch is a plan discrepancy to resolve, not permission to improvise.

### Task Ordering Rules

- Tasks must be ordered so that no task depends on output from a later task
- Mark dependencies explicitly: `**Depends on:** Task N`
- Mark parallelisable tasks explicitly: `**Can parallel with:** Task N, Task M`
- If using subagent-driven execution, tasks in the same parallel batch MUST have zero dependencies on each other

### Verification Per Task

Every task must include a verification step with:
- The exact command to run
- The exact expected output or behaviour
- What constitutes a pass vs. failure

---

## Phase 3: Self-Review

After writing the complete plan, review it yourself before presenting to the user:

**1. Requirements coverage:** For each requirement in the header, can you point to a task that implements it? List any gaps as `R[N] → NO TASK FOUND`.

**2. Placeholder scan:** Search the plan for any of the patterns from the "No Placeholders" section. Fix them.

**3. Type consistency:** Do the types, method signatures, and property names used in later tasks match what was defined in earlier tasks?

**4. Task ordering:** Does any task import/reference something created by a later task? Fix the order.

**5. Scope check:** Does any task add functionality not listed in the Requirements? Flag or remove it.

**6. Verification commands:** Can every `Run:` command actually execute? Is the working directory correct?

**7. Invariant producers** *(only if this plan changes a contract — a schema column, a sentinel or enum value, a response/payload shape, a function or tool signature, or a stated invariant)*: for each invariant the plan states, enumerate every path that could produce or violate it — every writer of the column, every caller of the verb, every branch reaching the state — and confirm the plan enforces it at each one. Grep for the column, the enum literal, the function name; put the count in the plan. An invariant enforced at one producer and asserted for all of them is the defect most likely to survive review.

**8. Cited claims:** every assertion the plan makes about code it does *not* change — "the gate already validates this", "the driver returns a number", "the hook fires once per session" — carries a `file:line` or a command that shows it. Extrapolated APIs read exactly like real ones, so an uncited claim is a guess wearing a fact's clothes. Uncited claims that a requirement depends on must be verified before the plan is presented, not left for a reviewer.

**9. Operator-owned work:** parse the `operator-checklist` JSON block when present and validate its
single section, schema, bounds, contiguous unique keys, semantic `blocking|follow-up` kinds, and
non-empty executable titles/instructions. Re-enumerate every manual or user-only action and confirm
each maps to exactly one operator key and appears nowhere else. If no manual action exists, confirm
the section is absent. Normal execution checkboxes must not stand in for operator completion.

**10. File and test evidence:** Verify every existing path and imported symbol against the opened source. For each test task, check its Test basis against the actual target suite: helpers and arguments, fixture fields, prefixes, mocks, hooks, insertion point, and runner command must match, or the task must explicitly implement the change. Confirm new files and helpers are labeled as new and fully specified. A test inferred only from production code or an unread neighboring suite fails this check.

Checks 7 and 8 exist because reviewers should be the second line of defence, not the first: half the findings on a heavily-reviewed plan have been repeats of a defect shape the author could have swept for once.

If you find issues, fix them inline before presenting the plan.

---

## Phase 4: Review and Handoff

After saving the plan, present it to the user for approval. Once approved:

**0. Register the plan.** Call `mai_plan` with the plan's repo-relative `path`. Record the returned
id in the plan document header as `**Plan record:** <uuid>`. Reviews and findings attach to this id,
so a plan that is not registered cannot receive them.

Re-read the recorded roadmap card while registering. Do not move it here. If it is not `planned`,
say so in the handoff: execution cannot make the agent-owned `planned → building` transition until
the operator places it in `planned`. A `none` header is a deliberate no-op, not permission to invent
a card.

**1. Run plan-review:** Invoke the `plan-review` skill to validate the plan against the actual codebase. This catches wrong file paths, non-existent imports, schema mismatches, and other reality gaps.

**2. Fix any blockers** found by plan-review. Re-run until APPROVED.

---

## Output

**3. Offer execution choice:**

**"Plan complete, reviewed, and saved to `docs/superpowers/plans/<filename>.md`. Execution options:**

**1. Plan Execute (recommended)** — Uses `plan-execute` skill with between-task audits, code review after every task, and verification-before-completion at the end.

**2. Subagent-Driven** — Uses `superpowers:subagent-driven-development` with `subagent-rules` injected into every subagent prompt. Fresh subagent per task + two-stage review.

**3. Inline Execution** — Uses `superpowers:executing-plans` for batch execution with checkpoints.

**Which approach?"**

Regardless of choice, `subagent-rules` MUST be invoked before dispatching any subagents.
