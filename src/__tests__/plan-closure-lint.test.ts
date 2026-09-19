/** plan-closure-lint's mechanical censuses.
 *
 * WHY THIS FILE EXISTS. Plan 48 stalled after six blind review passes, and the
 * two lineages that reached recurrence depth 3 were not architecture defects —
 * they were plan-document defects a reviewer had to find by hand each time: a
 * source pin that could never fail, a claim about an import that did not
 * exist, and a shell fence that could not run from the directory the previous
 * fence left. Each was cheap to repair and expensive to find. These are the
 * same censuses, run mechanically, so no later plan can carry the shape to a
 * reviewer.
 *
 * WHAT THIS FILE ACTUALLY COVERS. An earlier revision claimed "every check is
 * falsified in both directions here", and a reviewer disproved it by gutting
 * CHECK 7 four ways with all thirteen tests still green — the git-backed check
 * was never reached, because `runLint` writes its fixture into a bare tmpdir
 * where `git show` throws and the whole block is skipped. Claiming coverage you
 * do not have is the exact defect these censuses exist to catch, so the claim
 * is now specific and was verified by mutation rather than asserted:
 *
 *   CHECK 6  narrowing rationale guard ....... M5, 1 test red
 *   CHECK 7  containment threshold ........... M1, 5 tests red
 *   CHECK 7  unique-word floor ............... M2, 1 test red
 *   CHECK 7  untouched-by-this-edit filter ... M3, 1 test red
 *   CHECK 7  wrapped-line merge .............. M4, 2 tests red
 *   CHECK 7  heading exclusion ............... M6, 1 test red
 *
 * Two of these controls were decorative on their first attempt and were caught
 * by running the mutation, not by reading the test: the short-echo case changed
 * the comment, so the untouched-filter excluded it before the floor mattered,
 * and the heading case was too short to clear the floor at all. Write the
 * control, then break the code and watch it fail.
 *
 * CHECKS 1-5 have positive and negative cases below but were NOT mutation-
 * verified; treat their coverage as demonstrated, not proven.
 *
 * WHY THE FIXTURE REPO IS SYNTHETIC. The first version of this file used real
 * repository files as fixtures — a plan that claimed `Graph.fallback.test.tsx`
 * imports `./model`, for instance, was expected to fail because that file
 * really does not. Plan 48b then needed to ADD that import, which would have
 * turned this suite red and made a correct plan unexecutable. A test that pins
 * the current contents of a file the roadmap intends to change is a trap, not
 * a gate. So the lint runs against a repository tree this file builds, and
 * nothing here depends on the state of the real one.
 */
import { describe, expect, it, beforeAll, afterAll } from 'vitest';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

let repo = '';

beforeAll(() => {
  repo = fs.mkdtempSync(path.join(os.tmpdir(), 'plan-closure-lint-repo-'));
  const graphDir = path.join(repo, 'frontend', 'src', 'views', 'graph');
  fs.mkdirSync(graphDir, { recursive: true });
  // A root element carrying an attribute whose NAME ENDS IN a prop name. This
  // is the shape that made a real pin unfailable: `objective={state.objective}`
  // is a substring of `data-objective={state.objective}`.
  fs.writeFileSync(
    path.join(graphDir, 'Graph.tsx'),
    [
      "import { useState } from 'react';",
      '',
      'export function Graph() {',
      '  const [state] = useState({ objective: 4 });',
      '  return (',
      '    <div',
      '      data-objective={state.objective}',
      '    />',
      '  );',
      '}',
      '',
    ].join('\n'),
  );
  fs.writeFileSync(
    path.join(graphDir, 'WithModel.tsx'),
    ["import { thing } from './model';", 'export const a = thing;', ''].join('\n'),
  );
  fs.writeFileSync(
    path.join(graphDir, 'NoModel.tsx'),
    ["import { useState } from 'react';", 'export const b = useState;', ''].join('\n'),
  );
});

afterAll(() => {
  if (repo !== '') fs.rmSync(repo, { recursive: true, force: true });
});

