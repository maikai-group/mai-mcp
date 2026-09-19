// mai-graph PHP extractor (plan 33). Language structure here; WordPress
// semantics in php-wordpress.ts, both over ONE parse per file.
//
// Declarations are REPO-scoped (cpp.ts:151 precedent), not file-scoped like
// python.ts: PHP classes and functions are callable across files, so a
// file-scoped qualified name would make every cross-file callback reference
// unresolvable — silently, as dropped edges.
//
// References are resolved AFTER the walk: a callback can name a class declared
// in a file not yet visited. Deferred records hold strings only, so no AST is
// retained and each file is parsed exactly once.
import fs from 'node:fs';
import path from 'node:path';
import type { Node } from 'web-tree-sitter';
import { hashContent } from '../engine.js';
import { parserFor } from '../parsers.js';
import { canonicalRegisteredRoots } from '../roots.js';
import {
  httpCallQName,
  normalizeHttpMethod,
  owningRegisteredRepo,
  parseLiteralHttpUrl,
  serviceIdentity,
  serviceSourceQName,
  sourceQNameForPath,
  type HttpMethod,
  type ServiceIdentity,
} from '../contracts.js';
import { listOwnedRepoFiles } from '../walk.js';
import type { ContractSkipTallies, ExtractorOutput, GraphExtractor, NodeRef } from '../types.js';
import {
  argAt,
  isTestPath,
  lineOf,
  newTally,
  resolveClassName,
  stringLiteral,
  type FileCtx,
  type RepoCtx,
} from './php-ast.js';
import { handleWordPressCall } from './php-wordpress.js';

export const PHP_EXT = new Set(['.php']);

function emptyContractSkips(): ContractSkipTallies {
  return {
    dynamic_http_url: 0,
    dynamic_http_method: 0,
    dynamic_http_route: 0,
    dynamic_event_channel: 0,
  };
}

function httpStringLiteral(node: Node | null): string | null {
  const value = stringLiteral(node);
  if (value !== null) return value;
  if (node && (node.type === 'string' || node.type === 'encapsed_string') && node.namedChildCount === 0) return '';
  return null;
}

function resolvePhpClassName(raw: string, file: FileCtx): string {
  const rootQualified = raw.startsWith('\\');
  const written = raw.replace(/^\\+/, '');
  if (rootQualified) return written;
  const [head = '', ...tail] = written.split('\\');
  const imported = file.aliases.get(head.toLowerCase());
  if (imported !== undefined) return tail.length === 0 ? imported : `${imported}\\${tail.join('\\')}`;
  return file.namespace === '' ? written : `${file.namespace}\\${written}`;
}

function isGuzzleConstruction(node: Node | null, file: FileCtx): boolean {
  if (!node || node.type !== 'object_creation_expression') return false;
  const classNode = node.namedChildren.find((child) =>
    child !== null && (child.type === 'name' || child.type === 'qualified_name'));
  if (!classNode) return false;
  const resolved = resolvePhpClassName(classNode.text, file);
  return resolved.toLowerCase() === 'guzzlehttp\\client';
}

function isGuzzleTypeName(raw: string, file: FileCtx): boolean {
  const resolved = resolvePhpClassName(raw.replace(/^\?/, ''), file);
  return resolved.toLowerCase() === 'guzzlehttp\\client';
}

function directVariableName(node: Node | null): string | undefined {
  return node?.type === 'variable_name' ? node.namedChild(0)?.text : undefined;
}

function collectTargetVariables(node: Node | null, target: Set<string>): void {
  if (node === null) return;
  const direct = directVariableName(node);
  if (direct !== undefined) {
    target.add(direct);
    return;
  }
  if (node.type !== 'list_literal'
    && node.type !== 'array_creation_expression'
    && node.type !== 'by_ref'
    && node.type !== 'pair') return;
  for (const child of node.namedChildren) if (child) collectTargetVariables(child, target);
}

function isTransparentGuzzleValueWrapper(node: Node | null): boolean {
  return node?.type === 'parenthesized_expression' || node?.type === 'by_ref';
}

function isGuzzleValue(node: Node | null, file: FileCtx, clients: ReadonlySet<string>): boolean {
  if (isGuzzleConstruction(node, file)) return true;
  const variable = directVariableName(node);
  if (variable !== undefined) return clients.has(variable);
  if (node !== null && isTransparentGuzzleValueWrapper(node)) {
    return isGuzzleValue(node.namedChild(node.namedChildCount - 1), file, clients);
  }
  if (node?.type === 'assignment_expression' || node?.type === 'reference_assignment_expression') {
    return isGuzzleValue(node.childForFieldName('right'), file, clients);
  }
  return false;
}

