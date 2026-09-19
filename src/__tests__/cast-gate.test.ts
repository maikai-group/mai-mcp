import { afterEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const temps: string[] = [];

afterEach(() => {
  for (const dir of temps.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

function gateFixture(): { root: string; source: string; baseline: string; script: string } {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'mai-cast-gate-'));
  temps.push(root);
  fs.mkdirSync(path.join(root, 'scripts'));
  fs.mkdirSync(path.join(root, 'src'));
  fs.symlinkSync(path.join(ROOT, 'node_modules'), path.join(root, 'node_modules'), 'dir');
  const script = path.join(root, 'scripts', 'check-no-casts.mjs');
  const baseline = path.join(root, 'scripts', 'check-no-casts-baseline.json');
  const source = path.join(root, 'src', 'sample.ts');
  fs.copyFileSync(path.join(ROOT, 'scripts', 'check-no-casts.mjs'), script);
  return { root, source, baseline, script };
}

describe('whole-tree cast ratchet', () => {
  it('discovers a new violation without a hand-maintained file list', () => {
    const f = gateFixture();
    fs.writeFileSync(f.baseline, '{}\n');
    fs.writeFileSync(f.source, 'export const clean = 1;\n');
    expect(spawnSync(process.execPath, [f.script], { cwd: f.root }).status).toBe(0);
    fs.writeFileSync(f.source, 'export const drift = value as string;\n');
    const drift = spawnSync(process.execPath, [f.script], { cwd: f.root, encoding: 'utf8' });
    expect(drift.status).toBe(1);
    expect(drift.stderr).toContain('src/sample.ts: as-assertion baseline drift');
  });

  it('rejects an expect-error suppression exactly like ts-ignore', () => {
    const f = gateFixture();
    fs.writeFileSync(f.baseline, '{}\n');
    fs.writeFileSync(f.source, 'export const clean = 1;\n');
    expect(spawnSync(process.execPath, [f.script], { cwd: f.root }).status).toBe(0);
    // Joined at runtime so this regression test never becomes a literal
    // violation of the gate it exercises.
    const directive = '@ts-' + 'expect-error';
    fs.writeFileSync(f.source, `// ${directive}\nexport const suppressed: number = 'x';\n`);
    const drift = spawnSync(process.execPath, [f.script], { cwd: f.root, encoding: 'utf8' });
    expect(drift.status).toBe(1);
    expect(drift.stderr).toContain('ts-suppression');
  });

  it('also rejects silent baseline improvement until the reviewed snapshot is updated', () => {
    const f = gateFixture();
    fs.writeFileSync(f.baseline, JSON.stringify({ 'src/sample.ts': { 'as-assertion': 1 } }));
    fs.writeFileSync(f.source, 'export const legacy = value as string;\n');
    expect(spawnSync(process.execPath, [f.script], { cwd: f.root }).status).toBe(0);
    fs.writeFileSync(f.source, 'export const clean = "value";\n');
    expect(spawnSync(process.execPath, [f.script], { cwd: f.root }).status).toBe(1);
  });
});
