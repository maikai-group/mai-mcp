// mai-graph TypeScript/JS extractor (spec §3.1) — the TypeScript compiler API,
// NOT tree-sitter: accuracy is the entire game for the primary language.
// Emits file/function/class/component/endpoint nodes; imports/exports/defines/
// serves_route/references_table edges. Detectors (Fastify-style routes,
// Supabase .from(), SQL-in-literals, Expo Router) are syntactic heuristics —
// SQL-literal table refs are marked confidence 'inferred'. Local-only, no LLM.
import ts from 'typescript';
import fs from 'node:fs';
import path from 'node:path';
import { hashContent } from '../engine.js';
import { canonicalRegisteredRoots } from '../roots.js';
import {
  endpointQName,
  eventChannelQName,
  httpCallQName,
  normalizeHttpMethod,
  normalizeRoutePath,
  owningRegisteredRepo,
  parseLiteralHttpUrl,
  serviceIdentity,
  sourceQNameForPath,
  type HttpMethod,
  type ServiceIdentity,
} from '../contracts.js';
import { listOwnedRepoFiles } from '../walk.js';
import type {
  ContractSkipTallies,
  ExtractedEdge,
  ExtractedNode,
  ExtractorOutput,
  GraphExtractor,
  NodeRef,
} from '../types.js';

export const SOURCE_EXT = new Set(['.ts', '.tsx', '.js', '.jsx']);
const HTTP_METHODS = new Set(['get', 'post', 'put', 'delete', 'patch', 'options', 'head', 'all']);
const LOCAL_ROUTER_TYPE_NAMES = new Set(['AppLike', 'RouterLike']);
const LOCAL_ROUTER_VARIABLE_NAMES = new Set(['app', 'router']);
const ROUTER_IMPORTED_TYPE_NAMES = new Set(['Application', 'Express', 'Router', 'FastifyInstance']);
const ROUTER_FACTORY_MEMBERS = new Set(['Router', 'fastify', 'Fastify']);
// Existing provider registrations are syntactic; known client-shaped receivers
// remain excluded unless exact axios provenance above has already handled them.
const CLIENT_RECEIVERS = new Set(['axios', 'client', 'http', 'https', 'fetcher', 'api']);
const SQL_VERB = /\b(select|insert\s+into|update|delete\s+from)\b/i;
const SQL_TABLE = /\b(?:from|join|into|update)\s+"?([a-z_][a-z0-9_.]*)"?/gi;
const SQL_NOISE = new Set([
  'select', 'where', 'set', 'values', 'and', 'or', 'not', 'null', 'order', 'group',
  'by', 'limit', 'offset', 'returning', 'as', 'left', 'right', 'inner', 'outer',
  'join', 'on', 'lateral', 'unnest', 'distinct', 'case', 'when', 'then', 'else',
  'end', 'exists', 'in', 'is', 'using', 'conflict', 'nothing', 'excluded', 'only',
]);

/** Program from the repo's own tsconfig (extends/paths/monorepo refs resolved by
 * parseJsonConfigFileContent), with its file list filtered to the canonical
 * enumeration (`allowed`); falls back to the allowed set directly for
 * config-less repos. Empty intersection falls through to the bare scan. */
function buildProgram(repoPath: string, allowed: ReadonlySet<string>): ts.Program | null {
  const configPath = ts.findConfigFile(repoPath, ts.sys.fileExists, 'tsconfig.json');
  if (configPath && path.resolve(configPath).startsWith(repoPath + path.sep)) {
    const cfg = ts.readConfigFile(configPath, ts.sys.readFile);
    if (cfg.config) {
      const parsed = ts.parseJsonConfigFileContent(cfg.config, ts.sys, path.dirname(configPath));
      const rootNames = parsed.fileNames.filter((f) => allowed.has(path.resolve(f)));
      if (rootNames.length > 0) {
        return ts.createProgram(rootNames, { ...parsed.options, noEmit: true });
      }
    }
  }
  if (allowed.size === 0) return null;
  return ts.createProgram([...allowed], {
    allowJs: true,
    jsx: ts.JsxEmit.Preserve,
    noEmit: true,
    target: ts.ScriptTarget.ES2022,
    module: ts.ModuleKind.ESNext,
    moduleResolution: ts.ModuleResolutionKind.Bundler,
  });
}

function isExported(stmt: ts.Statement): boolean {
  if (!ts.canHaveModifiers(stmt)) return false;
  return (ts.getModifiers(stmt) ?? []).some((m) => m.kind === ts.SyntaxKind.ExportKeyword);
}

interface Sink {
  nodes: ExtractedNode[];
  edges: ExtractedEdge[];
  contractSkips: ContractSkipTallies;
}

function emptyContractSkips(): ContractSkipTallies {
  return {
    dynamic_http_url: 0,
    dynamic_http_method: 0,
    dynamic_http_route: 0,
    dynamic_event_channel: 0,
  };
}

function literalText(node: ts.Expression | undefined): string | null {
  if (node === undefined) return null;
  if (ts.isStringLiteralLike(node)) return node.text;
  if (ts.isNoSubstitutionTemplateLiteral(node)) return node.text;
  return null;
}

function literalPropertyKeyText(node: ts.Expression | undefined): string | undefined {
  if (node === undefined) return undefined;
  if (ts.isStringLiteralLike(node) || ts.isNumericLiteral(node)) return node.text;
  return undefined;
}

function unwrapTransparentExpression(expression: ts.Expression): ts.Expression {
  let current = expression;
  while (ts.isParenthesizedExpression(current)
    || ts.isAsExpression(current)
    || ts.isTypeAssertionExpression(current)
    || ts.isNonNullExpression(current)
    || ts.isSatisfiesExpression(current)) {
    current = current.expression;
  }
  return current;
}

function staticPropertyNameText(name: ts.PropertyName): string | undefined {
  if (ts.isIdentifier(name) || ts.isStringLiteralLike(name) || ts.isNumericLiteral(name)) return name.text;
  if (ts.isComputedPropertyName(name)) return literalPropertyKeyText(name.expression);
  return undefined;
}

interface ObjectPropertyRead {
  present: boolean;
  value?: ts.Expression;
}

function objectProperty(object: ts.ObjectLiteralExpression, key: string): ObjectPropertyRead {
  let result: ObjectPropertyRead = { present: false };
  for (const property of object.properties) {
    if (ts.isSpreadAssignment(property)) {
      result = { present: true };
      continue;
    }
    const name = property.name;
    if (name === undefined) continue;
    const staticName = staticPropertyNameText(name);
    if (staticName === undefined) {
      result = { present: true };
      continue;
    }
    if (staticName !== key) continue;
    if (ts.isShorthandPropertyAssignment(property)) result = { present: true, value: property.name };
    else if (ts.isPropertyAssignment(property)) result = { present: true, value: property.initializer };
    else {
      result = { present: true };
    }
  }
  return result;
}

function objectPropertyExpression(read: ObjectPropertyRead, unknown: ts.Expression): ts.Expression | undefined {
  if (!read.present) return undefined;
  return read.value ?? unknown;
}