function scopedGuzzleClients(
  scope: Node,
  inherited: ReadonlySet<string>,
  file: FileCtx,
): Set<string> {
  const scoped = scope.type === 'arrow_function' ? new Set(inherited) : new Set<string>();
  const parameters = scope.namedChildren.find((child) => child?.type === 'formal_parameters');
  for (const parameter of parameters?.namedChildren ?? []) {
    if (!parameter || parameter.type !== 'simple_parameter') continue;
    const type = parameter.childForFieldName('type');
    const variable = directVariableName(parameter.childForFieldName('name'));
    if (variable !== undefined) scoped.delete(variable);
    if (type !== null && variable !== undefined && isGuzzleTypeName(type.text, file)) scoped.add(variable);
  }
  if (scope.type === 'anonymous_function') {
    const captures = scope.namedChildren.find((child) => child?.type === 'anonymous_function_use_clause');
    for (const capture of captures?.namedChildren ?? []) {
      const variables = new Set<string>();
      collectTargetVariables(capture, variables);
      for (const variable of variables) if (inherited.has(variable)) scoped.add(variable);
    }
  }
  return scoped;
}

function phpArrayEntry(array: Node | null, key: string): { present: boolean; value: Node | null } {
  if (!array || array.type !== 'array_creation_expression') return { present: false, value: null };
  let result: { present: boolean; value: Node | null } = { present: false, value: null };
  for (const item of array.namedChildren) {
    if (!item || item.type !== 'array_element_initializer') continue;
    if (item.namedChildCount === 1) {
      if (item.namedChild(0)?.type === 'variadic_unpacking') result = { present: true, value: null };
      continue;
    }
    const keyNode = item.namedChild(0);
    const literal = stringLiteral(keyNode);
    if (literal === key) result = { present: true, value: item.namedChild(item.namedChildCount - 1) };
    else if (literal !== null
      || keyNode?.type === 'integer'
      || keyNode?.type === 'float'
      || keyNode?.type === 'boolean'
      || keyNode?.type === 'null'
      || keyNode?.type === 'unary_op_expression'
      || ((keyNode?.type === 'string' || keyNode?.type === 'encapsed_string') && keyNode.namedChildCount === 0)) {
      continue;
    } else result = { present: true, value: null };
  }
  return result;
}

/** `namespace A\B;` → 'A\B' (first one wins; braced multi-namespace files are rare). */
function readNamespace(root: Node): string {
  for (const child of root.namedChildren) {
    if (child && child.type === 'namespace_definition') {
      const nameNode = child.namedChildren.find((c) => c !== null && c.type === 'namespace_name');
      if (nameNode) return nameNode.text;
    }
  }
  return '';
}

/**
 * `use A\B\C;` → C→A\B\C ; `use A\B\C as D;` → D→A\B\C.
 * Verified shape: namespace_use_declaration > namespace_use_clause >
 * qualified_name [+ trailing `name` when aliased].
 */
function readUseMaps(root: Node): Pick<FileCtx, 'aliases' | 'functionAliases' | 'constantAliases'> {
  const aliases = new Map<string, string>();
  const functionAliases = new Map<string, string>();
  const constantAliases = new Map<string, string>();
  const visit = (node: Node): void => {
    if (node.type === 'namespace_use_declaration') {
      const declarationKind = /^use\s+(function|const)\b/.exec(node.text.trim())?.[1] ?? 'class';
      const prefix = node.namedChildren.find((child) => child?.type === 'namespace_name')?.text;
      const group = node.namedChildren.find((child) => child?.type === 'namespace_use_group');
      const clauses = group?.namedChildren ?? node.namedChildren;
      for (const clause of clauses) {
        if (!clause || clause.type !== 'namespace_use_clause') continue;
        const kind = /^(function|const)\b/.exec(clause.text.trim())?.[1] ?? declarationKind;
        const qn = clause.namedChildren.find((c) => c !== null && c.type === 'qualified_name');
        const imported = (qn ?? clause.namedChild(0))?.text?.replace(/^\\+/, '');
        if (!imported) continue;
        const fqcn = prefix === undefined ? imported : `${prefix}\\${imported}`;
        const aliasNode = clause.namedChildren.filter((c) => c !== null && c.type === 'name').pop();
        const alias = aliasNode ? aliasNode.text : (fqcn.split('\\').pop() ?? fqcn);
        if (kind === 'function') functionAliases.set(alias.toLowerCase(), fqcn);
        else if (kind === 'const') constantAliases.set(alias, fqcn);
        else aliases.set(alias.toLowerCase(), fqcn);
      }
      return;
    }
    for (const child of node.namedChildren) if (child) visit(child);
  };
  visit(root);
  return { aliases, functionAliases, constantAliases };
}

function registerClass(repo: RepoCtx, fqcn: string, qn: string): void {
  repo.classByFqcn.set(fqcn, qn);
  const short = fqcn.split('\\').pop() ?? fqcn;
  const list = repo.classesByShort.get(short);
  if (list) list.push(fqcn);
  else repo.classesByShort.set(short, [fqcn]);
}

