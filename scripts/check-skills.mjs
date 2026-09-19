#!/usr/bin/env node
// Plan 25 R8 plus post-Plan-27 workflow hardening: package gates and the
// review-cycle integrity gate over the shipped skill suite. Shared-block
// parity remains in sync-skill-blocks.mjs --check.
//
// Modes:
//   (none)          run every gate over skills/ ; exit 1 on any failure
//   --self-test     run the gates over built-in fixtures ; exit 0 when correct
//   --mutation-test inject known-bad fixtures ; exit 42 ONLY if all are rejected
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SKILLS_DIR = path.join(root, 'skills');

/** THE authoritative spine. skills/SPINE.md documents this; this list decides. */
export const REQUIRED_SECTIONS = [
  { key: 'invocation', heading: 'Invocation' },
  { key: 'when', heading: 'When to use' },
  { key: 'rules', heading: 'Non-negotiable rules' },
  { key: 'deps', heading: 'Dependencies' },
  // 8: the numbered workflow, checked separately (Step N | Phase N)
  { key: 'output', heading: 'Output' },
];

/** Injected payload: workflow exempt, but fenced payload text is policy-bearing. */
const PAYLOAD_SKILLS = new Set(['subagent-rules']);

/** Internal skills: invoked by another skill, never by a user, so they must NOT
 * announce — a second announcement for one piece of work comes from the wrong
 * actor. Distinct from PAYLOAD_SKILLS, which is about fenced text being shipped
 * policy: an internal skill still has a numbered workflow and it is still
 * checked. Membership is a claim the skill must back up in its Invocation. */
const INTERNAL_SKILLS = new Set(['mai-subagent-execute']);

// ---------- the tokenizer ----------

/**
 * Split markdown into fenced and unfenced regions. Structural gates read
 * unfenced prose. Policy gates additionally read fenced subagent-rules payload.
 * Tracks the marker so backticks cannot close a tilde fence or vice versa.
 */
export function tokenize(text) {
  const lines = text.split('\n');
  const unfenced = [];
  const fenced = [];
  const headings = [];
  let fence = null;
  lines.forEach((line, i) => {
    const open = line.match(/^\s*(`{3,}|~{3,})/);
    if (fence) {
      if (open && open[1][0] === fence[0] && open[1].length >= fence.length) {
        fence = null;
      } else {
        fenced.push({ n: i + 1, line });
      }
      return;
    }
    if (open) { fence = open[1]; return; }
    unfenced.push({ n: i + 1, line });
    const h = line.match(/^(#{1,6})\s+(.*?)\s*$/);
    if (h) headings.push({ n: i + 1, depth: h[1].length, text: h[2] });
  });
  return { unfenced, fenced, headings, raw: text };
}

export function frontmatter(text) {
  if (!text.startsWith('---\n')) return null;
  const end = text.indexOf('\n---\n', 4);
  if (end === -1) return null;
  const body = text.slice(4, end);
  const name = body.match(/^name:\s*(.+)$/m);
  const description = body.match(/^description:\s*(.+)$/m);
  return { name: name?.[1]?.trim(), description: description?.[1]?.trim() };
}

// ---------- the gates ----------

const problems = [];
const flag = (file, gate, msg) => problems.push(`${gate}: ${file}: ${msg}`);

const policyLines = (slug, tok) => PAYLOAD_SKILLS.has(slug)
  ? [...tok.unfenced, ...tok.fenced].sort((a, b) => a.n - b.n)
  : tok.unfenced;

const isTracked = (target, tracked) => {
  if (!tracked) return true;
  const abs = path.resolve(target);
  if (tracked.has(abs)) return true;
  const prefix = `${abs}${path.sep}`;
  return [...tracked].some((p) => p.startsWith(prefix));
};

const normalizeLabel = (label) => label.trim().replace(/\s+/g, ' ').toLowerCase();
const linkTarget = (raw) => {
  const first = raw.trim().match(/^<([^>]+)>|^(\S+)/);
  return (first?.[1] ?? first?.[2] ?? '').split('#')[0].trim();
};

/** G1 reference closure — inline and reference-style relative targets exist AND ship in git. */
export function gateReferenceClosure(file, dir, tok, tracked) {
  const check = (n, raw) => {
    const target = linkTarget(raw);
    if (!target || /^(https?:|mailto:)/.test(target)) return;
    const resolved = path.resolve(dir, target);
    if (!fs.existsSync(resolved)) {
      flag(file, 'reference-closure', `line ${n}: link target '${target}' does not exist`);
    } else if (!isTracked(resolved, tracked)) {
      flag(file, 'reference-closure', `line ${n}: link target '${target}' exists but is not git-tracked`);
    }
  };

  const definitions = new Map();
  for (const { n, line } of tok.unfenced) {
    const definition = line.match(/^\s*\[([^\]]+)\]:\s*(<[^>]+>|\S+)/);
    if (definition) {
      const label = normalizeLabel(definition[1]);
      if (definitions.has(label)) {
        flag(file, 'reference-closure', `line ${n}: duplicate reference definition '${label}'`);
      } else {
        definitions.set(label, { n, target: definition[2] });
      }
    }
  }
  // Checking every definition covers full [text][id], collapsed [id][], and
  // shortcut [id] references without mistaking ordinary bracketed prose for a link.
  for (const definition of definitions.values()) check(definition.n, definition.target);

  for (const { n, line } of tok.unfenced) {
    for (const m of line.matchAll(/\[[^\]]*\]\(([^)]+)\)/g)) check(n, m[1]);
    for (const m of line.matchAll(/\[([^\]]+)\]\[([^\]]*)\]/g)) {
      const label = normalizeLabel(m[2] || m[1]);
      const definition = definitions.get(label);
      if (!definition) {
        flag(file, 'reference-closure', `line ${n}: reference-style link '${label}' has no definition`);
      }
    }
  }
}

/** G3 frontmatter validity — Codex will not discover a skill without both. */
export function gateFrontmatter(file, text) {
  const fm = frontmatter(text);
  if (!fm) return flag(file, 'frontmatter', 'no frontmatter block');
  if (!fm.name) flag(file, 'frontmatter', 'frontmatter has no name');
  if (!fm.description) flag(file, 'frontmatter', 'frontmatter has no description');
}

/**
 * G4 harness lock-in. Keys on the tool NAME in an imperative construction, not
 * on the word. "Grep for the column" is a verb and passes; "Use Glob, Grep, and
 * Read" and "Edit with `apply_patch`" name one harness's surface and fail.
 */
// Tool spellings are case-sensitive identifiers. Actions are normalized, but
// `write-plan` must not become the Write tool and ordinary `task` must not become
// the Task tool merely because a broad /i word-boundary regex saw a hyphen/apostrophe.
const TOOL_NAME = '(?:Glob|Grep|Read|Write|Edit|Bash|Agent|apply_patch|exec_command|spawn_agent)';
const TOOL_END = '(?![A-Za-z0-9_-])';
const LOCKIN_PATTERNS = [
  new RegExp(`(?:^|[^A-Za-z0-9_-])(?:[Uu]se|[Uu]sing|[Rr]un|[Cc]all|[Ii]nvoke)\\s+(?:the\\s+)?${TOOL_NAME}(?:\\s+tool)?${TOOL_END}`),
  new RegExp(`\\b(?:[Ss]earch|[Rr]ead|[Ww]rite|[Ee]dit|[Oo]pen|[Ii]nspect|[Dd]ispatch|[Ss]pawn)[^.!?\\n]{0,60}\\b(?:with|via|using)\\s+(?:the\\s+)?${TOOL_NAME}(?:\\s+tool)?${TOOL_END}`),
  /\b(?:with|via|using|for)\s+(?:the\s+)?Agent\s+tool\b/,
  /\bthe\s+Agent\s+tool\b/,
  /\b(?:[Uu]se|[Rr]un|[Cc]all|[Ii]nvoke)\s+(?:the\s+)?Task\s+tool\b/,
];
export function gateHarnessLockIn(file, slug, tok) {
  for (const { n, line } of policyLines(slug, tok)) {
    let reason = null;
    for (const pattern of LOCKIN_PATTERNS) {
      if (pattern.test(line.replace(/`/g, ''))) { reason = 'names a harness tool as the mechanism'; break; }
    }
    if (!reason && /\bCLAUDE\.md\b/.test(line) && !/AGENTS\.md/.test(line) && !/equivalent/.test(line)) {
      reason = 'names CLAUDE.md without a harness-neutral alternative';
    }
    if (reason) flag(file, 'harness-lockin', `line ${n}: ${reason}`);
  }
}

const SUITE_DEPENDENCIES = [
  'write-plan', 'plan-review', 'receiving-plan-review', 'plan-execute',
  'subagent-rules', 'plan-compliance',
  // Plan 26. Without these the gate is blind to references to the new skills,
  // and any "reachable failure" claimed against them is unreachable.
  'mai-code-review', 'mai-receiving-code-review', 'mai-subagent-execute', 'mai-debug',
  // The orchestrator. Unregistered, G5 could not see receiving-plan-review's
  // reference to it and the undeclared dependency shipped green.
  'plan-review-cycle',
  'mai-design', 'mai-explore', 'mai-research', 'mai-test-design', 'mai-e2e',
  'mai-verify', 'mai-docs-sync', 'mai-skill-audit', 'mai-learn-workflow',
  'mai-specialist-review',
];
const meaningful = (cell) => cell.trim() !== '' && !/^(?:-|—|none|n\/a)$/i.test(cell.trim());

