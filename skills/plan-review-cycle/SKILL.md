---
name: plan-review-cycle
description: Coordinate proportionate independent plan review and bounded repairs. One broad review per architecture revision; clean deltas can close the cycle. Use for a requested review cycle, not a first standalone review or a repair with no follow-up requested.
---

<!-- SPDX-License-Identifier: MIT — Copyright © 2026 Maikai Group Inc.
     Part of mai-mcp (MIT — the whole project; see LICENSE). Copy freely. -->

# Plan Review Cycle

Establish architecture coverage once, independently check substantive repairs, and stop when the current revision is covered. Previously reviewed unchanged work retains its coverage.

## Invocation

**Announce at start:** "I'm using plan-review-cycle for one broad review and any necessary bounded deltas."

Name the plan, frozen SHA and selected mode. Default to proportionate review. Only an explicit user request for `final-clearance=exhaustive` enables a final end-to-end review and implementation rehearsal. Asking for a cycle, a strong model, maximum effort or a public release does not implicitly select exhaustive clearance.

## When to use

Use for an authorized review-and-repair cycle. Do not invoke this workflow merely to edit or discuss these skills. A first standalone review belongs to `plan-review`; a repair without an authorized follow-up belongs to `receiving-plan-review`.

## Non-negotiable rules

1. Pin every reviewed revision. Never edit it during an active review; reject mixed-revision results. Keep original review pins immutable.
2. The fixer cannot independently approve substantive changes. An independent reviewer may retain its own context and return for a delta if it never authored the plan or repair.
3. One completed broad review establishes coverage for the architecture revision even if it finds blockers. An aborted broad review or an unresolved coverage gap does not establish complete coverage.
4. A clean broad review, or broad coverage plus independent deltas covering all subsequent substantive changes, can approve the current frozen SHA. No open blocker may survive approval. Record warnings and notes as nonblocking follow-ups; accepting an actual product/security risk remains the user's decision.
5. Severity follows demonstrated consequences; breadth follows changed requirements and boundaries. A blocker does not by itself require broad review. Editorial corrections neither consume a review pass nor increment the blocked-pass count.
6. Preserve distinct behavioral requirements and useful discriminators. Removing duplicate checks or obsolete workflow gates is legitimate; do not manufacture passing evidence.
7. Stop for genuine unresolved authority choices, external blockers or drift requiring adjudication. Follow explicit current user decisions over older workflow defaults.
8. Preserve the reviewed files, index, HEAD and branch refs, and live services. Inspect the existing checkout and reuse valid evidence first. Probes needing writes may use owned isolated worktrees or small scratch directories; creating/removing an owned detached worktree is allowed within the task's filesystem permissions. Reuse matching environments across deltas. Clean only disposable review-owned environments after the cycle ends and reviewers stop; supplied implementation worktrees remain with their owner.
9. Retain durable finding UUIDs, dispositions, verification limits and a compact board handoff. Reuse existing outputs and closure notes; do not require parallel receipt documents or digest hierarchies.
10. Stop automatic dispatch after two consecutive substantive blocked passes in the same architecture revision. Diagnose recurring defects before another repair; report one recommended next action. Do not automatically buy more reviewers, increase model strength, or manufacture a new architecture revision to reset the budget.

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
| `plan-review` | Independent single review at the selected breadth | No independent verdict | Stop before approval |
| `receiving-plan-review` | Verifies findings and repairs the bounded affected set | No packaged repair workflow | Hand findings to the author without self-approval |
| `plan-execute` | Implements and verifies the approved plan | No packaged executor | Hand off approved pins and outstanding execution checks |
| `scripts/review-route.mjs` | Small deterministic breadth router | Automatic routing unavailable | Apply the table in the convergence reference and disclose the fallback |
| `scripts/review-scratch.mjs` | Owned isolated storage and cleanup; the one scratch contract, invoked as `node <skill-dir>/scripts/review-scratch.mjs` on every OS | Packaged scratch unavailable | Report the missing bundled helper and skip probes that need owned scratch; do not substitute an ad-hoc temporary directory |
| `scripts/review-headless.sh` | Optional opposite-CLI sample | Extra sample unavailable | Continue the ordinary independent review |

## Step 1: Pin and orient

Read the registered plan's current SHA, relevant project instructions, latest cycle handoff, open findings and active claims. Verify the file hash and any governing source/spec pins. Fetch older findings only for relevant lineage or missing facts; do not replay every historical synthesis.