function registerFunction(repo: RepoCtx, fqName: string, qn: string): void {
  const short = fqName.split('\\').pop() ?? fqName;
  const list = repo.functionsByShort.get(short);
  if (list) list.push(qn);
  else repo.functionsByShort.set(short, [qn]);
}

/**
 * Record `const NAME = 'literal';` for every class in ONE file, BEFORE the walk (R13).
 * A pre-scan rather than inline collection because a constant is routinely declared
 * after the method that uses it; no cross-file deferral is needed because `self::`
 * only ever names a class in this same file. Non-literal constants are simply
 * absent, which reads as unresolved at the use site and is tallied there.
 * Verified shape: `class_declaration > declaration_list > const_declaration >
 * const_element > (name) (string (string_content))`.
 */
function prescanConstants(repo: RepoCtx, file: FileCtx, root: Node): void {
  const visit = (node: Node, enclosing: string | null): void => {
    let scope = enclosing;
    if (
      node.type === 'class_declaration' ||
      node.type === 'interface_declaration' ||
      node.type === 'trait_declaration'
    ) {
      const nameNode = node.childForFieldName('name');
      const short = nameNode ? nameNode.text : '';
      if (short !== '') scope = file.namespace === '' ? short : `${file.namespace}\\${short}`;
    }
    // A1: an anonymous class's constants belong to no named class either —
    // without this, `const K` inside `new class {…}` is recorded under the
    // ENCLOSING class and a sibling method's `self::K` resolves to a value
    // the named class does not declare.
    if (node.type === 'anonymous_class') scope = null;
    if (node.type === 'const_element' && scope !== null) {
      const nameNode = node.namedChild(0);
      const value = stringLiteral(node.namedChild(1));
      if (nameNode && nameNode.type === 'name' && value !== null) {
        repo.constants.set(`${scope}::${nameNode.text}`, value);
      }
    }
    for (const child of node.namedChildren) if (child) visit(child, scope);
  };
  visit(root, null);
}

function emitPhpHttpCall(
  repo: RepoCtx,
  file: FileCtx,
  call: Node,
  identity: ServiceIdentity,
  skips: ContractSkipTallies,
  urlNode: Node | null,
  methodNode: Node | null,
  defaultMethod: HttpMethod,
  dynamicMethod = false,
): void {
  const rawUrl = httpStringLiteral(urlNode);
  if (rawUrl === null) {
    skips.dynamic_http_url++;
    return;
  }
  const parsed = parseLiteralHttpUrl(rawUrl);
  if (parsed === null) return;
  if (dynamicMethod) {
    skips.dynamic_http_method++;
    return;
  }
  let method = defaultMethod;
  if (methodNode !== null) {
    const rawMethod = httpStringLiteral(methodNode);
    if (rawMethod === null) {
      skips.dynamic_http_method++;
      return;
    }
    const normalized = normalizeHttpMethod(rawMethod);
    if (normalized === null) return;
    method = normalized;
  }
  const line = lineOf(call);
  const column = call.startPosition.column + 1;
  const qn = httpCallQName(identity.id, file.qn, line, column);
  repo.nodes.push({
    kind: 'http_call',
    name: `${method} ${parsed.host}${parsed.methodPath}`,
    qualifiedName: qn,
    filePath: file.abs,
    line,
    lang: 'php',
    metadata: {
      contract: 'http-call-v1',
      source_service: identity.id,
      target_host: parsed.host,
      method,
      path: parsed.methodPath,
    },
  });
  repo.edges.push({
    from: file.fileRef,
    to: { kind: 'http_call', qualifiedName: qn },
    relation: 'defines',
  });
}

function handlePhpHttpCall(
  repo: RepoCtx,
  file: FileCtx,
  call: Node,
  called: string,
  identity: ServiceIdentity,
  skips: ContractSkipTallies,
  guzzleClients: ReadonlySet<string>,
): void {
  if (called === 'wp_remote_get') {
    emitPhpHttpCall(repo, file, call, identity, skips, argAt(call, 0), null, 'GET');
    return;
  }
  if (called === 'wp_remote_post') {
    emitPhpHttpCall(repo, file, call, identity, skips, argAt(call, 0), null, 'POST');
    return;
  }
  if (called === 'wp_remote_request') {
    const options = argAt(call, 1);
    const methodEntry = phpArrayEntry(options, 'method');
    const dynamicMethod = options !== null && (
      options.type !== 'array_creation_expression' || (methodEntry.present && methodEntry.value === null)
    );
    emitPhpHttpCall(
      repo,
      file,
      call,
      identity,
      skips,
      argAt(call, 0),
      methodEntry.present ? methodEntry.value : null,
      'ANY',
      dynamicMethod,
    );
    return;
  }
  if (!called.startsWith('->')) return;
  const method = normalizeHttpMethod(called.slice(2));
  if (method === null || method === 'ANY') return;
  const receiver = call.childForFieldName('object');
  const receiverName = receiver?.type === 'variable_name' ? receiver.namedChild(0)?.text : undefined;
  if (receiverName === undefined || !guzzleClients.has(receiverName)) return;
  emitPhpHttpCall(repo, file, call, identity, skips, argAt(call, 0), null, method);
}

