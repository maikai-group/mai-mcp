---
name: mai-verify
description: Verify a bounded change, requirement set, plan section or release-readiness claim against matching evidence. Reuse valid results and run authorized missing checks; distinguish PASS, FAIL and NOT RUN without automatic fixes or shipping.
---

<!-- SPDX-License-Identifier: MIT — Copyright © 2026 Maikai Group Inc.
     Part of mai-mcp (MIT — the whole project; see LICENSE). Copy freely. -->

# Verify

Reconcile a bounded completion claim with the checks its requirements actually demand. Reuse evidence whose inputs still match and close authorized gaps, keeping failed and unrun required checks visible.

## Invocation

**Announce at start:** "I'm using the mai-verify skill to reconcile the required checks with their evidence."

## When to use

Use to assess a bounded change, requirements, plan section or release-readiness claim. Do not use as permission to fix code, rewrite a plan, ship a release or repeat checks indefinitely after unchanged inputs have already passed.

**Inputs:** `SCOPE` (change, requirements or plan section), `CLAIM` (what is being asserted complete), `EVIDENCE` (existing results and locations), and `ENVIRONMENT` (available targets and authorization). Derive required checks from actual project contracts rather than a generic checklist.

Example: "Use mai-verify on the invitation change; reuse today's matching test results and identify any required checks that did not run."

## Non-negotiable rules

1. Read your harness's instructions file (`CLAUDE.md`, `AGENTS.md`, or equivalent). Prime and recall when the brain is available; report unavailable recall. Current source wins over stale graph or memory; surface conflicting evidence.
2. Build the matrix from actual requirements and project commands. Preserve approved-plan, independent-review, finding UUID, lane and operator-task contracts; this report does not replace their required receipts.
3. Reuse a result only when relevant source, configuration, fixtures, environment and tool versions match. Unknown provenance or a stale input leaves a gap; a prior green label alone is insufficient.
4. Run only authorized missing checks, preferring disposable fixtures for checks that write state. Verification implies no dependency installation, global profile change, production mutation, deployment, third-party message or automatic activation.
5. Distinguish `PASS`, `FAIL` and `NOT RUN`. Overall PASS requires all required checks to pass; missing capability or authorization cannot turn required work into optional work.
6. Do not make automatic fixes or ship. Stop rechecking unchanged inputs once valid evidence satisfies the requirement; rerun only for changed inputs, a failure or an unresolved concern. Search before durable writes, preserve provenance and disclose unavailable persistence.

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
| `mai_prime` / `mai_search` | Optional project context and prior decision/evidence recall | Brain context cannot be checked | Read project instructions and local evidence; report recall did not run |
| `mai_remember` / `mai_lesson_add` | Optional durable decision or lesson capture | New observations cannot be persisted | Include source-backed observations in the report and mark them unpersisted |
| Project commands and evidence artifacts | Actual validation contracts and prior execution records | Some required checks lack executable or reusable evidence | Inspect source/configuration for the contract; mark unresolved required checks NOT RUN with the missing prerequisite |
| Authorized check environment | Permitted target, services and fixture lifecycle | Dependent checks cannot run | Continue safe independent checks; report the unavailable capability or authorization |

## Step 1 — Define the verification matrix

Read the bounded requirements, plan section or release criteria, affected source and project command definitions. Identify required checks, optional supporting checks and any mandated independent review or receipts. Explain what each check proves; compilation alone does not establish every behavioral requirement.

For each row record `Requirement/source anchor`, `Required?`, `Check and command`, `Relevant inputs`, `Environment/fixtures`, `Evidence location` and `Status`. Keep unresolved requirements explicit rather than inventing acceptance criteria.

## Step 2 — Validate existing evidence

Inspect the actual result and its execution identity: relevant source revision or content, configuration, fixture/data state, environment and tool versions. Compare those inputs with the current scope. Relevant unchanged inputs allow reuse even if unrelated files changed; record why the evidence still applies.

Accept a passing result only if the command or observation proves the required outcome. Record its exit status, passed/failed/skipped counts where available, and evidence location. Do not convert skipped assertions into passed checks. Mark absent, stale or unverifiable evidence as needing execution; explain the mismatch instead of discarding all prior results.

## Step 3 — Run authorized missing checks

Use the project's existing commands and supported environment. For writeful checks, use safe disposable state and the defined cleanup; verify authorization for effects outside it. Run independent permitted checks while reporting missing prerequisites for dependent ones.

Record command, relevant input identity, environment/tool versions, fixture lifecycle, exit status, counts and output location. A check that runs and fails is `FAIL`; a check that could not execute is `NOT RUN`. Preserve failure evidence and hand off the cause or next diagnostic check without fixing implementation automatically.

## Step 4 — Reconcile the claim

Review every required row once the relevant results are available. Assign `PASS` only to checks with matching successful evidence, `FAIL` to demonstrated failures and `NOT RUN` to unexecuted or unevidenced checks. Report reused and newly run evidence explicitly.

Overall status is `FAIL` if a required check failed, otherwise `NOT RUN` if any required check lacks passing evidence, otherwise `PASS`. Optional failures and gaps remain visible with their impact. A successful bounded verification does not authorize shipping or imply completion of requirements outside the scope.

## Output

Return `Scope and claim`, `Verification matrix`, `Reused evidence`, `New evidence`, `Overall status`, `Failures`, `Required NOT RUN checks`, `Evidence locations` and `Limits/next actions`. Include exit statuses and counts where applicable, provenance gaps and unavailable capabilities. Preserve the distinction between a complete bounded PASS and incomplete release readiness.
