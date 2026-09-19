---
name: mai-explore
description: Answer a bounded question about unfamiliar code by tracing current source, data flow and consumers, using graph and decision recall where available. Use for evidence-grounded exploration; do not make unrequested implementation changes.
---

<!-- SPDX-License-Identifier: MIT — Copyright © 2026 Maikai Group Inc.
     Part of mai-mcp (MIT — the whole project; see LICENSE). Copy freely. -->

# Explore

Explain how a bounded part of the codebase works, with source anchors and explicit evidence limits. Use the graph to locate candidates, then verify the explanation against current source.

## Invocation

**Announce at start:** "I'm using the mai-explore skill to trace the relevant code and separate verified behavior from remaining unknowns."

## When to use

Use for a focused question about unfamiliar structure, schema, behavior or affected consumers. Example: "How does an invitation token reach account creation, and which callers depend on its expiry behavior?"

Do not use as permission to implement, refactor, repair a defect or redesign the system. If the question expands beyond the requested boundary, identify the additional question before expanding scope.

**Inputs:** `question`, `repository/revision`, `scope`, and any known `entrypoint/symbol/behavior`. Narrow an unbounded request using the available context and the user's intended answer.

## Non-negotiable rules

1. Read project instructions and recall relevant decisions when the brain is available. Use the graph first for structure/schema; source wins over stale graph or memory.
2. Verify graph freshness and coverage against the source being explained. A graph edge is a candidate, and absence from an incomplete graph does not prove absence from the codebase.
3. Expand retrieval only to resolve a specific uncertainty. Do not impose arbitrary file/loop caps or invent relevance scores. Stop when the bounded question is answered or a named evidence gap prevents an answer.
4. Include relevant decisions and contrary evidence. Distinguish observed source behavior from inferred runtime behavior; surface conflicts rather than silently reconciling incompatible claims.
5. Make no unrequested implementation changes. Preserve plan approval, independent review, receipts, finding identities, lane claims and operator-task contracts when recommending next work.
6. Exploration implies no dependency installation, global profile changes, production mutation, deployment, third-party messages or activation. Search before any durable write and preserve its source provenance.

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
| `mai_prime` / `mai_search` | Optional project brain initialization and decision recall | Recorded rationale cannot be recalled through the brain | Report unavailable recall and inspect supplied decisions, project documentation and source |
| `mai_graph_find` / `mai_graph_neighbors` / `mai_graph_impact` / `mai_graph_trace` | Optional code/schema graph for locating structure and consumers | Graph discovery and freshness evidence are unavailable | Search symbols, imports, callers and schema definitions mechanically; report coverage limits |
| Source access | Current files and their revision or working-tree identity | Graph claims cannot be source-verified | Use supplied excerpts with their identity and report any unverified links or behavior |
| `mai_remember` / `mai_lesson_add` | Optional durable capture of new decisions or reusable discoveries | Findings cannot be persisted in the brain | Keep provenance and the proposed record in the report; state that it is unpersisted |

## Step 1: Frame the question and recall context

1. Read your harness's instructions file (`CLAUDE.md`, `AGENTS.md`, or equivalent). When available, prime and recall task-relevant decisions according to those instructions; report unavailable brain access.
2. State the precise question, relevant repository/revision and known scope. Identify what evidence would answer it and the current uncertainties.
3. Read relevant recalled rationale fully enough to assess applicability. Do not represent truncated or unavailable recall as a complete search.

## Step 2: Locate and verify structure

1. For structure or schema, query graph candidates first, including tables when relevant. Check graph freshness against the current revision and changed source; identify missing coverage.
2. Open the candidate definitions and callers. Confirm each connection needed by the explanation in current source.
3. Where the graph is unavailable, stale or thin, mechanically search the relevant symbols, routes, imports, queries and schema definitions. Record any mismatch between graph/memory and source, including evidence that contradicts the initial explanation.

## Step 3: Trace the bounded flow

1. Trace relevant entrypoints through control and data flow to outputs, storage or external boundaries. Follow callers and affected consumers far enough to answer the question.
2. Record source anchors for each material link, plus transformations, decisions and failure branches that affect the answer. Use tests as evidence of expected behavior without claiming they establish an unobserved runtime outcome.
3. For each additional retrieval, name the uncertainty it resolves. End retrieval when the question is supported or the remaining uncertainty needs unavailable source, an environment or user input. Do not broaden into unrelated subsystems merely because links exist.

## Step 4: Reconcile and report

1. Reconcile the source-backed flow with recorded decisions. Explain discrepancies, stale evidence and unverified assumptions; surface unresolved conflicts before proposing dependent work.
2. Identify affected surfaces and concrete next actions only where an unanswered question or the user's request calls for them. Keep implementation outside this exploration's scope.
3. If project instructions require a durable new discovery, search existing records first and capture it with source/revision evidence. State any persistence gap without claiming the record was written.

## Output

Return `question answered`, `repository/revision`, `source anchors`, `flow`, `affected surfaces/consumers`, `relevant decisions`, `contrary evidence`, `unknowns/evidence limits`, and `next actions`. Identify `graph freshness/coverage` and unavailable capabilities. Mark inferences and incomplete traces explicitly; include durable record IDs only when persistence succeeded.
