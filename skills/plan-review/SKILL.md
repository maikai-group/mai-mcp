---
name: plan-review
description: Independently review a plan or substantive delta against requirements and source contracts. Broad coverage is established once per architecture revision; bounded repairs need only delta review. Does not routinely implement or test the proposed application.
---

<!-- SPDX-License-Identifier: MIT — Copyright © 2026 Maikai Group Inc.
     Part of mai-mcp (MIT — the whole project; see LICENSE). Copy freely. -->

# Plan Review

Establish whether a plan is coherent, complete and compatible with the existing system, using evidence proportional to the consequences of a mistake.

---

## Invocation

**Announce at start:** "I'm using the plan-review skill to verify the plan against the codebase before execution."

### Independence and scope

A reviewer must not have authored the substantive changes it approves. A first independent session may review inline. Otherwise dispatch an independent reviewer without author conversation history. Prefer resuming that reviewer for bounded follow-ups if it never authored a repair; familiarity with reviewed source is useful. Fresh sessions and model rotation are optional.

Supply the plan id/path, immutable SHA, governing spec/source pins, selected breadth, actual diff, affected contracts, relevant finding UUIDs and existing verification evidence. Include scratch ownership only when needed. For headless Codex environments needing the stdio bridge, resolve the absolute Node and bridge paths, project slug/root and safe argv/file access to the required brain tools. The bridge does not require parent reasoning or a requested verdict.

## When to use

Use for independent validation of an implementation plan or a substantive delta before execution. Do not repair or execute the plan during review. Cosmetic edits normally need only an editorial diff/equivalence check by the coordinating session, not this skill.

Standalone and cycle reviews both accept `breadth=broad` or `breadth=delta`. Broad reviews cover the full plan and governing requirements once per architecture revision. Deltas read the header, actual changes, affected requirement sections, producer/consumer contracts and relevant regressions. Apply the checks below only within the selected scope.

`breadth=clearance` requires explicit exhaustive-mode authority. It adds an end-to-end review and the requested full implementation verification. A strong model does not imply this mode.

A delta may inspect a newly encountered affected boundary without reopening the entire plan. If evidence instead establishes changed requirements, architecture or a material integration boundary, return `SCOPE_ESCAPE` with the frozen SHA and dependency evidence. Do not post a misleading completed review or invent a blocker solely to request broader scope.

Stop early when fundamental failures make further inspection unproductive; record actual coverage and gaps. An incomplete broad review does not establish complete architecture coverage.

### Severity and verification

A BLOCKER requires evidence of a violated requirement, unsafe behavior, impossible execution step, or unresolved prerequisite essential to approval. Explain the consequence. Severity never selects review breadth.

Warnings are nonblocking concerns; notes are optional observations. Typos, equivalent wording, cosmetic line drift and clear editorial corrections usually need no finding. A missing receipt field or unrun implementation test is not automatically a blocker. Classify a missing check as approval-critical only when its uncertainty prevents judging the plan.

Plan review normally uses source inspection, contract tracing and static command validation. Run a focused isolated probe only when it resolves consequential uncertainty that inspection cannot settle. Do not routinely construct the complete proposed implementation, install full app/backend environments, or run its matrix. Implementation checks remain explicitly pending for execution.

Reuse trustworthy existing verification per [the convergence reference](../plan-review-cycle/references/convergence.md): unchanged relevant inputs and environment preserve a result across plan SHA changes. Missing metadata affects only that check. Record source-only verification honestly. Mutation tests are useful when a discriminator is uncertain, not mandatory for every finding.

### Before You Begin: Identify the Plan Type

Read the plan header and determine what kind of work it covers. This determines which audit sections apply.

| Plan type | How to identify | Extra audits required |
|-----------|----------------|-----------------------|
| **Port / migration** | Source file listed, target file listed, framework change | Source Fidelity audit (Phase 3) |
| **Contract change** | Adds/changes a schema column, a sentinel or enum value, a response/payload shape, a function or tool signature, or states a new invariant | Invariant & cross-component audit (2.8) |
| **Backend feature** | API routes, database queries, server-side logic | Schema audit, auth pattern audit |
| **UI component / page** | Frontend components, styling, client-side state | Style convention audit, API integration audit |
| **General / mixed** | Anything else | Apply all relevant checks from each section |

