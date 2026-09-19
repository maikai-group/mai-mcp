import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const CHECKER = path.join(ROOT, 'scripts', 'check-operator-tasks.mjs');
const PRIVATE_RELEASE_MARKER = path.join(ROOT, 'release', 'public');
const PRIVATE_RELEASE_INPUT = 'scripts/release-public.sh';
const HAS_PRIVATE_RELEASE = fs.existsSync(PRIVATE_RELEASE_MARKER);
function productionSources(root: string): string[] {
  const found: string[] = [];
  const walk = (directory: string) => {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      const absolute = path.join(directory, entry.name);
      if (entry.isDirectory()) { walk(absolute); continue; }
      const rel = path.relative(root, absolute).split(path.sep).join('/');
      if (entry.isFile() && entry.name.endsWith('.ts') && !rel.split('/').includes('__tests__')
          && !entry.name.endsWith('.test.ts')) found.push(rel);
    }
  };
  walk(path.join(root, 'src'));
  return found.sort();
}
const PRODUCTION_SOURCES = productionSources(ROOT);
const PUBLIC_GUARDED = [
  'db/schema.sql', 'db/migrations/2026-08-27-operator-tasks.sql',
  'db/migrations/2026-08-28-operator-task-history.sql',
  'db/migrations/2026-08-28-operator-task-history.rollback.sql',
  'src/operator-tasks.ts', 'src/plans.ts', 'src/tool-defs.ts',
  'src/read-budget.ts', 'src/web-server.ts',
];
const GUARDED = [...PUBLIC_GUARDED, ...(HAS_PRIVATE_RELEASE ? [PRIVATE_RELEASE_INPUT] : [])];
const run = (args: string[]) => spawnSync(process.execPath, [CHECKER, ...args], {
  cwd: ROOT, encoding: 'utf8',
});
const digest = (rel: string) => createHash('sha256')
  .update(fs.readFileSync(path.join(ROOT, rel))).digest('hex');
const git = (cwd: string, args: string[]) => {
  const result = spawnSync('git', args, { cwd, encoding: 'utf8' });
  if (result.status !== 0) throw new Error(result.stderr || result.stdout);
  return result.stdout.trim();
};
const FILE_MAP = [
  'db/migrations/2026-08-27-operator-tasks.sql',
  'db/migrations/2026-08-27-operator-tasks.rollback.sql',
  'db/schema.sql', 'src/operator-tasks.ts', 'src/plans.ts', 'src/git/plan-lifecycle.ts',
  'src/__tests__/operator-tasks.test.ts', 'src/__tests__/tracker-bridges.test.ts',
  'scripts/check-operator-tasks.mjs', 'src/__tests__/operator-task-gates.test.ts',
  'package.json', 'scripts/release-public.sh', 'src/tool-defs.ts', 'src/index.ts',
  'src/read-budget.ts', 'scripts/check-read-budgets.mjs',
  'src/__tests__/read-budget.test.ts', 'src/__tests__/context-budget.test.ts',
  'src/web-user-task-handlers.ts', 'src/__tests__/web-user-task-handlers.test.ts',
  'src/web-server.ts', 'frontend/src/lib/types.ts', 'frontend/src/shell/destinations.ts',
  'frontend/src/shell/Nav.tsx', 'frontend/src/shell/Shell.tsx',
  'frontend/src/shell/Shell.test.tsx', 'frontend/src/views/tasks/MyTasks.tsx',
  'frontend/src/views/tasks/MyTasks.test.tsx', 'frontend/e2e/seed.sql',
  'frontend/e2e/smoke.spec.ts', 'skills/write-plan/SKILL.md',
  'skills/plan-review/SKILL.md', 'skills/plan-execute/SKILL.md',
  'scripts/check-skills.mjs', 'src/__tests__/skills-gates.test.ts',
  'src/__tests__/backup-brain.test.ts', 'src/__tests__/graph-wave2-gates.test.ts',
];
const PUBLIC_AUDIT_INPUTS = [
  'db/schema.sql', 'db/migrations/2026-08-27-operator-tasks.sql',
  'db/migrations/2026-08-28-operator-task-history.sql',
  'db/migrations/2026-08-28-operator-task-history.rollback.sql',
  ...PRODUCTION_SOURCES, 'scripts/check-operator-tasks.mjs', 'package.json',
];
const AUDIT_INPUTS = [...PUBLIC_AUDIT_INPUTS, ...(HAS_PRIVATE_RELEASE ? [PRIVATE_RELEASE_INPUT] : [])];
const SUBJECTS = [
  'feat(tasks): add durable operator task domain',
  'feat(tasks): sync plan checklists and expose agent tools',
  'feat(tasks): add operator task web api',
  'feat(tasks): add My Tasks dashboard',
  'feat(skills): route operator work through My Tasks',
];
const PLAN44_SUBJECTS = [
  'feat(tasks): add durable history tombstones',
  'feat(tasks): add atomic history removal api',
  'feat(tasks): group task tabs by plan',
  'test(tasks): lock operator task history invariants',
];
const PLAN44_PATH = 'docs/superpowers/plans/2026-08-28-plan-44-operator-task-history.md';
const PLAN44_GROUPS = [
  [
    'db/migrations/2026-08-28-operator-task-history.sql',
    'db/migrations/2026-08-28-operator-task-history.rollback.sql',
    'db/schema.sql', 'src/operator-tasks.ts', 'src/plans.ts',
    'src/__tests__/operator-tasks.test.ts', 'src/__tests__/tracker-bridges.test.ts',
  ],
  ['src/web-user-task-handlers.ts', 'src/__tests__/web-user-task-handlers.test.ts'],
  [
    'frontend/src/lib/types.ts', 'frontend/src/views/tasks/MyTasks.tsx',
    'frontend/src/views/tasks/MyTasks.test.tsx',
  ],
  [
    'scripts/check-operator-tasks.mjs', 'src/__tests__/operator-task-gates.test.ts',
    'frontend/e2e/seed.sql', 'frontend/e2e/smoke.spec.ts', 'docs/configuration.md',
  ],
] as const;

