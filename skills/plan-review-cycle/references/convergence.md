# Proportionate review routing

Use the existing cycle handoff; no separate ledger, receipt schema or digest hierarchy is required.

## State and scope

Keep architecture revision, completed broad coverage, last accepted breadth/verdict and SHA, changed scope, substantive blocked streak, findings dispositions, and explicit exhaustive-mode authority. Preserve source/spec revision pins and relevant finding UUIDs. A new plan SHA alone does not invalidate architecture coverage.

New requirements, architecture or a material integration boundary require broad review. Local type fixes, task ordering corrections, tests, commands and wording changes remain bounded unless their actual effect changes one of those boundaries. Missing context in a handoff is repaired with targeted reads.

## Routes

| State | Next action |
|---|---|
| No completed broad coverage in current architecture | Broad review |
| Substantive bounded repair | Independent delta |
| Material architecture/requirements/integration change | New architecture revision and broad review |
| Pure editorial change | Diff/equivalence check; preserve original review pin |
| Clean broad or delta with all substantive changes covered | Approve |
| Explicit exhaustive mode, clean covered revision without clearance coverage | One exhaustive clearance |
| Bounded repair after exhaustive clearance | Delta; retain unchanged clearance coverage |
| Two consecutive substantive blocked passes | Stop automatic dispatch and report the cause |

The router's `--clearance-covered true` means an accepted exhaustive pass completed its actual scope in this architecture revision, and later changes are all covered by independent deltas. A blocked exhaustive pass can establish coverage; an aborted or incomplete one cannot. Reset this flag after a material architecture change.

A delta encountering a genuine architecture change returns `SCOPE_ESCAPE` with its pin and dependency evidence, without posting a misleading approval. The runner uses `--scope-escape-epoch` to route broad. Ordinary defects and localized verification gaps remain part of the delta.

Warnings, notes and editorial fixes are nonblocking and do not increase the blocked streak. Do not downgrade a real blocker to fit the budget. On recurrence, correct the defect family with a focused source search and appropriate proof in the existing finding note. At the budget limit, stop rather than purchase another review automatically. An explicit user instruction may authorize exactly one additional pass.

## Evidence reuse

Reuse existing logs/CI results/closure notes when the exact command and working directory, relevant source/plan-section/fixture bytes, lockfiles, configuration, tool versions and environment boundary match. Inspect the recorded status and observable; a summary saying “passed” is insufficient.

A changed whole-plan SHA does not invalidate evidence for unchanged inputs. Unknown dependencies invalidate the check whose dependency set is unknown. Reconstruct missing metadata from trustworthy existing records when possible; otherwise rerun that affected check only, if needed at this stage. Do not invalidate the whole matrix.

The executor owns required implementation checks. Plan review normally inspects the proposed test strategy and commands. Execute a focused probe in an owned isolated worktree or small scratch directory only to resolve a consequential uncertainty that source inspection cannot settle. No routine full production overlay, build or integration matrix precedes implementation.

Within execution, each required check must have matching final-state evidence. Reuse valid child, prior task or CI evidence; run missing/invalid checks once. Preserve explicit freshness-sensitive checks of live/external state. An earlier scratch probe covers actual implementation only if its relevant bytes and environment demonstrably match.

## Context and scratch reuse

Resume an independent reviewer when possible; never resume the fixer as the independent approver. A new reviewer receives factual pins, changed scope, relevant contract context and existing evidence, without the author's reasoning. Keep stable prompt prefixes stable and append changes, but treat provider caching as opportunistic and measure actual cached-token usage where available.

Read the existing checkout without copying it. Reuse verified isolated worktrees/dependencies across deltas and reset owned mutable fixtures. New worktrees start at the source pin; account explicitly for any relevant uncommitted changes. Use scratch for payloads/caches and small probes, with linked worktrees outside auto-deleted scratch roots. Preserve useful changes/evidence and clean disposable review-owned worktrees through Git after the cycle ends; supplied implementation worktrees remain with their owner. No keepalive polling, broad context reloads, or full environment reconstruction solely to improve caching.

## Importer example

Broad review of A finds an encryption-detection defect. Repair B changes only that behavior and its regressions. Focused encryption tests run or valid results are reused. Independent delta of B is clean: approve B. No full clearance, app/backend recreation or unrelated full-suite rerun follows. A later typo correction gets an editorial equivalence check.