The seven-day scratch janitor (`review-scratch.mjs prune`, marker-only and fail-closed) is a one-time, non-blocking opt-in per machine, never a review prerequisite. macOS: `bash <skill-dir>/scripts/install-janitor.sh install`, which renders the LaunchAgent's absolute Node and helper paths at install time. Windows: at cycle start run `powershell.exe -NoLogo -NoProfile -ExecutionPolicy Bypass -File scripts\windows\install-maintenance.ps1 -Job ReviewCleanup -Action Status` from the checkout; when it reports no task, run the same command once with `-Action Install` (per-user Task Scheduler, limited run level, no elevation). A missing janitor changes nothing about the review.

Read [the convergence reference](references/convergence.md) for routing and evidence reuse. Carry the architecture revision, broad coverage, last accepted review, changed scope and substantive blocked streak in the existing handoff.

## Step 2: Select scope and reviewer

No completed broad coverage for this architecture → broad. Substantive bounded repair → delta. A real requirements, architecture or material integration change → new architecture revision and broad. Clean covered revision → approve. Cosmetic-only changes → editorial equivalence check, no independent pass.

A local task reorder, new test, command correction, fixture change or wording edit is not automatically architectural. Require evidence that requirements, ownership, threat/data model, or a material producer/consumer contract changed. If a delta discovers a coverage gap, inspect the affected boundary; do not broaden the whole review merely because it was omitted from a handoff. A genuine architecture change returns `SCOPE_ESCAPE` without pretending the bounded review covered it.

Choose strength separately from breadth. Retain explicit user model preferences. Defaults:

| Pass shape | Codex model | Codex effort | Claude Code class/effort | Contract |
|---|---|---|---|---|
| Architecture broad pass | `gpt-5.6-terra` | `high` | Sonnet-class `high` | Establish architecture coverage |
| Bounded repair delta | `gpt-5.6-luna` | `high` | Sonnet-class `high` | Inspect changed scope and relevant regressions |
| High-risk repair delta | `gpt-5.6-sol` | `xhigh` | Opus- or Fable-class `xhigh` | Inspect the same bounded scope at greater depth |
| Optional exhaustive clearance | `gpt-5.6-sol` | `xhigh` | Opus- or Fable-class `xhigh` | Explicitly requested end-to-end challenge |

High-risk architecture work uses the stronger tier too. `review-profile=max` selects strongest available model/effort, not wider scope. `review-model=<model>` or per-breadth `review-models=` overrides are respected without a repeated picker. Record actual model/effort; inspect environment overrides such as `CLAUDE_CODE_SUBAGENT_MODEL` and `CLAUDE_CODE_EFFORT_LEVEL` before claiming a tier. Never silently report a stronger model than actually ran.

Prefer resuming the same independent reviewer for bounded deltas, retaining its source context and adding the new pin and diff. Initial Codex reviewer dispatch uses `fork_turns: "none"`; never copy the author's conversation. A fresh independent session can review inline. When resumption is unavailable or the reviewer authored a repair, start a clean reviewer with a compact factual handoff. Model/harness rotation and an extra opposite-harness sample are opt-in.

Keep stable instructions and factual reference material stable; append revision-specific changes. This can help provider prompt caching but does not guarantee a cache hit or make input tokens free. Do not send huge context solely to prime a cache, poll to keep it warm, or claim caching worked without usage evidence.

## Step 3: Run one review

The brief contains the immutable plan/spec/source pins, breadth, relevant diff and contracts, finding UUIDs and test evidence, plus scratch ownership when needed. It excludes author reasoning or a requested verdict. The reviewer follows `plan-review`, forms its own conclusion and posts one atomic review.

Reuse the existing checkout for source inspection. For probes needing writes, prefer a supplied, exclusively owned isolated worktree with matching inputs, or create a detached worktree at the pinned source SHA. For an uncommitted review target, reproduce and verify the relevant working changes too; a clean HEAD checkout alone is not equivalent. Verify dependencies and reset owned mutable fixtures before reuse. Do not recreate both app and backend environments for a probe needing only one module, or implement the plan twice. Archives/small scratch copies remain options when Git history/index is unnecessary.

Allocate scratch lazily with `node <skill-dir>/scripts/review-scratch.mjs create` — the same invocation on macOS, Linux and Windows — for temporary payloads, caches or small probes. Pass its exact `REVIEW_SCRATCH_ROOT` and route `TMPDIR`, `TMP`, `TEMP` and `npm_config_cache` beneath it. Record worktree paths and owners separately, outside auto-deleted scratch roots: the helper/janitor does not unregister linked worktrees. Reuse both kinds of environment across deltas while relevant inputs match.

