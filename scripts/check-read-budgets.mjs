#!/usr/bin/env node
// Plan 23 R7 static gate: the WHOLE registered tool surface is classified, the
// narrowing map covers exactly the reads, and there is exactly ONE post-nudge
// finalizer at the real tools/call boundary. A future tool cannot silently
// escape classification, and the nudge/cap order cannot silently invert.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import ts from 'typescript';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const fail = (msg) => { console.error(`read-budget gate: ${msg}`); process.exit(1); };
const src = (rel) => {
  const file = path.join(root, rel);
  if (!fs.existsSync(file)) fail(`missing ${rel}`);
  return ts.createSourceFile(rel, fs.readFileSync(file, 'utf8'), ts.ScriptTarget.ES2022, true);
};
const textOf = (node) => node.getText();
const sorted = (a) => [...a].sort();
const sameSet = (a, b) => JSON.stringify(sorted(a)) === JSON.stringify(sorted(b));

// ---------- 1 + 2: partition and narrowing map from the BUILT surface ----------
// file:// URLs: Node's ESM loader rejects a bare absolute path on Windows (drive
// letter reads as a URL scheme).
const [toolDefs, coord, budget] = await Promise.all([
  import(pathToFileURL(path.join(root, 'build/tool-defs.js')).href),
  import(pathToFileURL(path.join(root, 'build/coordination/index.js')).href),
  import(pathToFileURL(path.join(root, 'build/read-budget.js')).href),
]);
const registered = [...toolDefs.TOOLS, ...coord.coordination.toolDefs].map((t) => t.name);
const classified = [...budget.MCP_READ_TOOLS, ...budget.MCP_NON_READ_TOOLS];
if (registered.length !== classified.length) {
  fail(`registered ${registered.length} tools but classified ${classified.length}`);
}
if (!sameSet(registered, classified)) {
  const missing = registered.filter((n) => !classified.includes(n));
  const extra = classified.filter((n) => !registered.includes(n));
  fail(`partition != registered surface; unclassified=[${missing}] unregistered=[${extra}]`);
}
if (new Set(classified).size !== classified.length) fail('duplicate name across the partition');
if (!sameSet(Object.keys(budget.MCP_READ_NARROWING), budget.MCP_READ_TOOLS)) {
  const missing = budget.MCP_READ_TOOLS.filter((n) => !(n in budget.MCP_READ_NARROWING));
  const extra = Object.keys(budget.MCP_READ_NARROWING).filter((n) => !budget.MCP_READ_TOOLS.includes(n));
  fail(`narrowing keys != read tools; missing=[${missing}] extra=[${extra}]`);
}

// ---------- 3: exactly one injected-seam, post-nudge finalizer ----------
const index = src('src/index.ts');
let buildServerFn = null;
const visit = (node, fn) => { fn(node); ts.forEachChild(node, (c) => visit(c, fn)); };
visit(index, (n) => {
  if (ts.isFunctionDeclaration(n) && n.name?.text === 'buildServer') buildServerFn = n;
});
if (!buildServerFn) fail('buildServer function declaration not found in src/index.ts');
if (buildServerFn.parameters.length !== 1) {
  fail(`buildServer must take exactly one injected piggyback parameter, found ${buildServerFn.parameters.length}`);
}
const param = buildServerFn.parameters[0];
if (param.name.getText() !== 'piggyback') fail('buildServer parameter must be named piggyback');
if (!/typeof\s+coordination\.piggybackNudge/.test(textOf(param.type ?? param))) {
  fail('piggyback parameter must be typed from coordination.piggybackNudge');
}
if (!param.initializer || !/coordination\.piggybackNudge/.test(textOf(param.initializer))) {
  fail('piggyback parameter must default to coordination.piggybackNudge');
}

