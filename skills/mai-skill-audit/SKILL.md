---
name: mai-skill-audit
description: Audit an explicit skill set or the current project's shipped suite for trigger clarity, dependency and reference closure, behavioral conflicts and useful scope. Produces evidence-backed keep, improve, merge or retire proposals without editing, deleting or activating skills.
---

<!-- SPDX-License-Identifier: MIT — Copyright © 2026 Maikai Group Inc.
     Part of mai-mcp (MIT — the whole project; see LICENSE). Copy freely. -->

# Skill Audit

Assess whether an authorized skill set activates for the right tasks and gives usable, consistent instructions. Produce bounded proposals tied to evidence rather than stylistic preferences.

## Invocation

**Announce at start:** "I'm using the mai-skill-audit skill to inspect the scoped skills and report evidence-backed proposals."

## When to use

Use for an explicit skill set or the current project's shipped suite, such as "Audit these two review skills for overlapping triggers."

**Inputs:** `skill_paths_or_suite`, `project_root`, and `audit_question` when one is specified. Default scope is the current project's declared shipped suite, not every installed profile.

Do not use to install, activate, rewrite or delete skills. Do not inspect unrelated profiles, introduce a memory store, or propose churn based only on wording preferences.

## Non-negotiable rules

1. Read your harness's instructions file (`CLAUDE.md`, `AGENTS.md`, or equivalent). Prime and recall relevant decisions when the brain is available; report unavailable recall. Verify remembered claims against current files and surface conflicts.
2. Inventory only authorized locations. Follow references only within that scope; report inaccessible or out-of-scope dependencies without expanding into other profiles.
3. Audit read-only. A keep/improve/merge/retire recommendation is not permission to edit, delete or activate anything.
4. Tie each concern to a trigger, dependency, reference, example or observable behavior. Intentional handoffs and complementary scopes are not defects merely because wording overlaps.
5. Keep proposed repairs bounded and preserve existing authorization, plan review, finding, lane-claim and operator-task contracts. Do not replace those contracts with audit advice.
6. Search before any durable brain write, preserve provenance, and report missing capabilities or unperformed checks. Do not add a second memory system.

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
| `mai_prime` / `mai_search` | Optional project state and prior workflow decisions | Brain rationale is unavailable | Read project instructions and the scoped skills; mark recall unperformed |
| Project suite checker | Existing structural, dependency and reference validation | Automated suite validation is unavailable | Inspect manifests, dependency rows and referenced paths manually; distinguish inspection from executed checks |
| Authorized skill files and references | Source of the audited instructions and examples | A missing file cannot be assessed | Report the missing or out-of-scope input and limit conclusions to accessible files |

## Step 1: Establish the inventory

Read project instructions, prime and recall when available. Resolve the supplied paths or the project's declared shipped inventory. Record `skill`, `path`, `purpose`, `trigger`, `exclusions`, and `supporting_files`. Ask only if the authorized location cannot be established; do not search other profiles to fill the gap.

Read entrypoints and the supporting references relevant to the audit question. Check frontmatter/manifests, named dependencies and expected installed resources against the actual files.

## Step 2: Check structural contracts

Inspect and run the existing suite checker when available and safe within the audit scope. Record command, exit status and evidence. Check missing reference targets, undeclared dependencies, unavailable-capability fallbacks, discovery metadata and examples that rely on absent resources.

If no checker exists, inspect these contracts directly. Do not install a checker or claim that manual inspection proves runtime behavior.

## Step 3: Assess activation and behavior

Compare realistic requests against descriptions, triggers and exclusions. For apparent overlap, identify which skill should own the artifact and whether the instructions establish an intentional handoff. Check for conflicting prerequisites, recursive routing, misleading activation, unsupported capability claims and instructions that exceed task authorization.

Trace examples through the actual procedure. Where useful and authorized, exercise a small representative request in a disposable fixture with no external effects. Label reasoning from instructions separately from observed behavior. A shared word or preferred writing style is not enough to justify a finding.

## Step 4: Form bounded proposals

Assign each skill a disposition: `keep`, `improve`, `merge` or `retire`. For any proposed change, name the concrete failure or redundancy, evidence location, affected request, priority, smallest proposed edit and validation that would prove the repair.

For a merge, name the retained entrypoint and behavior that must survive. For retirement, identify what owns the retired behavior or why it is no longer needed. Leave the files unchanged and separate a demonstrated defect from an uncertainty requiring further evidence.

## Output

Return:

- `scope_and_inventory`: authorized paths, audited skills and excluded or unavailable inputs.
- `checks`: commands, outcomes, evidence locations and behavioral limits.
- `proposals`: skill, disposition, priority, evidence, impact, bounded edit and validation.
- `unresolved`: missing evidence or capabilities and what would settle each question.

State that proposals have not been applied. A clean audit may keep every skill without inventing improvements.
