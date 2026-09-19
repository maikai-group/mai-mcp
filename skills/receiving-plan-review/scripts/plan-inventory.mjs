#!/usr/bin/env node

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

function usage(message) {
  if (message) console.error(message);
  console.error('Usage: plan-inventory.mjs <plan.md> [--output file.json] [--compare before.json]');
  process.exit(2);
}

const args = process.argv.slice(2);
if (args.length === 0) usage();
const planPath = path.resolve(args[0]);
let outputPath;
let comparePath;
for (let i = 1; i < args.length; i++) {
  if (args[i] === '--output') outputPath = args[++i];
  else if (args[i] === '--compare') comparePath = args[++i];
  else usage(`Unknown argument: ${args[i]}`);
}
if ((args.includes('--output') && !outputPath) || (args.includes('--compare') && !comparePath)) usage();
if (!fs.existsSync(planPath)) usage(`Plan not found: ${planPath}`);

const text = fs.readFileSync(planPath, 'utf8');
const lines = text.split(/\r?\n/);
const locations = (predicate) => lines.flatMap((line, i) => predicate(line) ? [{ line: i + 1, text: line.trim() }] : []);
const matches = (re) => locations((line) => re.test(line));

const fileMap = [];
for (let i = 0; i < lines.length; i++) {
  const m = /^\|\s*(Create|Modify|Delete|Move|Rename)\s*\|\s*`([^`]+)`\s*\|/i.exec(lines[i]);
  if (m) fileMap.push({ line: i + 1, action: m[1].toLowerCase(), path: m[2] });
}

const requirements = [];
for (let i = 0; i < lines.length; i++) {
  const m = /^\s*-\s+(R\d+):\s*(.+)/.exec(lines[i]);
  if (m) requirements.push({ line: i + 1, id: m[1], text: m[2] });
}

const fences = [];
let openFence;
for (let i = 0; i < lines.length; i++) {
  const m = /^\s*(`{3,}|~{3,})(.*)$/.exec(lines[i]);
  if (!m) continue;
  const marker = m[1][0];
  const length = m[1].length;
  if (!openFence) {
    openFence = { line: i + 1, marker, length, info: m[2].trim() };
  } else if (openFence.marker === marker && length >= openFence.length && m[2].trim() === '') {
    fences.push({ ...openFence, closeLine: i + 1 });
    openFence = undefined;
  }
}

const placeholders = matches(/\b(TBD|TODO|implement later|fill in details|add appropriate error handling|handle edge cases)\b/i);
const numericClaims = locations((line) => /\b\d[\d,]*\s+(tests?|passed|failed|skipped|files?|tasks?|steps?)\b/i.test(line));
const testCases = locations((line) => /^\s*(?:it|test)(?:\.(?:each|skip|todo|only))?\s*\(/.test(line));
const inventory = {
  version: 1,
  path: planPath,
  sha256: crypto.createHash('sha256').update(text).digest('hex'),
  bytes: Buffer.byteLength(text),
  lines: lines.length,
  requirements,
  tasks: matches(/^###\s+Task\s+\d+/),
  steps: matches(/^\s*-\s*\[[ xX]\]\s+\*\*Step\s+/),
  describes: matches(/^\s*describe\s*\(/),
  testCases,
  runCommands: matches(/^\s*Run:\s*/i),
  expectedStatements: matches(/^\s*Expected(?:\s*\([^)]*\))?:\s*/i),
  fileMap,
  placeholders,
  numericClaims,
  fences: {
    closed: fences.length,
    unclosed: openFence ? [openFence] : [],
  },
};

function summary(value) {
  return {
    sha256: value.sha256,
    bytes: value.bytes,
    lines: value.lines,
    requirements: value.requirements.length,
    tasks: value.tasks.length,
    steps: value.steps.length,
    describes: value.describes.length,
    testCases: value.testCases.length,
    runCommands: value.runCommands.length,
    expectedStatements: value.expectedStatements.length,
    fileMap: value.fileMap.length,
    placeholders: value.placeholders.length,
    closedFences: value.fences.closed,
    unclosedFences: value.fences.unclosed.length,
  };
}

let comparison;
if (comparePath) {
  const before = JSON.parse(fs.readFileSync(path.resolve(comparePath), 'utf8'));
  const a = summary(before);
  const b = summary(inventory);
  comparison = Object.fromEntries(
    Object.keys(b).filter((key) => a[key] !== b[key]).map((key) => [key, { before: a[key], after: b[key] }])
  );
}

const result = comparison ? { inventory, comparison } : inventory;
const rendered = JSON.stringify(result, null, 2) + '\n';
if (outputPath) fs.writeFileSync(path.resolve(outputPath), rendered);
process.stdout.write(rendered);

if (inventory.fences.unclosed.length > 0) process.exitCode = 1;
