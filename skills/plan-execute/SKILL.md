---
name: plan-execute
description: Executes an approved implementation plan with strict fidelity, between-task audits, and mandatory verification. Use this skill when a plan has been reviewed (via plan-review) and is ready for execution. Triggers on "execute the plan", "implement the plan", "build it now", "start executing", "run the plan". Works with any project type — backend, frontend, full-stack, CLI, library. Invokes mai-subagent-execute for independent parallel batches and enforces code review checkpoints throughout.
---

<!-- SPDX-License-Identifier: MIT — Copyright © 2026 Maikai Group Inc.
     Part of mai-mcp (MIT — the whole project; see LICENSE). Copy freely. -->

# Plan Executor

You are executing a pre-approved implementation plan. Produce correct, complete code — nothing more, nothing less than what the plan specifies.

---

## Invocation

**Announce at start:** "I'm using the plan-execute skill to implement the approved plan with between-task audits and verification checkpoints."

---

## When to use

Use this skill when a plan has been reviewed and approved and is ready for execution. Triggers on "execute the plan", "implement the plan", "build it now", "start executing", "run the plan".

Do NOT execute without independent review coverage for the registered revision, including any explicitly recorded editorial equivalence chain. A clean delta completing prior broad coverage is sufficient; exhaustive clearance is not required.

### Plan corrections

A routine implementation correction within approved requirements can proceed under existing user authority. Record the amendment and affected verification while keeping the approved plan frozen. Editorial corrections do not reopen review. Substantive bounded repairs receive independent delta review; changed requirements, architecture or a material integration boundary require renewed broad review. Ask only for a genuinely new product/policy choice or missing authority.

---

## Non-negotiable rules

These are non-negotiable. No exceptions. No rationalisations.

1. **Follow the plan exactly.** Do not add anything not in the plan. Do not omit anything in the plan. The plan was approved — respect it.

2. **No switching approaches mid-execution.** If the plan specifies a particular pattern, component, or architecture, use it. Decisions were made in planning — do not relitigate them here.

3. **No type-safety bypasses.** No `any` (TypeScript), no `object` as a lazy catch-all, no `# type: ignore` (Python), no equivalent in other languages. If you encounter a type the plan doesn't cover, write `// TODO: NEEDS DECISION — type for [X]` and use the most specific type you can infer.

4. **When you hit something the plan didn't cover:** write `// TODO: NEEDS DECISION — [exact question]` at that point, note it in your task report, and keep going. Do not improvise a solution.

5. **The plan file is READ-ONLY during the run; tick the whole checklist at the end.** A registered plan is frozen before execution — `mai_plan` stores a SHA-256 of the file and every review pins its verdict to that hash ("approved @ `<sha>`"). Any edit changes the hash, so the approval stops referring to the file on disk and every later drift check reports a mismatch you caused. So do **not** flip boxes as you go, and do not touch the plan for any other reason mid-run. Track progress in your task list instead, and say once at the start that the ticks are deferred.

   Then in the **final task**: flip every `- [ ]` to `- [x]`, replace the status line with `**Status:** EXECUTED — verified <date>`, commit with an exact pathspec, and refresh the record — `mai_plan {path, status: "executed"}` — verifying the returned sha equals the post-commit file hash. That check is what proves no tick or status edit was left outside the execution record. Append the commit SHA to a step's line when that step is a commit (e.g. `- [x] **Step 6: Commit** — abc1234`). For a step deliberately skipped or deferred, leave it `- [ ]` and append a short reason (e.g. `(NOT run — deferred by the user, manual prod step)`) rather than falsely ticking it.

   The plan file is still the durable record — if its boxes read `[ ]` after the work shipped, the doc is lying and the next person can't tell what's complete. Deferring the ticks does not skip them; it batches them into the execution record.

6. **Every task boundary posts a handoff to the shared board, and resolves the note it supersedes.** The plan file and the commits are the durable record, but they are not what the next agent — or the plan's author, or a parallel session on another model — reads first. The board is. A run that keeps its findings in chat has made every one of them non-transferable: the user becomes the courier, hand-carrying task results between agents that could have read them directly.

   Posting is only half the rule. A note the run has overtaken is worse than no note, because it is read with the same authority as a current one — a stale `RESUME AT task N` pointer will send the next agent to redo work that is already committed. So each handoff **resolves the note it replaces** in the same action. Leaving both to accumulate turns the board into a pile the next agent has to date-sort and second-guess.

   Where a harness offers no shared board or thread surface, the handoff goes into the task report the user reads, in the same fields — the point is that it leaves your context in a form someone else can act on.