// The tools/call handler body.
let callHandler = null;
visit(buildServerFn, (n) => {
  if (ts.isCallExpression(n)
    && /setRequestHandler$/.test(n.expression.getText())
    && n.arguments.length >= 2
    && /['"]tools\/call['"]/.test(n.arguments[0].getText())) {
    callHandler = n.arguments[1];
  }
});
if (!callHandler) fail('tools/call handler not found in buildServer');
const handlerText = textOf(callHandler);

// It must await the injected PARAMETER, never the coordination property.
if (!/await\s+piggyback\(/.test(handlerText)) {
  fail('tools/call must await the injected piggyback parameter');
}
if (/coordination\.piggybackNudge/.test(handlerText)) {
  fail('tools/call must not reach coordination.piggybackNudge directly — use the injected parameter');
}
// Exactly one finalizer call, and it is the returned expression.
const finalizerCalls = [];
let nudgeAssignEnd = -1;
visit(callHandler, (n) => {
  if (ts.isCallExpression(n) && n.expression.getText() === 'finalizeToolResult') finalizerCalls.push(n);
  if (ts.isBinaryExpression(n)
    && n.operatorToken.kind === ts.SyntaxKind.EqualsToken
    && n.left.getText() === 'nudge'
    && /await\s+piggyback\(/.test(n.right.getText())) {
    nudgeAssignEnd = n.getEnd();
  }
});
if (finalizerCalls.length !== 1) {
  fail(`tools/call must contain exactly one finalizeToolResult call, found ${finalizerCalls.length}`);
}
const finalizer = finalizerCalls[0];
const args = finalizer.arguments.map((a) => a.getText());
if (args.join(',').replace(/\s+/g, '') !== 'request.params.name,result,nudge') {
  fail(`finalizeToolResult must be called as (request.params.name, result, nudge), got (${args.join(', ')})`);
}
if (!ts.isReturnStatement(finalizer.parent)) fail('the finalizeToolResult call must be the returned expression');
if (nudgeAssignEnd < 0) fail('tools/call must assign nudge from the awaited injected parameter');
if (finalizer.getStart() < nudgeAssignEnd) {
  fail('finalizeToolResult must run AFTER the nudge assignment (post-nudge order)');
}

// ---------- 4: neither dispatch facade caps ----------
for (const rel of ['src/index.ts', 'src/coordination/index.ts']) {
  const file = src(rel);
  let dispatchText = file.getFullText();
  if (rel === 'src/index.ts') {
    // buildServer legitimately owns the one finalizer; the DISPATCH must not.
    dispatchText = dispatchText.slice(buildServerFn.getEnd());
  }
  if (/finalizeToolResult\s*\(/.test(dispatchText)) fail(`${rel} dispatch must not call finalizeToolResult`);
  if (/budgetToolText/.test(dispatchText)) fail(`${rel} references the removed budgetToolText`);
}

// ---------- 5: the eleven long-body calls receive mcpBudget() ----------
const indexText = index.getFullText();
const coordText = src('src/coordination/index.ts').getFullText();
const EXPECTED_BUDGETED = [
  ['src/index.ts', /planText\(\s*params\s*,\s*mcpBudget\(\)\s*\)/, 'planText'],
  ['src/index.ts', /findingsQuery\(\{[\s\S]*?budget:\s*mcpBudget\(\)[\s\S]*?\}\)/, 'findingsQuery'],
  ['src/index.ts', /unifiedSearch\(\{[\s\S]*?budget:\s*mcpBudget\(\)[\s\S]*?\}\)/, 'unifiedSearch'],
  ['src/index.ts', /projectRecall\([^)]*mcpBudget\(\)\s*\)/, 'projectRecall'],
  ['src/index.ts', /dailyReport\([^)]*mcpBudget\(\)\s*\)/, 'dailyReport'],
  ['src/index.ts', /getContext\([^)]*mcpBudget\(\)\s*\)/, 'getContext'],
  ['src/index.ts', /violationsRecent\(\{[\s\S]*?budget:\s*mcpBudget\(\)[\s\S]*?\}\)/, 'violationsRecent'],
  ['src/coordination/index.ts', /boardRead\(\{[\s\S]*?budget:\s*mcpBudget\(\)[\s\S]*?\}\)/, 'boardRead'],
  ['src/index.ts', /sharedQuery\(\{[\s\S]*?\},\s*mcpBudget\(\)\s*\)/, 'sharedQuery'],
  ['src/index.ts', /operatorTasksText\(\s*rawArguments\s*,\s*mcpBudget\(\)\s*\)/, 'operatorTasksText'],
  ['src/index.ts', /ideasReadMarkdown\(\{[\s\S]*?budget:\s*mcpBudget\(\)[\s\S]*?\}\)/, 'ideasReadMarkdown'],
];
for (const [rel, re, name] of EXPECTED_BUDGETED) {
  const text = rel === 'src/index.ts' ? indexText : coordText;
  if (!re.test(text)) fail(`${name} in ${rel} must receive mcpBudget()`);
}

// Plan 43: the tenth owner is pinned to the real tools/call handler, not mere
// token presence elsewhere in index.ts. This pure predicate is mutation-tested
// below so a dead/fake owner cannot satisfy the census.
function operatorTaskBudgetOwnerViolation(sourceText) {
  const file = ts.createSourceFile('index.ts', sourceText, ts.ScriptTarget.ES2022, true);
  let dispatch = null;
  visit(file, (n) => {
    if (ts.isVariableDeclaration(n)
      && n.name.getText() === 'handleToolCall'
      && n.initializer
      && (ts.isArrowFunction(n.initializer) || ts.isFunctionExpression(n.initializer))) {
      dispatch = n.initializer;
    }
  });
  if (!dispatch) return 'operatorTasksText owner: handleToolCall dispatch missing';
  const exact = /operatorTasksText\(\s*rawArguments\s*,\s*mcpBudget\(\)\s*\)/g;
  const wholeCount = sourceText.match(exact)?.length ?? 0;
  const dispatchCount = dispatch.getText(file).match(exact)?.length ?? 0;
  if (dispatchCount !== 1 || wholeCount !== 1) {
    return `operatorTasksText must have one real tools/call budget owner; dispatch=${dispatchCount} whole=${wholeCount}`;
  }
  return null;
}

const operatorTaskOwnerViolation = operatorTaskBudgetOwnerViolation(indexText);
if (operatorTaskOwnerViolation) fail(operatorTaskOwnerViolation);

function ideaBudgetOwnerViolation(sourceText) {
  const file = ts.createSourceFile('index.ts', sourceText, ts.ScriptTarget.ES2022, true);
  let dispatch = null;
  const allCalls = [];
  visit(file, (n) => {
    if (ts.isVariableDeclaration(n)
      && n.name.getText() === 'handleToolCall'
      && n.initializer
      && (ts.isArrowFunction(n.initializer) || ts.isFunctionExpression(n.initializer))) {
      dispatch = n.initializer;
    }
    if (ts.isCallExpression(n) && n.expression.getText() === 'ideasReadMarkdown') allCalls.push(n);
  });
  if (!dispatch) return 'ideasReadMarkdown owner: handleToolCall dispatch missing';
  const dispatchCalls = [];
  visit(dispatch, (n) => {
    if (ts.isCallExpression(n) && n.expression.getText(file) === 'ideasReadMarkdown') dispatchCalls.push(n);
  });
  if (allCalls.length !== 1 || dispatchCalls.length !== 1) {
    return `ideasReadMarkdown must have one real tools/call owner; dispatch=${dispatchCalls.length} whole=${allCalls.length}`;
  }
  const argument = dispatchCalls[0].arguments[0];
  if (!argument || !ts.isObjectLiteralExpression(argument)) {
    return 'ideasReadMarkdown must receive one object argument in the tools/call dispatch';
  }
  const budgetProperty = argument.properties.find((property) =>
    ts.isPropertyAssignment(property) && property.name.getText(file) === 'budget');
  if (!budgetProperty || !ts.isPropertyAssignment(budgetProperty)
    || budgetProperty.initializer.getText(file).replace(/\s+/g, '') !== 'mcpBudget()') {
    return 'ideasReadMarkdown in the tools/call dispatch must receive budget: mcpBudget()';
  }
  return null;
}

const ideaOwnerViolation = ideaBudgetOwnerViolation(indexText);
if (ideaOwnerViolation) fail(ideaOwnerViolation);

// ---------- 6: selectors page, and the finalizer discriminates before capping ----------
const plans = src('src/plans.ts').getFullText();
for (const kind of ['synthesis', 'finding']) {
  const re = new RegExp(`budgetPage\\(\\s*\\n?\\s*pageBudget\\(\\)[\\s\\S]*?'${kind}'`);
  if (!re.test(plans)) fail(`the selected ${kind} page must use pageBudget()`);
}
const shares = src('src/shares.ts').getFullText();
{
  const re = new RegExp(`budgetPage\\(\\s*\\n?\\s*pageBudget\\(\\)[\\s\\S]*?'share'`);
  if (!re.test(shares)) fail(`the selected share page must use pageBudget()`);
}
const ideas = src('src/ideas.ts').getFullText();
function ideaAtomicPagingViolation(ideasText, budgetText) {
  const ideasFile = ts.createSourceFile('ideas.ts', ideasText, ts.ScriptTarget.ES2022, true);
  let reader = null;
  visit(ideasFile, (node) => {
    if (ts.isFunctionDeclaration(node) && node.name?.text === 'ideasReadMarkdown') reader = node;
  });
  if (!reader) return 'ideasReadMarkdown producer is missing';
  const pageCalls = [];
  visit(reader, (node) => {
    if (ts.isCallExpression(node) && node.expression.getText(ideasFile) === 'budgetPage') pageCalls.push(node);
  });
  const pageCall = pageCalls[0];
  if (pageCalls.length !== 1
    || pageCall.arguments[0]?.getText(ideasFile).replace(/\s+/g, '') !== 'pageBudget()'
    || pageCall.arguments[4]?.getText(ideasFile) !== "'idea'") {
    return 'the selected idea page must use pageBudget() with an idea frame';
  }
  const discriminatorBody = /export function isAtomicSelectorPage[\s\S]*?\n}/.exec(budgetText)?.[0] ?? '';
  if (!discriminatorBody.includes("tool === 'mai_ideas'")
    || !discriminatorBody.includes("framed.kind === 'idea'")) {
    return 'isAtomicSelectorPage must pair mai_ideas with idea frames';
  }
  return null;
}
const leaf = src('src/read-budget.ts').getFullText();
const ideaAtomicViolation = ideaAtomicPagingViolation(ideas, leaf);
if (ideaAtomicViolation) fail(ideaAtomicViolation);
const finalizeBody = /export function finalizeToolResult[\s\S]*?\n}/.exec(leaf);
if (!finalizeBody) fail('finalizeToolResult not found in src/read-budget.ts');
const fb = finalizeBody[0];
const atomicAt = fb.indexOf('isAtomicSelectorPage(tool, complete)');
const budgetTextAt = fb.indexOf('budgetText(mcpBudget()');
if (atomicAt < 0) fail('finalizeToolResult must branch on isAtomicSelectorPage(tool, complete)');
if (budgetTextAt < 0) fail('finalizeToolResult must fall through to the generic budgetText cap');
if (atomicAt > budgetTextAt) fail('the atomic-page branch must precede the generic cap');
const discriminator = /export function isAtomicSelectorPage[\s\S]*?\n}/.exec(leaf);
if (!discriminator) fail('isAtomicSelectorPage not found');
const d = discriminator[0];
for (const needle of [
  "tool === 'mai_plan'", "framed.kind === 'synthesis'",
  "tool === 'mai_findings'", "framed.kind === 'finding'",
  "tool === 'mai_shared'", "framed.kind === 'share'",
  "tool === 'mai_ideas'", "framed.kind === 'idea'",
  'text.length > pageBudget().charBudget',
]) {
  if (!d.includes(needle)) fail(`isAtomicSelectorPage must contain \`${needle}\``);
}
if (!/\bisError\b/.test(fb)) fail('finalizeToolResult must discriminate on isError');