const runLint = (planText: string): { status: number; out: string } => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'plan-closure-lint-'));
  const plan = path.join(dir, 'plan.md');
  fs.writeFileSync(plan, planText);
  try {
    return {
      status: 0,
      out: execFileSync('node', ['scripts/plan-closure-lint.mjs', plan, '--repo', repo], {
        encoding: 'utf8',
      }),
    };
  } catch (err) {
    const record = err !== null && typeof err === 'object' ? err : {};
    const status = Reflect.get(record, 'status');
    const stdout = Reflect.get(record, 'stdout');
    const stderr = Reflect.get(record, 'stderr');
    return {
      status: typeof status === 'number' ? status : 1,
      out: `${typeof stdout === 'string' ? stdout : ''}${typeof stderr === 'string' ? stderr : ''}`,
    };
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
};

/** A minimal plan that is clean under every check. Each case below adds
 * exactly one defect to it, so a reported kind is attributable. */
const BASE = [
  '# Fixture — Implementation Plan',
  '',
  '## File Map',
  '',
  '| Action | File | Responsibility |',
  '|--------|------|---------------|',
  '| Modify | `frontend/src/views/graph/Graph.tsx` | the graph view |',
  '',
  '---',
  '',
  '## Task 1: Fixture task',
  '',
  '**Files:**',
  '- Modify: `frontend/src/views/graph/Graph.tsx`',
  '',
  '- [ ] **Step 1: Verify**',
  '',
  '```bash',
  'cd "$(git rev-parse --show-toplevel)"',
  'npm run build',
  '```',
  '',
  '- [ ] **Step 2: Commit**',
  '',
  '```bash',
  'cd "$(git rev-parse --show-toplevel)"',
  'git add frontend/src/views/graph/Graph.tsx',
  'git commit -m "fixture"',
  '```',
  '',
].join('\n');

/** A plan that legitimately owns `file` and then makes `claim` about it, so
 * the only kind a case can report is the one under test. */
const planClaiming = (file: string, claim: string): string =>
  BASE.replace(
    '| Modify | `frontend/src/views/graph/Graph.tsx` | the graph view |',
    `| Modify | \`frontend/src/views/graph/Graph.tsx\` | the graph view |\n| Modify | \`${file}\` | the file under claim |`,
  )
    .replace(
      '- Modify: `frontend/src/views/graph/Graph.tsx`',
      `- Modify: \`frontend/src/views/graph/Graph.tsx\`\n- Modify: \`${file}\``,
    )
    .replace(
      'git add frontend/src/views/graph/Graph.tsx',
      `git add frontend/src/views/graph/Graph.tsx ${file}`,
    )
    .concat(`\nEdit \`${file}\`. (${claim})\n`);

/** CHECK 7 needs real git history, and `runLint` cannot give it: it writes the
 * plan into a bare tmpdir, so `git show` throws and the whole check is SKIPPED.
 * That is how this file came to assert coverage it did not have — a reviewer
 * gutted the threshold, the word floor, the untouched-filter and the
 * line-merge and all thirteen tests stayed green. Every case below runs the
 * lint inside a real repository, and each one is falsified by removing the
 * property it names. */
const runWithHistory = (before: string, after: string): string => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'plan-closure-lint-git-'));
  const script = path.resolve('scripts/plan-closure-lint.mjs');
  try {
    const plan = path.join(dir, 'plan.md');
    fs.writeFileSync(plan, before);
    const git = (...a: string[]): void => { execFileSync('git', a, { cwd: dir, stdio: 'ignore' }); };
    git('init', '-q');
    git('config', 'user.email', 't@example.com');
    git('config', 'user.name', 'T');
    git('add', 'plan.md');
    git('commit', '-qm', 'before');
    fs.writeFileSync(plan, after);
    try {
      return execFileSync('node', [script, 'plan.md', '--repo', dir], { cwd: dir, encoding: 'utf8' });
    } catch (err) {
      const record = err !== null && typeof err === 'object' ? err : {};
      const stdout = Reflect.get(record, 'stdout');
      return typeof stdout === 'string' ? stdout : '';
    }
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
};

