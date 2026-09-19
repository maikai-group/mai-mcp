---
name: mai-e2e
description: Exercise named user journeys in an authorized test environment with the project's existing runner and fixtures. Use for end-to-end behavior evidence; do not infer production authorization or a browser-framework installation from the request.
---

<!-- SPDX-License-Identifier: MIT — Copyright © 2026 Maikai Group Inc.
     Part of mai-mcp (MIT — the whole project; see LICENSE). Copy freely. -->

# End-to-End Testing

Exercise the requested user journeys and report evidence of their observable outcomes. Bind each result to the environment, revision and fixtures used, including required journeys that could not run.

## Invocation

**Announce at start:** "I'm using the mai-e2e skill to exercise the requested journeys and record their outcomes."

## When to use

Use for named success and failure journeys in an authorized test environment. Do not use to select a new browser framework, deploy a system, perform automatic production actions or replace focused checks that already satisfy the request.

**Inputs:** `JOURNEYS` (required and optional journeys with expected outcomes), `TARGET` (environment and revision), `AUTHORIZATION` (existing permission and limits), and `FIXTURES` (project test data and cleanup contract). Recover available inputs from the task and project before asking for missing details.

Example: "Use mai-e2e to check sign-in and expired-link recovery in the disposable preview, using its seeded accounts."

## Non-negotiable rules

1. Read your harness's instructions file (`CLAUDE.md`, `AGENTS.md`, or equivalent). Prime and recall when the brain is available; disclose unavailable recall. Verify graph/memory against current source and surface conflicts.
2. Reuse the project's runner and test data. No browser-framework mandate, dependency installation, global profile change, deployment, third-party message or automatic activation is implied.
3. Bind operations to the authorized target and effects. Honor existing authorization; stop dependent destructive or external actions when authorization is missing, while continuing safe independent checks. Production actions require explicit authorization.
4. Assert user-observable success and failure outcomes. Never disable tests, weaken assertions or suppress failed attempts to claim green. Required unrun journeys prevent a complete PASS.
5. Protect secrets and personal data in logs, screenshots and traces. Collect only useful artifacts, sanitize them before sharing and preserve controlled evidence locations.
6. Search before durable brain writes; preserve provenance and report unavailable persistence. Preserve existing approved-plan, review, finding and lane contracts.

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
| `mai_prime` / `mai_search` | Optional project context and prior journey/failure recall | Brain history cannot inform the run | Read project instructions and local evidence; report recall did not run |
| `mai_remember` / `mai_lesson_add` | Optional durable decision or lesson capture | New observations cannot be persisted | Return source-backed observations in the report and mark them unpersisted |
| Project E2E runner and test data | Existing journey execution and fixture contracts | Automated journeys may be unavailable | Use authorized existing manual or harness interaction only if it proves the same outcome; otherwise mark the journey NOT RUN |
| Authorized test environment | Target system and permitted effects | Dependent execution cannot proceed | Continue safe independent inspection and report the missing environment or authorization |

## Step 1 — Establish the target and baseline

Read journey definitions, relevant current source, runner configuration, test data and cleanup procedures. Record target identity, revision, runner/tool versions and the baseline state. Identify which journeys are required and their success/failure assertions; do not silently reclassify unavailable required work as optional.

Confirm available authorization covers the actual target and each effect. Isolate test state using the project's fixtures and identify how to restore it. If a prerequisite is missing, record the affected journeys and continue only independent authorized work.

## Step 2 — Execute observable journeys

Run the existing project command or authorized interaction sequence with its fixture setup. Exercise relevant success and failure paths and assert visible or consumer-observable outcomes, including persisted effects where part of the journey. Record exact commands or steps, time, environment, revision, exit status, assertion counts and outcomes.

Capture screenshots or traces when they clarify a failure or outcome. Avoid sensitive values in artifact names and redact exposed secrets or personal data before returning artifacts. An available runner alone is not evidence that a journey passed.

## Step 3 — Investigate failures within scope

For a suspected flake, retain the original failure and state the uncertainty a diagnostic run would resolve. Compare timing, fixtures, environment and traces; rerun only a bounded, targeted check supported by a hypothesis. Stop when further runs add no evidence or need changes outside authorization. Report unresolved flakiness rather than retrying until green or altering assertions.

Perform the planned fixture cleanup and compare with the baseline. Record cleanup failures and remaining test state; do not hide them in a successful journey result. Hand failures back with reproduction evidence without silently expanding into implementation repairs.

## Step 4 — Reconcile required coverage

Assign each journey `PASS`, `FAIL` or `NOT RUN`, with evidence or a concrete missing prerequisite. Preserve failed attempts even if a diagnostic rerun passes; explain whether the failure is resolved or still flaky. Overall `PASS` requires every required journey and required setup/cleanup check to pass. Report `FAIL` for a required failure; otherwise report `NOT RUN` when required work remains unrun.

## Output

Return `Scope`, `Target and authorization`, `Baseline and fixtures`, `Command/environment/revision`, `Journey results`, `Artifact locations`, `Failures and flakes`, `Cleanup`, `Gaps` and `Overall status`. Include counts, exit statuses and capability limits. State the next concrete check for each unresolved required journey; do not claim complete PASS with a gap.
