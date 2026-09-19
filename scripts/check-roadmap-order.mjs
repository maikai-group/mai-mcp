#!/usr/bin/env node
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import ts from 'typescript';

const PRIORITIES = ['now', 'next', 'later', 'someday'];
const WRITERS = [
  'ideaAddForProject', 'ideaAgentMove', 'ideaOperatorMove',
  'ideaOperatorUpdate', 'ideaOperatorReorder',
];
const READERS = ['ideasBoard', 'ideasBoardMarkdown', 'ideasReadMarkdown', 'primeIdeasSection'];
const FRONTEND_OWNERS = [
  'columnCards', 'priorityBandCards', 'applyPriorityChange',
  'dropTargetIndex', 'applyReorder',
];
const ROADMAP_CONSUMERS = ['onDragEnd', 'nudge', 'cyclePriority'];
const HISTORY_CONSUMERS = ['dropped'];
const EXEMPT_ORDERED_READERS = {
  shareCandidates: 'grant-picker search is intentionally relevance/recency ordered, not a roadmap rendering',
};
const SHARE_CANDIDATES_SHA256 = 'a6d12d8b07089a247a09cb89cec0ed7f7b882053c7910e709e885165d503576a';

const BACKEND_INPUTS = [
  'src/ideas.ts',
  'src/shares.ts',
  'src/__tests__/test-db-url.ts',
  'db/schema.sql',
];
const FRONTEND_INPUTS = [
  'frontend/src/views/roadmap/board.ts',
  'frontend/src/views/roadmap/Roadmap.tsx',
  'frontend/e2e/smoke.spec.ts',
  'frontend/e2e/seed.sql',
  'frontend/e2e/global-setup.ts',
  'frontend/playwright.config.ts',
  'docs/configuration.md',
  'src/__tests__/roadmap-order-gates.test.ts',
];

const FILE_MAP = new Set([
  'src/ideas.ts',
  'src/__tests__/ideas.test.ts',
  'src/__tests__/ideas-rollback.test.ts',
  'src/__tests__/web-json-api.test.ts',
  'src/__tests__/roadmap-order-gates.test.ts',
  'scripts/check-roadmap-order.mjs',
  'db/schema.sql',
  'frontend/src/views/roadmap/board.ts',
  'frontend/src/views/roadmap/board.test.ts',
  'frontend/src/views/roadmap/Roadmap.tsx',
  'frontend/src/views/roadmap/Roadmap.test.tsx',
  'frontend/src/views/roadmap/IdeaFormModal.test.tsx',
  'frontend/e2e/smoke.spec.ts',
  'frontend/e2e/seed.sql',
  'frontend/e2e/global-setup.ts',
  'frontend/playwright.config.ts',
  'docs/configuration.md',
]);

function parseArgs(argv) {
  const options = {
    root: process.cwd(),
    phase: 'complete',
    selfTest: false,
    mutationTest: false,
    base: undefined,
    schemaBase: undefined,
  };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--self-test') options.selfTest = true;
    else if (arg === '--mutation-test') options.mutationTest = true;
    else if (arg === '--root') options.root = path.resolve(argv[++index] ?? '');
    else if (arg === '--phase') options.phase = argv[++index];
    else if (arg === '--base') options.base = argv[++index];
    else if (arg === '--schema-base') options.schemaBase = argv[++index];
    else throw new Error(`unknown argument: ${arg}`);
  }
  if (options.phase !== 'backend' && options.phase !== 'complete') {
    throw new Error('--phase must be backend or complete');
  }
  return options;
}

function read(root, relativePath) {
  return fs.readFileSync(path.join(root, relativePath), 'utf8');
}

function sha256(value) {
  return crypto.createHash('sha256').update(value).digest('hex');
}

function sourceFile(relativePath, source) {
  return ts.createSourceFile(relativePath, source, ts.ScriptTarget.Latest, true,
    relativePath.endsWith('x') ? ts.ScriptKind.TSX : ts.ScriptKind.TS);
}

function functionName(node) {
  let cursor = node;
  while (cursor) {
    if (ts.isFunctionDeclaration(cursor) && cursor.name) return cursor.name.text;
    if (ts.isVariableDeclaration(cursor) && ts.isIdentifier(cursor.name) && cursor.initializer) {
      const initializer = cursor.initializer;
      if (ts.isArrowFunction(initializer) || ts.isFunctionExpression(initializer)) return cursor.name.text;
      if (ts.isCallExpression(initializer)
        && ts.isIdentifier(initializer.expression)
        && initializer.expression.text === 'useCallback'
        && initializer.arguments.some((argument) => ts.isArrowFunction(argument) || ts.isFunctionExpression(argument))) {
        return cursor.name.text;
      }
    }
    if (ts.isMethodDeclaration(cursor) && cursor.name) return cursor.name.getText();
    cursor = cursor.parent;
  }
  return '<module>';
}

function declarationTexts(relativePath, source) {
  const parsed = sourceFile(relativePath, source);
  const result = new Map();
  function visit(node) {
    if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.initializer) {
      result.set(node.name.text, node.getText(parsed));
    }
    ts.forEachChild(node, visit);
  }
  visit(parsed);
  return result;
}

function functionTexts(relativePath, source) {
  const parsed = sourceFile(relativePath, source);
  const result = new Map();
  function visit(node) {
    if (ts.isFunctionDeclaration(node) && node.name) result.set(node.name.text, node.getText(parsed));
    if ((ts.isArrowFunction(node) || ts.isFunctionExpression(node)) && ts.isVariableDeclaration(node.parent)) {
      result.set(node.parent.name.getText(parsed), node.parent.getText(parsed));
    }
    ts.forEachChild(node, visit);
  }
  visit(parsed);
  return result;
}

function expressionBindings(parsed) {
  const bindings = new Map();
  function visit(node) {
    if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.initializer) {
      bindings.set(node.name.text, node.initializer);
    }
    ts.forEachChild(node, visit);
  }
  visit(parsed);
  return bindings;
}