7. **A linked roadmap card follows execution state.** Read the plan's `**Roadmap card:**` header.
   When it names a UUID, execution cannot begin until that exact card is `planned`; move it
   `planned → building` with `mai_idea_move` and approved-plan evidence before Task 1. After every
   task and final gate passes, the execution closeout is committed, and `mai_plan` reads back
   `executed`, move the same card `building → shipped` with commit-and-gate evidence before the
   closing handoff. These are the only agent-owned transitions. Never move `idea → planned`, revive
   `dropped`, or repair a mismatched UUID by title. A `none` header is an explicit no-op.

8. **Operator task bodies stay in My Tasks.** At every task boundary and in the final response,
   report only pending/blocking/follow-up counts plus the exact plan identity and My Tasks URL from
   the receipt: `<plan title> @ <short current SHA> — <plan-scoped URL>`. For an aggregate receipt
   covering multiple plans, emit one identity/count/link line per plan. Never reconstruct the URL
   from a remembered plan ID; use the receipt returned by `mai_plan` or `mai_user_tasks_post`.
   Do not repeat operator-task titles or instructions in chat or board handoffs unless the user explicitly asks to see them there.
   This restriction applies only to already-stored operator task bodies; continue reporting normal
   implementation results, failures, and agent-to-agent work.

### What Proper Approach Means

When there is a choice between quick and correct, choose correct:

| Quick (not acceptable) | Correct (required) |
|---|---|
| Skip the between-task audit "because it's simple" | Run the audit every time |
| Trust subagent output without reading the files | Read and verify every file |
| Type-safety bypass (`any`, `object`, `# type: ignore`) | Properly typed interface |
| Approximate the implementation | Match the plan's intent exactly |
| Skip a hard section | Mark `// TODO: NEEDS DECISION` and keep going |
| Re-decide something already decided in the plan | Follow the plan |
| Add a "nice to have" not in the plan | Don't |
| Use a different approach than planned because it "seems better" | Follow the plan |
| Claim "done" without running verification commands | Run the commands, show the output |
| Mark subagent task complete because the subagent said so | Verify the work yourself |
| Tick boxes in the plan file as you go, breaking its frozen sha | Tick every box in the final task, then verify the refreshed sha |

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
| `plan-review` | Ships in this suite. Produces the approved plan and immutable review record this skill executes | The plan has no independent approval | None — stop; do not execute an unreviewed plan |
| `subagent-rules` | Ships in this suite. The rules block injected into every subagent prompt | A subagent dispatch lacks its required discipline | None — do not dispatch subagents without it |
| `plan-compliance` | Ships in this suite. Fidelity-to-plan audit after each task | The between-task fidelity audit is unavailable | Perform the audit inline from the plan's task requirements before continuing |
| `mai-code-review` | Ships in this suite. The milestone quality review that files durable findings | Milestone reviews have no packaged reviewer | Use the harness's reviewer, or read the diff against the plan yourself and record the result |
| `mai-receiving-code-review` | Ships in this suite. Verifies, repairs and closes code findings before shipping | Code findings cannot be receipted | Stop before commit; retain the UUIDs and resume when the receiver is available |
| `mai-subagent-execute` | Ships in this suite. Parallel dispatch for independent task batches | Parallel dispatch is unavailable | Execute sequentially — the default path, complete on its own |
| `superpowers:requesting-code-review` | Optional external. Reviewer-subagent dispatch | Its packaged review workflow is unavailable | Use the harness's reviewer mechanism, or read the diff against the plan yourself |
| `superpowers:verification-before-completion` | Optional external. Deeper evidence-before-claims discipline | Its packaged workflow is unavailable | Apply the evidence mechanics stated inline below |
| `context7` | Optional external. Library/framework documentation lookup | Its documentation lookup is unavailable | Read the dependency's source or README in `node_modules` |

---

## Step 1: Read the Plan

Read the full plan document before writing a single line of code.

Then call `mai_findings` with the plan's path and `status: "open"`. These are the review findings
nobody has closed yet. Anything a reviewer marked `blocker` must be resolved or explicitly disputed
before you execute the task it touches.

Do not start early. If anything is unclear, ask before starting — not halfway through.

