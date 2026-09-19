---
name: subagent-rules
description: Mandatory rules for every subagent implementation prompt. A narrow claim-only preflight may precede implementation solely to prime the child, read project instructions, claim its lane and pause; the resumed implementation prompt still begins with this payload verbatim. Injects discipline so implementers follow the plan exactly and do not go off-script. Triggers on any subagent implementation dispatch.
---

<!-- SPDX-License-Identifier: MIT — Copyright © 2026 Maikai Group Inc.
     Part of mai-mcp (MIT — the whole project; see LICENSE). Copy freely. -->

# Subagent Dispatch Rules

Subagents go off-script. They skip the project's instructions file, add features nobody asked for, use wrong patterns, and report "done" when they're not. This skill exists to prevent that.

---

## Invocation

**Internal — does not announce.** This skill's content is injected into another
agent's prompt; an announcement here would come from the wrong actor. The
dispatching skill announces, not this one.

---

## When to use

**Use this skill for every subagent implementation prompt.** The only exception is a claim-only preflight that contains no implementation task and permits exactly: `mai_prime` first, read project instructions, `mai_claim` before any task-file access, return the claim id, and pause. The resumed implementation continuation has no exception: this payload is first and verbatim.

### The Problem

Subagents fail in predictable ways:
- They don't read the project's instructions file — they jump straight into the task and miss project rules
- They add "helpful" extras not in the plan (scope creep)
- They use `any` types, hardcoded values, wrong patterns
- They switch approaches mid-task when they hit friction
- They report "done" without running verification
- They read random files looking for context instead of reading the project docs first

### What NOT To Do

- Do not send an implementation task or permit task-file access without the rules block first. The claim-only preflight exception may prime, read project instructions, claim and pause — nothing else.
- Do not dispatch subagents for security-sensitive code (encryption, auth, access control) — do that yourself
- Do not dispatch more than 3-4 subagents in parallel — you can't verify that many at once
- Do not mark a task complete because the subagent said it's complete — verify first
- Do not let subagent failures slide because "it's close enough" — fix it or redo it

---

## Non-negotiable rules

### What To Do: Inject Rules Into Every Subagent Prompt

When writing or resuming the **implementation** prompt, you MUST include the following block at the top, before the task. Copy it verbatim — do not paraphrase, summarize, or "adapt" it. A prior claim-only preflight is allowed only under the exact prime → instructions → claim → pause boundary above; it never carries implementation work.

```
## SUBAGENT RULES — READ BEFORE DOING ANYTHING

1. **Read the project's instructions file first.** Before touching any code, read the project instructions file (`CLAUDE.md`, `AGENTS.md`, or your harness's equivalent) in the project root. It contains project rules, patterns, build commands, and constraints you WILL violate if you skip it. This is not optional.

2. **Follow the plan exactly.** You have been given a specific task from an approved plan. Do exactly what it says. Do not add features, refactor surrounding code, add "helpful" comments, improve error handling beyond what's specified, or make any change not explicitly in your task.

3. **Do not switch approaches.** If the plan says to use a specific pattern, component, library, or architecture — use it. If you hit friction, work through it. Do not decide a different approach is "better" and switch mid-task.

4. **No type-safety bypasses.** No `any` (TypeScript), no `object` as catch-all, no `# type: ignore` (Python), no equivalent. If you don't know the type, write `// TODO: NEEDS DECISION — type for [X]` and use the most specific type you can infer.

5. **No hardcoded values.** Use the project's design system, theme tokens, CSS variables, or constants. If you don't know what they are, read the project's instructions file — it tells you.

6. **When stuck, mark it and move on.** If the plan didn't cover something, write `// TODO: NEEDS DECISION — [exact question]` at that location. Do NOT improvise a solution.

7. **Verify before reporting done.** Run the build command. Run the test command. Check that your code compiles and passes. If you can't run them, say so — don't claim success without evidence.

8. **Report what you actually did.** When done, list:
   - Files created or modified (with paths)
   - Any deviations from the plan (there should be none)
   - Any TODO: NEEDS DECISION items you left
   - Whether build/tests pass

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
```

### Prompt Template

Use this structure when dispatching subagents:

```
[SUBAGENT RULES block from above — copy verbatim]