function resolveSqlExpression(node, bindings, seen = new Set()) {
  if (ts.isStringLiteralLike(node)) return { text: node.text, unresolved: false };
  if (ts.isParenthesizedExpression(node)) return resolveSqlExpression(node.expression, bindings, seen);
  if (ts.isIdentifier(node)) {
    if (seen.has(node.text)) return { text: '<unresolved>', unresolved: true };
    const initializer = bindings.get(node.text);
    if (!initializer) return { text: '<unresolved>', unresolved: true };
    const nextSeen = new Set(seen);
    nextSeen.add(node.text);
    return resolveSqlExpression(initializer, bindings, nextSeen);
  }
  if (ts.isTemplateExpression(node)) {
    let text = node.head.text;
    let unresolved = false;
    for (const span of node.templateSpans) {
      const expression = resolveSqlExpression(span.expression, bindings, seen);
      text += expression.text;
      text += span.literal.text;
      unresolved ||= expression.unresolved;
    }
    return { text, unresolved };
  }
  if (ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.PlusToken) {
    const left = resolveSqlExpression(node.left, bindings, seen);
    const right = resolveSqlExpression(node.right, bindings, seen);
    return { text: left.text + right.text, unresolved: left.unresolved || right.unresolved };
  }
  return { text: '<unresolved>', unresolved: true };
}

function listProductionFiles(root) {
  const roots = ['src', 'frontend/src', 'scripts'];
  const files = [];
  for (const directory of roots) {
    const absolute = path.join(root, directory);
    if (!fs.existsSync(absolute)) continue;
    const pending = [absolute];
    while (pending.length > 0) {
      const current = pending.pop();
      for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
        const item = path.join(current, entry.name);
        const relative = path.relative(root, item).split(path.sep).join('/');
        if (entry.isDirectory()) {
          if (entry.name === 'build' || entry.name === 'fixtures' || entry.name === '__tests__') continue;
          pending.push(item);
        } else if (/\.(?:ts|tsx|js|mjs)$/.test(entry.name)
          && !/\.test\.[^.]+$/.test(entry.name)
          && relative !== 'scripts/check-roadmap-order.mjs') {
          files.push(relative);
        }
      }
    }
  }
  return files.sort();
}

function sqlCensus(root, errors) {
  const hits = [];
  for (const relativePath of listProductionFiles(root)) {
    const source = read(root, relativePath);
    const parsed = sourceFile(relativePath, source);
    const bindings = expressionBindings(parsed);
    const recorded = new Set();
    const recordHit = (hit) => {
      const key = `${hit.relativePath}:${hit.owner}:${hit.mutation}:${hit.orderedRead}:${hit.wildcard}`;
      if (!recorded.has(key)) {
        recorded.add(key);
        hits.push(hit);
      }
    };
    function visit(node) {
      if (ts.isCallExpression(node)
        && ts.isPropertyAccessExpression(node.expression)
        && node.expression.name.text === 'query'
        && node.arguments[0]) {
        const sql = resolveSqlExpression(node.arguments[0], bindings);
        const mutation = /\b(?:INSERT\s+INTO|UPDATE)\s+ideas\b/i.test(sql.text);
        const orderedRead = /\bFROM\s+ideas\b/i.test(sql.text) && /\bORDER\s+BY\b/i.test(sql.text);
        const touchesIdeas = /\bideas\b/i.test(sql.text);
        const wildcard = touchesIdeas && (
          /\bSELECT\s+(?:[A-Za-z_][\w]*\.)?\*/i.test(sql.text)
          || /\bRETURNING\s+(?:[A-Za-z_][\w]*\.)?\*/i.test(sql.text)
        );
        const unresolvedMutation = /\b(?:INSERT\s+INTO|UPDATE)\s+<unresolved>/i.test(sql.text);
        const unresolvedOrderedRead = /\bFROM\s+<unresolved>[\s\S]*\bORDER\s+BY\b/i.test(sql.text);
        const unresolvedIdeasShape = sql.unresolved
          && touchesIdeas
          && !mutation
          && !orderedRead
          && (/\bSET\b/i.test(sql.text) || /\bORDER\s+BY\b/i.test(sql.text));
        if (unresolvedMutation || unresolvedOrderedRead || unresolvedIdeasShape) {
          errors.push(`unresolved SQL target/shape in ${relativePath}#${functionName(node)}`);
        } else if (mutation || orderedRead || wildcard) {
          recordHit({ relativePath, owner: functionName(node), mutation, orderedRead, wildcard });
        }
      }
      if (ts.isTemplateExpression(node) || ts.isNoSubstitutionTemplateLiteral(node) || ts.isStringLiteral(node)) {
        const text = node.getText(parsed);
        if (/\bideas\b/i.test(text)) {
          const mutation = /\b(?:INSERT\s+INTO|UPDATE)\s+ideas\b/i.test(text);
          const orderedRead = /\bFROM\s+ideas\b/i.test(text) && /\bORDER\s+BY\b/i.test(text);
          const wildcard = /\bSELECT\s+(?:[A-Za-z_][\w]*\.)?\*/i.test(text)
            || /\bRETURNING\s+(?:[A-Za-z_][\w]*\.)?\*/i.test(text);
          if (mutation || orderedRead || wildcard) {
            recordHit({ relativePath, owner: functionName(node), mutation, orderedRead, wildcard });
          }
        }
      }
      ts.forEachChild(node, visit);
    }
    visit(parsed);
  }
  for (const hit of hits) {
    if (hit.wildcard) errors.push(`wildcard idea-row projection in ${hit.relativePath}#${hit.owner}`);
    if (hit.mutation && !WRITERS.includes(hit.owner)) {
      errors.push(`unclassified ideas writer ${hit.relativePath}#${hit.owner}`);
    }
    if (hit.orderedRead
      && !READERS.includes(hit.owner)
      && !WRITERS.includes(hit.owner)
      && hit.owner !== 'bandEdgeRankLocked'
      && !(hit.owner in EXEMPT_ORDERED_READERS)) {
      errors.push(`unclassified ordered ideas reader ${hit.relativePath}#${hit.owner}`);
    }
  }
  return hits;
}

