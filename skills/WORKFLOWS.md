<!-- SPDX-License-Identifier: MIT — Copyright © 2026 Maikai Group Inc.
     Part of mai-mcp (MIT — the whole project; see LICENSE). Copy freely. -->

# mai workflows

The suite contains 21 skills. Choose the procedure that matches the work and the artifact you need; a small task does not require every workflow.

## Find the right entrypoint

| Stage | Skill | Use it for |
|---|---|---|
| Understand | [mai-explore](mai-explore/SKILL.md) | Trace an unfamiliar behavior through source, graph and consumers |
| Understand | [mai-research](mai-research/SKILL.md) | Resolve a technical unknown with project and primary-source evidence |
| Design | [mai-design](mai-design/SKILL.md) | Turn an unsettled request into a written spec with explicit choices |
| Design | [mai-test-design](mai-test-design/SKILL.md) | Map requirements to meaningful behavioral tests and real fixtures |
| Plan | [write-plan](write-plan/SKILL.md) | Turn a settled spec into executable tasks and verification |
| Plan | [plan-review](plan-review/SKILL.md) | Independently assess a plan or bounded substantive delta |
| Plan | [receiving-plan-review](receiving-plan-review/SKILL.md) | Verify findings and repair their affected plan contracts |
| Plan | [plan-review-cycle](plan-review-cycle/SKILL.md) | Coordinate a requested review/repair cycle proportionately |
| Execute | [plan-execute](plan-execute/SKILL.md) | Execute a reviewed plan, audit tasks and reconcile completion |
| Execute | [mai-subagent-execute](mai-subagent-execute/SKILL.md) | Internal dispatch for independent plan tasks; invoked by the executor |
| Execute | [subagent-rules](subagent-rules/SKILL.md) | Rules payload for implementation dispatch, not a standalone task runner |
| Execute | [plan-compliance](plan-compliance/SKILL.md) | Check task fidelity against the approved plan |
| Diagnose | [mai-debug](mai-debug/SKILL.md) | Investigate a failure using prior lessons and current evidence |
| Review | [mai-code-review](mai-code-review/SKILL.md) | Independently review a bounded diff and file durable findings |
| Review | [mai-specialist-review](mai-specialist-review/SKILL.md) | Apply only relevant domain review roles within that lifecycle |
| Review | [mai-receiving-code-review](mai-receiving-code-review/SKILL.md) | Verify, repair and close code findings with evidence |
| Verify | [mai-e2e](mai-e2e/SKILL.md) | Exercise named user journeys in an authorized test environment |
| Verify | [mai-verify](mai-verify/SKILL.md) | Reconcile required checks and report passed, failed and unrun evidence |
| Maintain | [mai-docs-sync](mai-docs-sync/SKILL.md) | Align affected docs/examples with implemented, versioned behavior |
| Maintain | [mai-skill-audit](mai-skill-audit/SKILL.md) | Assess scoped skills and propose evidence-backed improvements |
| Learn | [mai-learn-workflow](mai-learn-workflow/SKILL.md) | Turn reviewed lessons into a bounded amendment or workflow draft |

## Specialist roles

These are portable reference prompts bundled inside the specialist skill. They can run inline within an independent review or through a bounded delegated reviewer. They are not five additional native agent registrations; the installer retains its four pinned native plan reviewers.

| Role | Relevant changes |
|---|---|
| [Security](mai-specialist-review/references/security.md) | Authorization, trust boundaries, secrets and sensitive outputs |
| [Database](mai-specialist-review/references/database.md) | Schema, migrations, queries, transactions and persistence |
| [Reliability](mai-specialist-review/references/reliability.md) | Failure handling, cancellation, retries, cleanup and fallback |
| [Retrieval](mai-specialist-review/references/retrieval.md) | Ingestion, freshness, access filtering, ranking and citations |
| [Test adequacy](mai-specialist-review/references/tests.md) | Behavioral assertions, discriminators, fixtures and flakes |

An authored diff needs an independent reviewer. Standalone specialist review enters the existing review workflow once; roles already inside that review return candidates to its current owner. The owner reconciles and persists findings once, preserving UUIDs and the normal receiving workflow.