A plan can be more than one type — a backend feature that adds a column is both.

---

## Non-negotiable rules

1. **A plan that fails this review does NOT proceed to execution.** You return a BLOCKED verdict with a clear list of what must be fixed. The plan author fixes it and re-submits.

2. **The reviewer preserves the review target** — findings and the final report are its normal outputs; an explicit `SCOPE_ESCAPE` handoff reports a material scope change. Inspect the existing checkout directly. Any probe that writes files uses an exclusively owned isolated worktree or small scratch directory, preserving the reviewed files, index, HEAD and branch refs. Creating/removing an owned detached worktree is allowed within the task's filesystem permissions; its Git registration is not a reason to require an archive copy.

3. **The review is one atomic post.** Do NOT write a review markdown document. The tool call is the review. A delta reporting a material scope change returns its evidence to the coordinator without claiming completed review.

4. **Reuse owned environments; allocate only what the probe needs.** Reuse matching evidence and isolated worktrees/dependencies across deltas. A new detached worktree must start at the pinned source revision; reproduce and verify any relevant uncommitted inputs separately. An archive remains an option when Git history/index is unnecessary. Do not implement the full plan as a review rehearsal. Put temporary payloads/caches in one owned scratch root when needed, and keep linked worktrees outside roots subject to recursive cleanup or the scratch janitor. Leave supplied worktrees to their owner. After probes stop, preserve useful changes/evidence and remove only disposable review-owned worktrees through `git worktree remove`; never force-remove unknown changes. Clean scratch separately.

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
| `plan-execute` | Ships in this suite. The recommended approved-verdict handoff | The packaged executor is unavailable | Hand the approved plan to a task-by-task harness-native execution workflow |
| `plan-review-cycle` | Ships in this suite. Owns supplied review environments and the marked scratch helper | Standalone reviewer owns any environment it creates | Use one secure-temp root for payloads/caches and separate Git-managed cleanup for owned worktrees; report ownership and cleanup |
| `superpowers:executing-plans` | Optional external. Named in the approved-verdict handoff | That external executor is unavailable | Recommend plan-execute, which ships in this suite |
| `superpowers:subagent-driven-development` | Optional external. Named in the same handoff | That dispatch workflow is unavailable | Recommend plan-execute, which covers the execution path |

---

## Phase 1: Pin and read the selected scope

Fetch the current plan record with `passes: "latest"` and verify its SHA against the file before review. Pin any governing spec/source revisions as well. Retrieve relevant findings by subject/paths or UUID and follow recurrence lineage as needed; do not load every historical pass by default.

For broad review, read the complete plan and governing requirements. Inventory requirements, file actions, imports/interfaces, task dependencies and proposed verification. Inspect the source and assets needed to verify those claims; a referenced large file need not be read end to end when the relevant contract is bounded.

For delta review, inventory only changed sections and their affected dependencies. Compare actual old/new revisions; the author's scope summary is a starting point, not proof of completeness. Read enough surrounding source and governing requirements to judge the repair and its regressions. Unchanged unrelated sections retain their prior coverage.

For ports/migrations, compare the source behavior relevant to this scope against the proposed replacement. Expand source inspection where necessary to detect dropped behavior.

Identify operator-only actions in the reviewed scope and validate their checklist under 2.9. In a delta, preserve prior checklist coverage unless the diff or affected action changes it.

---

## Phase 2: Codebase Cross-Reference

Work through the inventory from Phase 1 systematically. For each item, verify it against the actual filesystem and codebase — find the file, grep the contents, read the source. Do not guess.

### 2.1 File Existence Checks

For every file in the File Map:

**Modify files:**
- Does this file actually exist at the exact path stated?
- If the plan references specific line numbers (e.g. `file.ts:45-80`), do those lines contain what the plan expects?

**Create files:**
- Does this path already exist? If yes: is the plan overwriting something intentionally or is this a naming mistake?
- Is the directory structure consistent with the existing codebase layout?

Flag a mismatch as a BLOCKER only when it makes a required step invalid or ambiguous in a consequential way. Cosmetic line drift or an unambiguous prose typo is editorial.

### 2.2 Import and Dependency Checks

For every import in the plan's code blocks:

