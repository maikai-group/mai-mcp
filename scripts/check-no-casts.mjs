// Whole-tree AST ratchet for iron rule 7 / global lesson 293a39bc:
// no new type assertions (except `as const`), non-null assertions, `any`, or
// ts-ignore/nocheck/expect-error. Explicit file arguments retain strict
// zero-tolerance. @ts-expect-error is a suppression like the others: it silences
// the compiler for a line, so it belongs to the same ratchet (plan 38 R10).
import ts from 'typescript';
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(SCRIPT_DIR, '..');
const BASELINE_FILE = path.join(SCRIPT_DIR, 'check-no-casts-baseline.json');
// Iron rule 7 applies to the whole product, not just the server. `frontend/src`
// was never walked before plan 29, which is why R14 was unenforceable there.
const SCAN_ROOTS = ['src', 'frontend/src'].map((r) => path.join(REPO_ROOT, r));
// Baseline keys are POSIX-relative on every platform: Windows path.relative
// yields backslashes, and a key that differs by separator is not drift.
const relativeKey = (file) => path.relative(REPO_ROOT, file).split(path.sep).join('/');
// A scan root that does not exist is skipped rather than fatal: the committed
// cast-gate fixture copies this script into a synthetic root that has `src`
// only, and an ENOENT there would fail a gate for the wrong reason.
const allSourceFiles = () =>
  SCAN_ROOTS.filter((root) => existsSync(root)).flatMap((root) => sourceFiles(root)).sort();
const KINDS = ['as-assertion', 'angle-bracket assertion', 'non-null assertion', 'any', 'ts-suppression'];

function sourceFiles(dir) {
  const out = [];
  for (const name of readdirSync(dir)) {
    const full = path.join(dir, name);
    const stat = statSync(full);
    if (stat.isDirectory()) out.push(...sourceFiles(full));
    else if (/\.(?:[cm]?ts|tsx)$/.test(name)) out.push(full);
  }
  return out.sort();
}

function scan(file, { report }) {
  const text = readFileSync(file, 'utf8');
  const src = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true);
  const counts = Object.fromEntries(KINDS.map((kind) => [kind, 0]));
  const where = (node) => `${relativeKey(file)}:${src.getLineAndCharacterOfPosition(node.getStart(src)).line + 1}`;
  const flag = (node, kind) => {
    counts[kind] += 1;
    if (report) console.error(`${where(node)}: ${kind}: ${node.getText(src).slice(0, 60)}`);
  };
  const visit = (node) => {
    if (ts.isAsExpression(node) && node.type.getText(src) !== 'const') flag(node, 'as-assertion');
    if (ts.isTypeAssertionExpression(node)) flag(node, 'angle-bracket assertion');
    if (ts.isNonNullExpression(node)) flag(node, 'non-null assertion');
    if (node.kind === ts.SyntaxKind.AnyKeyword) flag(node, 'any');
    ts.forEachChild(node, visit);
  };
  visit(src);
  if (/@ts-(ignore|nocheck|expect-error)/.test(text)) {
    counts['ts-suppression'] += 1;
    if (report) console.error(`${relativeKey(file)}: ts-suppression directive`);
  }
  return Object.fromEntries(Object.entries(counts).filter(([, count]) => count > 0));
}

const requested = process.argv.slice(2);
if (requested.length === 1 && requested[0] === '--print-baseline') {
  const generated = {};
  for (const file of allSourceFiles()) {
    const counts = scan(file, { report: false });
    if (Object.keys(counts).length > 0) generated[relativeKey(file)] = counts;
  }
  console.log(`${JSON.stringify(generated, null, 2)}\n`);
  process.exit(0);
}
if (requested.length > 0) {
  let total = 0;
  for (const name of requested) {
    const counts = scan(path.resolve(name), { report: true });
    total += Object.values(counts).reduce((sum, count) => sum + count, 0);
  }
  if (total > 0) {
    console.error(`check-no-casts: ${total} banned construct(s)`);
    process.exit(1);
  }
  console.log('check-no-casts: clean');
  process.exit(0);
}

if (!existsSync(BASELINE_FILE)) {
  console.error(`check-no-casts: reviewed baseline is missing: ${path.relative(REPO_ROOT, BASELINE_FILE)}`);
  process.exit(1);
}
const parsed = JSON.parse(readFileSync(BASELINE_FILE, 'utf8'));
if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
  console.error('check-no-casts: baseline must be a JSON object');
  process.exit(1);
}

const files = allSourceFiles();
const actual = {};
for (const file of files) {
  const counts = scan(file, { report: false });
  if (Object.keys(counts).length > 0) actual[relativeKey(file)] = counts;
}

let drift = 0;
for (const file of [...new Set([...Object.keys(parsed), ...Object.keys(actual)])].sort()) {
  const expectedCounts = parsed[file] ?? {};
  const actualCounts = actual[file] ?? {};
  for (const kind of KINDS) {
    const expected = expectedCounts[kind] ?? 0;
    const found = actualCounts[kind] ?? 0;
    if (expected !== found) {
      console.error(`${file}: ${kind} baseline drift — expected ${expected}, found ${found}`);
      drift += 1;
    }
  }
}
if (drift > 0) {
  console.error(`check-no-casts: ${drift} baseline drift(s)`);
  process.exit(1);
}
console.log(`check-no-casts: clean (${files.length} source files; ${Object.keys(actual).length} legacy baselines)`);
