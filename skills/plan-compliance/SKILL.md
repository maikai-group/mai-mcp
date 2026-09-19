---
name: plan-compliance
description: Audit recent code changes against an approved implementation plan. Use after a task in a plan-execute workflow completes, or on demand when verifying that a chunk of work has not drifted from spec. Reports PASS or DEVIATIONS with a specific list of missing items, items added beyond plan, type-safety bypasses, scope creep, and verification status. Invoked by plan-execute after each task, or on demand. Distinct from code-review (quality) — this skill checks fidelity-to-plan only.
---

<!-- SPDX-License-Identifier: MIT — Copyright © 2026 Maikai Group Inc.
     Part of mai-mcp (MIT — the whole project; see LICENSE). Copy freely. -->

# Plan Compliance Audit

You are auditing whether code changes faithfully implement a section of an approved implementation plan. You are NOT reviewing code quality — that is the `code-review` skill's job. You are checking **fidelity to plan**: did what got written match what the plan said to write?

## Invocation

"Using plan-compliance skill to audit Task X against the plan."

## When to use

Use after a task in a plan-execute workflow completes, or on demand when verifying that a chunk of work has not drifted from spec.

### Inputs

Skill arguments (or environment variables, or injected context):
- `PLAN_PATH` — absolute path to the plan markdown file
- `TASK_ID` — task identifier as it appears in the plan (e.g. "Task 2", "Phase 2 Task 2", "Wave 3 Step 4")
- `DIFF_REF` — git ref to diff against (defaults to last audit checkpoint, falling back to working tree if none)

If any required input is missing, ask the user before proceeding. Do not guess.

### When NOT to use

- Architectural review — use `code-review` instead.
- Quality / style review — use `code-review`.
- Validating the plan itself before execution — use `plan-review`.
- Pre-execution prep — use `plan-execute`.

## Non-negotiable rules

1. **Read-only.** Do NOT modify any files during the audit. Reporting only.
2. **No inline fixes.** List issues; the orchestrator/user decides what to do.
3. **Tolerate cosmetic diffs.** Whitespace, comment wording, identical-shape reformatting → ignore. Substantive logic/structure/contract differences → flag.
4. **Plan ambiguity.** If the plan itself is ambiguous, name the ambiguity in the issues list. Do not invent a "correct" interpretation.
5. **No editorializing.** Don't suggest improvements, don't praise, don't explain why the plan made certain choices. Just compare and report.
6. **Verdict logic.**
   - VERDICT: PASS — zero ✗ Missing AND zero ⚠ Diverged AND zero scope-creep/type-bypass issues AND verification-PASS evidence (or task has no V-criterion).
   - VERDICT: DEVIATIONS — anything else.

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
| `plan-review` | Ships in this suite. Produces the approved requirements this audit compares against | The implementation has no approved plan baseline | None — stop; fidelity cannot be audited without an approved plan |
| `plan-execute` | Ships in this suite. Calls this audit between execution tasks | Automatic between-task invocation is unavailable | Run this audit directly after each task and before continuing |
| `code-review` | Optional external. A quality/architecture review, distinct from this fidelity audit | Its packaged quality review is unavailable | Use a harness-native reviewer or direct diff review; this skill still performs fidelity-to-plan only |

## Step 1 — Locate the plan section

Read the plan file at `PLAN_PATH`. Find the section for `TASK_ID`. Extract:

- **File-list** — every "Create" / "Modify" / "Delete" entry in the task's File Map or step body
- **Step bodies** — each step's specified content (exact code/config for Create steps, modification details for Modify steps)
- **Verification commands** — what the plan says proves the task is done (curl, npm test, build commands, etc.)
- **V-criterion mapping** — does the task ship a validation criterion (V1, V2…)? What does PASS look like?

If the task ID can't be located unambiguously, ask the user to clarify.

## Step 2 — Identify actual changes

Compute the change set:

```bash
# If checkpoint exists:
git diff --name-status $DIFF_REF
git diff $DIFF_REF

# If no checkpoint, working tree:
git status --porcelain
git diff
git diff --cached
```

Build a list of files actually created, modified, deleted, plus their content / diff hunks.

## Step 3 — Three-way compare

For each file the plan says to create/modify:

| Status | Meaning |
|---|---|
| ✓ Match | File exists; content aligns with plan (whitespace/comment-wording diffs are OK) |
| ✗ Missing | Plan said create, file does not exist |
| ⚠ Diverged | File exists but content substantively differs (different function names, different fields, different logic) |

For each file the agent actually changed but the plan does NOT mention:

- ⚠ **Beyond plan** — file changed unprompted
- ⚠ **Type-safety bypass** — `any` / `object` (lazy) / `# type: ignore` / `// @ts-ignore` / unsafe casts / silent type widening
- ⚠ **Scope creep** — extra helper functions, premature abstractions, error-handling layers, validation, fallbacks not specified by the plan
- ⚠ **Mock/stub leftovers** — `TODO`, `FIXME`, `XXX`, `placeholder`, `// stub`, hardcoded test values (unless plan said so)
- ⚠ **NEEDS DECISION** — `// TODO: NEEDS DECISION` markers that the plan did not invite

Tolerate trivial cosmetic differences. Flag only substantive divergence.

## Step 4 — Verification check

- Did the plan specify verification commands for this task? List them.
- Inspect executor-provided output/CI evidence and its relevant input/environment identity. Do not search unrelated shell history or ask the user to reconstruct available evidence.
- Is there evidence of PASS? (Curl output, test pass, build success.)
- If the task has a V-criterion (V1, V2…), is there valid evidence it passed? If not, identify the affected missing check for the executor.
- Do not execute tests or launch quality review from this fidelity audit. Matching existing results satisfy verification; reused does not mean unverified.

## Output

Format the report exactly as below. Be terse. The audit's value is being skimmable.

```
PLAN COMPLIANCE AUDIT — Task {TASK_ID}
Plan: {PLAN_PATH}
Diff ref: {DIFF_REF}
Audited at: {ISO-8601 timestamp}

VERDICT: PASS | DEVIATIONS

Files in plan: {N total}
  ✓ Matched:           {N}
  ✗ Missing:           {N}
  ⚠ Diverged:          {N}

Files changed beyond plan: {N}

Issues:
  [if none]: none
  [if any]: one bullet per issue, with file:line where applicable
    - {file:line} — {category} — {brief description}

Verification:
  V-criterion: {V1, V2, ... or "none"}
  Commands run: {list, or "no evidence"}
  Result: {PASS / FAIL / unknown}

Next: {one sentence — what to fix next, or "proceed to next task"}
```
