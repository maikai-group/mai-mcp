import { execFileSync, spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const checker = path.join(repoRoot, 'scripts/check-roadmap-order.mjs');

function runChecker(...args: string[]): string {
  return execFileSync(process.execPath, [checker, ...args], {
    cwd: repoRoot,
    encoding: 'utf8',
  });
}

describe('roadmap ordering invariant gate', () => {
  it('accepts the live complete producer/read census', () => {
    const output = runChecker();
    expect(output).toContain('PASS roadmap-order complete');
    expect(output).toContain('5 writer owners');
    expect(output).toContain('4 backend readers/delegates');
    expect(output).toContain('1 fingerprinted share exemption');
    expect(output).toContain('5 frontend owners');
    expect(output).toContain('3 Roadmap consumers');
    expect(output).toContain('1 history consumer');
    expect(output).toContain('0 wildcards/unclassified SQL shapes');
  });

  it('rejects missing and malformed copied inputs', () => {
    const output = runChecker('--self-test');
    expect(output).toContain('PASS self-test');
    expect(output).toContain('interpolated backend inputs rejected');
  });

  it('rejects the exact 23 complete-phase mutants and restores live hashes', () => {
    const output = runChecker('--mutation-test');
    const mutants = [
      'removed priority',
      'swapped ranks',
      'alphabetical board order',
      'one idea query reverting to a wildcard projection',
      'whole-column rank query',
      'one writer losing the priority argument',
      'sorted source/target advisory acquisition removed',
      'sorted advisory acquisition reversed',
      'locked identity revalidation removed',
      'reorder losing its priority predicate',
      'reorder losing its exact-project predicate',
      'an executable schema/default/index change',
      'an extra production file containing an unclassified ideas writer',
      'an extra production file containing an unclassified ordered reader',
      'exact idea reader losing its project visibility wall',
      'exact idea reader losing its bounded ambiguity check',
      'comparator loss',
      'dropped history reverting to raw response filtering',
      'applyReorder reverting to whole-column rank mutation',
      'onDragEnd snapshot reverting to columnCards',
      'nudge snapshot reverting to columnCards',
      'cyclePriority reverting to the label-only map',
      'an extra production frontend sorter/rank mutator',
    ];
    for (const mutant of mutants) expect(output).toContain(`PASS mutant: ${mutant}`);
    expect(output).toContain('PASS mutation inventory: 23 complete-phase mutants rejected; live hashes restored');
  });

  it('fails before connecting when MAI_TEST_DB_URL is absent', () => {
    const environment = { ...process.env };
    delete environment.MAI_TEST_DB_URL;
    delete environment.MAI_DB_URL;
    const result = spawnSync(
      process.execPath,
      [path.join(repoRoot, 'node_modules/vitest/vitest.mjs'), 'run', 'src/__tests__/ideas.test.ts'],
      { cwd: repoRoot, env: environment, encoding: 'utf8' },
    );
    expect(result.status).not.toBe(0);
    expect(`${result.stdout}\n${result.stderr}`).toContain(
      'MAI_TEST_DB_URL is required — use scripts/run-with-disposable-db.sh',
    );
  });

  it('fails before Playwright starts a server or setup connects without a disposable URL', () => {
    const environment = { ...process.env };
    delete environment.MAI_TEST_DB_URL;
    delete environment.MAI_DB_URL;
    const result = spawnSync(
      process.execPath,
      [path.join(repoRoot, 'frontend/node_modules/@playwright/test/cli.js'),
        'test', '--list', '--config', 'playwright.config.ts'],
      { cwd: path.join(repoRoot, 'frontend'), env: environment, encoding: 'utf8' },
    );
    const output = `${result.stdout}\n${result.stderr}`;
    expect(result.status).not.toBe(0);
    expect(output).toContain('MAI_TEST_DB_URL is required — use scripts/run-with-disposable-db.sh');
    expect(output).not.toContain('refusing non-disposable test database: mai_brain');
  });
});