function auditBackend(root) {
  const errors = [];
  for (const relativePath of BACKEND_INPUTS) {
    if (!fs.existsSync(path.join(root, relativePath))) errors.push(`missing backend input: ${relativePath}`);
  }
  if (errors.length > 0) return { errors, census: [] };
  const ideas = read(root, 'src/ideas.ts');
  const shares = read(root, 'src/shares.ts');
  const schema = read(root, 'db/schema.sql');
  const functions = functionTexts('src/ideas.ts', ideas);
  const expectedRank = `export const IDEA_PRIORITY_RANK = {\n  now: 0,\n  next: 1,\n  later: 2,\n  someday: 3,\n} as const satisfies Record<IdeaPriority, number>;`;
  if (!ideas.includes(expectedRank)) errors.push('IDEA_PRIORITY_RANK is missing or malformed');
  for (const priority of PRIORITIES) {
    const rank = PRIORITIES.indexOf(priority);
    if (!ideas.includes(`WHEN '${priority}' THEN ${rank}`)) errors.push(`SQL priority rank is wrong for ${priority}`);
  }
  const expectedColumns = `'id', 'project_id', 'title', 'detail', 'status', 'priority',\n  'sort_order', 'source', 'evidence', 'created_at', 'updated_at'`;
  if (!ideas.includes(expectedColumns)) errors.push('IDEA_ROW_COLUMNS does not exactly cover IdeaDbRow');
  if (/\b(?:SELECT|RETURNING)\s+(?:[A-Za-z_][\w]*\.)?\*/.test(ideas)) {
    errors.push('src/ideas.ts contains a wildcard idea-row projection');
  }
  const board = functions.get('ideasBoard') ?? '';
  if (!board.includes('ORDER BY status, ${IDEA_PRIORITY_SQL}')) errors.push('ideasBoard lacks explicit priority ordering');
  if (!board.includes('CASE WHEN project_id IS NULL THEN 1 ELSE 0 END')) errors.push('ideasBoard lacks selected-project-before-global ordering');
  const prime = functions.get('primeIdeasSection') ?? '';
  if (!prime.includes("CASE status WHEN 'building' THEN 0 WHEN 'planned' THEN 1 ELSE 2 END")) errors.push('primeIdeasSection does not keep building before planned');
  if (!prime.includes('${IDEA_PRIORITY_SQL}')) errors.push('primeIdeasSection lacks explicit priority ordering');
  if (!prime.includes('CASE WHEN project_id IS NULL THEN 1 ELSE 0 END')) errors.push('primeIdeasSection lacks scope ordering');
  const markdown = functions.get('ideasBoardMarkdown') ?? '';
  if (!markdown.includes('ideasBoard({ scope, includeClosed, projectIdOverride })')) errors.push('ideasBoardMarkdown does not delegate to ideasBoard');
  const exactRead = functions.get('ideasReadMarkdown') ?? '';
  if (!exactRead.includes('(project_id = $2 OR project_id IS NULL)')) {
    errors.push('ideasReadMarkdown lacks the selected-project/global visibility wall');
  }
  if (!exactRead.includes('ORDER BY id LIMIT 2')) {
    errors.push('ideasReadMarkdown does not bound exact-card ambiguity detection');
  }
  if (!exactRead.includes('result.rows.length > 1')) {
    errors.push('ideasReadMarkdown does not reject ambiguous short references');
  }

  const lockBands = functions.get('lockIdeaBands') ?? '';
  if (!lockBands.includes('.sort((a, b) => a.localeCompare(b))')) errors.push('band locks are not sorted canonically');
  if (lockBands.includes('.sort((a, b) => b.localeCompare(a))')) errors.push('band locks use reversed ordering');
  if (!lockBands.includes('pg_advisory_xact_lock(hashtextextended($1, 0))')) errors.push('band advisory lock is missing');
  const edge = functions.get('bandEdgeRankLocked') ?? '';
  for (const predicate of [
    'project_id IS NOT DISTINCT FROM $1::uuid',
    'status = $2::text',
    'priority = $3::text',
    'ORDER BY id FOR UPDATE',
  ]) if (!edge.includes(predicate)) errors.push(`bandEdgeRankLocked missing ${predicate}`);
  if (!edge.includes('Math.min(...ranks) - 1000') || !edge.includes('Math.max(...ranks) + 1000')) {
    errors.push('band edge allocation is not spaced prepend/append');
  }

  for (const writer of WRITERS) {
    const body = functions.get(writer) ?? '';
    if (!body) {
      errors.push(`missing writer ${writer}`);
      continue;
    }
    if (!body.includes('lockIdeaBands')) errors.push(`${writer} does not acquire band locks`);
    if (!body.includes('priority')) errors.push(`${writer} does not carry priority semantics`);
  }
  const add = functions.get('ideaAddForProject') ?? '';
  if (!add.includes("const band: IdeaBand = { projectId, status: 'idea', priority };")) errors.push('ideaAddForProject lost the requested priority band');
  if (!add.includes("bandEdgeRankLocked(client, band, 'append')")) errors.push('ideaAddForProject is not append-allocated');
  for (const writer of ['ideaAgentMove', 'ideaOperatorMove', 'ideaOperatorUpdate', 'ideaOperatorReorder']) {
    const body = functions.get(writer) ?? '';
    if (!body.includes('sameBandIdentity(candidateRow, lockedRow)')) errors.push(`${writer} lacks locked identity revalidation`);
    if (!body.includes('FOR UPDATE')) errors.push(`${writer} lacks a locked re-read`);
  }
  const agentMove = functions.get('ideaAgentMove') ?? '';
  if (!agentMove.includes("bandEdgeRankLocked(client, targetBand, 'prepend', lockedRow.id)")) errors.push('ideaAgentMove is not target-band prepend allocated');
  const operatorMove = functions.get('ideaOperatorMove') ?? '';
  if (!operatorMove.includes('args.sortOrder ??') || !operatorMove.includes("bandEdgeRankLocked(client, targetBand, 'prepend', lockedRow.id)")) errors.push('ideaOperatorMove placement table drifted');
  const operatorUpdate = functions.get('ideaOperatorUpdate') ?? '';
  if (!operatorUpdate.includes("bandEdgeRankLocked(client, targetBand, 'prepend', lockedRow.id)")) errors.push('ideaOperatorUpdate does not prepend on band change');
  const reorder = functions.get('ideaOperatorReorder') ?? '';
  for (const predicate of [
    'project_id IS NOT DISTINCT FROM $1::uuid',
    'status = $2::text',
    'priority = $3::text',
    'ORDER BY id FOR UPDATE',
    'target project priority band',
  ]) if (!reorder.includes(predicate)) errors.push(`ideaOperatorReorder missing ${predicate}`);
  if (!reorder.includes('actualIds.add(lockedRow.id)')) errors.push('ideaOperatorReorder does not validate target-band union moving card');

  const wantedComment = 'sort_order DOUBLE PRECISION NOT NULL DEFAULT 0,  -- rank inside exact project/status/priority band; spaced and transactionally renumbered';
  if (!schema.includes(wantedComment)) errors.push('ideas.sort_order schema comment is not the reviewed exact-band wording');
  const shareFunctions = functionTexts('src/shares.ts', shares);
  const shareCandidates = shareFunctions.get('shareCandidates') ?? '';
  if (sha256(shareCandidates) !== SHARE_CANDIDATES_SHA256) {
    errors.push(`shareCandidates exemption fingerprint changed: ${EXEMPT_ORDERED_READERS.shareCandidates}`);
  }
  const census = sqlCensus(root, errors);
  const mutationOwners = new Set(census.filter((hit) => hit.mutation).map((hit) => hit.owner));
  for (const writer of WRITERS) if (!mutationOwners.has(writer)) errors.push(`writer census missing ${writer}`);
  return { errors, census };
}

