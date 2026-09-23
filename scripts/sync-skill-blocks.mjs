#!/usr/bin/env node
// One source for shared workflow rules, injected between
// markers into every consumer. `--check` fails on drift instead of writing.
//
// The block is REPLACED wholesale on every sync, so a hand-edit inside it
// disappears silently — lesson 420dbda2. The marker comment says so inline.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const check = process.argv.includes('--check');
const fail = (msg) => { console.error(`skill-blocks: ${msg}`); process.exit(1); };

/** blockName -> { source, consumers } */
const BLOCKS = {
  cleanup: {
    source: 'skill-blocks/cleanup.md',
    // Every shipped skill owns its artifacts, including future entrypoints.
    consumers: fs.readdirSync(path.join(root, 'skills'), { withFileTypes: true })
      .filter((entry) => entry.isDirectory()
        && fs.existsSync(path.join(root, 'skills', entry.name, 'SKILL.md')))
      .map((entry) => `skills/${entry.name}/SKILL.md`),
  },
  epistemics: {
    source: 'skill-blocks/epistemics.md',
    consumers: [
      'skills/receiving-plan-review/SKILL.md',
      'skills/mai-receiving-code-review/SKILL.md',
    ],
  },
  'navigation-preflight': {
    source: 'skill-blocks/navigation-preflight.md',
    consumers: [
      'skills/mai-design/SKILL.md',
      'skills/write-plan/SKILL.md',
      'skills/mai-explore/SKILL.md',
      'skills/plan-review/SKILL.md',
      'skills/receiving-plan-review/SKILL.md',
    ],
  },
};

const START = (name) => `<!-- mai:shared:${name} start`;
const END = (name) => `<!-- mai:shared:${name} end -->`;

function occurrences(text, needle) {
  const hits = [];
  for (let from = 0; ; ) {
    const hit = text.indexOf(needle, from);
    if (hit === -1) return hits;
    hits.push(hit);
    from = hit + needle.length;
  }
}

function header(name) {
  return `${START(name)} — synced from ${BLOCKS[name].source}.
     Do NOT hand-edit inside this block; the sync rewrites it wholesale and the
     edit disappears silently (lesson 420dbda2). -->`;
}

let drifted = 0;
for (const [name, def] of Object.entries(BLOCKS)) {
  const srcPath = path.join(root, def.source);
  if (!fs.existsSync(srcPath)) fail(`missing source ${def.source}`);
  const body = fs.readFileSync(srcPath, 'utf8').trimEnd();
  const want = `${header(name)}\n${body}\n${END(name)}`;

  for (const rel of def.consumers) {
    const file = path.join(root, rel);
    if (!fs.existsSync(file)) fail(`missing consumer ${rel}`);
    const text = fs.readFileSync(file, 'utf8');
    const starts = occurrences(text, START(name));
    const ends = occurrences(text, END(name));
    if (starts.length !== 1 || ends.length !== 1) {
      fail(`${rel} must have exactly one ${name} start and end marker (found ${starts.length}/${ends.length})`);
    }
    const [startIdx] = starts;
    const [endIdx] = ends;
    if (endIdx < startIdx) fail(`${rel} has ${name} markers out of order`);
    const current = text.slice(startIdx, endIdx + END(name).length);
    if (current === want) continue;
    drifted++;
    if (check) {
      console.error(`skill-blocks: ${rel} has drifted from ${def.source}`);
      continue;
    }
    fs.writeFileSync(file, text.slice(0, startIdx) + want + text.slice(endIdx + END(name).length));
    console.log(`synced ${name} -> ${rel}`);
  }

  // AMENDMENT A1 (plan 26, finding 2f947589, author-approved 2026-08-14).
  // The consumer list is a REGISTRATION, and a registration that can be
  // reverted silently is not one. Every per-consumer check above only inspects
  // skills that are already registered, so deleting an entry made the whole
  // block stop reaching a shipped skill while `--check` still printed
  // "in sync" — measured. Enforce EXACT equality in both directions: every
  // skill carrying the marker must be registered, and every registered
  // consumer must carry it. Placed after the loop on purpose, so a registered
  // consumer's own marker/order/drift failure still reports its specific
  // message first.
  const markerBearing = [];
  const skillsDir = path.join(root, 'skills');
  if (fs.existsSync(skillsDir)) {
    for (const entry of fs.readdirSync(skillsDir, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const rel = `skills/${entry.name}/SKILL.md`;
      const file = path.join(root, rel);
      if (!fs.existsSync(file)) continue;
      if (fs.readFileSync(file, 'utf8').includes(START(name))) markerBearing.push(rel);
    }
  }
  const registered = new Set(def.consumers);
  const unregistered = markerBearing.filter((rel) => !registered.has(rel)).sort();
  if (unregistered.length > 0) {
    fail(`${name}: ${unregistered.join(', ')} carr${unregistered.length === 1 ? 'ies' : 'y'} the block but ${unregistered.length === 1 ? 'is' : 'are'} not a registered consumer — add ${unregistered.length === 1 ? 'it' : 'them'} to BLOCKS.${name}.consumers`);
  }
}

if (check) {
  if (drifted > 0) fail(`${drifted} block(s) drifted — run: npm run sync:skill-blocks`);
  console.log('skill-blocks: in sync');
} else if (drifted === 0) {
  console.log('skill-blocks: already in sync');
}
