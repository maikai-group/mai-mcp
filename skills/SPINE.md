<!-- SPDX-License-Identifier: MIT — Copyright © 2026 Maikai Group Inc.
     Part of mai-mcp (MIT — the whole project; see LICENSE). Copy freely. -->

# The skill spine

Every workflow skill in this suite has the same nine positions, in this order. The
authoritative machine-readable list is `REQUIRED_SECTIONS` in
`scripts/check-skills.mjs` — this file explains it; that file enforces it. If
they ever disagree, the script wins and this file is the bug.

| # | Section | Contract |
|---|---------|----------|
| 1 | frontmatter | `---` block with `name` and `description`. Codex will not discover a skill without both |
| 2 | SPDX header | The MIT comment. The whole project is MIT, so any file here can be copied anywhere |
| 3 | `# Title` + purpose | One paragraph: what this skill is for, in the first two sentences |
| 4 | `## Invocation` | Either the verbatim announcement, or an explicit statement that the skill is internal and does not announce |
| 5 | `## When to use` | Includes when NOT to use. A skill that never says when to stop gets invoked wrongly |
| 6 | `## Non-negotiable rules` | The absolutes, numbered. If a rule has an exception, the exception belongs in the rule |
| 7 | `## Dependencies` | Every external skill or tool: what it is, what happens without it, the harness-native fallback |
| 8 | Workflow | `## Step N` **or** `## Phase N`, consistently within this skill. Not present in the injected-payload exception below |
| 9 | `## Output` | What the skill hands back — report, verdict, or artifact |

**Injected-payload exception — decision `4c26ecfb`.** `subagent-rules` carries
positions 1–7 and `## Output` as the same portable shell, but no numbered
workflow position. Its middle is the literal block another actor copies into a
prompt; forcing Step/Phase headings onto that payload would change the artifact
instead of documenting a workflow. The gate requires this exact named exception
and forbids numbered workflow headings in it. It is not a general opt-out from
the other spine contracts.

Every non-`None` Dependencies body is an exact four-column table:
`Dependency | What it is | Without it | Harness-native fallback`. All four cells
are required for every referenced dependency; naming the dependency alone is not
a declaration.

## Step or Phase?

Both are correct; mixing them inside one skill is not.

- A **phase** is a workflow stage with internal operations — `plan-review` reads
  the plan, then cross-references, then audits.
- A **step** is an ordered action in a procedure — `plan-execute` does this, then
  this, then this.

For workflow skills, the gate detects which term a skill opens with and requires it throughout. It
does **not** require every workflow skill to choose the same one: uniformity should
protect contracts, not normalise harmless wording.

## Announcement is conditional

A user-invoked skill announces itself so the operator knows which discipline is
running. An **injected** skill — one whose content is pasted into another
agent's prompt, like `subagent-rules` — must not, because the announcement would
come from the wrong actor. Section 4 is always required; the announcement inside
it is not.

## Harness neutrality

Skills speak in **actions**, never tool names: "read the file", "search the
codebase", "edit the file". The instructions file is "your harness's
instructions file (`CLAUDE.md`, `AGENTS.md`, or equivalent)".

The verb is fine — "grep the codebase for the column" is an action. The tool
name presented as *the* tool is not: "Use Glob, Grep, and Read" and "Edit with
`apply_patch`" both name one harness's surface and fail the gate.