## Example handoffs

### A focused task

"Explain cancellation" → **explore** → source anchors, flow and unknowns.

"Verify this fix" → **verify** → relevant checks and evidence gaps. Use **debug** if a failure needs investigation, or **test design** if the regression discriminator is unclear. A simple edit does not become a full feature-planning exercise.

### A feature

"Add bulk exports" → **design** → settled spec → **write-plan** → **plan-review** → **plan-execute**.

Research or test design can resolve a specific unknown before the plan freezes. During execution, fidelity audits check the plan; independent code review at meaningful milestones checks correctness and relevant specialist risks. E2E exercises required journeys when applicable. Verification reconciles evidence; docs sync updates affected public instructions. Existing authorization, operator-task gates and review receipts continue to apply.

### Ongoing improvement

A **skill audit** produces proposals, not automatic edits. A **learn workflow** request starts with reviewed lessons, checks existing guidance, then produces the smallest supported amendment or inactive draft. Validation and review precede activation; already-granted target-specific authorization remains valid.

## Temporary artifacts

Every skill requires cleanup of its owned temporary artifacts before completion, including failed or cancelled runs. This includes copied dependencies, build output, caches and scratch worktrees under OS temp paths. Executors also reconcile child-agent cleanup and retain responsibility for checkouts supplied to reviewers. Preserve deliverables and compact evidence, verify removals, and report any retained path with its owner, reason and next action. A scheduled janitor does not replace this closeout.

The rule is embedded in every installed skill from `skill-blocks/cleanup.md`; maintain that source and run `npm run sync:skill-blocks`. The parity check rejects missing or drifted blocks, including new skill entrypoints.

## Installation and capabilities

From an installation that contains this suite:

```sh
mai skills status --target all
mai skills install --target all
```

For an existing managed installation, use `mai skills upgrade --target all`. The installer preserves local drift unless explicitly overridden; inspect it rather than using `--force` by habit. Codex also accepts `--codex-scope repo|user|admin`; choose the intended scope. Run installation only when that target is authorized. Copying a skill tree includes its nested references.

Skills use harness-neutral actions. Brain recall, graph access, documentation retrieval, test runners and reviewer delegation depend on the actual environment. Each skill declares unavailable-capability behavior. Missing required evidence remains a gap, and an unrun required check cannot become PASS. A brain write is reported as persisted only after a successful receipt.

## Automatic selection

Skills are selected by the host using their descriptions and the project's task-to-skill guide. Connecting an MCP server alone does not install or force invocation of a skill. The versioned project instructions tell the agent to read the smallest applicable installed skill without waiting for its name. Explicit selection remains available when the host misses an implicit match.

Task-scoped `mai_prime` can append one advisory suggestion for common action phrases. Its conservative matcher does not understand every paraphrase; a missing hint is not a reason to skip an applicable skill. The hint may also be omitted to preserve prime's existing context budget. It does not establish availability, satisfy prerequisites, or authorize execution.

For Codex user installation in the selected profile:

```sh
mai skills install --target codex --codex-scope user
mai skills status --target codex --codex-scope user
```

The existing managed rules upgrade path distributes the v7 project guide. Existing running MCP processes need the updated build and a new process before they can emit the new suggestions. Check the host's skill catalog after installing; if it has not refreshed, restart that client. Selection evaluations and their limits are recorded in `docs/testing/workflow-selection.md` in the development repository.

## Inspiration and ownership

These are original mai workflows informed by [ECC](https://github.com/affaan-m/ECC), particularly its [agents](https://github.com/affaan-m/ECC/tree/main/agents) and [skills](https://github.com/affaan-m/ECC/tree/main/skills): planner/architect, code explorer, test analysis, E2E, security/database review, silent-failure review, retrieval review, documentation maintenance, skill stocktaking and verification.

The adaptation uses mai's existing graph, reviewed memory, plan lifecycle and durable findings. No ECC runtime, commercial service, fixed model preference, new memory store or paid dependency is required. This suite is MIT, like the rest of mai-mcp.