/** Walk one file: declarations, imports, inheritance, and WP call handoff. */
function walkFile(
  repo: RepoCtx,
  file: FileCtx,
  root: Node,
  identity: ServiceIdentity,
  skips: ContractSkipTallies,
  qnameOf: (absPath: string) => string | null,
  declaredFunctions: ReadonlySet<string>,
): void {
  const meta = file.isTest ? { test: true } : {};
  const fileGlobalGuzzleClients = new Set<string>();
  const referenceGroupsByClients = new WeakMap<Set<string>, Map<string, Set<string>>>();
  const referenceGroupsFor = (clients: Set<string>): Map<string, Set<string>> => {
    const existing = referenceGroupsByClients.get(clients);
    if (existing !== undefined) return existing;
    const created = new Map<string, Set<string>>();
    referenceGroupsByClients.set(clients, created);
    return created;
  };
  const linkedVariables = (variable: string, references: Map<string, Set<string>>): Set<string> => {
    return references.get(variable) ?? new Set([variable]);
  };
  const unlinkReference = (variable: string, references: Map<string, Set<string>>): void => {
    const group = references.get(variable);
    if (group === undefined) return;
    group.delete(variable);
    references.delete(variable);
    for (const remaining of group) references.set(remaining, group);
  };
  const linkReference = (left: string, right: string, references: Map<string, Set<string>>): Set<string> => {
    if (left === right) return linkedVariables(right, references);
    unlinkReference(left, references);
    const group = references.get(right) ?? new Set([right]);
    group.add(left);
    for (const variable of group) references.set(variable, group);
    return group;
  };
  const setGuzzleProvenance = (
    variables: ReadonlySet<string>,
    enabled: boolean,
    clients: Set<string>,
    references: Map<string, Set<string>>,
  ): void => {
    const linked = new Set<string>();
    for (const variable of variables) for (const member of linkedVariables(variable, references)) linked.add(member);
    for (const variable of linked) {
      clients.delete(variable);
      if (enabled) clients.add(variable);
    }
  };
  const byReferenceCaptureVariables = (scope: Node): Set<string> => {
    const variables = new Set<string>();
    if (scope.type !== 'anonymous_function') return variables;
    const captures = scope.namedChildren.find((child) => child?.type === 'anonymous_function_use_clause');
    for (const capture of captures?.namedChildren ?? []) {
      if (capture?.type === 'by_ref') collectTargetVariables(capture, variables);
    }
    return variables;
  };
  const projectReferenceGroups = (
    variables: ReadonlySet<string>,
    sourceReferences: Map<string, Set<string>>,
    scopedReferences: Map<string, Set<string>>,
  ): void => {
    const projected = new Set<Set<string>>();
    for (const variable of variables) {
      const inheritedGroup = linkedVariables(variable, sourceReferences);
      const group = new Set([...inheritedGroup].filter((member) => variables.has(member)));
      if (group.size > 1) projected.add(group);
    }
    for (const group of projected) for (const variable of group) scopedReferences.set(variable, group);
  };
  const applyAssignmentProvenance = (
    node: Node,
    clients: Set<string>,
    references: Map<string, Set<string>>,
  ): void => {
    const left = node.childForFieldName('left');
    const right = node.childForFieldName('right');
    const rightIsGuzzle = isGuzzleValue(right, file, clients);
    const targets = new Set<string>();
    collectTargetVariables(left, targets);
    const variable = directVariableName(left);
    if (node.type === 'reference_assignment_expression' && variable !== undefined) {
      const source = directVariableName(right);
      const linked = source === undefined
        ? linkedVariables(variable, references)
        : linkReference(variable, source, references);
      setGuzzleProvenance(linked, rightIsGuzzle, clients, references);
    } else {
      setGuzzleProvenance(targets, rightIsGuzzle && variable !== undefined, clients, references);
    }
  };
  const invalidateWrites = (
    node: Node,
    clients: Set<string>,
    references: Map<string, Set<string>>,
  ): void => {
    if (node.type === 'function_definition'
      || node.type === 'method_declaration'
      || node.type === 'anonymous_function'
      || node.type === 'arrow_function'
      || node.type === 'class_declaration'
      || node.type === 'anonymous_class') return;
    if (node.type === 'assignment_expression' || node.type === 'reference_assignment_expression') {
      const targets = new Set<string>();
      collectTargetVariables(node.childForFieldName('left'), targets);
      setGuzzleProvenance(targets, false, clients, references);
      for (const variable of targets) unlinkReference(variable, references);
      return;
    }
    if (node.type === 'unset_statement' || node.type === 'foreach_statement') {
      const targets = new Set<string>();
      for (const child of node.namedChildren) if (child) collectTargetVariables(child, targets);
      setGuzzleProvenance(targets, false, clients, references);
      for (const variable of targets) unlinkReference(variable, references);
      return;
    }
    for (const child of node.namedChildren) if (child) invalidateWrites(child, clients, references);
  };
  const discoverFileGlobalGuzzleClients = (node: Node, straightLine = false): void => {
    if (node.type === 'function_definition'
      || node.type === 'method_declaration'
      || node.type === 'anonymous_function'
      || node.type === 'arrow_function'
      || node.type === 'class_declaration'
      || node.type === 'anonymous_class') return;
    const references = referenceGroupsFor(fileGlobalGuzzleClients);
    if (node.type === 'assignment_expression' || node.type === 'reference_assignment_expression') {
      if (straightLine) {
        const right = node.childForFieldName('right');
        if (right !== null) discoverFileGlobalGuzzleClients(right, true);
        applyAssignmentProvenance(node, fileGlobalGuzzleClients, references);
      } else invalidateWrites(node, fileGlobalGuzzleClients, references);
      return;
    }
    if (node.type === 'unset_statement' || node.type === 'foreach_statement') {
      invalidateWrites(node, fileGlobalGuzzleClients, references);
      return;
    }
    const childStraightLine = node.type === 'program'
      || node.type === 'namespace_definition'
      || (straightLine && (node.type === 'compound_statement'
        || node.type === 'expression_statement'
        || isTransparentGuzzleValueWrapper(node)));
    if (!childStraightLine && straightLine) {
      invalidateWrites(node, fileGlobalGuzzleClients, references);
      return;
    }
    for (const child of node.namedChildren) {
      if (child) discoverFileGlobalGuzzleClients(child, childStraightLine);
    }
  };
  discoverFileGlobalGuzzleClients(root);

  const visit = (node: Node, enclosing: string | null, inheritedGuzzleClients: Set<string>): void => {
    const opensScope = node.type === 'function_definition'
      || node.type === 'method_declaration'
      || node.type === 'anonymous_function'
      || node.type === 'arrow_function';
    const inheritedReferenceGroups = referenceGroupsFor(inheritedGuzzleClients);
    const guzzleClients = opensScope
      ? scopedGuzzleClients(node, inheritedGuzzleClients, file)
      : inheritedGuzzleClients;
    const referenceGroups = referenceGroupsFor(guzzleClients);
    if (opensScope) {
      projectReferenceGroups(byReferenceCaptureVariables(node), inheritedReferenceGroups, referenceGroups);
    }
    switch (node.type) {
      case 'class_declaration':
      case 'interface_declaration':
      case 'trait_declaration': {
        const nameNode = node.childForFieldName('name');
        const short = nameNode ? nameNode.text : '';
        if (short === '') break;
        const fqcn = file.namespace === '' ? short : `${file.namespace}\\${short}`;
        const qn = `${repo.repoBase}#${fqcn}`;
        repo.nodes.push({
          kind: 'class',
          name: short,
          qualifiedName: qn,
          filePath: file.abs,
          line: lineOf(node),
          lang: 'php',
          metadata: meta,
        });
        repo.edges.push({ from: file.fileRef, to: { kind: 'class', qualifiedName: qn }, relation: 'defines' });
        registerClass(repo, fqcn, qn);

        // extends / implements → deferred `inherits`
        for (const clause of node.namedChildren) {
          if (!clause) continue;
          if (clause.type !== 'base_clause' && clause.type !== 'class_interface_clause') continue;
          for (const target of clause.namedChildren) {
            if (!target || (target.type !== 'name' && target.type !== 'qualified_name')) continue;
            repo.deferred.push({
              from: { kind: 'class', qualifiedName: qn },
              relation: 'inherits',
              cls: { form: 'named', name: target.text },
              enclosing: fqcn,
              file,
              line: lineOf(clause),
            });
          }
        }

        for (const child of node.namedChildren) if (child) visit(child, fqcn, guzzleClients);
        return;
      }

      case 'assignment_expression':
      case 'reference_assignment_expression': {
        const right = node.childForFieldName('right');
        if (right !== null) visit(right, enclosing, guzzleClients);
        applyAssignmentProvenance(node, guzzleClients, referenceGroups);
        return;
      }

      case 'global_declaration': {
        const globals = new Set<string>();
        for (const child of node.namedChildren) if (child) collectTargetVariables(child, globals);
        for (const variable of globals) {
          guzzleClients.delete(variable);
          unlinkReference(variable, referenceGroups);
          if (fileGlobalGuzzleClients.has(variable)) guzzleClients.add(variable);
        }
        projectReferenceGroups(
          globals,
          referenceGroupsFor(fileGlobalGuzzleClients),
          referenceGroups,
        );
        return;
      }

      case 'foreach_statement': {
        const body = node.childForFieldName('body');
        const iterable = node.namedChild(0);
        if (iterable !== null) visit(iterable, enclosing, guzzleClients);
        const candidates = node.namedChildren.slice(1).filter((child) => child !== null && child !== body);
        const targets = new Set<string>();
        for (const candidate of candidates) collectTargetVariables(candidate, targets);
        setGuzzleProvenance(targets, false, guzzleClients, referenceGroups);
        if (body !== null) visit(body, enclosing, guzzleClients);
        return;
      }

      case 'unset_statement': {
        for (const child of node.namedChildren) {
          const variable = directVariableName(child);
          if (variable !== undefined) {
            guzzleClients.delete(variable);
            unlinkReference(variable, referenceGroups);
          }
        }
        break;
      }

      case 'method_declaration': {
        const nameNode = node.childForFieldName('name');
        const short = nameNode ? nameNode.text : '';
        if (short === '' || enclosing === null) break;
        const qn = `${repo.repoBase}#${enclosing}::${short}`;
        repo.methodQns.add(qn);
        repo.nodes.push({
          kind: 'function',
          name: short,
          qualifiedName: qn,
          filePath: file.abs,
          line: lineOf(node),
          lang: 'php',
          metadata: meta,
        });
        repo.edges.push({
          from: { kind: 'class', qualifiedName: `${repo.repoBase}#${enclosing}` },
          to: { kind: 'function', qualifiedName: qn },
          relation: 'defines',
        });
        break;
      }

      case 'function_definition': {
        const nameNode = node.childForFieldName('name');
        const short = nameNode ? nameNode.text : '';
        if (short === '') break;
        const fqName = file.namespace === '' ? short : `${file.namespace}\\${short}`;
        const qn = `${repo.repoBase}#${fqName}`;
        repo.methodQns.add(qn);
        repo.nodes.push({
          kind: 'function',
          name: short,
          qualifiedName: qn,
          filePath: file.abs,
          line: lineOf(node),
          lang: 'php',
          metadata: meta,
        });
        repo.edges.push({ from: file.fileRef, to: { kind: 'function', qualifiedName: qn }, relation: 'defines' });
        registerFunction(repo, fqName, qn);
        break;
      }

      case 'require_expression':
      case 'require_once_expression':
      case 'include_expression':
      case 'include_once_expression': {
        // Only literal-suffixed paths resolve; __DIR__ . '/x.php' is the common
        // shape, so match on the trailing literal and probe the filesystem.
        const literal = node.text.match(/['"]([^'"]+\.php)['"]/);
        const rel = literal?.[1];
        if (rel === undefined) break;
        const candidate = path.resolve(path.dirname(file.abs), rel.replace(/^\/+/, ''));
        if (fs.existsSync(candidate)) {
          const targetQName = qnameOf(fs.realpathSync.native(candidate));
          if (targetQName === null) break;
          repo.edges.push({
            from: file.fileRef,
            to: { kind: 'file', qualifiedName: targetQName },
            relation: 'imports',
            metadata: { line: lineOf(node) },
          });
        }
        break;
      }

      case 'function_call_expression': {
        const nameNode = node.childForFieldName('function');
        // `\add_action(...)` — legal and common inside a namespaced file — parses
        // its callee as `qualified_name`, not `name`. Accepting only `name` would
        // silently skip every root-namespace-qualified WP call.
        let called = '';
        let rootQualified = false;
        if (nameNode && (nameNode.type === 'name' || nameNode.type === 'qualified_name')) {
          rootQualified = nameNode.text.startsWith('\\');
          called = nameNode.text.replace(/^\\+/, '').toLowerCase();
        }
        // A namespaced same-name function is NOT the WP global; only a bare or
        // root-qualified name is.
        const localFunction = (file.namespace === '' ? called : `${file.namespace}\\${called}`).toLowerCase();
        const importedFunction = file.functionAliases.get(called);
        const importedGlobal = importedFunction?.toLowerCase() === called;
        const globalFunction = rootQualified
          || importedGlobal
          || (importedFunction === undefined && !declaredFunctions.has(localFunction));
        if (called !== '' && !called.includes('\\') && globalFunction) {
          handleWordPressCall(repo, file, node, called, enclosing, identity, skips);
          handlePhpHttpCall(repo, file, node, called, identity, skips, guzzleClients);
        }
        break;
      }

      case 'member_call_expression': {
        // Two DIFFERENT member-call families, and they need different guards.
        //
        // 1. $wpdb->query/prepare/… — must be receiver-checked. `->query` is an
        //    ordinary method name on countless objects, and matching the method
        //    alone would attribute any `$logger->query(...)` to a table read.
        // 2. $role->add_cap('x') / $role->remove_cap('x') — WordPress grants
        //    capabilities through a WP_Role member call, and the receiver is a
        //    local variable with no fixed name ($role, $r, $admin…). Requiring
        //    receiver 'wpdb' here would make the entire add_cap surface dead
        //    code, which is what an earlier revision did. `add_cap` is
        //    distinctive enough that the method name alone is a safe key.
        const method = node.childForFieldName('name')?.text ?? '';
        if (method === '') break;
        const recv = node.childForFieldName('object');
        const recvName =
          recv && recv.type === 'variable_name' ? (recv.namedChild(0)?.text ?? '') : '';
        const isWpdbCall = recvName === 'wpdb';
        const isCapCall = method === 'add_cap' || method === 'remove_cap';
        if (isWpdbCall || isCapCall) handleWordPressCall(repo, file, node, `->${method}`, enclosing, identity, skips);
        handlePhpHttpCall(repo, file, node, `->${method}`, identity, skips, guzzleClients);
        break;
      }

      case 'anonymous_class': {
        // A1 (execution-time amendment, finding 6e0d2006): methods of
        // `new class { … }` belong to no named class. Recursing with the
        // enclosing FQCN fabricates `Outer::method` nodes that then satisfy
        // resolveDeferred's methodQns existence check — a phantom listens_to
        // edge at extracted confidence. Recurse with NO enclosing scope:
        // its members are skipped like closures, never mis-attributed.
        for (const child of node.namedChildren) if (child) visit(child, null, new Set());
        return;
      }

      default:
        break;
    }
    for (const child of node.namedChildren) if (child) visit(child, enclosing, guzzleClients);
  };

  visit(root, null, new Set<string>());
}