describe('plan-closure-lint censuses', () => {
  it('passes a plan whose fences, pins and citations are all sound', () => {
    const r = runLint(BASE);
    expect(r.out).toContain('CLEAN');
    expect(r.status).toBe(0);
  });

  it('flags a source pin that already matches inside a longer token', () => {
    const shadowed = `${BASE}\n\`\`\`ts\nexpect(graph).toContain("objective={state.objective}");\n\`\`\`\n`;
    const r = runLint(shadowed);
    expect(r.out).toContain('pin-shadow');
    expect(r.out).toContain('already matches INSIDE a longer token');
    expect(r.status).toBe(1);
  });

  it('accepts the anchored form of that same pin', () => {
    const anchored = `${BASE}\n\`\`\`ts\nexpect(graph).toMatch(/\\n\\s+objective=\\{state\\.objective\\}/);\n\`\`\`\n`;
    const r = runLint(anchored);
    expect(r.out).toContain('CLEAN');
    expect(r.status).toBe(0);
  });

  it('flags a fence that inherits its working directory from the previous fence', () => {
    const unanchored = BASE.replace(
      '```bash\ncd "$(git rev-parse --show-toplevel)"\ngit add',
      '```bash\ngit add',
    );
    const r = runLint(unanchored);
    expect(r.out).toContain('fence-cwd');
    expect(r.out).toContain('they share one shell');
    expect(r.status).toBe(1);
  });

  it('stays silent about fences when no fence in the plan changes directory', () => {
    // The hazard is inheritance. A plan whose fences never cd cannot have it,
    // and firing there would train authors to ignore the check.
    const noCd = BASE.split('\n')
      .filter((line) => !line.startsWith('cd "$(git rev-parse'))
      .join('\n');
    const r = runLint(noCd);
    expect(r.out).not.toContain('fence-cwd');
    expect(r.out).toContain('CLEAN');
  });

  it('flags a file:line citation that points past the end of the file', () => {
    const r = runLint(`${BASE}\nSee \`frontend/src/views/graph/Graph.tsx:999999\` for the mount.\n`);
    expect(r.out).toContain('citation-drift');
    expect(r.out).toContain('points past the end');
    expect(r.status).toBe(1);
  });

  it('flags an import claim naming a file that has no such import, in either word order', () => {
    // Both phrasings occur in real plans. Matching only the first order is how
    // this family reached a sixth review pass.
    const claims = [
      '`Thing` joins the `./model` import.',
      '`Thing` joins the type imports from `./model`.',
    ];
    for (const claim of claims) {
      const r = runLint(planClaiming('frontend/src/views/graph/NoModel.tsx', claim));
      expect(r.out).toContain('citation-drift');
      expect(r.out).toContain('has NO import from');
      expect(r.status).toBe(1);
    }
  });

  it('accepts an import claim that names a file which really does import that module', () => {
    const r = runLint(
      planClaiming('frontend/src/views/graph/WithModel.tsx', '`Thing` joins the `./model` import.'),
    );
    expect(r.out).toContain('CLEAN');
    expect(r.status).toBe(0);
  });

  it("counts a declared predecessor plan's code as declarations, but not as uses", () => {
    // A plan split into a series introduces symbols in its first half that have
    // not reached the repo when the second half is reviewed. Without this, every
    // one of them reads as undeclared — noise that trains an author to ignore
    // the check. The predecessor supplies declarations only.
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'plan-closure-lint-series-'));
    try {
      const first = path.join(dir, 'first.md');
      fs.writeFileSync(first, '```ts\nexport const predecessorOnly = (): number => 1;\n```\n');
      const second = `${BASE.replace(
        '**Files:**',
        `**Depends on plan:** the first half (\`${first}\`)\n\n**Files:**`,
      )}\n\`\`\`ts\nconst x = predecessorOnly();\n\`\`\`\n`;
      expect(runLint(second).out).toContain('CLEAN');

      const orphaned = runLint(second.replace(/\*\*Depends on plan:\*\*[^\n]*\n\n/, ''));
      expect(orphaned.out).toContain('identifier-closure');
      expect(orphaned.out).toContain('predecessorOnly');
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('flags a census whose expected count includes a declaration that cannot match the pattern', () => {
    // Plan 48b-2 shipped exactly this: `grep -c "setX("` expecting 2, where the
    // declaration is a destructuring and so is followed by `]`, not `(`. The
    // real count was 1, so the plan's own gate would have stopped the executor
    // on correct code.
    const plan = `${BASE}\n\`\`\`ts\nexport function useThing(): void {\n  const [thing, setThing] = [0, (n: number): void => { void n; }];\n  void thing;\n  setThing(4);\n}\n\`\`\`\n\n\`\`\`bash\ncd "$(git rev-parse --show-toplevel)"\ngrep -c "setThing(" frontend/src/views/graph/Graph.tsx   # expected 2 — the declaration and the single write\n\`\`\`\n`;
    const r = runLint(plan);
    expect(r.out).toContain('census-arithmetic');
    expect(r.out).toContain('cannot match');
    expect(r.status).toBe(1);
  });

  it('stays silent when a census rationale does not claim to count the declaration', () => {
    // The same destructuring, but the expected count is the call sites alone —
    // which is correct, and is how the sibling `setCameraRequest(` census reads.
    const plan = `${BASE}\n\`\`\`ts\nexport function useThing(): void {\n  const [thing, setThing] = [0, (n: number): void => { void n; }];\n  void thing;\n  setThing(4);\n}\n\`\`\`\n\n\`\`\`bash\ncd "$(git rev-parse --show-toplevel)"\ngrep -c "setThing(" frontend/src/views/graph/Graph.tsx   # expected 1 — the single write; a second means another producer\n\`\`\`\n`;
    const r = runLint(plan);
    expect(r.out).not.toContain('census-arithmetic');
    expect(r.out).toContain('CLEAN');
  });


  /** The claim under test wraps across two comment lines, exactly as the one
   * that survived plan 48b-1's repair did. A line-level compare cannot see it. */
  const WRAPPED = [
    '```ts',
    '// the cache is cleared on every write and that',
    '// is the only path that ever clears it',
    'export const q = 1;',
    '```',
  ].join('\n');
  const CLAIM_BEFORE = `${BASE}\n- R9: the cache is cleared on every write and that is the only path that ever clears it\n\n${WRAPPED}\n`;
  const CLAIM_AFTER = CLAIM_BEFORE.replace(
    '- R9: the cache is cleared on every write and that is the only path that ever clears it',
    '- R9: the cache is cleared on write and on eviction, which are two distinct paths',
  );

  it('flags an untouched claim that still asserts what the edit removed', () => {
    const out = runWithHistory(CLAIM_BEFORE, CLAIM_AFTER);
    expect(out).toContain('claim-survives');
    expect(out).toContain('Repair the shape, not the cited site');
  });

  it('sees a claim only because it merges wrapped lines into sentences', () => {
    // The load-bearing property. Neither comment line alone carries enough of
    // the removed wording to score; only the merged sentence does. If the merge
    // is ever removed, this case goes green and the check goes blind.
    const oneLinePerClaim = CLAIM_AFTER.replace(
      '// the cache is cleared on every write and that\n// is the only path that ever clears it',
      '// the cache is cleared on every write and that\n\n// is the only path that ever clears it',
    );
    expect(runWithHistory(CLAIM_BEFORE, oneLinePerClaim)).not.toContain('claim-survives');
    expect(runWithHistory(CLAIM_BEFORE, CLAIM_AFTER)).toContain('claim-survives');
  });

  it('ignores a surviving line the edit itself rewrote', () => {
    // A line that CHANGED is the repair, not an unswept sibling. The reword
    // below reuses nearly all of the removed wording ON PURPOSE: without the
    // untouched-filter the repaired requirement scores against its own former
    // self and the check reports every edit it was asked to verify.
    const bothFixed = CLAIM_AFTER.replace(
      '// the cache is cleared on every write and that\n// is the only path that ever clears it',
      '// the cache is cleared on every write and that\n// is not the only path that ever clears it',
    );
    expect(runWithHistory(CLAIM_BEFORE, bothFixed)).not.toContain('claim-survives');
  });

  it('ignores a survivor too short to be a claim', () => {
    // The survivor must be short AND untouched, or the untouched-filter excludes
    // it before the floor is ever consulted — which is how an earlier version of
    // this case passed against a gutted floor. Three words here, every one of
    // them in the removed text: without the floor it scores a perfect 1.0.
    const shortBefore = `${BASE}\n- R9: the cache is cleared on every write and that is the only path that ever clears it\n\n\`\`\`ts\n// the cache is cleared\nexport const q = 1;\n\`\`\`\n`;
    const shortAfter = shortBefore.replace(
      '- R9: the cache is cleared on every write and that is the only path that ever clears it',
      '- R9: the cache is cleared on write and on eviction, which are two distinct paths',
    );
    expect(runWithHistory(shortBefore, shortAfter)).not.toContain('claim-survives');
  });

  it('ignores a survivor that merely shares a few words with the removed text', () => {
    // Below the containment threshold. Without it the check fires on ordinary
    // vocabulary reuse and authors learn to ignore the output.
    const unrelated = CLAIM_AFTER.replace(
      '// the cache is cleared on every write and that\n// is the only path that ever clears it',
      '// the renderer batches writes into a single frame for smoothness',
    );
    expect(runWithHistory(CLAIM_BEFORE, unrelated)).not.toContain('claim-survives');
  });

  it('does not treat a section heading as a surviving claim', () => {
    // A heading is a title, not an assertion, and it shares vocabulary with the
    // paragraph it introduces — so without this exclusion an ordinary edit under
    // a section reports the section's own name. Found by running the check
    // against a real plan, where it fired on "## Task 1: The camera frame".
    // The heading must be LONG enough to clear the unique-word floor, or the
    // floor masks the exclusion and this case passes without it — which is
    // how the first version of this control was decorative.
    const headed = `${CLAIM_BEFORE}\n## The cache is cleared on every write and that is the only path that ever clears it\n\nfiller text under the heading\n`;
    const headedAfter = headed.replace(
      '- R9: the cache is cleared on every write and that is the only path that ever clears it',
      '- R9: the cache is cleared on write and on eviction, which are two distinct paths',
    ).replace('// the cache is cleared on every write and that\n// is the only path that ever clears it', '// cleared on write and on eviction both');
    const out = runWithHistory(headed, headedAfter);
    expect(out).not.toContain('claim-survives');
  });

  it('stays silent when the plan has no committed history to compare against', () => {
    const r = runLint(`${BASE}\n- R9: a claim with no previous revision to differ from\n`);
    expect(r.out).not.toContain('claim-survives');
    expect(r.out).toContain('CLEAN');
  });

  it('reports a predecessor plan the header names but that cannot be read', () => {
    const r = runLint(
      BASE.replace(
        '**Files:**',
        '**Depends on plan:** `docs/superpowers/plans/no-such-plan.md`\n\n**Files:**',
      ),
    );
    expect(r.out).toContain('cannot be read');
    expect(r.status).toBe(1);
  });
});

