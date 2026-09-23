---
name: mai-design
description: Turn an unsettled feature or behavior request into a source-grounded written spec with settled choices and verification criteria. Use before implementation planning; do not implement code or redesign an approved plan unless requested.
---

<!-- SPDX-License-Identifier: MIT — Copyright © 2026 Maikai Group Inc.
     Part of mai-mcp (MIT — the whole project; see LICENSE). Copy freely. -->

# Design

Resolve the consequential unknowns in a feature request and write a spec that planning can use. Keep requirements, assumptions and unresolved blockers distinct so a plausible design is never mistaken for a settled one.

## Invocation

**Announce at start:** "I'm using the mai-design skill to settle the behavior and write a spec grounded in the current project."

## When to use

Use when a feature request leaves behavior, scope or interfaces unsettled. Example: "Design invitation expiry and recovery for our existing account flow."

Do not use for implementation, a routine code explanation, or unsolicited redesign of an approved plan. If the spec is already settled, hand it to `write-plan` without reopening settled choices.

**Inputs:** `request`, `project/source scope`, `known requirements`, `constraints`, and any existing `spec/plan` or authorization. Derive available context before asking for missing information.

## Non-negotiable rules

1. Read project instructions and recall relevant decisions before proposing choices. Current source determines current behavior; explain contrary evidence and surface decision conflicts before proceeding with dependent design work.
2. Separate known requirements, constraints and assumptions. Ask only consequential unresolved questions; keep working on independent parts while waiting. Existing authorization remains valid and needs no ritual reconfirmation.
3. Compare options only where a real tradeoff remains. Do not invent alternatives to settled requirements or silently choose a consequential unresolved requirement for the user.
4. Do not edit implementation or alter an approved plan unless requested. Preserve existing plan review, review receipts, finding identities, lane claims and operator-task requirements; a design does not bypass them.
5. Analysis implies no dependency installation, global profile changes, production mutation, deployment, third-party messages or activation. Search before durable writes, cite evidence and distinguish user choices from inferred recommendations.

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
| `mai_prime` / `mai_search` | Optional project brain initialization and decision recall | Prior decisions cannot be recalled through the brain | Report unavailable recall; read project instructions, supplied decisions and current source |
| Source access | Current affected implementation and interface contracts | Existing behavior cannot be verified | Use supplied source excerpts with their revision; name missing evidence and keep dependent choices unresolved |
| `mai_remember` / `mai_lesson_add` | Optional durable decision and lesson capture | Settled outcomes cannot be persisted in the brain | Keep the decision, rationale and provenance in the spec; report that persistence did not run |
| `write-plan` | Shipped workflow from settled spec to reviewed implementation plan | Packaged planning handoff is unavailable | Deliver the settled spec and planning inputs; retain the project's existing planning and review process |

## Step 1: Establish the design boundary

1. Read your harness's instructions file (`CLAUDE.md`, `AGENTS.md`, or equivalent). When the brain is available, prime for this task and recall relevant decisions according to those instructions. State unavailable capabilities explicitly.
2. Inspect existing specs/plans and the current source affected by the request. Record source anchors for behavior, interfaces and constraints; verify recalled claims against source.
3. List `known requirements`, `constraints`, `assumptions` and `open choices`. Explain conflicts between the request, recorded decisions and implementation instead of silently overriding them.

<!-- mai:shared:navigation-preflight start — synced from skill-blocks/navigation-preflight.md.
     Do NOT hand-edit inside this block; the sync rewrites it wholesale and the
     edit disappears silently (lesson 420dbda2). -->
### Conditional navigation preflight

At this discovery checkpoint, make one automatic `mai_navigate` call when the tool is exposed, the work is substantive, and a concrete unresolved question could change the current artifact's constraints, affected consumers or verification. Use the adjacent intent guidance. Skip trivial edits, already-resolved questions and questions requiring unsuitable sensitive evidence.

Before calling, state the bounded question and that an enabled Jev call sends selected project evidence to TypeSafe. Existing project opt-in is sufficient; do not enable a provider, obtain credentials or ask for repeated confirmation. If enablement is unknown, a disabled response is a harmless capability check, not permission to change configuration.

Use known terms/node IDs and only relevant labelled excerpts. Keep expected answers, hidden evaluation labels and credentials out of input. For `family`, first verify the causal mechanism; similarity alone never establishes a defect.

One automatic call per invocation is the default. At most one additional call is allowed for a newly discovered, specific high-risk uncertainty; explain that uncertainty before calling. Do not retry at the skill layer. One tool call can contain multiple provider evaluations and retries, so tool-call count alone is not a cost measurement.

Inspect status, omissions, freshness and provenance. Verify every material reference against current source or its authoritative record before using it. Preserve contrary evidence and distinguish caller-supplied excerpts from source-verified material.

Disabled, absent, busy, unavailable, empty, insufficient, cancelled or partial navigation continues through ordinary graph/search/source tools. Navigation never proves completeness or replaces a required consumer/family sweep. Do not reduce required review breadth, approve work, file or close findings, amend an approved plan, or expand scope because of a ranking.

When material, report the verified addition, rejected lead or remaining gap in the existing artifact/report. Carry source-backed constraints and verification requirements into the plan; execution remains governed by that approved plan. Do not claim reliability or token savings without complete-workflow measurements.
<!-- mai:shared:navigation-preflight end -->

Navigation intent: choose decisions, layout or impact for the single unresolved question about existing constraints or affected consumers. Use the result before settling consequential design choices.

## Step 2: Settle consequential choices

1. For each real tradeoff, describe viable options against the actual requirements: behavior, compatibility, complexity and failure consequences where relevant. Give a recommendation with its rationale.
2. Resolve what existing instructions, evidence and authorization already settle. Ask about the remaining choices that materially affect scope, behavior or interfaces; do not ask the user to repeat an answer already given.
3. Continue independent source inspection or spec sections while answers are pending. Record each settled choice and its basis; keep unanswered choices named rather than filling them with assumptions.

## Step 3: Write the spec

Write a reviewable artifact at the project's established spec location, or return the full spec when no writable location is available. Include these named sections:

- `Scope` and `Non-goals`.
- `Requirements and constraints`, with assumptions labeled.
- `Behavior`, including relevant user-visible states and transitions.
- `Interfaces and data`, including affected contracts and compatibility.
- `Failure cases` and expected recovery behavior.
- `Verification criteria`: observable outcomes that would establish each requirement.
- `Settled choices`: rationale and evidence or user direction.
- `Open blockers`: the unresolved choice, consequence and information needed to settle it.

Use source anchors for claims about existing behavior. Keep proposed behavior distinguishable from what already ships.

## Step 4: Check readiness and hand off

1. Compare the spec with the request and source. If a consequential requirement, interface or failure behavior remains unresolved, report `BLOCKED` with its named blockers; do not claim ready for planning.
2. Otherwise report `SETTLED` and hand the spec to `write-plan` when planning is in scope. A settled design is input to planning, not an approved implementation plan.
3. If project instructions call for durable capture, search first and record only new decisions or lessons with source/user provenance. Report unavailable persistence and retain the text in the artifact.

## Output

Return `status` (`SETTLED` or `BLOCKED`), `spec path/content`, `settled choices`, `open blockers`, `source anchors`, `evidence/capability limits`, and `next action`. Include any `durable record IDs` or explicitly unpersisted decision text. Only a settled spec receives a ready-for-planning handoff.
