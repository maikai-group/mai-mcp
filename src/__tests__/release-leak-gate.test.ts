import { afterEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const SOURCE_GATE = path.join(ROOT, 'scripts', 'release-leak-check.sh');
const SOURCE_MANIFEST = path.join(ROOT, 'scripts', 'release-leak-content-allowlist.txt');
const temps: string[] = [];

afterEach(() => {
  for (const dir of temps.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

function fixture(copyManifest: boolean): { scripts: string; tree: string } {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'mai-release-leak-'));
  temps.push(root);
  const scripts = path.join(root, 'scripts');
  const tree = path.join(root, 'tree');
  fs.mkdirSync(scripts);
  fs.mkdirSync(tree);
  fs.copyFileSync(SOURCE_GATE, path.join(scripts, 'release-leak-check.sh'));
  if (copyManifest) fs.copyFileSync(SOURCE_MANIFEST, path.join(scripts, 'release-leak-content-allowlist.txt'));
  return { scripts, tree };
}

function runGate(scripts: string, tree: string) {
  return spawnSync('bash', [path.join(scripts, 'release-leak-check.sh'), tree], { encoding: 'utf8' });
}

// The leak gate and its content manifest are PRIVATE release tooling: both are
// deliberately absent from the public package (verified — release-public.sh
// ships neither), while this file does ship. Without this guard every case here
// dies on ENOENT copying a source that isn't there. Skip rather than early-
// return, so a public run reports "skipped" instead of a vacuous pass.
// Precedent: skills-gates.test.ts guards the private assembler the same way.
const GATE_PRESENT = fs.existsSync(SOURCE_GATE) && fs.existsSync(SOURCE_MANIFEST);

describe.skipIf(!GATE_PRESENT)('release leak gate integrity inputs', () => {
  it('fails closed when the content allowlist is missing even if the tree has no hits', () => {
    const { scripts, tree } = fixture(false);
    const result = runGate(scripts, tree);
    expect(result.status).toBe(1);
    expect(result.stdout).toContain('content allowlist missing');
  });

  it('rejects every assembled-tree symlink before content scanning', () => {
    const { scripts, tree } = fixture(true);
    const target = path.join(path.dirname(tree), 'target');
    fs.mkdirSync(target);
    fs.symlinkSync(target, path.join(tree, 'linked-dir'), 'dir');
    const result = runGate(scripts, tree);
    expect(result.status).toBe(1);
    expect(result.stdout).toContain('LEAK [symlink present]: linked-dir');
  });

  it('rejects traversal in the fingerprinted content manifest', () => {
    const { scripts, tree } = fixture(true);
    const forbiddenPort = `543${33}`;
    fs.writeFileSync(
      path.join(scripts, 'release-leak-content-allowlist.txt'),
      `1|${forbiddenPort}|../outside.ts|const port = ${forbiddenPort};\n`
    );
    const result = runGate(scripts, tree);
    expect(result.status).toBe(1);
    expect(result.stdout).toContain('invalid content-allowlist path');
  });

  it('accepts a clean assembled-tree fixture', () => {
    const { scripts, tree } = fixture(true);
    fs.writeFileSync(path.join(scripts, 'release-leak-content-allowlist.txt'), '');
    fs.writeFileSync(path.join(tree, 'README.md'), 'generic public content\n');
    const result = runGate(scripts, tree);
    expect(result.status).toBe(0);
    expect(result.stdout).toContain('leak-check: CLEAN');
  });

  it('rejects the motivating private project slug', () => {
    // The slug is assembled at runtime, never written literally: this file
    // SHIPS in the public tree, and a literal would be caught by the very
    // pattern it tests — failing the release assembler's own leak gate.
    const slug = `shield${'-'}vault`;
    const { scripts, tree } = fixture(true);
    fs.writeFileSync(path.join(scripts, 'release-leak-content-allowlist.txt'), '');
    fs.writeFileSync(path.join(tree, 'README.md'), `do not ship ${slug}\n`);
    const result = runGate(scripts, tree);
    expect(result.status).toBe(1);
    expect(result.stdout).toContain(`LEAK [${slug}]`);
    expect(result.stdout).toContain('leak-check: FAILED');
  });
});
