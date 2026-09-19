#!/usr/bin/env node
// plan-closure-lint — mechanical closure checks for an implementation plan.
//
// WHY THIS EXISTS. Across three blind passes on plans 46 and 47 the single most
// recurrent finding family was the "repair shadow": a correction stated in PROSE
// that never reached the two structured places execution actually reads —
//   (1) a task's `Files:` block and its `git add` pathspec, and
//   (2) the declaration of an identifier a code block uses.
// Reviewers caught each instance individually; prose fixes produced the next
// instance. This is the mechanical guard that prose could not be.
//
// Usage: node plan-closure-lint.mjs <plan.md> [--repo <root>]
// Exit 0 = clean, 1 = findings.

import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

const args = process.argv.slice(2);
const planPath = args[0];
const repoRoot = args.includes('--repo') ? args[args.indexOf('--repo') + 1] : process.cwd();
if (!planPath) { console.error('usage: plan-closure-lint.mjs <plan.md> [--repo <root>]'); process.exit(2); }

const text = fs.readFileSync(planPath, 'utf8');
const lines = text.split('\n');
const problems = [];
const note = (kind, msg) => problems.push({ kind, msg });

// ---------------------------------------------------------------- structure
// Split into tasks. A task opens at a `## Task N` or `### Task N` heading
// (plans 32a/32b nest tasks one level deeper) and owns everything up to the
// next heading of its own level or higher — so a ### task ends at its ###
// sibling AND at the ## section that follows, and a ## task keeps any ###
// sub-headings inside it.
// A `# comment` inside a bash fence is not a heading: a plan whose commit
// fence carries a VC1 note would otherwise lose the `git add` that follows it.
const inFence = [];
{
  let open = false;
  for (const l of lines) { if (l.startsWith('```')) open = !open; inFence.push(open || l.startsWith('```')); }
}
const headingLevel = (i) => (inFence[i] ? 0 : (/^(#+)\s/.exec(lines[i])?.[1].length ?? 0));
const taskStarts = [];
lines.forEach((l, i) => { if (!inFence[i] && /^#{2,3} Task /.test(l)) taskStarts.push(i); });
const sectionEnd = (start) => {
  const level = headingLevel(start);
  for (let i = start + 1; i < lines.length; i++) {
    const at = headingLevel(i);
    if (at > 0 && at <= level) return i;
  }
  return lines.length;
};
const tasks = taskStarts.map((s) => ({
  title: lines[s].replace(/^#+\s*/, '').trim(),
  start: s,
  end: sectionEnd(s),
  body: lines.slice(s, sectionEnd(s)).join('\n'),
}));

// ------------------------------------------------------------- path harvest
// Anchored with a lookbehind rather than \b so `skills/x/scripts/y.sh` is one
// path, not also `scripts/y.sh`. Root files a plan can own are listed by name.
// `*`, `$`, `{` and `}` are harvested on purpose: a generated output declared as
// one literal glob is ownable, and a `${VAR}` path a task stages is visible —
// the old class dropped both, so a plan could stage a file it never declared.
const PATH_RE = /(?<![A-Za-z0-9_@./*${}-])((?:src|frontend|scripts|docs|db|hooks|skill-blocks|skills|installer|release|\.github|\.claude)\/[A-Za-z0-9_@./*${}-]+\.[A-Za-z0-9]+|package\.json|package-lock\.json|README\.md|CLAUDE\.md)/g;
const harvest = (s) => new Set([...s.matchAll(PATH_RE)].map((m) => m[1].replace(/[.,;:)]+$/, '')));

// File Map rows: | Create | `path` | responsibility |
const fileMap = new Map(); // path -> action
for (const l of lines) {
  const m = /^\|\s*(Create|Modify)\s*\|\s*`([^`]+)`\s*\|/.exec(l);
  if (m) fileMap.set(m[2], m[1]);
}
if (fileMap.size === 0) note('structure', 'no File Map rows found — cannot check file closure');

// Per-task Files: blocks and git add pathspecs
for (const t of tasks) {
  const filesBlock = /\*\*Files:\*\*\s*\n((?:\s*-\s*(?:Create|Modify):.*\n)+)/.exec(t.body);
  t.files = filesBlock ? harvest(filesBlock[1]) : new Set();
  // Only the lines that say Create: a later task may Modify a file an earlier
  // task created; that is sequential ownership, not ambiguity.
  t.creates = filesBlock
    ? harvest(filesBlock[1].split('\n').filter((l) => /^\s*-\s*Create:/.test(l)).join('\n'))
    : new Set();
  // Each continued line must be matched as a unit — a greedy [^\n]* eats the
  // trailing backslash and the continuation can then never match, which silently
  // reports correctly-staged files as unstaged.
  const adds = [...t.body.matchAll(/git add ((?:[^\n]*\\\n)*[^\n]*)/g)].map((m) => m[1]);
  t.staged = harvest(adds.join(' '));
  t.mentioned = harvest(t.body);
}

// ------------------------------------------------- CHECK 1: file closure
for (const [p, action] of fileMap) {
  const owners = tasks.filter((t) => t.files.has(p));
  if (owners.length === 0) {
    note('file-closure', `File Map lists ${action} \`${p}\` but NO task's Files: block names it`);
    continue;
  }
  // A Created file has exactly one creator; a Modified file may legitimately be
  // edited by several sequential tasks, provided EACH stages its own edit (the
  // per-owner staging check below still applies to every owner).
  if (action === 'Create') {
    const creators = owners.filter((t) => t.creates.has(p));
    if (creators.length > 1) {
      note('file-closure', `\`${p}\` is created by ${creators.length} tasks (${creators.map((o) => o.title.split(':')[0]).join(', ')}) — a Create row has ambiguous ownership`);
    } else if (creators.length === 0) {
      note('file-closure', `File Map says Create \`${p}\` but no task's Files: block creates it (${owners.map((o) => o.title.split(':')[0]).join(', ')} only modify it)`);
    }
  }
  for (const o of owners) {
    if (!o.staged.has(p)) {
      note('file-closure', `${o.title.split(':')[0]}: Files: names \`${p}\` but its \`git add\` does not stage it`);
    }
  }
}

// Reverse: a task stages or lists something the File Map never declared
const selfPath = planPath.replace(/^\.\//, '').replace(process.cwd() + '/', '');
const isSelf = (p) => selfPath.endsWith(p) || p.endsWith(path.basename(planPath));
for (const t of tasks) {
  for (const p of new Set([...t.files, ...t.staged])) {
    if (isSelf(p)) continue;   // the closeout commit stages the plan itself
    if (!fileMap.has(p)) {
      note('file-closure', `${t.title.split(':')[0]}: touches \`${p}\` but it is in no File Map row`);
    }
  }
}

// Prose-mentioned edits that never became a File Map row. Only flag paths the
// plan speaks about editing, to keep this from firing on every citation.
const EDIT_VERB = /\b(add(?:ing)?|insert|replace|extend|update|edit|modify|delete|remove|re-?point|register)\b/i;
// A path may be quoted relative to a subdirectory the command cd's into
// (`cd frontend && npx vitest run src/views/...`); it is covered when a File
// Map row ends with it, so only genuinely unmapped paths are reported.
const coveredByMap = (p) => fileMap.has(p) || [...fileMap.keys()].some((k) => k.endsWith('/' + p));
for (const t of tasks) {
  for (const p of t.mentioned) {
    if (coveredByMap(p) || isSelf(p)) continue;
    const hit = t.body.split('\n').find((l) => l.includes(p) && EDIT_VERB.test(l));
    if (hit) note('file-closure', `${t.title.split(':')[0]}: prose says it edits \`${p}\` ("${hit.trim().slice(0, 80)}…") but it is in no File Map row`);
  }
}

// ------------------------------------------- CHECK 2: identifier closure
// Identifiers used inside plan code blocks that the plan never declares and
// that do not exist in the repo. Deliberately conservative: only flags
// call-position and member-root identifiers, and only camelCase locals.
const codeBlocks = [...text.matchAll(/```(?:ts|tsx|js|jsx)\n([\s\S]*?)```/g)].map((m) => m[1]);
const allCode = codeBlocks.join('\n');

// A plan split into a series declares its predecessor in the header. That plan's
// code has not reached the repo yet, so without this every symbol the first plan
// introduces reads as undeclared in the second — noise that trains an author to
// ignore the check. Predecessor code counts as DECLARATIONS only; uses are still
// this plan's own.
const predecessor = text.match(/\*\*Depends on plan:\*\*[^\n]*?`([^`]+\.md)`/);
let inheritedCode = '';
if (predecessor !== null) {
  const abs = path.isAbsolute(predecessor[1]) ? predecessor[1] : path.join(repoRoot, predecessor[1]);
  try {
    inheritedCode = [...fs.readFileSync(abs, 'utf8').matchAll(/```(?:ts|tsx|js|jsx)\n([\s\S]*?)```/g)]
      .map((m) => m[1]).join('\n');
  } catch {
    note('citation-drift', `header names predecessor plan \`${predecessor[1]}\` but it cannot be read from ${repoRoot}`);
  }
}
const declCode = `${allCode}\n${inheritedCode}`;

const declared = new Set();
for (const re of [
  /\b(?:const|let|var|function|class|interface|type|enum)\s+([A-Za-z_$][\w$]*)/g,
  /import\s+\{([^}]*)\}/g,
  /\b([A-Za-z_$][\w$]*)\s*[:,]\s*(?:string|number|boolean|unknown|MutableRefObject)/g,
]) {
  for (const m of declCode.matchAll(re)) {
    for (const part of m[1].split(/[,\s]+/)) {
      const id = part.replace(/\bas\b.*/, '').trim();
      if (id) declared.add(id);
    }
  }
}
// Function params: crude but effective — anything inside a param list.
for (const m of declCode.matchAll(/\(([^)]*)\)\s*(?::[^=]*)?=>/g)) {
  for (const part of m[1].split(',')) {
    const id = part.trim().split(/[:\s=]/)[0];
    if (id) declared.add(id);
  }
}
for (const m of declCode.matchAll(/function\s+\w*\s*\(([^)]*)\)/g)) {
  for (const part of m[1].split(',')) {
    const id = part.trim().split(/[:\s=?]/)[0];
    if (id) declared.add(id);
  }
}
// Multi-line signatures and interface members: `[^)]*` above cannot cross a
// nested `)` (e.g. a callback-typed parameter), so any param after one was
// invisible and reported undeclared. An indented `name:` / `name?:` line is a
// declaration site in every such construct. Over-capturing (object keys also
// match) only shrinks the finding set, never invents one.
for (const m of declCode.matchAll(/^\s+([A-Za-z_$][\w$]*)\??:\s/gm)) {
  declared.add(m[1]);
}

// Everything the repo exports or defines, so a citation counts as a declaration.
let repoSymbols = new Set();
const repoFiles = new Map(); // absolute path -> source, reused by checks 3-5
const walk = (dir, depth = 0) => {
  if (depth > 6) return;
  let entries = [];
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
  for (const e of entries) {
    if (e.name === 'node_modules' || e.name === '.git' || e.name === 'build' || e.name === 'dist') continue;
    const full = path.join(dir, e.name);
    if (e.isDirectory()) walk(full, depth + 1);
    else if (/\.(ts|tsx|mjs|js)$/.test(e.name)) {
      let src = '';
      try { src = fs.readFileSync(full, 'utf8'); } catch { continue; }
      for (const m of src.matchAll(/\b(?:const|let|var|function|class|interface|type|enum)\s+([A-Za-z_$][\w$]*)/g)) repoSymbols.add(m[1]);
      for (const m of src.matchAll(/^\s*([A-Za-z_$][\w$]*)\s*[(:,]/gm)) repoSymbols.add(m[1]);
      repoFiles.set(full, src);
    }
  }
};
for (const d of ['src', 'frontend/src', 'scripts']) walk(path.join(repoRoot, d));

const GLOBALS = new Set(['console','Math','JSON','Number','String','Boolean','Array','Object','Set','Map','Promise','Date','Error','RangeError','TypeError','process','require','module','exports','window','document','fs','path','crypto','URL','Symbol','BigInt','RegExp','isNaN','parseInt','parseFloat','setTimeout','clearTimeout','setInterval','clearInterval','undefined','null','true','false','this','super','await','async','return','if','else','for','while','switch','case','break','continue','new','typeof','instanceof','in','of','let','const','var','function','class','extends','implements','import','export','from','as','default','try','catch','finally','throw','delete','void','yield','static','get','set','public','private','protected','readonly','abstract','declare','namespace','expect','it','describe','beforeEach','afterEach','beforeAll','afterAll','vi','test']);

// Comments and string literals are prose, not code: an identifier named only in
// a `//` line is a citation, not a use. Stripping them is what separates a real
// undeclared symbol from the author explaining Math.sqrt in a sentence.
const stripProse = (s) => s
  .replace(/\/\*[\s\S]*?\*\//g, ' ')
  .split('\n').map((l) => l.replace(/\/\/.*$/, '')).join('\n')
  .replace(/`(?:[^`\\]|\\.)*`/g, '``')
  .replace(/'(?:[^'\\]|\\.)*'/g, "''")
  .replace(/"(?:[^"\\]|\\.)*"/g, '""');

// Destructured state: `const [hero, setHero] = useState(...)`
for (const m of declCode.matchAll(/\b(?:const|let)\s*\[([^\]]*)\]/g)) {
  for (const part of m[1].split(',')) { const id = part.trim(); if (id) declared.add(id); }
}
// Destructured objects/imports: `const { a, b } = ...`
for (const m of declCode.matchAll(/\b(?:const|let)\s*\{([^}]*)\}/g)) {
  for (const part of m[1].split(',')) {
    const id = part.split(':').pop().trim();
    if (id) declared.add(id);
  }
}

const used = new Map(); // id -> first line snippet
for (const block of codeBlocks) {
  const code = stripProse(block);
  // (?<![.\w$]) — never flag a PROPERTY. `Math.cbrt(` must not report `cbrt`.
  for (const m of code.matchAll(/(?<![.\w$])([a-z_$][\w$]*)\s*\(/g)) {
    const id = m[1];
    if (!used.has(id)) used.set(id, block.split('\n').find((l) => l.includes(id + '(')) ?? '');
  }
  for (const m of code.matchAll(/(?<![.\w$])([a-z_$][\w$]*)\.[A-Za-z_$]/g)) {
    const id = m[1];
    if (!used.has(id)) used.set(id, block.split('\n').find((l) => l.includes(id + '.')) ?? '');
  }
}

for (const [id, snippet] of used) {
  if (GLOBALS.has(id) || declared.has(id) || repoSymbols.has(id)) continue;
  if (id.length <= 2) continue;
  note('identifier-closure', `code block uses \`${id}\` — not declared in the plan and not found in the repo ("${snippet.trim().slice(0, 78)}…")`);
}


// ------------------------------------------- CHECK 3: fence working directory
// WHY THIS EXISTS. Plan 48's passes 5 and 6 each found a bash fence whose
// commands could not run from the directory the PREVIOUS fence left behind —
// twice on a `git add` block, where the paired `git commit` still runs and can
// ship another session's staged work. A plan's fences execute in one persistent
// shell, so a fence that does not establish its own directory inherits one.
// The hazard only exists once some fence changes directory; when none does,
// this check stays silent.
const FENCE_ANCHOR = /^cd\s+"\$\(git rev-parse --show-toplevel\)/;
const CWD_SENSITIVE = /^\s*(npm|npx|node|bash|git|pnpm|yarn|\.\/|scripts\/|db\/)\b/;
const bashFences = [];
for (let i = 0; i < lines.length; i += 1) {
  if (!/^```(bash|sh)\s*$/.test(lines[i])) continue;
  let j = i + 1;
  while (j < lines.length && !lines[j].startsWith('```')) j += 1;
  bashFences.push({ line: i + 1, body: lines.slice(i + 1, j) });
  i = j;
}
if (bashFences.some((f) => f.body.some((l) => /^\s*cd\s/.test(l)))) {
  for (const f of bashFences) {
    const first = (f.body.find((l) => l.trim() !== '') ?? '').trim();
    if (FENCE_ANCHOR.test(first)) continue;
    const sensitive = f.body.find((l) => CWD_SENSITIVE.test(l));
    if (!sensitive) continue;
    note('fence-cwd', `fence at line ${f.line} runs \`${sensitive.trim().slice(0, 58)}\` but does not open with \`cd "$(git rev-parse --show-toplevel)"\` — another fence in this plan changes directory and they share one shell`);
  }
}

// ------------------------------------------ CHECK 4: seam-pin discrimination
// WHY THIS EXISTS. Plan 48 pass 6 blocked on a source pin that could never
// fail: `toContain("objective={state.objective}")` is a SUBSTRING of the
// pre-existing `data-objective={state.objective}`, so it matched before the
// plan changed anything and the mutant written to break it survived. A pin
// whose match lands inside a longer token is not a pin.
const WORDISH = /[A-Za-z0-9_$-]/;
const reportedPins = new Set();
for (const m of allCode.matchAll(/\.toContain\(\s*"((?:[^"\\]|\\.)*)"\s*\)/g)) {
  const literal = m[1].replace(/\\"/g, '"').replace(/\\\\/g, '\\');
  if (literal.length < 8 || reportedPins.has(literal)) continue;
  for (const [file, src] of repoFiles) {
    let at = src.indexOf(literal);
    let shadowed = -1;
    while (at !== -1) {
      if (at > 0 && WORDISH.test(src[at - 1])) { shadowed = at; break; }
      at = src.indexOf(literal, at + 1);
    }
    if (shadowed === -1) continue;
    const lineNo = src.slice(0, shadowed).split('\n').length;
    reportedPins.add(literal);
    note('pin-shadow', `pin "${literal.slice(0, 44)}…" already matches INSIDE a longer token at ${path.relative(repoRoot, file)}:${lineNo} — it passes without the plan's change; anchor it (toMatch(/\\n\\s+…/))`);
    break;
  }
}

// -------------------------------------- CHECK 5: citations and import claims
// WHY THIS EXISTS. Across plans 46-48 the most-repeated warning family was a
// claim about code the plan does NOT change: a `file:line` anchor that had
// moved, or "`X` joins the `./model` import" naming a file with no such
// import, which leaves the executor no line to extend. Both are mechanical.
const basenameIndex = new Map();
for (const abs of repoFiles.keys()) {
  const b = path.basename(abs);
  if (!basenameIndex.has(b)) basenameIndex.set(b, []);
  basenameIndex.get(b).push(abs);
}
const resolveRef = (ref) => {
  const direct = path.join(repoRoot, ref);
  if (repoFiles.has(direct)) return [direct];
  return (basenameIndex.get(path.basename(ref)) ?? [])
    .filter((abs) => abs.endsWith('/' + ref) || path.basename(abs) === ref);
};
const seenCite = new Set();
for (const m of text.matchAll(/`([A-Za-z0-9_@./-]+\.(?:ts|tsx|mjs|js)):(\d+)(?:-(\d+))?`/g)) {
  if (seenCite.has(m[0])) continue;
  seenCite.add(m[0]);
  const end = Number(m[3] ?? m[2]);
  const candidates = resolveRef(m[1]);
  if (candidates.length === 0) continue; // a file this plan creates, or outside the walk
  if (candidates.some((abs) => repoFiles.get(abs).split('\n').length >= end)) continue;
  const shown = path.relative(repoRoot, candidates[0]);
  note('citation-drift', `citation \`${m[1]}:${m[2]}${m[3] ? '-' + m[3] : ''}\` points past the end of ${shown} (${repoFiles.get(candidates[0]).split('\n').length} lines)`);
}
// Both word orders occur in practice: "joins the `./model` import" and
// "joins the type imports from `./model`". Missing the second is how the
// pass-6 instance of this family reached a reviewer.
const IMPORT_CLAIMS = [
  /`([A-Za-z0-9_]+)`\s+joins\s+[^`\n]{0,60}?`([^`\n]+)`\s+import/g,
  /`([A-Za-z0-9_]+)`\s+joins\s+[^`\n]{0,60}?imports?\s+from\s+`([^`\n]+)`/g,
];
for (const m of IMPORT_CLAIMS.flatMap((re) => [...text.matchAll(re)])) {
  const before = text.slice(0, m.index);
  const files = [...before.matchAll(/`([A-Za-z0-9_@./-]+\.(?:ts|tsx))(?::\d+(?:-\d+)?)?`/g)];
  if (files.length === 0) continue;
  const candidates = resolveRef(files[files.length - 1][1]);
  if (candidates.length !== 1) continue;
  const spec = m[2].replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  if (new RegExp(`from\\s+['"]${spec}['"]`).test(repoFiles.get(candidates[0]))) continue;
  note('citation-drift', `"\`${m[1]}\` joins the \`${m[2]}\` import" resolves to ${path.relative(repoRoot, candidates[0])}, which has NO import from \`${m[2]}\` — the executor has no line to extend`);
}

// ------------------------------------------- CHECK 6: census arithmetic
// WHY THIS EXISTS. Plan 48b-2 shipped `grep -c "setCameraObjective(" Graph.tsx
// # expected 2 - the declaration and the single write`. The declaration is a
// destructuring, so the identifier is followed by `]`, not `(`, and the real
// count is 1. The plan's own rule ("a count other than this means a second
// producer exists") would therefore have stopped the executor on CORRECT code.
// A census is a gate; a gate that cannot return its expected value is worse
// than no gate. Narrow on purpose: it fires only when the rationale itself
// claims to be counting the declaration.
const CENSUS = /grep -c "([^"]+)"\s+(\S+)[^\n#]*#\s*expected\s+(\d+)([^\n]*)/g;
for (const m of text.matchAll(CENSUS)) {
  const [, pat, file, exp, rationale] = m;
  const ident = /^([A-Za-z_$][A-Za-z0-9_$]*)\($/.exec(pat);
  // The rationale must COUNT the declaration, not merely mention it — a
  // corrected census that explains why the declaration is excluded would
  // otherwise re-trip this check forever.
  if (ident === null || !/\bdeclarations?\s+(?:and|plus|\+)\b/i.test(rationale)) continue;
  const name = ident[1];
  const destructured = new RegExp(`(?:const|let)\\s*\\[[^\\]]*\\b${name}\\b[^\\]]*\\]`).test(allCode);
  const assigned = new RegExp(`(?:const|let)\\s+${name}\\s*=`).test(allCode);
  if (!destructured && !assigned) continue;
  note('census-arithmetic', `census \`grep -c "${pat}" ${file}\` expects ${exp} and its rationale counts the declaration, but this plan declares \`${name}\` as ${destructured ? 'a destructuring' : 'an assignment'} — the identifier is not followed by "(" there, so the declaration line cannot match. The census fires on correct code`);
}

// -------------------------------------- CHECK 7: claims repaired in one place
// WHY THIS EXISTS. The single most expensive habit in this workflow is fixing
// the cited site and leaving a sibling. Plan 48b-1 repaired R5's "the only way
// a request is dropped" and left the identical false claim in a fence comment
// fifteen lines away - a comment that SHIPS into Landscape.tsx, so one source
// file would have asserted both. The mechanical form: when a line is edited,
// a near-duplicate of the text you removed should not survive elsewhere.
//
// WHAT THIS CANNOT SEE, stated because an understated limit is how a check gets
// cited as coverage it does not provide. It finds a sibling that REPEATS the
// wording you removed. It cannot find one that CONTRADICTS the wording you
// added: plan 48b-2 retracted "the four exit variants differ" in prose and left
// `// what precedes it differs per exit variant` in a shipping comment fifteen
// lines below, sharing too few words with the deleted text to score. Catching
// that needs semantics, not containment. So when you repair a claim, still grep
// for what the claim was ABOUT, not only for the sentence you deleted.
const gitRef = args.includes('--against') ? args[args.indexOf('--against') + 1] : 'HEAD';
if (!args.includes('--no-history')) {
  let previous = null;
  try {
    previous = execFileSync('git', ['show', `${gitRef}:${selfPath}`], {
      cwd: repoRoot, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'],
    });
  } catch { previous = null; }   // new file, or not a git tree: nothing to compare
  if (previous !== null) {
    const words = (l) => l.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim().split(' ').filter((w) => w.length > 2);
    // A claim is a SENTENCE, not a line. Comment blocks and prose paragraphs
    // wrap, so "This is the only way a / request is dropped" is invisible to
    // any line-level comparison - which is precisely the sibling that survived
    // plan 48b-1's repair. Merge consecutive lines of the same kind first.
    const units = (src) => {
      const out = [];
      let buf = null;
      let fence = false;
      src.split('\n').forEach((raw, i) => {
        const t = raw.trim();
        if (t.startsWith('```')) { fence = !fence; buf = null; return; }
        // Inside a fence only `//` and `/* … */` commentary can carry a claim;
        // code (even a capitalised PowerShell line) never does. Outside, a
        // `**bold**`-led line is prose, not a comment.
        if (fence && !/^(\/\/|\/\*|\*(?!\*))/.test(t)) { buf = null; return; }
        const comment = /^(\/\/|\*(?!\*)|\/\*)/.test(t);
        // Headings are titles, not assertions: they cannot "still assert" what
        // an edit removed, and they share vocabulary with every paragraph under
        // them, so including them fires on ordinary section names. Excluded as a
        // correctness fix, pinned by its own case below.
        const prose = !/^#/.test(t) && /^[-*|>#]|^\*\*|^[A-Z(]/.test(t) && !/[;{}]\s*$/.test(t)
          && !/^(const|let|return|expect|await|import|export|it\(|describe\()/.test(t);
        const kind = comment ? 'comment' : (prose ? 'prose' : null);
        if (kind === null || t.length === 0) { buf = null; return; }
        // A table row or a list item is a claim of its own: merging a File Map
        // into one unit made deleting a single row "remove" the whole table.
        // A bold-led line (`**Date:**`, `**Revision…**`) is a claim of its own too:
        // a plan header merged into one unit indicts every short survivor when one
        // header line is appended.
        const starter = kind === 'prose' && /^([-*|>]|\d+\.)\s|^\*\*/.test(t);
        if (buf !== null && buf.kind === kind && !starter) { buf.text += ' ' + t; return; }
        buf = { kind, line: i + 1, text: t };
        out.push(buf);
      });
      return out;
    };
    // CONTAINMENT, not similarity. The surviving sibling is usually far shorter
    // than the paragraph you edited, so dividing by the longer side scores it
    // near zero and hides exactly the case this check exists for.
    const contains = (removedWords, unitWords) => {
      const rs = new Set(removedWords);
      const u = [...new Set(unitWords)];
      if (u.length < 8) return 0;
      return u.filter((w) => rs.has(w)).length / u.length;
    };
    const prevUnits = new Set(units(previous).map((u) => u.text));
    // Score against the best SINGLE removed sentence, never the bag of every
    // removed word. A multi-paragraph edit's bag saturates, and then every
    // untouched sibling that shares the edit's vocabulary scores 85%+ — plan
    // 32b's Task 5 re-author indicted two lines no removed sentence resembled.
    const currentUnits = new Set(units(text).map((u) => u.text));
    const removedUnits = units(previous)
      .filter((u) => !currentUnits.has(u.text))
      .map((u) => words(u.text));
    const bestContainment = (unitWords) =>
      removedUnits.reduce((best, rw) => Math.max(best, contains(rw, unitWords)), 0);
    // A Files: inventory line (`- Create: \`path\``) is not a claim — CHECK 1
    // owns it — and its only words are path tokens a rewritten paragraph
    // naturally shares.
    const inventory = (u) => /^-\s*(Create|Modify|Delete):/.test(u.text);
    const survivors = units(text)
      .filter((u) => prevUnits.has(u.text))          // untouched by this edit
      .filter((u) => !inventory(u))
      .map((u) => ({ ...u, score: bestContainment(words(u.text)) }))
      .filter((u) => u.score >= 0.85)
      .sort((a, b) => b.score - a.score)
      .slice(0, 5);
    for (const u of survivors) {
      note('claim-survives', `line ${u.line}: this ${u.kind} was not touched by the edit, yet ${Math.round(u.score * 100)}% of its wording appears in text the edit REMOVED — "${u.text.slice(0, 100)}…". If the claim was wrong there it is wrong here. Repair the shape, not the cited site`);
    }
  }
}

// ----------------------------------------------------------------- report
const byKind = problems.reduce((a, p) => { (a[p.kind] ??= []).push(p.msg); return a; }, {});
const total = problems.length;
console.log(`plan-closure-lint: ${path.basename(planPath)}`);
console.log(`  tasks: ${tasks.length} | File Map rows: ${fileMap.size} | code blocks: ${codeBlocks.length}`);
for (const [kind, msgs] of Object.entries(byKind)) {
  console.log(`\n  ${kind} (${msgs.length}):`);
  for (const m of msgs) console.log(`    - ${m}`);
}
if (total === 0) console.log('\n  CLEAN — every File Map row is owned and staged; no undeclared identifiers;\n  every fence self-locates, every pin discriminates, every citation resolves.');
console.log(`\n  total: ${total}`);
process.exit(total === 0 ? 0 : 1);