## Your Task

**Plan:** [filename or reference]
**Task:** [task number and title from the plan]
**What to do:** [specific description of what this task produces]

**Files to create:**
- [list exact file paths]

**Files to modify:**
- [list exact file paths]

**Key constraints:**
- [any task-specific rules from the plan]

**Your LAST action before returning:** release the lane you claimed in the
preflight — `mai_claim {release: "<the claim id you reported>"}` — and report
that id as released. A claim binds to the session that made it, so nobody else
can release it for you; skip this and the lane sits warning every other agent
until it expires.

Before that release, finish owned temporary-artifact cleanup and report exact
removed paths. Hand any still-needed supplied environment back to its named
owner with a reason and next cleanup action; preserve deliverables first.

**When done, report:**
- Files created/modified
- Build/test status
- Any NEEDS DECISION items
- The claim id you released
- Verified temporary-path cleanup and any accepted ownership handoff
```

---

## Dependencies

| Dependency | What it is | Without it | Harness-native fallback |
|---|---|---|---|
| `plan-execute` | Ships in this suite. The executor that routes implementation batches through the internal dispatcher | Automatic integration from that executor is unavailable | Inject this block manually at the top of any harness-native implementation prompt |
| `mai-subagent-execute` | Ships in this suite. Owns the prime → claim → verified implementation continuation boundary | The claim-only exception has no constrained owner | Do not use the exception; put this payload first in the one implementation prompt |
| `superpowers:subagent-driven-development` | Optional external. One dispatch workflow this block is injected into | That packaged dispatch workflow is unavailable | Inject the block into whatever dispatch mechanism the harness provides |
| `superpowers:dispatching-parallel-agents` | Optional external. Another such workflow | That packaged parallel workflow is unavailable | Inject the block into every prompt of a harness-native parallel dispatch |

### Integration With Other Skills

This skill is invoked by:
- **`plan-execute`** — routes parallel batches through `mai-subagent-execute`, whose claim-only preflight carries no task and whose verified implementation continuation begins with this payload
- **`superpowers:subagent-driven-development`** — use subagent-rules to inject the rules block into the implementer prompt template
- **`superpowers:dispatching-parallel-agents`** — same: inject rules block into every parallel agent prompt

When using `superpowers:subagent-driven-development`, prepend the SUBAGENT RULES block to the implementer prompt (before the task-specific content). The spec reviewer and code quality reviewer subagents don't need the rules block — they're reviewers, not implementers.

---

## Output

### Verification After Subagent Returns

**Do not trust subagent output.** After every subagent completes:

1. **Read every file it created or modified** — don't take its word for it
2. **Check for plan fidelity** — did it do what was asked, nothing more, nothing less?
3. **Grep for `any`** — subagents love to sneak in type bypasses
4. **Grep for hardcoded hex values** — `#fff`, `#000`, `#1a1a1a` etc.
5. **Check imports** — are they using the right paths and named exports?
6. **Run the build/test commands** — if the subagent said "tests pass," verify it
7. **Check for scope creep** — extra files, extra functions, extra error handling, extra comments

If ANY of these checks fail, fix the issues before moving to the next task. Do not accumulate broken subagent output across tasks.

### Common Subagent Failures (Watch For These)

| Failure | How to catch it |
|---------|----------------|
| Skipped the project's instructions file | Wrong patterns, wrong file paths, wrong conventions |
| Added extras not in plan | Diff against plan — any unexplained additions |
| Used `any` type | `grep -r "any" --include="*.ts" --include="*.tsx"` on touched files |
| Hardcoded colors | `grep -r "#[0-9a-fA-F]" --include="*.ts" --include="*.tsx" --include="*.css"` |
| Wrong import paths | Files fail to compile |
| Didn't run tests | Ask for command output — if they can't show it, they didn't run it |
| "Done" but incomplete | Compare file list against plan's task scope |
| Switched approaches | Architecture doesn't match plan |
| Added comments everywhere | Diff shows docstrings/comments not in plan |