- Does the imported file/module exist at the stated path?
- Does the named export actually exist with that exact name in that file?
- Is the import style consistent with the rest of the codebase? (e.g. named vs default imports — follow whatever the project does)
- Are third-party libraries installed? Check `package.json`, `requirements.txt`, `Cargo.toml`, `go.mod`, or whatever dependency file the project uses.

**Flag wrong paths and non-existent named exports as BLOCKERs. Flag wrong import style as WARNINGs.**

### 2.3 Component, Function, and Module Checks

For every component, hook, service function, class, or utility referenced by name:

- Does it exist in the codebase with that exact name?
- Is it imported from the correct path in the plan?
- Does its actual interface (props, parameters, return type) match how the plan uses it?

Identify the project's key directories (components, hooks, services, utils, lib, etc.) and pay special attention to references into those areas.

**A plan referencing a function/component that doesn't exist or has a different interface is a BLOCKER.**

### 2.4 Type and Interface Checks

For every type or interface in the plan:

- If it references an existing type from the codebase, does that type actually exist with that name?
- Are there any `any` types (TypeScript) or equivalent type-safety bypasses in the plan's code blocks?
- Are type names used consistently across all tasks? (if Task 2 defines `WorkoutItem` but Task 5 uses `WorkoutEntry`, that's a bug)
- Are required fields/props complete — no missing required members?

Report unsafe type bypasses or incompatible types with their concrete consequence. A spelling mismatch confined to non-normative prose is editorial.

### 2.5 API and Database Checks

For every API call, database query, or route handler in the plan:

- Does the table/collection/model name exist in the schema?
- Do the column/field names match the actual schema?
- Does the route path match the existing API route structure?
- Are auth/authorization patterns consistent with how the project handles them?
- Are queries safe — no wildcard selects (`SELECT *`), no unparameterized inputs?

**Wrong table/column names and incorrect auth patterns are BLOCKERs.**

### 2.6 Style and Design System Checks

For any UI plan referencing colours, spacing, or design tokens:

- Does the project have a design system or theme? If so, are the plan's references consistent with it?
- Are there hardcoded values (hex colours, pixel values) where the project uses tokens/variables?
- Does the styling approach match the project's pattern? (CSS modules, Tailwind, styled-components, StyleSheet.create, etc.)

Style differences are normally nonblocking. Block only when the approach violates an explicit requirement or cannot work with the application.

### 2.7 Verification Command Checks

For every `Run:` command in the plan:

- Is the working directory correct?
- Does the test file path exist (for existing tests) or will it be created in a prior task?
- Is the test/build command syntax correct for the project?
- Does the `Expected:` output match what the code would actually produce?

**Broken commands that can never succeed are BLOCKERs. Suspicious expected outputs are WARNINGs.**

### 2.8 Invariant and Cross-Component Claims (Contract Changes Only)

**Skip this section unless the plan is a contract change** (see the plan-type table). On an ordinary plan the blast radius is visible in the diff; on a contract change it is not, and that gap is the only reason this section exists. Do not run it on every plan — a check that always fires gets tuned out.

**Enumerate the producers of every invariant.** For each invariant the plan states — "counters never decrement", "every citation is project-scoped", "nothing changes without an operator POST" — list every path that could produce or violate it: every writer of the column, every caller of the verb, every branch that reaches the state. Then confirm the plan enforces it at *each* one.

Enumerate mechanically and put the number in the review: grep for the column, the enum literal, the function name; count the call sites. "The plan handles this" without an enumeration is not a check. **An invariant enforced at one producer but asserted for all of them is a BLOCKER** — it passes review and fails in production, and it is the defect shape that recurs most.

**Require a citation for claims about code the plan does not change.** Any assertion about existing behaviour — "the gate already validates this", "the hook fires once per session", "the driver returns this as a number" — must carry a `file:line` or a command that demonstrates it. Extrapolated APIs read exactly like real ones, which is why reading is not enough. **Uncited behavioural claims are WARNINGs; an uncited claim that a requirement depends on is a BLOCKER.**

### 2.9 Operator Checklist Semantics and Single-Source Ownership

Apply this audit during broad review and when a delta changes operator actions or checklist structure. Validate the applicable
wire contract:

- The sole level-two heading contains the sole `operator-checklist` fence as its only content, with only blank lines outside the fence.
- The JSON root is an array of 1–100 entries.
- Every entry contains exactly `key`, `kind`, `title`, and `instructions`, with no extra fields.
- Keys are unique and contiguous `O1`…`On`: `O` followed by a nonzero decimal digit and then zero or more decimal digits; kinds outside `blocking|follow-up` are invalid.
- Titles are non-blank, at most 300 characters, and contain no C0 or DEL controls.
- Instructions are non-blank, executable, at most 4,000 characters, and contain no C0 or DEL controls except tab, line feed, and carriage return.

Invalid JSON/schema that prevents task synchronization, or incorrect blocking semantics, is a BLOCKER. Treat presentation-only issues by their actual consequence. A closeout gate marked `follow-up` is a BLOCKER. A post-ship action marked
`blocking` without an explicit justification is a BLOCKER.

Enumerate every manual-action producer in the plan tasks and prose, then map each action to exactly
one operator key. A user-only action outside the structured block, any repeated title/instruction
body, an operator-run section duplication, or a normal execution checkbox that represents operator completion
is a BLOCKER. If the producer inventory is empty, the structured section must be absent; if it is
non-empty, exactly one structured section must exist.

Reviewers never mutate or sync operator tasks. This phase validates the immutable plan only; task
creation belongs to execution after approval.

---

## Phase 3: Source Fidelity Audit (Ports/Migrations Only)

This phase only applies when the plan is porting code from one framework/platform to another. Skip for other plan types.

Compare the source behavior inventoried in Phase 1 against the tasks in the selected scope.

### 3.1 Feature Coverage

For every functional unit in the source (component, handler, route, class method):
- Is there a corresponding implementation in the plan?
- Is the mapping to the target framework correct?

### 3.2 Event/Handler Coverage

For every event handler or callback in the source:
- Is it present in the plan with the correct target-framework equivalent?
- Are framework-specific event name translations correct?

### 3.3 State Coverage

For every piece of state in the source:
- Is it present in the plan?
- Is the initial value preserved?
- Are there any state variables that were silently dropped?

### 3.4 Interface/Props Coverage

For every prop, parameter, or public interface in the source:
- Is it present in the plan's target implementation?
- Is the type correct?
- Are any silently dropped without a documented reason?

### 3.5 Navigation/Routing Coverage

For every navigation call or route definition in the source:
- Is it mapped to the target framework's routing approach?
- Are paths/routes correct?

### 3.6 Style Coverage

For every style in the source:
- Is there a corresponding style in the target format?
- Are source-framework-specific properties that have no target equivalent dropped or flagged?

### 3.7 Data/API Coverage

For every API call, data fetch, or external integration in the source:
- Is there a corresponding entry in the plan?
- If the target framework requires a different integration pattern, is it accounted for?

**Any dropped feature that is not explicitly marked out-of-scope is a BLOCKER.**

---

## Phase 4: Internal Consistency Audit

Within the selected scope, check for internal contradictions.

### 4.1 Task Dependency Ordering

For each task, identify what it **creates** (files, types, exports) and what it **consumes** (imports, references). Build a dependency graph:

- If Task N imports a file created in Task M, then M must come before N
- If Task N references a type defined in Task M, then M must come before N
- If Task N modifies a file created in Task M, then M must come before N

**A task that depends on output from a later task is a BLOCKER.** The fix is to reorder or split tasks.

For plans using parallel subagents: tasks in the same parallel batch must have NO dependencies on each other. If Task 3a imports something Task 3b creates, they cannot be parallel.

### 4.2 Type Consistency Across Tasks

Scan the plan for type names, function names, and variable names used in multiple tasks. Do they match exactly? A single naming inconsistency is a bug that will surface mid-execution.

### 4.3 Architecture Alignment

Does what the tasks actually do match the Architecture section's description? If the Architecture says "stateless component" but Task 3 introduces global state, that's a contradiction.

### 4.4 Scope Creep Detection

Compare the plan's tasks against the stated Goal/Requirements. Flag any task or subtask that:

- Adds functionality not mentioned in the requirements
- Refactors existing code that isn't broken or blocking the feature
- Introduces abstractions "for future use"
- Adds configuration options nobody asked for
- Touches files unrelated to the stated goal

**Scope creep is a WARNING** (not a blocker) — but it must be called out explicitly so the user can decide whether to keep or cut it. Unacknowledged scope creep is how plans balloon from 5 tasks to 15.

### 4.5 Unresolved work

Look for unresolved decisions, missing required behavior and unusable task instructions. A literal TODO, illustrative pre-fix example, prose-only step or reference to shared implementation is not automatically a defect. Block only when the omission prevents correct execution or leaves a governing requirement undecided. Clarifications with unchanged meaning are editorial.

### 4.6 Completeness Check

For broad review, map every requirement from the spec/Goal; for delta review, update only affected mappings. Then for each requirement, identify which task(s) address it:

```
R1: [requirement text] → Task 2, Task 5
R2: [requirement text] → Task 3
R3: [requirement text] → NO TASK FOUND
```

**A requirement with no corresponding task is a BLOCKER** — it means the plan will deliver incomplete work.

---

## Phase 5: Post the Review

Post once after the selected scope is complete. A material scope change returns a handoff instead of claiming completed review.

Call `mai_review_post` once, with:

- `plan` — the plan's repo-relative path (or its uuid)
- `plan_sha` — the sha you pinned in Phase 1. If the response carries an `R-drift` warning, the
  plan changed underneath you — reject the mixed-revision result and report drift; do not reattribute the old review to new bytes. An `R-location` warning means a citation into the plan
  points past the end of the file: repair it with `mai_finding_update {finding_id, location}`
  before moving on. (Source-file citations are never warned on — only the plan's own lines are
  checkable at post time.)
- `kind` — `author` for your own pass, `blind` for an independent pass
- `verdict` — `approved` or `blocked`
- `synthesis` — the analytical prose: what the findings MEAN together, which ones are members of one
  recurrence family, where defects cluster. **Do not skip this.** Across nine review passes on plan 14
  the single most valuable output was the observation that three passes were one family; a list of
  findings without that synthesis loses the insight and keeps only the bookkeeping.
- `findings` — every finding, each with `severity`, `title`, `location`, `issue`, `evidence`, `fix`,
  and `recurrence_of` where it repeats an earlier one. `evidence` and `fix` are REQUIRED — **on
  `note`-severity findings too**, even though the old report format gave notes only
  Observation/Suggestion: an optional field on a hurried write ends up empty, and six months later
  the reasoning is unreconstructable. For a note, `evidence` is the observation and `fix` is the
  suggestion.
- `finding_count` — the exact number of findings in the ledger you intend to post. Compute it before
  constructing the tool call. The server rejects a dropped or partial array when this count differs.

Treat the returned receipt as part of the write. Its finding count must equal `finding_count`, every
intended `ref` must have one returned UUID, and `mai_plan {path, pass:"N"}` must read back that same
pass and verdict before you report completion. A mismatch or uncertain timeout is a failed/unknown
post, never a clean review; read back before retrying so a committed first attempt is not duplicated.

Then report to the user in chat: the verdict, the finding count by severity, and the synthesis.
The `ref` you give each finding (`B1`, `W2`) is a label for that conversation only — the returned
UUID is the identifier, which is why the same `B1` can appear in a dozen reviews without ambiguity.

Before posting, report checks performed, evidence reused, deferred implementation checks and unresolved gaps from your existing notes. Do not repeat the audit. Approval-critical gaps block; execution-stage checks explicitly pending do not. Clean only reviewer-owned scratch; leave cycle-owned scratch for its coordinator and report its path.

---

## Output

### Verdict Rules

**APPROVED:** No BLOCKERs. WARNINGs and NOTEs may exist — communicate them but do not block.

**BLOCKED:** One or more BLOCKERs found. State the verdict clearly. Do not suggest "proceeding with caution" — blocked means stopped.

If the plan author pushes back on a BLOCKER, do not capitulate without evidence. Either confirm it is a valid finding with evidence from the codebase, or retract it with a clear explanation of what you misread. There is no middle ground.

---

### What Comes Next

**If APPROVED:** Report the exact SHA and scope. A clean broad, or a clean delta completing existing broad coverage, permits execution under `plan-execute`; pending implementation verification is not claimed as passed.

**If BLOCKED:** Present the posted findings and synthesis in chat. Do not offer to fix the plan yourself unless the user asks — the plan author wrote it and should own the fixes, because they have context you may not. After substantive repairs, review the delta at its new pin; editorial fixes need only an equivalence check. Do not automatically restart a full review.
