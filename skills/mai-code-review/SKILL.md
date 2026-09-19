---
name: mai-code-review
description: Review a diff against the codebase and file durable findings in the brain. Use after implementing a change, at a phase boundary, before a shipping commit, or when a diff touches sensitive ground. Recalls what past reviews found on similar code, derives the project's stack from the graph, and files BLOCKER/WARNING/NOTE findings with stable UUIDs. Triggers on "review this code", "review the diff", "review my changes", "code review".
---

<!-- SPDX-License-Identifier: MIT — Copyright © 2026 Maikai Group Inc.
     Part of mai-mcp (MIT — the whole project; see LICENSE). Copy freely. -->

# Code Review

Review a bounded diff against the codebase and leave findings that outlive the session. A review that only produces prose is forgotten by the next agent; a review that files findings is recalled by the debugging session that hits the same defect three months later.

---

## Invocation

**Announce at start:** "I'm using the mai-code-review skill to review this diff and file findings in the brain."

### Who runs the review

Independence is the point, not ceremony. Choose by what this session already knows:

- **This session wrote the diff → dispatch a subagent.** An author reviewing its own work is anchored; blindness has to be structural.
- **Otherwise — an independent session → review inline.** You are already blind to the authoring, and inline gives the review your full context at no dispatch cost.

When dispatching, the reviewer brief contains, in order: the exact review range and scoped path union; the project slug from the parent's priming output; the instruction to invoke this skill and follow it end to end including filing findings; and the reminder to preserve the reviewed checkout, index, HEAD and branch refs. Include any supplied worktree and its owner. Owned isolated worktrees for probes are allowed under rule 2; findings remain the review's durable output.

**Do not inject the suite's implementer-only rules payload into this reviewer.** That payload tells its recipient to follow an approved implementation plan and edit within a task. The reviewer preserves the review target; isolated probes do not authorize implementing repairs there. Its review-specific brief above supplies the discipline it needs.

**Never pass author session history to the reviewer.** An independent reviewer may retain its own source/review context for later deltas if it did not author the repair. Supply current pins and the actual diff; model rotation is optional.

---

## When to use

Use after implementing a change, at a phase boundary, before a commit that ships, or when a diff touches authentication, schema, money, or release paths.

Do NOT use it for a plan document — that is `plan-review`. Do NOT use it to *act on* findings — that is `mai-receiving-code-review`. Do NOT run it on every trivial task; it may dispatch a subagent and that cost should track blast radius.

---

## Non-negotiable rules

1. **The review is scoped before it starts.** State the range — `BASE_SHA..HEAD_SHA`, or the working diff — and the exact path union before reading anything. An unbounded review is an opinion. A working-diff scope includes tracked changes and scoped untracked files; "not in `git diff`" does not mean "not part of the change."

2. **Preserve the review target; isolate only what needs writes.** Inspect the existing checkout and reuse matching verification evidence first. Do not edit its files, stage changes, move its HEAD or change branch refs. When a probe needs writes, reuse an exclusively owned isolated worktree matching the reviewed revision, or create one with `git worktree add --detach <owned-path> <reviewed-sha>`. The associated worktree registration/removal is permitted within the task's filesystem permissions; it does not authorize changing other worktrees or refs. An archive is optional for checks that do not need Git history/index. A new worktree starts from committed bytes: for working-diff reviews, include and verify the scoped staged, unstaged and untracked inputs before using its results. Keep probe edits out of the review target.

   Keep linked worktrees outside auto-deleted scratch roots and record their owner. Reuse them across deltas after checking relevant inputs and resetting owned mutable fixtures; do not rebuild the application merely to review it. After probes stop, preserve useful evidence/changes and remove only disposable review-owned worktrees with `git worktree remove <owned-path>`. Do not force-remove unknown changes or delete a supplied implementation worktree. Temporary payloads/caches may use a separate owned scratch directory; ordinary recursive scratch cleanup is not worktree cleanup.