/** G5 dependency declaration — every reference needs a complete four-field row. */
export function gateDependencies(file, slug, tok) {
  const depsHeading = tok.headings.find((h) => h.depth === 2 && h.text === 'Dependencies');
  const depsEnd = depsHeading
    ? (tok.headings.find((h) => h.n > depsHeading.n && h.depth <= 2)?.n ?? Number.MAX_SAFE_INTEGER)
    : -1;
  const outsideDependencies = policyLines(slug, tok).filter(({ n }) =>
    !depsHeading || n <= depsHeading.n || n >= depsEnd);
  const referenced = new Set();
  for (const { line } of outsideDependencies) {
    for (const m of line.matchAll(/\bsuperpowers:([a-z-]+)/g)) referenced.add(`superpowers:${m[1]}`);
    if (/\bcontext7\b/.test(line)) referenced.add('context7');
    if (/(^|[^a-z-])code-review([^a-z-]|$)/.test(line)) referenced.add('code-review');
    for (const dep of SUITE_DEPENDENCIES) {
      if (dep !== slug && new RegExp(`(^|[^a-z-])${dep}([^a-z-]|$)`).test(line)) referenced.add(dep);
    }
  }
  if (referenced.size === 0) return;
  if (!depsHeading) {
    return flag(file, 'dependency-declaration', `references ${[...referenced].join(', ')} but has no Dependencies section`);
  }
  const rows = tok.unfenced
    .filter(({ n, line }) => n > depsHeading.n && n < depsEnd && /^\s*\|.*\|\s*$/.test(line))
    .map(({ line }) => line.trim().slice(1, -1).split('|').map((cell) => cell.trim()));
  const expectedHeader = ['Dependency', 'What it is', 'Without it', 'Harness-native fallback'];
  if (!rows.some((row) => row.length === 4 && row.every((cell, i) => cell === expectedHeader[i]))) {
    flag(file, 'dependency-declaration', `Dependencies table header must be: ${expectedHeader.join(' | ')}`);
  }
  for (const dep of referenced) {
    const row = rows.find((cells) => cells[0]?.replace(/`/g, '') === dep);
    if (!row) {
      flag(file, 'dependency-declaration', `references ${dep} but Dependencies does not declare it`);
      continue;
    }
    if (row.length !== 4) {
      flag(file, 'dependency-declaration', `${dep} row must have Dependency, What it is, Without it, and Harness-native fallback`);
      continue;
    }
    if (!meaningful(row[1])) flag(file, 'dependency-declaration', `${dep} has no What it is description`);
    if (!meaningful(row[2])) flag(file, 'dependency-declaration', `${dep} has no Without it behavior`);
    if (!meaningful(row[3])) flag(file, 'dependency-declaration', `${dep} has no harness-native fallback`);
  }
}

const sectionBody = (tok, heading, includeFenced = false) => {
  const start = tok.headings.find((h) => h.depth === 2 && h.text === heading);
  if (!start) return '';
  const end = tok.headings.find((h) => h.n > start.n && h.depth <= 2)?.n ?? Number.MAX_SAFE_INTEGER;
  const lines = includeFenced ? [...tok.unfenced, ...tok.fenced].sort((a, b) => a.n - b.n) : tok.unfenced;
  return lines.filter(({ n }) => n > start.n && n < end).map(({ line }) => line).join('\n').trim();
};

/** G6 spine conformance — shell contracts plus workflow positions, except decision 4c26ecfb. */
export function gateSpine(file, slug, text, tok) {
  const fmEnd = text.indexOf('\n---\n', 4);
  const spdx = [...text.matchAll(/<!-- SPDX-License-Identifier:/g)];
  const titles = tok.headings.filter((h) => h.depth === 1);
  const title = titles[0];
  const titleOffset = text.search(/^#\s+.+$/m);
  if (spdx.length !== 1) flag(file, 'spine', `expected exactly one SPDX header, found ${spdx.length}`);
  if (titles.length !== 1) flag(file, 'spine', `expected exactly one level-1 title, found ${titles.length}`);
  if (fmEnd !== -1 && spdx.length === 1 && spdx[0].index < fmEnd + 5) {
    flag(file, 'spine', 'SPDX header must follow the frontmatter');
  }
  if (spdx.length === 1 && titleOffset !== -1 && spdx[0].index > titleOffset) {
    flag(file, 'spine', 'SPDX header must precede the level-1 title');
  }
  const h2 = tok.headings.filter((h) => h.depth === 2);
  const workflow = h2.filter((h) => /^(Step|Phase)\s+\d+\b/.test(h.text));
  const allowed = new Set([...REQUIRED_SECTIONS.map((s) => s.heading), ...workflow.map((h) => h.text)]);
  for (const heading of h2) {
    if (!allowed.has(heading.text)) flag(file, 'spine', `unexpected top-level section '## ${heading.text}'`);
  }
  const positions = new Map();
  for (const { heading } of REQUIRED_SECTIONS) {
    const hits = h2.map((h, i) => ({ h, i })).filter(({ h }) => h.text === heading);
    if (hits.length === 0) flag(file, 'spine', `missing section '## ${heading}'`);
    if (hits.length > 1) flag(file, 'spine', `duplicate section '## ${heading}'`);
    if (hits.length === 1) positions.set(heading, hits[0].i);
  }
  const ordered = REQUIRED_SECTIONS.map((s) => positions.get(s.heading));
  if (ordered.every((i) => i !== undefined) && ordered.some((i, n) => n > 0 && i <= ordered[n - 1])) {
    flag(file, 'spine', 'required sections are out of order');
  }
  const invocation = h2.find((h) => h.text === 'Invocation');
  if (title && invocation) {
    const purpose = tok.unfenced.filter(({ n, line }) => n > title.n && n < invocation.n
      && line.trim() && !line.trim().startsWith('<!--') && !line.trim().startsWith('#')
      && !/^\s*(?:---+|\|.*\||[-*+]\s*$)/.test(line));
    if (purpose.length === 0) flag(file, 'spine', 'title has no purpose prose before Invocation');
  }
  const invocationBody = sectionBody(tok, 'Invocation').replace(/\s+/g, ' ');
  const whenBody = sectionBody(tok, 'When to use');
  const rulesBody = sectionBody(tok, 'Non-negotiable rules', PAYLOAD_SKILLS.has(slug));
  const depsBody = sectionBody(tok, 'Dependencies');
  const outputBody = sectionBody(tok, 'Output');
  if (PAYLOAD_SKILLS.has(slug)) {
    if (!/internal\b.*does not announce/i.test(invocationBody)) {
      flag(file, 'spine', 'payload Invocation must state that it is internal and does not announce');
    }
    if (workflow.length > 0) flag(file, 'spine', 'payload skill must not add a numbered workflow');
  } else if (INTERNAL_SKILLS.has(slug)) {
    // An internal skill must SAY it is internal. Silence is how a skill that
    // should announce quietly stops announcing.
    if (!/internal[^.\n]*does not announce/i.test(sectionBody(tok, 'Invocation'))) {
      flag(file, 'spine', 'internal Invocation must state that it is internal and does not announce');
    }
  } else if (!/(?:\*\*Announce at start:\*\*\s*["“]|(?:^|\n)["“](?:I'm using|Using)\b)/im.test(sectionBody(tok, 'Invocation'))) {
    flag(file, 'spine', 'Invocation has no Announce at start contract');
  }
  if (!/\b(?:do not|don't|not to|stop|never)\b/i.test(whenBody)) {
    flag(file, 'spine', 'When to use has no explicit stop/NOT-to-use boundary');
  }
  if (!/^\s*\d+\.\s+/m.test(rulesBody)) {
    flag(file, 'spine', 'Non-negotiable rules has no numbered absolute');
  }
  if (!depsBody) flag(file, 'spine', 'Dependencies has no contract body');
  if (!outputBody) flag(file, 'spine', 'Output has no handback contract');
  if (PAYLOAD_SKILLS.has(slug)) return;
  if (workflow.length === 0) {
    flag(file, 'spine', 'no level-2 numbered Step/Phase workflow section');
    return;
  }
  const terms = new Set(workflow.map((h) => h.text.match(/^(Step|Phase)\b/)[1]));
  if (terms.size > 1) {
    flag(file, 'spine', `mixes ${[...terms].join(' and ')} in one skill — pick one and use it throughout`);
  }
  const deps = positions.get('Dependencies');
  const output = positions.get('Output');
  if (deps !== undefined && output !== undefined) {
    const workflowIndexes = workflow.map((w) => h2.indexOf(w));
    if (workflowIndexes.some((i) => i <= deps || i >= output)) {
      flag(file, 'spine', 'numbered workflow must be after Dependencies and before Output');
    }
  }
}

/** G7 package validity — every skills/ subdir is a real, uniquely-named skill. */
export function gatePackageValidity(dir) {
  const seen = new Map();
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const skillFile = path.join(dir, entry.name, 'SKILL.md');
    if (!fs.existsSync(skillFile)) {
      flag(`skills/${entry.name}`, 'package-validity', 'directory under skills/ has no SKILL.md — it would install as a broken skill');
      continue;
    }
    const fm = frontmatter(fs.readFileSync(skillFile, 'utf8'));
    const name = fm?.name ?? entry.name;
    if (seen.has(name)) {
      flag(`skills/${entry.name}`, 'package-validity', `duplicate skill name '${name}' (also ${seen.get(name)}) — Codex does not merge duplicates`);
    }
    seen.set(name, `skills/${entry.name}`);
  }
}

/** G8 retained operator-task and lifecycle contracts. Review routing is covered
 * by executable behavioral tests, not exact workflow wording. */
export function gateReviewWorkflow(file, slug, tok) {
  if (slug !== 'write-plan' && slug !== 'plan-review-cycle' && slug !== 'plan-review' && slug !== 'plan-execute') return;
  const prose = tok.unfenced.map(({ line }) => line).join('\n');

  if ((slug === 'plan-review' || slug === 'plan-review-cycle') && prose.includes('subagent-rules')) {
    flag(file, 'review-workflow', 'reviewer dispatch must not inject implementation-only subagent-rules');
  }

  if (slug === 'write-plan') {
    const required = [
      ['plan records roadmap identity', 'Every plan carries exactly one roadmap-card identity header'],
      ['roadmap lookup includes closed cards', 'mai_ideas {include_closed:true}'],
      ['roadmap matching rejects fuzzy titles', 'Never fuzzy-match a title'],
      ['operator owns planned curation', '`idea → planned` remains operator curation'],
      ['writer does not move the card', 'Do not move it here'],
      ['unlinked plans are explicit', 'A `none` header is a deliberate no-op'],
      ['structured operator checklist is mandatory when needed', 'If any such action exists, emit exactly one level-two'],
      ['empty operator inventory omits the section', 'If the inventory is empty, omit the Operator Checklist section entirely'],
      ['operator checklist has exact entry bounds', 'The checklist array contains 1–100 entries.'],
      ['operator checklist has exact fields', 'Each entry contains exactly the four fields `key`, `kind`, `title`, and `instructions`, with no extras.'],
      ['operator checklist title bound and controls are exact', 'Titles are non-blank strings of at most 300 characters and contain no C0 or DEL control characters.'],
      ['operator checklist instruction bound and controls are exact', 'Instructions are non-blank strings of at most 4,000 characters'],
      ['operator checklist structure is exact', 'The sole `## Operator Checklist` heading contains the sole `operator-checklist` fence as its only content'],
      ['operator task bodies are single-source', 'Operator checklist bodies appear once: never repeat them in an operator-run section, ordinary plan prose, chat handoff, or board handoff.'],
      ['execution boxes cannot represent operator completion', 'they never represent operator completion'],
    ];
    for (const [contract, needle] of required) {
      if (!prose.includes(needle)) flag(file, 'review-workflow', `missing contract: ${contract}`);
    }
    return;
  }

  if (slug === 'plan-review') {
    const required = [
      ['operator checklist schema and semantics block approval', 'kinds outside `blocking|follow-up` are invalid'],
      ['operator checklist review has exact entry bound', 'The JSON root is an array of 1–100 entries.'],
      ['operator checklist review has exact fields', 'exactly `key`, `kind`, `title`, and `instructions`, with no extra fields'],
      ['operator checklist review has exact text bounds', 'Titles are non-blank, at most 300 characters'],
      ['operator checklist review has exact control rules', 'no C0 or DEL controls except tab, line feed, and carriage return'],
      ['manual producers map exactly once', 'map each action to exactly'],
      ['reviewers never sync operator tasks', 'Reviewers never mutate or sync operator tasks'],
    ];
    for (const [contract, needle] of required) {
      if (!prose.includes(needle)) flag(file, 'review-workflow', `missing contract: ${contract}`);
    }
    return;
  }

  if (slug === 'plan-review-cycle') {
    // Review breadth/termination is tested through review-route.mjs. Do not pin
    // workflow prose or model-policy wording as a substitute for behavior tests.
    // The scratch lifecycle IS pinned: the canonical helper is the one contract
    // on every OS (Plan 32b Task 5), so the operative commands must name it.
    const required = [
      ['scratch is allocated through the canonical helper', 'review-scratch.mjs create'],
      ['scratch is cleaned through the canonical helper', 'review-scratch.mjs cleanup "$REVIEW_SCRATCH_ROOT"'],
      ['the janitor is the canonical helper', 'review-scratch.mjs prune'],
    ];
    for (const [contract, needle] of required) {
      if (!prose.includes(needle)) flag(file, 'review-workflow', `missing contract: ${contract}`);
    }
    return;
  }

  const required = [
    ['every task boundary posts', 'Every task boundary posts a handoff to the shared board'],
    ['handoff precedes next task', 'Post before starting the next task'],
    ['superseded handoff resolves', 'resolve the handoff this one supersedes'],
    ['final output reconciles board state', '**Board state:**'],
    ['linked roadmap starts building', 'planned → building` with `mai_idea_move`'],
    ['roadmap start carries approved-plan evidence', 'exact approved plan SHA, and execution-start date'],
    ['linked roadmap ships after executed readback', '`building → shipped` with commit-and-gate evidence'],
    ['roadmap close follows executed plan readback', 'only after the executed-plan'],
    ['operator-only transitions stay protected', 'Never move `idea → planned`'],
    ['legacy plans cannot bypass linkage', 'If a plan predates the required header, stop'],
    ['closing handoff receipts roadmap state', 'roadmap card UUID and its `shipped` move receipt'],
    ['executing receipt carries task counts and link', 'receipt to contain numeric inserted/existing and blocking/follow-up counts plus the My Tasks link'],
    ['legacy server gets one sync recovery', '`mai_user_tasks_post {mode:"sync-plan", plan_path:"<path>"}` exactly once as recovery'],
    ['sync recovery never copies task bodies', 'Never copy plan task titles or instructions into that recovery call'],
    ['new operator work uses one assign batch', 'Submit it once as one'],
    ['handoffs are count-and-link only', 'report only pending/blocking/follow-up counts plus `http://127.0.0.1:6601/#/tasks`'],
    ['handoffs never repeat stored task bodies', 'Do not repeat operator-task titles or instructions in chat or board handoffs unless the user explicitly asks to see them there.'],
    ['pending blockers stop closeout', 'Any pending blocking count stops closeout'],
    ['follow-ups do not block closeout', 'Pending follow-ups do not block closeout'],
    ['post-resolution gates are fresh', 'rerun every freshness-sensitive final gate before'],
  ];
  for (const [contract, needle] of required) {
    if (!prose.includes(needle)) flag(file, 'review-workflow', `missing contract: ${contract}`);
  }
}

/** G11 scratch-lifecycle contracts (Plan 32b Task 5). Fingerprints prove the
 * reviewed bytes; these needles prove the properties a re-pin must never lose:
 * the marker is the only deletion authority, a failed open-file probe retains,
 * both default temp roots are pruned, the Windows task is exact-name and
 * limited, and the POSIX wrapper is a strict delegate. Release-only artifacts
 * are skipped in the installable package, exactly like the fingerprints. */
export const SCRATCH_CONTRACTS = [
  {
    path: 'skills/plan-review-cycle/scripts/review-scratch.mjs',
    required: true,
    needles: [
      ['marker-only deletion authority', "if (!('version' in fields) || !('uid' in fields)) return null;"],
      ['failed open-file probe retains', 'if (probe.retain) {\n    retain(candidate, probe.retain);\n    return false;\n  }'],
      ['second default temp root on macOS', "if (platform === 'darwin') roots.push(canonicalRoot(DARWIN_SYSTEM_TMP_ROOT));"],
    ],
  },
  {
    path: 'skills/plan-review-cycle/scripts/review-scratch.sh',
    required: true,
    needles: [
      ['POSIX wrapper delegates to the canonical helper', 'exec node "$SCRIPT_DIR/review-scratch.mjs" "$@"'],
    ],
  },
  {
    path: 'scripts/windows/install-maintenance.ps1',
    required: false,
    needles: [
      ['exact review cleanup task name', "ReviewCleanup = 'mai-mcp-review-scratch-cleanup'"],
      ['exact backup task name', "Backup        = 'mai-mcp-brain-backup'"],
      ['limited interactive principal', '-LogonType Interactive -RunLevel Limited'],
    ],
  },
];

export function gateScratchContracts(repoRoot, { requireRelease = true } = {}) {
  for (const item of SCRATCH_CONTRACTS) {
    const file = path.join(repoRoot, item.path);
    if (!fs.existsSync(file)) {
      if (item.required || requireRelease) flag(item.path, 'scratch-contract', 'scratch lifecycle artifact is missing');
      continue;
    }
    const text = fs.readFileSync(file, 'utf8');
    for (const [contract, needle] of item.needles) {
      if (!text.includes(needle)) flag(item.path, 'scratch-contract', `missing contract: ${contract}`);
    }
  }
}

/** G9 reviewer definitions — the Claude column of the tier table routes to
 * pinned subagent definitions. The table is only real if each definition
 * exists, pins the tier's model and effort in frontmatter, and ships in the
 * public release staging. Runs against a repo root, not the skills dir, so the
 * fixture harness exercises it by calling it directly on a temp root. */
export const REVIEWER_DEFINITIONS = [
  { name: 'plan-reviewer-broad', model: 'sonnet', effort: 'high' },
  { name: 'plan-reviewer-delta', model: 'sonnet', effort: 'high' },
  { name: 'plan-reviewer-clearance', model: 'opus', effort: 'xhigh' },
  { name: 'plan-reviewer-clearance-max', model: 'opus', effort: 'max' },
];
const WORKFLOW_FINGERPRINTS = [
  {
    path: 'skills/plan-review-cycle/scripts/review-scratch.mjs',
    sha256: '9c114012e008c6a7edd78c13a2fd32080d73b38fdd0b3ba3302ff94024b1fecd',
    required: true,
  },
  {
    path: 'skills/plan-review-cycle/scripts/review-scratch.sh',
    sha256: '48ab3cf7ff7337f0d4b60e8e2d9b5b2e4c2fce3d994651180dd41ccd2bd30946',
    required: true,
  },
  {
    path: 'skills/plan-review-cycle/scripts/review-headless.sh',
    sha256: '596215e6d4e82e5922cfebb2e2be9bbe8b61ead9019d37255852369bf69b27b6',
    required: true,
  },
  {
    path: 'skills/plan-review-cycle/references/headless-review.schema.json',
    sha256: 'e590bc2a395f05037295887b29ebf843bfd6a5312b4d71d5f0365dfa7d33b038',
    required: true,
  },
  {
    path: 'skills/plan-review-cycle/scripts/install-janitor.sh',
    sha256: '977449bd1aa8532fdad0c01fd4864a5fbaaf405ae64a372ca07e341d322113ce',
    required: true,
  },
  {
    path: 'skills/plan-review-cycle/scripts/com.mai.review-tmp-janitor.plist',
    sha256: '343a182105d381cade7796d9c6d1822f0b4114ae0cfb5e3a001afbebbbd24569',
    required: true,
  },
  {
    path: 'scripts/windows/install-maintenance.ps1',
    sha256: 'eb9154fa36d6df224e198e0ea7a35af68d28b6e2df266e7dcf7e2481f1ff21ef',
  },
  {
    path: 'scripts/release-leak-check.sh',
    sha256: '67470b695fd6c954004f1e4437707bf6689beb418ebb106d469e0c7b1e1e54c8',
  },
  {
    path: 'scripts/release-leak-content-allowlist.txt',
    sha256: 'a0a908a1d1d4aa78e24d00cf67a76cb6e9110fa08557c72b7aaba52442482397',
  },
  {
    path: 'scripts/release-public.sh',
    sha256: 'cf465f810a281b41212e37998b7fa3dfe7af6f68f4594cb58a70c0b9e32eb461',
    required: false,
  },
];

/** Retained scratch/headless and release artifact integrity. Review skill prose
 * deliberately has no fingerprint: editorial edits do not require reapproval. */
export function gateWorkflowFingerprints(repoRoot, { requireRelease = true } = {}) {
  for (const item of WORKFLOW_FINGERPRINTS) {
    const file = path.join(repoRoot, item.path);
    const required = item.required || requireRelease;
    if (!fs.existsSync(file)) {
      if (required) flag(item.path, 'workflow-fingerprint', 'reviewed workflow artifact is missing');
      continue;
    }
    const actual = createHash('sha256').update(fs.readFileSync(file)).digest('hex');
    if (actual !== item.sha256) {
      flag(item.path, 'workflow-fingerprint', 'reviewed workflow artifact changed; re-review and update its pinned fingerprint');
    }
  }
}

export function gateReviewerDefinitions(repoRoot, { requireRelease = true, exactInventory = false } = {}) {
  const expectedNames = REVIEWER_DEFINITIONS.map(({ name }) => `${name}.md`).sort();
  const agentsDir = path.join(repoRoot, '.claude', 'agents');
  if (exactInventory && fs.existsSync(agentsDir)) {
    const actualNames = fs.readdirSync(agentsDir).sort();
    if (JSON.stringify(actualNames) !== JSON.stringify(expectedNames)) {
      flag('.claude/agents', 'reviewer-definitions', `public reviewer inventory must be exact: expected ${expectedNames.join(', ')}, found ${actualNames.join(', ')}`);
    }
  }
  for (const { name, model, effort } of REVIEWER_DEFINITIONS) {
    const file = path.join(repoRoot, '.claude', 'agents', `${name}.md`);
    const rel = `.claude/agents/${name}.md`;
    if (!fs.existsSync(file)) {
      flag(rel, 'reviewer-definitions', 'pinned reviewer definition is missing');
      continue;
    }
    const text = fs.readFileSync(file, 'utf8');
    const end = text.startsWith('---\n') ? text.indexOf('\n---\n', 4) : -1;
    const fm = end === -1 ? '' : text.slice(4, end);
    const body = end === -1 ? '' : text.slice(end + '\n---\n'.length);
    // `key : value` is valid YAML — the space before the colon must not hide
    // a duplicate from the count or a value from the check.
    const scalar = (raw) => {
      let single = false;
      let double = false;
      let escaped = false;
      let commentAt = -1;
      for (let i = 0; i < raw.length; i += 1) {
        const ch = raw[i];
        if (escaped) { escaped = false; continue; }
        if (double && ch === '\\') { escaped = true; continue; }
        if (!double && ch === "'") { single = !single; continue; }
        if (!single && ch === '"') { double = !double; continue; }
        if (!single && !double && ch === '#' && (i === 0 || /\s/.test(raw[i - 1]))) { commentAt = i; break; }
      }
      const value = (commentAt === -1 ? raw : raw.slice(0, commentAt)).trim();
      if (/^"(?:[^"\\]|\\.)*"$/.test(value)) {
        try { return JSON.parse(value); } catch { return value; }
      }
      if (/^'(?:[^']|'')*'$/.test(value)) return value.slice(1, -1).replaceAll("''", "'");
      return value;
    };
    const field = (k) => {
      const raw = fm.match(new RegExp(`^${k}\\s*:\\s*(.*?)\\s*$`, 'm'))?.[1];
      return raw === undefined ? undefined : scalar(raw);
    };
    // Exactly one of each routed field — a duplicate is a contradiction the
    // harness resolves by whichever precedence it happens to have, and a
    // frontmatter name that disagrees with the filename registers an agent
    // type the tier table never routes to.
    const keys = [];
    for (const line of fm.split('\n')) {
      if (!line.trim() || line.trim().startsWith('#')) continue;
      const match = line.match(/^([A-Za-z][A-Za-z0-9_-]*)\s*:/);
      if (!match) {
        flag(rel, 'reviewer-definitions', `frontmatter must use one simple top-level scalar per line: ${line}`);
        continue;
      }
      keys.push(match[1]);
    }
    const allowedKeys = ['name', 'description', 'model', 'effort'];
    for (const key of keys) {
      if (!allowedKeys.includes(key)) flag(rel, 'reviewer-definitions', `unsupported frontmatter field: ${key}`);
    }
    const count = (k) => keys.filter((key) => key === k).length;
    for (const k of allowedKeys) {
      if (count(k) !== 1) flag(rel, 'reviewer-definitions', `frontmatter must have exactly one ${k} field, found ${count(k)}`);
    }
    if (field('name') !== name) flag(rel, 'reviewer-definitions', `frontmatter name must be ${name}`);
    if (!field('description')?.trim()) flag(rel, 'reviewer-definitions', 'frontmatter description is required');
    if (field('model') !== model) flag(rel, 'reviewer-definitions', `frontmatter must pin model: ${model}`);
    if (field('effort') !== effort) flag(rel, 'reviewer-definitions', `frontmatter must pin effort: ${effort}`);
    if (!body.trim()) flag(rel, 'reviewer-definitions', 'reviewer instruction body is empty');
  }
  const release = path.join(repoRoot, 'scripts', 'release-public.sh');
  if (!fs.existsSync(release)) {
    if (requireRelease) flag('scripts/release-public.sh', 'reviewer-definitions', 'private release assembler is missing');
  } else {
    const operational = fs.readFileSync(release, 'utf8').split('\n')
      .map((line) => line.trim())
      .filter((line) => line && !line.startsWith('#'));
    const expected = REVIEWER_DEFINITIONS.map(({ name }) =>
      `cp ".claude/agents/${name}.md" "$OUT/.claude/agents/${name}.md"`);
    for (const line of expected) {
      if (operational.filter((candidate) => candidate === line).length !== 1) {
        flag('scripts/release-public.sh', 'reviewer-definitions', `release staging must contain exactly once: ${line}`);
      }
    }
    const agentCopies = operational.filter((line) =>
      /\b(?:rsync|cp)\b/.test(line) && line.includes('.claude/agents/'));
    if (agentCopies.length !== expected.length || agentCopies.some((line) => !expected.includes(line))) {
      flag('scripts/release-public.sh', 'reviewer-definitions', 'release staging must copy only the reviewed agent definitions to their exact public destinations');
    }
    const packageCheck = 'node scripts/check-skills.mjs --reviewer-package "$OUT"';
    if (operational.filter((line) => line === packageCheck).length !== 1) {
      flag('scripts/release-public.sh', 'reviewer-definitions', `release staging must execute exactly once: ${packageCheck}`);
    }
    const packedProof = [
      'TARBALL=$(npm pack "$OUT" --pack-destination "$PACK_TMP" --cache "$PACK_TMP/npm-cache" --silent)',
      'tar -xzf "$PACK_TMP/$TARBALL" -C "$PACK_TMP/extracted"',
      'node "$PACK_TMP/extracted/package/scripts/check-skills.mjs" --reviewer-package "$PACK_TMP/extracted/package"',
      'npm run check:skills',
      'ln -s "$PRIVATE_NODE_MODULES" node_modules',
      '"$PRIVATE_NODE_MODULES/.bin/vitest" run src/__tests__/skills-gates.test.ts',
    ];
    for (const line of packedProof) {
      if (operational.filter((candidate) => candidate === line).length !== 1) {
        flag('scripts/release-public.sh', 'reviewer-definitions', `release staging must prove the extracted tarball with exactly once: ${line}`);
      }
    }
  }
}