/** Plans 32a and 32b introduce tasks with `### Task N` (three hashes) because
 * their tasks sit under a `## Tasks`-style h2 spine. The first version of the
 * splitter only recognised `## Task N`, so on those plans it found zero tasks,
 * reported every File Map row as unowned, and its verdict was noise. A task
 * heading at either level must open a task, and the task must end at the next
 * heading of its own level or higher — not swallow its sibling, and not run
 * into the h2 section that follows. */
describe('plan-closure-lint task headings', () => {
  const asH3 = (plan: string): string => plan.replace(/^## Task /gm, '### Task ');

  it('owns a ### task and ends it at the following ## section', () => {
    const plan = asH3(BASE).concat(
      [
        '',
        '## Final execution invariants',
        '',
        '```bash',
        'cd "$(git rev-parse --show-toplevel)"',
        'git add docs/superpowers/plans/other.md',
        '```',
        '',
      ].join('\n'),
    );
    const r = runLint(plan);
    expect(r.out).toContain('tasks: 1 |');
    expect(r.out).toContain('CLEAN');
    expect(r.status).toBe(0);
  });

  it('ends a ### task at its ### sibling instead of swallowing it', () => {
    const plan = asH3(BASE)
      .replace(
        '| Modify | `frontend/src/views/graph/Graph.tsx` | the graph view |',
        '| Modify | `frontend/src/views/graph/Graph.tsx` | the graph view |\n| Modify | `frontend/src/views/graph/WithModel.tsx` | the second task |',
      )
      .concat(
        [
          '',
          '### Task 2: Second fixture task',
          '',
          '**Files:**',
          '- Modify: `frontend/src/views/graph/WithModel.tsx`',
          '',
          '- [ ] **Step 1: Commit**',
          '',
          '```bash',
          'cd "$(git rev-parse --show-toplevel)"',
          'git add frontend/src/views/graph/Graph.tsx',
          'git commit -m "fixture"',
          '```',
          '',
        ].join('\n'),
      );
    const r = runLint(plan);
    expect(r.out).toContain('tasks: 2 |');
    expect(r.out).toContain(
      'Task 2: Files: names `frontend/src/views/graph/WithModel.tsx` but its `git add` does not stage it',
    );
    expect(r.status).not.toBe(0);
  });
});

/** Three more shapes Plan 32b carries that the first splitter/harvester could
 * not see: a `# comment` line inside a bash fence is not a heading and must
 * not end the task; File Map rows for root files (`package.json`) and for
 * trees outside src/frontend/scripts/docs (`skills/…`, `installer/…`,
 * `.github/…`) must be ownable, and a nested `skills/…/scripts/x` must not
 * also be harvested as `scripts/x`; and a file one task Creates and a later
 * task Modifies has ONE creator, not ambiguous ownership. */
describe('plan-closure-lint fence comments, root/skills paths and create-then-modify', () => {
  const asH3 = (plan: string): string => plan.replace(/^## Task /gm, '### Task ');

  it('does not end a task at a # comment inside a bash fence', () => {
    const plan = asH3(BASE).replace(
      'git add frontend/src/views/graph/Graph.tsx',
      '# VC1: the comment below is not a heading\ngit add frontend/src/views/graph/Graph.tsx',
    );
    const r = runLint(plan);
    expect(r.out).toContain('tasks: 1 |');
    expect(r.out).toContain('CLEAN');
    expect(r.status).toBe(0);
  });

  it('lets a task own root files and paths under skills, installer and .github', () => {
    const extra = ['package.json', 'skills/plan-review-cycle/scripts/review-scratch.mjs', 'installer/README.md', '.github/workflows/platform.yml'];
    const plan = BASE
      .replace(
        '| Modify | `frontend/src/views/graph/Graph.tsx` | the graph view |',
        '| Modify | `frontend/src/views/graph/Graph.tsx` | the graph view |\n' + extra.map((p) => `| Modify | \`${p}\` | extra |`).join('\n'),
      )
      .replace(
        '- Modify: `frontend/src/views/graph/Graph.tsx`',
        '- Modify: `frontend/src/views/graph/Graph.tsx`\n' + extra.map((p) => `- Modify: \`${p}\``).join('\n'),
      )
      .replace(
        'git add frontend/src/views/graph/Graph.tsx',
        `git add frontend/src/views/graph/Graph.tsx ${extra.join(' ')}`,
      );
    const r = runLint(plan);
    expect(r.out).not.toContain('scripts/review-scratch.mjs` but it is in no File Map row');
    expect(r.out).toContain('CLEAN');
    expect(r.status).toBe(0);
  });

  const twoTasks = (secondAction: 'Create' | 'Modify'): string =>
    BASE.replace(
      '| Modify | `frontend/src/views/graph/Graph.tsx` | the graph view |',
      '| Modify | `frontend/src/views/graph/Graph.tsx` | the graph view |\n| Create | `frontend/src/views/graph/New.tsx` | created then edited |',
    )
      .replace(
        '- Modify: `frontend/src/views/graph/Graph.tsx`',
        '- Modify: `frontend/src/views/graph/Graph.tsx`\n- Create: `frontend/src/views/graph/New.tsx`',
      )
      .replace(
        'git add frontend/src/views/graph/Graph.tsx',
        'git add frontend/src/views/graph/Graph.tsx frontend/src/views/graph/New.tsx',
      )
      .concat(
        [
          '',
          '## Task 2: Second fixture task',
          '',
          '**Files:**',
          `- ${secondAction}: \`frontend/src/views/graph/New.tsx\``,
          '',
          '- [ ] **Step 1: Commit**',
          '',
          '```bash',
          'cd "$(git rev-parse --show-toplevel)"',
          'git add frontend/src/views/graph/New.tsx',
          'git commit -m "fixture"',
          '```',
          '',
        ].join('\n'),
      );

  it('treats create-then-modify across two tasks as one creator', () => {
    const r = runLint(twoTasks('Modify'));
    expect(r.out).toContain('CLEAN');
    expect(r.status).toBe(0);
  });

  it('still flags a file two tasks both claim to create', () => {
    const r = runLint(twoTasks('Create'));
    expect(r.out).toContain('a Create row has ambiguous ownership');
    expect(r.status).not.toBe(0);
  });
});

/** A large edit — several paragraphs removed at once — used to make the
 * claim-survives check fire on every untouched sibling that merely shared the
 * edit's vocabulary, because containment was measured against the BAG of all
 * removed words. Plan 32b's Task 5 re-author flagged two such lines. A claim
 * survives when ONE removed sentence still says it, so containment is scored
 * against the best single removed sentence. */
describe('plan-closure-lint claim-survives scores against one removed sentence', () => {
  const R6 = '- R6: the janitor prunes each named root after seven days using the marker timestamp';
  const R7 = '- R7: the helper retains any tree holding an open file and reports why';
  const R8 = '- R8: the janitor prunes each named root after seven days and retains any tree holding an open file';
  const before = `${BASE}\n${R6}\n\n${R7}\n\n${R8}\n`;

  it('does not flag a sibling whose words are spread across several removed sentences', () => {
    // R8's vocabulary is the UNION of R6 and R7, but neither R6 nor R7 alone
    // says what R8 says. Removing both must not indict R8.
    const after = before
      .replace(R6, '- R6: the janitor uses a cutoff computed from the marker')
      .replace(R7, '- R7: probe failures keep the candidate');
    expect(runWithHistory(before, after)).not.toContain('claim-survives');
  });

  it('still flags a sibling that one removed sentence does say', () => {
    const dup = '- R9: the janitor prunes each named root after seven days using the marker timestamp exactly';
    const withDup = `${before}\n${dup}\n`;
    const after = withDup.replace(R6, '- R6: the janitor uses a cutoff computed from the marker');
    expect(runWithHistory(withDup, after)).toContain('claim-survives');
  });
});

/** A table row or a list item is one claim each. Merging a whole File Map or
 * Files: block into a single "sentence" meant deleting ONE row marked the
 * entire block as removed text, and every sibling list that shares the
 * block's vocabulary (Modify, src, test, json…) then scored as a survivor.
 * Wrapped prose paragraphs still merge; rows and items do not. */
describe('plan-closure-lint claim-survives treats rows and list items as separate claims', () => {
  const ROWS = '| Modify | `src/alpha/model-layer.ts` | model layer |\n| Modify | `src/beta/plain-layer.ts` | plain layer |';
  const ITEMS = '- Modify: `src/alpha/model-layer.ts`\n- Modify: `src/beta/plain-layer.ts`';
  const SIBLING = '- R3: modify src alpha model layer and modify src beta plain layer';
  const before = BASE
    .replace('| Modify | `frontend/src/views/graph/Graph.tsx` | the graph view |', `| Modify | \`frontend/src/views/graph/Graph.tsx\` | the graph view |\n${ROWS}`)
    .replace('- Modify: `frontend/src/views/graph/Graph.tsx`', `- Modify: \`frontend/src/views/graph/Graph.tsx\`\n${ITEMS}`)
    .replace('git add frontend/src/views/graph/Graph.tsx', 'git add frontend/src/views/graph/Graph.tsx src/alpha/model-layer.ts src/beta/plain-layer.ts')
    .concat(`\n${SIBLING}\n`);
  const after = before
    .replace(`\n${ROWS}`, '')
    .replace(`\n${ITEMS}`, '')
    .replace(' src/alpha/model-layer.ts src/beta/plain-layer.ts', '');

  it('does not indict a sibling whose words are spread across two deleted rows', () => {
    const out = runWithHistory(before, after);
    expect(out).toContain('CLEAN');
    expect(out).not.toContain('claim-survives');
  });
});

/** A `- Create:` / `- Modify:` inventory line is not a claim: it cannot "still
 * assert" what a rewritten paragraph used to say, and its only words are path
 * tokens the paragraph naturally shares. CHECK 1 already owns those lines. */
describe('plan-closure-lint claim-survives ignores Files: inventory lines', () => {
  const ROW = '| Create | `skills/plan-review-cycle/scripts/review-scratch.mjs` | canonical helper |';
  const ITEM = '- Create: `skills/plan-review-cycle/scripts/review-scratch.mjs`';
  const PARA = 'Update both review skills so their operative create commands invoke node review-scratch.mjs directly in plan-review-cycle on every OS and remove the loophole.';
  const before = BASE
    .replace('| Modify | `frontend/src/views/graph/Graph.tsx` | the graph view |', `| Modify | \`frontend/src/views/graph/Graph.tsx\` | the graph view |\n${ROW}`)
    .replace('- Modify: `frontend/src/views/graph/Graph.tsx`', `- Modify: \`frontend/src/views/graph/Graph.tsx\`\n${ITEM}`)
    .replace('git add frontend/src/views/graph/Graph.tsx', 'git add frontend/src/views/graph/Graph.tsx skills/plan-review-cycle/scripts/review-scratch.mjs')
    .concat(`\n${PARA}\n`);
  const after = before.replace(PARA, 'Anchor by content: the row whose first cell names the shell helper now points at the mjs form.');

  it('does not indict an inventory line that shares path tokens with a rewritten paragraph', () => {
    const out = runWithHistory(before, after);
    expect(out).toContain('CLEAN');
    expect(out).not.toContain('claim-survives');
  });
});

/** A generated output (a receipt named at run time) must still be owned: a
 * File Map row and a Files: entry written as the same literal glob, staged by
 * that glob. The old harvester could not see `*` or `${VAR}` at all, so a plan
 * could stage a generated file it never declared. Now a `${VAR}` form is
 * harvested and reported as unowned, and the glob form is ownable. */
describe('plan-closure-lint generated outputs declared as a glob', () => {
  const GLOB = 'docs/release/windows/windows-11-*.json';
  const owned = BASE
    .replace('| Modify | `frontend/src/views/graph/Graph.tsx` | the graph view |', `| Modify | \`frontend/src/views/graph/Graph.tsx\` | the graph view |\n| Create | \`${GLOB}\` | generated receipt |`)
    .replace('- Modify: `frontend/src/views/graph/Graph.tsx`', `- Modify: \`frontend/src/views/graph/Graph.tsx\`\n- Create: \`${GLOB}\``)
    .replace('git add frontend/src/views/graph/Graph.tsx', `git add frontend/src/views/graph/Graph.tsx ${GLOB}`);

  it('accepts a generated file declared, listed and staged by one literal glob', () => {
    const r = runLint(owned);
    expect(r.out).toContain('CLEAN');
    expect(r.status).toBe(0);
  });

  it('reports a ${VAR} path a task stages but the File Map never declares', () => {
    const plan = BASE.replace(
      'git add frontend/src/views/graph/Graph.tsx',
      'git add frontend/src/views/graph/Graph.tsx "docs/release/windows/windows-11-${UTC_DATE}-${SHA8}.json"',
    );
    const r = runLint(plan);
    expect(r.out).toContain('touches `docs/release/windows/windows-11-${UTC_DATE}-${SHA8}.json` but it is in no File Map row');
    expect(r.status).not.toBe(0);
  });
});

/** Three unit-classification defects surfaced by Plan 32b's pass-3 repair:
 * a code line inside a fence that happens to start with a capital letter was
 * classified as PROSE; a `**bold**`-led paragraph starts with `*` and was
 * classified as a code COMMENT; and consecutive bold-led lines (a plan header's
 * `**Date:**`, `**Spec:**`, `**Revision…**` fields) merged into one giant
 * unit, so appending one header line "removed" every plan term at once and
 * indicted every short survivor. Each case is red against the previous lint. */
describe('plan-closure-lint claim-survives unit classification', () => {
  it('does not treat a capitalised code line inside a fence as a prose claim', () => {
    const CODE = 'Set-Location C:\\src\\mai-mcp; npm run acceptance:windows -- -Phase Automated -CheckoutRoot $PWD.Path';
    const R4 = '- R4: Set-Location src mai mcp then npm run acceptance windows Phase Automated CheckoutRoot pwd path';
    const before = `${BASE}\n${R4}\n\n\`\`\`powershell\n${CODE}\n\`\`\`\n`;
    const after = before.replace(R4, '- R4: the operator runs the acceptance script from the checkout');
    expect(runWithHistory(before, after)).not.toContain('claim-survives');
  });

  it('keeps consecutive **bold**-led lines as separate prose claims', () => {
    // R5 and R6 are adjacent bold-led lines. Merged into one "comment" unit
    // (the old rule), editing R5 marks the unit as touched and R6's surviving
    // duplicate claim is never reported.
    const R5 = '**R5 — the cache is cleared on every write and that is the only path that ever clears it.**';
    const R6 = '**R6 — the cache is cleared on every write and that is the only path that ever clears it, restated.**';
    const before = `${BASE}\n${R5}\n${R6}\n`;
    const after = before.replace(R5, '**R5 — the cache is cleared on write and on eviction, which are two distinct paths.**');
    expect(runWithHistory(before, after)).toContain('claim-survives');
  });
});
