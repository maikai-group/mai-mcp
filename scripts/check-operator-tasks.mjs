#!/usr/bin/env node
// Plan 43 fail-closed gate for the durable operator-task inbox.
// The checker reads source/DDL (never the database) so the same audit can run
// against isolated mutation roots and the assembled public artifact.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PRODUCER_RECEIPT = 'operator-task producers OK: planRegister, postPlanNote/Git bridge';
const PUBLIC_NON_SOURCE_INPUTS = [
  'db/schema.sql', 'db/migrations/2026-08-27-operator-tasks.sql',
  'db/migrations/2026-08-28-operator-task-history.sql',
  'db/migrations/2026-08-28-operator-task-history.rollback.sql',
  'scripts/check-operator-tasks.mjs', 'package.json',
];
const REQUIRED_PRODUCTION_INPUTS = [
  'src/operator-tasks.ts', 'src/plans.ts', 'src/git/plan-lifecycle.ts',
  'src/tool-defs.ts', 'src/index.ts', 'src/read-budget.ts',
  'src/coordination/index.ts', 'src/web-user-task-handlers.ts', 'src/web-server.ts',
];
const PRIVATE_RELEASE_MARKER = 'release/public';
const PRIVATE_RELEASE_INPUT = 'scripts/release-public.sh';
const privateReleaseRequired = (root) => fs.existsSync(path.join(root, PRIVATE_RELEASE_MARKER));
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
const PLAN_PATH = 'docs/superpowers/plans/2026-08-27-plan-43-operator-task-inbox.md';
const TASK_SUBJECTS = [
  'feat(tasks): add durable operator task domain',
  'feat(tasks): sync plan checklists and expose agent tools',
  'feat(tasks): add operator task web api',
  'feat(tasks): add My Tasks dashboard',
  'feat(skills): route operator work through My Tasks',
];
const REPAIR_RE = /^fix\(tasks\): address Plan 43 code review [0-9a-f]{8}(?:[ ,][0-9a-f]{8})*$/;
const CLOSEOUT_SUBJECT = 'docs(plan): mark Plan 43 executed';
const PLAN44_IMPLEMENTATION_PATHS = [
  'db/migrations/2026-08-28-operator-task-history.sql',
  'db/migrations/2026-08-28-operator-task-history.rollback.sql',
  'db/schema.sql', 'src/operator-tasks.ts', 'src/plans.ts',
  'src/__tests__/operator-tasks.test.ts',
  // User-approved execution amendment A2: durable rows require fixture isolation.
  'src/__tests__/tracker-bridges.test.ts',
  'src/web-user-task-handlers.ts', 'src/__tests__/web-user-task-handlers.test.ts',
  'frontend/src/lib/types.ts', 'frontend/src/views/tasks/MyTasks.tsx',
  'frontend/src/views/tasks/MyTasks.test.tsx', 'scripts/check-operator-tasks.mjs',
  'src/__tests__/operator-task-gates.test.ts', 'frontend/e2e/seed.sql',
  'frontend/e2e/smoke.spec.ts', 'docs/configuration.md',
];
const PLAN44_TASK_SUBJECTS = [
  'feat(tasks): add durable history tombstones',
  'feat(tasks): add atomic history removal api',
  'feat(tasks): group task tabs by plan',
  'test(tasks): lock operator task history invariants',
];
const PLAN44_REPAIR_RE = /^fix\(tasks\): address Plan 44 code review [0-9a-f]{8}(?:[ ,][0-9a-f]{8})*$/;
const PLAN44_PATH = 'docs/superpowers/plans/2026-08-28-plan-44-operator-task-history.md';
const PLAN44_CLOSEOUT_SUBJECT = 'docs(plan): mark Plan 44 executed';

const read = (root, rel) => {
  const file = path.join(root, rel);
  return fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : null;
};
const parse = (root, rel) => {
  const text = read(root, rel);
  return text === null ? null : ts.createSourceFile(rel, text, ts.ScriptTarget.ES2022, true);
};
const visit = (node, fn) => { fn(node); ts.forEachChild(node, (child) => visit(child, fn)); };
const normalizedSql = (text) => text.replace(/--[^\n]*/g, '').replace(/\s+/g, ' ').trim();
const sameList = (a, b) => JSON.stringify(a) === JSON.stringify(b);

function productionSources(root) {
  const files = [];
  const problems = [];
  const sourceRoot = path.join(root, 'src');
  if (!fs.existsSync(sourceRoot)) return { files, problems: ['required input missing: src'] };
  const walk = (directory) => {
    let entries;
    try { entries = fs.readdirSync(directory, { withFileTypes: true }); }
    catch { problems.push(`production source unreadable: ${path.relative(root, directory)}`); return; }
    for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
      const absolute = path.join(directory, entry.name);
      const rel = path.relative(root, absolute).split(path.sep).join('/');
      let stat;
      try { stat = fs.lstatSync(absolute); }
      catch { problems.push(`production source unreadable: ${rel}`); continue; }
      if (stat.isSymbolicLink()) { problems.push(`production source symlink forbidden: ${rel}`); continue; }
      if (stat.isDirectory()) { walk(absolute); continue; }
      if (!stat.isFile() || !entry.name.endsWith('.ts')) continue;
      const parts = rel.split('/');
      if (parts.includes('__tests__') || entry.name.endsWith('.test.ts')) continue;
      files.push(rel);
    }
  };
  walk(sourceRoot);
  return { files: files.sort(), problems };
}

const publicDeclaredInputs = (root) => [
  ...PUBLIC_NON_SOURCE_INPUTS, ...productionSources(root).files,
];
const declaredInputs = (root) => [
  ...publicDeclaredInputs(root),
  ...(privateReleaseRequired(root) ? [PRIVATE_RELEASE_INPUT] : []),
];

function operatorSchema(text) {
  const start = text.indexOf('CREATE TABLE IF NOT EXISTS operator_tasks');
  if (start < 0) return null;
  const index = text.indexOf('CREATE INDEX IF NOT EXISTS operator_tasks_plan', start);
  if (index < 0) return null;
  const end = text.indexOf(';', index);
  return end < 0 ? null : normalizedSql(text.slice(start, end + 1));
}

const PLAN44_SCHEMA_BLOCKS = [
  '  source_plan_slug      text,\n',
  '  removed_at            timestamptz,\n',
  `,\n  CONSTRAINT operator_tasks_source_identity CHECK (
    (source_kind = 'plan' AND source_plan_slug IS NOT NULL)
    OR (source_kind = 'ad_hoc' AND source_plan_slug IS NULL)
  )`,
  `,\n  CONSTRAINT operator_tasks_removed_terminal CHECK (
    removed_at IS NULL OR status IN ('completed','dismissed')
  )`,
  `\nCREATE UNIQUE INDEX IF NOT EXISTS operator_tasks_plan_source_key
  ON operator_tasks(project_id, source_plan_slug, task_key)
  WHERE source_kind = 'plan' AND source_plan_slug IS NOT NULL;`,
  `\nCREATE INDEX IF NOT EXISTS operator_tasks_visible
  ON operator_tasks(
    project_id, status, plan_id, resolved_at DESC NULLS LAST,
    kind, sort_order, created_at, id
  )
  WHERE removed_at IS NULL;`,
];

function stripHistorySchema(text) {
  let stripped = text;
  const missing = [];
  for (const block of PLAN44_SCHEMA_BLOCKS) {
    if (!stripped.includes(block)) missing.push(block.split('\n')[0].trim() || block.split('\n')[1].trim());
    else stripped = stripped.replace(block, '');
  }
  return { stripped, missing };
}

function namedFunctions(source) {
  const functions = new Map();
  visit(source, (node) => {
    if (ts.isFunctionDeclaration(node) && node.name) functions.set(node.name.text, node);
  });
  return functions;
}