// ---------- runner ----------

function repoTrackedFiles() {
  if (fs.existsSync(path.join(root, '.git'))) {
    const out = execFileSync('git', ['ls-files', '-z', '--', 'skills'], { cwd: root, encoding: 'utf8' });
    return new Set(out.split('\0').filter(Boolean).map((p) => path.resolve(root, p)));
  }
  // npm tarballs intentionally have no .git directory. Every regular file in
  // their packaged skills tree is, by construction, part of that immutable
  // package inventory, so reference closure can use the package itself as the
  // tracked set without weakening source-checkout behavior.
  const packaged = new Set();
  const walk = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const file = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(file);
      else if (entry.isFile() || entry.isSymbolicLink()) packaged.add(path.resolve(file));
    }
  };
  walk(SKILLS_DIR);
  return packaged;
}

export function runAll(dir, tracked = path.resolve(dir) === path.resolve(SKILLS_DIR) ? repoTrackedFiles() : null) {
  problems.length = 0;
  // Repo-level, not per-skill: only meaningful on the real tree. Fixture
  // coverage comes from definitionMutant calling the gate on a temp root.
  if (path.resolve(dir) === path.resolve(SKILLS_DIR)) {
    const privateTree = fs.existsSync(path.join(root, 'release', 'public'));
    gateWorkflowFingerprints(root, { requireRelease: privateTree });
    gateScratchContracts(root, { requireRelease: privateTree });
    gateReviewerDefinitions(root, { requireRelease: privateTree, exactInventory: !privateTree });
  }
  gatePackageValidity(dir);
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const skillFile = path.join(dir, entry.name, 'SKILL.md');
    if (!fs.existsSync(skillFile)) continue;
    const rel = `skills/${entry.name}/SKILL.md`;
    const text = fs.readFileSync(skillFile, 'utf8');
    const tok = tokenize(text);
    gateReferenceClosure(rel, path.join(dir, entry.name), tok, tracked);
    gateFrontmatter(rel, text);
    gateHarnessLockIn(rel, entry.name, tok);
    gateDependencies(rel, entry.name, tok);
    gateSpine(rel, entry.name, text, tok);
    gateReviewWorkflow(rel, entry.name, tok);
  }
  return [...problems];
}

