---
name: mai-docs-sync
description: Align affected documentation and examples with current source after a behavior change or within a named documentation scope. Respects generated-file ownership and verifies support claims. Does not document planned features as shipped or regenerate unrelated docs.
---

<!-- SPDX-License-Identifier: MIT — Copyright © 2026 Maikai Group Inc.
     Part of mai-mcp (MIT — the whole project; see LICENSE). Copy freely. -->

# Documentation Sync

Update authorized documentation to describe current behavior, with source evidence for commands, interfaces and support claims. Follow the owning generator where documentation is generated.

## Invocation

**Announce at start:** "I'm using the mai-docs-sync skill to align the affected documentation with current source."

## When to use

Use for a specific behavior change or a bounded documentation request, such as "Update the CLI examples after the export flag changed."

**Inputs:** `change_or_scope`, `project_root`, `documentation_paths` when known, and `target_revision_or_version` when relevant.

Do not use to implement missing behavior, advertise planned features, or rewrite an unrelated documentation set. An unresolved source/version question prevents the affected claim from being presented as verified.

## Non-negotiable rules

1. Read your harness's instructions file (`CLAUDE.md`, `AGENTS.md`, or equivalent). When the brain is available, prime and recall relevant decisions; report unavailable recall. Current source wins over stale graph or memory, and conflicts must be surfaced.
2. Change only affected, authorized documentation and examples. Preserve existing plan, review, claim and operator-task requirements; a documentation request does not authorize implementation or deployment.
3. Identify generator ownership before editing generated content. Change the owning input and use its generator; do not hand-edit outputs or regenerate unrelated documentation.
4. Keep support and version claims truthful. Distinguish implemented behavior, released availability and planned behavior using evidence for the requested version.
5. Verify commands safely. Use read-only commands or authorized disposable fixtures; an example does not authorize production mutations, installs or third-party messages.
6. Search before durable brain writes and cite the source evidence. Report unperformed checks and persistence failures explicitly.

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
| `mai_prime` / `mai_search` | Optional project state and decision recall | Prior rationale cannot be checked in the brain | Read project instructions and source; report recall unavailable |
| `mai_graph_find` / `mai_graph_neighbors` | Optional interface and consumer map | Graph navigation is unavailable | Search current source for public entrypoints and consumers, then trace them directly |
| Project documentation generator | Owner-defined transformation from source inputs to generated docs | Generated output cannot be refreshed | Leave generated output unchanged, identify its owning input and blocked regeneration |
| Project documentation checks | Existing link, example or consistency validators | Packaged validation is unavailable | Inspect targets and run safe examples directly; list checks that remain unrun |

## Step 1: Bind the documentation scope

Read project instructions, prime and recall when available. Identify the changed behavior or requested documentation paths and the revision/version being described. Locate the authoritative docs, mirrored examples, generated-file markers, generator inputs and ownership instructions. Resolve material scope ambiguity before dependent edits while continuing unaffected inspection.

## Step 2: Trace each claim to source

Use the graph for structure when available, check its freshness, and verify current source. Trace public commands through their parser and implementation, or interfaces through their declarations and consumers. Record source anchors for accepted arguments, defaults, outputs, failure cases and version restrictions relevant to the docs.

Create a bounded map: `claim`, `source_anchor`, `affected_doc`, `owner_or_generator`, `required_change`. Surface contradictions with recalled decisions. If behavior or release availability remains uncertain, mark that claim unresolved rather than inventing support.

## Step 3: Update the owning files

Apply the mapped changes to authorized prose and examples. For generated docs, edit the owning inputs and run the documented generator only when its output scope is authorized. If it cannot regenerate just the affected authorized set, report that limitation and leave the regeneration pending. Inspect resulting changes for unrelated output.

Keep examples consistent with real command names, interfaces and supported versions. Do not turn an implementation gap into a documentation promise.

## Step 4: Verify the changed documentation

Check relative links and anchors, referenced files, command syntax and agreement among affected examples. Use existing documentation checks when available. Execute examples only with safe inputs in the authorized environment; otherwise record what was inspected and what was not executed.

Compare the final documentation changes to the source map. Record commands, outcomes and evidence locations. Report generator failures, unresolved support claims and other validation gaps without implying a complete verification.

## Output

Return:

- `scope_and_version`: behavior, documentation scope and source revision/version.
- `changed_files`: each file, the claim corrected and its source anchor; include generator inputs and outputs.
- `validation`: checks and commands, outcomes and evidence locations.
- `gaps`: unrun checks, blocked regeneration, uncertain claims and the next action needed.

If no edit is needed, state that and cite the matching source/documentation evidence.