function frontendCensus(root, errors) {
  const hits = [];
  const files = listProductionFiles(root)
    .filter((relativePath) => relativePath.startsWith('frontend/src/'));
  for (const relativePath of files) {
    const source = read(root, relativePath);
    const parsed = sourceFile(relativePath, source);
    function record(node, shape, explicitOwner) {
      const owner = explicitOwner ?? functionName(node);
      hits.push({ relativePath, owner, shape });
      const approved = (relativePath === 'frontend/src/views/roadmap/board.ts'
          && FRONTEND_OWNERS.includes(owner))
        || (relativePath === 'frontend/src/views/roadmap/Roadmap.tsx'
          && (ROADMAP_CONSUMERS.includes(owner) || HISTORY_CONSUMERS.includes(owner)));
      if (!approved) {
        errors.push(`unclassified frontend ordering ${shape} in ${relativePath}#${owner}`);
      }
    }
    function isSortOrderAccess(node) {
      return (ts.isPropertyAccessExpression(node) && node.name.text === 'sort_order')
        || (ts.isElementAccessExpression(node)
          && node.argumentExpression !== undefined
          && ts.isStringLiteralLike(node.argumentExpression)
          && node.argumentExpression.text === 'sort_order');
    }
    function containsSortOrderAccess(node) {
      let found = false;
      function inspect(candidate) {
        if (isSortOrderAccess(candidate)) found = true;
        if (!found) ts.forEachChild(candidate, inspect);
      }
      inspect(node);
      return found;
    }
    function visit(node) {
      if (ts.isCallExpression(node)
        && ts.isPropertyAccessExpression(node.expression)
        && node.expression.name.text === 'sort') {
        const receiver = node.expression.expression.getText(parsed);
        const text = node.getText(parsed);
        if (/cards?|ideas?|roadmap/i.test(receiver) || /sort_order|PRIORITY_RANK|priority/i.test(text)) {
          record(node, 'sorter');
        }
      }
      if (ts.isCallExpression(node)
        && ts.isIdentifier(node.expression)
        && node.expression.text === 'priorityBandCards') {
        record(node, 'band selection');
      }
      if (ts.isPropertyAssignment(node)
        && node.name.getText(parsed) === 'sort_order') {
        record(node, 'rank mutator');
      }
      if (ts.isBinaryExpression(node)
        && node.operatorToken.kind >= ts.SyntaxKind.FirstAssignment
        && node.operatorToken.kind <= ts.SyntaxKind.LastAssignment
        && containsSortOrderAccess(node.left)) {
        record(node, 'rank assignment');
      }
      if ((ts.isPrefixUnaryExpression(node) || ts.isPostfixUnaryExpression(node))
        && (node.operator === ts.SyntaxKind.PlusPlusToken || node.operator === ts.SyntaxKind.MinusMinusToken)
        && containsSortOrderAccess(node.operand)) {
        record(node, 'rank update');
      }
      if (ts.isDeleteExpression(node) && containsSortOrderAccess(node.expression)) {
        record(node, 'rank deletion');
      }
      if (ts.isVariableDeclaration(node)
        && ts.isIdentifier(node.name)
        && (node.name.text === 'expectedIds' || node.name.text === 'orderedIds')) {
        record(node, 'snapshot builder');
      }
      if (ts.isCallExpression(node)
        && ts.isIdentifier(node.expression)
        && node.expression.text === 'setCards') {
        const owner = functionName(node);
        const text = node.getText(parsed);
        if (text.includes('applyPriorityChange')
          || text.includes('applyReorder')
          || owner === 'onDragEnd'
          || owner === 'nudge') {
          record(node, 'ordering state update');
        }
      }
      if (ts.isVariableDeclaration(node)
        && ts.isIdentifier(node.name)
        && node.name.text === 'dropped') {
        record(node, 'dropped history binding', 'dropped');
      }
      ts.forEachChild(node, visit);
    }
    visit(parsed);
  }
  return hits;
}