// ---------- fixtures ----------

const GOOD = `---
name: fixture
description: A conforming fixture.
---

<!-- SPDX-License-Identifier: MIT -->

# Fixture

Purpose sentence.

## Invocation

**Announce at start:** "Using fixture."

## When to use

Use for X. Do NOT use for Y.

## Non-negotiable rules

1. A rule.

## Dependencies

None.

## Phase 1: Do it

Grep for the column and read the file.

## Output

A report.
`;

const PAYLOAD_GOOD = `---
name: subagent-rules
description: A conforming injected payload fixture.
---

<!-- SPDX-License-Identifier: MIT -->

# Payload fixture

Purpose sentence.

## Invocation

**Internal — does not announce.** The dispatching skill announces.

## When to use

Inject for implementers. Do NOT inject for an inline task.

## Non-negotiable rules

Copy this payload verbatim:

~~~text
1. Read the project instructions before editing.
~~~

## Dependencies

None.

## Output

The verified subagent handback.
`;

function withTempSkills(files, fn, { extra = {}, untracked = [] } = {}) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'mai-skills-fixture-'));
  try {
    const written = [];
    for (const [name, text] of Object.entries(files)) {
      fs.mkdirSync(path.join(tmp, name), { recursive: true });
      const file = path.join(tmp, name, 'SKILL.md');
      fs.writeFileSync(file, text);
      written.push(file);
    }
    for (const [rel, text] of Object.entries(extra)) {
      const file = path.join(tmp, rel);
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, text);
      written.push(file);
    }
    const excluded = new Set(untracked.map((p) => path.resolve(tmp, p)));
    const tracked = new Set(written.map((p) => path.resolve(p)).filter((p) => !excluded.has(p)));
    return fn(tmp, tracked);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

