// mai-graph python extractor (spec §3.2) — tree-sitter-python via WASM.
// Existing source structure plus bounded, provenance-backed HTTP/event contracts.
// Local-only, literal-only, no cross-file value flow and no LLM.
import fs from 'node:fs';
import path from 'node:path';
import { Query, type Node } from 'web-tree-sitter';
import {
  endpointQName, eventChannelQName, httpCallQName, normalizeHttpMethod,
  normalizeRoutePath, owningRegisteredRepo, parseLiteralHttpUrl, serviceIdentity,
  serviceSourceQName, type HttpMethod, type ServiceIdentity,
} from '../contracts.js';
import { hashContent } from '../engine.js';
import { loadLanguage, parserFor } from '../parsers.js';
import { canonicalPhysicalPath, canonicalRegisteredRoots } from '../roots.js';
import { listOwnedRepoFiles } from '../walk.js';
import type {
  ContractSkipTallies, ExtractedEdge, ExtractedNode, ExtractorOutput,
  GraphExtractor, NodeRef,
} from '../types.js';

export const PY_EXT = new Set(['.py']);
const MAIN_RE = /if\s+__name__\s*==\s*['"]__main__['"]/;
const HTTP_VERBS = new Set(['get', 'post', 'put', 'patch', 'delete', 'head', 'options']);
const QUERY_SRC =
  '(import_statement name: (dotted_name) @mod) ' +
  '(import_from_statement module_name: (dotted_name) @from) ' +
  '(function_definition name: (identifier) @fn) ' +
  '(class_definition name: (identifier) @cls) ' +
  '(call function: (identifier) @call) ' +
  '(call function: (attribute attribute: (identifier) @call))';

type HttpLibrary = 'requests' | 'httpx' | 'aiohttp';
type ModuleName = HttpLibrary | 'fastapi' | 'flask' | 'celery' | 'kafka';
type ConstructorCapability =
  | 'fastapi_app' | 'fastapi_router' | 'flask_app' | 'celery_app'
  | 'http_client' | 'kafka_producer' | 'kafka_consumer';
type Binding =
  | { kind: 'module'; module: ModuleName; receiverId: string }
  | { kind: 'constructor'; capability: ConstructorCapability; library?: HttpLibrary }
  | { kind: 'http_function'; library: HttpLibrary; method: string }
  | { kind: 'instance'; capability: ConstructorCapability; receiverId: string; library?: HttpLibrary; prefix?: string; dynamicPrefix?: boolean; unsupportedPrefix?: boolean };
interface BindingEvent { position: number; value: Binding | null; exists: boolean }
interface Arguments {
  positional: Node[];
  keywords: Map<string, Node>;
  keywordExpansion: boolean;
}
type StringExpressionClassification =
  | { kind: 'decoded'; value: string }
  | { kind: 'static_unsupported' }
  | { kind: 'dynamic' }
  | { kind: 'absent' };
interface LexicalScope {
  id: number;
  kind: 'module' | 'function' | 'class' | 'lambda' | 'comprehension' | 'annotation' | 'branch';
  parent: LexicalScope | null;
  events: Map<string, BindingEvent[]>;
  overlayEvents: Map<string, BindingEvent[]>;
  locals: Set<string>;
  globals: Set<string>;
  nonlocals: Set<string>;
  overlayNames: Set<string>;
}
interface MemberEvent { receiverId: string; member: string; position: number; scope: LexicalScope }
type BindingOperation =
  | { kind: 'known'; scope: LexicalScope; overlay?: boolean; name: string; value: Binding; position: number }
  | { kind: 'assignment'; scope: LexicalScope; overlay?: boolean; evaluationScope: LexicalScope; name: string; right: Node | null; evaluationPosition: number; position: number; receiverId: string }
  | { kind: 'invalidate'; scope: LexicalScope; overlay?: boolean; name: string; position: number }
  | { kind: 'delete'; scope: LexicalScope; overlay?: boolean; name: string; position: number }
  | { kind: 'member'; evaluationScope: LexicalScope; effectScope: LexicalScope; receiver: string; member: string; evaluationPosition: number; position: number; eventPosition: number }
  | { kind: 'join'; scope: LexicalScope; branches: LexicalScope[]; includeParent: boolean; parentPosition: number; position: number };
interface BindingContext {
  root: LexicalScope;
  scopeByNode: Map<string, LexicalScope[]>;
  evaluationPositions: Map<string, number[]>;
  nonExecutingNodes: Set<string>;
  memberEvents: MemberEvent[];
  unstableNames: Set<string>;
  deferredUnstableNames: Set<string>;
  unstableMembers: Set<string>;
}
interface RuntimeWindow {
  sourceStart: number;
  sourceEnd: number;
  runtimeStart: number;
  runtimeEnd: number;
}
interface ContractSink {
  nodes: ExtractedNode[]; edges: ExtractedEdge[]; skips: ContractSkipTallies;
  nodeQNames: Set<string>; edgeKeys: Set<string>;
}

function emptyContractSkips(): ContractSkipTallies {
  return { dynamic_http_url: 0, dynamic_http_method: 0, dynamic_http_route: 0, dynamic_event_channel: 0 };
}

function resolveModule(module: string, repoRoot: string): string | null {
  const rel = module.split('.').join('/');
  for (const cand of [`${rel}.py`, `${rel}/__init__.py`]) {
    try {
      const absolute = path.join(repoRoot, cand);
      if (fs.statSync(absolute).isFile()) return absolute;
    } catch { /* try next */ }
  }
  return null;
}

function supportedModule(value: string): ModuleName | null {
  if (value === 'requests' || value === 'httpx' || value === 'aiohttp'
    || value === 'fastapi' || value === 'flask' || value === 'celery' || value === 'kafka') return value;
  return null;
}

function importedBinding(moduleName: string, imported: string): Binding | null {
  const module = supportedModule(moduleName);
  if (module === null) return null;
  if (module === 'fastapi' && imported === 'FastAPI') return { kind: 'constructor', capability: 'fastapi_app' };
  if (module === 'fastapi' && imported === 'APIRouter') return { kind: 'constructor', capability: 'fastapi_router' };
  if (module === 'flask' && imported === 'Flask') return { kind: 'constructor', capability: 'flask_app' };
  if (module === 'celery' && imported === 'Celery') return { kind: 'constructor', capability: 'celery_app' };
  if (module === 'kafka' && imported === 'KafkaProducer') return { kind: 'constructor', capability: 'kafka_producer' };
  if (module === 'kafka' && imported === 'KafkaConsumer') return { kind: 'constructor', capability: 'kafka_consumer' };
  if ((module === 'httpx' && (imported === 'Client' || imported === 'AsyncClient'))
    || (module === 'aiohttp' && imported === 'ClientSession')
    || (module === 'requests' && imported === 'Session')) {
    return { kind: 'constructor', capability: 'http_client', library: module };
  }
  if ((module === 'requests' || module === 'httpx') && (HTTP_VERBS.has(imported) || imported === 'request')) {
    return { kind: 'http_function', library: module, method: imported };
  }
  if (module === 'aiohttp' && imported === 'request') {
    return { kind: 'http_function', library: module, method: imported };
  }
  return null;
}

function unwrapExpression(node: Node): Node {
  let current = node;
  while (current.type === 'parenthesized_expression' && current.namedChildCount === 1) {
    const inner = current.namedChild(0);
    if (!inner) break;
    current = inner;
  }
  return current;
}

function namedUnicodeCharacter(name: string): string | null {
  const small = /^LATIN SMALL LETTER ([A-Z])$/.exec(name);
  if (small) return small[1].toLowerCase();
  const capital = /^LATIN CAPITAL LETTER ([A-Z])$/.exec(name);
  if (capital) return capital[1];
  const digits = new Map([
    ['DIGIT ZERO', '0'], ['DIGIT ONE', '1'], ['DIGIT TWO', '2'], ['DIGIT THREE', '3'],
    ['DIGIT FOUR', '4'], ['DIGIT FIVE', '5'], ['DIGIT SIX', '6'], ['DIGIT SEVEN', '7'],
    ['DIGIT EIGHT', '8'], ['DIGIT NINE', '9'],
  ]);
  const punctuation = new Map([
    ['SPACE', ' '], ['FULL STOP', '.'], ['SOLIDUS', '/'], ['REVERSE SOLIDUS', '\\'],
    ['HYPHEN-MINUS', '-'], ['LOW LINE', '_'], ['COLON', ':'], ['SEMICOLON', ';'],
    ['QUESTION MARK', '?'], ['NUMBER SIGN', '#'], ['AMPERSAND', '&'], ['EQUALS SIGN', '='],
    ['LINE FEED', '\n'], ['CARRIAGE RETURN', '\r'], ['CHARACTER TABULATION', '\t'],
  ]);
  return digits.get(name) ?? punctuation.get(name) ?? null;
}

function stringLiteral(node: Node | null | undefined): string | null {
  if (!node) return null;
  const expression = unwrapExpression(node);
  if (expression.type === 'concatenated_string') {
    let combined = '';
    for (const child of expression.namedChildren) {
      if (!child) continue;
      const value = stringLiteral(child);
      if (value === null) return null;
      combined += value;
    }
    return combined;
  }
  if (expression.type !== 'string') return null;
  const match = /^([rRuUbBfF]*)(\"\"\"|'''|\"|')([\s\S]*)\2$/.exec(expression.text);
  if (!match) return null;
  const prefixes = match[1].toLowerCase();
  if (prefixes.includes('b') || prefixes.includes('f')) return null;
  const body = match[3];
  if (prefixes.includes('r')) return body;
  let decoded = '';
  for (let index = 0; index < body.length; index++) {
    const char = body[index];
    if (char !== '\\') { decoded += char; continue; }
    index++;
    if (index >= body.length) return null;
    const escaped = body[index];
    const simple = new Map([
      ['\\', '\\'], ["'", "'"], ['"', '"'], ['a', '\u0007'], ['b', '\b'],
      ['f', '\f'], ['n', '\n'], ['r', '\r'], ['t', '\t'], ['v', '\u000b'],
    ]);
    const replacement = simple.get(escaped);
    if (replacement !== undefined) { decoded += replacement; continue; }
    if (escaped === '\n') continue;
    if (escaped === '\r' && body[index + 1] === '\n') { index++; continue; }
    if (/[0-7]/.test(escaped)) {
      let digits = escaped;
      while (digits.length < 3 && /[0-7]/.test(body[index + 1] ?? '')) digits += body[++index];
      decoded += String.fromCodePoint(Number.parseInt(digits, 8));
      continue;
    }
    const width = escaped === 'x' ? 2 : escaped === 'u' ? 4 : escaped === 'U' ? 8 : 0;
    if (width > 0) {
      const digits = body.slice(index + 1, index + 1 + width);
      if (digits.length !== width || !/^[0-9a-fA-F]+$/.test(digits)) return null;
      const point = Number.parseInt(digits, 16);
      if (point > 0x10ffff) return null;
      decoded += String.fromCodePoint(point);
      index += width;
      continue;
    }
    if (escaped === 'N' && body[index + 1] === '{') {
      const close = body.indexOf('}', index + 2);
      if (close < 0) return null;
      const named = namedUnicodeCharacter(body.slice(index + 2, close));
      if (named === null) return null;
      decoded += named;
      index = close;
      continue;
    }
    // Python preserves unrecognized escapes in ordinary strings.
    decoded += `\\${escaped}`;
  }
  return decoded;
}

const STATIC_ATOM_TYPES = new Set([
  'none', 'true', 'false', 'ellipsis', 'integer', 'float', 'list', 'tuple', 'set', 'dictionary',
]);

function classifyStringExpression(node: Node | null | undefined): StringExpressionClassification {
  if (!node) return { kind: 'absent' };
  const expression = unwrapExpression(node);
  const decoded = stringLiteral(expression);
  if (decoded !== null) return { kind: 'decoded', value: decoded };
  if (expression.type === 'concatenated_string') {
    const children = expression.namedChildren.filter((child) => child !== null)
      .map((child) => classifyStringExpression(child));
    return children.every((child) => child.kind === 'decoded' || child.kind === 'static_unsupported')
      ? { kind: 'static_unsupported' }
      : { kind: 'dynamic' };
  }
  if (expression.type === 'string') {
    const match = /^([rRuUbBfF]*)(?:\"\"\"|'''|\"|')/.exec(expression.text);
    return match !== null && !match[1].toLowerCase().includes('f')
      ? { kind: 'static_unsupported' }
      : { kind: 'dynamic' };
  }
  if (STATIC_ATOM_TYPES.has(expression.type)) return { kind: 'static_unsupported' };
  if (expression.type === 'unary_operator') {
    const operands = expression.namedChildren.filter((child) => child !== null)
      .map((child) => classifyStringExpression(child));
    if (operands.length > 0 && operands.every((child) => child.kind === 'decoded' || child.kind === 'static_unsupported')) {
      return { kind: 'static_unsupported' };
    }
  }
  return { kind: 'dynamic' };
}

function callArguments(call: Node): Arguments {
  const positional: Node[] = [];
  const keywords = new Map<string, Node>();
  let keywordExpansion = false;
  const args = call.childForFieldName('arguments');
  if (!args) return { positional, keywords, keywordExpansion };
  for (const child of args.namedChildren) {
    if (!child) continue;
    if (child.type === 'keyword_argument') {
      const name = child.childForFieldName('name');
      const value = child.childForFieldName('value');
      if (name && value) keywords.set(name.text, value);
    } else if (child.type === 'dictionary_splat') keywordExpansion = true;
    else positional.push(child);
  }
  return { positional, keywords, keywordExpansion };
}

function calleeParts(call: Node): { receiver: Node | null; member: string } | null {
  const rawFunction = call.childForFieldName('function');
  if (!rawFunction) return null;
  const fn = unwrapExpression(rawFunction);
  if (fn.type === 'identifier') return { receiver: null, member: fn.text };
  if (fn.type !== 'attribute') return null;
  const rawReceiver = fn.childForFieldName('object');
  const member = fn.childForFieldName('attribute');
  if (!rawReceiver || !member) return null;
  const receiver = unwrapExpression(rawReceiver);
  if (receiver.type !== 'identifier') return null;
  return { receiver, member: member.text };
}

function nodeKey(node: Node): string {
  return `${node.type}:${node.startIndex}:${node.endIndex}`;
}

function addBindingEvent(scope: LexicalScope, name: string, event: BindingEvent): void {
  const entries = scope.events.get(name);
  if (entries) entries.push(event); else scope.events.set(name, [event]);
}

function addOverlayEvent(scope: LexicalScope, name: string, event: BindingEvent): void {
  const entries = scope.overlayEvents.get(name);
  if (entries) entries.push(event); else scope.overlayEvents.set(name, [event]);
}

function ownBindingEvent(
  scope: LexicalScope,
  name: string,
  position: number,
): { seen: boolean; exists: boolean; value: Binding | null } {
  const entries = scope.events.get(name) ?? [];
  let seen = false;
  let exists = false;
  let value: Binding | null = null;
  for (const entry of entries) {
    if (entry.position >= position) break;
    seen = true;
    exists = entry.exists;
    value = entry.value;
  }
  return { seen, exists, value };
}

function ownOverlayEvent(
  scope: LexicalScope,
  name: string,
  position: number,
): { seen: boolean; exists: boolean; value: Binding | null } {
  const entries = scope.overlayEvents.get(name) ?? [];
  let seen = false;
  let exists = false;
  let value: Binding | null = null;
  for (const entry of entries) {
    if (entry.position >= position) break;
    seen = true;
    exists = entry.exists;
    value = entry.value;
  }
  return { seen, exists, value };
}

function moduleScope(scope: LexicalScope): LexicalScope {
  let current = scope;
  while (current.parent !== null) current = current.parent;
  return current;
}

function nearestNonClassScope(scope: LexicalScope): LexicalScope {
  let current = scope;
  while (current.kind === 'class' && current.parent !== null) current = current.parent;
  return current;
}

function nearestExecutionScope(scope: LexicalScope): LexicalScope {
  let current = scope;
  while ((current.kind === 'class' || current.kind === 'annotation' || current.kind === 'branch')
    && current.parent !== null) {
    current = current.parent;
  }
  return current;
}

function nearestBranchScope(scope: LexicalScope): LexicalScope | null {
  let current: LexicalScope | null = scope;
  while (current !== null) {
    if (current.kind === 'branch') return current;
    current = current.parent;
  }
  return null;
}

function nonlocalScope(scope: LexicalScope, name: string): LexicalScope | null {
  let current = scope.parent;
  while (current !== null) {
    if (current.kind !== 'class' && current.locals.has(name)) return current;
    current = current.parent;
  }
  return null;
}

function bindingAt(context: BindingContext, scope: LexicalScope, name: string, position: number): Binding | null {
  if (context.unstableNames.has(name)) return null;
  if (nearestExecutionScope(scope).kind !== 'module' && context.deferredUnstableNames.has(name)) return null;
  if (scope.globals.has(name)) {
    const overlay = ownBindingEvent(scope, name, position);
    if (overlay.seen) return overlay.exists ? overlay.value : null;
    const executionScope = nearestExecutionScope(scope);
    if (executionScope.kind !== 'module' && executionScope.overlayNames.has(name)) {
      const eagerOverlay = ownOverlayEvent(executionScope, name, position);
      if (eagerOverlay.seen) return eagerOverlay.exists ? eagerOverlay.value : null;
    }
    return bindingAt(context, moduleScope(scope), name, position);
  }
  if (scope.nonlocals.has(name)) {
    const overlay = ownBindingEvent(scope, name, position);
    const target = nonlocalScope(scope, name);
    return overlay.seen || target === null
      ? (overlay.exists ? overlay.value : null)
      : bindingAt(context, target, name, position);
  }
  if (scope.locals.has(name)) {
    const own = ownBindingEvent(scope, name, position);
    if (scope.kind === 'branch' && !own.seen && scope.parent !== null) {
      return bindingAt(context, scope.parent, name, position);
    }
    if (scope.kind === 'class' && (!own.seen || !own.exists) && scope.parent !== null) {
      return bindingAt(context, scope.parent, name, position);
    }
    return own.exists ? own.value : null;
  }
  if (scope.overlayNames.has(name)) {
    const overlay = ownOverlayEvent(scope, name, position);
    if (overlay.seen) return overlay.exists ? overlay.value : null;
  }
  return scope.parent === null ? null : bindingAt(context, scope.parent, name, position);
}

function scopeContains(ancestor: LexicalScope, scope: LexicalScope): boolean {
  let current: LexicalScope | null = scope;
  while (current !== null) {
    if (current === ancestor) return true;
    current = current.parent;
  }
  return false;
}

function memberIsLive(
  context: BindingContext,
  scope: LexicalScope,
  binding: Binding,
  member: string,
  position: number,
): boolean {
  if (binding.kind !== 'module' && binding.kind !== 'instance') return true;
  if (context.unstableMembers.has(member)) return false;
  return !context.memberEvents.some((event) => event.receiverId === binding.receiverId
    && event.member === member && scopeContains(event.scope, scope) && event.position < position);
}

function memberBinding(
  context: BindingContext,
  scope: LexicalScope,
  binding: Binding,
  member: string,
  position: number,
): Binding | null {
  if (binding.kind !== 'module' || !memberIsLive(context, scope, binding, member, position)) return null;
  return importedBinding(binding.module, member);
}

function constructorBinding(
  call: Node,
  scope: LexicalScope,
  context: BindingContext,
  receiverId: string,
  evaluationPosition = call.startIndex,
): Binding | null {
  const parts = calleeParts(call);
  if (parts === null) return null;
  let binding: Binding | null;
  if (parts.receiver === null) binding = bindingAt(context, scope, parts.member, evaluationPosition);
  else {
    const receiver = bindingAt(context, scope, parts.receiver.text, evaluationPosition);
    binding = receiver === null ? null : memberBinding(context, scope, receiver, parts.member, evaluationPosition);
  }
  if (binding?.kind !== 'constructor') return null;
  const args = callArguments(call);
  if (binding.capability === 'fastapi_router') {
    const prefixNode = args.keywords.get('prefix');
    if (prefixNode === undefined) return args.keywordExpansion
      ? { kind: 'instance', capability: binding.capability, receiverId, dynamicPrefix: true }
      : { kind: 'instance', capability: binding.capability, receiverId, prefix: '' };
    const prefix = classifyStringExpression(prefixNode);
    if (prefix.kind === 'decoded') {
      return { kind: 'instance', capability: binding.capability, receiverId, prefix: prefix.value };
    }
    return prefix.kind === 'dynamic'
      ? { kind: 'instance', capability: binding.capability, receiverId, dynamicPrefix: true }
      : { kind: 'instance', capability: binding.capability, receiverId, unsupportedPrefix: true };
  }
  return {
    kind: 'instance', capability: binding.capability, receiverId,
    ...(binding.library === undefined ? {} : { library: binding.library }),
  };
}

function parameterNames(parameters: Node | null): string[] {
  if (!parameters) return [];
  const names: string[] = [];
  for (const child of parameters.namedChildren) {
    if (!child) continue;
    if (child.type === 'identifier') names.push(child.text);
    else {
      const name = child.childForFieldName('name');
      if (name?.type === 'identifier') names.push(name.text);
      else if (child.type === 'list_splat' || child.type === 'dictionary_splat') {
        const identifier = child.namedChildren.find((entry) => entry?.type === 'identifier');
        if (identifier) names.push(identifier.text);
      }
    }
  }
  return names;
}

function typeParameterNames(parameters: Node | null): string[] {
  if (!parameters) return [];
  const names: string[] = [];
  for (const parameter of parameters.namedChildren) {
    if (!parameter) continue;
    const name = parameter.descendantsOfType('identifier')[0];
    if (name) names.push(name.text);
  }
  return names;
}

function targetIdentifiers(target: Node | null): string[] {
  return storeTargets(target).flatMap((entry) => entry.kind === 'name' ? [entry.name] : []);
}

function memberTarget(target: Node | null): { receiver: string; member: string } | null {
  if (target?.type !== 'attribute') return null;
  const rawReceiver = target.childForFieldName('object');
  const member = target.childForFieldName('attribute');
  if (!rawReceiver || !member) return null;
  const receiver = unwrapExpression(rawReceiver);
  if (receiver.type !== 'identifier') return null;
  return { receiver: receiver.text, member: member.text };
}

type StoreTarget =
  | { kind: 'name'; name: string }
  | { kind: 'member'; receiver: string; member: string };

interface StoreTargetLeaf { node: Node; target: StoreTarget | null }

function storeTargetLeaves(target: Node | null): StoreTargetLeaf[] {
  if (!target) return [];
  if (target.type === 'identifier') {
    return [{ node: target, target: { kind: 'name', name: target.text } }];
  }
  const member = memberTarget(target);
  if (member !== null) return [{ node: target, target: { kind: 'member', ...member } }];
  if (target.type === 'attribute' || target.type === 'subscript') return [{ node: target, target: null }];
  const leaves: StoreTargetLeaf[] = [];
  for (const child of target.namedChildren) if (child) leaves.push(...storeTargetLeaves(child));
  return leaves;
}

function storeTargets(target: Node | null): StoreTarget[] {
  return storeTargetLeaves(target).flatMap((leaf) => leaf.target === null ? [] : [leaf.target]);
}

function collectScopeDeclarations(node: Node | null, scope: LexicalScope): void {
  if (!node) return;
  const nestedScope = node.type === 'function_definition' || node.type === 'class_definition'
    || node.type === 'lambda' || node.type.endsWith('_comprehension') || node.type === 'generator_expression';
  if (nestedScope) return;
  if (node.type === 'global_statement' || node.type === 'nonlocal_statement') {
    const target = node.type === 'global_statement' ? scope.globals : scope.nonlocals;
    for (const child of node.namedChildren) if (child?.type === 'identifier') target.add(child.text);
    return;
  }
  for (const child of node.namedChildren) if (child) collectScopeDeclarations(child, scope);
}

function containsOwnYield(node: Node | null): boolean {
  if (node === null) return false;
  if (node.type === 'yield' || node.type === 'yield_from') return true;
  if (node.type === 'function_definition' || node.type === 'lambda' || node.type === 'class_definition') {
    return false;
  }
  return node.namedChildren.some((child) => child !== null && containsOwnYield(child));
}

function collectConservativeHazards(root: Node): {
  unstableNames: Set<string>;
  deferredUnstableNames: Set<string>;
  unstableMembers: Set<string>;
} {
  const unstableNames = new Set<string>();
  const unstableMembers = new Set<string>();
  const moduleWrites = new Map<string, number>();
  const recordModuleName = (name: string): void => {
    moduleWrites.set(name, (moduleWrites.get(name) ?? 0) + 1);
  };
  const recordTarget = (target: Node | null, deferred: boolean, routedNames: Set<string>): void => {
    for (const storeTarget of storeTargets(target)) {
      if (storeTarget.kind === 'name') {
        if (deferred && routedNames.has(storeTarget.name)) unstableNames.add(storeTarget.name);
        else if (!deferred) recordModuleName(storeTarget.name);
      } else if (deferred) unstableMembers.add(storeTarget.member);
    }
  };
  const routedNames = (suite: Node | null): Set<string> => {
    const names = new Set<string>();
    const visitDeclarations = (node: Node): void => {
      if (node.type === 'function_definition' || node.type === 'class_definition' || node.type === 'lambda') return;
      if (node.type === 'global_statement' || node.type === 'nonlocal_statement') {
        for (const child of node.namedChildren) if (child?.type === 'identifier') names.add(child.text);
        return;
      }
      for (const child of node.namedChildren) if (child) visitDeclarations(child);
    };
    if (suite !== null) visitDeclarations(suite);
    return names;
  };
  const visit = (node: Node, deferred: boolean, activeRoutedNames: Set<string>): void => {
    if (node.type === 'function_definition') {
      const body = node.childForFieldName('body');
      const nestedRoutedNames = routedNames(body);
      for (const child of node.namedChildren) {
        if (child) visit(child, body !== null && nodeKey(child) === nodeKey(body), nestedRoutedNames);
      }
      return;
    }
    if (node.type === 'lambda') deferred = true;
    if (node.type === 'import_statement' && !deferred) {
      for (const child of node.namedChildren) {
        if (!child) continue;
        const imported = child.type === 'aliased_import' ? child.childForFieldName('name') : child;
        const alias = child.type === 'aliased_import' ? child.childForFieldName('alias') : null;
        if (imported) recordModuleName(alias?.text ?? imported.text.split('.')[0]);
      }
    } else if (node.type === 'import_from_statement' && !deferred) {
      const moduleNode = node.childForFieldName('module_name');
      for (const child of node.namedChildren) {
        if (!child || (moduleNode !== null && nodeKey(child) === nodeKey(moduleNode))) continue;
        const imported = child.type === 'aliased_import' ? child.childForFieldName('name') : child;
        const alias = child.type === 'aliased_import' ? child.childForFieldName('alias') : null;
        if (imported) recordModuleName(alias?.text ?? imported.text);
      }
    } else if (node.type === 'assignment' || node.type === 'augmented_assignment') {
      recordTarget(node.childForFieldName('left'), deferred, activeRoutedNames);
    } else if (node.type === 'named_expression') {
      recordTarget(node.childForFieldName('name'), deferred, activeRoutedNames);
    } else if (node.type === 'delete_statement') {
      for (const child of node.namedChildren) {
        if (child) recordTarget(child, deferred, activeRoutedNames);
      }
    } else if (node.type === 'for_statement' || node.type === 'for_in_clause') {
      recordTarget(node.childForFieldName('left'), deferred, activeRoutedNames);
    } else if (node.type === 'as_pattern') {
      recordTarget(node.childForFieldName('alias'), deferred, activeRoutedNames);
    }
    for (const child of node.namedChildren) if (child) visit(child, deferred, activeRoutedNames);
  };
  visit(root, false, new Set());
  const deferredUnstableNames = new Set(
    [...moduleWrites].filter(([, count]) => count > 1).map(([name]) => name),
  );
  return { unstableNames, deferredUnstableNames, unstableMembers };
}

function markLocal(scope: LexicalScope, name: string): void {
  if (!scope.globals.has(name) && !scope.nonlocals.has(name)) scope.locals.add(name);
}

function matchCaptureNames(pattern: Node): string[] {
  if (pattern.type === 'dotted_name') {
    return !pattern.text.includes('.') && pattern.text !== '_' ? [pattern.text] : [];
  }
  if (pattern.type === 'class_pattern') {
    const children = pattern.namedChildren.filter((child) => child !== null);
    return children.slice(1).flatMap((child) => matchCaptureNames(child));
  }
  if (pattern.type === 'keyword_pattern') {
    const value = pattern.namedChildren.filter((child) => child !== null).at(-1);
    return value ? matchCaptureNames(value) : [];
  }
  if (pattern.type === 'splat_pattern') {
    const names: string[] = [];
    for (const child of pattern.namedChildren) {
      if (child?.type === 'identifier' && child.text !== '_') names.push(child.text);
    }
    return names;
  }
  if (pattern.type === 'identifier') return pattern.text === '_' ? [] : [pattern.text];
  if (pattern.type === 'string' || pattern.type === 'integer' || pattern.type === 'float') return [];
  const names: string[] = [];
  for (const child of pattern.namedChildren) if (child) names.push(...matchCaptureNames(child));
  return names;
}

function collectBindings(root: Node): BindingContext {
  const hazards = collectConservativeHazards(root);
  let nextScopeId = 1;
  const rootScope: LexicalScope = {
    id: 0, kind: 'module', parent: null, events: new Map(), overlayEvents: new Map(), locals: new Set(),
    globals: new Set(), nonlocals: new Set(), overlayNames: new Set(),
  };
  const scopeByNode = new Map<string, LexicalScope[]>();
  const evaluationPositions = new Map<string, number[]>();
  const nonExecutingNodes = new Set<string>();
  const operations: BindingOperation[] = [];
  const memberEvents: MemberEvent[] = [];
  const joinTargets = new Map<LexicalScope, StoreTarget[]>();
  const futureAnnotations = root.namedChildren.some((child) => child?.type === 'future_import_statement'
    && /\bannotations\b/.test(child.text));
  const recordEvaluation = (node: Node, scope: LexicalScope, position: number): void => {
    const key = nodeKey(node);
    const scopes = scopeByNode.get(key);
    if (scopes) scopes.push(scope); else scopeByNode.set(key, [scope]);
    const positions = evaluationPositions.get(key);
    if (positions) positions.push(position); else evaluationPositions.set(key, [position]);
  };
  const runtimePosition = (sourcePosition: number, window?: RuntimeWindow): number => {
    if (window === undefined) return sourcePosition;
    const sourceSpan = Math.max(1, window.sourceEnd - window.sourceStart);
    const ratio = Math.max(0, Math.min(1, (sourcePosition - window.sourceStart) / sourceSpan));
    return window.runtimeStart + ratio * (window.runtimeEnd - window.runtimeStart);
  };
  const runtimeOffset = (
    sourcePosition: number,
    sourceDelta: number,
    window?: RuntimeWindow,
  ): number => {
    const quantum = window === undefined
      ? 1
      : (window.runtimeEnd - window.runtimeStart) / Math.max(1, window.sourceEnd - window.sourceStart);
    return runtimePosition(sourcePosition, window) + sourceDelta * quantum;
  };
  const bindingEffectScope = (
    scope: LexicalScope,
    name: string,
  ): { scope: LexicalScope; overlay: boolean } => {
    if (scope.kind !== 'class') return { scope, overlay: false };
    if (scope.globals.has(name)) {
      const executionScope = nearestExecutionScope(scope);
      if (executionScope.kind === 'module') return { scope: executionScope, overlay: false };
      executionScope.overlayNames.add(name);
      return { scope: executionScope, overlay: true };
    }
    if (scope.nonlocals.has(name)) return { scope: nonlocalScope(scope, name) ?? scope, overlay: false };
    return { scope, overlay: false };
  };
  const markBranchTarget = (scope: LexicalScope, target: StoreTarget): void => {
    const branch = nearestBranchScope(scope);
    if (branch === null) return;
    const targets = joinTargets.get(branch);
    if (targets) targets.push(target); else joinTargets.set(branch, [target]);
  };
  const addStoreTargetOperation = (
    scope: LexicalScope,
    target: StoreTarget,
    right: Node | null,
    rhsEvaluationPosition: number,
    memberEvaluationPosition: number,
    position: number,
    evaluationScope: LexicalScope,
    receiverId: string,
    bindKnownName: boolean,
  ): void => {
    markBranchTarget(scope, target);
    if (target.kind === 'member') {
      operations.push({
        kind: 'member', evaluationScope, effectScope: scope,
        receiver: target.receiver, member: target.member,
        evaluationPosition: memberEvaluationPosition, position, eventPosition: position,
      });
      return;
    }
    markLocal(scope, target.name);
    const effect = bindingEffectScope(scope, target.name);
    if (right !== null && bindKnownName) {
      operations.push({
        kind: 'assignment', scope: effect.scope, overlay: effect.overlay,
        evaluationScope, name: target.name, right,
        evaluationPosition: rhsEvaluationPosition, position, receiverId,
      });
    } else operations.push({
      kind: 'invalidate', scope: effect.scope, overlay: effect.overlay, name: target.name, position,
    });
  };
  const addNameOperation = (
    scope: LexicalScope,
    target: Node | null,
    right: Node | null,
    evaluationPosition: number,
    position: number,
    evaluationScope = scope,
    sharedReceiverId?: string,
  ): void => {
    const targets = storeTargets(target);
    for (const storeTarget of targets) {
      addStoreTargetOperation(
        scope, storeTarget, right, evaluationPosition, evaluationPosition, position,
        evaluationScope,
        sharedReceiverId ?? `python-binding:${scope.id}:${storeTarget.kind === 'name' ? storeTarget.name : storeTarget.receiver}:${position}`,
        targets.length === 1 && storeTarget.kind === 'name' && target?.type === 'identifier',
      );
    }
  };
  const addDeleteOperations = (
    scope: LexicalScope,
    target: Node | null,
    evaluationPosition: number,
    position: number,
  ): void => {
    for (const storeTarget of storeTargets(target)) {
      if (storeTarget.kind === 'member') {
        addStoreTargetOperation(
          scope, storeTarget, null, evaluationPosition, evaluationPosition, position,
          scope, `python-delete:${scope.id}:${storeTarget.receiver}:${position}`, false,
        );
      } else {
        markLocal(scope, storeTarget.name);
        markBranchTarget(scope, storeTarget);
        const effect = bindingEffectScope(scope, storeTarget.name);
        operations.push({
          kind: 'delete', scope: effect.scope, overlay: effect.overlay,
          name: storeTarget.name, position,
        });
      }
    }
  };
  const recordBareAnnotation = (scope: LexicalScope, target: Node | null, position: number): void => {
    if (target?.type === 'identifier') {
      markLocal(scope, target.text);
      return;
    }
    if (target?.type === 'attribute' || target?.type === 'subscript') return;
    addNameOperation(scope, target, null, position, position);
  };
  const createScope = (
    kind: LexicalScope['kind'],
    parent: LexicalScope,
    unknownNames: string[] = [],
  ): LexicalScope => {
    const created: LexicalScope = {
      id: nextScopeId++, kind, parent, events: new Map(), overlayEvents: new Map(), locals: new Set(),
      globals: new Set(), nonlocals: new Set(), overlayNames: new Set(),
    };
    for (const name of unknownNames) {
      created.locals.add(name);
      addBindingEvent(created, name, { position: -1, value: null, exists: true });
    }
    return created;
  };
  const queueControlFlowJoin = (
    scope: LexicalScope,
    branches: LexicalScope[],
    includeParent: boolean,
    node: Node,
    runtimeWindow?: RuntimeWindow,
  ): void => {
    const position = runtimeOffset(node.endIndex, 0.95, runtimeWindow);
    operations.push({
      kind: 'join', scope, branches, includeParent,
      parentPosition: position,
      position,
    });
  };
  const visit = (node: Node, scope: LexicalScope, runtimeWindow?: RuntimeWindow): void => {
    recordEvaluation(node, scope, runtimePosition(node.startIndex, runtimeWindow));
    if (node.type === 'function_definition') {
      const name = node.childForFieldName('name');
      const definitionPosition = runtimePosition(node.endIndex, runtimeWindow);
      if (name) {
        markLocal(scope, name.text);
        markBranchTarget(scope, { kind: 'name', name: name.text });
        const effect = bindingEffectScope(scope, name.text);
        operations.push({
          kind: 'invalidate', scope: effect.scope, overlay: effect.overlay,
          name: name.text, position: definitionPosition,
        });
      }
      const lexicalParent = nearestNonClassScope(scope);
      const typeParameters = node.childForFieldName('type_parameters');
      const typeNames = typeParameterNames(typeParameters);
      const annotationScope = typeNames.length > 0 ? createScope('annotation', scope, typeNames) : scope;
      const bodyTypeScope = typeNames.length > 0 ? createScope('annotation', lexicalParent, typeNames) : lexicalParent;
      const childScope = createScope('function', bodyTypeScope);
      const parameters = node.childForFieldName('parameters');
      for (const parameter of parameterNames(parameters)) {
        childScope.locals.add(parameter);
        addBindingEvent(childScope, parameter, { position: -1, value: null, exists: true });
      }
      const body = node.childForFieldName('body');
      const returnType = node.childForFieldName('return_type');
      collectScopeDeclarations(body, childScope);
      const defaults: Node[] = [];
      const annotations: Node[] = [];
      if (parameters !== null) {
        recordEvaluation(parameters, annotationScope, runtimePosition(parameters.startIndex, runtimeWindow));
        for (const parameter of parameters.namedChildren) {
          if (!parameter) continue;
          recordEvaluation(parameter, annotationScope, runtimePosition(parameter.startIndex, runtimeWindow));
          const defaultValue = parameter.childForFieldName('value');
          const annotation = parameter.childForFieldName('type');
          const parameterName = parameter.type === 'identifier' ? parameter
            : (parameter.childForFieldName('name')
              ?? parameter.namedChildren.find((entry) => entry?.type === 'identifier') ?? null);
          if (defaultValue !== null) {
            defaults.push(defaultValue);
          }
          if (annotation !== null) annotations.push(annotation);
        }
      }
      if (returnType !== null) annotations.push(returnType);
      const visitRuntimeSequence = (
        nodes: Node[],
        targetScope: LexicalScope,
        runtimeStart: number,
        runtimeEnd: number,
      ): void => {
        if (nodes.length === 0) return;
        const sequenceWindow: RuntimeWindow = {
          sourceStart: nodes[0]?.startIndex ?? node.startIndex,
          sourceEnd: nodes.at(-1)?.endIndex ?? node.endIndex,
          runtimeStart: runtimeOffset(node.endIndex, runtimeStart - node.endIndex, runtimeWindow),
          runtimeEnd: runtimeOffset(node.endIndex, runtimeEnd - node.endIndex, runtimeWindow),
        };
        for (const expression of nodes) visit(expression, targetScope, sequenceWindow);
      };
      visitRuntimeSequence(defaults, scope, node.endIndex - 0.9, node.endIndex - 0.7);
      for (const annotation of annotations) nonExecutingNodes.add(nodeKey(annotation));
      if (typeParameters !== null) nonExecutingNodes.add(nodeKey(typeParameters));
      for (const child of node.namedChildren) {
        if (!child) continue;
        if (body !== null && nodeKey(child) === nodeKey(body)) {
          if (containsOwnYield(body)) {
            nonExecutingNodes.add(nodeKey(body));
            continue;
          }
          const bodyWindows: RuntimeWindow[] = [{
            sourceStart: child.startIndex, sourceEnd: child.endIndex,
            runtimeStart: runtimeOffset(node.endIndex, 0.1, runtimeWindow),
            runtimeEnd: runtimeOffset(node.endIndex, 0.9, runtimeWindow),
          }];
          for (const bodyWindow of bodyWindows) {
            for (const local of childScope.locals) {
              operations.push({
                kind: 'invalidate', scope: childScope, name: local,
                position: bodyWindow.runtimeStart - 0.000001,
              });
            }
            visit(child, childScope, bodyWindow);
          }
        } else if ((parameters !== null && nodeKey(child) === nodeKey(parameters))
          || (returnType !== null && nodeKey(child) === nodeKey(returnType))) {
          continue;
        } else if (name !== null && nodeKey(child) === nodeKey(name)) {
          recordEvaluation(child, annotationScope, runtimePosition(child.startIndex, runtimeWindow));
        } else {
          visit(child, annotationScope, runtimeWindow);
        }
      }
      return;
    }
    if (node.type === 'class_definition') {
      const name = node.childForFieldName('name');
      if (name) {
        addNameOperation(
          scope, name, null,
          runtimePosition(node.startIndex, runtimeWindow), runtimePosition(node.endIndex, runtimeWindow),
        );
      }
      const lexicalParent = nearestNonClassScope(scope);
      const typeParameters = node.childForFieldName('type_parameters');
      const typeNames = typeParameterNames(typeParameters);
      const annotationScope = typeNames.length > 0 ? createScope('annotation', scope, typeNames) : scope;
      const classTypeScope = typeNames.length > 0
        ? createScope('annotation', lexicalParent, typeNames)
        : lexicalParent;
      const childScope = createScope('class', classTypeScope);
      const body = node.childForFieldName('body');
      collectScopeDeclarations(body, childScope);
      for (const child of node.namedChildren) {
        if (!child) continue;
        if (typeParameters !== null && nodeKey(child) === nodeKey(typeParameters)) {
          nonExecutingNodes.add(nodeKey(child));
          continue;
        }
        visit(
          child,
          body !== null && nodeKey(child) === nodeKey(body) ? childScope : annotationScope,
          runtimeWindow,
        );
      }
      return;
    }
    if (node.type === 'lambda') {
      const lexicalParent = nearestNonClassScope(scope);
      const childScope: LexicalScope = {
        id: nextScopeId++, kind: 'lambda', parent: lexicalParent, events: new Map(), overlayEvents: new Map(), locals: new Set(),
        globals: new Set(), nonlocals: new Set(), overlayNames: new Set(),
      };
      const parameters = node.childForFieldName('parameters');
      for (const parameter of parameterNames(parameters)) {
        childScope.locals.add(parameter);
        addBindingEvent(childScope, parameter, { position: -1, value: null, exists: true });
      }
      const body = node.childForFieldName('body');
      for (const child of node.namedChildren) {
        if (!child) continue;
        if (body !== null && nodeKey(child) === nodeKey(body)) {
          nonExecutingNodes.add(nodeKey(body));
        } else visit(child, scope, runtimeWindow);
      }
      return;
    }
    if (node.type === 'if_statement' || node.type === 'elif_clause'
      || node.type === 'while_statement') {
      const condition = node.childForFieldName('condition');
      if (condition !== null) visit(condition, scope, runtimeWindow);
      const branchNodes = node.namedChildren.filter((child): child is Node => child !== null
        && (condition === null || nodeKey(child) !== nodeKey(condition)));
      const branches = branchNodes.map((branchNode) => {
        const branchScope = createScope('branch', scope);
        visit(branchNode, branchScope, runtimeWindow);
        return branchScope;
      });
      const alternative = node.childForFieldName('alternative');
      queueControlFlowJoin(
        scope,
        branches,
        node.type === 'while_statement' || alternative === null,
        node,
        runtimeWindow,
      );
      return;
    }
    if (node.type === 'boolean_operator') {
      const left = node.childForFieldName('left') ?? node.namedChild(0);
      const right = node.childForFieldName('right') ?? node.namedChild(1);
      if (left !== null) visit(left, scope, runtimeWindow);
      const branches: LexicalScope[] = [];
      if (right !== null) {
        const branchScope = createScope('branch', scope);
        visit(right, branchScope, runtimeWindow);
        branches.push(branchScope);
      }
      queueControlFlowJoin(scope, branches, true, node, runtimeWindow);
      return;
    }
    if (node.type === 'try_statement') {
      const finallyClause = node.namedChildren.find((child) => child?.type === 'finally_clause') ?? null;
      const branches = node.namedChildren.filter((child): child is Node => child !== null
        && (finallyClause === null || nodeKey(child) !== nodeKey(finallyClause)))
        .map((branchNode) => {
          const branchScope = createScope('branch', scope);
          visit(branchNode, branchScope, runtimeWindow);
          return branchScope;
        });
      if (finallyClause === null) queueControlFlowJoin(scope, branches, true, node, runtimeWindow);
      else {
        const position = runtimeOffset(finallyClause.startIndex, -0.05, runtimeWindow);
        operations.push({
          kind: 'join', scope, branches, includeParent: true,
          parentPosition: position, position,
        });
        visit(finallyClause, scope, runtimeWindow);
      }
      return;
    }
    if (node.type === 'match_statement') {
      const subject = node.childForFieldName('subject') ?? node.namedChild(0);
      if (subject !== null) visit(subject, scope, runtimeWindow);
      const branches = node.namedChildren.filter((child): child is Node => child !== null
        && (subject === null || nodeKey(child) !== nodeKey(subject)))
        .map((branchNode) => {
          const branchScope = createScope('branch', scope);
          visit(branchNode, branchScope, runtimeWindow);
          return branchScope;
        });
      queueControlFlowJoin(scope, branches, true, node, runtimeWindow);
      return;
    }
    if (node.type.endsWith('_comprehension') || node.type === 'generator_expression') {
      if (node.type === 'generator_expression') {
        const firstClause = node.namedChildren.find((child) => child?.type === 'for_in_clause') ?? null;
        const firstIterable = firstClause?.childForFieldName('right') ?? null;
        if (firstIterable !== null) visit(firstIterable, scope, runtimeWindow);
        let firstClauseSeen = false;
        for (const child of node.namedChildren) {
          if (child === null) continue;
          if (child.type === 'for_in_clause' && !firstClauseSeen) {
            firstClauseSeen = true;
            const left = child.childForFieldName('left');
            if (left !== null) nonExecutingNodes.add(nodeKey(left));
            continue;
          }
          nonExecutingNodes.add(nodeKey(child));
        }
        return;
      }
      const lexicalParent = nearestNonClassScope(scope);
      const childScope: LexicalScope = {
        id: nextScopeId++, kind: 'comprehension', parent: lexicalParent, events: new Map(), overlayEvents: new Map(), locals: new Set(),
        globals: new Set(), nonlocals: new Set(), overlayNames: new Set(),
      };
      const clauses = node.namedChildren.filter((child) => child?.type === 'for_in_clause');
      for (const clause of clauses) {
        if (!clause) continue;
        const targets = storeTargets(clause.childForFieldName('left'));
        for (const target of targets) {
          if (target.kind === 'name') {
            childScope.locals.add(target.name);
            addBindingEvent(childScope, target.name, { position: -1, value: null, exists: true });
          }
        }
      }
      const body = node.childForFieldName('body');
      const runtimeChildren = node.namedChildren.filter((child): child is Node => child !== null
        && (body === null || nodeKey(child) !== nodeKey(body)));
      const phaseCount = runtimeChildren.reduce(
        (count, child) => count + (child.type === 'for_in_clause' ? 2 : 1),
        1,
      );
      const executionWindows: RuntimeWindow[] = [{
        sourceStart: node.startIndex,
        sourceEnd: node.endIndex,
        runtimeStart: runtimePosition(node.startIndex, runtimeWindow),
        runtimeEnd: runtimePosition(node.endIndex, runtimeWindow),
      }];
      for (const executionWindow of executionWindows) {
        for (const local of childScope.locals) {
          operations.push({
            kind: 'invalidate', scope: childScope, name: local,
            position: executionWindow.runtimeStart - 0.000001,
          });
        }
        let phaseIndex = 0;
        const nextPhase = (phaseNode: Node): RuntimeWindow => {
          const start = executionWindow.runtimeStart
            + (phaseIndex / phaseCount) * (executionWindow.runtimeEnd - executionWindow.runtimeStart);
          const end = executionWindow.runtimeStart
            + ((phaseIndex + 0.8) / phaseCount) * (executionWindow.runtimeEnd - executionWindow.runtimeStart);
          phaseIndex++;
          return {
            sourceStart: phaseNode.startIndex, sourceEnd: phaseNode.endIndex,
            runtimeStart: start, runtimeEnd: end,
          };
        };
        let phaseScope = childScope;
        let clauseIndex = 0;
        for (const child of runtimeChildren) {
          if (child.type === 'for_in_clause') {
            const left = child.childForFieldName('left');
            const right = child.childForFieldName('right');
            if (right !== null) {
              const iterablePhase = nextPhase(right);
              visit(right, clauseIndex === 0 ? scope : phaseScope, iterablePhase);
            }
            const afterTargetScope = createScope('comprehension', phaseScope);
            const targetPhase = nextPhase(left ?? child);
            if (left !== null) visit(left, phaseScope, targetPhase);
            const targetEvaluationPosition = targetPhase.runtimeEnd;
            for (const target of storeTargets(left)) {
              if (target.kind !== 'member') continue;
              operations.push({
                kind: 'member', evaluationScope: phaseScope, effectScope: afterTargetScope,
                receiver: target.receiver, member: target.member, evaluationPosition: targetEvaluationPosition,
                position: targetEvaluationPosition, eventPosition: -1,
              });
              const eagerEffectPosition = runtimePosition(node.endIndex, runtimeWindow);
              operations.push({
                kind: 'member', evaluationScope: phaseScope, effectScope: scope,
                receiver: target.receiver, member: target.member, evaluationPosition: targetEvaluationPosition,
                position: eagerEffectPosition, eventPosition: eagerEffectPosition,
              });
            }
            phaseScope = afterTargetScope;
            clauseIndex++;
          } else visit(child, phaseScope, nextPhase(child));
        }
        if (body !== null) visit(body, phaseScope, nextPhase(body));
      }
      return;
    }
    if (node.type === 'conditional_expression') {
      const children = node.namedChildren.filter((child): child is Node => child !== null);
      const consequence = children[0] ?? null;
      const condition = children[1] ?? null;
      const alternative = children[2] ?? null;
      const runtimeStart = runtimePosition(node.startIndex, runtimeWindow);
      const runtimeEnd = runtimePosition(node.endIndex, runtimeWindow);
      const conditionEnd = runtimeStart + (runtimeEnd - runtimeStart) * 0.45;
      const branchStart = runtimeStart + (runtimeEnd - runtimeStart) * 0.55;
      if (condition !== null) {
        visit(condition, scope, {
          sourceStart: condition.startIndex, sourceEnd: condition.endIndex,
          runtimeStart, runtimeEnd: conditionEnd,
        });
      }
      const branches: LexicalScope[] = [];
      for (const branch of [consequence, alternative]) {
        if (branch === null) continue;
        const branchScope = createScope('branch', scope);
        visit(branch, branchScope, {
          sourceStart: branch.startIndex, sourceEnd: branch.endIndex,
          runtimeStart: branchStart, runtimeEnd,
        });
        branches.push(branchScope);
      }
      queueControlFlowJoin(scope, branches, false, node, runtimeWindow);
      return;
    }
    if (node.type === 'import_statement') {
      for (const child of node.namedChildren) {
        if (!child) continue;
        const imported = child.type === 'aliased_import' ? child.childForFieldName('name') : child;
        const alias = child.type === 'aliased_import' ? child.childForFieldName('alias') : null;
        if (!imported) continue;
        const module = supportedModule(imported.text);
        const local = alias?.text ?? imported.text.split('.')[0];
        markLocal(scope, local);
        markBranchTarget(scope, { kind: 'name', name: local });
        const effect = bindingEffectScope(scope, local);
        const position = runtimePosition(node.endIndex, runtimeWindow);
        if (module !== null) {
          operations.push({
            kind: 'known', scope: effect.scope, overlay: effect.overlay, name: local, position,
            value: { kind: 'module', module, receiverId: `python-module:${module}` },
          });
        } else operations.push({
          kind: 'invalidate', scope: effect.scope, overlay: effect.overlay, name: local, position,
        });
      }
    } else if (node.type === 'import_from_statement') {
      const moduleNode = node.childForFieldName('module_name');
      const moduleName = moduleNode?.text ?? '';
      for (const child of node.namedChildren) {
        if (!child || (moduleNode !== null && nodeKey(child) === nodeKey(moduleNode))) continue;
        const imported = child.type === 'aliased_import' ? child.childForFieldName('name') : child;
        const alias = child.type === 'aliased_import' ? child.childForFieldName('alias') : null;
        if (!imported) continue;
        const value = importedBinding(moduleName, imported.text);
        const local = alias?.text ?? imported.text;
        markLocal(scope, local);
        markBranchTarget(scope, { kind: 'name', name: local });
        const effect = bindingEffectScope(scope, local);
        const position = runtimePosition(node.endIndex, runtimeWindow);
        if (value !== null) operations.push({
          kind: 'known', scope: effect.scope, overlay: effect.overlay, name: local, value, position,
        });
        else operations.push({
          kind: 'invalidate', scope: effect.scope, overlay: effect.overlay, name: local, position,
        });
      }
    } else if (node.type === 'type_alias_statement') {
      const left = node.childForFieldName('left');
      const aliasName = left?.descendantsOfType('identifier')[0] ?? null;
      addNameOperation(
        scope, aliasName, null,
        runtimePosition(node.startIndex, runtimeWindow), runtimePosition(node.endIndex, runtimeWindow),
      );
      for (const child of node.namedChildren) {
        if (child !== null && (aliasName === null || nodeKey(child) !== nodeKey(aliasName))) {
          nonExecutingNodes.add(nodeKey(child));
        }
      }
      return;
    } else if (node.type === 'assignment') {
      const annotation = node.childForFieldName('type');
      const parentRight = node.parent?.type === 'assignment' ? node.parent.childForFieldName('right') : null;
      if (parentRight !== null && nodeKey(parentRight) === nodeKey(node)) return;
      const targets: Node[] = [];
      let current: Node = node;
      let finalRight = current.childForFieldName('right');
      const firstLeft = current.childForFieldName('left');
      if (firstLeft) targets.push(firstLeft);
      while (finalRight?.type === 'assignment') {
        current = finalRight;
        const left = current.childForFieldName('left');
        if (left) targets.push(left);
        finalRight = current.childForFieldName('right');
      }
      const statementEnd = runtimePosition(node.endIndex, runtimeWindow);
      if (finalRight === null) {
        const annotationTarget = targets[0] ?? null;
        recordBareAnnotation(scope, annotationTarget, statementEnd);
        if (annotationTarget !== null) visit(annotationTarget, scope, runtimeWindow);
      } else {
        const phaseStart = runtimeOffset(node.endIndex, 0.05, runtimeWindow);
        const phaseEnd = runtimeOffset(node.endIndex, 0.4, runtimeWindow);
        visit(finalRight, scope, runtimeWindow);
        const orderedTargets = targets.flatMap((target) => {
          const leaves = storeTargetLeaves(target);
          return leaves.map((leaf) => ({
            ...leaf,
            bindKnownName: leaves.length === 1 && leaf.target?.kind === 'name' && target.type === 'identifier',
          }));
        });
        const sharedReceiverId = `python-binding-chain:${scope.id}:${statementEnd}`;
        for (const [index, target] of orderedTargets.entries()) {
          const targetStart = phaseStart
            + (index / Math.max(1, orderedTargets.length)) * (phaseEnd - phaseStart);
          const targetEnd = phaseStart
            + ((index + 0.6) / Math.max(1, orderedTargets.length)) * (phaseEnd - phaseStart);
          const position = phaseStart
            + ((index + 0.8) / Math.max(1, orderedTargets.length)) * (phaseEnd - phaseStart);
          visit(target.node, scope, {
            sourceStart: target.node.startIndex, sourceEnd: target.node.endIndex,
            runtimeStart: targetStart, runtimeEnd: targetEnd,
          });
          if (target.target !== null) {
            addStoreTargetOperation(
              scope, target.target, finalRight,
              runtimePosition(finalRight.startIndex, runtimeWindow), position, position,
              scope, sharedReceiverId, target.bindKnownName,
            );
          }
        }
      }
      if (annotation !== null) {
        const annotationExecutes = !futureAnnotations && (scope.kind === 'module' || scope.kind === 'class');
        if (!annotationExecutes) nonExecutingNodes.add(nodeKey(annotation));
        else if (finalRight !== null) {
          visit(annotation, scope, {
            sourceStart: annotation.startIndex, sourceEnd: annotation.endIndex,
            runtimeStart: runtimeOffset(node.endIndex, 0.45, runtimeWindow),
            runtimeEnd: runtimeOffset(node.endIndex, 0.65, runtimeWindow),
          });
        } else visit(annotation, scope, runtimeWindow);
      }
      return;
    } else if (node.type === 'augmented_assignment') {
      addNameOperation(
        scope, node.childForFieldName('left'), null,
        runtimePosition(node.startIndex, runtimeWindow), runtimePosition(node.endIndex, runtimeWindow),
      );
    } else if (node.type === 'delete_statement') {
      const evaluationPosition = runtimePosition(node.startIndex, runtimeWindow);
      const position = runtimePosition(node.endIndex, runtimeWindow);
      for (const child of node.namedChildren) {
        if (child) addDeleteOperations(scope, child, evaluationPosition, position);
      }
    } else if (node.type === 'for_statement') {
      const left = node.childForFieldName('left');
      const right = node.childForFieldName('right');
      if (right !== null) visit(right, scope, runtimeWindow);
      const branchScope = createScope('branch', scope);
      const rawPhaseStart = right?.endIndex ?? node.startIndex;
      const phaseStart = runtimeOffset(rawPhaseStart, 0.1, runtimeWindow);
      const phaseEnd = runtimeOffset(rawPhaseStart, 0.6, runtimeWindow);
      const leaves = storeTargetLeaves(left);
      for (const [index, leaf] of leaves.entries()) {
        const targetStart = phaseStart + (index / Math.max(1, leaves.length)) * (phaseEnd - phaseStart);
        const targetEnd = phaseStart + ((index + 0.6) / Math.max(1, leaves.length)) * (phaseEnd - phaseStart);
        const position = phaseStart + ((index + 0.8) / Math.max(1, leaves.length)) * (phaseEnd - phaseStart);
        visit(leaf.node, branchScope, {
          sourceStart: leaf.node.startIndex, sourceEnd: leaf.node.endIndex,
          runtimeStart: targetStart, runtimeEnd: targetEnd,
        });
        if (leaf.target !== null) {
          addStoreTargetOperation(
            branchScope, leaf.target, null, phaseStart, position, position,
            branchScope, `python-for:${branchScope.id}:${position}`, false,
          );
        }
      }
      for (const child of node.namedChildren) {
        if (!child || (left !== null && nodeKey(child) === nodeKey(left))
          || (right !== null && nodeKey(child) === nodeKey(right))) continue;
        visit(child, branchScope, runtimeWindow);
      }
      queueControlFlowJoin(scope, [branchScope], true, node, runtimeWindow);
      return;
    } else if (node.type === 'named_expression') {
      let targetScope = scope;
      while (targetScope.kind === 'comprehension' && targetScope.parent !== null) targetScope = targetScope.parent;
      addNameOperation(
        targetScope, node.childForFieldName('name'), node.childForFieldName('value'),
        runtimePosition(node.startIndex, runtimeWindow), runtimePosition(node.endIndex, runtimeWindow), scope,
      );
    } else if (node.type === 'as_pattern') {
      const alias = node.childForFieldName('alias');
      const value = node.namedChildren.find((child) => child !== null
        && (alias === null || nodeKey(child) !== nodeKey(alias))) ?? null;
      if (value !== null) visit(value, scope, runtimeWindow);
      const phaseStart = runtimeOffset(node.endIndex, 0.05, runtimeWindow);
      const phaseEnd = runtimeOffset(node.endIndex, 0.5, runtimeWindow);
      const leaves = storeTargetLeaves(alias);
      for (const [index, leaf] of leaves.entries()) {
        const targetStart = phaseStart + (index / Math.max(1, leaves.length)) * (phaseEnd - phaseStart);
        const targetEnd = phaseStart + ((index + 0.6) / Math.max(1, leaves.length)) * (phaseEnd - phaseStart);
        const position = phaseStart + ((index + 0.8) / Math.max(1, leaves.length)) * (phaseEnd - phaseStart);
        visit(leaf.node, scope, {
          sourceStart: leaf.node.startIndex, sourceEnd: leaf.node.endIndex,
          runtimeStart: targetStart, runtimeEnd: targetEnd,
        });
        if (leaf.target !== null) {
          addStoreTargetOperation(
            scope, leaf.target, null, phaseStart, position, position,
            scope, `python-as:${scope.id}:${position}`, false,
          );
        }
      }
      return;
    } else if (node.type === 'except_clause') {
      const value = node.childForFieldName('value');
      const alias = value?.type === 'as_pattern' ? value.childForFieldName('alias') : null;
      if (alias !== null) {
        const clauseEnd = runtimePosition(node.endIndex, runtimeWindow);
        addDeleteOperations(
          scope, alias, clauseEnd,
          runtimeOffset(node.endIndex, 0.5, runtimeWindow),
        );
      }
    } else if (node.type === 'case_clause') {
      const pattern = node.namedChildren.find((child) => child?.type === 'case_pattern');
      if (pattern) {
        for (const name of new Set(matchCaptureNames(pattern))) {
          markLocal(scope, name);
          markBranchTarget(scope, { kind: 'name', name });
          const effect = bindingEffectScope(scope, name);
          operations.push({
            kind: 'invalidate', scope: effect.scope, overlay: effect.overlay, name,
            position: runtimePosition(pattern.endIndex, runtimeWindow),
          });
        }
      }
    }
    for (const child of node.namedChildren) if (child) visit(child, scope, runtimeWindow);
  };
  visit(root, rootScope);
  const context: BindingContext = {
    root: rootScope, scopeByNode, evaluationPositions, nonExecutingNodes, memberEvents,
    unstableNames: hazards.unstableNames, deferredUnstableNames: hazards.deferredUnstableNames,
    unstableMembers: hazards.unstableMembers,
  };
  operations.sort((left, right) => left.position - right.position);
  for (const operation of operations) {
    if (operation.kind === 'known') {
      const addEvent = operation.overlay === true ? addOverlayEvent : addBindingEvent;
      addEvent(operation.scope, operation.name, {
        position: operation.position, value: operation.value, exists: true,
      });
    } else if (operation.kind === 'invalidate') {
      const addEvent = operation.overlay === true ? addOverlayEvent : addBindingEvent;
      addEvent(operation.scope, operation.name, {
        position: operation.position, value: null, exists: true,
      });
    } else if (operation.kind === 'delete') {
      const addEvent = operation.overlay === true ? addOverlayEvent : addBindingEvent;
      addEvent(operation.scope, operation.name, {
        position: operation.position, value: null, exists: false,
      });
    } else if (operation.kind === 'assignment') {
      let value: Binding | null = null;
      const right = operation.right === null ? null : unwrapExpression(operation.right);
      if (right?.type === 'call') {
        value = constructorBinding(
          right, operation.evaluationScope, context, operation.receiverId, operation.evaluationPosition,
        );
      }
      else if (right?.type === 'identifier') {
        value = bindingAt(context, operation.evaluationScope, right.text, operation.evaluationPosition);
      }
      const addEvent = operation.overlay === true ? addOverlayEvent : addBindingEvent;
      addEvent(operation.scope, operation.name, {
        position: operation.position, value, exists: true,
      });
    } else if (operation.kind === 'join') {
      const targets = new Map<string, StoreTarget>();
      for (const branch of operation.branches) {
        for (const target of joinTargets.get(branch) ?? []) {
          const key = target.kind === 'name'
            ? `name:${target.name}`
            : `member:${target.receiver}.${target.member}`;
          targets.set(key, target);
        }
      }
      for (const target of targets.values()) {
        markBranchTarget(operation.scope, target);
        if (target.kind === 'member') {
          const receiverIds = new Set(memberEvents.filter((event) =>
            event.member === target.member
            && operation.branches.some((branch) => scopeContains(branch, event.scope)))
            .map((event) => event.receiverId));
          for (const receiverId of receiverIds) {
            memberEvents.push({
              receiverId, member: target.member,
              position: operation.position,
              scope: nearestBranchScope(operation.scope) ?? nearestExecutionScope(operation.scope),
            });
          }
          continue;
        }
        const values = operation.branches.map((branch) =>
          bindingAt(context, branch, target.name, operation.position + 0.000001));
        if (operation.includeParent) {
          values.push(bindingAt(
            context, operation.scope, target.name, operation.parentPosition + 0.000001,
          ));
        }
        const first = values[0] ?? null;
        const exact = first !== null && values.length > 0
          && values.every((value) => value !== null
            && JSON.stringify(value) === JSON.stringify(first))
          ? first
          : null;
        markLocal(operation.scope, target.name);
        const effect = bindingEffectScope(operation.scope, target.name);
        const addEvent = effect.overlay ? addOverlayEvent : addBindingEvent;
        addEvent(effect.scope, target.name, {
          position: operation.position, value: exact, exists: true,
        });
      }
    } else {
      const receiver = bindingAt(context, operation.evaluationScope, operation.receiver, operation.evaluationPosition);
      if (receiver?.kind === 'module' || receiver?.kind === 'instance') {
        const executionScope = nearestBranchScope(operation.effectScope)
          ?? nearestExecutionScope(operation.effectScope);
        memberEvents.push({
          receiverId: receiver.receiverId, member: operation.member,
          position: operation.eventPosition, scope: executionScope,
        });
      }
    }
  }
  const allScopes = new Set([...scopeByNode.values()].flat());
  for (const scope of allScopes) {
    for (const entries of scope.events.values()) entries.sort((left, right) => left.position - right.position);
    for (const entries of scope.overlayEvents.values()) entries.sort((left, right) => left.position - right.position);
  }
  memberEvents.sort((left, right) => left.position - right.position);
  return context;
}

function pushNode(sink: ContractSink, node: ExtractedNode): void {
  if (sink.nodeQNames.has(node.qualifiedName)) return;
  sink.nodeQNames.add(node.qualifiedName);
  sink.nodes.push(node);
}

function pushEdge(sink: ContractSink, edge: ExtractedEdge): void {
  const key = `${edge.from.kind}\u0000${edge.from.qualifiedName}\u0000${edge.relation}\u0000${edge.to.kind}\u0000${edge.to.qualifiedName}`;
  if (sink.edgeKeys.has(key)) return;
  sink.edgeKeys.add(key);
  sink.edges.push(edge);
}

function functionOwner(node: Node, fileQName: string): NodeRef {
  let current: Node | null = node;
  while (current) {
    if (current.type === 'function_definition') {
      const name = current.childForFieldName('name');
      if (name) return { kind: 'function', qualifiedName: `${fileQName}#${name.text}` };
    }
    if (current.type === 'decorator' && current.parent?.type === 'decorated_definition') {
      const definition = current.parent.childForFieldName('definition');
      const name = definition?.type === 'function_definition' ? definition.childForFieldName('name') : null;
      if (name) return { kind: 'function', qualifiedName: `${fileQName}#${name.text}` };
    }
    current = current.parent;
  }
  return { kind: 'file', qualifiedName: fileQName };
}

function extractContracts(root: Node, abs: string, fileQName: string, identity: ServiceIdentity, sink: ContractSink): void {
  const bindings = collectBindings(root);
  const addEndpoint = (owner: NodeRef, call: Node, method: HttpMethod, rawPath: string): void => {
    const route = normalizeRoutePath(rawPath);
    if (route === null) return;
    const qn = endpointQName(identity.id, method, route);
    pushNode(sink, {
      kind: 'endpoint', name: `${method} ${route}`, qualifiedName: qn,
      line: call.startPosition.row + 1, lang: 'python',
      metadata: { contract: 'http-endpoint-v1', service_id: identity.id, service_aliases: identity.aliases, method, path: route },
    });
    pushEdge(sink, { from: owner, to: { kind: 'endpoint', qualifiedName: qn }, relation: 'serves_route' });
  };
  const addHttpCall = (
    owner: NodeRef,
    call: Node,
    urlNode: Node | undefined,
    methodNode: Node | undefined,
    fixedMethod: HttpMethod | null,
    keywordExpansion: boolean,
    classify: (node: Node | null | undefined) => StringExpressionClassification = classifyStringExpression,
  ): void => {
    const urlInput = classify(urlNode);
    if (urlInput.kind !== 'decoded') {
      if (urlInput.kind === 'dynamic' || (urlInput.kind === 'absent' && keywordExpansion)) {
        sink.skips.dynamic_http_url++;
      }
      return;
    }
    const parsed = parseLiteralHttpUrl(urlInput.value);
    if (parsed === null) return;
    let method = fixedMethod;
    if (method === null) {
      const methodInput = classify(methodNode);
      if (methodInput.kind === 'absent') {
        if (keywordExpansion) sink.skips.dynamic_http_method++;
        return;
      }
      if (methodInput.kind !== 'decoded') {
        if (methodInput.kind === 'dynamic') sink.skips.dynamic_http_method++;
        return;
      }
      const normalized = normalizeHttpMethod(methodInput.value);
      if (normalized === null || normalized === 'ANY') return;
      method = normalized;
    }
    const line = call.startPosition.row + 1;
    const column = call.startPosition.column + 1;
    const qn = httpCallQName(identity.id, fileQName, line, column);
    pushNode(sink, {
      kind: 'http_call', name: `${method} ${parsed.host}${parsed.methodPath}`,
      qualifiedName: qn, filePath: abs, line, lang: 'python',
      metadata: { contract: 'http-call-v1', source_service: identity.id, target_host: parsed.host, method, path: parsed.methodPath },
    });
    pushEdge(sink, { from: owner, to: { kind: 'http_call', qualifiedName: qn }, relation: 'defines' });
  };
  const addEvent = (
    owner: NodeRef,
    relation: 'emits' | 'listens_on',
    transport: 'kafka' | 'celery',
    channelNode: Node | undefined,
    keywordExpansion = false,
    classify: (node: Node | null | undefined) => StringExpressionClassification = classifyStringExpression,
  ): void => {
    const channelInput = classify(channelNode);
    if (channelInput.kind !== 'decoded') {
      if (channelInput.kind === 'dynamic' || (channelInput.kind === 'absent' && keywordExpansion)) {
        sink.skips.dynamic_event_channel++;
      }
      return;
    }
    const channel = channelInput.value;
    const qn = eventChannelQName(transport, channel);
    if (qn === null) return;
    pushNode(sink, { kind: 'event_channel', name: channel, qualifiedName: qn });
    pushEdge(sink, { from: owner, to: { kind: 'event_channel', qualifiedName: qn }, relation });
  };
  const processCallAt = (
    call: Node,
    decorator: boolean,
    scope: LexicalScope,
    evaluationPosition: number,
  ): void => {
    const parts = calleeParts(call);
    if (parts === null) return;
    const args = callArguments(call);
    const classifyAt = (input: Node | null | undefined): StringExpressionClassification =>
      classifyStringExpression(input);
    const owner = functionOwner(call, fileQName);
    const direct = parts.receiver === null ? bindingAt(bindings, scope, parts.member, evaluationPosition) : null;
    const receiver = parts.receiver?.type === 'identifier'
      ? bindingAt(bindings, scope, parts.receiver.text, evaluationPosition)
      : null;
    if (receiver !== null && !memberIsLive(bindings, scope, receiver, parts.member, evaluationPosition)) return;

    if (decorator && receiver?.kind === 'instance'
      && (receiver.capability === 'fastapi_app' || receiver.capability === 'fastapi_router')
      && HTTP_VERBS.has(parts.member)) {
      const routeNode = args.positional[0] ?? args.keywords.get('path');
      const routeInput = classifyAt(routeNode);
      if (routeInput.kind !== 'decoded') {
        if (routeInput.kind === 'dynamic' || (routeInput.kind === 'absent' && args.keywordExpansion)) {
          sink.skips.dynamic_http_route++;
        }
        return;
      }
      if (receiver.unsupportedPrefix === true) return;
      if (receiver.dynamicPrefix === true) { sink.skips.dynamic_http_route++; return; }
      const method = normalizeHttpMethod(parts.member);
      if (method !== null && method !== 'ANY') addEndpoint(owner, call, method, `${receiver.prefix ?? ''}${routeInput.value}`);
      return;
    }
    if (decorator && receiver?.kind === 'instance' && receiver.capability === 'flask_app' && parts.member === 'route') {
      const routeNode = args.positional[0] ?? args.keywords.get('rule');
      const routeInput = classifyAt(routeNode);
      if (routeInput.kind !== 'decoded') {
        if (routeInput.kind === 'dynamic' || (routeInput.kind === 'absent' && args.keywordExpansion)) {
          sink.skips.dynamic_http_route++;
        }
        return;
      }
      const route = normalizeRoutePath(routeInput.value);
      if (route === null) return;
      const rawMethodsNode = args.keywords.get('methods');
      if (rawMethodsNode === undefined) {
        if (args.keywordExpansion) sink.skips.dynamic_http_method++;
        else addEndpoint(owner, call, 'GET', route);
        return;
      }
      const methodsNode = unwrapExpression(rawMethodsNode);
      if (methodsNode.type !== 'list' && methodsNode.type !== 'tuple') {
        if (classifyAt(methodsNode).kind === 'dynamic') sink.skips.dynamic_http_method++;
        return;
      }
      const methodNodes = methodsNode.namedChildren.filter((child) => child !== null);
      const methodInputs = methodNodes.map((child) => classifyAt(child));
      if (methodInputs.some((method) => method.kind !== 'decoded')) {
        if (methodInputs.some((method) => method.kind === 'dynamic')) sink.skips.dynamic_http_method++;
        return;
      }
      for (const methodInput of methodInputs) {
        if (methodInput.kind !== 'decoded') continue;
        const method = normalizeHttpMethod(methodInput.value);
        if (method !== null && method !== 'ANY') addEndpoint(owner, call, method, route);
      }
      return;
    }
    if (decorator && receiver?.kind === 'instance' && receiver.capability === 'celery_app' && parts.member === 'task') {
      addEvent(owner, 'listens_on', 'celery', args.keywords.get('name'), args.keywordExpansion, classifyAt);
      return;
    }

    let httpLibrary: HttpLibrary | null = null;
    let httpMethod = parts.member;
    if (direct?.kind === 'http_function') { httpLibrary = direct.library; httpMethod = direct.method; }
    else if (receiver?.kind === 'module'
      && (receiver.module === 'requests' || receiver.module === 'httpx'
        || (receiver.module === 'aiohttp' && parts.member === 'request'))) httpLibrary = receiver.module;
    else if (receiver?.kind === 'instance' && receiver.capability === 'http_client' && receiver.library) httpLibrary = receiver.library;
    if (httpLibrary !== null && (HTTP_VERBS.has(httpMethod) || httpMethod === 'request')) {
      if (httpMethod === 'request') {
        addHttpCall(
          owner, call, args.keywords.get('url') ?? args.positional[1],
          args.keywords.get('method') ?? args.positional[0], null, args.keywordExpansion, classifyAt,
        );
      }
      else {
        const method = normalizeHttpMethod(httpMethod);
        if (method !== null && method !== 'ANY') {
          addHttpCall(owner, call, args.keywords.get('url') ?? args.positional[0], undefined, method, args.keywordExpansion, classifyAt);
        }
      }
      return;
    }
    if (receiver?.kind === 'instance' && receiver.capability === 'celery_app' && parts.member === 'send_task') {
      addEvent(owner, 'emits', 'celery', args.keywords.get('name') ?? args.positional[0], args.keywordExpansion, classifyAt); return;
    }
    if (receiver?.kind === 'instance' && receiver.capability === 'kafka_producer' && (parts.member === 'send' || parts.member === 'produce')) {
      addEvent(owner, 'emits', 'kafka', args.keywords.get('topic') ?? args.positional[0], args.keywordExpansion, classifyAt); return;
    }
    if (receiver?.kind === 'instance' && receiver.capability === 'kafka_consumer' && parts.member === 'subscribe') {
      const rawTopics = args.keywords.get('topics') ?? args.positional[0];
      const topics = rawTopics === undefined ? null : unwrapExpression(rawTopics);
      if (!topics) {
        if (args.keywordExpansion) sink.skips.dynamic_event_channel++;
        return;
      }
      if (topics.type !== 'list' && topics.type !== 'tuple') {
        if (classifyAt(topics).kind === 'dynamic') sink.skips.dynamic_event_channel++;
        return;
      }
      const topicNodes = topics.namedChildren.filter((child) => child !== null);
      const topicInputs = topicNodes.map((topic) => classifyAt(topic));
      if (topicInputs.some((topic) => topic.kind !== 'decoded')) {
        if (topicInputs.some((topic) => topic.kind === 'dynamic')) sink.skips.dynamic_event_channel++;
        return;
      }
      for (const topic of topicNodes) addEvent(owner, 'listens_on', 'kafka', topic, false, classifyAt);
      return;
    }
    const constructor = parts.receiver === null
      ? direct
      : (receiver === null ? null : memberBinding(bindings, scope, receiver, parts.member, evaluationPosition));
    if (constructor?.kind === 'constructor' && constructor.capability === 'kafka_consumer' && args.positional.length > 0) {
      const topicInputs = args.positional.map((topic) => classifyAt(topic));
      if (topicInputs.some((topic) => topic.kind !== 'decoded')) {
        if (topicInputs.some((topic) => topic.kind === 'dynamic')) sink.skips.dynamic_event_channel++;
        return;
      }
      for (const topic of args.positional) addEvent(owner, 'listens_on', 'kafka', topic, false, classifyAt);
    }
  };
  const processCall = (call: Node, decorator: boolean): void => {
    const scopes = bindings.scopeByNode.get(nodeKey(call)) ?? [bindings.root];
    const positions = bindings.evaluationPositions.get(nodeKey(call)) ?? [call.startIndex];
    const baseline = { ...sink.skips };
    const rejected = emptyContractSkips();
    for (const [index, scope] of scopes.entries()) {
      Object.assign(sink.skips, baseline);
      processCallAt(call, decorator, scope, positions[index] ?? positions.at(-1) ?? call.startIndex);
      if (sink.skips.dynamic_http_url > baseline.dynamic_http_url) rejected.dynamic_http_url = 1;
      if (sink.skips.dynamic_http_method > baseline.dynamic_http_method) rejected.dynamic_http_method = 1;
      if (sink.skips.dynamic_http_route > baseline.dynamic_http_route) rejected.dynamic_http_route = 1;
      if (sink.skips.dynamic_event_channel > baseline.dynamic_event_channel) rejected.dynamic_event_channel = 1;
    }
    sink.skips.dynamic_http_url = baseline.dynamic_http_url + rejected.dynamic_http_url;
    sink.skips.dynamic_http_method = baseline.dynamic_http_method + rejected.dynamic_http_method;
    sink.skips.dynamic_http_route = baseline.dynamic_http_route + rejected.dynamic_http_route;
    sink.skips.dynamic_event_channel = baseline.dynamic_event_channel + rejected.dynamic_event_channel;
  };
  const visit = (node: Node): void => {
    if (bindings.nonExecutingNodes.has(nodeKey(node))) return;
    if (node.type === 'decorator') {
      const rawExpression = node.namedChild(0);
      const expression = rawExpression === null ? null : unwrapExpression(rawExpression);
      if (expression?.type === 'call') {
        processCall(expression, true);
        for (const child of expression.namedChildren) if (child) visit(child);
      } else if (expression) visit(expression);
      return;
    }
    if (node.type === 'call') processCall(node, false);
    for (const child of node.namedChildren) if (child) visit(child);
  };
  visit(root);
}

export const pythonExtractor: GraphExtractor = {
  name: 'python',
  vocabulary: {
    kinds: ['file', 'function', 'class', 'endpoint', 'http_call', 'event_channel'],
    relations: ['imports', 'defines', 'calls', 'serves_route', 'emits', 'listens_on'],
  },
  async extract({ repoPaths, changedFiles, excludes }): Promise<ExtractorOutput> {
    const nodes: ExtractedNode[] = [];
    const edges: ExtractedEdge[] = [];
    const contractSkips = emptyContractSkips();
    const contractSink: ContractSink = { nodes, edges, skips: contractSkips, nodeQNames: new Set(), edgeKeys: new Set() };
    const resolvedRepos = canonicalRegisteredRoots(repoPaths, { baseDir: process.cwd(), rejectRelative: true });
    const identities = new Map(resolvedRepos.map((repo) => [repo, serviceIdentity(repo)]));
    const changed = changedFiles ? new Set(changedFiles.map((p) => path.resolve(p))) : null;
    const parser = await parserFor('python');
    const lang = await loadLanguage('python');
    const query = new Query(lang, QUERY_SRC);

    for (const repo of resolvedRepos) {
      const identity = identities.get(repo) ?? serviceIdentity(repo);
      const repoBase = path.basename(repo);
      const sourceBase = serviceSourceQName(identity.id, repoBase);
      const files = listOwnedRepoFiles(repo, resolvedRepos, PY_EXT, excludes ?? []);
      for (const abs of files) {
        if (changed && !changed.has(path.resolve(abs))) continue;
        let text: string;
        try { text = fs.readFileSync(abs, 'utf8'); } catch { continue; }
        const qn = `${sourceBase}/${path.relative(repo, abs).split(path.sep).join('/')}`;
        const fileRef: NodeRef = { kind: 'file', qualifiedName: qn };
        nodes.push({ kind: 'file', name: path.basename(abs), qualifiedName: qn, filePath: abs, lang: 'python', contentHash: hashContent(text), metadata: MAIN_RE.test(text) ? { entrypoint: true } : {} });
        const tree = parser.parse(text);
        if (!tree) continue;
        const callNames = new Set<string>();
        for (const cap of query.captures(tree.rootNode)) {
          const line = cap.node.startPosition.row + 1;
          switch (cap.name) {
            case 'mod':
            case 'from': {
              const lexicalTarget = resolveModule(cap.node.text, repo);
              const targetPath = lexicalTarget === null ? null : canonicalPhysicalPath(lexicalTarget, repo);
              const targetOwner = targetPath === null ? null : owningRegisteredRepo(targetPath, resolvedRepos);
              const targetIdentity = targetOwner === null ? undefined : identities.get(targetOwner);
              const legacyTarget = targetPath === null || targetOwner === null ? null : `${path.basename(targetOwner)}/${path.relative(targetOwner, targetPath).split(path.sep).join('/')}`;
              const target = legacyTarget === null || targetIdentity === undefined ? null : serviceSourceQName(targetIdentity.id, legacyTarget);
              if (target && target !== qn) edges.push({ from: fileRef, to: { kind: 'file', qualifiedName: target }, relation: 'imports' });
              break;
            }
            case 'fn':
            case 'cls': {
              const kind = cap.name === 'fn' ? 'function' : 'class';
              const declQn = `${qn}#${cap.node.text}`;
              nodes.push({ kind, name: cap.node.text, qualifiedName: declQn, filePath: abs, line, lang: 'python' });
              edges.push({ from: fileRef, to: { kind, qualifiedName: declQn }, relation: 'defines' });
              break;
            }
            case 'call': callNames.add(cap.node.text); break;
          }
        }
        for (const name of callNames) edges.push({ from: fileRef, to: { kind: 'function', qualifiedName: `${qn}#${name}` }, relation: 'calls', confidence: 'inferred' });
        extractContracts(tree.rootNode, abs, qn, identity, contractSink);
      }
    }
    return { nodes, edges, contractSkips };
  },
};
