/**
 * Plan 39: the wave-2 policy checker is itself under test. A gate nobody proves
 * can fail is decoration, so this suite runs its self-test and its scratch-copy
 * mutation matrix and requires every mutant to be rejected BY NAME — and the
 * worktree to be byte-identical afterwards.
 */
import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const CHECKER = path.join(ROOT, 'scripts', 'check-graph-wave2.mjs');
const IS_PRIVATE_SOURCE = fs.existsSync(path.join(ROOT, 'release', 'public'));
function skipPrivateCheckerSuite(privateSource: boolean, checkerExists: boolean): boolean {
  if (privateSource && !checkerExists) throw new Error('private graph wave2 checker missing');
  return !checkerExists;
}
const SKIP_PRIVATE_CHECKER_SUITE = skipPrivateCheckerSuite(
  IS_PRIVATE_SOURCE,
  fs.existsSync(CHECKER),
);
const GUARDED = [
  'src/graph/registry.ts', 'src/graph/coverage.ts',
  'src/graph/query-language.ts', 'src/graph/risk.ts', 'src/graph/query.ts',
];

const run = (args: string[]) =>
  spawnSync(process.execPath, [CHECKER, ...args], { cwd: ROOT, encoding: 'utf8' });
const digest = (rel: string): string =>
  createHash('sha256').update(fs.readFileSync(path.join(ROOT, rel))).digest('hex');

describe('graph wave2 artifact boundary', () => {
  it('fails closed on source deletion while accepting public absence', () => {
    expect(() => skipPrivateCheckerSuite(true, false)).toThrow('private graph wave2 checker missing');
    expect(skipPrivateCheckerSuite(false, false)).toBe(true);
  });
});

describe.skipIf(SKIP_PRIVATE_CHECKER_SUITE)('graph wave2 policy gate', () => {
  it('passes on the live checkout and names the policy it defends', () => {
    const result = run([]);
    expect(result.status).toBe(0);
    expect(result.stdout).toContain('graph-wave2 policy OK');
    expect(result.stdout).toContain('21 relations');
    expect(result.stdout).toContain('13 literal coverage pairs');
  });

  it('fails closed on missing and malformed policy inputs', () => {
    const result = run(['--self-test']);
    expect(result.status).toBe(0);
    expect(result.stdout).toContain('graph-wave2 self-test OK');
  });

  it('rejects every mutant by name and restores the sources', () => {
    const before = Object.fromEntries(GUARDED.map((rel) => [rel, digest(rel)]));
    const result = run(['--mutation-test']);
    expect(result.stderr).toBe('');
    expect(result.status).toBe(0);
    expect(result.stdout).toMatch(/graph-wave2 mutation-test OK \(\d+ mutants rejected by name\)/);
    // Every matrix row from the plan is present and rejected BY NAME.
    const count = Number(/OK \((\d+) mutants/.exec(result.stdout)?.[1] ?? '0');
    expect(count).toBeGreaterThanOrEqual(31);
    const checker = fs.readFileSync(CHECKER, 'utf8');
    for (const mutant of [
      'M1-seed-project', 'M2-edge-project', 'M3-endpoint-project-source',
      'M3-endpoint-project-target', 'M4-memory-edge-scope', 'M4-decision-scope',
      'M4-lesson-scope', 'M5-seed-cap', 'M5-edge-cap', 'M5-default-limit',
      'M5-result-cap', 'M5-step-cap', 'M5-list-cap', 'M6-limit-not-threaded',
      'M6-hydration-unbounded', 'M7-role-deleted', 'M7-role-changed', 'M8-root-kind',
      'M8-boundary-kind', 'M8-boundary-relation', 'M9-use-exclusion',
      'M9-export-exclusion', 'M9-root-exclusion', 'M10-provenance',
      'M10-longest-prefix', 'M11-stale-confidence', 'M12-limited-floor',
      'M13-ilike-seed', 'M14-coverage-prefix', 'M14-coverage-inference',
      'M16-examined-after-dedupe',
    ]) {
      expect(checker).toContain(`id: '${mutant}'`);
    }
    for (const rel of GUARDED) expect(digest(rel)).toBe(before[rel]);
  });

  it('audits the SQL producer census, not mere token presence', async () => {
    // A scratch copy whose edge predicate is scoped to the wrong table must be
    // rejected even though the word project_id still appears.
    const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'wave2-census-'));
    try {
      for (const rel of [...GUARDED, 'src/graph/query.ts']) {
        fs.mkdirSync(path.join(scratch, path.dirname(rel)), { recursive: true });
        fs.copyFileSync(path.join(ROOT, rel), path.join(scratch, rel));
      }
      const target = path.join(scratch, 'src/graph/query.ts');
      const source = fs.readFileSync(target, 'utf8');
      // Anchor on the TRAVERSAL statement specifically — the legacy
      // neighbourhood query carries the same words earlier in the file.
      const anchor = "WHERE e.project_id = $1\n          AND (($5::text = 'outgoing'";
      expect(source).toContain(anchor);
      fs.writeFileSync(target, source.replace(anchor,
        "WHERE (source.project_id = $1)\n          AND (($5::text = 'outgoing'"));
      const result = run(['--root', scratch]);
      expect(result.status).toBe(1);
      expect(result.stderr).toContain('wave2 edge project predicate missing');
    } finally {
      fs.rmSync(scratch, { recursive: true, force: true });
    }
  });

  it('reports a scratch-root drift instead of silently passing', () => {
    // The checker must audit the ROOT it is given, not the repository it lives in.
    const result = run(['--root', path.join(ROOT, 'scripts')]);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('source missing');
  });
});