function appendFixtureChange(root: string, rel: string, marker: string): void {
  const target = path.join(root, rel);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  if (!fs.existsSync(target)) fs.writeFileSync(target, 'baseline\n');
  const prefix = rel.endsWith('.sql') ? '--' : rel.endsWith('.md') ? '<!--' : '//';
  const suffix = rel.endsWith('.md') ? ' -->' : '';
  fs.appendFileSync(target, `\n${prefix} ${marker}${suffix}\n`);
}

function plan44RangeFixture(options: {
  subjects?: readonly string[];
  omitPath?: string;
  extraPath?: string;
  interleavedSubject?: string;
  driftBaseMigration?: boolean;
  closeoutSubject?: string;
  extraCloseoutPath?: string;
} = {}): { root: string; base: string; impl: string; final?: string } {
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'operator-task-plan44-range-'));
  git(scratch, ['init', '-q']);
  git(scratch, ['config', 'user.email', 'gate@test']);
  git(scratch, ['config', 'user.name', 'gate']);
  if (HAS_PRIVATE_RELEASE) fs.mkdirSync(path.join(scratch, 'release', 'public'), { recursive: true });
  const implementationPaths = PLAN44_GROUPS.flat();
  for (const rel of new Set([...AUDIT_INPUTS, ...implementationPaths])) {
    const target = path.join(scratch, rel);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    if (AUDIT_INPUTS.includes(rel)) fs.copyFileSync(path.join(ROOT, rel), target);
    else fs.writeFileSync(target, 'baseline\n');
  }
  git(scratch, ['add', '-A']);
  git(scratch, ['commit', '-q', '-m', 'base']);
  const base = git(scratch, ['rev-parse', 'HEAD']);
  const subjects = options.subjects ?? PLAN44_SUBJECTS;
  for (let index = 0; index < PLAN44_GROUPS.length; index += 1) {
    const group = PLAN44_GROUPS[index];
    for (const rel of group) {
      if (rel !== options.omitPath) appendFixtureChange(scratch, rel, `plan44 task ${index + 1}`);
    }
    if (index === PLAN44_GROUPS.length - 1 && options.extraPath) {
      appendFixtureChange(scratch, options.extraPath, 'plan44 extra path');
    }
    if (index === PLAN44_GROUPS.length - 1 && options.driftBaseMigration) {
      appendFixtureChange(scratch, 'db/migrations/2026-08-27-operator-tasks.sql', 'forbidden drift');
    }
    git(scratch, ['add', '-A']);
    git(scratch, ['commit', '-q', '-m', subjects[index] ?? `fix(tasks): address Plan 44 code review deadbeef`]);
    if (index === 1 && options.interleavedSubject) {
      git(scratch, ['commit', '-q', '--allow-empty', '-m', options.interleavedSubject]);
    }
  }
  const impl = git(scratch, ['rev-parse', 'HEAD']);
  fs.symlinkSync(path.join(ROOT, 'node_modules'), path.join(scratch, 'node_modules'));
  if (options.closeoutSubject) {
    const plan = path.join(scratch, PLAN44_PATH);
    fs.mkdirSync(path.dirname(plan), { recursive: true });
    fs.writeFileSync(plan, '# Plan 44 executed\n');
    if (options.extraCloseoutPath) appendFixtureChange(scratch, options.extraCloseoutPath, 'closeout extra');
    git(scratch, ['add', PLAN44_PATH, ...(options.extraCloseoutPath ? [options.extraCloseoutPath] : [])]);
    git(scratch, ['commit', '-q', '-m', options.closeoutSubject]);
    return { root: scratch, base, impl, final: git(scratch, ['rev-parse', 'HEAD']) };
  }
  return { root: scratch, base, impl };
}

