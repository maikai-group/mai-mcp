---
name: mai-test-design
description: Design a behavioral verification matrix for settled requirements, an existing defect, or a bounded diff. Use when meaningful coverage needs design before planning or execution; skip trivial wording changes and implementation-mirroring tests.
---

<!-- SPDX-License-Identifier: MIT — Copyright © 2026 Maikai Group Inc.
     Part of mai-mcp (MIT — the whole project; see LICENSE). Copy freely. -->

# Test Design

Turn requirements and failure modes into the smallest useful set of behavioral checks. Ground every proposed check in the project's actual test infrastructure and explain what incorrect behavior it would detect.

## Invocation

**Announce at start:** "I'm using the mai-test-design skill to map requirements to meaningful behavioral checks."

## When to use

Use when settled requirements, a defect, or a diff needs a verification strategy. Do not use for speculative coverage of trivial wording changes, unsettled product behavior, or running a test suite whose checks are already defined.

**Inputs:** `SCOPE` (requirements, defect, or diff), `REQUIREMENTS` (expected behavior and failure cases), and `PLAN` (existing approved baseline, if any). Derive available details from project artifacts; name any consequential missing behavior instead of inventing it.

Example: "Use mai-test-design for expired invitation handling; reuse the existing invitation fixtures and include the failure response."

## Non-negotiable rules

1. Read your harness's instructions file (`CLAUDE.md`, `AGENTS.md`, or equivalent). Prime and recall when the brain is available; report unavailable recall. Current source overrides stale graph or memory evidence; surface conflicts.
2. Inspect real suites, helpers and configuration before proposing test code or commands. Do not invent helper APIs, runner options or available environments.
3. Check observable behavior and meaningful failure modes. No universal coverage percentage, mock-call-only proof, or assertions that merely mirror the implementation.
4. Design the matrix without changing implementation or a frozen plan. Route substantive plan deltas through its existing review and approval workflow before execution; preserve lane, review and operator-task contracts.
5. Analysis authorizes no dependency installation, global profile change, production mutation, deployment, third-party message or automatic activation. Search before durable brain writes and preserve source provenance; say when persistence is unavailable.

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
| `mai_prime` / `mai_search` | Optional project context and decision/lesson recall | Prior brain context is unavailable | Read project instructions and local decisions; report recall did not run |
| `mai_remember` / `mai_lesson_add` | Optional durable decision or lesson capture | New durable observations cannot be persisted | Include the observation and source references in the handoff; state it is unpersisted |
| Project test suites, helpers and runner configuration | Existing fixture and command contracts | Runnable test design may be incomplete | Inspect available source and documented commands; mark missing infrastructure or environment explicitly |

## Step 1 — Establish the behavior and baseline

Read the input requirements and relevant current source. Recall prior test decisions and compare the existing plan, if present. Separate required outcomes, inferred risks and unresolved requirements. A missing behavioral decision becomes an open question, not an invented expected result.

## Step 2 — Inspect the real test infrastructure

Read nearby suites, helper definitions, fixture setup/teardown, runner configuration and package/build commands. Record source anchors for reusable fixtures and execution commands. Identify isolation boundaries, required services, credentials and unavailable environments. If no suitable helper exists, describe the fixture needed and mark it as proposed rather than pretending it already exists.

## Step 3 — Build the verification matrix

For each required behavior or meaningful failure mode, supply:

| Field | Content |
|---|---|
| `Requirement` | Requirement identifier and source anchor |
| `Behavior` | User- or consumer-observable result, including relevant failure response |
| `Layer` | Unit, integration, end-to-end or other project-supported check, with reason |
| `Fixture` | Real helper/data source and setup; explicitly proposed additions if needed |
| `Discriminator` | Plausible incorrect behavior that makes this check fail |
| `Command` | Verified project command and selection, or the concrete missing runner contract |
| `Isolation` | Disposable state, cleanup and service/environment prerequisites |
| `Status` | Existing coverage, proposed check, unavailable environment or unresolved requirement |

Prefer the smallest set that distinguishes correct behavior from the identified failures. Use mocks only where appropriate to the test boundary; assert the resulting behavior. Reuse a lower-cost check when it proves the same requirement, and retain broader checks only for behavior that depends on integration. Do not treat a proposed command as execution evidence.

## Step 4 — Reconcile and hand off

Compare the matrix with existing tests and the approved plan. Explain uncovered requirements, redundant proposals and any substantive plan delta. Pass the matrix to planning or authorized execution with prerequisites and unresolved decisions attached; a frozen plan stays unchanged until its established review path accepts the delta.

## Output

Return `Scope`, `Source anchors`, `Verification matrix`, `Coverage gaps`, `Unavailable environments`, `Plan delta` and `Handoff`. State what is ready for planning/execution and what remains unresolved. Include recall or persistence limits; this design report is not a test PASS claim.
