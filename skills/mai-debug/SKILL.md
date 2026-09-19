---
name: mai-debug
description: Systematically investigate bugs, failing tests, build or integration failures, performance regressions, and unexpected behaviour before proposing fixes. Use for "debug", "why is this failing", "this is broken", or repeated unsuccessful fixes. Combines prior lessons with current evidence to prove the cause and verify the repair; supports diagnosis-only requests.
---

<!-- SPDX-License-Identifier: MIT — Copyright © 2026 Maikai Group Inc.
     Part of mai-mcp (MIT — the whole project; see LICENSE). Copy freely. -->

# Debug

Find the cause from current evidence, prove any repair, and preserve what makes the next investigation cheaper. Ask the brain for prior lessons first; a familiar symptom is a lead, not a diagnosis.

---

## Invocation

**Announce at start:** "I'm using the mai-debug skill — checking what the brain already knows about this symptom before forming a hypothesis."

---

## When to use

Use on any bug, test failure, or behaviour you cannot explain — **before** proposing a fix.

Use it especially when you notice yourself retrying variations of the same approach, a quick workaround seems obvious, or an intermittent failure disappears on rerun. Do NOT use it to review working code (`mai-code-review`) or to design a new feature.

**Respect the requested outcome.** A diagnosis request ends with the cause, evidence, and proposed repair; it does not authorize implementation. A request to fix the issue includes the bounded repair and verification. Production reproduction, destructive probes, dependency installation, and architectural redesign need their own task authority.

---

## Non-negotiable rules

1. **Ask the brain before forming a hypothesis.** Verify recalled causes against the current failing path; never bypass investigation because a lesson sounds familiar. If recall is unavailable, use the declared fallback.
2. **Establish the failing baseline before repairing.** Reproduce when safe, preserving the command, input, and environment before changing them. If safe reproduction is unavailable, current traces and source may still support an authorized repair; state that evidence and the reproduction limit, and label the repair unverified until the relevant checks run. An unconfirmed cause is not grounds for a repair.
3. **One hypothesis at a time, and write it down before testing it.** State the predicted observation and the observation that would refute it. Change one relevant variable per experiment.
4. **Prove any claim of a verified repair.** Use a controlled failing/passing comparison in a safe test environment; a green run alone is insufficient. If that comparison cannot run, report the verification gap. Do not reintroduce a defect in production or revert unrelated user changes to prove a point.
5. **Circling means change the investigation.** After three unsuccessful experiments without narrowing the cause, stop varying fixes. Reassess evidence, instrumentation, and assumptions. A fourth needs a new discriminating observation; a count alone does not prove the architecture is wrong. If no useful next experiment is available, report what is missing and go to Phase 6.
6. **Finish by preserving the lesson.** Record it in the brain when authorized and available. If the user prohibits persistence or the lesson cannot be stored without disclosing protected information, keep a suitably redacted lesson in the report and explain why it was not persisted.

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
| `mai_search` / `mai_findings` | mai-mcp recall over lessons and past findings | The brain-first phase is unavailable | Start at Phase 2 and say the recall step did not run |
| `mai_git_context` / `mai_git_show` | mai-mcp git evidence — when a behaviour changed and which decision carried it | Change history must be reconstructed by hand | Use the harness's git access directly |
| `mai_graph_impact` / `mai_graph_trace` | mai-mcp code graph — candidate blast radius | Scope must be derived by search alone | Search mechanically; the graph only ever proposed candidates |
| `mai_lesson_add` | mai-mcp durable rule capture | The lesson cannot be recorded | Report the lesson in your output and say it was not persisted |
| `mai-code-review` | Ships in this suite. Reviews working code — the boundary this skill states in When to use | The artifact boundary is unstated | Say whether you are debugging a failure or reviewing a change before you start |

---

## Phase 1: Ask the brain

Before any theory:

1. `mai_search` the **symptom** in the words the system produced — the error text, the failing assertion, the observed behaviour.
2. `mai_findings` with `similar_to` set to the same, for defects found in past reviews.
3. Read what comes back properly. A prior lesson often names a cause that has nothing to do with where the symptom appears — one recorded here describes a full disk presenting as three unrelated failures in three different subsystems.

**Recall responses are budgeted.** A broad search returns headlines plus a recovery pointer, not the full text. If the pointer says results were omitted, narrow the query or fetch the specific entry by id before concluding anything. "The brain has nothing on this" is a claim about a *complete* read; a truncated one cannot support it, and here it sends you to Phase 2 cold when the answer was already recorded.

If the brain has it, you have a **candidate cause, not a verified one**. Reproduce in Phase 2, check the relevant current path in Phase 3, and test the candidate in Phase 4. Reproducing the same error does not establish the same cause. Reuse existing evidence when it matches the current revision and conditions; keep these phases brief when the evidence is decisive.

## Phase 2: Reproduce

Read the complete error and relevant stack trace. Separate the first failing boundary from downstream errors. Record expected versus actual behaviour, the exact command or request, input, revision/build, and relevant environment differences. Reproduce in the smallest authorized environment that still exercises the failure; do not reset caches, reinstall dependencies, or change configuration before preserving the baseline.

For intermittent failures, record attempts and failures and vary suspected timing, ordering, or load deliberately. A passing rerun is an observation, not a fix. Prefer a controlled schedule, seed, or fault injection over arbitrary sleeps or retries; retain real timing when timing itself is the contract.

If you cannot reproduce it, use available traces and environment comparisons to identify the next discriminating observation. If those establish a cause, explain the evidence and the reproduction limit separately. Otherwise report the cause as unconfirmed, with what you tried and the next check — then go to **Phase 6 anyway**. Absence of a local failure does not prove the reported failure is absent.

