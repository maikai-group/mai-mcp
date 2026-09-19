---
name: mai-subagent-execute
description: Dispatch independent plan tasks to parallel subagents with lane claiming, injected rules and verified results. Invoked by plan-execute when a batch of tasks has no shared dependencies; not invoked directly by a user. Handles decomposition checks, dispatch, per-agent verification and lane release.
---

<!-- SPDX-License-Identifier: MIT — Copyright © 2026 Maikai Group Inc.
     Part of mai-mcp (MIT — the whole project; see LICENSE). Copy freely. -->

# Subagent Execute

Dispatch only. `plan-execute` remains the executor and keeps the audits, the gates and the verification; this skill owns getting work to parallel agents and getting verified results back.

---

## Invocation

**Internal — does not announce.** This skill is invoked by `plan-execute`, never directly by a user. The executing skill announces; this one does not add a second announcement for the same work.

---

## When to use

Use when `plan-execute` has a batch of tasks the plan marks as having no dependencies on each other, and the harness can run agents in parallel.

Do NOT use it for tasks that share files, for security-sensitive work (auth, crypto, access control — do that yourself), or when you cannot verify the results afterwards. Sequential execution is the default and is complete on its own; parallelism is an optimisation, not a requirement.

---

## Non-negotiable rules

1. **Overlap within a batch is a decomposition bug, not a warning.** Fix the batch before dispatching. Two agents editing one file is the failure this skill exists to prevent.
2. **`subagent-rules` goes into every implementer prompt**, verbatim. Reviewer agents do not take it — they are not implementing.
3. **A success report is not evidence.** Read what each agent actually touched and run the task's gates yourself.
4. **Never dispatch more agents than you can verify.** Three or four is the practical ceiling.
5. **Every lane is released.** A finished agent's claim must not sit warning others.

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
| `subagent-rules` | Ships in this suite. The rules block injected into every implementer prompt | Dispatch lacks its required discipline | None — do not dispatch |
| `plan-execute` | Ships in this suite. The executor that invokes this and owns the audits | There is no plan context to dispatch from | None — this skill is not a standalone executor |
| `mai_claim` / `mai_claims` | mai-mcp coordination. Lane claiming and overlap visibility | Overlapping edits are invisible until they collide | Serialise the batch — run the tasks sequentially rather than blind |
| Harness parallel dispatch | The ability to run more than one agent | Parallelism is unavailable | Execute the batch sequentially; the plan is complete either way |

---

## Step 1: Check the batch

Confirm the tasks are genuinely independent: list the files each will touch and check for overlap **mechanically**, not by reading the plan's claim that they are independent. An overlap means the decomposition is wrong — fix it and re-check before dispatching anything.

## Step 2: Choose the model

**The rule is capability, not a name:** dispatch to the strongest implementation model your harness makes available. Implementers write code that ships; a cheaper model here is paid for twice, in the verification pass and the repair.

What that resolves to, as illustration rather than requirement:

| Harness | Strongest available implementer |
|---|---|
| Claude Code | An Opus-class model |
| Codex | The parent model, or an available Codex implementer |
| Any other | The strongest configured implementation model |

Where the project records a model preference, that preference wins over this table — it is the operator's decision and this skill does not overrule it.

Never fail merely because a preferred model is unavailable. Fall back to the next strongest and **name the model you actually dispatched to** in your output: a fallback nobody was told about turns into a review that trusts a weaker implementer than it thinks it is checking.

For a headless worker that needs the shell bridge, follow `docs/harnesses.md`'s
“Stateful brain access for headless workers” workflow in the visible mai-mcp
checkout. Retain one `mai-worker-session.mjs` process and one session directory
through the claim-only preflight and the same worker's continuation. Every
brain call uses that channel; verify the child claim before releasing the
implementation prompt. Close the channel and verify cleanup after the worker
exits. A one-shot reviewer bridge does not establish worker claim continuity.
If this capability is unavailable, use the sequential fallback below.

## Step 3: Dispatch the claim handshake

Dispatch the chosen child with a **claim-only preflight** prompt containing only the exact lane paths,
the intent line, and this order: (1) call `mai_prime` before any other task action; (2) read the project
instructions file named by the harness/repository; (3) call `mai_claim` as the first task-lane action,
before reading or editing any task file; (4) return the claim id and pause. Do not include the
implementation task yet. `mai_prime` is the mandatory session-start action; `mai_claim` is the first
lane action. Neither permits task-file work before the parent verifies the claim.

This preflight is the narrow exception documented in `subagent-rules`: it is not an implementation
prompt and therefore does not carry the full payload. The resumed implementation continuation does.

If the harness cannot resume the same child after it reports the claim, it cannot provide this
barrier. Use the sequential fallback instead of dispatching an unverified parallel lane.

## Step 4: Verify the claim, then release implementation

Confirm through `mai_claims` that the **same child session** holds exactly the proposed lane. A
missing, extra, or parent-owned claim is a dispatch failure: do not send the task.

Only after that check passes, continue the same child with the implementation prompt. It begins with
the `subagent-rules` block verbatim at the top, then contains: the task's exact scope from the plan; the files it may
create or modify; and the instruction that its **last action**, before returning, is to release the
verified claim id and report that id as released.

The child owns both claim transitions. A claim binds to the session that made it, so a parent can
neither claim on the child's behalf nor release what the child claimed — omit the final release
instruction and every lane leaks by construction, warning other agents until it expires.

## Step 5: Verify each result

For every returned agent, before accepting it:

- Read every file it created or modified. Do not trust the summary.
- Check the diff against the task's scope — anything extra is scope creep and comes out.
- Search for the escape hatches subagents reach for: type bypasses, hardcoded values, skipped error handling.
- Run the task's own verification commands yourself and read the output.

An agent that reports success and shows no diff did nothing.

## Step 6: Reconcile and report lanes

Confirm each lane the children released is actually gone. Report any still held — a lane whose child has returned is abandoned, and it warns every other agent until it expires. You cannot release it yourself; name it so a human can. Reconcile the batch's results before dispatching the next one; do not accumulate unverified work across batches.

Also reconcile each child's exact temporary-path inventory and verify its cleanup receipt. A supplied checkout stays with its named owner while needed; explicitly accept and carry that cleanup responsibility into `plan-execute` closeout. Recover an interrupted child's owned scratch after its processes stop. A released lane alone is not proof of filesystem cleanup.

---

## Output

Report per agent: the task, the files it touched, whether its gates passed, any scope creep removed, its lane's release status, and verified cleanup or exact paths handed to an accepting owner. Then the batch verdict — every task verified, or which are outstanding and why.
