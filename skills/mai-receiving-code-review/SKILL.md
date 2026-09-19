---
name: mai-receiving-code-review
description: Act on code review findings without blindly accepting them or performatively agreeing. Use when code findings have been filed and need to be verified, repaired and closed. Verifies each premise from source, sweeps the codebase for the defect's shape, repairs, re-runs the gates, and closes findings by UUID and project. Do not use for plan review findings — that is a different skill for a different artifact.
---

<!-- SPDX-License-Identifier: MIT — Copyright © 2026 Maikai Group Inc.
     Part of mai-mcp (MIT — the whole project; see LICENSE). Copy freely. -->

# Receiving Code Review

Findings are evidence to verify, not instructions to obey. Repair what is real, dispute what is not, and close each finding with the truth of what happened.

---

## Invocation

**Announce at start:** "I'm using the mai-receiving-code-review skill to verify, repair and close the open code findings."

---

## When to use

Use when code findings exist and need acting on — after `mai-code-review` files them, or when `mai_findings` shows open code findings on work you own.

Do NOT use it for plan-review findings; that is `receiving-plan-review`, whose four plan-document phases do not apply here. Do NOT use it to *produce* findings; that is `mai-code-review`.

---

## Non-negotiable rules

1. **Never close a finding because the code changed.** Reproduce or falsify its premise, repair, verify, then close.
2. **Never accept risk on someone else's behalf.** `accepted-risk` requires an explicit human decision. A disproven finding is `disputed`, with the evidence that disproves it.
3. **Never weaken a test or a gate to make it pass.** Preserve the failing discriminator; repair the behaviour.
4. **Apply the fix completely or dispute it.** Silent partial application is the failure mode; an upheld dispute is healthy.
5. **Close by UUID and project.** Labels collide; UUIDs do not.

<!-- mai:shared:epistemics start — synced from skill-blocks/epistemics.md.
     Do NOT hand-edit inside this block; the sync rewrites it wholesale and the
     edit disappears silently (lesson 420dbda2). -->
### Receiving a finding

**Verify the premise before acting on it.** Current source and governing requirements decide whether the finding is real. A persuasive review is evidence to evaluate, not authority to change the design.

Authority order: explicit current user decision; approved governing spec/recorded decision; actual code/schema/tool interfaces; plan prose; reviewer suggestion. Surface consequential conflicts.

### Repair the defect family

Search for the relevant defect shape and inspect matching sites, including its producer or generator. A targeted mechanical search across an artifact is not a mandate to reread the whole artifact. Record the search and affected sites in the existing finding note; merge duplicate repair work while preserving finding UUIDs.

Check the changed end state and affected contracts. Re-read all citations belonging to the finding. Check heading ownership, counts or ordering only if the repair affects them. Cosmetic wording corrections need a diff and consistency check; substantive changes need evidence proportional to their effects.

### Evidence and limits

Use existing trustworthy verification when command, relevant inputs, configuration/toolchain and environment match. Missing metadata invalidates only the affected check. Record what ran, what was reused, and what remains unknown in the existing closure note; no separate repair-shadow receipt is required.

For executable behavior, run the relevant regression when valid evidence is absent. Demonstrate red/green or mutation behavior when needed to establish that a discriminator catches the defect; do not require a new mutation exercise for every repair. Plan prose is normally checked by source/contract inspection, with focused scratch probes for consequential uncertainty. Full implementation verification belongs to execution.

When no executable gate covers a claim, state "Verified by source inspection" with the inspected boundary; never imply a test ran. A genuine approval-critical uncertainty remains open. Before a repair that requires a new product/policy decision, raise that decision; routine corrections within current authority proceed.
<!-- mai:shared:epistemics end -->

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
| `mai code-findings` CLI | Ships with mai-mcp. Reads and closes findings by UUID | Findings cannot be closed durably | Repair anyway and report each finding's disposition in the output |
| `mai_findings` | mai-mcp recall. Fetches open findings and finds recurrences of a shape | Open findings must be supplied by the caller | Work from the findings you were handed; say the recurrence check did not run |
| `mai-code-review` | Ships in this suite. Produces the findings this acts on | Nothing to receive | None needed |
| `receiving-plan-review` | Ships in this suite. The same discipline for plan documents — the boundary stated in When to use | The artifact boundary is unstated | Confirm you are holding code findings, not plan findings, before starting |
| `plan-review` | Ships in this suite. Produces the plan findings this skill deliberately does not handle | The boundary is unstated | As above |