For optional headless sampling use `review-headless.sh doctor` then `review-headless.sh run` on the actual CLI, not GUI/cloud substitutes. This wrapper's sample is not a durable approval; do not run an extra sample unless requested. Its ephemeral mode is a fallback, not a reason to discard an available resumable reviewer.

The packaged headless wrapper requires its workdir beneath its scratch root. Use the native reviewer route for an external worktree; do not duplicate an existing worktree or place it under the janitor merely to satisfy that optional wrapper.

For headless Codex environments where registered MCP calls fail, use the existing `scripts/mai-review-bridge.mjs` next to its build: resolve absolute Node/bridge paths and pass project slug/root and JSON through argv or a file. Never interpolate finding text into shell code. The reviewer needs `mai_findings`, `mai_plan`, `mai_review_post`, and location repair via `mai_finding_update`. Do not spawn nested reviewers.

Read back a posted review once to confirm SHA, verdict and intended finding UUID/counts; reuse a reviewer's confirmed readback instead of repeating it at each orchestration layer. Unknown writes require readback before retry. Record the accepted result and replace the preceding board handoff.

## Step 4: Repair and reuse evidence

Invoke `receiving-plan-review` for confirmed findings. It owns premise verification, the defect-shape search, affected end-state checks, targeted proof and UUID closure. The runner consumes that evidence; it does not repeat those checks or construct another overlay.

Pin the repaired SHA and inspect the actual diff to select its scope. A substantive repair needs independent delta review. For purely editorial changes (including evidenced corrections to misclassified blockers), verify the diff changes no behavior, requirement, command, code example, contract or acceptance criterion; record the new SHA and its equivalence to the reviewed baseline. Keep the old review attached to its original SHA. If equivalence is uncertain, request a small delta.

Reuse checks individually as described in the convergence reference. Missing metadata invalidates only the affected check. Implementation-only checks stay explicitly pending until execution; no blanket full-matrix rerun or mandatory mutation exercise follows a prose repair.

## Step 5: Route or stop

Run `node <skill-dir>/scripts/review-route.mjs` with the accepted state before dispatch. It checks the breadth/verdict pair, architecture coverage, findings dispositions and blocked budget. `--final-clearance exhaustive` is supplied only with explicit authority; otherwise it defaults to `none`.

Recurring substantive findings require a root-cause correction across the relevant defect family. Record it in the existing finding note with focused proof; no single-use root-proof digest or universal failure matrix is required. Repeated verification-only findings call for removing duplicate or irrelevant checks, not building another verification layer. Budget exhaustion leaves the plan reviewing and reports `review-stalled` as cycle state. Only an explicit user instruction can authorize one additional pass; consume that authority once.

## Step 6: Approve and hand off

Approve when completed broad coverage plus any necessary independent deltas cover the current frozen revision, all substantive changes are accounted for, and there are no open blockers or unresolved approval-critical gaps. Confirm the SHA on disk and registration. Editorial carry-forward must identify the original review and exact equivalence-checked new revision rather than invent a new independent review.

In explicit exhaustive mode only, perform the requested final end-to-end review and complete matrix once; existing matching results may satisfy individual checks. If it finds a bounded defect, a clean independent delta plus still-valid clearance coverage can close the cycle without another complete clearance pass.

After reviewers stop, retain useful evidence/changes and remove only disposable review-owned worktrees with `git worktree remove <owned-path>`. Do not force-remove unknown changes or remove supplied implementation worktrees. Separately clean owned scratch with `node <skill-dir>/scripts/review-scratch.mjs cleanup "$REVIEW_SCRATCH_ROOT"` when allocated. Report cleanup failures explicitly; the optional janitor handles scratch directories, not worktrees.

Apply this closeout on blocked, stalled, failed or cancelled cycles too, following the mandatory cleanup rules. The seven-day janitor is crash recovery, not a substitute for cleanup before returning. Hand still-needed supplied environments to their accepting owner with exact paths and next cleanup actions.

## Output

Report approved SHA (or blocker), broad/delta pass counts, changed scope, finding dispositions, evidence reused/run/deferred and execution readiness. Use one compact board handoff and resolve the one it supersedes. Plan approval means ready to implement, not that the unimplemented application has passed its full suite.