// ---------- 7: mai_prime is the ONE production call that carries pageBudget() ----------
// A pure source-text predicate so the self-test below can mutate a COPY in
// memory: the checkout is never written to (plan 38 R1).
const PRIME_DISPATCH_CALL = 'prime(p.task_description,p.mode??"summary",pageBudget())';
const normalizeCall = (text) => text.replace(/\s+/g, '').replace(/'/g, '"');

function primeDispatchViolation(sourceText) {
  const file = ts.createSourceFile('index.ts', sourceText, ts.ScriptTarget.ES2022, true);
  let importsPageBudget = false;
  const primeCalls = [];
  visit(file, (n) => {
    if (ts.isImportDeclaration(n)
      && /read-budget\.js/.test(n.moduleSpecifier.getText())
      && /\bpageBudget\b/.test(n.getText())) {
      importsPageBudget = true;
    }
    if (ts.isCallExpression(n) && n.expression.getText() === 'prime') primeCalls.push(n);
  });
  if (!importsPageBudget) return 'src/index.ts must import pageBudget from ./read-budget.js';
  const budgeted = primeCalls.filter((c) => /pageBudget\(\)/.test(c.getText()));
  if (budgeted.length !== 1) {
    return `exactly one production prime(...) call may pass pageBudget(), found ${budgeted.length}`;
  }
  const call = budgeted[0];
  if (normalizeCall(call.getText()) !== PRIME_DISPATCH_CALL) {
    return `the mai_prime dispatch must call ${PRIME_DISPATCH_CALL}, found ${normalizeCall(call.getText())}`;
  }
  let clause = call.parent;
  while (clause && !ts.isCaseClause(clause)) clause = clause.parent;
  if (!clause || !/['"]mai_prime['"]/.test(clause.expression.getText())) {
    return 'the budgeted prime(...) call must live in the case "mai_prime" dispatch clause';
  }
  return null;
}

const primeViolation = primeDispatchViolation(index.getFullText());
if (primeViolation) fail(primeViolation);

console.log(`read-budget wire inventory OK (${budget.MCP_READ_TOOLS.length} reads; one finalizer)`);


if (process.argv.includes('--self-test')) {
  const live = fs.readFileSync(path.join(root, 'src/index.ts'), 'utf8');
  if (primeDispatchViolation(live)) fail(`self-test: live source must conform (${primeDispatchViolation(live)})`);
  const dropped = live.replace(
    'await prime(p.task_description, p.mode ?? "summary", pageBudget())',
    'await prime(p.task_description, p.mode ?? "summary")');
  if (dropped === live) fail('self-test: could not construct the dropped-budget mutation');
  if (!primeDispatchViolation(dropped)) fail('self-test: dropping the dispatch budget was NOT rejected');
  const second = live.replace(
    'case "mai_topics": {',
    'case "mai_topics": { const leaked = await prime("x", "summary", pageBudget()); void leaked;');
  if (second === live) fail('self-test: could not construct the second-caller mutation');
  if (!primeDispatchViolation(second)) fail('self-test: a second pageBudget() prime caller was NOT rejected');
  const droppedOperatorOwner = live.replace(
    'await operatorTasksText(rawArguments, mcpBudget())',
    'await operatorTasksText(rawArguments)');
  if (droppedOperatorOwner === live) fail('self-test: could not construct missing operatorTasksText owner');
  if (!operatorTaskBudgetOwnerViolation(droppedOperatorOwner)) {
    fail('self-test: missing operatorTasksText budget owner was NOT rejected');
  }
  const fakeOperatorOwner = droppedOperatorOwner
    + '\nasync function fakeOperatorTaskBudgetOwner(rawArguments) { '
    + 'return operatorTasksText(rawArguments, mcpBudget()); }\n';
  if (!operatorTaskBudgetOwnerViolation(fakeOperatorOwner)) {
    fail('self-test: fake operatorTasksText budget owner was NOT rejected');
  }
  const droppedIdeaOwner = live.replace(
    '          includeClosed: p.include_closed,\n          budget: mcpBudget(),',
    '          includeClosed: p.include_closed,\n          budget: undefined,',
  );
  if (droppedIdeaOwner === live) fail('self-test: could not construct missing ideasReadMarkdown budget owner');
  if (!ideaBudgetOwnerViolation(droppedIdeaOwner)) {
    fail('self-test: missing ideasReadMarkdown budget owner was NOT rejected');
  }
  const liveIdeas = fs.readFileSync(path.join(root, 'src/ideas.ts'), 'utf8');
  const liveBudget = fs.readFileSync(path.join(root, 'src/read-budget.ts'), 'utf8');
  const wrongIdeaFrame = liveIdeas.replace("complete, part, 'idea',", "complete, part, 'share',");
  if (wrongIdeaFrame === liveIdeas) fail('self-test: could not construct wrong idea-frame producer');
  if (!ideaAtomicPagingViolation(wrongIdeaFrame, liveBudget)) {
    fail('self-test: wrong idea-frame producer was NOT rejected');
  }
  const droppedIdeaPair = liveBudget.replace(
    "    || (tool === 'mai_ideas' && framed.kind === 'idea');",
    '    ;',
  );
  if (droppedIdeaPair === liveBudget) fail('self-test: could not construct missing mai_ideas/idea discriminator');
  if (!ideaAtomicPagingViolation(liveIdeas, droppedIdeaPair)) {
    fail('self-test: missing mai_ideas/idea discriminator was NOT rejected');
  }
  console.log('read-budget mutation self-test OK');
}