3. **The brain proposes; current source decides.** Recall supplies history and candidate scope. The diff, the schema, the migrations and the source are authoritative. A stale graph must never be able to silence a finding — where the graph is thin, fall back to mechanical search rather than reporting a clean review.

4. **Every finding names a location and carries evidence.** `file:line`, the issue, the evidence you gathered, and a fix. A finding a reader cannot verify is a rumour.

5. **Severity is BLOCKER, WARNING or NOTE.** No other vocabulary.

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
| `mai-specialist-review` | Ships in this suite. Selects relevant security, database, reliability, retrieval and test roles | Packaged specialist prompts are unavailable | Apply the relevant risk checks directly within this independent review; state expertise/evidence gaps |
| mai-mcp tool surface | `mai_findings`, `mai_graph_find`, `mai_git_context` — recall and stack derivation | Recall and graph-derived scope are unavailable | Review from the diff and source alone; say so in the output, because the recall half is missing |
| `mai code-findings` CLI | Ships with mai-mcp. Persists findings with stable UUIDs | Findings cannot be filed durably | Emit the findings in the output and say they were not persisted |
| `mai-receiving-code-review` | Ships in this suite. The counterpart that acts on what this files | Findings have no defined receipt discipline | Hand the findings to the author with the evidence intact |
| `plan-review` | Ships in this suite. Reviews plan documents — the boundary this skill states in When to use | The artifact boundary is unstated | Say which artifact you are reviewing before you start |

---

## Phase 1: Scope and recall

1. **State the range and path union.** `BASE_SHA..HEAD_SHA` for committed work, or "the working diff", plus the exact in-scope paths. Record both — every finding is relative to them.
2. **Build the complete inventory without staging.** For a working diff, union `git diff --name-only HEAD -- <paths>` (tracked staged and unstaged changes) with `git ls-files --others --exclude-standard -- <paths>` (untracked, non-ignored files), sort/deduplicate it, and compare it with the caller's declared path union. Read the tracked patch completely and read every untracked inventory file completely. A missing declared path is a scope failure, not an empty diff. For a committed range, inventory and read `git diff BASE_SHA..HEAD_SHA -- <paths>`.
3. **Ask the brain what has gone wrong here before.** Call `mai_findings` with `similar_to` set to the change's subject and the complete touched-path inventory. This returns findings from every past review in the project. Recurring defects are the highest-value thing a review can catch and they are invisible to a review that starts cold.

**Recall responses are budgeted.** A broad read comes back as headlines plus a recovery pointer, not the whole record. Read the pointer: if it says results were omitted, narrow the query or fetch the specific finding by its id. A truncated list read as the complete answer produces a review that reports "nothing recurring here" on a brain that said otherwise — worse than not asking.

## Phase 2: Derive the stack

Do not assume the languages or conventions. Ask, then verify:

- `mai_graph_find` for the tables, functions and routes the diff touches.
- The project's registered repos for which languages are actually present.
- Freshness-check what the graph returns. Where it is thin or stale, search mechanically instead — a graph miss is not evidence of absence.

Apply only the check families the project actually has. A TypeScript project gets the TypeScript families; a project with no SQL gets no SQL checks.

## Phase 3: Review

When a requested domain review or concrete changed boundary warrants it, use the applicable role
references from `mai-specialist-review`. If that skill initiated this review, consume the selected
roles here directly; do not re-enter its standalone route or start another review workflow.
Keep this review's scope and independence. Role workers return candidate findings to this owner;
reconcile duplicates and persist each finding once in Phase 4. Do not run every role by default.

For every changed file, against the families that apply:

- **Correctness** — does it do what the change intended? Are the edge cases the diff creates handled?
- **Type safety** — `any`, `as unknown as`, `@ts-ignore`, or the language's equivalent escape hatch. Each is a finding.
- **Data access** — do named tables and columns exist? Any `SELECT *`? Any unparameterised input? Are auth predicates present where the surrounding code has them?
- **Convention** — does it match the patterns already in this codebase, or invent a parallel one?
- **Tests** — does relevant evidence establish behavior and catch the defect? Inspect test adequacy. Reuse matching results; run focused regressions when evidence is missing or a concrete uncertainty remains. Cosmetic changes need no new test.
- **Blast radius** — what else calls this? Enumerate mechanically; a count produced by reading is a guess.