function auditFrontend(root) {
  const errors = [];
  for (const relativePath of FRONTEND_INPUTS) {
    if (!fs.existsSync(path.join(root, relativePath))) errors.push(`missing frontend input: ${relativePath}`);
  }
  if (errors.length > 0) return { errors, census: [] };

  const boardSource = read(root, 'frontend/src/views/roadmap/board.ts');
  const roadmapSource = read(root, 'frontend/src/views/roadmap/Roadmap.tsx');
  const smokeSource = read(root, 'frontend/e2e/smoke.spec.ts');
  const seedSource = read(root, 'frontend/e2e/seed.sql');
  const setupSource = read(root, 'frontend/e2e/global-setup.ts');
  const configSource = read(root, 'frontend/playwright.config.ts');
  const docsSource = read(root, 'docs/configuration.md');
  const gateSource = read(root, 'src/__tests__/roadmap-order-gates.test.ts');
  const boardFunctions = functionTexts('frontend/src/views/roadmap/board.ts', boardSource);
  const roadmapDeclarations = declarationTexts('frontend/src/views/roadmap/Roadmap.tsx', roadmapSource);
  const expectedRank = `export const PRIORITY_RANK = {\n  now: 0,\n  next: 1,\n  later: 2,\n  someday: 3,\n} as const satisfies Record<IdeaPriority, number>;`;
  if (!boardSource.includes(expectedRank)) errors.push('frontend PRIORITY_RANK is missing or malformed');

  const column = boardFunctions.get('columnCards') ?? '';
  if (!column.includes('PRIORITY_RANK[a.priority] - PRIORITY_RANK[b.priority]')) {
    errors.push('columnCards lacks the canonical priority comparator');
  }
  if (!column.includes('Number(a.project_id === null) - Number(b.project_id === null)')) {
    errors.push('columnCards lacks selected-project-before-global ordering');
  }
  if (!column.includes('compareBandCards(a, b)')) errors.push('columnCards lacks band rank/creation/id ordering');

  const priorityBand = boardFunctions.get('priorityBandCards') ?? '';
  for (const predicate of [
    'card.status === status',
    'card.priority === priority',
    'card.project_id === projectId',
    '.sort(compareBandCards)',
  ]) if (!priorityBand.includes(predicate)) errors.push(`priorityBandCards missing ${predicate}`);

  const priorityChange = boardFunctions.get('applyPriorityChange') ?? '';
  for (const predicate of [
    'if (!moved || moved.priority === priority) return cards',
    'priorityBandCards(cards, moved.status, priority, moved.project_id)',
    'Math.min(...target.map((card) => card.sort_order)) - 1000',
    '? 1000',
  ]) if (!priorityChange.includes(predicate)) errors.push(`applyPriorityChange missing ${predicate}`);

  const dropTarget = boardFunctions.get('dropTargetIndex') ?? '';
  for (const predicate of [
    'over.priority === moved.priority',
    'over.project_id === moved.project_id',
    'return target === moved.status ? -1 : 0',
    'priorityBandCards(cards, target, moved.priority, moved.project_id)',
  ]) if (!dropTarget.includes(predicate)) errors.push(`dropTargetIndex missing ${predicate}`);

  const reorder = boardFunctions.get('applyReorder') ?? '';
  for (const predicate of [
    'if (index < 0) return cards',
    'priorityBandCards(cards, status, moved.priority, moved.project_id)',
    "status: card.id === id ? status : card.status",
    '(position + 1) * 1000',
  ]) if (!reorder.includes(predicate)) errors.push(`applyReorder missing ${predicate}`);

  for (const consumer of ['onDragEnd', 'nudge']) {
    const body = roadmapDeclarations.get(consumer) ?? '';
    const bandCalls = body.match(/priorityBandCards\(/g)?.length ?? 0;
    if (bandCalls !== 2) errors.push(`${consumer} must build both snapshots through priorityBandCards`);
    if (!body.includes('applyReorder(')) errors.push(`${consumer} does not delegate to applyReorder`);
  }
  const onDragEnd = roadmapDeclarations.get('onDragEnd') ?? '';
  if (!onDragEnd.includes('if (next === cards) return')) errors.push('onDragEnd does not suppress no-op posts');
  const cyclePriority = roadmapDeclarations.get('cyclePriority') ?? '';
  if (!cyclePriority.includes('applyPriorityChange(current, card.id, priority)')) {
    errors.push('cyclePriority does not use applyPriorityChange');
  }
  const dropped = roadmapDeclarations.get('dropped') ?? '';
  if (!dropped.includes("columnCards(visibleCards, 'dropped')")) {
    errors.push('dropped history does not use the canonical columnCards binding');
  }

  if (!setupSource.includes("import { requireDisposableTestDbUrl } from '../../src/__tests__/test-db-url.js';")
    || !setupSource.includes('const dbUrl = requireDisposableTestDbUrl();')
    || !setupSource.includes("execFileSync('psql', [dbUrl")
    || !setupSource.includes('const once = runAndRead();')
    || !setupSource.includes('const twice = runAndRead();')
    || !setupSource.includes('twice !== once')) {
    errors.push('Playwright global setup does not validate and use MAI_TEST_DB_URL before psql');
  }
  if (!configSource.includes("import { requireDisposableTestDbUrl } from '../src/__tests__/test-db-url.js';")
    || !configSource.includes('const dbUrl = requireDisposableTestDbUrl();')
    || !configSource.includes('MAI_DB_URL: dbUrl')) {
    errors.push('Playwright config does not validate the disposable URL before webServer startup');
  }
  if (setupSource.includes('/mai_brain') || configSource.includes('/mai_brain')) {
    errors.push('Playwright setup/config retains a normal mai_brain fallback');
  }
  for (const seedContract of [
    "('E2E P42 project now alpha',    'now'",
    "('E2E P42 project next alpha',   'next'",
    "('E2E P42 project later alpha',  'later'",
    "('E2E P42 project someday alpha','someday'",
    "project_id IS NULL",
    "source = 'user'",
    "title LIKE 'E2E P42 %'",
    "'E2E P42 global now overlap'",
  ]) if (!seedSource.includes(seedContract)) errors.push(`Plan 42 E2E seed missing ${seedContract}`);
  for (const smokeContract of [
    'roadmap priority bands, priority changes, and manual order survive reloads',
    "const p42Prefix = 'E2E P42 '",
    "movingCard.getByTestId('priority-chip').click()",
    "'/api/ideas/reorder'",
    'outsideMovedBand',
    'await page.reload()',
  ]) if (!smokeSource.includes(smokeContract)) errors.push(`Plan 42 reload smoke missing ${smokeContract}`);
  for (const docsContract of [
    'Every Roadmap column is grouped',
    'Now, Next, Later, Someday',
    'Clicking a priority moves that card to the top of its',
    'drag order is manual within a band and persists in PostgreSQL',
  ]) if (!docsSource.includes(docsContract)) errors.push(`Roadmap documentation missing ${docsContract}`);
  for (const gateContract of [
    'fails before Playwright starts a server or setup connects without a disposable URL',
    'delete environment.MAI_TEST_DB_URL',
    "'test', '--list', '--config', 'playwright.config.ts'",
    'MAI_TEST_DB_URL is required — use scripts/run-with-disposable-db.sh',
  ]) if (!gateSource.includes(gateContract)) errors.push(`Playwright disposable-DB negative gate missing ${gateContract}`);

  const census = frontendCensus(root, errors);
  const owners = new Set(census.map((hit) => hit.owner));
  for (const owner of FRONTEND_OWNERS) if (!owners.has(owner)) errors.push(`frontend census missing owner ${owner}`);
  for (const owner of ROADMAP_CONSUMERS) if (!owners.has(owner)) errors.push(`frontend census missing consumer ${owner}`);
  for (const owner of HISTORY_CONSUMERS) if (!owners.has(owner)) errors.push(`frontend census missing history consumer ${owner}`);
  return { errors, census };
}

function audit(root, phase) {
  const backend = auditBackend(root);
  const errors = [...backend.errors];
  let frontendCensusResult = [];
  if (phase === 'complete') {
    const frontend = auditFrontend(root);
    errors.push(...frontend.errors);
    frontendCensusResult = frontend.census;
  }
  return { errors, census: backend.census, frontendCensus: frontendCensusResult };
}

function copyInputs(root, phase) {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'mai-roadmap-order-'));
  const inputs = phase === 'complete' ? [...BACKEND_INPUTS, ...FRONTEND_INPUTS] : BACKEND_INPUTS;
  for (const relativePath of inputs) {
    const target = path.join(temp, relativePath);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.copyFileSync(path.join(root, relativePath), target);
  }
  return temp;
}

