---
name: receiving-plan-review
description: Verify plan findings and make bounded repairs with revision provenance. Editorial fixes need no review pass; substantive repairs return for independent delta review. Does not execute the plan or start a review loop itself.
---

<!-- SPDX-License-Identifier: MIT — Copyright © 2026 Maikai Group Inc.
     Part of mai-mcp (MIT — the whole project; see LICENSE). Copy freely. -->

# Receiving Plan Review

Repair confirmed defects and their affected dependencies without reopening unchanged work. Preserve governing requirements and make the revised SHA and evidence explicit.

## Invocation

**Announce at start:** "I'm using receiving-plan-review to verify the findings and make bounded repairs."

## When to use

Use to address posted plan findings. Do not use for first review or implementation. Do not automatically launch a review cycle after repairing a finding.

## Non-negotiable rules

1. Edit the plan only unless the user authorized source/spec changes. Do not execute the complete plan, apply live migrations, publish or make billed calls.
2. Never edit while a review of those bytes is active. Pin baseline and revised SHA; preserve original review records.
3. Use durable finding UUIDs. Verify the premise and affected end state before marking a finding fixed or disputed.
4. The author of a substantive repair cannot independently approve it. Return substantive changes for independent delta review; an existing independent reviewer may continue.
5. Reserve blockers for demonstrated failures of requirements, safety or executability. Warnings/notes are nonblocking. Editorial corrections require a diff/consistency check, not an independent pass.
6. Preserve distinct behavioral coverage. Removing redundant checks and correcting obsolete workflow rules is allowed; do not weaken a useful discriminator merely to get green output.
7. New product, security, privacy, billing or release-policy choices need authority. A local repair implementing an existing decision does not require renewed permission.
8. On recurrence, correct the relevant defect family. Do not generate a universal failure matrix or another receipt layer. The cycle coordinator owns the retry budget and dispatch.

<!-- mai:shared:epistemics start — synced from skill-blocks/epistemics.md.
     Do NOT hand-edit inside this block; the sync rewrites it wholesale and the
     edit disappears silently (lesson 420dbda2). -->
### Receiving a finding

**Verify the premise before acting on it.** Current source and governing requirements decide whether the finding is real. A persuasive review is evidence to evaluate, not authority to change the design.

Authority order: explicit current user decision; approved governing spec/recorded decision; actual code/schema/tool interfaces; plan prose; reviewer suggestion. Surface consequential conflicts.

### Repair the defect family

Search for the relevant defect shape and inspect matching sites, including its producer or generator. A targeted mechanical search across an artifact is not a mandate to reread the whole artifact. Record the search and affected sites in the existing finding note; merge duplicate repair work while preserving finding UUIDs.

Check the changed end state and affected contracts. Re-read all citations belonging to the finding. Check heading ownership, counts or ordering only if the repair affects them. Cosmetic wording corrections need a diff and consistency check; substantive changes need evidence proportional to their effects.

### Evidence and limits

Use existing trustworthy verification when command, relevant inputs, configuration/toolchain and environment match. Missing metadata invalidates only the affected check. Record what ran, what was reused, and what remains unknown in the existing closure note; no separate repair-shadow receipt is required.

For executable behavior, run the relevant regression when valid evidence is absent. Demonstrate red/green or mutation behavior when needed to establish that a discriminator catches the defect; do not require a new mutation exercise for every repair. Plan prose is normally checked by source/contract inspection, with focused scratch probes for consequential uncertainty. Full implementation verification belongs to execution.

When no executable gate covers a claim, state "Verified by source inspection" with the inspected boundary; never imply a test ran. A genuine approval-critical uncertainty remains open. Before a repair that requires a new product/policy decision, raise that decision; routine corrections within current authority proceed.
<!-- mai:shared:epistemics end -->

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
| `plan-review` | Independent substantive-delta review | No packaged reviewer | Hand the repaired pin to an independent reviewer with the affected scope |
| `plan-review-cycle` | Routing, retry budget and evidence reuse | No cycle coordinator | Return the repair and evidence without starting an automatic loop |

## Phase 1: Pin and inspect

Prime/read project instructions. Fetch the current plan record, relevant open findings and their cited prior lineage; fetch older passes only when needed. Compare the file hash with the registered and reviewed pins. Inspect intentional intervening changes rather than assuming old line numbers still apply. Check active review ownership and path claims before editing.

Read affected plan sections, governing requirements and source/contracts needed to verify each premise. Expand inspection as evidence requires. Do not routinely read every Modify file, prior synthesis or the full plan/spec.

## Phase 2: Classify and repair

For each UUID, confirm or dispute the premise with evidence. Explain concrete consequences before treating it as blocking. For misclassified wording/style findings, dispute the blocking classification with an evidence note on the same UUID; do not invent an unsupported severity-update API. Preserve any nonblocking observation in the note. Editorial corrections do not consume another blocked pass.

Group real defects by shape and search related sites. Apply the smallest complete repair. Use [the fan-out reference](references/drift-fanout.md) only for changed concepts. Update affected signatures, commands, counts, task references and requirements mappings; do not regenerate unrelated inventories.

A substantive repair changes behavior, executable examples, commands, requirements, contracts or acceptance criteria. Pure editorial changes leave all of those unchanged. When uncertain, use a bounded independent delta rather than calling the edit cosmetic.

## Phase 3: Verify the affected end state

Inspect the actual diff and all affected cited sites. Run whitespace/fence/reference checks where relevant. The optional inventory script helps with complex task moves or large edits; it is not mandatory around a wording correction.

Source/contract inspection normally verifies plan repairs. For consequential behavior or command uncertainty, execute the smallest discriminating scratch probe using actual amended code. Reuse matching isolated environments and valid relevant test results under the cycle evidence rules.

Do not construct the full proposed production overlay simply because the plan contains code blocks. Do not rebuild full app/backend environments or rerun unchanged baselines. Full builds and implementation suites stay pending for execution unless explicitly requested. Record genuine gaps; approval-critical unresolved claims stay open.

## Phase 4: Register and reconcile

Hash and register the revised plan at `reviewing`, confirming the returned SHA. Update each UUID with disposition, affected sites and source/test evidence; preserve original review pins and duplicate finding identities. Accepting actual risk requires explicit user authority.

For editorial-only changes to an approved baseline (or a completed independent review whose only blockers were evidenced editorial misclassifications), record exact old/new SHA, diff and equivalence check in the existing handoff. The original independent review still names its original bytes; never claim a new independent pass occurred. The coordinator may carry approval forward only when all intervening changes are editorial and no blocker remains.

For substantive changes, return the new SHA, actual diff, affected contracts and relevant evidence for independent delta review. If requirements, architecture or a material integration boundary changed, identify that evidence for broad routing. Do not reclassify local wording/task-order fixes as architecture to reset a cycle budget.

During execution, keep the approved plan frozen and record an authorized amendment separately rather than silently rewriting the reviewed baseline.

## Output

Report revised SHA, unique repairs, UUID dispositions, editorial/substantive scope, evidence reused/run and remaining gaps. Post one compact board handoff and resolve its predecessor. State whether independent delta review is pending; do not dispatch, self-approve substantive repairs or start another loop from this skill.