function toolNames(source, declarationName) {
  let names = null;
  visit(source, (node) => {
    if (!ts.isVariableDeclaration(node) || node.name.getText() !== declarationName || !node.initializer) return;
    let init = node.initializer;
    while (ts.isAsExpression(init) || ts.isSatisfiesExpression(init)) init = init.expression;
    if (!ts.isArrayLiteralExpression(init)) return;
    const found = [];
    for (const element of init.elements) {
      if (!ts.isObjectLiteralExpression(element)) continue;
      const prop = element.properties.find((p) => ts.isPropertyAssignment(p) && p.name.getText() === 'name');
      if (prop && ts.isPropertyAssignment(prop) && ts.isStringLiteral(prop.initializer)) found.push(prop.initializer.text);
    }
    names = found;
  });
  return names;
}

function stringArray(source, name) {
  let values = null;
  visit(source, (node) => {
    if (!ts.isVariableDeclaration(node) || node.name.getText() !== name || !node.initializer) return;
    let init = node.initializer;
    while (ts.isAsExpression(init) || ts.isSatisfiesExpression(init)) init = init.expression;
    if (ts.isArrayLiteralExpression(init) && init.elements.every(ts.isStringLiteral)) {
      values = init.elements.map((element) => element.text);
    }
  });
  return values;
}

const TASK_DOMAIN_CALLS = new Set([
  'syncPlanOperatorTasks', 'operatorTasksPost', 'operatorTasksText',
  'listOperatorTasks', 'operatorTaskStatus', 'removeOperatorTasks',
]);
const isTaskDomainModule = (value) => /(?:^|\/)operator-tasks\.js$/.test(value);

function taskDomainModuleReferences(source, rel) {
  const references = [];
  if (!source.getFullText().includes('operator-tasks.js')) return references;
  visit(source, (node) => {
    if ((ts.isImportDeclaration(node) || ts.isExportDeclaration(node))
        && !(ts.isImportDeclaration(node) && node.importClause?.isTypeOnly)
        && !(ts.isExportDeclaration(node) && node.isTypeOnly)
        && node.moduleSpecifier && ts.isStringLiteral(node.moduleSpecifier)
        && isTaskDomainModule(node.moduleSpecifier.text)) {
      references.push(`${rel}:operator-tasks-module`);
      return;
    }
    if (ts.isCallExpression(node) && node.expression.kind === ts.SyntaxKind.ImportKeyword
        && node.arguments.length === 1 && ts.isStringLiteral(node.arguments[0])
        && isTaskDomainModule(node.arguments[0].text)) {
      references.push(`${rel}:operator-tasks-module`);
    }
  });
  return references;
}

function taskDomainCalls(source, rel) {
  const calls = [];
  if (rel !== 'src/operator-tasks.ts' && !source.getFullText().includes('operator-tasks.js')) {
    visit(source, (node) => {
      if (ts.isCallExpression(node) && ts.isIdentifier(node.expression)
          && TASK_DOMAIN_CALLS.has(node.expression.text)) {
        calls.push(`${rel}:${node.expression.text}`);
      }
    });
    return calls;
  }
  const taskBindings = new Map();
  const namespaceBindings = new Set();
  const unwrap = (expression) => {
    let current = expression;
    while (ts.isAwaitExpression(current) || ts.isParenthesizedExpression(current)
        || ts.isAsExpression(current) || ts.isSatisfiesExpression(current)
        || ts.isNonNullExpression(current)) current = current.expression;
    return current;
  };
  const isTaskNamespace = (expression) => {
    const current = unwrap(expression);
    if (ts.isIdentifier(current)) return namespaceBindings.has(current.text);
    return ts.isCallExpression(current) && current.expression.kind === ts.SyntaxKind.ImportKeyword
      && current.arguments.length === 1 && ts.isStringLiteral(current.arguments[0])
      && isTaskDomainModule(current.arguments[0].text);
  };
  const resolveTask = (expression) => {
    const current = unwrap(expression);
    if (ts.isIdentifier(current)) {
      return taskBindings.get(current.text)
        ?? (TASK_DOMAIN_CALLS.has(current.text) ? current.text : null);
    }
    if (ts.isPropertyAccessExpression(current) && isTaskNamespace(current.expression)
        && TASK_DOMAIN_CALLS.has(current.name.text)) return current.name.text;
    return null;
  };
  for (const statement of source.statements) {
    if (!ts.isImportDeclaration(statement) || !ts.isStringLiteral(statement.moduleSpecifier)
        || !isTaskDomainModule(statement.moduleSpecifier.text)) continue;
    const bindings = statement.importClause?.namedBindings;
    if (bindings && ts.isNamedImports(bindings)) {
      for (const element of bindings.elements) {
        const imported = element.propertyName?.text ?? element.name.text;
        if (TASK_DOMAIN_CALLS.has(imported)) taskBindings.set(element.name.text, imported);
      }
    } else if (bindings && ts.isNamespaceImport(bindings)) {
      namespaceBindings.add(bindings.name.text);
    }
  }
  let changed = true;
  while (changed) {
    changed = false;
    visit(source, (node) => {
      if (!ts.isVariableDeclaration(node) || !node.initializer) return;
      if (ts.isIdentifier(node.name)) {
        const resolved = resolveTask(node.initializer);
        if (resolved && taskBindings.get(node.name.text) !== resolved) {
          taskBindings.set(node.name.text, resolved);
          changed = true;
        } else if (isTaskNamespace(node.initializer) && !namespaceBindings.has(node.name.text)) {
          namespaceBindings.add(node.name.text);
          changed = true;
        }
        return;
      }
      if (!ts.isObjectBindingPattern(node.name) || !isTaskNamespace(node.initializer)) return;
      for (const element of node.name.elements) {
        if (!ts.isIdentifier(element.name)) continue;
        const imported = element.propertyName && ts.isIdentifier(element.propertyName)
          ? element.propertyName.text : element.name.text;
        if (TASK_DOMAIN_CALLS.has(imported) && taskBindings.get(element.name.text) !== imported) {
          taskBindings.set(element.name.text, imported);
          changed = true;
        }
      }
    });
  }
  const resolvedTasksIn = (node) => {
    const resolved = new Set();
    visit(node, (candidate) => {
      if (!ts.isIdentifier(candidate) && !ts.isPropertyAccessExpression(candidate)) return;
      const canonical = resolveTask(candidate);
      if (canonical) resolved.add(canonical);
    });
    return resolved;
  };
  for (const statement of source.statements) {
    if (ts.isExportDeclaration(statement) && !statement.moduleSpecifier
        && statement.exportClause && ts.isNamedExports(statement.exportClause)) {
      for (const element of statement.exportClause.elements) {
        const local = element.propertyName?.text ?? element.name.text;
        const canonical = resolveTask(ts.factory.createIdentifier(local));
        if (canonical) calls.push(`${rel}:${canonical}:reexport`);
      }
      continue;
    }
    if (ts.isExportAssignment(statement)) {
      for (const canonical of resolvedTasksIn(statement.expression)) {
        calls.push(`${rel}:${canonical}:reexport`);
      }
      continue;
    }
    if (!ts.isVariableStatement(statement)
        || !statement.modifiers?.some((modifier) => modifier.kind === ts.SyntaxKind.ExportKeyword)) continue;
    for (const declaration of statement.declarationList.declarations) {
      if (!declaration.initializer) continue;
      for (const canonical of resolvedTasksIn(declaration.initializer)) {
        calls.push(`${rel}:${canonical}:reexport`);
      }
    }
  }
  visit(source, (node) => {
    if (!ts.isCallExpression(node)) return;
    if (ts.isIdentifier(node.expression)) {
      const canonical = resolveTask(node.expression);
      if (canonical) calls.push(`${rel}:${canonical}`);
      return;
    }
    const canonical = resolveTask(node.expression);
    if (canonical) calls.push(`${rel}:${canonical}`);
  });
  return calls;
}