const swapRulesAndDeps = GOOD.replace(
  '## Non-negotiable rules\n\n1. A rule.\n\n## Dependencies\n\nNone.',
  '## Dependencies\n\nNone.\n\n## Non-negotiable rules\n\n1. A rule.',
);
const payloadLockIn = GOOD
  .replace('name: fixture', 'name: subagent-rules')
  .replace('## Output', '```text\nUse the Agent tool and read CLAUDE.md first.\n```\n\n## Output');
const DEPENDENCY_GOOD = GOOD
  .replace('Grep for the column and read the file.', 'Invoke superpowers:brainstorming first.')
  .replace('None.', `| Dependency | What it is | Without it | Harness-native fallback |
|---|---|---|---|
| \`superpowers:brainstorming\` | Interactive design exploration | Design context is unavailable | Establish scope directly with the user |`);
const REFERENCE_GOOD = GOOD.replace('Purpose sentence.',
  'Purpose [full][one], [two][], and [three].\n\n[one]: references/one.md\n[two]: references/two.md\n[three]: references/three.md');

const textMutant = (label, gate, text) => ({
  label, gate, run: () => withTempSkills({ fixture: text }, (d, tracked) => runAll(d, tracked)),
});
const contractMutant = (slug, label, from, to = '') => ({
  label,
  gate: 'review-workflow',
  run: () => {
    const source = fs.readFileSync(path.join(SKILLS_DIR, slug, 'SKILL.md'), 'utf8');
    const hits = source.split(from).length - 1;
    if (hits !== 1) throw new Error(`mutation fixture '${label}' expected one anchor, found ${hits}`);
    return withTempSkills({ [slug]: source.replace(from, to) }, (d, tracked) => runAll(d, tracked));
  },
});
/** G9 fixtures: copy the real reviewer definitions + release script into a
 * temp repo root, apply one mutation, run the gate directly on that root. */
const definitionMutant = (label, mutate, gateOptions = {}) => ({
  label,
  gate: 'reviewer-definitions',
  run: () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'mai-agents-fixture-'));
    try {
      fs.mkdirSync(path.join(tmp, '.claude', 'agents'), { recursive: true });
      fs.mkdirSync(path.join(tmp, 'scripts'), { recursive: true });
      for (const { name } of REVIEWER_DEFINITIONS) {
        fs.copyFileSync(path.join(root, '.claude', 'agents', `${name}.md`), path.join(tmp, '.claude', 'agents', `${name}.md`));
      }
      // The private assembler is deliberately not part of the public tree, but
      // this fixture must still run there and return the exact protocol exits.
      // Synthesize the minimal conforming input when the real script is absent.
      const releaseSrc = path.join(root, 'scripts', 'release-public.sh');
      const releaseDst = path.join(tmp, 'scripts', 'release-public.sh');
      if (fs.existsSync(releaseSrc)) {
        fs.copyFileSync(releaseSrc, releaseDst);
      } else {
        fs.writeFileSync(releaseDst, [
          '# synthesized fixture stand-in — the private assembler does not ship',
          ...REVIEWER_DEFINITIONS.map(({ name }) =>
            `cp ".claude/agents/${name}.md" "$OUT/.claude/agents/${name}.md"`),
          'node scripts/check-skills.mjs --reviewer-package "$OUT"',
          'TARBALL=$(npm pack "$OUT" --pack-destination "$PACK_TMP" --cache "$PACK_TMP/npm-cache" --silent)',
          'tar -xzf "$PACK_TMP/$TARBALL" -C "$PACK_TMP/extracted"',
          'node "$PACK_TMP/extracted/package/scripts/check-skills.mjs" --reviewer-package "$PACK_TMP/extracted/package"',
          'npm run check:skills',
          'ln -s "$PRIVATE_NODE_MODULES" node_modules',
          '"$PRIVATE_NODE_MODULES/.bin/vitest" run src/__tests__/skills-gates.test.ts',
          '',
        ].join('\n'));
      }
      mutate(tmp);
      problems.length = 0;
      gateReviewerDefinitions(tmp, gateOptions);
      return [...problems];
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  },
});
const fingerprintMutant = (label, mutate, { requireRelease = true } = {}) => ({
  label,
  gate: 'workflow-fingerprint',
  run: () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'mai-workflow-fingerprint-'));
    try {
      for (const rel of WORKFLOW_FINGERPRINTS.map((item) => item.path)) {
        const source = path.join(root, rel);
        if (!fs.existsSync(source)) continue;
        const target = path.join(tmp, rel);
        fs.mkdirSync(path.dirname(target), { recursive: true });
        fs.copyFileSync(source, target);
      }
      mutate(tmp);
      problems.length = 0;
      gateWorkflowFingerprints(tmp, { requireRelease });
      return [...problems];
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  },
});
const singleByteFingerprintMutant = (label, rel) => {
  const fixture = fingerprintMutant(label, (tmp) => {
    const target = path.join(tmp, rel);
    if (fs.existsSync(target)) fs.appendFileSync(target, Buffer.from([0x0a]));
  }, { requireRelease: true });
  return {
    ...fixture,
    run: () => fixture.run().filter((problem) =>
      problem.startsWith(`workflow-fingerprint: ${rel}:`)),
  };
};
/** Reachability control: unlike fingerprintMutant, this invokes a copied
 * checker through its real no-argument entry point. Deleting runAll's
 * gateWorkflowFingerprints edge must make this mutant survive. */
