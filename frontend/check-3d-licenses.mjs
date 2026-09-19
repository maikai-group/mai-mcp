import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const frontendRoot = process.argv[2] === undefined ? scriptDir : path.resolve(process.argv[2]);
const lockPath = path.join(frontendRoot, 'package-lock.json');
const manifest = JSON.parse(fs.readFileSync(path.join(frontendRoot, 'package.json'), 'utf8'));
assert.equal(manifest.dependencies?.['3d-force-graph'], '1.80.0',
  'package.json must pin 3d-force-graph exactly at 1.80.0');
assert.equal(manifest.devDependencies?.['@types/three'], '0.185.4',
  'package.json must pin the matching three.js declarations exactly at 0.185.4');
const lock = JSON.parse(fs.readFileSync(lockPath, 'utf8'));
const packages = lock.packages;
assert.ok(packages && typeof packages === 'object', 'package-lock.json has no packages inventory');

const rootKey = 'node_modules/3d-force-graph';
assert.ok(packages[rootKey], '3d-force-graph is absent from the installed lockfile');

function resolveDependency(parentKey, name) {
  let base = parentKey;
  while (true) {
    const candidate = base === '' ? `node_modules/${name}` : `${base}/node_modules/${name}`;
    if (packages[candidate]) return candidate;
    const at = base.lastIndexOf('/node_modules/');
    if (at < 0) {
      if (base === '') break;
      base = '';
    } else {
      base = base.slice(0, at);
    }
  }
  throw new Error(`${parentKey} declares ${name}, but the lockfile has no resolvable package`);
}

const queue = [rootKey];
const closure = new Set();
while (queue.length > 0) {
  const key = queue.pop();
  if (closure.has(key)) continue;
  closure.add(key);
  const entry = packages[key];
  const names = new Set([
    ...Object.keys(entry.dependencies ?? {}),
    ...Object.keys(entry.optionalDependencies ?? {}),
  ]);
  for (const name of names) queue.push(resolveDependency(key, name));
}

const allowed = new Set(['MIT', 'ISC', 'BSD-3-Clause']);
const histogram = new Map();
const rows = [];
for (const key of [...closure].sort()) {
  const packagePath = path.join(frontendRoot, key, 'package.json');
  const pkg = JSON.parse(fs.readFileSync(packagePath, 'utf8'));
  assert.ok(allowed.has(pkg.license), `${pkg.name}@${pkg.version} has unapproved license ${pkg.license}`);
  histogram.set(pkg.license, (histogram.get(pkg.license) ?? 0) + 1);
  rows.push(`${pkg.name}@${pkg.version} ${pkg.license}`);
}

const root = JSON.parse(fs.readFileSync(path.join(frontendRoot, rootKey, 'package.json'), 'utf8'));
assert.equal(root.version, '1.80.0', '3d-force-graph must remain pinned at 1.80.0');
assert.equal(root.license, 'MIT', 'the direct production dependency must remain MIT');
assert.equal(closure.size, 35, `3d-force-graph closure changed: expected 35 packages, saw ${closure.size}`);
assert.deepEqual(Object.fromEntries([...histogram].sort()), {
  'BSD-3-Clause': 4,
  ISC: 13,
  MIT: 18,
});

for (const row of rows) console.log(row);
console.log('3d-force-graph closure licenses OK (35 packages: 18 MIT, 13 ISC, 4 BSD-3-Clause)');