function replaceOnce(root, relativePath, before, after) {
  const absolute = path.join(root, relativePath);
  const source = fs.readFileSync(absolute, 'utf8');
  if (!source.includes(before)) throw new Error(`mutation fixture missing in ${relativePath}: ${before}`);
  fs.writeFileSync(absolute, source.replace(before, after));
}

const BACKEND_MUTANTS = [
  ['removed priority', (root) => replaceOnce(root, 'src/ideas.ts', '  someday: 3,\n', '')],
  ['swapped ranks', (root) => replaceOnce(root, 'src/ideas.ts', '  now: 0,\n  next: 1,', '  now: 1,\n  next: 0,')],
  ['alphabetical board order', (root) => replaceOnce(root, 'src/ideas.ts', 'ORDER BY status, ${IDEA_PRIORITY_SQL},', 'ORDER BY status, priority,')],
  ['one idea query reverting to a wildcard projection', (root) => replaceOnce(root, 'src/ideas.ts', 'SELECT ${ideaRowProjection()} FROM ideas WHERE', 'SELECT * FROM ideas WHERE')],
  ['whole-column rank query', (root) => replaceOnce(root, 'src/ideas.ts', '       AND priority = $3::text\n       AND ($4::uuid', '       AND ($4::uuid')],
  ['one writer losing the priority argument', (root) => replaceOnce(root, 'src/ideas.ts', "const band: IdeaBand = { projectId, status: 'idea', priority };", "const band: IdeaBand = { projectId, status: 'idea', priority: 'someday' };" )],
  ['sorted source/target advisory acquisition removed', (root) => replaceOnce(root, 'src/ideas.ts', '.sort((a, b) => a.localeCompare(b))', '')],
  ['sorted advisory acquisition reversed', (root) => replaceOnce(root, 'src/ideas.ts', '.sort((a, b) => a.localeCompare(b))', '.sort((a, b) => b.localeCompare(a))')],
  ['locked identity revalidation removed', (root) => {
    const absolute = path.join(root, 'src/ideas.ts');
    const source = fs.readFileSync(absolute, 'utf8');
    const needle = '    if (!sameBandIdentity(candidateRow, lockedRow)) return IDENTITY_DRIFT;\n';
    if (!source.includes(needle)) throw new Error('locked revalidation mutation fixture missing');
    fs.writeFileSync(absolute, source.split(needle).join(''));
  }],
  ['reorder losing its priority predicate', (root) => replaceOnce(root, 'src/ideas.ts', '         AND priority = $3::text\n       ORDER BY id FOR UPDATE', '       ORDER BY id FOR UPDATE')],
  ['reorder losing its exact-project predicate', (root) => replaceOnce(root, 'src/ideas.ts', '       WHERE project_id IS NOT DISTINCT FROM $1::uuid\n         AND status = $2::text', '       WHERE status = $2::text')],
  ['an executable schema/default/index change', (root) => replaceOnce(root, 'db/schema.sql', 'sort_order DOUBLE PRECISION NOT NULL DEFAULT 0,', 'sort_order DOUBLE PRECISION NOT NULL DEFAULT 1,')],
  ['an extra production file containing an unclassified ideas writer', (root) => {
    const target = path.join(root, 'src/rogue-roadmap-writer.ts');
    fs.writeFileSync(target, "export const rogue = `UPDATE ideas SET sort_order = 1`;\n");
  }],
  ['an extra production file containing an unclassified ordered reader', (root) => {
    const target = path.join(root, 'src/rogue-roadmap-reader.ts');
    fs.writeFileSync(target, "export const rogue = `SELECT id FROM ideas ORDER BY priority`;\n");
  }],
  ['exact idea reader losing its project visibility wall', (root) => replaceOnce(
    root,
    'src/ideas.ts',
    'WHERE ${idPredicate} AND (project_id = $2 OR project_id IS NULL)',
    'WHERE ${idPredicate}',
  )],
  ['exact idea reader losing its bounded ambiguity check', (root) => replaceOnce(
    root,
    'src/ideas.ts',
    'ORDER BY id LIMIT 2',
    'ORDER BY id',
  )],
];