const productionFingerprintMutant = {
  label: 'fingerprint: production entry stops invoking workflow fingerprints',
  gate: 'workflow-fingerprint',
  run: () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'mai-workflow-entry-'));
    try {
      fs.mkdirSync(path.join(tmp, 'scripts'), { recursive: true });
      fs.mkdirSync(path.join(tmp, '.claude'), { recursive: true });
      fs.cpSync(SKILLS_DIR, path.join(tmp, 'skills'), { recursive: true });
      fs.cpSync(path.join(root, 'skill-blocks'), path.join(tmp, 'skill-blocks'), { recursive: true });
      fs.cpSync(path.join(root, '.claude', 'agents'), path.join(tmp, '.claude', 'agents'), { recursive: true });
      fs.copyFileSync(path.join(root, 'scripts', 'check-skills.mjs'), path.join(tmp, 'scripts', 'check-skills.mjs'));
      fs.appendFileSync(path.join(tmp, 'skills', 'plan-review-cycle', 'scripts', 'review-scratch.sh'), '\n# changed scratch lifecycle\n');
      try {
        execFileSync(process.execPath, ['scripts/check-skills.mjs'], { cwd: tmp, encoding: 'utf8', stdio: 'pipe' });
        return [];
      } catch (err) {
        const record = err !== null && typeof err === 'object' ? err : {};
        const output = `${Reflect.get(record, 'stdout') ?? ''}${Reflect.get(record, 'stderr') ?? ''}`;
        return output.includes('workflow-fingerprint:')
          ? ['workflow-fingerprint: production entry rejected the changed artifact']
          : [];
      }
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  },
};
const scratchContractMutant = (label, mutate) => ({
  label,
  gate: 'scratch-contract',
  run: () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'mai-scratch-contract-'));
    try {
      for (const rel of SCRATCH_CONTRACTS.map((item) => item.path)) {
        const source = path.join(root, rel);
        if (!fs.existsSync(source)) continue;
        const target = path.join(tmp, rel);
        fs.mkdirSync(path.dirname(target), { recursive: true });
        fs.copyFileSync(source, target);
      }
      mutate(tmp);
      problems.length = 0;
      // Like fingerprintMutant: in the installable package the release-only
      // installer is absent and the gate rejects that absence; the source tree
      // and the assembled tree (Task 7 ships it) exercise the real needles.
      gateScratchContracts(tmp, { requireRelease: true });
      return [...problems];
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  },
});
const rewriteCopy = (tmp, rel, from, to) => {
  const file = path.join(tmp, rel);
  if (!fs.existsSync(file)) return;
  const text = fs.readFileSync(file, 'utf8');
  if (!text.includes(from)) throw new Error(`mutant anchor missing in ${rel}: ${from}`);
  fs.writeFileSync(file, text.split(from).join(to));
};
const HELPER_MJS = 'skills/plan-review-cycle/scripts/review-scratch.mjs';
const HELPER_SH = 'skills/plan-review-cycle/scripts/review-scratch.sh';
const MAINTENANCE_PS1 = 'scripts/windows/install-maintenance.ps1';
const MUTANTS = [
  textMutant('lock-in: Claude tool names', 'harness-lockin', GOOD.replace('Grep for the column and read the file.', 'Use Glob, Grep, and Read — do not guess.')),
  textMutant('lock-in: optional article and tool suffix', 'harness-lockin', GOOD.replace('Grep for the column and read the file.', 'Use the Read tool.')),
  textMutant('lock-in: Codex edit tool suffix', 'harness-lockin', GOOD.replace('Grep for the column and read the file.', 'Use the apply_patch tool.')),
  textMutant('lock-in: shell tool imperative', 'harness-lockin', GOOD.replace('Grep for the column and read the file.', 'Run Bash.')),
  textMutant('lock-in: search with named Grep', 'harness-lockin', GOOD.replace('Grep for the column and read the file.', 'Search with Grep.')),
  textMutant('lock-in: read via named Read tool', 'harness-lockin', GOOD.replace('Grep for the column and read the file.', 'Read via the Read tool.')),
  textMutant('lock-in: search with named Glob tool', 'harness-lockin', GOOD.replace('Grep for the column and read the file.', 'Search the codebase with the Glob tool.')),
  textMutant('lock-in: apply_patch', 'harness-lockin', GOOD.replace('Grep for the column and read the file.', 'Edit with `apply_patch`.')),
  textMutant('lock-in: bare CLAUDE.md', 'harness-lockin', GOOD.replace('Grep for the column and read the file.', "Read the project's CLAUDE.md for rules.")),
  {
    label: 'lock-in: fenced injected payload', gate: 'harness-lockin',
    run: () => withTempSkills({ 'subagent-rules': payloadLockIn }, (d, tracked) => runAll(d, tracked)),
  },
  textMutant('spine: missing Dependencies', 'spine', GOOD.replace('## Dependencies\n\nNone.\n\n', '')),
  textMutant('spine: truly out-of-order sections', 'spine', swapRulesAndDeps),
  textMutant('spine: mixed level-2 Step and Phase', 'spine', GOOD.replace('## Output', '## Step 2: Another\n\nx.\n\n## Output')),
  textMutant('spine: SPDX after content', 'spine', GOOD
    .replace('<!-- SPDX-License-Identifier: MIT -->\n\n', '')
    .concat('\n<!-- SPDX-License-Identifier: MIT -->\n')),
  textMutant('spine: missing purpose', 'spine', GOOD.replace('Purpose sentence.\n\n', '')),
  textMutant('spine: thematic break is not purpose prose', 'spine', GOOD.replace('Purpose sentence.', '---')),
  textMutant('spine: duplicate title', 'spine', GOOD.replace('Purpose sentence.', '# Second title\n\nPurpose sentence.')),
  textMutant('spine: empty Invocation', 'spine', GOOD.replace('**Announce at start:** "Using fixture."', '')),
  textMutant('spine: negated announcement is not an announcement', 'spine', GOOD.replace('**Announce at start:** "Using fixture."', 'Do not Announce at start.')),
  textMutant('spine: When to use has no stop boundary', 'spine', GOOD.replace('Use for X. Do NOT use for Y.', 'Use for X.')),
  textMutant('spine: rules are not numbered', 'spine', GOOD.replace('1. A rule.', 'A rule.')),
  textMutant('spine: empty Dependencies', 'spine', GOOD.replace('## Dependencies\n\nNone.\n\n', '## Dependencies\n\n')),
  textMutant('spine: missing workflow', 'spine', GOOD.replace('## Phase 1: Do it', '### Phase 1: Do it')),
  textMutant('spine: empty Output', 'spine', GOOD.replace('A report.\n', '')),
  textMutant('spine: unexpected top-level section', 'spine', GOOD.concat('\n## Legacy appendix\n\nUnmapped.\n')),
  textMutant('frontmatter: no description', 'frontmatter', GOOD.replace('description: A conforming fixture.\n', '')),
  textMutant('deps: undeclared superpowers ref', 'dependency-declaration', GOOD.replace('Grep for the column and read the file.', 'Invoke superpowers:brainstorming first.')),
  textMutant('deps: renamed semantic header', 'dependency-declaration', DEPENDENCY_GOOD.replace('Harness-native fallback', 'Fallback')),
  textMutant('deps: missing What it is', 'dependency-declaration', DEPENDENCY_GOOD.replace('Interactive design exploration', '')),
  textMutant('deps: missing Without it', 'dependency-declaration', DEPENDENCY_GOOD.replace('Design context is unavailable', '')),
  textMutant('deps: missing harness fallback', 'dependency-declaration', DEPENDENCY_GOOD.replace('Establish scope directly with the user', '')),
  {
    label: 'reference: dangling target', gate: 'reference-closure',
    run: () => withTempSkills({ fixture: GOOD.replace('Purpose sentence.', '[missing](references/missing.md)') }, (d, tracked) => runAll(d, tracked)),
  },
  {
    label: 'reference: existing but untracked target', gate: 'reference-closure',
    run: () => withTempSkills(
      { fixture: GOOD.replace('Purpose sentence.', '[untracked](references/untracked.md)') },
      (d, tracked) => runAll(d, tracked),
      { extra: { 'fixture/references/untracked.md': 'present' }, untracked: ['fixture/references/untracked.md'] },
    ),
  },
  {
    label: 'reference: dangling reference-style target', gate: 'reference-closure',
    run: () => withTempSkills(
      { fixture: GOOD.replace('Purpose sentence.', 'Purpose [missing][asset].\n\n[asset]: references/missing.md') },
      (d, tracked) => runAll(d, tracked),
    ),
  },
  {
    label: 'reference: existing but untracked reference-style target', gate: 'reference-closure',
    run: () => withTempSkills(
      { fixture: GOOD.replace('Purpose sentence.', 'Purpose [untracked][asset].\n\n[asset]: references/untracked.md') },
      (d, tracked) => runAll(d, tracked),
      { extra: { 'fixture/references/untracked.md': 'present' }, untracked: ['fixture/references/untracked.md'] },
    ),
  },
  {
    label: 'reference: dangling shortcut-style target', gate: 'reference-closure',
    run: () => withTempSkills(
      { fixture: GOOD.replace('Purpose sentence.', 'Purpose [asset].\n\n[asset]: references/missing-shortcut.md') },
      (d, tracked) => runAll(d, tracked),
    ),
  },
  {
    label: 'reference: dangling collapsed-style target', gate: 'reference-closure',
    run: () => withTempSkills(
      { fixture: GOOD.replace('Purpose sentence.', 'Purpose [asset][].\n\n[asset]: references/missing-collapsed.md') },
      (d, tracked) => runAll(d, tracked),
    ),
  },
  {
    label: 'reference: duplicate definitions are ambiguous', gate: 'reference-closure',
    run: () => withTempSkills(
      { fixture: GOOD.replace('Purpose sentence.', 'Purpose [asset].\n\n[asset]: references/first.md\n[asset]: references/second.md') },
      (d, tracked) => runAll(d, tracked),
      { extra: { 'fixture/references/first.md': 'first', 'fixture/references/second.md': 'second' } },
    ),
  },
  {
    label: 'package: duplicate frontmatter name', gate: 'package-validity',
    run: () => withTempSkills({ one: GOOD, two: GOOD }, (d, tracked) => runAll(d, tracked)),
  },
  {
    label: 'spine: internal skill that does not say it is internal', gate: 'spine',
    run: () => withTempSkills({
      'mai-subagent-execute': GOOD
        .replace('## Invocation\n\n**Announce at start:** "Using fixture."',
                 '## Invocation\n\nThis one is quietly internal.')
        .replace('name: fixture', 'name: mai-subagent-execute'),
    }, (d, tracked) => runAll(d, tracked)),
  },
  textMutant('deps: undeclared reference to a new suite skill', 'dependency-declaration',
    GOOD.replace('Grep for the column and read the file.', 'Hand the batch to mai-subagent-execute.')),
  contractMutant('plan-execute', 'execute: task-boundary board post deleted',
    'Every task boundary posts a handoff to the shared board',
    'Every task boundary produces a local report'),
  contractMutant('plan-execute', 'execute: superseded handoff resolution deleted',
    'resolve the handoff this one supersedes',
    'retain the handoff this one supersedes'),
  contractMutant('write-plan', 'plan: structured operator checklist requirement deleted',
    'If any such action exists, emit exactly one level-two',
    'Operator actions may be described wherever convenient'),
  contractMutant('write-plan', 'plan: operator checklist entry bound widened',
    'The checklist array contains 1–100 entries.',
    'The checklist array contains 1–1,000 entries.'),
  contractMutant('write-plan', 'plan: operator checklist title bound widened',
    'Titles are non-blank strings of at most 300 characters',
    'Titles are non-blank strings of at most 3,000 characters'),
  contractMutant('write-plan', 'plan: operator checklist instruction bound widened',
    'Instructions are non-blank strings of at most 4,000 characters',
    'Instructions are non-blank strings of at most 40,000 characters'),
  contractMutant('write-plan', 'plan: operator checklist extra fields allowed',
    'with no extras.',
    'with optional extension fields.'),
  contractMutant('plan-review', 'review: operator checklist control constraints deleted',
    'no C0 or DEL controls except tab, line feed, and carriage return',
    'all control characters are accepted'),
  contractMutant('plan-execute', 'execute: pending blocking gate deleted',
    'Any pending blocking count stops closeout',
    'Pending blocking work is advisory during closeout'),
  contractMutant('plan-execute', 'execute: handoff repeats operator task bodies',
    'report only pending/blocking/follow-up counts plus `http://127.0.0.1:6601/#/tasks`',
    'report operator task titles and instructions in every handoff'),
  contractMutant('write-plan', 'plan: roadmap identity header deleted',
    'Every plan carries exactly one roadmap-card identity header',
    'A roadmap-card identity header is optional'),
  contractMutant('write-plan', 'plan: fuzzy roadmap matching allowed',
    'Never fuzzy-match a title',
    'Use the closest matching title'),
  contractMutant('write-plan', 'plan: writer mutates operator-owned planned state',
    'Do not move it here',
    'Move it into planned during registration'),
  contractMutant('plan-execute', 'execute: roadmap start transition deleted',
    'planned → building` with `mai_idea_move`',
    'planned work is noted locally'),
  contractMutant('plan-execute', 'execute: roadmap shipped transition runs before closeout proof',
    'only after the executed-plan',
    'before the executed-plan'),
  contractMutant('plan-execute', 'execute: unsupported roadmap transitions allowed',
    'Never move `idea → planned`',
    'Move `idea → planned` when needed'),
  definitionMutant('definitions: reviewer name contradicts its filename', (tmp) => {
    const file = path.join(tmp, '.claude', 'agents', 'plan-reviewer-clearance.md');
    fs.writeFileSync(file, fs.readFileSync(file, 'utf8').replace('name: plan-reviewer-clearance', 'name: wrong-reviewer-name'));
  }),
  definitionMutant('definitions: duplicate conflicting frontmatter field', (tmp) => {
    const file = path.join(tmp, '.claude', 'agents', 'plan-reviewer-broad.md');
    fs.writeFileSync(file, fs.readFileSync(file, 'utf8').replace('model: sonnet', 'model: sonnet\nmodel: haiku'));
  }),
  // `model : haiku` is valid YAML — a colon-adjacent count regex missed it.
  definitionMutant('definitions: spaced-colon duplicate frontmatter field', (tmp) => {
    const file = path.join(tmp, '.claude', 'agents', 'plan-reviewer-broad.md');
    fs.writeFileSync(file, fs.readFileSync(file, 'utf8').replace('model: sonnet', 'model: sonnet\nmodel : haiku'));
  }),
  definitionMutant('definitions: release mentions agents only in a comment', (tmp) => {
    fs.writeFileSync(path.join(tmp, 'scripts', 'release-public.sh'),
      '# this assembler mentions .claude/agents/ without copying it\necho done\n');
  }),
  definitionMutant('definitions: clearance reviewer missing', (tmp) => {
    fs.rmSync(path.join(tmp, '.claude', 'agents', 'plan-reviewer-clearance.md'));
  }),
  definitionMutant('definitions: clearance effort downgraded', (tmp) => {
    const file = path.join(tmp, '.claude', 'agents', 'plan-reviewer-clearance.md');
    fs.writeFileSync(file, fs.readFileSync(file, 'utf8').replace('effort: xhigh', 'effort: high'));
  }),
  definitionMutant('definitions: broad model drifts off-tier', (tmp) => {
    const file = path.join(tmp, '.claude', 'agents', 'plan-reviewer-broad.md');
    fs.writeFileSync(file, fs.readFileSync(file, 'utf8').replace('model: sonnet', 'model: haiku'));
  }),
  definitionMutant('definitions: reviewed description is deleted', (tmp) => {
    const file = path.join(tmp, '.claude', 'agents', 'plan-reviewer-delta.md');
    fs.writeFileSync(file, fs.readFileSync(file, 'utf8').replace(/^description:.*\n/m, ''));
  }),
  definitionMutant('definitions: behavior-changing frontmatter field is added', (tmp) => {
    const file = path.join(tmp, '.claude', 'agents', 'plan-reviewer-clearance.md');
    fs.writeFileSync(file, fs.readFileSync(file, 'utf8').replace('effort: xhigh', 'effort: xhigh\npermissionMode: bypassPermissions'));
  }),
  definitionMutant('definitions: sustained max reviewer is downgraded', (tmp) => {
    const file = path.join(tmp, '.claude', 'agents', 'plan-reviewer-clearance-max.md');
    fs.writeFileSync(file, fs.readFileSync(file, 'utf8').replace('effort: max', 'effort: xhigh'));
  }),
  definitionMutant('definitions: release copies to the wrong destination', (tmp) => {
    const file = path.join(tmp, 'scripts', 'release-public.sh');
    fs.writeFileSync(file, fs.readFileSync(file, 'utf8').replace(
      '"$OUT/.claude/agents/plan-reviewer-clearance.md"',
      '"$OUT/not-agent-definitions/plan-reviewer-clearance.md"'));
  }),
  definitionMutant('definitions: release bulk-copies unreviewed agents', (tmp) => {
    const file = path.join(tmp, 'scripts', 'release-public.sh');
    fs.appendFileSync(file, '\nrsync -a .claude/agents/ "$OUT/.claude/agents/"\n');
  }),
  definitionMutant('definitions: release staging stops shipping agents', (tmp) => {
    const file = path.join(tmp, 'scripts', 'release-public.sh');
    fs.writeFileSync(file, fs.readFileSync(file, 'utf8').replaceAll('.claude/agents/', '.claude-agents-gone/'));
  }),
  definitionMutant('definitions: release assembler is missing', (tmp) => {
    fs.rmSync(path.join(tmp, 'scripts', 'release-public.sh'));
  }),
  definitionMutant('definitions: release omits packaged-inventory verification', (tmp) => {
    const file = path.join(tmp, 'scripts', 'release-public.sh');
    fs.writeFileSync(file, fs.readFileSync(file, 'utf8').replace(
      'node scripts/check-skills.mjs --reviewer-package "$OUT"',
      'echo reviewer package assumed clean'));
  }),
  definitionMutant('definitions: release never packs the artifact', (tmp) => {
    const file = path.join(tmp, 'scripts', 'release-public.sh');
    fs.writeFileSync(file, fs.readFileSync(file, 'utf8').replace(
      'TARBALL=$(npm pack "$OUT" --pack-destination "$PACK_TMP" --cache "$PACK_TMP/npm-cache" --silent)',
      'TARBALL=assumed.tgz'));
  }),
  definitionMutant('definitions: extracted tarball never runs the persistent suite', (tmp) => {
    const file = path.join(tmp, 'scripts', 'release-public.sh');
    fs.writeFileSync(file, fs.readFileSync(file, 'utf8').replace(
      '"$PRIVATE_NODE_MODULES/.bin/vitest" run src/__tests__/skills-gates.test.ts',
      'echo packaged tests assumed green'));
  }),
  definitionMutant('definitions: public package contains an unreviewed fifth agent', (tmp) => {
    fs.writeFileSync(path.join(tmp, '.claude', 'agents', 'unreviewed.md'), '---\nname: unreviewed\n---\n');
    fs.rmSync(path.join(tmp, 'scripts', 'release-public.sh'));
  }, { requireRelease: false, exactInventory: true }),




  productionFingerprintMutant,

  fingerprintMutant('fingerprint: leak gate accepts a missing content manifest', (tmp) => {
    const file = path.join(tmp, 'scripts', 'release-leak-check.sh');
    // The installable public package intentionally omits private release
    // machinery. In that nested suite the fingerprint gate itself rejects the
    // missing private surface; in the source tree this mutation proves the
    // manifest precondition cannot be weakened without updating the pin.
    if (!fs.existsSync(file)) return;
    fs.writeFileSync(file, fs.readFileSync(file, 'utf8').replace(
      '[ -f "$CONTENT_ALLOW" ] || { echo "refusing: content allowlist missing: $CONTENT_ALLOW"; exit 1; }',
      'true # missing allowlist accepted'));
  }),
  fingerprintMutant('fingerprint: release exits successfully before its proofs', (tmp) => {
    const file = path.join(tmp, 'scripts', 'release-public.sh');
    if (!fs.existsSync(file)) return;
    fs.writeFileSync(file, fs.readFileSync(file, 'utf8').replace(
      'set -euo pipefail',
      'set -euo pipefail\nexit 0'));
  }),
  singleByteFingerprintMutant(
    'fingerprint: one-byte release-public drift after reviewed re-pin',
    'scripts/release-public.sh',
  ),

  // Plan 32b Task 5: the scratch lifecycle's load-bearing properties.
  scratchContractMutant('scratch: marker-name-only deletion', (tmp) => rewriteCopy(tmp, HELPER_MJS,
    "if (!('version' in fields) || !('uid' in fields)) return null;", '// name prefix is enough')),
  scratchContractMutant('scratch: failed open-file probe deletes', (tmp) => rewriteCopy(tmp, HELPER_MJS,
    'if (probe.retain) {\n    retain(candidate, probe.retain);\n    return false;\n  }', 'if (probe.retain) return true;')),
  scratchContractMutant('scratch: wrong Task Scheduler task name', (tmp) => rewriteCopy(tmp, MAINTENANCE_PS1,
    "ReviewCleanup = 'mai-mcp-review-scratch-cleanup'", "ReviewCleanup = 'mai-review-cleanup'")),
  scratchContractMutant('scratch: missing -RunLevel Limited', (tmp) => rewriteCopy(tmp, MAINTENANCE_PS1,
    '-LogonType Interactive -RunLevel Limited', '-LogonType Interactive')),
  scratchContractMutant('scratch: missing second temp root', (tmp) => rewriteCopy(tmp, HELPER_MJS,
    "if (platform === 'darwin') roots.push(canonicalRoot(DARWIN_SYSTEM_TMP_ROOT));", '')),
  scratchContractMutant('scratch: wrapper bypassing .mjs', (tmp) => rewriteCopy(tmp, HELPER_SH,
    'exec node "$SCRIPT_DIR/review-scratch.mjs" "$@"', 'rm -rf -- "$2"')),
];