/** Resolve every deferred reference against the completed repo tables (R5). */
function resolveDeferred(repo: RepoCtx): void {
  for (const ref of repo.deferred) {
    // Function-target refs resolve against the completed function index. Doing
    // this during the walk is order-dependent — see callbackOrigin's 'function'
    // case — so it happens here and only here.
    if (ref.fn !== undefined) {
      const candidates = repo.functionsByShort.get(ref.fn) ?? [];
      if (candidates.length !== 1) {
        if (candidates.length > 1) repo.tally.ambiguousShortNames++;
        else repo.tally.unresolvedCallbacks++;
        continue;
      }
      const only = candidates[0];
      if (only === undefined) continue;
      const fnRef: NodeRef = { kind: 'function', qualifiedName: only };
      repo.edges.push({
        from: ref.invert === true ? fnRef : ref.from,
        to: ref.invert === true ? ref.from : fnRef,
        relation: ref.relation,
        metadata: { line: ref.line },
      });
      continue;
    }

    const resolved = resolveClassName(ref.cls, ref.enclosing, ref.file, repo);
    if (!resolved) {
      repo.tally.unresolvedClasses++;
      continue;
    }
    const targetQn =
      ref.member === undefined
        ? `${repo.repoBase}#${resolved.fqcn}`
        : `${repo.repoBase}#${resolved.fqcn}::${ref.member}`;
    // A class that resolves but whose METHOD does not exist would otherwise be
    // emitted and silently dropped by the engine's endpoint resolver
    // (engine.ts:185-192) as a generic unresolved edge — invisible to the
    // callback tally the acceptance gate thresholds. Count it here instead.
    if (ref.member !== undefined && !repo.methodQns.has(targetQn)) {
      repo.tally.unresolvedCallbacks++;
      continue;
    }
    const resolvedRef: NodeRef = {
      kind: ref.member === undefined ? 'class' : 'function',
      qualifiedName: targetQn,
    };
    repo.edges.push({
      from: ref.invert === true ? resolvedRef : ref.from,
      to: ref.invert === true ? ref.from : resolvedRef,
      relation: ref.relation,
      confidence: resolved.confidence,
      metadata: { line: ref.line },
    });
  }
}

