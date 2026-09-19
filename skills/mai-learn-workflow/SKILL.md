---
name: mai-learn-workflow
description: Turn reviewed lessons and source evidence into a bounded lesson amendment or project-specific draft workflow. Checks provenance, current relevance and existing skills before drafting; validation and review precede any authorized activation. Does not promote unreviewed inference into global rules.
---

<!-- SPDX-License-Identifier: MIT — Copyright © 2026 Maikai Group Inc.
     Part of mai-mcp (MIT — the whole project; see LICENSE). Copy freely. -->

# Learn a Workflow

Decide whether reviewed evidence warrants a reusable project procedure, a narrower lesson amendment, or no change. Deliver a concrete draft with provenance and validation before considering activation.

## Invocation

**Announce at start:** "I'm using the mai-learn-workflow skill to check the reviewed evidence and draft only the reusable procedure it supports."

## When to use

Use with reviewed lessons and their source evidence, such as "Turn the reviewed migration-cleanup lesson into a project workflow draft."

**Inputs:** `lesson_ids_or_records`, `review_status_and_provenance`, `source_evidence`, `project_scope`, and any `existing_activation_authorization`.

Do not use repetition alone as authority, convert unreviewed inference into a global rule, or automatically promote brain entries. If review status or source evidence cannot be verified, report the missing proof and stop dependent drafting or activation; a candidate lesson is not an approved procedure.

## Non-negotiable rules

1. Read your harness's instructions file (`CLAUDE.md`, `AGENTS.md`, or equivalent). Prime and recall when the brain is available; report unavailable recall. Current source outranks stale graph or memory, and conflicts must be surfaced.
2. Verify lesson status, provenance and current relevance before reuse. Frequency suggests something to investigate; it does not establish correctness or authority.
3. Search existing lessons and authorized project skills before adding a procedure. Prefer the smallest supported change; no new memory store or duplicate workflow.
4. Default to a project-specific draft with a narrow trigger. An explicitly requested broader target takes precedence over that default; verify that the reviewed evidence supports its scope before drafting, and do not silently substitute a local target. Remove secrets, personal data and incidental session details while retaining safe source references and the causal evidence.
5. Validate and review before activation. Honor existing explicit authorization; when it is absent, finish the concrete draft first and request approval only for the remaining activation action.
6. Preserve existing plan review, finding, claim and operator-task contracts. Drafting does not authorize dependency installation, global profile changes, production mutation or automatic brain promotion.
7. Search before durable writes and cite reviewed source evidence. Apply a lesson amendment only within existing authorization; report failed or unavailable persistence without claiming success.

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
| `mai_prime` / `mai_search` | Optional project state, lesson and decision recall | Brain search cannot establish precedent | Search supplied reviewed records and authorized project files; report the recall gap |
| Brain lesson records and writes | Reviewed status, provenance and authorized amendment persistence | Status or persistence may be unavailable | Use supplied review evidence when verifiable; otherwise stop dependent work; preserve an unpersisted amendment as a proposal |
| Project skill validator | Existing structural and packaging checks | Automated draft validation is unavailable | Inspect metadata, triggers, dependencies and reference closure manually; report automation unperformed |
| Project review mechanism | Review of the draft's evidence and behavior before activation | Required review is incomplete | Obtain a harness-native review against source and realistic requests; if unavailable, leave the draft inactive and report the gap |

## Step 1: Verify the evidence

Read project instructions, prime and recall when available. For each lesson, capture `id_or_path`, `review_status`, `review_reference`, `source_anchor`, `applicable_conditions`, and `current_relevance`. Confirm the stated failure and repair against available current source or reproducible evidence.

Separate reviewed conclusions from later inference. If status is unreviewed, evidence is absent, or current behavior contradicts the lesson, report that discrepancy and the review or evidence needed. Do not infer approval from the number of repeats.

## Step 2: Choose the smallest useful outcome

Search existing lessons and project skills for the same trigger and prevention. Compare their actual procedures with the reviewed evidence.

Choose and explain one outcome:

1. `no_change`: existing guidance is sufficient or the evidence does not support a reusable change.
2. `lesson_amendment`: a correction or condition belongs in an existing lesson; draft the exact amendment with provenance and apply it only if authorized.
3. `draft_skill`: the evidence supports a repeatable project procedure with a distinct trigger and useful verification.

Do not grow a one-off workaround into universal policy or create a second entrypoint for an existing procedure without a supported need.

## Step 3: Draft the supported procedure

For `draft_skill`, write to an authorized project draft location outside automatic skill discovery. Include `purpose`, `narrow_trigger`, `exclusions`, `prerequisites`, `inputs`, ordered actions, `failure_and_stop_behavior`, `verification`, `output`, and safe `source_references`.

Make the procedure portable through actions and explicit capability fallbacks. Follow the project's skill format and dependency contracts. Generalize incidental names or session details without erasing the conditions that made the lesson valid. Keep any unresolved inference out of normative instructions.

## Step 4: Validate, review and handle activation

Use the existing validator when available, inspect dependencies and references, and exercise a representative request plus an excluded or failing case without external effects. Review whether the draft preserves the lesson's causal evidence, stays within project scope and has meaningful verification. Record reviewer, evidence and unresolved findings; resolve substantive findings before activation.

If validation or review remains incomplete, return the inactive draft and exact gap. After those checks pass, follow existing explicit installation/activation authorization for the specified target. Otherwise present the reviewed draft and request approval only for the named remaining activation action. Do not ask again for permission already given, expand the authorized target, or automatically promote a brain entry.

## Output

Return:

- `decision`: no change, lesson amendment or draft skill, with rationale.
- `provenance`: reviewed lesson references, source anchors, conditions and current relevance.
- `artifact`: concrete draft path or exact amendment; persisted status when applicable.
- `validation_and_review`: checks, representative outcomes, reviewer evidence and gaps.
- `activation`: inactive, blocked on named checks, awaiting specified authorization, or activated at the explicitly authorized target with evidence.

Report unavailable brain capabilities and any unpersisted proposal. A draft alone is not an activated workflow.