function runSelfTest() {
  const clean = withTempSkills({ fixture: GOOD }, (d, tracked) => runAll(d, tracked));
  if (clean.length > 0) {
    console.error('self-test FAILED: the conforming fixture was flagged:');
    for (const p of clean) console.error(`  ${p}`);
    return 1;
  }
  // G9 conforming control: an un-mutated definitions root must be clean.
  // Without this, fixture-construction rot (e.g. an agent copy landing empty)
  // would leave every G9 mutant "rejected" on the missing-file flag while the
  // census stayed green — gate-level acceptance hiding message-level vacuity.
  const g9Clean = definitionMutant('g9-conforming-control', () => {}).run();
  if (g9Clean.length > 0) {
    console.error('self-test FAILED: conforming reviewer definitions were flagged:');
    for (const p of g9Clean) console.error(`  ${p}`);
    return 1;
  }
  const g9QuotedClean = definitionMutant('g9-quoted-scalar-control', (tmp) => {
    const file = path.join(tmp, '.claude', 'agents', 'plan-reviewer-broad.md');
    fs.writeFileSync(file, fs.readFileSync(file, 'utf8').replace('model: sonnet', 'model: "sonnet"'));
  }).run();
  if (g9QuotedClean.length > 0) {
    console.error('self-test FAILED: valid quoted reviewer frontmatter was flagged:');
    for (const p of g9QuotedClean) console.error(`  ${p}`);
    return 1;
  }
  const g9QuotedCommentClean = definitionMutant('g9-quoted-inline-comment-control', (tmp) => {
    const file = path.join(tmp, '.claude', 'agents', 'plan-reviewer-broad.md');
    fs.writeFileSync(file, fs.readFileSync(file, 'utf8').replace('model: sonnet', 'model: "sonnet" # reviewed tier'));
  }).run();
  if (g9QuotedCommentClean.length > 0) {
    console.error('self-test FAILED: valid quoted reviewer frontmatter with an inline comment was flagged:');
    for (const p of g9QuotedCommentClean) console.error(`  ${p}`);
    return 1;
  }
  const payloadClean = withTempSkills({ 'subagent-rules': PAYLOAD_GOOD }, (d, tracked) => runAll(d, tracked));
  if (payloadClean.length > 0) {
    console.error('self-test FAILED: the conforming payload fixture was flagged:');
    for (const p of payloadClean) console.error(`  ${p}`);
    return 1;
  }
  const dependencyClean = withTempSkills({ fixture: DEPENDENCY_GOOD }, (d, tracked) => runAll(d, tracked));
  if (dependencyClean.length > 0) {
    console.error('self-test FAILED: the complete dependency schema was flagged:');
    for (const p of dependencyClean) console.error(`  ${p}`);
    return 1;
  }
  const referenceClean = withTempSkills(
    { fixture: REFERENCE_GOOD },
    (d, tracked) => runAll(d, tracked),
    { extra: {
      'fixture/references/one.md': 'one',
      'fixture/references/two.md': 'two',
      'fixture/references/three.md': 'three',
    } },
  );
  if (referenceClean.length > 0) {
    console.error('self-test FAILED: conforming reference styles were flagged:');
    for (const p of referenceClean) console.error(`  ${p}`);
    return 1;
  }
  // The two measured real-world verbs must NOT be flagged.
  const verbs = GOOD.replace('Grep for the column and read the file.',
    '3. **Grep for `any`** — subagents love to sneak in type bypasses.\nGrep for the column, the enum literal, the function name. Read the file. Use the source file.');
  const verbClean = withTempSkills({ fixture: verbs }, (d, tracked) => runAll(d, tracked));
  if (verbClean.length > 0) {
    console.error('self-test FAILED: a verb was flagged as a tool name:');
    for (const p of verbClean) console.error(`  ${p}`);
    return 1;
  }
  // Exact retained real-world prose: neither the hyphenated skill name nor
  // ordinary lowercase task noun is a harness tool identifier.
  const retained = GOOD
    .replace('"Using fixture."', '"I\'m using the write-plan skill to build the implementation plan."')
    .replace('Grep for the column and read the file.', "Run the task's verification commands.");
  problems.length = 0;
  gateHarnessLockIn('skills/fixture/SKILL.md', 'fixture', tokenize(retained));
  const retainedClean = [...problems];
  if (retainedClean.length > 0) {
    console.error('self-test FAILED: retained source prose was flagged as a tool mandate:');
    for (const p of retainedClean) console.error(`  ${p}`);
    return 1;
  }
  // A dir without SKILL.md must be caught by package validity.
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'mai-skills-fixture-'));
  let pkgProblems;
  try {
    fs.mkdirSync(path.join(tmp, '_shared'), { recursive: true });
    fs.writeFileSync(path.join(tmp, '_shared', 'notes.md'), 'x');
    pkgProblems = runAll(tmp, new Set());
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
  if (!pkgProblems.some((p) => p.startsWith('package-validity'))) {
    console.error('self-test FAILED: a SKILL.md-less directory was not caught');
    return 1;
  }
  console.log('skills gate self-test OK');
  return 0;
}