const FRONTEND_MUTANTS = [
  ['comparator loss', (root) => replaceOnce(
    root,
    'frontend/src/views/roadmap/board.ts',
    '    PRIORITY_RANK[a.priority] - PRIORITY_RANK[b.priority]\n    || ',
    '    ',
  )],
  ['dropped history reverting to raw response filtering', (root) => replaceOnce(
    root,
    'frontend/src/views/roadmap/Roadmap.tsx',
    "const dropped = columnCards(visibleCards, 'dropped');",
    "const dropped = visibleCards.filter((card) => card.status === 'dropped');",
  )],
  ['applyReorder reverting to whole-column rank mutation', (root) => replaceOnce(
    root,
    'frontend/src/views/roadmap/board.ts',
    'const target = priorityBandCards(cards, status, moved.priority, moved.project_id)',
    'const target = columnCards(cards, status)',
  )],
  ['onDragEnd snapshot reverting to columnCards', (root) => replaceOnce(
    root,
    'frontend/src/views/roadmap/Roadmap.tsx',
    'const expectedIds = priorityBandCards(cards, status, active.priority, active.project_id)',
    'const expectedIds = columnCards(cards, status)',
  )],
  ['nudge snapshot reverting to columnCards', (root) => replaceOnce(
    root,
    'frontend/src/views/roadmap/Roadmap.tsx',
    'const expectedIds = priorityBandCards(cards, status, card.priority, card.project_id)',
    'const expectedIds = columnCards(cards, status)',
  )],
  ['cyclePriority reverting to the label-only map', (root) => replaceOnce(
    root,
    'frontend/src/views/roadmap/Roadmap.tsx',
    'setCards((current) => applyPriorityChange(current, card.id, priority));',
    'setCards((current) => current.map((item) => item.id === card.id ? { ...item, priority } : item));',
  )],
  ['an extra production frontend sorter/rank mutator', (root) => {
    const target = path.join(root, 'frontend/src/lib/rogue-roadmap-order.ts');
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, 'export function rogue(cards) { return cards.sort((a, b) => a.sort_order - b.sort_order); }\n');
  }],
];

function inputHashes(root, phase) {
  const inputs = phase === 'complete' ? [...BACKEND_INPUTS, ...FRONTEND_INPUTS] : BACKEND_INPUTS;
  return new Map(inputs.map((relativePath) => [relativePath, sha256(read(root, relativePath))]));
}

function assertHashesUnchanged(root, before) {
  for (const [relativePath, digest] of before) {
    if (sha256(read(root, relativePath)) !== digest) throw new Error(`live input changed during checker run: ${relativePath}`);
  }
}

function runSelfTest(root, phase) {
  const baseline = copyInputs(root, phase);
  try {
    const baselineResult = audit(baseline, phase);
    if (baselineResult.errors.length > 0) throw new Error(`self-test baseline failed: ${baselineResult.errors.join('; ')}`);
    fs.unlinkSync(path.join(baseline, 'src/ideas.ts'));
    if (audit(baseline, phase).errors.length === 0) throw new Error('self-test accepted a missing backend input');
  } finally {
    fs.rmSync(baseline, { recursive: true, force: true });
  }
  const malformed = copyInputs(root, phase);
  try {
    replaceOnce(malformed, 'src/ideas.ts', '  later: 2,', '  later: 9,');
    if (audit(malformed, phase).errors.length === 0) throw new Error('self-test accepted malformed priority rank');
  } finally {
    fs.rmSync(malformed, { recursive: true, force: true });
  }
  for (const [label, body] of [
    [
      'interpolated ideas writer',
      "const table = 'ideas';\nexport async function rogue(db) { return db.query(`UPDATE ${table} SET sort_order = 1`); }\n",
    ],
    [
      'interpolated ideas ordered reader',
      "const table = 'ideas';\nexport async function rogue(db) { return db.query(`SELECT id FROM ${table} ORDER BY priority`); }\n",
    ],
  ]) {
    const dynamic = copyInputs(root, phase);
    try {
      fs.writeFileSync(path.join(dynamic, 'src/dynamic-roadmap-sql.ts'), body);
      if (audit(dynamic, phase).errors.length === 0) throw new Error(`self-test accepted ${label}`);
    } finally {
      fs.rmSync(dynamic, { recursive: true, force: true });
    }
  }
  if (phase === 'complete') {
    for (const [label, relativePath, body] of [
      [
        'external production frontend sorter',
        'frontend/src/lib/rogue-roadmap-order.ts',
        'export function rogue(cards) { return cards.sort((a, b) => a.sort_order - b.sort_order); }\n',
      ],
      [
        'direct frontend sort_order assignment',
        'frontend/src/views/roadmap/rogue-rank.ts',
        'export function rogue(cards) { cards[0].sort_order = 1; return cards; }\n',
      ],
      [
        'compound frontend sort_order assignment',
        'frontend/src/views/roadmap/rogue-rank.ts',
        'export function rogue(card) { card.sort_order += 1; return card; }\n',
      ],
      [
        'frontend sort_order update expression',
        'frontend/src/views/roadmap/rogue-rank.ts',
        'export function rogue(card) { card.sort_order++; return card; }\n',
      ],
      [
        'frontend element-access sort_order assignment',
        'frontend/src/views/roadmap/rogue-rank.ts',
        "export function rogue(card) { card['sort_order'] = 1; return card; }\n",
      ],
      [
        'frontend destructuring sort_order assignment',
        'frontend/src/views/roadmap/rogue-rank.ts',
        'export function rogue(card, source) { ({ sort_order: card.sort_order } = source); return card; }\n',
      ],
      [
        'frontend sort_order deletion',
        'frontend/src/views/roadmap/rogue-rank.ts',
        'export function rogue(card) { delete card.sort_order; return card; }\n',
      ],
    ]) {
      const escaped = copyInputs(root, phase);
      try {
        const target = path.join(escaped, relativePath);
        fs.mkdirSync(path.dirname(target), { recursive: true });
        fs.writeFileSync(target, body);
        if (audit(escaped, phase).errors.length === 0) throw new Error(`self-test accepted ${label}`);
      } finally {
        fs.rmSync(escaped, { recursive: true, force: true });
      }
    }
  }
  const frontendReceipt = phase === 'complete' ? '; escaped frontend inputs rejected' : '';
  console.log(`PASS self-test: missing, malformed, and interpolated backend inputs rejected${frontendReceipt}`);
}