/** Return every problem so mutation tests can demand the intended diagnostic. */
export function auditRoot(root) {
  const census = productionSources(root);
  const problems = [...census.problems];
  const inputs = [...new Set([...declaredInputs(root), ...REQUIRED_PRODUCTION_INPUTS])];
  const sources = Object.fromEntries(inputs.map((rel) => [rel, read(root, rel)]));
  for (const [rel, text] of Object.entries(sources)) {
    if (text === null) problems.push(`required input missing: ${rel}`);
  }
  if (problems.length > 0) return problems;

  const parsedProduction = new Map();
  for (const rel of census.files) {
    const source = parse(root, rel);
    if (!source) { problems.push(`production source unreadable: ${rel}`); continue; }
    if (source.parseDiagnostics.length > 0) {
      problems.push(`production source unparseable: ${rel}`);
      continue;
    }
    parsedProduction.set(rel, source);
  }
  if (problems.length > 0) return problems;

  const currentSchema = sources['db/schema.sql'];
  const baseMigration = sources['db/migrations/2026-08-27-operator-tasks.sql'];
  const historyMigration = sources['db/migrations/2026-08-28-operator-task-history.sql'];
  const historyRollback = sources['db/migrations/2026-08-28-operator-task-history.rollback.sql'];
  const strippedHistory = stripHistorySchema(currentSchema);
  if (strippedHistory.missing.length > 0) {
    problems.push(`operator-task current history schema block missing: [${strippedHistory.missing}]`);
  }
  const schema = operatorSchema(strippedHistory.stripped);
  const migration = operatorSchema(baseMigration);
  if (schema === null || migration === null || schema !== migration) {
    problems.push('operator-task schema/migration parity mismatch');
  }
  const indexCount = (migration?.match(/CREATE (?:UNIQUE )?INDEX IF NOT EXISTS operator_tasks_/g) ?? []).length;
  if (indexCount !== 4) problems.push(`operator-task index census mismatch: ${indexCount} (want 4)`);
  const currentIndexCount = (currentSchema.match(/CREATE (?:UNIQUE )?INDEX IF NOT EXISTS operator_tasks_/g) ?? []).length;
  if (currentIndexCount !== 6) {
    problems.push(`operator-task current index census mismatch: ${currentIndexCount} (want 6)`);
  }
  if (/\b(?:source_plan_slug|removed_at)\b|operator_tasks_(?:source_identity|removed_terminal|plan_source_key|visible)/.test(baseMigration)) {
    problems.push('operator-task Plan 43 base migration contains history schema');
  }
  if (!/ADD COLUMN IF NOT EXISTS removed_at\s+timestamptz/.test(historyMigration)) {
    problems.push('operator-task history migration removed_at column missing');
  }
  if (!/ADD COLUMN IF NOT EXISTS source_plan_slug\s+text/.test(historyMigration)) {
    problems.push('operator-task history migration source_plan_slug column missing');
  }
  const requiredHistoryPatterns = [
    /SET source_plan_slug = plan\.slug[\s\S]*?task\.source_kind = 'plan'[\s\S]*?task\.source_plan_slug IS NULL/,
    /RAISE EXCEPTION 'cannot recover source identity for an orphaned plan task'/,
    /ADD CONSTRAINT operator_tasks_source_identity CHECK \(\s*\(source_kind = 'plan' AND source_plan_slug IS NOT NULL\)\s*OR \(source_kind = 'ad_hoc' AND source_plan_slug IS NULL\)\s*\)/,
    /ADD CONSTRAINT operator_tasks_removed_terminal CHECK \(\s*removed_at IS NULL OR status IN \('completed','dismissed'\)\s*\)/,
    /CREATE UNIQUE INDEX IF NOT EXISTS operator_tasks_plan_source_key\s*ON operator_tasks\(project_id, source_plan_slug, task_key\)\s*WHERE source_kind = 'plan' AND source_plan_slug IS NOT NULL;/,
    /CREATE INDEX IF NOT EXISTS operator_tasks_visible\s*ON operator_tasks\(\s*project_id, status, plan_id, resolved_at DESC NULLS LAST,\s*kind, sort_order, created_at, id\s*\)\s*WHERE removed_at IS NULL;/,
  ];
  if (requiredHistoryPatterns.some((pattern) => !pattern.test(historyMigration))) {
    problems.push('operator-task history migration contract incomplete');
  }
  const expectedRollback = normalizedSql(`
    DROP INDEX IF EXISTS operator_tasks_visible;
    DROP INDEX IF EXISTS operator_tasks_plan_source_key;
    ALTER TABLE operator_tasks DROP CONSTRAINT IF EXISTS operator_tasks_removed_terminal;
    ALTER TABLE operator_tasks DROP CONSTRAINT IF EXISTS operator_tasks_source_identity;
    ALTER TABLE operator_tasks DROP COLUMN IF EXISTS removed_at, DROP COLUMN IF EXISTS source_plan_slug;
  `);
  if (normalizedSql(historyRollback) !== expectedRollback) {
    problems.push('operator-task history rollback is not the bounded inverse');
  }

  const plansFile = parsedProduction.get('src/plans.ts');
  if (!plansFile) return [...problems, 'producer source missing: src/plans.ts'];
  const functions = namedFunctions(plansFile);
  const writers = [];
  for (const [name, fn] of functions) {
    const body = fn.getText(plansFile);
    if (/UPDATE\s+plans[\s\S]*?status\s*=\s*'executing'/i.test(body)) writers.push(name);
  }
  if (!sameList(writers.sort(), ['planRegister', 'postPlanNote'])) {
    problems.push(`operator-task producer census mismatch: [${writers.sort().join(', ')}]`);
  }
  const rogueWriterFiles = [];
  for (const [rel, source] of parsedProduction) {
    if (rel === 'src/plans.ts') continue;
    if (/UPDATE\s+plans[\s\S]*?status\s*=\s*['"`]executing['"`]/i.test(source.getFullText())) {
      rogueWriterFiles.push(rel);
    }
  }
  if (rogueWriterFiles.length > 0) {
    problems.push(`operator-task producer census mismatch: rogue production writers [${rogueWriterFiles.join(', ')}]`);
  }
  for (const name of ['planRegister', 'postPlanNote']) {
    const fn = functions.get(name);
    if (!fn) { problems.push(`operator-task producer missing: ${name}`); continue; }
    const body = fn.getText(plansFile);
    const begin = body.indexOf("await client.query('BEGIN')");
    const sync = body.indexOf('syncPlanOperatorTasks({');
    const writerMatch = /UPDATE\s+plans[\s\S]*?status\s*=\s*'executing'[\s\S]*?`/i.exec(body);
    const writer = writerMatch ? writerMatch.index : -1;
    const commit = body.indexOf("await client.query('COMMIT')", writer);
    if (begin < 0 || sync < 0 || writer < 0 || commit < 0 || !(begin < sync && sync < writer && writer < commit)) {
      problems.push(`operator-task ${name} transaction order invalid`);
    }
    const syncEnd = sync < 0 ? sync : body.indexOf('});', sync);
    if (syncEnd < 0 || !/\bclient\b/.test(body.slice(sync, syncEnd + 3))) {
      problems.push(`operator-task ${name} sync must share PoolClient`);
    }
    const writerText = writerMatch?.[0] ?? '';
    if (!/client\.query/.test(body.slice(Math.max(0, writer - 40), writer + writerText.length + 10))) {
      problems.push(`operator-task ${name} status writer escaped transaction`);
    }
    if (!/project_id\s*=\s*\$2/i.test(writerText) || !/status\s+(?:IN\s*\(|=\s*'approved')/i.test(writerText)) {
      problems.push(`operator-task ${name} project/status predicate missing`);
    }
    if (name === 'planRegister') {
      const aliases = body.indexOf('await consolidatePlanAliases(client, survivor, losers)');
      if (aliases < 0 || !(begin < aliases && aliases < sync)) {
        problems.push('operator-task executing alias consolidation escaped transaction');
      }
      const lockedIdentity = body.indexOf('FROM plans WHERE project_id = $1 ORDER BY id FOR UPDATE');
      if (lockedIdentity < 0 || !(begin < lockedIdentity && lockedIdentity < aliases)) {
        problems.push('operator-task executing identity rows must lock before alias resolution');
      }
    }
  }
  const plansText = sources['src/plans.ts'];
  if (/INSERT\s+INTO\s+plans[\s\S]{0,500}['"]executing['"]/i.test(plansText)) {
    problems.push('operator-task executing-on-insert is forbidden');
  }
  if (!/await\s+consolidatePlanAliases\(client,\s*survivor,\s*losers\)/.test(plansText)) {
    problems.push('operator-task executing branch bypasses shared alias helper');
  }
  if (!/await\s+consolidatePlanAliases\(client,\s*row,\s*physical\.slice\(1\)\)/.test(plansText)) {
    problems.push('operator-task non-executing branch bypasses shared alias helper');
  }
  const nonExecutingStart = plansText.indexOf('// Every registration path that can insert or retarget a plan');
  const nonExecutingBranch = nonExecutingStart < 0 ? '' : plansText.slice(nonExecutingStart);
  const nonExecutingBegin = nonExecutingBranch.indexOf("await client.query('BEGIN')");
  const nonExecutingAdvisory = nonExecutingBranch.indexOf(
    'SELECT pg_advisory_xact_lock(hashtextextended($1, 0))');
  const nonExecutingLock = nonExecutingBranch.indexOf(
    'FROM plans WHERE project_id = $1 ORDER BY id FOR UPDATE');
  const nonExecutingAliases = nonExecutingBranch.indexOf(
    'await consolidatePlanAliases(client, row, physical.slice(1))');
  const nonExecutingCommit = nonExecutingBranch.indexOf("await client.query('COMMIT')");
  if (!(nonExecutingBegin >= 0 && nonExecutingBegin < nonExecutingAdvisory
      && nonExecutingAdvisory < nonExecutingLock
      && nonExecutingLock < nonExecutingAliases
      && nonExecutingAliases < nonExecutingCommit)) {
    problems.push('operator-task non-executing alias consolidation escaped transaction');
  }
  const helper = functions.get('consolidatePlanAliases')?.getText(plansFile) ?? '';
  if (!/UPDATE\s+operator_tasks\s+SET\s+plan_id\s*=\s*\$1,\s*source_plan_slug\s*=\s*CASE\s+WHEN\s+source_kind\s*=\s*'plan'\s+THEN\s+\$3\s+ELSE\s+NULL\s+END\s+WHERE\s+plan_id\s*=\s*\$2/i.test(helper)) {
    problems.push('operator-task alias helper task transfer missing');
  }

  const actualCallSites = [];
  const actualModuleSites = [];
  const taskSqlFiles = [];
  for (const [rel, source] of parsedProduction) {
    actualCallSites.push(...taskDomainCalls(source, rel));
    actualModuleSites.push(...taskDomainModuleReferences(source, rel));
    if (/(?:FROM|INTO|UPDATE|JOIN|TABLE)\s+operator_tasks\b/i.test(source.getFullText())) taskSqlFiles.push(rel);
  }
  const expectedCallSites = [
    'src/index.ts:operatorTasksPost', 'src/index.ts:operatorTasksText',
    'src/operator-tasks.ts:listOperatorTasks', 'src/operator-tasks.ts:syncPlanOperatorTasks',
    'src/plans.ts:syncPlanOperatorTasks', 'src/plans.ts:syncPlanOperatorTasks',
    'src/web-user-task-handlers.ts:listOperatorTasks',
    'src/web-user-task-handlers.ts:operatorTaskStatus',
    'src/web-user-task-handlers.ts:removeOperatorTasks',
  ];
  if (!sameList(actualCallSites.sort(), expectedCallSites.sort())) {
    problems.push(`operator-task task-domain caller census mismatch: [${actualCallSites.join(', ')}]`);
  }
  const expectedModuleSites = [
    'src/index.ts:operator-tasks-module',
    'src/plans.ts:operator-tasks-module', 'src/plans.ts:operator-tasks-module',
    'src/web-user-task-handlers.ts:operator-tasks-module',
  ];
  if (!sameList(actualModuleSites.sort(), expectedModuleSites.sort())) {
    problems.push(`operator-task module-reference census mismatch: [${actualModuleSites.join(', ')}]`);
  }
  if (!sameList(taskSqlFiles.sort(), ['src/operator-tasks.ts', 'src/plans.ts'])) {
    problems.push(`operator-task SQL sink census mismatch: [${taskSqlFiles.sort().join(', ')}]`);
  }

  const checkerFile = parse(root, 'scripts/check-operator-tasks.mjs');
  const rootedFileMap = checkerFile ? stringArray(checkerFile, 'FILE_MAP') : null;
  if (!rootedFileMap || rootedFileMap.length !== 37
      || !rootedFileMap.includes('src/git/plan-lifecycle.ts')) {
    problems.push('operator-task lifecycle owner missing from implementation-range ledger');
  } else if (!sameList([...rootedFileMap].sort(), [...FILE_MAP].sort())) {
    problems.push('operator-task implementation-range ledger drift');
  }

  const defsFile = parse(root, 'src/tool-defs.ts');
  const coordFile = parse(root, 'src/coordination/index.ts');
  const budgetFile = parse(root, 'src/read-budget.ts');
  if (!defsFile || !coordFile || !budgetFile) return [...problems, 'operator-task tool census source missing'];
  const defs = toolNames(defsFile, 'TOOLS');
  const coord = toolNames(coordFile, 'COORDINATION_TOOL_DEFS');
  const reads = stringArray(budgetFile, 'MCP_READ_TOOLS');
  const nonReads = stringArray(budgetFile, 'MCP_NON_READ_TOOLS');
  if (!defs || !coord || !reads || !nonReads) {
    problems.push('operator-task tool census unreadable');
  } else {
    const registered = [...defs, ...coord].sort();
    const classified = [...reads, ...nonReads].sort();
    if (registered.length !== 47 || classified.length !== 47 || !sameList(registered, classified)) {
      problems.push(`operator-task tool classification mismatch: ${registered.length}/${classified.length} (want 47/47)`);
    }
    if (!reads.includes('mai_user_tasks') || nonReads.includes('mai_user_tasks')) {
      problems.push('mai_user_tasks read classification missing');
    }
    if (!nonReads.includes('mai_user_tasks_post') || reads.includes('mai_user_tasks_post')) {
      problems.push('mai_user_tasks_post non-read classification missing');
    }
  }
  const defsText = sources['src/tool-defs.ts'];
  const taskDefsStart = defsText.indexOf('name: "mai_user_tasks_post"');
  const taskDefsEnd = defsText.indexOf('name: "mai_review_post"', taskDefsStart);
  const taskDefs = taskDefsStart < 0 || taskDefsEnd < 0 ? '' : defsText.slice(taskDefsStart, taskDefsEnd);
  if (!taskDefs || /\b(?:complete|reopen|dismiss|status|remove|removed_at|task_ids|group_key|snapshot)\s*:/.test(taskDefs)) {
    problems.push('operator-task agent resolution property forbidden');
  }

  const operatorSource = sources['src/operator-tasks.ts'];
  const banned = /\bagent_messages\b|transcript|session[ _-]?chat|tracking[ /_-]?todos?|markdown[ _-]?checkbox|checkbox[ _-]?scanner|(?:from\s+)?['"][^'"]*notes|(?:from\s+)?['"][^'"]*coordination\/board/i;
  if (banned.test(operatorSource)) problems.push('operator-task chat/board/scraper dependency forbidden');
  if (!/UPDATE\s+operator_tasks[\s\S]*?WHERE\s+id\s*=\s*\$1\s+AND\s+project_id\s*=\s*\$2\s+AND\s+removed_at\s+IS\s+NULL\s+AND\s+\$\{guard\}/i.test(operatorSource)) {
    problems.push('operator-task project predicate missing');
  }
  const operatorFile = parsedProduction.get('src/operator-tasks.ts');
  const operatorFunctions = operatorFile ? namedFunctions(operatorFile) : new Map();
  const functionBody = (name) => operatorFunctions.get(name)?.getText(operatorFile) ?? '';
  const pendingBody = functionBody('pendingCounts');
  const listBody = functionBody('listOperatorTasks');
  const mutationBody = functionBody('mutationSql');
  const taskRemoval = functionBody('removeOperatorTasks');
  const groupRemoval = functionBody('removeOperatorTaskGroup');
  const snapshotBody = functionBody('removalSnapshot');
  const syncBody = functionBody('syncWithClient');
  if (!/WHERE project_id = \$1 AND removed_at IS NULL/.test(pendingBody)) {
    problems.push('operator-task pending count tombstone filter missing');
  }
  if (!/AND ot\.removed_at IS NULL/.test(listBody)) {
    problems.push('operator-task list tombstone filter missing');
  }
  if (!/WHERE id = \$1 AND project_id = \$2 AND removed_at IS NULL AND \$\{guard\}/.test(mutationBody)) {
    problems.push('operator-task status tombstone guard missing');
  }
  if (!/taskIds\.length < 1[\s\S]*?taskIds\.length > 100[\s\S]*?UUID_RE\.test[\s\S]*?new Set\(taskIds\)/.test(taskRemoval)
      || !/await client\.query\('BEGIN'\)/.test(taskRemoval)
      || !/ORDER BY id FOR UPDATE/.test(taskRemoval)
      || !/removed\.rowCount !== taskIds\.length/.test(taskRemoval)
      || !/await client\.query\('COMMIT'\)/.test(taskRemoval)
      || !/await client\.query\('ROLLBACK'\)/.test(taskRemoval)
      || !/return removeOperatorTaskGroup\(\{ projectId: args\.projectId, target: args\.target \}\)/.test(taskRemoval)) {
    problems.push('operator-task task removal transaction contract incomplete');
  }
  if (!/UPDATE operator_tasks[\s\S]*?WHERE project_id = \$1 AND id = ANY\(\$2::uuid\[\]\)/.test(taskRemoval)) {
    problems.push('operator-task task removal project predicate missing');
  }
  if (!/UPDATE operator_tasks[\s\S]*?removed_at IS NULL AND status IN \('completed','dismissed'\)[\s\S]*?RETURNING id/.test(taskRemoval)) {
    problems.push('operator-task task removal terminal guard missing');
  }
  if (!/groupKey !== 'unlinked'[\s\S]*?planMatch/.test(groupRemoval)
      || !/ORDER BY id FOR UPDATE/.test(groupRemoval)
      || !/removed\.rowCount !== ids\.length/.test(groupRemoval)
      || !/await client\.query\('BEGIN'\)/.test(groupRemoval)
      || !/await client\.query\('COMMIT'\)/.test(groupRemoval)
      || !/await client\.query\('ROLLBACK'\)/.test(groupRemoval)) {
    problems.push('operator-task group removal transaction contract incomplete');
  }
  if (!/WHERE project_id = \$1 AND plan_id IS NULL/.test(groupRemoval)
      || !/WHERE project_id = \$1 AND plan_id = \$2/.test(groupRemoval)
      || !/UPDATE operator_tasks[\s\S]*?WHERE project_id = \$1 AND id = ANY\(\$2::uuid\[\]\)/.test(groupRemoval)) {
    problems.push('operator-task group removal project predicate missing');
  }
  const groupTerminalGuards = groupRemoval.match(
    /removed_at IS NULL AND status IN \('completed','dismissed'\)/g,
  ) ?? [];
  if (groupTerminalGuards.length !== 3) {
    problems.push('operator-task group removal terminal guard missing');
  }
  if (!/removalSnapshot\(selected\.rows\) !== args\.target\.snapshot/.test(groupRemoval)) {
    problems.push('operator-task group removal snapshot guard missing');
  }
  if (!/\.sort\(\(left, right\) => left\.id\.localeCompare\(right\.id\)\)/.test(snapshotBody)
      || !/new Date\(row\.updated_at\)\.toISOString\(\)/.test(snapshotBody)
      || !/createHash\('sha256'\)/.test(snapshotBody)
      || !/removalSnapshot\(terminal\)/.test(listBody)
      || !/removalSnapshot\(selected\.rows\)/.test(groupRemoval)) {
    problems.push('operator-task removal snapshot implementation incomplete');
  }
  if (!/WHERE project_id = \$1 AND source_plan_slug = \$2 AND task_key = \$3/.test(syncBody)
      || !/UPDATE operator_tasks SET plan_id = \$1 WHERE id = \$2 AND plan_id IS NULL/.test(syncBody)) {
    problems.push('operator-task plan sync source identity predicate missing');
  }
  if (/removed_at\s*=\s*(?:NULL|null)/.test(syncBody)) {
    problems.push('operator-task plan sync must never clear tombstones');
  }

  const webSource = sources['src/web-server.ts'];
  const postDispatch = webSource.indexOf('if (req.method === "POST")');
  const getDispatch = webSource.indexOf('if (req.method === "GET")');
  const getSection = getDispatch < 0 || postDispatch < 0 ? '' : webSource.slice(getDispatch, postDispatch);
  const postSection = postDispatch < 0 ? '' : webSource.slice(postDispatch);
  if (!/err instanceof UserTaskClientError \? err\.status : 500/.test(getSection)) {
    problems.push('operator-task GET client-error translation missing');
  }
  if (!/err instanceof UserTaskClientError \? err\.status : 500/.test(postSection)) {
    problems.push('operator-task POST client-error translation missing');
  }

  if (privateReleaseRequired(root)) {
    const release = sources[PRIVATE_RELEASE_INPUT];
    if (!/check-operator-tasks\.mjs/.test(release)) problems.push('operator-task release checker omission');
    if (!/for\s+m\s+in\s+db\/migrations\/\*/.test(release)) problems.push('operator-task release migration include-list missing');
  }
  const pkg = JSON.parse(sources['package.json']);
  if (pkg.scripts?.['check:operator-tasks'] !== 'node scripts/check-operator-tasks.mjs') {
    problems.push('operator-task package gate command missing');
  }
  return problems;
}

const git = (args, cwd = REPO_ROOT) => execFileSync('git', args, {
  cwd, encoding: 'utf8', maxBuffer: 32 * 1024 * 1024,
});

export function auditRange(base, finalRef, cwd = REPO_ROOT) {
  const problems = [];
  const end = finalRef ?? 'HEAD';
  try { git(['diff', '--check', `${base}..${end}`], cwd); }
  catch (err) { problems.push(`operator-task base range fails diff-check: ${String(err.stdout ?? '').trim()}`); }
  const changed = git(['diff', '--name-only', `${base}..${end}`], cwd)
    .split('\n').map((s) => s.trim()).filter(Boolean).sort();
  const expected = finalRef ? [...FILE_MAP, PLAN_PATH].sort() : [...FILE_MAP].sort();
  if (!sameList(changed, expected)) {
    const missing = expected.filter((p) => !changed.includes(p));
    const extra = changed.filter((p) => !expected.includes(p));
    problems.push(`operator-task File Map range mismatch: missing=[${missing}] extra=[${extra}]`);
  }
  const subjects = git(['log', '--reverse', '--format=%s', `${base}..${end}`], cwd)
    .split('\n').map((s) => s.trim()).filter(Boolean);
  const tasks = subjects.filter((s) => TASK_SUBJECTS.includes(s));
  if (!sameList(tasks, TASK_SUBJECTS)) problems.push(`operator-task task commits out of order or missing: [${tasks}]`);
  for (const subject of subjects) {
    if (TASK_SUBJECTS.includes(subject) || REPAIR_RE.test(subject) || subject === CLOSEOUT_SUBJECT) continue;
    problems.push(`operator-task unrelated commit in range: ${subject}`);
  }
  if (finalRef) {
    const finalHash = git(['rev-parse', finalRef], cwd).trim();
    const finalSubject = git(['show', '-s', '--format=%s', finalHash], cwd).trim();
    const finalPaths = git(['show', '--name-only', '--format=', finalHash], cwd)
      .split('\n').map((s) => s.trim()).filter(Boolean);
    if (finalSubject !== CLOSEOUT_SUBJECT || !sameList(finalPaths, [PLAN_PATH])) {
      problems.push('operator-task final commit must be the plan-only closeout');
    }
  } else if (changed.includes(PLAN_PATH)) {
    problems.push('operator-task pre-close range includes bookkeeping plan row');
  }
  return problems;
}

function directCommitRef(ref, label, cwd, problems) {
  if (!/^[0-9a-f]{40}$/.test(ref ?? '')) {
    problems.push(`operator-task Plan 44 ${label} must be an exact 40-hex commit id`);
    return false;
  }
  try {
    const type = git(['cat-file', '-t', ref], cwd).trim();
    if (type !== 'commit') {
      problems.push(`operator-task Plan 44 ${label} is not a direct commit object`);
      return false;
    }
  } catch {
    problems.push(`operator-task Plan 44 ${label} does not name an object`);
    return false;
  }
  return true;
}

export function auditPlan44Range(base, implementation, finalRef, cwd = REPO_ROOT) {
  const problems = [];
  const baseOk = directCommitRef(base, 'base', cwd, problems);
  const implOk = directCommitRef(implementation, 'implementation', cwd, problems);
  const finalOk = finalRef === undefined
    ? true
    : directCommitRef(finalRef, 'final', cwd, problems);
  if (!baseOk || !implOk || !finalOk) return problems;

  const ancestor = spawnSync('git', ['merge-base', '--is-ancestor', base, implementation], {
    cwd, encoding: 'utf8',
  });
  if (ancestor.status !== 0) {
    problems.push('operator-task Plan 44 base is not an ancestor of implementation');
    return problems;
  }
  try { git(['diff', '--check', `${base}..${implementation}`], cwd); }
  catch (err) {
    problems.push(`operator-task Plan 44 implementation range fails diff-check: ${String(err.stdout ?? '').trim()}`);
  }
  const changed = git(['diff', '--name-only', `${base}..${implementation}`], cwd)
    .split('\n').map((value) => value.trim()).filter(Boolean).sort();
  const expected = [...PLAN44_IMPLEMENTATION_PATHS].sort();
  if (!sameList(changed, expected)) {
    const missing = expected.filter((item) => !changed.includes(item));
    const extra = changed.filter((item) => !expected.includes(item));
    problems.push(`operator-task Plan 44 File Map range mismatch: missing=[${missing}] extra=[${extra}]`);
  }
  const subjects = git(['log', '--reverse', '--format=%s', `${base}..${implementation}`], cwd)
    .split('\n').map((value) => value.trim()).filter(Boolean);
  const tasks = subjects.filter((subject) => PLAN44_TASK_SUBJECTS.includes(subject));
  if (!sameList(tasks, PLAN44_TASK_SUBJECTS)) {
    problems.push(`operator-task Plan 44 task commits out of order or missing: [${tasks}]`);
  }
  for (const subject of subjects) {
    if (PLAN44_TASK_SUBJECTS.includes(subject) || PLAN44_REPAIR_RE.test(subject)) continue;
    problems.push(`operator-task Plan 44 unrelated commit in implementation range: ${subject}`);
  }
  try {
    const baseMigration = git(['show', `${base}:db/migrations/2026-08-27-operator-tasks.sql`], cwd);
    const implMigration = git(['show', `${implementation}:db/migrations/2026-08-27-operator-tasks.sql`], cwd);
    if (baseMigration !== implMigration) {
      problems.push('operator-task Plan 44 immutable Plan 43 base migration changed');
    }
  } catch {
    problems.push('operator-task Plan 44 immutable Plan 43 base migration is unreadable');
  }

  if (finalRef !== undefined) {
    const finalAncestor = spawnSync('git', ['merge-base', '--is-ancestor', implementation, finalRef], {
      cwd, encoding: 'utf8',
    });
    if (finalAncestor.status !== 0) {
      problems.push('operator-task Plan 44 implementation is not an ancestor of final');
      return problems;
    }
    const postSubjects = git(['log', '--reverse', '--format=%s', `${implementation}..${finalRef}`], cwd)
      .split('\n').map((value) => value.trim()).filter(Boolean);
    const postPaths = git(['diff', '--name-only', `${implementation}..${finalRef}`], cwd)
      .split('\n').map((value) => value.trim()).filter(Boolean).sort();
    if (!sameList(postSubjects, [PLAN44_CLOSEOUT_SUBJECT])
        || !sameList(postPaths, [PLAN44_PATH])) {
      problems.push('operator-task Plan 44 final range must be one plan-only closeout commit');
    }
    const completePaths = git(['diff', '--name-only', `${base}..${finalRef}`], cwd)
      .split('\n').map((value) => value.trim()).filter(Boolean).sort();
    if (!sameList(completePaths, [...PLAN44_IMPLEMENTATION_PATHS, PLAN44_PATH].sort())) {
      problems.push('operator-task Plan 44 complete range path set is invalid');
    }
  }
  return problems;
}

const sha256 = (file) => createHash('sha256').update(fs.readFileSync(file)).digest('hex');
function scratchCopy(files = declaredInputs(REPO_ROOT), { privateMarker = privateReleaseRequired(REPO_ROOT) } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'mai-operator-tasks-'));
  for (const rel of files) {
    fs.mkdirSync(path.join(root, path.dirname(rel)), { recursive: true });
    fs.copyFileSync(path.join(REPO_ROOT, rel), path.join(root, rel));
  }
  if (privateMarker) fs.mkdirSync(path.join(root, PRIVATE_RELEASE_MARKER), { recursive: true });
  return root;
}

const MUTANTS = [
  { id: 'M1-direct-sync-removed', file: 'src/plans.ts', find: 'operatorTasks = await syncPlanOperatorTasks({ plan: survivor.id, expectedSha: sha, client });', replace: 'operatorTasks = { inserted: 0, existing: 0, blocking: 0, follow_up: 0 };', expect: 'operator-task planRegister transaction order invalid' },
  { id: 'M2-direct-sync-reordered', file: 'src/plans.ts', find: "operatorTasks = await syncPlanOperatorTasks({ plan: survivor.id, expectedSha: sha, client });\n      const result", replace: 'const result', expect: 'operator-task planRegister transaction order invalid' },
  { id: 'M3-direct-shared-client', file: 'src/plans.ts', find: 'plan: survivor.id, expectedSha: sha, client', replace: 'plan: survivor.id, expectedSha: sha', expect: 'operator-task planRegister sync must share PoolClient' },
  { id: 'M4-direct-transaction-escape', file: 'src/plans.ts', find: "await client.query('BEGIN');", replace: "await pool.query('BEGIN');", expect: 'operator-task planRegister transaction order invalid' },
  { id: 'M5-bridge-sync-removed', file: 'src/plans.ts', find: 'operatorTasks = await syncPlanOperatorTasks({\n        plan: planId, expectedSha: plan.current_sha, client,\n      });', replace: 'operatorTasks = { inserted: 0, existing: 0, blocking: 0, follow_up: 0 };', expect: 'operator-task postPlanNote transaction order invalid' },
  { id: 'M6-bridge-sync-reordered', file: 'src/plans.ts', find: "operatorTasks = await syncPlanOperatorTasks({\n        plan: planId, expectedSha: plan.current_sha, client,\n      });\n      const updated", replace: 'const updated', expect: 'operator-task postPlanNote transaction order invalid' },
  { id: 'M7-bridge-shared-client', file: 'src/plans.ts', find: 'plan: planId, expectedSha: plan.current_sha, client,', replace: 'plan: planId, expectedSha: plan.current_sha,', expect: 'operator-task postPlanNote sync must share PoolClient' },
  { id: 'M8-bridge-transaction-escape', file: 'src/plans.ts', find: "const updated = await client.query(\n        `UPDATE plans SET status = 'executing'", replace: "const updated = await pool.query(\n        `UPDATE plans SET status = 'executing'", expect: 'operator-task postPlanNote status writer escaped transaction' },
  { id: 'M9-extra-writer', file: 'src/plans.ts', find: 'export async function retractPlanNote(', replace: "async function rogueWriter(client: PoolClient) { await client.query(`UPDATE plans SET status = 'executing' WHERE id = $1`); }\n\nexport async function retractPlanNote(", expect: 'operator-task producer census mismatch' },
  { id: 'M10-renamed-writer', file: 'src/plans.ts', find: 'export async function postPlanNote(', replace: 'export async function renamedPlanNote(', expect: 'operator-task producer census mismatch' },
  { id: 'M11-executing-on-insert', file: 'src/plans.ts', find: "VALUES ($1, $2, $3, $4, $5, COALESCE($6, 'draft'))", replace: "VALUES ($1, $2, $3, $4, $5, 'executing')", expect: 'operator-task executing-on-insert is forbidden' },
  { id: 'M12-agent-resolution', file: 'src/tool-defs.ts', find: 'plan_path: { type: "string", minLength: 1, maxLength: 1000 },\n        tasks:', replace: 'plan_path: { type: "string", minLength: 1, maxLength: 1000 },\n        status: { type: "string" },\n        tasks:', expect: 'operator-task agent resolution property forbidden' },
  { id: 'M13-chat-dependency', file: 'src/operator-tasks.ts', find: "import crypto from 'node:crypto';", replace: "import crypto from 'node:crypto';\nimport './coordination/board.js';", expect: 'operator-task chat/board/scraper dependency forbidden' },
  { id: 'M14-schema-drift', file: 'db/schema.sql', find: 'sort_order            int NOT NULL CHECK (sort_order BETWEEN 0 AND 99),', replace: 'sort_order            int NOT NULL CHECK (sort_order BETWEEN 0 AND 999),', expect: 'operator-task schema/migration parity mismatch' },
  { id: 'M15-project-predicate', file: 'src/operator-tasks.ts', find: 'WHERE id = $1 AND project_id = $2 AND removed_at IS NULL AND ${guard}', replace: 'WHERE id = $1 AND $2::uuid IS NOT NULL AND removed_at IS NULL AND ${guard}', expect: 'operator-task project predicate missing' },
  { id: 'M16-tool-misclassification', file: 'src/read-budget.ts', find: "  'mai_user_tasks', 'mai_receipts',\n] as const;", replace: '] as const;', expect: 'operator-task tool classification mismatch' },
  { id: 'M17-release-omission', file: 'scripts/release-public.sh', find: 'check-operator-tasks.mjs ', replace: '', expect: 'operator-task release checker omission' },
  { id: 'M18-nonexec-helper-bypass', file: 'src/plans.ts', find: 'await consolidatePlanAliases(client, row, physical.slice(1));', replace: 'void physical;', expect: 'operator-task non-executing branch bypasses shared alias helper' },
  { id: 'M19-task-transfer-removed', file: 'src/plans.ts', find: "await client.query(\n      `UPDATE operator_tasks\n          SET plan_id = $1,\n              source_plan_slug = CASE WHEN source_kind = 'plan' THEN $3 ELSE NULL END\n        WHERE plan_id = $2`,\n      [survivor.id, loser.id, survivor.slug]\n    );", replace: 'void loser;', expect: 'operator-task alias helper task transfer missing' },
  { id: 'M20-direct-project-predicate', file: 'src/plans.ts', find: "WHERE id = $1 AND project_id = $2 AND status IN ('approved','executing')", replace: "WHERE id = $1 AND status IN ('approved','executing')", expect: 'operator-task planRegister project/status predicate missing' },
  { id: 'M21-executing-alias-order', file: 'src/plans.ts', find: 'await consolidatePlanAliases(client, survivor, losers);', replace: 'void losers;', expect: 'operator-task executing alias consolidation escaped transaction' },
  { id: 'M22-nonexec-alias-order', file: 'src/plans.ts', find: 'await consolidatePlanAliases(client, row, physical.slice(1));', replace: "await client.query('COMMIT');\n      await consolidatePlanAliases(client, row, physical.slice(1));", expect: 'operator-task non-executing alias consolidation escaped transaction' },
  { id: 'M23-lifecycle-ledger-removal', file: 'scripts/check-operator-tasks.mjs', find: "  'db/schema.sql', 'src/operator-tasks.ts', 'src/plans.ts', 'src/git/plan-lifecycle.ts',", replace: "  'db/schema.sql', 'src/operator-tasks.ts', 'src/plans.ts',", expect: 'operator-task lifecycle owner missing from implementation-range ledger' },
  { id: 'M24-rogue-production-writer', file: 'src/rogue-operator-writer.ts', create: "export async function rogue(client) { await client.query(`UPDATE plans SET status = 'executing' WHERE id = $1`); }\n", expect: 'operator-task producer census mismatch' },
  { id: 'M25-rogue-board-task-caller', file: 'src/rogue-board-task-caller.ts', create: "import { operatorTaskStatus } from './operator-tasks.js';\nconst mirrorTaskStatus = operatorTaskStatus;\nexport async function mirrorAgentMessage(agent_messages) { return mirrorTaskStatus(agent_messages); }\n", expect: 'operator-task task-domain caller census mismatch' },
  { id: 'M26-get-client-error-translation', file: 'src/web-server.ts', find: ' || err instanceof UserTaskClientError', replace: '', occurrence: 1, expect: 'operator-task GET client-error translation missing' },
  { id: 'M27-post-client-error-translation', file: 'src/web-server.ts', find: ' || err instanceof UserTaskClientError', replace: '', occurrence: 2, expect: 'operator-task POST client-error translation missing' },
  { id: 'M28-pending-tombstone-filter', file: 'src/operator-tasks.ts', find: 'WHERE project_id = $1 AND removed_at IS NULL', replace: 'WHERE project_id = $1', expect: 'operator-task pending count tombstone filter missing' },
  { id: 'M29-list-tombstone-filter', file: 'src/operator-tasks.ts', find: '        AND ot.removed_at IS NULL\n', replace: '', expect: 'operator-task list tombstone filter missing' },
  { id: 'M30-status-tombstone-guard', file: 'src/operator-tasks.ts', find: 'WHERE id = $1 AND project_id = $2 AND removed_at IS NULL AND ${guard}', replace: 'WHERE id = $1 AND project_id = $2 AND ${guard}', expect: 'operator-task status tombstone guard missing' },
  { id: 'M31-task-removal-project', file: 'src/operator-tasks.ts', find: "UPDATE operator_tasks\n          SET removed_at = now(), updated_at = now()\n        WHERE project_id = $1 AND id = ANY($2::uuid[])", replace: "UPDATE operator_tasks\n          SET removed_at = now(), updated_at = now()\n        WHERE $1::uuid IS NOT NULL AND id = ANY($2::uuid[])", occurrence: 2, expect: 'operator-task task removal project predicate missing' },
  { id: 'M32-task-removal-terminal', file: 'src/operator-tasks.ts', find: "AND removed_at IS NULL AND status IN ('completed','dismissed')", replace: 'AND removed_at IS NULL', occurrence: 4, expect: 'operator-task task removal terminal guard missing' },
  { id: 'M33-history-removed-column', file: 'db/migrations/2026-08-28-operator-task-history.sql', find: '  ADD COLUMN IF NOT EXISTS removed_at timestamptz;', replace: ';', expect: 'operator-task history migration removed_at column missing' },
  { id: 'M34-base-history-injection', file: 'db/migrations/2026-08-27-operator-tasks.sql', find: '  resolved_at           timestamptz,', replace: '  resolved_at           timestamptz,\n  removed_at            timestamptz,', expect: 'operator-task Plan 43 base migration contains history schema' },
  { id: 'M35-history-source-column', file: 'db/migrations/2026-08-28-operator-task-history.sql', find: '  ADD COLUMN IF NOT EXISTS source_plan_slug text,\n', replace: '', expect: 'operator-task history migration source_plan_slug column missing' },
  { id: 'M36-sync-source-identity', file: 'src/operator-tasks.ts', find: 'WHERE project_id = $1 AND source_plan_slug = $2 AND task_key = $3', replace: 'WHERE project_id = $1 AND task_key = $3', expect: 'operator-task plan sync source identity predicate missing' },
  { id: 'M37-group-snapshot', file: 'src/operator-tasks.ts', find: 'selected.rows.length === 0 || removalSnapshot(selected.rows) !== args.target.snapshot', replace: 'selected.rows.length === 0', expect: 'operator-task group removal snapshot guard missing' },
  { id: 'M38-group-project', file: 'src/operator-tasks.ts', find: 'WHERE project_id = $1 AND plan_id IS NULL', replace: 'WHERE plan_id IS NULL', expect: 'operator-task group removal project predicate missing' },
];

function selfTest() {
  const failures = [];
  const missing = scratchCopy(declaredInputs(REPO_ROOT).filter((rel) => rel !== 'src/plans.ts'));
  try {
    if (!auditRoot(missing).some((p) => p === 'required input missing: src/plans.ts')) failures.push('self-test: missing producer source passed');
  } finally { fs.rmSync(missing, { recursive: true, force: true }); }
  const malformed = scratchCopy();
  try {
    fs.writeFileSync(path.join(malformed, 'package.json'), '{');
    try { auditRoot(malformed); failures.push('self-test: malformed package passed'); }
    catch { /* fail closed */ }
  } finally { fs.rmSync(malformed, { recursive: true, force: true }); }
  const publicArtifact = scratchCopy(publicDeclaredInputs(REPO_ROOT), { privateMarker: false });
  try {
    const publicProblems = auditRoot(publicArtifact);
    if (publicProblems.length > 0) failures.push(`self-test: marker-free public artifact failed — ${publicProblems.join('; ')}`);
    fs.mkdirSync(path.join(publicArtifact, PRIVATE_RELEASE_MARKER), { recursive: true });
    if (!auditRoot(publicArtifact).includes(`required input missing: ${PRIVATE_RELEASE_INPUT}`)) {
      failures.push('self-test: private marker did not require release assembler');
    }
  } finally { fs.rmSync(publicArtifact, { recursive: true, force: true }); }
  return failures;
}

function mutationTest() {
  const failures = [];
  const inputs = declaredInputs(REPO_ROOT);
  const before = Object.fromEntries(inputs.map((rel) => [rel, sha256(path.join(REPO_ROOT, rel))]));
  const applicable = MUTANTS.filter((mutant) => mutant.id !== 'M17-release-omission' || privateReleaseRequired(REPO_ROOT));
  for (const mutant of applicable) {
    const root = scratchCopy();
    try {
      const target = path.join(root, mutant.file);
      if (mutant.create !== undefined) {
        fs.mkdirSync(path.dirname(target), { recursive: true });
        fs.writeFileSync(target, mutant.create);
      } else {
        const original = fs.readFileSync(target, 'utf8');
        const occurrences = original.split(mutant.find).length - 1;
        const occurrence = mutant.occurrence ?? 1;
        if (occurrences < occurrence) { failures.push(`${mutant.id}: source anchor not found`); continue; }
        let seen = 0;
        const mutated = original.replaceAll(mutant.find, (match) => {
          seen += 1;
          return seen === occurrence ? mutant.replace : match;
        });
        fs.writeFileSync(target, mutated);
      }
      const result = spawnSync(process.execPath, [fileURLToPath(import.meta.url), '--root', root], {
        cwd: REPO_ROOT, encoding: 'utf8',
      });
      const diagnostics = result.stderr.split('\n').map((line) =>
        line.replace(/^operator-tasks gate:\s*/, '').trim()).filter(Boolean);
      if (result.status === 0 || !diagnostics.some((problem) => problem.startsWith(mutant.expect))) {
        failures.push(`${mutant.id}: wrong diagnostic — ${diagnostics.join('; ') || 'mutation passed'}`);
      }
    } finally { fs.rmSync(root, { recursive: true, force: true }); }
  }
  for (const [rel, hash] of Object.entries(before)) {
    if (sha256(path.join(REPO_ROOT, rel)) !== hash) failures.push(`${rel}: mutation test changed worktree`);
  }
  return failures;
}

function parseCli(argv) {
  const parsed = {
    root: REPO_ROOT,
    base: undefined,
    final: undefined,
    plan44Base: undefined,
    plan44Impl: undefined,
    plan44Final: undefined,
    selfTest: false,
    mutationTest: false,
  };
  const problems = [];
  const seen = new Set();
  const valued = new Set([
    '--root', '--base', '--final', '--plan44-base', '--plan44-impl', '--plan44-final',
  ]);
  const toggles = new Set(['--self-test', '--mutation-test']);
  for (let index = 0; index < argv.length; index += 1) {
    const option = argv[index];
    if (!valued.has(option) && !toggles.has(option)) {
      problems.push(`unknown option: ${option}`);
      continue;
    }
    if (seen.has(option)) {
      problems.push(`duplicate option: ${option}`);
      if (valued.has(option) && argv[index + 1] && !argv[index + 1].startsWith('--')) index += 1;
      continue;
    }
    seen.add(option);
    if (valued.has(option)) {
      const value = argv[index + 1];
      if (!value || value.startsWith('--')) {
        problems.push(`${option} needs a non-flag value`);
        continue;
      }
      index += 1;
      if (option === '--root') parsed.root = path.resolve(value);
      else if (option === '--base') parsed.base = value;
      else if (option === '--final') parsed.final = value;
      else if (option === '--plan44-base') parsed.plan44Base = value;
      else if (option === '--plan44-impl') parsed.plan44Impl = value;
      else parsed.plan44Final = value;
    } else if (option === '--self-test') parsed.selfTest = true;
    else parsed.mutationTest = true;
  }
  if (parsed.final !== undefined && parsed.base === undefined) problems.push('--final requires --base');
  const legacyRange = parsed.base !== undefined || parsed.final !== undefined;
  const plan44Range = parsed.plan44Base !== undefined
    || parsed.plan44Impl !== undefined || parsed.plan44Final !== undefined;
  if (legacyRange && plan44Range) problems.push('Plan 43 and Plan 44 range flags are mutually exclusive');
  if ((parsed.plan44Base === undefined) !== (parsed.plan44Impl === undefined)) {
    problems.push('--plan44-base and --plan44-impl are required together');
  }
  if (parsed.plan44Final !== undefined
      && (parsed.plan44Base === undefined || parsed.plan44Impl === undefined)) {
    problems.push('--plan44-final requires --plan44-base and --plan44-impl');
  }
  return { parsed, problems };
}

function main() {
  const cli = parseCli(process.argv.slice(2));
  const {
    root, base, final, plan44Base, plan44Impl, plan44Final,
    selfTest: shouldSelfTest, mutationTest: shouldMutationTest,
  } = cli.parsed;
  let problems = [...cli.problems];
  if (problems.length === 0) {
    try { problems = auditRoot(root); }
    catch (err) { problems = [`checker could not parse inputs: ${err instanceof Error ? err.message : String(err)}`]; }
    if (base !== undefined) problems.push(...auditRange(base, final, root));
    if (plan44Base !== undefined && plan44Impl !== undefined) {
      problems.push(...auditPlan44Range(plan44Base, plan44Impl, plan44Final, root));
    }
  }
  if (problems.length > 0) {
    for (const problem of problems) console.error(`operator-tasks gate: ${problem}`);
    process.exit(1);
  }
  console.log(PRODUCER_RECEIPT);
  console.log('operator-task gate OK (47 tools; 6 indexes)');
  if (shouldSelfTest) {
    const failures = selfTest();
    if (failures.length) { for (const failure of failures) console.error(`operator-tasks gate: ${failure}`); process.exit(1); }
    console.log('operator-task self-test OK');
  }
  if (shouldMutationTest) {
    const failures = mutationTest();
    if (failures.length) { for (const failure of failures) console.error(`operator-tasks gate: ${failure}`); process.exit(1); }
    const count = MUTANTS.filter((mutant) =>
      mutant.id !== 'M17-release-omission' || privateReleaseRequired(REPO_ROOT)).length;
    console.log(`operator-task mutation-test OK (${count} mutants rejected by name)`);
  }
}

if (process.argv[1]
    && fs.realpathSync(process.argv[1]) === fs.realpathSync(fileURLToPath(import.meta.url))) main();