Do not repeat a completed fidelity audit or unchanged milestone review. Review substantive repairs independently as deltas, including affected contracts and regressions. Full builds/tests are owned by execution; use an isolated worktree or small scratch probe only when needed. A full-file read or full suite is not mandatory merely because a finding was repaired.

Classify blockers by demonstrated correctness, safety or requirement failures. Wording/style observations are nonblocking; severity does not widen scope. Record unresolved verification gaps and whether they prevent approval.

## Phase 4: File the findings

For each finding, file it through the CLI as a JSON document read from a private scratch file — never as shell-interpolated arguments, because finding text quotes real source, including quotes, backticks and `$(…)`. The CLI accepts the document on stdin or via `--file <path>`; this skill prescribes `--file`, because a file written by your harness's editing tool is never a shell word at any point.

Write the JSON with your harness's file-editing mechanism, never by interpolating its content into a shell word. The wire schema is exact, and its severity values are lowercase even though review output displays the vocabulary as uppercase:

```json
{
  "base_sha": "<full base revision, or current HEAD for a working diff>",
  "head_sha": "<full head revision, or working-tree>",
  "severity": "blocker",
  "title": "<short finding title>",
  "location": "<file:line>",
  "issue": "<what is wrong>",
  "evidence": "<what the current source and execution prove>",
  "fix": "<the complete repair>"
}
```

Allowed wire severities are exactly `blocker`, `warning`, and `note`; render them as BLOCKER, WARNING, and NOTE in the review report. Put each JSON document in a private unique directory and clean it on exit, so parallel reviews cannot collide on a shared `/tmp/finding-1.json`:

```bash
REVIEW_TMP=$(mktemp -d "${TMPDIR:-/tmp}/mai-code-review.XXXXXX")
trap 'rm -rf "$REVIEW_TMP"' EXIT
FINDING_FILE="$REVIEW_TMP/finding.json"
# Write the JSON object above to $FINDING_FILE with the harness's editing tool.
mai code-findings add --project <slug> --file "$FINDING_FILE"
```

**Where `<slug>` comes from.** The CLI requires an explicit project and never infers one. Take the slug from the project identity in your priming output; if you were dispatched without it, ask the operator. Never guess — a wrong slug is a cross-project write.

**Do not** build the JSON inline with `echo '{…}' | …`: the document is still a shell word there, and one backtick in an `evidence` field is enough to execute something. If your harness makes writing a temp file awkward, use a quoted heredoc (`<<'JSON'`), which the shell does not expand — but the file is the default.

**`head_sha` for a working-diff review.** The store requires both SHAs. For an uncommitted diff use the current `HEAD` as `base_sha` and the literal string `working-tree` as `head_sha`, so a finding filed against uncommitted work is distinguishable from one filed against a commit rather than silently attributed to `HEAD`.

Check the exit status. On the `add` path: `0` ok, `2` validation, `4` project mismatch, `5` database failure. (`3` is a lookup outcome and cannot occur here — there is no existing finding to miss.) A non-zero exit means the finding was **not** filed — say so rather than reporting it as recorded.

If a finding matches one the Phase 1 recall returned, say so explicitly: a recurrence is more important than a novel defect, because it means an earlier repair closed the instance and not the class.

---

## Output

Report, in this order:

1. **The range reviewed**, exactly as scoped.
2. **Counts by severity**, and the filed UUIDs.
3. **The single most important finding**, stated so someone can act on it without reading the rest.
4. **What you could not check** — the graph was stale, a suite could not run, a dependency was absent. A review that hides its gaps is worse than a short one.
5. **Verdict:** whether anything BLOCKER-severity stands between this diff and shipping.