const RECEIPT_LOADER = String.raw`
set -euo pipefail
load_plan44_ref() {
  local ref_file=$1 label=$2 byte_count last_byte object_type ref
  test ! -L "$ref_file" || { printf '%s\n' "$label receipt is a symlink" >&2; return 1; }
  test -f "$ref_file" || { printf '%s\n' "$label receipt is missing or non-regular" >&2; return 1; }
  byte_count=$(LC_ALL=C wc -c < "$ref_file" | tr -d '[:space:]')
  test "$byte_count" = 41 || { printf '%s\n' "$label receipt must be exactly 40 lowercase hex bytes plus LF" >&2; return 1; }
  last_byte=$(tail -c 1 "$ref_file" | od -An -v -tx1 | tr -d '[:space:]')
  test "$last_byte" = 0a || { printf '%s\n' "$label receipt must end in LF" >&2; return 1; }
  ref=$(sed -n '1p' "$ref_file")
  printf '%s\n' "$ref" | grep -Eq '^[0-9a-f]{40}$' || { printf '%s\n' "$label receipt is not a 40-hex commit id" >&2; return 1; }
  object_type=$(git cat-file -t "$ref") || { printf '%s\n' "$label receipt does not name an object" >&2; return 1; }
  test "$object_type" = commit || { printf '%s\n' "$label receipt is not a direct commit object" >&2; return 1; }
  printf '%s\n' "$ref"
}
base=$(load_plan44_ref "$1" base)
implementation=$(load_plan44_ref "$2" implementation)
git merge-base --is-ancestor "$base" "$implementation"
`;

function rangeFixture(includeLifecycle: boolean): { root: string; base: string } {
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'operator-task-range-'));
  git(scratch, ['init', '-q']);
  git(scratch, ['config', 'user.email', 'gate@test']);
  git(scratch, ['config', 'user.name', 'gate']);
  if (HAS_PRIVATE_RELEASE) fs.mkdirSync(path.join(scratch, 'release', 'public'), { recursive: true });
  for (const rel of new Set([...AUDIT_INPUTS, ...FILE_MAP])) {
    const target = path.join(scratch, rel);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    if (AUDIT_INPUTS.includes(rel)) fs.copyFileSync(path.join(ROOT, rel), target);
    else fs.writeFileSync(target, 'baseline\n');
  }
  git(scratch, ['add', '-A']);
  git(scratch, ['commit', '-q', '-m', 'base']);
  const base = git(scratch, ['rev-parse', 'HEAD']);
  const changed = FILE_MAP.filter((rel) => includeLifecycle || rel !== 'src/git/plan-lifecycle.ts');
  for (const rel of changed) {
    const target = path.join(scratch, rel);
    if (!AUDIT_INPUTS.includes(rel)) {
      fs.writeFileSync(target, `implemented ${rel}\n`);
    } else if (rel === 'package.json') {
      const parsed = JSON.parse(fs.readFileSync(target, 'utf8'));
      parsed.range_fixture = true;
      fs.writeFileSync(target, `${JSON.stringify(parsed, null, 2)}\n`);
    } else if (rel.endsWith('.sql')) {
      fs.appendFileSync(target, '-- range fixture\n');
    } else if (rel.endsWith('.sh')) {
      fs.appendFileSync(target, '# range fixture\n');
    } else {
      fs.appendFileSync(target, '// range fixture\n');
    }
  }
  for (let index = 0; index < SUBJECTS.length; index += 1) {
    const chunk = changed.filter((_rel, item) => item % SUBJECTS.length === index);
    git(scratch, ['add', '--', ...chunk]);
    git(scratch, ['commit', '-q', '-m', SUBJECTS[index]]);
  }
  fs.symlinkSync(path.join(ROOT, 'node_modules'), path.join(scratch, 'node_modules'));
  return { root: scratch, base };
}