function runMutationTest(root, phase) {
  const liveBefore = inputHashes(root, phase);
  const mutants = phase === 'complete' ? [...BACKEND_MUTANTS, ...FRONTEND_MUTANTS] : BACKEND_MUTANTS;
  for (const [name, mutate] of mutants) {
    const temp = copyInputs(root, phase);
    try {
      mutate(temp);
      const result = audit(temp, phase);
      if (result.errors.length === 0) throw new Error(`mutation survived: ${name}`);
      console.log(`PASS mutant: ${name}`);
    } finally {
      fs.rmSync(temp, { recursive: true, force: true });
    }
  }
  assertHashesUnchanged(root, liveBefore);
  const inventory = phase === 'complete'
    ? `${mutants.length} complete-phase mutants rejected`
    : `${mutants.length} backend mutants rejected`;
  console.log(`PASS mutation inventory: ${inventory}; live hashes restored`);
}

function stripSqlLineComments(source) {
  return source.split('\n').map((line) => line.replace(/--.*$/, '')).join('\n');
}

function baseSchema(root, reference) {
  const absolute = path.resolve(root, reference);
  if (fs.existsSync(absolute)) {
    const file = fs.statSync(absolute).isDirectory() ? path.join(absolute, 'db/schema.sql') : absolute;
    return fs.readFileSync(file, 'utf8');
  }
  return execFileSync('git', ['show', `${reference}:db/schema.sql`], { cwd: root, encoding: 'utf8' });
}

function checkSchemaBase(root, reference) {
  const before = baseSchema(root, reference);
  const after = read(root, 'db/schema.sql');
  const oldLine = 'sort_order DOUBLE PRECISION NOT NULL DEFAULT 0,  -- fractional ranking; midpoint insertion, no renumbering';
  const newLine = 'sort_order DOUBLE PRECISION NOT NULL DEFAULT 0,  -- rank inside exact project/status/priority band; spaced and transactionally renumbered';
  if (!before.includes(oldLine) || !after.includes(newLine)) throw new Error('schema base does not contain the reviewed one-line comment replacement');
  if (stripSqlLineComments(before) !== stripSqlLineComments(after)) throw new Error('executable schema text changed');
  console.log(`PASS schema-base: only the reviewed ideas.sort_order comment changed from ${reference}`);
}

function checkBaseRange(root, reference) {
  const subjects = execFileSync('git', ['log', '--format=%s', '--reverse', `${reference}..HEAD`], { cwd: root, encoding: 'utf8' })
    .trim().split('\n').filter(Boolean);
  const taskSubjects = [
    'feat(roadmap): persist priority-band ordering',
    'feat(roadmap): keep dashboard moves inside priority bands',
    'test(roadmap): prove priority order survives reload',
  ];
  let cursor = 0;
  for (const subject of subjects) {
    if (subject === taskSubjects[cursor]) cursor += 1;
    else if (!/^(?:fix|test|refactor)\(roadmap\): address Plan 42 code review/.test(subject)) {
      throw new Error(`unlabelled commit in Plan 42 range: ${subject}`);
    }
  }
  if (cursor !== taskSubjects.length) throw new Error('Plan 42 range does not contain the three ordered task commits');
  const changed = execFileSync('git', ['diff', '--name-only', `${reference}..HEAD`], { cwd: root, encoding: 'utf8' })
    .trim().split('\n').filter(Boolean);
  for (const relativePath of changed) if (!FILE_MAP.has(relativePath)) throw new Error(`path outside Plan 42 File Map: ${relativePath}`);
  for (const unchanged of ['src/shares.ts', 'src/__tests__/test-db-url.ts']) {
    if (changed.includes(unchanged)) throw new Error(`verify-unchanged path changed: ${unchanged}`);
  }
  checkSchemaBase(root, reference);
  console.log(`PASS base range: ${subjects.length} labelled commits; ${changed.length} owned paths`);
}

function main() {
  const options = parseArgs(process.argv.slice(2));
  const result = audit(options.root, options.phase);
  if (result.errors.length > 0) {
    for (const error of result.errors) console.error(`ERROR ${error}`);
    process.exitCode = 1;
    return;
  }
  const mutationOwners = new Set(result.census.filter((hit) => hit.mutation).map((hit) => hit.owner));
  const orderedOwners = new Set(result.census.filter((hit) => hit.orderedRead).map((hit) => hit.owner));
  const frontendOwners = new Set(result.frontendCensus.map((hit) => hit.owner));
  const frontendSummary = options.phase === 'complete'
    ? `; ${READERS.length} backend readers/delegates; 1 fingerprinted share exemption; ${FRONTEND_OWNERS.filter((owner) => frontendOwners.has(owner)).length} frontend owners; ${ROADMAP_CONSUMERS.filter((owner) => frontendOwners.has(owner)).length} Roadmap consumers; ${HISTORY_CONSUMERS.filter((owner) => frontendOwners.has(owner)).length} history consumer`
    : '';
  console.log(`PASS roadmap-order ${options.phase}: ${mutationOwners.size} writer owners; ${orderedOwners.size} ordered-reader/helper owners${frontendSummary}; 0 wildcards/unclassified SQL shapes`);
  if (options.selfTest) runSelfTest(options.root, options.phase);
  if (options.mutationTest) runMutationTest(options.root, options.phase);
  if (options.schemaBase) checkSchemaBase(options.root, options.schemaBase);
  if (options.base) checkBaseRange(options.root, options.base);
}

main();
