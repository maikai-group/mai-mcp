---
name: mai-specialist-review
description: Review a bounded code change through relevant security, database, reliability, retrieval or test-adequacy roles. Use for requested specialist review or concrete risks found during code review; preserves independent review and the existing finding lifecycle.
---

<!-- SPDX-License-Identifier: MIT — Copyright © 2026 Maikai Group Inc.
     Part of mai-mcp (MIT — the whole project; see LICENSE). Copy freely. -->

# Specialist Review

Select the expertise a change needs and return evidence-backed findings through the existing review lifecycle. The bundled roles are portable prompts: they can run inside an independent review or in a bounded reviewer delegation.

## Invocation

**Announce at start:** "I'm using the mai-specialist-review skill to review the relevant risks in this change."

Inputs: exact revision range or working diff, scoped paths, project identity, and requested roles or the concrete risk to assess. Example: "Review the tenant export diff for security and database risks."

## When to use

Use for requested domain review or a specific risk that warrants deeper investigation during a code review. Select only roles relevant to actual source and requirements.

Do NOT use for a plan, routine formatting, unbounded hardening, or repairing findings. Do not run all roles merely because they are available.

## Non-negotiable rules

1. Preserve the checkout, index, HEAD and branch refs. Review does not authorize fixes, live migrations, exploit deployment or production requests.
2. An author cannot provide independent approval of their own diff. Use an independent reviewer; if none is available, report that gap and label any self-check accordingly.
3. Source and demonstrated impact decide findings. Graph/memory are discovery aids; missing or stale entries are not proof of absence. A checklist preference alone is not a BLOCKER.
4. Use the existing review owner for persistence and receipt. Return candidate findings to that owner; never file the same candidate in both a role and the outer review.
5. Keep the two entry modes separate. Standalone entry invokes the review workflow once; an active review consumes roles directly and never recursively starts another review.

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
| `mai-code-review` | Shipped independent review, severity and durable finding workflow | Its recall/persistence procedure is unavailable | Use an independent read-only source reviewer; emit complete findings as unpersisted and name missing capabilities |
| mai-mcp brain | Project priming, decisions, graph and prior findings | Historical context or graph scope is missing | Inspect current source mechanically and report missing recall; never claim a brain write succeeded |
| Independent reviewer capability | A separate reviewer without author context | Independent approval is unavailable to the author | Report a self-check and independence gap; do not label it independent approval |

## Step 1: Establish the review owner

Read project instructions (`AGENTS.md`, `CLAUDE.md`, or equivalent). Prime and recall relevant decisions/findings when the brain is available. State the range and path union, including scoped untracked files for a working diff. Verify graph-derived scope in source; fall back to mechanical search where coverage is thin.

- **Standalone invocation:** hand the bounded scope and selected roles to `mai-code-review` once. If this session authored the diff, its independent reviewer receives source pins, paths and role names, not author conversation history. The active reviewer executes Steps 2–3 below inside its normal review.
- **Already inside that review:** keep the existing owner and proceed directly to Step 2. Do not invoke the standalone entry again.
- **Workflow unavailable:** preserve the same evidence and independence boundaries, review read-only with the harness, and state which findings could not be persisted.

## Step 2: Choose and read applicable roles

Check the actual stack and changed boundaries before selecting references. Read only the selected role files.

| Role | Use when | Reference |
|---|---|---|
| Security | Input or trust boundaries, credentials, authorization or sensitive output change | [Security](references/security.md) |
| Database | Schema, migrations, queries, transactions or persistence semantics change | [Database](references/database.md) |
| Reliability | Errors, cancellation, retries, cleanup or fallback behavior change | [Reliability](references/reliability.md) |
| Retrieval | Indexing, retrieval filters, ranking, freshness, citations or evaluation change | [Retrieval](references/retrieval.md) |
| Tests | Behavioral evidence, fixtures, discriminators or flakiness needs scrutiny | [Test adequacy](references/tests.md) |

A role may run inline within the independent review. When delegation is available and useful, give a reviewer only its bounded role, current pins, shared contracts and source evidence. Preserve independence and read-only ownership. If delegation is unavailable, the independent review owner performs selected roles sequentially.

## Step 3: Investigate and reconcile candidates

Trace each suspected defect to its caller, data contract or failure path. Inspect contrary evidence and intentional behavior before concluding. Reuse matching verification; isolate only necessary probes and keep their writes outside the review target.

For each candidate record: role, location, violated requirement/contract, trigger, observed evidence, consequence, smallest complete repair, and verification gap. Use BLOCKER for demonstrated correctness/safety/requirement failure; WARNING for nonblocking risk; NOTE for optional observation.

Merge candidates that describe the same defect, retaining all relevant evidence and any existing finding UUID. Distinguish a valid documented fallback from concealed failure and an evaluation gap from proven poor retrieval.

## Step 4: Return through the existing lifecycle

Inside `mai-code-review`, send reconciled candidates to its Phase 4 exactly once; that owner files findings and returns UUIDs. Role workers do not independently file or close them. Repairs remain the existing receiving workflow's responsibility.

If persistence is unavailable, return the complete candidate record with `unpersisted` status, not invented UUIDs. A clean role report states what was inspected and what could not be checked; it is not a whole-product security certification.

## Output

Return scope/pins, selected roles and why, counts by BLOCKER/WARNING/NOTE, findings with evidence and UUIDs or unpersisted status, independence posture, verification gaps, and whether any demonstrated blocker prevents approval.