As you read, identify:
- The task execution order and any dependency chains
- Which tasks can be parallelised (no shared dependencies)
- What existing code/components/utilities to reuse
- The verification commands specified for each task

### Step 1.0: Synchronize the approved operator checklist

Start execution with the existing `mai_plan {path, status:"executing"}` transition and require its
receipt to contain numeric inserted/existing and blocking/follow-up counts plus the My Tasks link.
If a resumed or upgraded server returns no operator-task receipt, call
`mai_user_tasks_post {mode:"sync-plan", plan_path:"<path>"}` exactly once as recovery. Never copy plan task titles or instructions into that recovery call; the registered plan remains the source.

Newly discovered user-only work is not added to the frozen plan. Submit it once as one
`mai_user_tasks_post` `assign` batch with stable keys, then keep its bodies out of chat and board
handoffs under rule 8.

### Step 1.1: Move the linked roadmap card into Building

Read the plan's `**Roadmap card:**` value before claiming files or starting Task 1.

- `none` means no roadmap mutation; record `Roadmap: unlinked (declared none)` in the execution-start
  handoff and continue.
- A UUID must resolve exactly through `mai_ideas {include_closed:true}`. If it is `planned`, call
  `mai_idea_move {idea_id, to:"building", evidence}` where evidence names the registered plan id,
  exact approved plan SHA, and execution-start date. Persist the move receipt in the first handoff.
- If that exact UUID is already `building`, treat this as a resumed execution, make no duplicate
  move, and record the observed state.
- If the UUID is missing, ambiguous, `idea`, `shipped`, or `dropped`, stop before implementation and
  ask the user to resolve the board state. Do not substitute a same-title card and do not call an
  unsupported transition.

If a plan predates the required header, stop and have its author add either the exact card UUID or
the explicit `none` declaration, then refresh/re-approve the plan SHA. If the roadmap tools are
unavailable for a linked UUID, stop with the exact failed capability; continuing would make the
board contradict execution.

## Step 2: Check Existing Assets

Before writing anything from scratch, check what already exists in the project. Identify the project's key directories (components, hooks, services, utils, lib, models, etc.) and verify what's already there.

If something exists, import it. Do not recreate it.

Implement each task once in the chosen working checkout, using a worktree when isolation is needed. Reuse that checkout and its dependencies across tasks where compatible; share pinned revisions and matching test evidence with reviewers. Reviewers inspect it without editing and use separate isolated probes only when necessary. A review scratch folder is not a mandatory second implementation, and a supplied implementation worktree is not disposable review scratch.

Use **context7** to look up framework or library documentation if you need to verify a specific API, component prop, or behaviour.

## Step 3: Break the Work into Tasks

Use the plan's task breakdown directly. Each task becomes a tracked unit of work.

**For sequential execution:** Work through tasks in order. Mark each `in_progress` when you start it, `completed` only after it passes the between-task audit (Step 5).

**For parallel execution:** Invoke `mai-subagent-execute` with the independent task batch. Tasks in the same batch must have NO dependencies or overlapping file lanes (plan-review should have checked this; verify again). `plan-execute` remains the parent executor: it chooses the batch, waits for verified results, and runs every audit below.

**Do not bypass the internal dispatcher with a generic child runner.** `mai-subagent-execute` owns the claim-only handshake, verified continuation, capability-based model choice, `subagent-rules` injection into implementers, and child-owned claim release. If it is unavailable, execute sequentially; do not recreate half of its protocol inline.

## Step 4: Execute Each Task

For each task, follow this cycle:

1. **Read** any existing files the task modifies
2. **Write** the code exactly as the plan specifies
3. **Prepare** the task diff for the single fidelity audit in Step 5
4. **Verify** the task with its required commands, reusing existing results only when relevant inputs and environment match
5. **Hold** any commit block this task carries — it is a deferred shipping unit, not an implementation
   step. A task with no commit block is complete at its gates; do not invent one
6. **Proceed to the pre-commit audit** (Step 5)

When writing code:
- Follow the project's existing patterns and conventions
- Use named imports (no wildcards)
- Follow the project's styling approach (whatever it uses)
- Write explicit types — no type-safety bypasses
- Do not add error handling, validation, or features not in the plan

If a task discovers new operator-only work, collect all items discovered in that task and submit one
stable-key `assign` batch before the boundary audit. Do not edit the frozen plan to record them.