describe('operator task invariant gate', () => {
  it('prints the exact normalized producer receipt', () => {
    const result = run([]);
    expect(result.status).toBe(0);
    expect(result.stderr).toBe('');
    expect(result.stdout).toContain(
      'operator-task producers OK: planRegister, postPlanNote/Git bridge');
    expect(result.stdout).toContain('operator-task gate OK (47 tools; 6 indexes)');
  });

  it('fails closed for missing and malformed inputs', () => {
    const result = run(['--self-test']);
    expect(result.status).toBe(0);
    expect(result.stdout).toContain('operator-task self-test OK');
  });

  it('requires the private assembler only when the private release marker exists', () => {
    const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'operator-task-public-boundary-'));
    try {
      for (const rel of PUBLIC_AUDIT_INPUTS) {
        fs.mkdirSync(path.join(scratch, path.dirname(rel)), { recursive: true });
        fs.copyFileSync(path.join(ROOT, rel), path.join(scratch, rel));
      }
      const packaged = run(['--root', scratch]);
      expect(packaged.status, packaged.stderr).toBe(0);
      fs.mkdirSync(path.join(scratch, 'release', 'public'), { recursive: true });
      const privateMissing = run(['--root', scratch]);
      expect(privateMissing.status).toBe(1);
      expect(privateMissing.stderr).toContain(`required input missing: ${PRIVATE_RELEASE_INPUT}`);
    } finally {
      fs.rmSync(scratch, { recursive: true, force: true });
    }
  });

  it('fails closed when either Plan 44 migration is absent from a public root', () => {
    for (const missing of [
      'db/migrations/2026-08-28-operator-task-history.sql',
      'db/migrations/2026-08-28-operator-task-history.rollback.sql',
    ]) {
      const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'operator-task-plan44-missing-'));
      try {
        for (const rel of PUBLIC_AUDIT_INPUTS) {
          if (rel === missing) continue;
          const target = path.join(scratch, rel);
          fs.mkdirSync(path.dirname(target), { recursive: true });
          fs.copyFileSync(path.join(ROOT, rel), target);
        }
        const result = run(['--root', scratch]);
        expect(result.status).toBe(1);
        expect(result.stderr).toContain(`required input missing: ${missing}`);
      } finally {
        fs.rmSync(scratch, { recursive: true, force: true });
      }
    }
  });

  it.each([
    [['--root'], '--root needs a non-flag value'],
    [['--base'], '--base needs a non-flag value'],
    [['--final'], '--final needs a non-flag value'],
    [['--mutation-tset'], 'unknown option: --mutation-tset'],
    [['--root', ROOT, '--root', ROOT], 'duplicate option: --root'],
    [['--self-test', '--self-test'], 'duplicate option: --self-test'],
    [['--final', 'HEAD'], '--final requires --base'],
    [['--plan44-base', 'HEAD'], '--plan44-base and --plan44-impl are required together'],
    [['--plan44-impl', 'HEAD'], '--plan44-base and --plan44-impl are required together'],
    [['--plan44-final', 'HEAD'], '--plan44-final requires --plan44-base and --plan44-impl'],
    [['--base', 'HEAD', '--plan44-base', 'HEAD', '--plan44-impl', 'HEAD'],
      'Plan 43 and Plan 44 range flags are mutually exclusive'],
  ])('rejects malformed CLI grammar %#', (args, diagnostic) => {
    const result = run(args);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain(diagnostic);
    expect(result.stdout).not.toContain('operator-task gate OK');
  });

  it('rejects the exact mutation census by intended diagnostic without touching sources', () => {
    const before = Object.fromEntries(GUARDED.map((rel) => [rel, digest(rel)]));
    const result = run(['--mutation-test']);
    expect(result.status).toBe(0);
    expect(result.stderr).toBe('');
    expect(result.stdout).toContain(
      `operator-task mutation-test OK (${HAS_PRIVATE_RELEASE ? 38 : 37} mutants rejected by name)`,
    );
    const checker = fs.readFileSync(CHECKER, 'utf8');
    for (let index = 1; index <= 38; index += 1) expect(checker).toContain(`'M${index}-`);
    for (const rel of GUARDED) expect(digest(rel)).toBe(before[rel]);
  }, 120_000);

  it('audits the supplied root, including agent resolution schema drift', () => {
    const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'operator-task-gate-'));
    try {
      const rels = AUDIT_INPUTS;
      if (HAS_PRIVATE_RELEASE) fs.mkdirSync(path.join(scratch, 'release', 'public'), { recursive: true });
      for (const rel of rels) {
        fs.mkdirSync(path.join(scratch, path.dirname(rel)), { recursive: true });
        fs.copyFileSync(path.join(ROOT, rel), path.join(scratch, rel));
      }
      const target = path.join(scratch, 'src/tool-defs.ts');
      const source = fs.readFileSync(target, 'utf8');
      fs.writeFileSync(target, source.replace(
        'plan_path: { type: "string", minLength: 1, maxLength: 1000 },\n        tasks:',
        'plan_path: { type: "string", minLength: 1, maxLength: 1000 },\n        dismiss: { type: "boolean" },\n        tasks:',
      ));
      const result = run(['--root', scratch]);
      expect(result.status).toBe(1);
      expect(result.stderr).toContain('operator-task agent resolution property forbidden');
    } finally {
      fs.rmSync(scratch, { recursive: true, force: true });
    }
  });

  it('rejects weakened history constraints and missing group terminal guards', () => {
    for (const mutate of [
      (scratch: string) => {
        const target = path.join(scratch, 'db/migrations/2026-08-28-operator-task-history.sql');
        const source = fs.readFileSync(target, 'utf8');
        fs.writeFileSync(target, source.replace(
          "removed_at IS NULL OR status IN ('completed','dismissed')",
          "removed_at IS NULL OR status IN ('pending','completed','dismissed')",
        ));
        return 'operator-task history migration contract incomplete';
      },
      (scratch: string) => {
        const target = path.join(scratch, 'src/operator-tasks.ts');
        const source = fs.readFileSync(target, 'utf8');
        const start = source.indexOf('async function removeOperatorTaskGroup');
        const end = source.indexOf('export async function removeOperatorTasks', start);
        const group = source.slice(start, end).replaceAll(
          "removed_at IS NULL AND status IN ('completed','dismissed')",
          'removed_at IS NULL',
        );
        fs.writeFileSync(target, `${source.slice(0, start)}${group}${source.slice(end)}`);
        return 'operator-task group removal terminal guard missing';
      },
      (scratch: string) => {
        const target = path.join(scratch, 'db/migrations/2026-08-28-operator-task-history.sql');
        const source = fs.readFileSync(target, 'utf8');
        fs.writeFileSync(target, source.replace(
          'ON operator_tasks(project_id, source_plan_slug, task_key)',
          'ON operator_tasks(project_id, task_key)',
        ));
        return 'operator-task history migration contract incomplete';
      },
      (scratch: string) => {
        const target = path.join(scratch, 'db/migrations/2026-08-28-operator-task-history.sql');
        const source = fs.readFileSync(target, 'utf8');
        fs.writeFileSync(target, source.replace(
          'project_id, status, plan_id, resolved_at DESC NULLS LAST,',
          'project_id, plan_id, resolved_at DESC NULLS LAST,',
        ));
        return 'operator-task history migration contract incomplete';
      },
    ]) {
      const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'operator-task-plan44-semantics-'));
      try {
        if (HAS_PRIVATE_RELEASE) fs.mkdirSync(path.join(scratch, 'release', 'public'), { recursive: true });
        for (const rel of AUDIT_INPUTS) {
          const target = path.join(scratch, rel);
          fs.mkdirSync(path.dirname(target), { recursive: true });
          fs.copyFileSync(path.join(ROOT, rel), target);
        }
        const diagnostic = mutate(scratch);
        const result = run(['--root', scratch]);
        expect(result.status).toBe(1);
        expect(result.stderr).toContain(diagnostic);
      } finally {
        fs.rmSync(scratch, { recursive: true, force: true });
      }
    }
  });

  it('recursively rejects rogue production writers, task callers, syntax errors, and symlinks', () => {
    const cases = [
      {
        rel: 'src/new/rogue-writer.ts',
        body: "export async function rogue(client) { return client.query(`UPDATE plans SET status = 'executing' WHERE id = $1`); }\n",
        diagnostic: 'operator-task producer census mismatch',
      },
      {
        rel: 'src/new/rogue-board-alias.ts',
        body: "import { operatorTaskStatus as relayStatus } from '../operator-tasks.js';\nexport const relay = (agent_messages) => relayStatus(agent_messages);\n",
        diagnostic: 'operator-task task-domain caller census mismatch',
      },
      {
        rel: 'src/new/rogue-board-namespace.ts',
        body: "import * as operatorTasks from '../operator-tasks.js';\nexport const relay = (agent_messages) => operatorTasks.operatorTaskStatus(agent_messages);\n",
        diagnostic: 'operator-task task-domain caller census mismatch',
      },
      {
        rel: 'src/new/rogue-board-rebound.ts',
        body: "import { operatorTaskStatus } from '../operator-tasks.js';\nconst relayStatus = operatorTaskStatus;\nexport const relay = (agent_messages) => relayStatus(agent_messages);\n",
        diagnostic: 'operator-task task-domain caller census mismatch',
      },
      {
        rel: 'src/new/rogue-board-dynamic.ts',
        body: "const { operatorTaskStatus: relayStatus } = await import('../operator-tasks.js');\nexport const relay = (agent_messages) => relayStatus(agent_messages);\n",
        diagnostic: 'operator-task task-domain caller census mismatch',
      },
      {
        rel: 'src/new/rogue-board-reexport.ts',
        body: "export { operatorTaskStatus as relayStatus } from '../operator-tasks.js';\n",
        diagnostic: 'operator-task module-reference census mismatch',
      },
      { rel: 'src/new/broken.ts', body: 'export const = ;\n', diagnostic: 'production source unparseable' },
    ];
    for (const item of cases) {
      const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'operator-task-census-'));
      try {
        for (const rel of AUDIT_INPUTS) {
          fs.mkdirSync(path.join(scratch, path.dirname(rel)), { recursive: true });
          fs.copyFileSync(path.join(ROOT, rel), path.join(scratch, rel));
        }
        const target = path.join(scratch, item.rel);
        fs.mkdirSync(path.dirname(target), { recursive: true });
        fs.writeFileSync(target, item.body);
        const result = run(['--root', scratch]);
        expect(result.status).toBe(1);
        expect(result.stderr).toContain(item.diagnostic);
      } finally {
        fs.rmSync(scratch, { recursive: true, force: true });
      }
    }

    for (const reexport of [
      'export { operatorTaskStatus as relayedTaskStatus };\n',
      'export const relayedTaskStatus = operatorTaskStatus;\n',
    ]) {
      const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'operator-task-reexport-census-'));
      try {
        for (const rel of AUDIT_INPUTS) {
          fs.mkdirSync(path.join(scratch, path.dirname(rel)), { recursive: true });
          fs.copyFileSync(path.join(ROOT, rel), path.join(scratch, rel));
        }
        fs.appendFileSync(path.join(scratch, 'src/web-user-task-handlers.ts'), reexport);
        const consumer = path.join(scratch, 'src/new/rogue-reexport-consumer.ts');
        fs.mkdirSync(path.dirname(consumer), { recursive: true });
        fs.writeFileSync(consumer,
          "import { relayedTaskStatus as mutateTask } from '../web-user-task-handlers.js';\n"
          + 'export const relay = (agent_messages) => mutateTask(agent_messages);\n');
        const result = run(['--root', scratch]);
        expect(result.status).toBe(1);
        expect(result.stderr).toContain('operator-task task-domain caller census mismatch');
      } finally {
        fs.rmSync(scratch, { recursive: true, force: true });
      }
    }

    const ownerExport = fs.mkdtempSync(path.join(os.tmpdir(), 'operator-task-owner-export-census-'));
    try {
      for (const rel of AUDIT_INPUTS) {
        fs.mkdirSync(path.join(ownerExport, path.dirname(rel)), { recursive: true });
        fs.copyFileSync(path.join(ROOT, rel), path.join(ownerExport, rel));
      }
      fs.appendFileSync(path.join(ownerExport, 'src/operator-tasks.ts'),
        'export { operatorTaskStatus as ownerRelayStatus };\n');
      const result = run(['--root', ownerExport]);
      expect(result.status).toBe(1);
      expect(result.stderr).toContain('operator-task task-domain caller census mismatch');
    } finally {
      fs.rmSync(ownerExport, { recursive: true, force: true });
    }

    const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'operator-task-census-link-'));
    try {
      for (const rel of AUDIT_INPUTS) {
        fs.mkdirSync(path.join(scratch, path.dirname(rel)), { recursive: true });
        fs.copyFileSync(path.join(ROOT, rel), path.join(scratch, rel));
      }
      fs.symlinkSync(path.join(scratch, 'src/plans.ts'), path.join(scratch, 'src/rogue-link.ts'));
      const result = run(['--root', scratch]);
      expect(result.status).toBe(1);
      expect(result.stderr).toContain('production source symlink forbidden: src/rogue-link.ts');
    } finally {
      fs.rmSync(scratch, { recursive: true, force: true });
    }
  });

  it('accepts the exact 37-path range and rejects omission of its lifecycle owner', () => {
    const complete = rangeFixture(true);
    try {
      const pass = run(['--root', complete.root, '--base', complete.base]);
      expect(pass.status, pass.stderr).toBe(0);
      expect(pass.stdout).toContain('operator-task gate OK');

      const checker = path.join(complete.root, 'scripts/check-operator-tasks.mjs');
      const source = fs.readFileSync(checker, 'utf8');
      const ledgerAnchor =
        "  'db/schema.sql', 'src/operator-tasks.ts', 'src/plans.ts', 'src/git/plan-lifecycle.ts',";
      expect(source).toContain(ledgerAnchor);
      const withoutLifecycle = source.replace(ledgerAnchor,
        "  'db/schema.sql', 'src/operator-tasks.ts', 'src/plans.ts',");
      expect(withoutLifecycle).not.toBe(source);
      fs.writeFileSync(checker, withoutLifecycle);
      const missingLedger = spawnSync(process.execPath, [checker, '--root', complete.root, '--base', complete.base], {
        cwd: complete.root, encoding: 'utf8',
      });
      expect(missingLedger.status, missingLedger.stdout + missingLedger.stderr).toBe(1);
      expect(missingLedger.stderr).toContain(
        'operator-task lifecycle owner missing from implementation-range ledger');
    } finally {
      fs.rmSync(complete.root, { recursive: true, force: true });
    }

    const omitted = rangeFixture(false);
    try {
      const missingChange = run(['--root', omitted.root, '--base', omitted.base]);
      expect(missingChange.status).toBe(1);
      expect(missingChange.stderr).toContain(
        'operator-task File Map range mismatch: missing=[src/git/plan-lifecycle.ts]');
    } finally {
      fs.rmSync(omitted.root, { recursive: true, force: true });
    }
  });

  it('audits the exact Plan 44 pre-close range and rejects history/path/subject drift', () => {
    const complete = plan44RangeFixture();
    try {
      const pass = run([
        '--root', complete.root, '--plan44-base', complete.base, '--plan44-impl', complete.impl,
      ]);
      expect(pass.status, pass.stdout + pass.stderr).toBe(0);
      expect(pass.stdout).toContain('operator-task gate OK (47 tools; 6 indexes)');
    } finally {
      fs.rmSync(complete.root, { recursive: true, force: true });
    }

    const cases: Array<{
      options: Parameters<typeof plan44RangeFixture>[0];
      diagnostic: string;
    }> = [
      {
        options: { subjects: [PLAN44_SUBJECTS[1], PLAN44_SUBJECTS[0], PLAN44_SUBJECTS[2], PLAN44_SUBJECTS[3]] },
        diagnostic: 'operator-task Plan 44 task commits out of order or missing',
      },
      {
        options: { subjects: [PLAN44_SUBJECTS[0], 'fix(tasks): address Plan 44 code review deadbeef', PLAN44_SUBJECTS[2], PLAN44_SUBJECTS[3]] },
        diagnostic: 'operator-task Plan 44 task commits out of order or missing',
      },
      {
        options: { interleavedSubject: 'chore: unrelated interleave' },
        diagnostic: 'operator-task Plan 44 unrelated commit in implementation range',
      },
      {
        options: { extraPath: 'plan44-extra.txt' },
        diagnostic: 'operator-task Plan 44 File Map range mismatch',
      },
      {
        options: { omitPath: 'docs/configuration.md' },
        diagnostic: 'operator-task Plan 44 File Map range mismatch',
      },
      {
        options: { driftBaseMigration: true },
        diagnostic: 'operator-task Plan 44 immutable Plan 43 base migration changed',
      },
      {
        options: { interleavedSubject: 'fix(tasks): unlabelled Plan 44 repair' },
        diagnostic: 'operator-task Plan 44 unrelated commit in implementation range',
      },
    ];
    for (const item of cases) {
      const fixture = plan44RangeFixture(item.options);
      try {
        const result = run([
          '--root', fixture.root, '--plan44-base', fixture.base, '--plan44-impl', fixture.impl,
        ]);
        expect(result.status).toBe(1);
        expect(result.stderr).toContain(item.diagnostic);
      } finally {
        fs.rmSync(fixture.root, { recursive: true, force: true });
      }
    }
  }, 120_000);

  it('loads Plan 44 receipts only from exact regular 40-hex-LF commit files', () => {
    const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'operator-task-plan44-receipts-'));
    try {
      git(scratch, ['init', '-q']);
      git(scratch, ['config', 'user.email', 'gate@test']);
      git(scratch, ['config', 'user.name', 'gate']);
      fs.writeFileSync(path.join(scratch, 'seed.txt'), 'base\n');
      git(scratch, ['add', 'seed.txt']);
      git(scratch, ['commit', '-q', '-m', 'base']);
      const base = git(scratch, ['rev-parse', 'HEAD']);
      fs.appendFileSync(path.join(scratch, 'seed.txt'), 'implementation\n');
      git(scratch, ['commit', '-q', '-am', 'implementation']);
      const impl = git(scratch, ['rev-parse', 'HEAD']);
      const good = [`${base}\n`, `${impl}\n`];
      const runPair = (targetIndex: number, shape: string): ReturnType<typeof spawnSync> => {
        const pair = fs.mkdtempSync(path.join(scratch, 'pair-'));
        const paths = [path.join(pair, 'base'), path.join(pair, 'implementation')];
        fs.writeFileSync(paths[0], good[0]);
        fs.writeFileSync(paths[1], good[1]);
        const target = paths[targetIndex];
        if (shape === 'missing') fs.rmSync(target);
        else if (shape === 'symlink') {
          fs.rmSync(target);
          const source = path.join(pair, 'symlink-source');
          fs.writeFileSync(source, good[targetIndex]);
          fs.symlinkSync(source, target);
        } else if (shape === 'non-regular') {
          fs.rmSync(target);
          fs.mkdirSync(target);
        } else if (shape === 'empty') fs.writeFileSync(target, '');
        else if (shape === 'multiline') fs.writeFileSync(target, `${good[targetIndex]}${good[targetIndex]}`);
        else if (shape === 'malformed') fs.writeFileSync(target, `${'g'.repeat(40)}\n`);
        else if (shape === 'trailing') fs.writeFileSync(target, `${good[targetIndex]}x`);
        else if (shape === 'nul-no-lf') fs.writeFileSync(target, Buffer.concat([
          Buffer.from(good[targetIndex].slice(0, 40)), Buffer.from([0]),
        ]));
        const result = spawnSync('bash', ['-c', RECEIPT_LOADER, 'bash', ...paths], {
          cwd: scratch, encoding: 'utf8',
        });
        fs.rmSync(pair, { recursive: true, force: true });
        return result;
      };
      const validDir = fs.mkdtempSync(path.join(scratch, 'valid-'));
      const validPaths = [path.join(validDir, 'base'), path.join(validDir, 'implementation')];
      fs.writeFileSync(validPaths[0], good[0]);
      fs.writeFileSync(validPaths[1], good[1]);
      const valid = spawnSync('bash', ['-c', RECEIPT_LOADER, 'bash', ...validPaths], {
        cwd: scratch, encoding: 'utf8',
      });
      expect(valid.status, valid.stderr).toBe(0);
      for (const targetIndex of [0, 1]) {
        for (const shape of [
          'missing', 'symlink', 'non-regular', 'empty', 'multiline',
          'malformed', 'trailing', 'nul-no-lf',
        ]) {
          const result = runPair(targetIndex, shape);
          expect(result.status, `${targetIndex}:${shape}`).not.toBe(0);
        }
      }
    } finally {
      fs.rmSync(scratch, { recursive: true, force: true });
    }
  });

  it('rejects non-commit and non-ancestor Plan 44 CLI refs without tag peeling', () => {
    const fixture = plan44RangeFixture();
    try {
      const blob = git(fixture.root, ['hash-object', '-w', 'scripts/check-operator-tasks.mjs']);
      for (const [base, impl] of [[blob, fixture.impl], [fixture.base, blob]]) {
        const result = run([
          '--root', fixture.root, '--plan44-base', base, '--plan44-impl', impl,
        ]);
        expect(result.status).toBe(1);
        expect(result.stderr).toContain('is not a direct commit object');
      }
      git(fixture.root, ['tag', '-a', 'plan44-tag', '-m', 'plan44 tag', fixture.base]);
      const tagObject = git(fixture.root, ['rev-parse', 'plan44-tag^{tag}']);
      expect(tagObject).toMatch(/^[0-9a-f]{40}$/);
      const tagged = run([
        '--root', fixture.root, '--plan44-base', tagObject, '--plan44-impl', fixture.impl,
      ]);
      expect(tagged.status).toBe(1);
      expect(tagged.stderr).toContain('base is not a direct commit object');

      const tree = git(fixture.root, ['rev-parse', `${fixture.base}^{tree}`]);
      const unrelated = git(fixture.root, ['commit-tree', tree, '-m', 'unrelated root']);
      const ancestry = run([
        '--root', fixture.root, '--plan44-base', unrelated, '--plan44-impl', fixture.impl,
      ]);
      expect(ancestry.status).toBe(1);
      expect(ancestry.stderr).toContain('base is not an ancestor of implementation');
    } finally {
      fs.rmSync(fixture.root, { recursive: true, force: true });
    }
  });

  it('accepts only one Plan 44 plan-only closeout commit after implementation', () => {
    const complete = plan44RangeFixture({ closeoutSubject: 'docs(plan): mark Plan 44 executed' });
    try {
      if (!complete.final) throw new Error('closeout fixture missing final');
      const pass = run([
        '--root', complete.root,
        '--plan44-base', complete.base,
        '--plan44-impl', complete.impl,
        '--plan44-final', complete.final,
      ]);
      expect(pass.status, pass.stdout + pass.stderr).toBe(0);

      git(complete.root, ['commit', '-q', '--allow-empty', '-m', 'extra post-implementation commit']);
      const second = run([
        '--root', complete.root,
        '--plan44-base', complete.base,
        '--plan44-impl', complete.impl,
        '--plan44-final', git(complete.root, ['rev-parse', 'HEAD']),
      ]);
      expect(second.status).toBe(1);
      expect(second.stderr).toContain('final range must be one plan-only closeout commit');
    } finally {
      fs.rmSync(complete.root, { recursive: true, force: true });
    }

    for (const options of [
      { closeoutSubject: 'docs: wrong closeout subject' },
      { closeoutSubject: 'docs(plan): mark Plan 44 executed', extraCloseoutPath: 'closeout-extra.txt' },
    ]) {
      const fixture = plan44RangeFixture(options);
      try {
        if (!fixture.final) throw new Error('negative closeout fixture missing final');
        const result = run([
          '--root', fixture.root,
          '--plan44-base', fixture.base,
          '--plan44-impl', fixture.impl,
          '--plan44-final', fixture.final,
        ]);
        expect(result.status).toBe(1);
        expect(result.stderr).toContain('final range must be one plan-only closeout commit');
      } finally {
        fs.rmSync(fixture.root, { recursive: true, force: true });
      }
    }

    const nonAncestor = plan44RangeFixture({ closeoutSubject: 'docs(plan): mark Plan 44 executed' });
    try {
      if (!nonAncestor.final) throw new Error('non-ancestor fixture missing final');
      const tree = git(nonAncestor.root, ['rev-parse', `${nonAncestor.impl}^{tree}`]);
      const sideImpl = git(nonAncestor.root, [
        'commit-tree', tree, '-p', nonAncestor.base, '-m', PLAN44_SUBJECTS[3],
      ]);
      const result = run([
        '--root', nonAncestor.root,
        '--plan44-base', nonAncestor.base,
        '--plan44-impl', sideImpl,
        '--plan44-final', nonAncestor.final,
      ]);
      expect(result.status).toBe(1);
      expect(result.stderr).toContain('implementation is not an ancestor of final');
    } finally {
      fs.rmSync(nonAncestor.root, { recursive: true, force: true });
    }
  }, 120_000);
});