## Phase 3: Locate the failing boundary

- **When did this change?** Use the git evidence tools to find the commits that touched the failing path, and the decisions attached to them. "It worked last week" is a searchable claim.
- **What else does this touch?** Ask the graph for the blast radius, then verify mechanically — the graph proposes candidates and can be stale; the source decides.

**Compare working and failing cases.** Find a nearby working path, input, environment, or known-good revision. Check the relevant implementation and contracts, then list differences in data, configuration, dependencies, state, and execution order. A difference becomes a candidate only when it explains the observation; unfamiliar code is not evidence of a defect.

**Trace the bad value or missing event backward.** Starting at the failure, follow callers and transformations to the earliest violated contract. For multiple components, inspect inputs, outputs, and configuration propagation at the suspected boundaries until you locate the last correct state and first incorrect state. Distinguish a missing value from a malformed or stale value.

When existing evidence cannot distinguish boundaries, add the smallest authorized diagnostic probe and run it before proposing a repair. Capture correlation, types, presence, and relevant state; redact secrets and personal data. Never dump credentials or the entire environment. Remove temporary instrumentation after the investigation unless retaining it is part of the authorized repair.

## Phase 4: One hypothesis at a time

For each hypothesis, write a short record: **cause → supporting evidence → prediction → refuting observation → smallest experiment → result**. Choose an experiment that distinguishes plausible causes, not one that merely makes the error disappear. For example, increasing a timeout can hide both slow work and a missing completion signal; observe whether and when the signal occurs first.

Change one relevant variable and preserve other conditions. Classify the result as supported, refuted, or inconclusive. If the probe never exercised the failing path or changed several relevant conditions, it did not test the claim. Remove unsuccessful experimental edits before the next test without discarding user changes.

**Count experiments that add no information.** Apply rule 5 when three fail to narrow the cause. If evidence instead points to shared state, coupling, or an incompatible contract, explain that architectural possibility and the scope it would require; do not launch a redesign as another fix attempt.

**Diagnosis-only exit:** report the causal evidence, remaining uncertainty, and smallest proposed repair, then go to Phase 6 without implementing it. If the cause is unconfirmed, do not advance to repair. Any separately authorized containment (such as a rollback or bounded retry) must be labelled mitigation, with evidence and limits; it is not proof of a cause.

## Phase 5: Fix and prove it

Enter only when repair is authorized and Phase 4 supports the cause.

1. **Capture a failing check before the repair.** Use the project's existing test runner and fixtures for a focused behavioural regression, or a repeatable minimal probe if no suitable runner exists. Confirm it fails for the reported defect, not setup, syntax, or missing dependencies. If no check can safely run, proceed only under rule 2's evidence-supported exception: state the baseline evidence, the missing check, and the repair's unverified status.
2. **Make the smallest complete repair at the responsible boundary.** Preserve valid behaviour and the intended contract. Avoid bundled refactors, speculative guards at every layer, or retries that conceal a deterministic defect. For an async readiness problem, await the actual completion condition with a bounded timeout; a longer sleep is not causal evidence.
3. **Show the check distinguishes broken from repaired behaviour.** Run the same check under matching conditions before and after the repair. Existing pre-fix failure evidence is sufficient; otherwise compare in an isolated fixture or temporarily remove only your repair in a safe test environment. A test that passes both with and without the fix does not demonstrate this repair, even if it provides other useful coverage.
4. **Check affected neighbours.** Run the relevant caller, error-path, and integration checks identified in Phase 3, plus required project gates. For intermittent issues, use the controlled reproducer where possible; report attempts/failures and residual uncertainty rather than treating one green rerun as proof. Separate unrelated pre-existing failures from repair regressions with evidence.

If the repair fails, return to Phase 3 or 4 with the observation; do not stack another untested fix on top. Remove task-owned diagnostic changes and scratch artifacts, preserving the regression check and necessary evidence.

## Phase 6: Record the lesson

Write the durable rule with `mai_lesson_add` — search first, then cite. What makes a lesson worth recording is that it would have saved *this* session: the surprising cause, the misleading symptom, the check that would have found it in one step. Extend a matching lesson instead of creating a duplicate. Separate observations from hypotheses; an unconfirmed cause stays unconfirmed in memory. Include the conditions under which the lesson applies, especially when the same symptom has multiple causes.

**Every debugging run reaches this phase — completed or abandoned.** A run that found and fixed the cause records the cause. A run that could not reproduce the failure (Phase 2) records what varied and the check that would settle it. A run stopped for circling (rule 5) records what was ruled out and why the approach was wrong. End with either a recorded lesson or an explicit reason it was not persisted, including the authority and privacy limits in rule 6; "it was trivial", "I did not finish", and "I got stuck" are not skip reasons.

A trivial or local cause gets the smallest reusable prevention/check that would have shortened this run; it is not a skip path. If `mai_lesson_add` is unavailable, preserve the exact lesson text and report the persistence failure through the Dependencies fallback so it can be written when the brain returns.

---

## Output

Report concisely: the observed symptom and requested scope; whether recall supplied a useful lead; the cause and its discriminating evidence (or what remains unconfirmed); the proposed or implemented repair; checks run and their outcomes, including verification gaps; and the lesson id or reason for non-persistence. Distinguish a mitigation from a repair and a diagnosis from an implemented fix. If the brain was unavailable, report the exact safe-to-share lesson text and persistence failure. Include the cleanup result required above.