---

## Phase 1: Build the ledger

1. Fetch the open code findings. Record each one's **UUID**, severity, location and stated premise. Recall is budgeted — a broad fetch returns headlines plus a recovery pointer, so read the pointer and fetch each finding by id before dispositioning it. Acting on a headline is acting on a summary of a premise you never read.
2. Do not begin editing until every finding has a disposition: `fix`, `dispute`, or `needs-human-decision`.
3. For each finding, verify the premise from the source it describes — not from the finding's own description of that source.
4. Read the coordination board and active claims, then claim the initially cited repair paths. Record the baseline `HEAD`, the complete tracked/untracked worktree inventory in scope, and a SHA-256 digest of every in-scope working file. Preserve unrelated changes. If another actor changes an in-scope byte or the scoped inventory before repair begins, stop and re-derive the ledger from the new state.

## Phase 2: Sweep the shape

For each confirmed finding, before repairing it: restate the defect as a **shape** and search the codebase for every other instance. Record a verdict per hit — same defect, or immune and why.

State the search you ran. A command with its output is a sweep; "I checked" is not. Sites the sweep finds that no reviewer cited join the ledger now, rather than becoming the next review's findings.

Extend the claim and pinned inventory to every repair site the sweep discovers before editing any of them.

## Phase 3: Repair

Make the smallest complete change that fixes the confirmed defect and every site the sweep found, using your harness's editing tool. Do not refactor surrounding code, and do not fix things nobody found — that is a new change needing its own review.

## Phase 4: Verify

Before verification, mint the **candidate closure pin**: final `HEAD`, sorted scoped path inventory, and SHA-256 digest of every scoped working file. Validate existing relevant verification against those bytes and their environment, then run only missing/invalidated checks. Test the original symptom. Mutation/revert proof is conditional on uncertainty about the discriminator; valid existing proof need not be repeated.

Record affected scope, final cited sites, proof and limits in the existing closure note. No separate repair-shadow receipt is required. Substantive repairs receive independent delta review before shipping; editorial corrections need only an equivalence check.

Immediately after the receipt and gates, recompute the candidate closure pin and require exact equality. Only that matching pre/post pin becomes the **verified closure pin**. Immediately before each durable close, recompute it again. If `HEAD`, the inventory, or any scoped digest changed at either boundary, do not close against mixed bytes; re-read the change, mint a new candidate pin, and re-run the affected receipt and gates before trying again.

## Phase 5: Close

Close each finding with the disposition and a note saying what actually happened.

Include the final closure pin in the note so the durable disposition identifies the exact code state it verified.

A close note quotes the same real source the finding did — backticks, quotes, `$(…)`. The `add` path solved that by never letting the payload be a shell word; the close path must not reopen it. Write the note to a private scratch file with your harness's editing tool, read it into a variable, and pass the variable **quoted** — a `"$VAR"` expansion is not re-parsed for substitution, so the note stays data:

```bash
RECEIPT_TMP=$(mktemp -d "${TMPDIR:-/tmp}/mai-receiving-code-review.XXXXXX")
trap 'rm -rf "$RECEIPT_TMP"' EXIT
NOTE_FILE="$RECEIPT_TMP/note.txt"
# Write the note to $NOTE_FILE with the harness's editing tool — never inline it.
NOTE=$(cat "$NOTE_FILE")
mai code-findings close <uuid> --status fixed --note "$NOTE" --project <slug>
```

**Do not** write `--note "…"` with the text inline, and do not build the command by string concatenation. One backtick in a note is enough to execute something. If your harness dispatches the command as an argument array rather than through a shell, pass the note as a single argument and no shell is involved at all — that is the safest form available.

`<slug>` is the project you are pinned to — take it from the project identity in your priming output, or ask the operator. Never guess it: the CLI never infers a project, and a wrong slug is a cross-project write that exits `4`.

Check the exit status: `0` ok, `2` validation, `3` the UUID exists nowhere, `4` it belongs to a different project, `5` database failure. `3` and `4` are different facts — a typo'd UUID versus a right UUID under the wrong slug — and neither is "closed". Report which one you got rather than treating any non-zero exit as done.

---

## Output

Report: each finding's UUID and disposition; what the shape sweep found; the repair evidence; the final closure pin; the gates you re-ran and their result; and anything left open, with the reason. A finding left `open` on purpose is a decision — name it as one.