## Step 5: Between-Task Audit (MANDATORY)

**After a task's implementation and gates complete — and before any deferred shipping commit it carries — run this audit.** This is not optional. This is the checkpoint that prevents drift from compounding or shipping.

#### 5.1 One fidelity and integration audit

Run `plan-compliance` once over the actual task diff, affected interfaces and verification evidence. This satisfies task self-check and dispatched-work fidelity checks; do not reread every modified file or run a second fidelity checklist afterward.

For child work, inspect changes yourself and validate command output against actual relevant inputs and environment. Reuse valid evidence. Rerun only missing/invalid checks or focused checks needed to resolve a concrete concern.

For plan findings addressed by the task, update the plan UUID with its evidence. Code findings belong to `mai-receiving-code-review`, which owns safe closure and affected re-verification. Do not duplicate its shell closure recipe.

#### 5.4 Quality review at milestones

Use the fidelity result from 5.1 and add quality review only when a milestone warrants it:

- **Every task — fidelity.** Consume the existing 5.1 compliance result; do not run it again.
- **At milestones — quality.** Run `mai-code-review`, which reviews inline or dispatches according to
  its context posture and files durable findings. **A routine local task commit is not by itself a
  milestone** — if it were, this policy would just be "review every task" wearing a longer name. A
  quality milestone is: an explicit phase boundary, the end of a group of related tasks; an
  accumulated diff that crosses a size or sensitivity threshold — authentication, schema, money, or
  release paths; or the point where work **leaves this isolated branch/worktree** through push, merge,
  publish or deploy.

Running the quality review after every task is not more rigorous, it is more expensive: a task that
writes one verbatim file does not need a dispatched reviewer. Running it *never* is the failure this
policy exists to prevent. **What matters is that the check ran and its result is recorded, not which
tool ran it.** If `mai-code-review` files anything, invoke `mai-receiving-code-review` and record every
code-finding UUID's disposition before 5.6 can run; a review without receipt is not a green milestone.
Review the unreviewed diff and affected interactions for correctness, safety and test adequacy. Consume the fidelity result and matching verification evidence. An already-reviewed milestone does not require another whole-diff review merely because it reaches a push/commit boundary; review intervening substantive changes as a delta.

**If the review finds issues, fix them before starting the next task.** Do not accumulate problems across tasks.

#### 5.5 Audit Report

After each audit + code review, produce a brief status:

```
Task [N]: [title]
Status: PASS / FAIL
Plan fidelity: [matched / N deviations found]
Integration: [clean / N issues found]
Subagent verified: [yes/no/N/A]
Code review: [passed / N issues found]
Code findings: [none / UUID: disposition, ...]
Commit: [sha / N/A — task has no commit block]
Issues: [list if any, "none" if clean]
```

**If FAIL:** Fix the issues before proceeding. Do not start the next task with a failed audit hanging.

**On PASS:** Proceed to 5.6. Do **not** start the next task and do **not** edit the plan `.md` yet — the plan remains frozen for the duration of the run and every box is ticked at the end (rule 5).

#### 5.6 Commit After Green Audit and Finding Receipt

If this task carries a commit block, execute it now — and only now. The event order is implementation
→ task verification → fidelity review → milestone quality review when triggered → code-finding receipt
and re-verification → PASS report → shipping commit. If any review or receipt fails, there is no
commit. After the exact commit succeeds, record its SHA and begin the next task.

**A task with no commit block ends here.** Record `commit: N/A` in the audit report and begin the next
task. Never invent a commit to satisfy this step — this skill executes arbitrary plans, and not every
task in one is a shipping unit.

#### 5.7 Post the Task Handoff

Post before starting the next task, so the board is never behind the commits (rule 6). Same six fields
every time — a reader comparing two handoffs should be diffing content, not hunting for it:

| Field | Content |
|---|---|
| Task | Number and title, and `PASS` or `BLOCKED` |
| Plan fidelity | Steps completed verbatim, plus any amendment ids this task carried |
| Findings | Each finding id with `fixed`, `disputed` + the evidence that disproves it, or `accepted-risk` + who accepted it |
| Commit | The SHA, or `N/A` for a task that is not a shipping unit |
| Evidence | The gate outputs that prove the claim — counts and exit statuses, not adjectives |
| Next | The next task, plus any carry-forward this task created for a later one |