function runMutationTest() {
  const survived = [];
  for (const mutant of MUTANTS) {
    const found = mutant.run();
    if (!found.some((p) => p.startsWith(`${mutant.gate}:`))) survived.push(mutant.label);
  }
  if (survived.length > 0) {
    console.error('mutation test FAILED — these mutants were NOT rejected:');
    for (const s of survived) console.error(`  ${s}`);
    return 1;
  }
  console.log(`all ${MUTANTS.length} skill-gate mutations rejected`);
  return 42;
}

export function main(argv = process.argv.slice(2)) {
  if (argv[0] === '--self-test') return runSelfTest();
  if (argv[0] === '--mutation-test') return runMutationTest();
  if (argv[0] === '--reviewer-package' && argv.length === 2) {
    problems.length = 0;
    gateReviewerDefinitions(path.resolve(argv[1]), { requireRelease: false, exactInventory: true });
    if (problems.length > 0) {
      console.error('reviewer package: FAILED');
      for (const p of problems) console.error(`  ${p}`);
      return 1;
    }
    console.log('reviewer package: clean');
    return 0;
  }
  if (argv.length > 0) {
    console.error(`unknown mode: ${argv.join(' ')}`);
    return 1;
  }
  const found = runAll(SKILLS_DIR);
  if (found.length > 0) {
    console.error('skills gate: FAILED');
    for (const p of found) console.error(`  ${p}`);
    return 1;
  }
  console.log('skills gate: clean');
  return 0;
}

const invoked = process.argv[1]
  ? import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href
  : false;
if (invoked) process.exitCode = main();