export const phpExtractor: GraphExtractor = {
  name: 'php',
  vocabulary: {
    kinds: ['file', 'function', 'class', 'hook', 'option', 'capability', 'shortcode', 'asset', 'wp_table', 'endpoint', 'scheduled_job', 'http_call'],
    relations: [
      'defines', 'imports', 'inherits', 'calls',
      'fires', 'listens_to', 'reads_option', 'writes_option',
      'serves_route', 'scheduled_by', 'secured_by', 'references_table', 'depends_on',
    ],
  },
  // `changedFiles` is deliberately NOT destructured or honoured. php is
  // registered as a full re-run on both the build and update paths (R10); a
  // partial walk would build the class/function tables from the changed file
  // alone, so `resolveDeferred` could not resolve any cross-file reference and
  // would emit nothing where the splice had already deleted the old edges.
  // Ignoring the field keeps that failure impossible even if a future change
  // wrongly enrols php in `update.ts`'s `splices` array.
  async extract({ repoPaths, excludes }): Promise<ExtractorOutput> {
    const parser = await parserFor('php');
    const allNodes: ExtractorOutput['nodes'] = [];
    const allEdges: ExtractorOutput['edges'] = [];
    const contractSkips = emptyContractSkips();
    const resolvedRepos = canonicalRegisteredRoots(repoPaths, { baseDir: process.cwd(), rejectRelative: true });
    const identities = new Map(resolvedRepos.map((repoRoot) => [repoRoot, serviceIdentity(repoRoot)]));
    const qnameOf = (absPath: string): string | null => {
      const owner = owningRegisteredRepo(absPath, resolvedRepos);
      if (owner === null) return null;
      const ownerIdentity = identities.get(owner);
      if (ownerIdentity === undefined) return null;
      const legacy = `${path.basename(owner)}/${path.relative(owner, absPath).split(path.sep).join('/')}`;
      return sourceQNameForPath(ownerIdentity.id, legacy, path.extname(absPath));
    };

    for (const repoRoot of resolvedRepos) {
      const identity = identities.get(repoRoot);
      if (identity === undefined) continue;
      const repo: RepoCtx = {
        repoBase: serviceSourceQName(identity.id, path.basename(repoRoot)),
        repoRoot,
        nodes: [],
        edges: [],
        classByFqcn: new Map(),
        classesByShort: new Map(),
        functionsByShort: new Map(),
        methodQns: new Set(),
        deferred: [],
        constants: new Map(),
        tally: newTally(),
      };
      const parsedFiles: Array<{ file: FileCtx; root: Node }> = [];

      for (const abs of listOwnedRepoFiles(repoRoot, resolvedRepos, PHP_EXT, excludes ?? [])) {
        let text: string;
        try {
          text = fs.readFileSync(abs, 'utf8');
        } catch {
          continue;
        }
        let root: Node;
        try {
          const tree = parser.parse(text);
          if (!tree) continue;
          root = tree.rootNode;
        } catch {
          continue; // unparseable file is skipped, never fatal
        }

        const relPosix = path.relative(repoRoot, abs).split(path.sep).join('/');
        const qn = `${repo.repoBase}/${relPosix}`;
        const isTest = isTestPath(relPosix);
        const useMaps = readUseMaps(root);
        const file: FileCtx = {
          abs,
          qn,
          fileRef: { kind: 'file', qualifiedName: qn } satisfies NodeRef,
          namespace: readNamespace(root),
          ...useMaps,
          isTest,
        };
        repo.nodes.push({
          kind: 'file',
          name: path.basename(abs),
          qualifiedName: qn,
          filePath: abs,
          lang: 'php',
          contentHash: hashContent(text),
          metadata: isTest ? { test: true } : {},
        });
        parsedFiles.push({ file, root });
      }

      const declaredFunctions = new Set<string>();
      const collectDeclaredFunctions = (node: Node, namespace: string): void => {
        if (node.type === 'function_definition') {
          const short = node.childForFieldName('name')?.text ?? '';
          if (short !== '') declaredFunctions.add((namespace === '' ? short : `${namespace}\\${short}`).toLowerCase());
        }
        for (const child of node.namedChildren) if (child) collectDeclaredFunctions(child, namespace);
      };
      for (const parsed of parsedFiles) collectDeclaredFunctions(parsed.root, parsed.file.namespace);
      for (const parsed of parsedFiles) {
        prescanConstants(repo, parsed.file, parsed.root);
        walkFile(repo, parsed.file, parsed.root, identity, contractSkips, qnameOf, declaredFunctions);
      }

      resolveDeferred(repo);
      allNodes.push(...repo.nodes);
      allEdges.push(...repo.edges);
      // ALWAYS emitted, never conditional, and in a fixed machine-parseable
      // shape. A line that only appears when something went wrong cannot be
      // asserted against a threshold: the acceptance gate could not tell "zero
      // unresolved" from "the extractor never ran". Task 8 greps this exact
      // prefix, so do not reword it.
      console.warn(
        `php-tally ${path.basename(repo.repoRoot)} unresolved_callbacks=${repo.tally.unresolvedCallbacks} ` +
        `unresolved_classes=${repo.tally.unresolvedClasses} ` +
        `ambiguous_short_names=${repo.tally.ambiguousShortNames} ` +
        `dynamic_names=${repo.tally.dynamicNames}`
      );
    }

    return { nodes: allNodes, edges: allEdges, contractSkips };
  },
};