function sourceBindings(sf: ts.SourceFile, checker: ts.TypeChecker): {
  axios: Set<ts.Symbol>;
  kafkaClasses: Set<ts.Symbol>;
  kafkaNamespaces: Set<ts.Symbol>;
  routerFactories: Set<ts.Symbol>;
  routerNamespaces: Set<ts.Symbol>;
  routerTypes: Set<ts.Symbol>;
} {
  const axios = new Set<ts.Symbol>();
  const kafkaClasses = new Set<ts.Symbol>();
  const kafkaNamespaces = new Set<ts.Symbol>();
  const routerFactories = new Set<ts.Symbol>();
  const routerNamespaces = new Set<ts.Symbol>();
  const routerTypes = new Set<ts.Symbol>();
  const addSymbol = (target: Set<ts.Symbol>, identifier: ts.Identifier): void => {
    const symbol = checker.getSymbolAtLocation(identifier);
    if (symbol !== undefined) target.add(symbol);
  };
  const visit = (node: ts.Node): void => {
    if (ts.isImportDeclaration(node) && ts.isStringLiteralLike(node.moduleSpecifier)) {
      const moduleName = node.moduleSpecifier.text;
      const clause = node.importClause;
      if (moduleName === 'axios' && clause) {
        if (clause.name) addSymbol(axios, clause.name);
        if (clause.namedBindings && ts.isNamespaceImport(clause.namedBindings)) addSymbol(axios, clause.namedBindings.name);
        else if (clause.namedBindings) {
          for (const element of clause.namedBindings.elements) {
            if ((element.propertyName?.text ?? element.name.text) === 'default') addSymbol(axios, element.name);
          }
        }
      }
      if (moduleName === 'kafkajs' && clause?.namedBindings) {
        if (ts.isNamespaceImport(clause.namedBindings)) addSymbol(kafkaNamespaces, clause.namedBindings.name);
        else for (const element of clause.namedBindings.elements) {
          if ((element.propertyName?.text ?? element.name.text) === 'Kafka') addSymbol(kafkaClasses, element.name);
        }
      }
      if ((moduleName === 'express' || moduleName === 'fastify') && clause) {
        if (clause.name) addSymbol(routerFactories, clause.name);
        if (clause.namedBindings && ts.isNamespaceImport(clause.namedBindings)) {
          addSymbol(routerNamespaces, clause.namedBindings.name);
        } else if (clause.namedBindings) {
          for (const element of clause.namedBindings.elements) {
            const imported = element.propertyName?.text ?? element.name.text;
            if (ROUTER_FACTORY_MEMBERS.has(imported) || imported === 'express') {
              addSymbol(routerFactories, element.name);
            }
            if (ROUTER_IMPORTED_TYPE_NAMES.has(imported)) addSymbol(routerTypes, element.name);
          }
        }
      }
    }
    if (ts.isImportEqualsDeclaration(node)
      && ts.isExternalModuleReference(node.moduleReference)
      && node.moduleReference.expression !== undefined
      && ts.isStringLiteralLike(node.moduleReference.expression)
      && (node.moduleReference.expression.text === 'express' || node.moduleReference.expression.text === 'fastify')) {
      addSymbol(routerFactories, node.name);
    }
    if (ts.isVariableDeclaration(node) && node.initializer && ts.isCallExpression(node.initializer)
      && ts.isIdentifier(node.initializer.expression) && node.initializer.expression.text === 'require'
      && node.initializer.arguments.length === 1 && ts.isStringLiteralLike(node.initializer.arguments[0])
      && (node.initializer.arguments[0].text === 'express' || node.initializer.arguments[0].text === 'fastify')) {
      const requireSymbol = checker.getSymbolAtLocation(node.initializer.expression);
      const supportedRequire = requireSymbol === undefined
        || (requireSymbol.declarations ?? []).every((declaration) => declaration.getSourceFile() !== sf);
      if (supportedRequire) {
        if (ts.isIdentifier(node.name)) addSymbol(routerFactories, node.name);
        else if (ts.isObjectBindingPattern(node.name)) {
          for (const element of node.name.elements) {
            if (!ts.isIdentifier(element.name)) continue;
            const imported = element.propertyName !== undefined && ts.isIdentifier(element.propertyName)
              ? element.propertyName.text
              : element.name.text;
            if (ROUTER_FACTORY_MEMBERS.has(imported) || imported === 'express') {
              addSymbol(routerFactories, element.name);
            }
          }
        }
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
  return { axios, kafkaClasses, kafkaNamespaces, routerFactories, routerNamespaces, routerTypes };
}

function extractFile(
  sf: ts.SourceFile,
  abs: string,
  fileQName: string,
  identity: ServiceIdentity,
  options: ts.CompilerOptions,
  checker: ts.TypeChecker,
  qnameOf: (absPath: string) => string | null,
  sink: Sink
): void {
  const ext = path.extname(abs);
  const isJsxFile = ext === '.tsx' || ext === '.jsx';
  const lang = ext === '.ts' || ext === '.tsx' ? 'typescript' : 'javascript';
  const fileRef: NodeRef = { kind: 'file', qualifiedName: fileQName };
  const lineOf = (node: ts.Node): number => sf.getLineAndCharacterOfPosition(node.getStart(sf)).line + 1;
  const positionOf = (node: ts.Node): { line: number; column: number } => {
    const point = sf.getLineAndCharacterOfPosition(node.getStart(sf));
    return { line: point.line + 1, column: point.character + 1 };
  };
  const bindings = sourceBindings(sf, checker);
  const kafkaRoots = new Set<ts.Symbol>();
  const kafkaProducers = new Set<ts.Symbol>();
  const kafkaConsumers = new Set<ts.Symbol>();
  const routerReceivers = new Set<ts.Symbol>();
  const symbolOf = (identifier: ts.Identifier): ts.Symbol | undefined => checker.getSymbolAtLocation(identifier);
  const symbolsEquivalent = (left: ts.Symbol, right: ts.Symbol): boolean => {
    if (left === right) return true;
    const leftDeclarations = left.declarations ?? [];
    const rightDeclarations = right.declarations ?? [];
    return leftDeclarations.some((declaration) => rightDeclarations.includes(declaration));
  };
  const symbolSetHas = (symbols: ReadonlySet<ts.Symbol>, symbol: ts.Symbol): boolean => {
    return [...symbols].some((candidate) => symbolsEquivalent(candidate, symbol));
  };
  const symbolOfExpression = (expression: ts.Expression): ts.Symbol | undefined => {
    const unwrapped = unwrapTransparentExpression(expression);
    if (ts.isIdentifier(unwrapped)) return symbolOf(unwrapped);
    if (ts.isPropertyAccessExpression(unwrapped)) return checker.getSymbolAtLocation(unwrapped.name);
    if (ts.isElementAccessExpression(unwrapped)) {
      const key = literalPropertyKeyText(unwrapped.argumentExpression);
      return key === undefined ? undefined : checker.getTypeAtLocation(unwrapped.expression).getProperty(key);
    }
    return undefined;
  };
  const hasSymbol = (symbols: ReadonlySet<ts.Symbol>, identifier: ts.Identifier): boolean => {
    const symbol = symbolOf(identifier);
    return symbol !== undefined && symbols.has(symbol);
  };
  const reassignments: Array<{ symbol: ts.Symbol; position: number }> = [];
  const recordReassignment = (symbol: ts.Symbol, position: number): void => {
    reassignments.push({ symbol, position });
  };
  const symbolWasReassignedBefore = (symbol: ts.Symbol, position: number): boolean => {
    return reassignments.some((entry) => entry.position < position && symbolsEquivalent(entry.symbol, symbol));
  };
  const identifierWasReassignedBefore = (identifier: ts.Identifier, position: number): boolean => {
    const symbol = symbolOf(identifier);
    return symbol !== undefined && symbolWasReassignedBefore(symbol, position);
  };
  interface AccessPath {
    root: ts.Symbol;
    members: string[];
    versions: number[];
  }
  interface AccessAlias extends AccessPath {
    position: number;
  }
  type RuntimeCapability = 'router' | 'kafka_root' | 'kafka_producer' | 'kafka_consumer';
  interface RuntimeCapabilityValue {
    capability: RuntimeCapability;
    sourcePath?: AccessPath;
  }
  const accessAliases: Array<AccessAlias & { symbol: ts.Symbol }> = [];
  const accessValueAliases: Array<{ target: AccessPath; source: AccessPath; position: number }> = [];
  const accessReplacements: Array<{ container: AccessPath; property: string; position: number }> = [];
  const invalidatedAccessPaths: Array<AccessPath & { dynamic: boolean; position: number }> = [];
  const restoredAccessPaths: Array<AccessPath & { position: number }> = [];
  const runtimeCapabilities: Array<AccessPath & { capability: RuntimeCapability; position: number }> = [];
  const sameAccessIdentity = (left: AccessPath, right: AccessPath): boolean => {
    return symbolsEquivalent(left.root, right.root)
      && left.members.length === right.members.length
      && left.members.every((member, index) => right.members[index] === member)
      && left.versions.length === right.versions.length
      && left.versions.every((version, index) => right.versions[index] === version);
  };
  const extendAccessPath = (base: AccessPath, member: string, position: number): AccessPath => {
    const version = accessReplacements.filter((entry) => entry.position < position
      && entry.property === member
      && sameAccessIdentity(entry.container, base)).length;
    return {
      root: base.root,
      members: [...base.members, member],
      versions: [...base.versions, version],
    };
  };
  const resolveAccessValueAlias = (pathValue: AccessPath, position: number): AccessPath => {
    let current = pathValue;
    const seen = new Set<AccessPath>();
    for (;;) {
      let latest: { source: AccessPath; position: number } | undefined;
      for (const alias of accessValueAliases) {
        if (alias.position > position || !sameAccessIdentity(alias.target, current)) continue;
        if (latest === undefined || alias.position >= latest.position) latest = alias;
      }
      if (latest === undefined) return current;
      if (seen.has(latest.source)) return current;
      seen.add(latest.source);
      current = latest.source;
    }
  };
  const accessAliasOf = (symbol: ts.Symbol, position: number): AccessPath | undefined => {
    let latest: AccessAlias | undefined;
    for (const alias of accessAliases) {
      if (!symbolsEquivalent(alias.symbol, symbol) || alias.position > position) continue;
      if (latest !== undefined && latest.position > alias.position) continue;
      const detached = reassignments.some((entry) => entry.position > alias.position
        && entry.position < position
        && symbolsEquivalent(entry.symbol, symbol));
      if (!detached) latest = alias;
    }
    return latest;
  };
  const accessPathOf = (expression: ts.Expression, position = expression.getStart(sf)): AccessPath | undefined => {
    const unwrapped = unwrapTransparentExpression(expression);
    if (ts.isIdentifier(unwrapped)) {
      const root = symbolOf(unwrapped);
      if (root === undefined) return undefined;
      const alias = accessAliasOf(root, position);
      const version = reassignments.filter((entry) => entry.position < position
        && symbolsEquivalent(entry.symbol, root)).length;
      return alias === undefined
        ? { root, members: [], versions: [version] }
        : { root: alias.root, members: [...alias.members], versions: [...alias.versions] };
    }
    if (unwrapped.kind === ts.SyntaxKind.ThisKeyword) {
      const root = checker.getTypeAtLocation(unwrapped).getSymbol();
      return root === undefined ? undefined : { root, members: [], versions: [0] };
    }
    if (ts.isPropertyAccessExpression(unwrapped)) {
      const base = accessPathOf(unwrapped.expression, position);
      return base === undefined
        ? undefined
        : resolveAccessValueAlias(extendAccessPath(base, unwrapped.name.text, position), position);
    }
    if (ts.isElementAccessExpression(unwrapped)) {
      const key = literalPropertyKeyText(unwrapped.argumentExpression);
      const base = accessPathOf(unwrapped.expression, position);
      return key === undefined || base === undefined
        ? undefined
        : resolveAccessValueAlias(extendAccessPath(base, key, position), position);
    }
    return undefined;
  };
  const samePathPrefix = <T>(prefix: readonly T[], value: readonly T[]): boolean => {
    return prefix.length <= value.length && prefix.every((member, index) => value[index] === member);
  };
  const recordAccessInvalidation = (
    receiverExpression: ts.Expression,
    property: string | null,
    position: number,
  ): boolean => {
    const receiver = accessPathOf(receiverExpression, position);
    if (receiver === undefined) return false;
    let invalidation: AccessPath & { dynamic: boolean; position: number };
    if (property === null) {
      invalidation = { ...receiver, members: [...receiver.members], versions: [...receiver.versions], dynamic: true, position };
    } else {
      const previous = extendAccessPath(receiver, property, position);
      accessReplacements.push({
        container: { ...receiver, members: [...receiver.members], versions: [...receiver.versions] },
        property,
        position,
      });
      invalidation = {
        ...previous,
        versions: [...previous.versions.slice(0, -1), (previous.versions.at(-1) ?? 0) + 1],
        dynamic: false,
        position,
      };
    }
    if (!invalidatedAccessPaths.some((entry) => sameAccessIdentity(entry, invalidation)
      && entry.dynamic === invalidation.dynamic
      && entry.position === invalidation.position)) {
      invalidatedAccessPaths.push(invalidation);
    }
    return true;
  };
  const recordBindingReplacement = (symbol: ts.Symbol, position: number): void => {
    recordReassignment(symbol, position);
    const version = reassignments.filter((entry) => entry.position <= position
      && symbolsEquivalent(entry.symbol, symbol)).length;
    invalidatedAccessPaths.push({
      root: symbol,
      members: [],
      versions: [version],
      dynamic: true,
      position,
    });
  };
  const accessPathWasInvalidated = (
    base: AccessPath | undefined,
    property?: string,
    position = Number.POSITIVE_INFINITY,
  ): boolean => {
    if (base === undefined) return false;
    const candidate = property === undefined ? base : extendAccessPath(base, property, position);
    return invalidatedAccessPaths.some((entry) => {
      if (entry.position >= position) return false;
      if (restoredAccessPaths.some((restored) => restored.position >= entry.position
        && restored.position < position
        && sameAccessIdentity(restored, entry))) return false;
      if (!symbolsEquivalent(entry.root, candidate.root)
        || !samePathPrefix(entry.members, candidate.members)
        || !samePathPrefix(entry.versions, candidate.versions)) return false;
      return !entry.dynamic || candidate.members.length > entry.members.length;
    });
  };
  const accessWasInvalidated = (
    expression: ts.Expression,
    property?: string,
    position = expression.getStart(sf),
  ): boolean => accessPathWasInvalidated(accessPathOf(expression, position), property, position);
  const setAccessAliasSymbol = (symbol: ts.Symbol, source: AccessPath, position: number): void => {
    accessAliases.push({
      symbol,
      root: source.root,
      members: [...source.members],
      versions: [...source.versions],
      position,
    });
  };
  const setAccessAlias = (name: ts.BindingName, source: AccessPath, position: number): void => {
    if (ts.isIdentifier(name)) {
      const declared = symbolOf(name);
      if (declared !== undefined) setAccessAliasSymbol(declared, source, position);
      return;
    }
    for (let index = 0; index < name.elements.length; index++) {
      const element = name.elements[index];
      if (ts.isOmittedExpression(element) || element.dotDotDotToken !== undefined) continue;
      let member: string | undefined;
      if (ts.isArrayBindingPattern(name)) member = String(index);
      else {
        const property = element.propertyName ?? (ts.isIdentifier(element.name) ? element.name : undefined);
        if (property !== undefined) member = staticPropertyNameText(property);
      }
      if (member === undefined) continue;
      setAccessAlias(element.name, extendAccessPath(source, member, position), position);
    }
  };
  const setAssignmentAccessAliases = (target: ts.Expression, source: AccessPath, position: number): void => {
    const unwrapped = unwrapTransparentExpression(target);
    if (ts.isIdentifier(unwrapped)) {
      setAccessAlias(unwrapped, source, position);
      return;
    }
    if (ts.isArrayLiteralExpression(unwrapped)) {
      for (let index = 0; index < unwrapped.elements.length; index++) {
        const element = unwrapped.elements[index];
        if (ts.isOmittedExpression(element) || ts.isSpreadElement(element)) continue;
        setAssignmentAccessAliases(element, extendAccessPath(source, String(index), position), position);
      }
      return;
    }
    if (!ts.isObjectLiteralExpression(unwrapped)) return;
    for (const property of unwrapped.properties) {
      if (ts.isShorthandPropertyAssignment(property)) {
        const declared = checker.getShorthandAssignmentValueSymbol(property) ?? symbolOf(property.name);
        if (declared !== undefined) setAccessAliasSymbol(
          declared,
          extendAccessPath(source, property.name.text, position),
          position,
        );
      } else if (ts.isPropertyAssignment(property)) {
        const member = staticPropertyNameText(property.name);
        if (member !== undefined) setAssignmentAccessAliases(
          property.initializer,
          extendAccessPath(source, member, position),
          position,
        );
      }
    }
  };
  const setAssignmentAccessValueAlias = (target: ts.Expression, source: AccessPath, position: number): void => {
    const unwrapped = unwrapTransparentExpression(target);
    if (!ts.isPropertyAccessExpression(unwrapped) && !ts.isElementAccessExpression(unwrapped)) return;
    const targetPath = accessPathOf(unwrapped, position + 1);
    if (targetPath === undefined) return;
    accessValueAliases.push({
      target: { ...targetPath, members: [...targetPath.members], versions: [...targetPath.versions] },
      source: { ...source, members: [...source.members], versions: [...source.versions] },
      position,
    });
  };
  const assignmentValueAccessPath = (expression: ts.Expression, position: number): AccessPath | undefined => {
    const unwrapped = unwrapTransparentExpression(expression);
    if (ts.isBinaryExpression(unwrapped) && unwrapped.operatorToken.kind === ts.SyntaxKind.EqualsToken) {
      return assignmentValueAccessPath(unwrapped.right, position);
    }
    return accessPathOf(unwrapped, position);
  };
  const recordAssignmentTarget = (target: ts.Expression, position: number): void => {
    const unwrapped = unwrapTransparentExpression(target);
    if (unwrapped !== target) {
      recordAssignmentTarget(unwrapped, position);
      return;
    }
    if (ts.isIdentifier(target)) {
      const symbol = symbolOf(target);
      if (symbol !== undefined) recordBindingReplacement(symbol, position);
      return;
    }
    if (ts.isPropertyAccessExpression(target)) {
      if (!recordAccessInvalidation(target.expression, target.name.text, position)) {
        const symbol = checker.getSymbolAtLocation(target.name);
        if (symbol !== undefined) recordReassignment(symbol, position);
      }
      return;
    }
    if (ts.isElementAccessExpression(target)) {
      const key = literalPropertyKeyText(target.argumentExpression);
      if (!recordAccessInvalidation(target.expression, key ?? null, position)) {
        const property = symbolOfExpression(target);
        if (property !== undefined) recordReassignment(property, position);
        const container = symbolOfExpression(target.expression);
        if (container !== undefined) recordReassignment(container, position);
      }
      return;
    }
    if (ts.isArrayLiteralExpression(target)) {
      for (const element of target.elements) {
        if (ts.isOmittedExpression(element)) continue;
        recordAssignmentTarget(ts.isSpreadElement(element) ? element.expression : element, position);
      }
      return;
    }
    if (ts.isObjectLiteralExpression(target)) {
      for (const property of target.properties) {
        if (ts.isShorthandPropertyAssignment(property)) {
          const symbol = checker.getShorthandAssignmentValueSymbol(property) ?? symbolOf(property.name);
          if (symbol !== undefined) recordBindingReplacement(symbol, position);
        }
        else if (ts.isPropertyAssignment(property)) recordAssignmentTarget(property.initializer, position);
        else if (ts.isSpreadAssignment(property)) recordAssignmentTarget(property.expression, position);
      }
      return;
    }
    if (ts.isBinaryExpression(target)
      && target.operatorToken.kind >= ts.SyntaxKind.FirstAssignment
      && target.operatorToken.kind <= ts.SyntaxKind.LastAssignment) {
      recordAssignmentTarget(target.left, position);
    }
  };
  const collectReassignments = (node: ts.Node): void => {
    if (ts.isVariableDeclaration(node) && node.initializer !== undefined) {
      const position = node.getEnd();
      const source = assignmentValueAccessPath(node.initializer, node.initializer.getStart(sf));
      if (source !== undefined) setAccessAlias(node.name, source, position);
    }
    if (ts.isBinaryExpression(node)
      && node.operatorToken.kind >= ts.SyntaxKind.FirstAssignment
      && node.operatorToken.kind <= ts.SyntaxKind.LastAssignment) {
      const position = node.getEnd();
      const source = node.operatorToken.kind === ts.SyntaxKind.EqualsToken
        ? assignmentValueAccessPath(node.right, node.right.getStart(sf))
        : undefined;
      recordAssignmentTarget(node.left, position);
      if (source !== undefined) {
        setAssignmentAccessAliases(node.left, source, position);
        setAssignmentAccessValueAlias(node.left, source, position);
      }
    }
    if ((ts.isForInStatement(node) || ts.isForOfStatement(node))
      && !ts.isVariableDeclarationList(node.initializer)) {
      recordAssignmentTarget(node.initializer, node.expression.getEnd());
    }
    if (ts.isDeleteExpression(node)) recordAssignmentTarget(node.expression, node.getEnd());
    if (ts.isPrefixUnaryExpression(node)
      && (node.operator === ts.SyntaxKind.PlusPlusToken || node.operator === ts.SyntaxKind.MinusMinusToken)) {
      recordAssignmentTarget(node.operand, node.getEnd());
    }
    if (ts.isPostfixUnaryExpression(node)) recordAssignmentTarget(node.operand, node.getEnd());
    ts.forEachChild(node, collectReassignments);
  };
  collectReassignments(sf);

  const isKafkaConstructor = (expression: ts.Expression): boolean => {
    if (ts.isIdentifier(expression)) {
      const symbol = symbolOf(expression);
      return symbol !== undefined
        && !symbolWasReassignedBefore(symbol, expression.getStart(sf))
        && bindings.kafkaClasses.has(symbol);
    }
    return ts.isPropertyAccessExpression(expression)
      && ts.isIdentifier(expression.expression)
      && hasSymbol(bindings.kafkaNamespaces, expression.expression)
      && expression.name.text === 'Kafka';
  };
  const isDirectRouterRequire = (expression: ts.Expression): boolean => {
    const unwrapped = unwrapTransparentExpression(expression);
    const required = ts.isCallExpression(unwrapped)
      ? unwrapTransparentExpression(unwrapped.expression)
      : undefined;
    if (!ts.isCallExpression(unwrapped)
      || required === undefined
      || !ts.isIdentifier(required)
      || required.text !== 'require'
      || unwrapped.arguments.length !== 1
      || !ts.isStringLiteralLike(unwrapped.arguments[0])
      || (unwrapped.arguments[0].text !== 'express' && unwrapped.arguments[0].text !== 'fastify')) return false;
    const requireSymbol = symbolOf(required);
    return requireSymbol === undefined
      || (requireSymbol.declarations ?? []).every((declaration) => declaration.getSourceFile() !== sf);
  };
  const isRouterFactoryReceiver = (expression: ts.Expression, position: number): boolean => {
    const unwrapped = unwrapTransparentExpression(expression);
    if (ts.isBinaryExpression(unwrapped) && unwrapped.operatorToken.kind === ts.SyntaxKind.EqualsToken) {
      return isRouterFactoryReceiver(unwrapped.right, position);
    }
    if (isDirectRouterRequire(unwrapped)) return true;
    const receiver = symbolOfExpression(unwrapped);
    return receiver !== undefined
      && !symbolWasReassignedBefore(receiver, position)
      && !accessWasInvalidated(unwrapped, undefined, position)
      && (symbolSetHas(bindings.routerFactories, receiver) || symbolSetHas(bindings.routerNamespaces, receiver));
  };
  const isRouterFactoryCall = (call: ts.CallExpression): boolean => {
    const callee = unwrapTransparentExpression(call.expression);
    if (ts.isIdentifier(callee)) {
      const factory = symbolOf(callee);
      return factory !== undefined
        && !symbolWasReassignedBefore(factory, call.getStart(sf))
        && (symbolSetHas(bindings.routerFactories, factory) || symbolSetHas(bindings.routerNamespaces, factory));
    }
    if (ts.isCallExpression(callee)) return isDirectRouterRequire(callee);
    if (!ts.isPropertyAccessExpression(callee)) return false;
    if (isDirectRouterRequire(callee.expression)) {
      return ROUTER_FACTORY_MEMBERS.has(callee.name.text);
    }
    const receiverPath = assignmentValueAccessPath(callee.expression, call.getStart(sf));
    if (accessPathWasInvalidated(receiverPath, callee.name.text, call.getStart(sf))) return false;
    const propertyFactory = checker.getSymbolAtLocation(callee.name);
    if (propertyFactory !== undefined && !symbolWasReassignedBefore(propertyFactory, call.getStart(sf))
      && symbolSetHas(bindings.routerFactories, propertyFactory)) return true;
    return isRouterFactoryReceiver(callee.expression, call.getStart(sf))
      && ROUTER_FACTORY_MEMBERS.has(callee.name.text);
  };
  const hasImportedRouterType = (type: ts.TypeNode | undefined): boolean => {
    if (type === undefined || !ts.isTypeReferenceNode(type)) return false;
    if (ts.isIdentifier(type.typeName)) {
      const typeSymbol = symbolOf(type.typeName);
      return typeSymbol !== undefined && symbolSetHas(bindings.routerTypes, typeSymbol);
    }
    if (!ts.isIdentifier(type.typeName.left)) return false;
    const namespace = symbolOf(type.typeName.left);
    return namespace !== undefined
      && (symbolSetHas(bindings.routerFactories, namespace) || symbolSetHas(bindings.routerNamespaces, namespace))
      && ROUTER_IMPORTED_TYPE_NAMES.has(type.typeName.right.text);
  };
  type RouterBindingDeclaration = ts.VariableDeclaration | ts.ParameterDeclaration | ts.PropertyDeclaration;
  const hasRouteSignature = (parameters: ts.NodeArray<ts.ParameterDeclaration>): boolean => {
    const first = parameters[0];
    const last = parameters[parameters.length - 1];
    return parameters.length >= 2
      && first !== undefined && ts.isIdentifier(first.name)
      && (first.name.text === 'route' || first.name.text === 'path')
      && (checker.getTypeAtLocation(first).flags & ts.TypeFlags.StringLike) !== 0
      && last !== undefined && ts.isIdentifier(last.name) && last.name.text === 'handler'
      && checker.getTypeAtLocation(last).getCallSignatures().length > 0;
  };
  const hasLocalRouterContract = (declaration: RouterBindingDeclaration): boolean => {
    if (!ts.isIdentifier(declaration.name)
      || !LOCAL_ROUTER_VARIABLE_NAMES.has(declaration.name.text.toLowerCase())
      || declaration.type === undefined
      || !ts.isTypeReferenceNode(declaration.type)
      || !ts.isIdentifier(declaration.type.typeName)
      || !LOCAL_ROUTER_TYPE_NAMES.has(declaration.type.typeName.text)) return false;
    const typeSymbol = symbolOf(declaration.type.typeName);
    return (typeSymbol?.declarations ?? []).some((typeDeclaration) => {
      if (typeDeclaration.getSourceFile() !== sf) return false;
      const members = ts.isInterfaceDeclaration(typeDeclaration)
        ? typeDeclaration.members
        : ts.isTypeAliasDeclaration(typeDeclaration) && ts.isTypeLiteralNode(typeDeclaration.type)
          ? typeDeclaration.type.members
          : undefined;
      return members?.some((member) => {
        if (member.name === undefined || !ts.isIdentifier(member.name) || !HTTP_METHODS.has(member.name.text)) return false;
        if (ts.isMethodSignature(member)) return hasRouteSignature(member.parameters);
        return ts.isPropertySignature(member)
          && member.type !== undefined
          && ts.isFunctionTypeNode(member.type)
          && hasRouteSignature(member.type.parameters);
      });
    });
  };
  let routerBindingsChanged = false;
  const addRouterReceiver = (symbol: ts.Symbol): void => {
    if (symbolSetHas(routerReceivers, symbol)) return;
    routerReceivers.add(symbol);
    routerBindingsChanged = true;
  };
  const addRouterFactory = (symbol: ts.Symbol): void => {
    if (symbolSetHas(bindings.routerFactories, symbol)) return;
    bindings.routerFactories.add(symbol);
    routerBindingsChanged = true;
  };
  const propagateRouterSymbol = (declared: ts.Symbol, source: ts.Symbol, position: number): void => {
    if (symbolWasReassignedBefore(declared, position) || symbolWasReassignedBefore(source, position)) return;
    if (symbolSetHas(routerReceivers, source)) addRouterReceiver(declared);
    if (symbolSetHas(bindings.routerFactories, source) || symbolSetHas(bindings.routerNamespaces, source)) {
      addRouterFactory(declared);
    }
  };
  const propagateRouterInitializer = (declared: ts.Symbol, initializer: ts.Expression): void => {
    const position = initializer.getStart(sf);
    if (symbolWasReassignedBefore(declared, position)) return;
    const unwrapped = unwrapTransparentExpression(initializer);
    if (ts.isCallExpression(unwrapped) && isRouterFactoryCall(unwrapped)) addRouterReceiver(declared);
    const aliased = symbolOfExpression(unwrapped);
    if (aliased !== undefined) {
      const sourcePath = accessPathOf(unwrapped);
      if (sourcePath !== undefined) accessAliases.push({ symbol: declared, ...sourcePath, position });
      propagateRouterSymbol(declared, aliased, position);
    }
  };
  const propertyText = (name: ts.PropertyName): string | undefined => {
    return staticPropertyNameText(name);
  };
  const objectPropertySymbol = (object: ts.ObjectLiteralExpression, name: ts.PropertyName): ts.Symbol | undefined => {
    const text = propertyText(name);
    return text === undefined ? undefined : checker.getTypeAtLocation(object).getProperty(text);
  };
  const resolveImmutableInitializer = (
    expression: ts.Expression,
    seen: ReadonlySet<ts.Symbol> = new Set(),
    position = expression.getStart(sf),
  ): ts.Expression => {
    const unwrapped = unwrapTransparentExpression(expression);
    if (!ts.isIdentifier(unwrapped)) return unwrapped;
    const symbol = symbolOf(unwrapped);
    if (symbol === undefined || symbolWasReassignedBefore(symbol, position) || seen.has(symbol)) return unwrapped;
    const declaration = (symbol.declarations ?? []).find((candidate) => ts.isVariableDeclaration(candidate) && candidate.initializer !== undefined);
    if (declaration === undefined || !ts.isVariableDeclaration(declaration) || declaration.initializer === undefined) return unwrapped;
    const nextSeen = new Set(seen);
    nextSeen.add(symbol);
    return resolveImmutableInitializer(declaration.initializer, nextSeen, position);
  };
  function bindingSourceExpression(element: ts.BindingElement): ts.Expression | undefined {
    const pattern = element.parent;
    const owner = pattern.parent;
    const container = ts.isVariableDeclaration(owner)
      ? owner.initializer
      : ts.isBindingElement(owner)
        ? bindingSourceExpression(owner)
        : undefined;
    if (container === undefined) return undefined;
    const resolved = resolveImmutableInitializer(container);
    if (ts.isArrayBindingPattern(pattern)) {
      if (!ts.isArrayLiteralExpression(resolved)) return undefined;
      const index = pattern.elements.indexOf(element);
      const value = index < 0 ? undefined : resolved.elements[index];
      return value === undefined || ts.isOmittedExpression(value) || ts.isSpreadElement(value) ? undefined : value;
    }
    if (!ts.isObjectLiteralExpression(resolved)) return undefined;
    const name = element.propertyName ?? (ts.isIdentifier(element.name) ? element.name : undefined);
    if (name === undefined) return undefined;
    const text = propertyText(name);
    if (text === undefined) return undefined;
    for (const property of resolved.properties) {
      if (ts.isShorthandPropertyAssignment(property) && property.name.text === text) return property.name;
      if (ts.isPropertyAssignment(property) && propertyText(property.name) === text) return property.initializer;
    }
    return undefined;
  }
  function bindingSourceType(pattern: ts.ObjectBindingPattern | ts.ArrayBindingPattern): ts.Type | undefined {
    const owner = pattern.parent;
    if (ts.isVariableDeclaration(owner)) {
      return owner.initializer === undefined ? undefined : checker.getTypeAtLocation(owner.initializer);
    }
    if (ts.isParameter(owner)) return checker.getTypeAtLocation(owner);
    if (ts.isBindingElement(owner)) {
      const source = bindingSourceSymbol(owner);
      return source === undefined ? undefined : checker.getTypeOfSymbolAtLocation(source, owner);
    }
    return undefined;
  }
  function bindingSourceSymbol(element: ts.BindingElement): ts.Symbol | undefined {
    const sourceType = bindingSourceType(element.parent);
    if (sourceType === undefined) return undefined;
    if (ts.isObjectBindingPattern(element.parent)) {
      const name = element.propertyName ?? (ts.isIdentifier(element.name) ? element.name : undefined);
      if (name === undefined) return undefined;
      const text = propertyText(name);
      return text === undefined ? undefined : sourceType.getProperty(text);
    }
    const index = element.parent.elements.indexOf(element);
    return index < 0 ? undefined : sourceType.getProperty(String(index));
  }
  const staticKafkaCapabilityOf = (
    expression: ts.Expression,
    position: number,
  ): RuntimeCapability | undefined => {
    const unwrapped = unwrapTransparentExpression(expression);
    if (ts.isBinaryExpression(unwrapped) && unwrapped.operatorToken.kind === ts.SyntaxKind.EqualsToken) {
      return staticKafkaCapabilityOf(unwrapped.right, position);
    }
    if (ts.isNewExpression(unwrapped) && isKafkaConstructor(unwrapped.expression)) return 'kafka_root';
    if (ts.isCallExpression(unwrapped) && ts.isPropertyAccessExpression(unwrapped.expression)) {
      const receiver = unwrapped.expression.expression;
      const method = unwrapped.expression.name.text;
      const receiverCapability = staticKafkaCapabilityOf(receiver, position);
      const receiverPath = assignmentValueAccessPath(receiver, position);
      if (accessPathWasInvalidated(receiverPath, method, position)) return undefined;
      if (receiverCapability === 'kafka_root' && method === 'producer') return 'kafka_producer';
      if (receiverCapability === 'kafka_root' && method === 'consumer') return 'kafka_consumer';
    }
    const receiver = symbolOfExpression(unwrapped);
    if (receiver === undefined
      || symbolWasReassignedBefore(receiver, position)
      || accessWasInvalidated(unwrapped, undefined, position)) return undefined;
    if (kafkaRoots.has(receiver)) return 'kafka_root';
    if (kafkaProducers.has(receiver)) return 'kafka_producer';
    if (kafkaConsumers.has(receiver)) return 'kafka_consumer';
    return undefined;
  };
  const discoverBindings = (node: ts.Node): void => {
    if ((ts.isVariableDeclaration(node) || ts.isParameter(node) || ts.isPropertyDeclaration(node))
      && ts.isIdentifier(node.name)) {
      const declared = symbolOf(node.name);
      if (declared !== undefined && !symbolWasReassignedBefore(declared, node.getStart(sf))
        && (hasImportedRouterType(node.type) || hasLocalRouterContract(node))) {
        addRouterReceiver(declared);
      }
      const initializer = ts.isVariableDeclaration(node) || ts.isPropertyDeclaration(node)
        ? node.initializer
        : undefined;
      if (declared !== undefined && !symbolWasReassignedBefore(declared, node.getStart(sf)) && initializer !== undefined) {
        propagateRouterInitializer(declared, initializer);
      }
    }
    if (ts.isPropertyAssignment(node) && ts.isObjectLiteralExpression(node.parent)) {
      const declared = objectPropertySymbol(node.parent, node.name);
      if (declared !== undefined) propagateRouterInitializer(declared, node.initializer);
    }
    if (ts.isShorthandPropertyAssignment(node) && ts.isObjectLiteralExpression(node.parent)) {
      const declared = objectPropertySymbol(node.parent, node.name);
      const source = checker.getShorthandAssignmentValueSymbol(node);
      if (declared !== undefined && source !== undefined) propagateRouterSymbol(declared, source, node.getStart(sf));
    }
    if (ts.isBindingElement(node) && ts.isIdentifier(node.name)) {
      const declared = symbolOf(node.name);
      const source = bindingSourceSymbol(node);
      if (declared !== undefined && source !== undefined) propagateRouterSymbol(declared, source, node.getStart(sf));
      const sourceExpression = bindingSourceExpression(node);
      if (declared !== undefined && sourceExpression !== undefined) {
        propagateRouterInitializer(declared, sourceExpression);
      }
    }
    if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.initializer) {
      const declared = symbolOf(node.name);
      const capability = staticKafkaCapabilityOf(node.initializer, node.initializer.getStart(sf));
      if (declared !== undefined && !symbolWasReassignedBefore(declared, node.getStart(sf))) {
        if (capability === 'kafka_root') kafkaRoots.add(declared);
        if (capability === 'kafka_producer') kafkaProducers.add(declared);
        if (capability === 'kafka_consumer') kafkaConsumers.add(declared);
      }
    }
    ts.forEachChild(node, discoverBindings);
  };
  do {
    routerBindingsChanged = false;
    discoverBindings(sf);
  } while (routerBindingsChanged);
  const runtimeCapabilityAtPath = (
    pathValue: AccessPath | undefined,
    position: number,
  ): RuntimeCapability | undefined => {
    if (pathValue === undefined) return undefined;
    let latest: (AccessPath & { capability: RuntimeCapability; position: number }) | undefined;
    for (const entry of runtimeCapabilities) {
      if (entry.position > position || !sameAccessIdentity(entry, pathValue)) continue;
      if (latest === undefined || entry.position >= latest.position) latest = entry;
    }
    return latest?.capability;
  };
  const staticCapability = (expression: ts.Expression, position: number): RuntimeCapability | undefined => {
    const receiver = symbolOfExpression(expression);
    if (receiver === undefined
      || symbolWasReassignedBefore(receiver, position)
      || accessWasInvalidated(expression, undefined, position)) return undefined;
    if (symbolSetHas(routerReceivers, receiver)) return 'router';
    if (symbolSetHas(kafkaRoots, receiver)) return 'kafka_root';
    if (symbolSetHas(kafkaProducers, receiver)) return 'kafka_producer';
    if (symbolSetHas(kafkaConsumers, receiver)) return 'kafka_consumer';
    return undefined;
  };
  const runtimeCapabilityOf = (expression: ts.Expression, position: number): RuntimeCapabilityValue | undefined => {
    const unwrapped = unwrapTransparentExpression(expression);
    if (ts.isBinaryExpression(unwrapped) && unwrapped.operatorToken.kind === ts.SyntaxKind.EqualsToken) {
      return runtimeCapabilityOf(unwrapped.right, position);
    }
    if (ts.isCallExpression(unwrapped) && isRouterFactoryCall(unwrapped)) return { capability: 'router' };
    if (ts.isNewExpression(unwrapped) && isKafkaConstructor(unwrapped.expression)) {
      return { capability: 'kafka_root' };
    }
    if (ts.isCallExpression(unwrapped) && ts.isPropertyAccessExpression(unwrapped.expression)) {
      const receiver = unwrapped.expression.expression;
      const method = unwrapped.expression.name.text;
      const receiverValue = runtimeCapabilityOf(receiver, position);
      if (accessPathWasInvalidated(receiverValue?.sourcePath, method, position)) return undefined;
      if (receiverValue?.capability === 'kafka_root' && method === 'producer') {
        return { capability: 'kafka_producer' };
      }
      if (receiverValue?.capability === 'kafka_root' && method === 'consumer') {
        return { capability: 'kafka_consumer' };
      }
    }
    const sourcePath = accessPathOf(unwrapped, position);
    const runtimeCapability = runtimeCapabilityAtPath(sourcePath, position);
    if (runtimeCapability !== undefined) return { capability: runtimeCapability, sourcePath };
    const capability = staticCapability(unwrapped, position);
    return capability === undefined ? undefined : { capability, sourcePath };
  };
  const recordRuntimeCapability = (
    target: ts.Expression,
    capability: RuntimeCapability,
    position: number,
    restoresUnknownReplacement: boolean,
  ): void => {
    const targetPath = accessPathOf(target, position + 1);
    if (targetPath === undefined) return;
    const snapshot = {
      ...targetPath,
      members: [...targetPath.members],
      versions: [...targetPath.versions],
      position,
    };
    runtimeCapabilities.push({ ...snapshot, capability });
    if (restoresUnknownReplacement) restoredAccessPaths.push(snapshot);
  };
  const collectRuntimeCapabilities = (node: ts.Node): void => {
    if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.initializer !== undefined) {
      const capability = runtimeCapabilityOf(node.initializer, node.initializer.getStart(sf))?.capability;
      if (capability !== undefined) recordRuntimeCapability(node.name, capability, node.getEnd(), false);
    }
    if (ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.EqualsToken) {
      const position = node.getEnd();
      const sourcePath = assignmentValueAccessPath(node.right, node.right.getStart(sf));
      const capability = runtimeCapabilityOf(node.right, node.right.getStart(sf))?.capability;
      if (capability !== undefined) recordRuntimeCapability(node.left, capability, position, sourcePath === undefined);
    }
    ts.forEachChild(node, collectRuntimeCapabilities);
  };
  collectRuntimeCapabilities(sf);
  const hasCallableHandler = (call: ts.CallExpression): boolean => {
    const handler = call.arguments[call.arguments.length - 1];
    if (handler === undefined) return false;
    if (ts.isArrowFunction(handler) || ts.isFunctionExpression(handler)) return true;
    return checker.getTypeAtLocation(handler).getCallSignatures().length > 0;
  };

  sink.nodes.push({
    kind: 'file',
    name: path.basename(abs),
    qualifiedName: fileQName,
    filePath: abs,
    lang,
    contentHash: hashContent(sf.text),
  });

  const addDecl = (name: string, decl: ts.Node, kindHint: 'function' | 'class', exported: boolean, signature: string): void => {
    const kind = kindHint === 'class' ? 'class' : isJsxFile && /^[A-Z]/.test(name) ? 'component' : 'function';
    const qn = `${fileQName}#${name}`;
    const ref: NodeRef = { kind, qualifiedName: qn };
    sink.nodes.push({
      kind,
      name,
      qualifiedName: qn,
      filePath: abs,
      line: lineOf(decl),
      lang,
      signature: signature.replace(/\s+/g, ' ').trim().slice(0, 300),
    });
    sink.edges.push({ from: fileRef, to: ref, relation: 'defines' });
    if (exported) sink.edges.push({ from: fileRef, to: ref, relation: 'exports' });
  };

  for (const stmt of sf.statements) {
    if ((ts.isImportDeclaration(stmt) || ts.isExportDeclaration(stmt)) && stmt.moduleSpecifier && ts.isStringLiteralLike(stmt.moduleSpecifier)) {
      const resolved = ts.resolveModuleName(stmt.moduleSpecifier.text, abs, options, ts.sys).resolvedModule;
      if (resolved && !resolved.isExternalLibraryImport) {
        const targetQName = qnameOf(path.resolve(resolved.resolvedFileName));
        if (targetQName && targetQName !== fileQName) {
          sink.edges.push({ from: fileRef, to: { kind: 'file', qualifiedName: targetQName }, relation: 'imports' });
        }
      }
    } else if (ts.isFunctionDeclaration(stmt) && stmt.name) {
      const sigEnd = stmt.body ? stmt.body.getStart(sf) : stmt.getEnd();
      addDecl(stmt.name.text, stmt, 'function', isExported(stmt), sf.text.slice(stmt.getStart(sf), sigEnd));
    } else if (ts.isClassDeclaration(stmt) && stmt.name) {
      addDecl(stmt.name.text, stmt, 'class', isExported(stmt), `class ${stmt.name.text}`);
    } else if (ts.isVariableStatement(stmt)) {
      const exported = isExported(stmt);
      for (const decl of stmt.declarationList.declarations) {
        if (
          ts.isIdentifier(decl.name) &&
          decl.initializer &&
          (ts.isArrowFunction(decl.initializer) || ts.isFunctionExpression(decl.initializer))
        ) {
          const sigEnd = decl.initializer.body.getStart(sf);
          addDecl(decl.name.text, decl, 'function', exported, sf.text.slice(decl.getStart(sf), sigEnd));
        }
      }
    }
  }

  const addTableRef = (tableIdent: string, confidence: 'extracted' | 'inferred', via: string, line: number): void => {
    const ident = tableIdent.toLowerCase();
    const last = ident.split('.').pop() ?? ident;
    if (SQL_NOISE.has(last)) return;
    const qn = ident.includes('.') ? ident : `public.${ident}`;
    sink.edges.push({
      from: fileRef,
      to: { kind: 'table', qualifiedName: qn },
      relation: 'references_table',
      confidence,
      metadata: { via, line },
    });
  };

  const addEndpoint = (method: HttpMethod, rawRoute: string, node: ts.Node): void => {
    const route = normalizeRoutePath(rawRoute);
    if (route === null) return;
    const qn = endpointQName(identity.id, method, route);
    sink.nodes.push({
      kind: 'endpoint',
      name: `${method} ${route}`,
      qualifiedName: qn,
      line: lineOf(node),
      lang,
      metadata: {
        contract: 'http-endpoint-v1',
        service_id: identity.id,
        service_aliases: identity.aliases,
        method,
        path: route,
      },
    });
    sink.edges.push({ from: fileRef, to: { kind: 'endpoint', qualifiedName: qn }, relation: 'serves_route' });
  };

  const addHttpCall = (
    node: ts.CallExpression,
    urlExpression: ts.Expression | undefined,
    methodExpression: ts.Expression | undefined,
    defaultMethod: HttpMethod,
  ): void => {
    const rawUrl = literalText(urlExpression);
    if (rawUrl === null) {
      sink.contractSkips.dynamic_http_url++;
      return;
    }
    const parsed = parseLiteralHttpUrl(rawUrl);
    if (parsed === null) return;
    let method = defaultMethod;
    if (methodExpression !== undefined) {
      const rawMethod = literalText(methodExpression);
      if (rawMethod === null) {
        sink.contractSkips.dynamic_http_method++;
        return;
      }
      const normalized = normalizeHttpMethod(rawMethod);
      if (normalized === null) return;
      method = normalized;
    }
    const point = positionOf(node);
    const qn = httpCallQName(identity.id, fileQName, point.line, point.column);
    sink.nodes.push({
      kind: 'http_call',
      name: `${method} ${parsed.host}${parsed.methodPath}`,
      qualifiedName: qn,
      filePath: abs,
      line: point.line,
      lang,
      metadata: {
        contract: 'http-call-v1',
        source_service: identity.id,
        target_host: parsed.host,
        method,
        path: parsed.methodPath,
      },
    });
    sink.edges.push({ from: fileRef, to: { kind: 'http_call', qualifiedName: qn }, relation: 'defines' });
  };

  const addEvent = (relation: 'emits' | 'listens_on', expression: ts.Expression | undefined): void => {
    const channel = literalText(expression);
    if (channel === null) {
      sink.contractSkips.dynamic_event_channel++;
      return;
    }
    const qn = eventChannelQName('kafka', channel);
    if (qn === null) return;
    sink.nodes.push({ kind: 'event_channel', name: channel, qualifiedName: qn });
    sink.edges.push({ from: fileRef, to: { kind: 'event_channel', qualifiedName: qn }, relation });
  };

  const visit = (node: ts.Node): void => {
    if (ts.isCallExpression(node)) {
      const arg0 = node.arguments[0];
      const fetchSymbol = ts.isIdentifier(node.expression) && node.expression.text === 'fetch'
        ? checker.getSymbolAtLocation(node.expression)
        : undefined;
      const supportedFetch = fetchSymbol === undefined
        || (fetchSymbol.declarations ?? []).every((declaration) => declaration.getSourceFile() !== sf);
      const fetchBindingUnchanged = fetchSymbol === undefined
        || !symbolWasReassignedBefore(fetchSymbol, node.getStart(sf));
      if (ts.isIdentifier(node.expression) && node.expression.text === 'fetch'
        && supportedFetch && fetchBindingUnchanged) {
        const optionsArg = node.arguments[1];
        let methodExpression: ts.Expression | undefined;
        if (optionsArg !== undefined) {
          if (ts.isObjectLiteralExpression(optionsArg)) {
            methodExpression = objectPropertyExpression(objectProperty(optionsArg, 'method'), optionsArg);
          } else {
            methodExpression = optionsArg;
          }
        }
        addHttpCall(node, arg0, methodExpression, 'GET');
      } else if (ts.isIdentifier(node.expression) && hasSymbol(bindings.axios, node.expression)
        && !identifierWasReassignedBefore(node.expression, node.getStart(sf))) {
        const config = arg0;
        if (config && ts.isObjectLiteralExpression(config)) {
          addHttpCall(
            node,
            objectPropertyExpression(objectProperty(config, 'url'), config),
            objectPropertyExpression(objectProperty(config, 'method'), config),
            'GET',
          );
        } else sink.contractSkips.dynamic_http_url++;
      } else if (ts.isPropertyAccessExpression(node.expression)) {
        const method = node.expression.name.text;
        const receiver = node.expression.expression;
        const unwrappedReceiver = unwrapTransparentExpression(receiver);
        const receiverName = ts.isIdentifier(unwrappedReceiver) ? unwrappedReceiver.text : '';
        const receiverSymbol = symbolOfExpression(unwrappedReceiver);
        const receiverRuntimeValue = runtimeCapabilityOf(unwrappedReceiver, node.getStart(sf));
        const receiverRuntimeCapability = receiverRuntimeValue?.capability;
        const receiverCapabilityPath = receiverRuntimeValue?.sourcePath
          ?? assignmentValueAccessPath(unwrappedReceiver, node.getStart(sf));
        const routerReceiver = receiverRuntimeCapability === 'router'
          || (receiverSymbol !== undefined && symbolSetHas(routerReceivers, receiverSymbol))
          || (ts.isCallExpression(unwrappedReceiver) && isRouterFactoryCall(unwrappedReceiver));
        const routerReceiverUnchanged = receiverRuntimeCapability === 'router'
          || receiverSymbol === undefined
          || !symbolWasReassignedBefore(receiverSymbol, node.getStart(sf));
        const routerMethodUnchanged = !accessPathWasInvalidated(receiverCapabilityPath, method, node.getStart(sf));
        const axiosMethodUnchanged = !accessWasInvalidated(unwrappedReceiver, method);
        const kafkaProducerMethodUnchanged = !accessPathWasInvalidated(
          receiverCapabilityPath,
          'send',
          node.getStart(sf),
        );
        const kafkaConsumerMethodUnchanged = !accessPathWasInvalidated(
          receiverCapabilityPath,
          'subscribe',
          node.getStart(sf),
        );
        if (receiverSymbol !== undefined && bindings.axios.has(receiverSymbol) && axiosMethodUnchanged) {
          const directMethod = normalizeHttpMethod(method);
          if (directMethod !== null && method.toLowerCase() !== 'request') {
            addHttpCall(node, arg0, undefined, directMethod);
          } else if (method === 'request' && arg0 && ts.isObjectLiteralExpression(arg0)) {
            addHttpCall(
              node,
              objectPropertyExpression(objectProperty(arg0, 'url'), arg0),
              objectPropertyExpression(objectProperty(arg0, 'method'), arg0),
              'GET',
            );
          } else if (method === 'request') sink.contractSkips.dynamic_http_url++;
        } else if ((receiverRuntimeCapability === 'kafka_producer'
          || (receiverSymbol !== undefined && kafkaProducers.has(receiverSymbol)))
          && method === 'send' && kafkaProducerMethodUnchanged) {
          if (arg0 && ts.isObjectLiteralExpression(arg0)) {
            addEvent('emits', objectPropertyExpression(objectProperty(arg0, 'topic'), arg0));
          }
          else sink.contractSkips.dynamic_event_channel++;
        } else if ((receiverRuntimeCapability === 'kafka_consumer'
          || (receiverSymbol !== undefined && kafkaConsumers.has(receiverSymbol)))
          && method === 'subscribe' && kafkaConsumerMethodUnchanged) {
          if (arg0 && ts.isObjectLiteralExpression(arg0)) {
            const topicRead = objectProperty(arg0, 'topic');
            const topicsRead = objectProperty(arg0, 'topics');
            const topic = objectPropertyExpression(topicRead, arg0);
            const topics = objectPropertyExpression(topicsRead, arg0);
            if (topicRead.present) addEvent('listens_on', topic);
            else if (topicsRead.present && topics && ts.isArrayLiteralExpression(topics)) {
              const literals = topics.elements.map((element) => literalText(element));
              if (literals.some((value) => value === null)) sink.contractSkips.dynamic_event_channel++;
              else for (const element of topics.elements) addEvent('listens_on', element);
            } else sink.contractSkips.dynamic_event_channel++;
          } else sink.contractSkips.dynamic_event_channel++;
        } else if (HTTP_METHODS.has(method)
          && !CLIENT_RECEIVERS.has(receiverName)
          && routerReceiver
          && routerReceiverUnchanged
          && !accessPathWasInvalidated(receiverCapabilityPath, undefined, node.getStart(sf))
          && routerMethodUnchanged
          && hasCallableHandler(node)) {
          const route = literalText(arg0);
          if (route === null) sink.contractSkips.dynamic_http_route++;
          else if (route.startsWith('/')) {
            const providerMethod = normalizeHttpMethod(method === 'all' ? 'ANY' : method);
            if (providerMethod !== null) addEndpoint(providerMethod, route, node);
          }
        }
        if (method === 'from' && arg0 !== undefined && ts.isStringLiteralLike(arg0) && /^[a-z_][a-z0-9_]*$/.test(arg0.text)) {
          addTableRef(arg0.text, 'extracted', 'orm-from-call', lineOf(node));
        }
      }
    }
    if (ts.isStringLiteralLike(node) || ts.isTemplateExpression(node)) {
      const text = node.getText(sf);
      if (SQL_VERB.test(text)) {
        for (const m of text.matchAll(SQL_TABLE)) {
          addTableRef(m[1], 'inferred', 'sql-literal', lineOf(node));
        }
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
}

/** Expo Router file-based routes: repos with expo-router get an endpoint node
 * per page file under app/ (layout/system files starting with _ or + skipped). */
function extractExpoRoutes(
  repo: string,
  identity: ServiceIdentity,
  allowed: ReadonlySet<string>,
  qnameOf: (absPath: string) => string | null,
  changed: Set<string> | null,
  sink: Sink
): void {
  let pkg: { dependencies?: Record<string, string>; devDependencies?: Record<string, string> };
  try {
    pkg = JSON.parse(fs.readFileSync(path.join(repo, 'package.json'), 'utf8')) as typeof pkg;
  } catch {
    return;
  }
  if (!pkg.dependencies?.['expo-router'] && !pkg.devDependencies?.['expo-router']) return;
  const appDir = path.join(repo, 'app');
  for (const abs of [...allowed].filter((f) => f.startsWith(appDir + path.sep))) {
    const base = path.basename(abs);
    if (base.startsWith('_') || base.startsWith('+')) continue;
    if (changed && !changed.has(path.resolve(abs))) continue;
    const fileQName = qnameOf(abs);
    if (!fileQName) continue;
    const segs = path
      .relative(appDir, abs)
      .split(path.sep)
      .join('/')
      .replace(/\.(tsx|ts|jsx|js)$/, '')
      .split('/')
      .filter((s) => !(s.startsWith('(') && s.endsWith(')')));
    if (segs[segs.length - 1] === 'index') segs.pop();
    const route = normalizeRoutePath(`/${segs.join('/')}`);
    if (route === null) continue;
    const qn = endpointQName(identity.id, 'ANY', route);
    sink.nodes.push({
      kind: 'endpoint',
      name: `ANY ${route}`,
      qualifiedName: qn,
      lang: 'typescript',
      metadata: {
        contract: 'http-endpoint-v1',
        service_id: identity.id,
        service_aliases: identity.aliases,
        method: 'ANY',
        path: route,
      },
    });
    sink.edges.push({ from: { kind: 'file', qualifiedName: fileQName }, to: { kind: 'endpoint', qualifiedName: qn }, relation: 'serves_route' });
  }
}

export const tsExtractor: GraphExtractor = {
  name: 'ts',
  vocabulary: {
    kinds: ['file', 'function', 'class', 'component', 'endpoint', 'http_call', 'event_channel'],
    relations: ['imports', 'exports', 'defines', 'serves_route', 'references_table', 'emits', 'listens_on'],
  },
  async extract({ repoPaths, changedFiles, excludes }): Promise<ExtractorOutput> {
    const sink: Sink = { nodes: [], edges: [], contractSkips: emptyContractSkips() };
    const resolvedRepos = canonicalRegisteredRoots(repoPaths, { baseDir: process.cwd(), rejectRelative: true });
    const identities = new Map(resolvedRepos.map((repo) => [repo, serviceIdentity(repo)]));
    const changed = changedFiles ? new Set(changedFiles.map((p) => path.resolve(p))) : null;
    const qnameOf = (absPath: string): string | null => {
      const owner = owningRegisteredRepo(absPath, resolvedRepos);
      if (owner === null) return null;
      const identity = identities.get(owner);
      if (identity === undefined) return null;
      const legacy = `${path.basename(owner)}/${path.relative(owner, absPath).split(path.sep).join('/')}`;
      return sourceQNameForPath(identity.id, legacy, path.extname(absPath));
    };

    for (const repo of resolvedRepos) {
      // Canonical enumeration once per repo; the program may pull in files
      // beyond it (transitive imports — e.g. an excluded dir imported from
      // src), so the allowed set also gates the source-file loop below.
      const allowed = new Set(
        listOwnedRepoFiles(repo, resolvedRepos, SOURCE_EXT, excludes ?? [])
          .filter((f) => !f.endsWith('.d.ts'))
          .map((f) => path.resolve(f))
      );
      const program = buildProgram(repo, allowed);
      if (!program) continue;
      const identity = identities.get(repo);
      if (identity === undefined) continue;
      const options = program.getCompilerOptions();
      const checker = program.getTypeChecker();
      for (const sf of program.getSourceFiles()) {
        const abs = path.resolve(sf.fileName);
        if (sf.isDeclarationFile || !allowed.has(abs)) continue;
        if (changed && !changed.has(abs)) continue;
        const fileQName = qnameOf(abs);
        if (!fileQName) continue;
        extractFile(sf, abs, fileQName, identity, options, checker, qnameOf, sink);
      }
      extractExpoRoutes(repo, identity, allowed, qnameOf, changed, sink);
    }
    return sink;
  },
};