In the same action, resolve the handoff this one supersedes. Carry-forwards are the exception: a
carry-forward stays open until the task that owns it closes it, because it is a debt, not a status.

Two things belong here that a summary tends to drop. Record a finding you closed by **disputing** it
with the same weight as one you fixed — the next reader cannot re-derive your evidence, and an
undisputed-looking finding gets re-found next pass. And when your first attempt satisfied the words of
a finding but not its requirement, say so: that near-miss is the most transferable thing the task
produced, and it dies in your context otherwise.

## Step 6: Final Verification

After tasks and audits pass, reconcile required checks against final relevant inputs. Reuse trustworthy task, child, CI or earlier results when command, working directory, source/fixtures, configuration, lockfiles, tool versions and environment match. Validate actual status/output; a prose success claim is insufficient.

Run each missing or invalidated check once. Missing metadata invalidates only the affected check, not the entire matrix. Whole-plan SHA or unrelated documentation changes do not invalidate results for unchanged inputs. A scratch plan probe covers implementation only when its relevant bytes and environment demonstrably match.

Include final integration/release checks required by the plan and preserve checks whose purpose requires fresh live/external state. Reconcile affected requirements against accumulated task audits rather than repeating their full comparisons. No second final gate follows this one.

For defect fixes, verify the original symptom through a relevant regression. Use red/green or mutation proof when needed to establish that the assertion discriminates; do not repeat it when valid evidence already exists.

### Step 6.1: Enforce the operator blocking gate

At every task boundary, and again immediately before plan checkbox/status closeout and before the
roadmap `building → shipped` transition, call
`mai_user_tasks {plan_path:"<path>", detail:"summary"}`. Report only its numeric counts and My Tasks
link. Any pending blocking count stops closeout: do not tick the plan, mark it executed, or ship the
roadmap card. Pending follow-ups do not block closeout.

After the operator resolves the blockers, rerun every freshness-sensitive final gate before
closeout. Checkbox changes never auto-execute or auto-ship a plan; the verified lifecycle calls
remain explicit.

## Step 7: Report

After all tasks complete and final verification passes:

**First, update the plan document.** This is where the run's deferred ticks land (rule 5): flip every completed step to `- [x]` in the plan `.md`, and add a `> **STATUS (verified YYYY-MM-DD):**` line near the top summarising the outcome (✅ complete / partial + what's deferred, with commit SHAs and merge/deploy state). This makes the plan file self-evidently "done" at a glance. Commit that edit with an exact pathspec, then refresh the plan record and verify the returned sha matches the post-commit file hash — an unverified refresh leaves you unable to say whether any edit escaped the execution record. Then provide the report contract in `## Output`.

**Then close the linked roadmap card.** Re-read the exact UUID recorded in the plan. When it is
`building`, call `mai_idea_move {idea_id, to:"shipped", evidence}` only after the executed-plan
readback above succeeds. Evidence names the plan record, post-closeout plan SHA, implementation
commit range, and the final gate commands with their exit statuses/counts. If it is already
`shipped`, record the idempotent observed state; any other status is a stop condition and execution
must not be reported as fully reconciled. A declared `none` remains a no-op.

**Finish resource cleanup before returning.** Reconcile the run's temporary-path inventory, including child and reviewer handoffs, using the mandatory cleanup rules above. Preserve final commits/deliverables and compact evidence, then remove completed owned worktrees and disposable dependencies/builds. An implementation checkout supplied to a reviewer remains the executor's cleanup responsibility. Include verified removals and any retained path's owner, reason and next action in the closing handoff; do not report the whole run complete with disposable artifacts left behind.

---

## Output

**Task status:** List each task with its audit result.

**Decisions needed:** For every `// TODO: NEEDS DECISION`, state the question clearly.

**What was NOT added:** Confirm nothing was added beyond the plan.

**What was NOT omitted:** Confirm every plan item is present.

**Verification evidence:** Summarize commands, status and evidence locations; distinguish reused, executed and deferred checks without dumping full repeated logs.

**Board state:** Post the closing handoff — plan id, final commit range, every task's status, and each
finding's disposition, plus the roadmap card UUID and its `shipped` move receipt (or the declared
`none` no-op) — and resolve every note from the run it supersedes, including the last task
handoff. Then say what remains open and who owns it. A run that reports `EXECUTED` in chat while the
board still shows an open mid-run pointer has left the next agent a contradiction to resolve, and they
will resolve it wrong.
