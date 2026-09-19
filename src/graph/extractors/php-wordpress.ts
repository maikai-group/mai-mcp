// WordPress semantics for the php extractor (plan 33). Pure handlers over an
// already-parsed tree — no file walking, no I/O — so they are testable by
// feeding a parsed fixture and asserting the emitted nodes/edges.
//
// Rendezvous nodes (hook/option/capability/shortcode/asset) are emitted with NO
// filePath: engine.ts:292 splices by file_path, so a file-owned hook node would
// cascade away other files' live listens_to edges. See registry SHARED_KINDS.
import type { Node } from 'web-tree-sitter';
import {
  endpointQName,
  normalizeHttpMethod,
  normalizeRoutePath,
  type HttpMethod,
  type ServiceIdentity,
} from '../contracts.js';
import type { EdgeConfidence } from '../registry.js';
import type { ContractSkipTallies, NodeRef } from '../types.js';
import {
  argAt,
  callbackFromArg,
  fileOwnedMeta,
  lineOf,
  rendezvousNode,
  stringLiteral,
  surfaceArg,
  type FileCtx,
  type RepoCtx,
} from './php-ast.js';

const HOOK_REGISTER = new Set(['add_action', 'add_filter']);
const HOOK_FIRE = new Set(['do_action', 'do_action_ref_array', 'apply_filters', 'apply_filters_ref_array']);
const OPTION_READ = new Set(['get_option', 'get_site_option']);
const OPTION_WRITE = new Set(['update_option', 'add_option', 'delete_option', 'update_site_option']);
const CAP_CHECK = new Set(['current_user_can', 'user_can', 'author_can']);
/** Member-call capability grants. Keyed with the `->` prefix the walker emits,
 * because WordPress grants through `$role->add_cap('x')` — a WP_Role member
 * call whose receiver variable has no fixed name. Bare `add_cap` never appears
 * as a global function call, so the `->` form is the only reachable one. */
const CAP_GRANT = new Set(['->add_cap', '->remove_cap']);
const ASSET_ENQUEUE = new Set(['wp_enqueue_script', 'wp_enqueue_style', 'wp_register_script', 'wp_register_style']);
/** 0-based index of $menu_slug per WordPress signature — known, never guessed. */
const ADMIN_PAGE_SLUG_INDEX = new Map<string, number>([
  ['add_menu_page', 3],
  ['add_submenu_page', 4],
  ['add_options_page', 3],
  ['add_management_page', 3],
]);
const CRON_SCHEDULE = new Set(['wp_schedule_event', 'wp_schedule_single_event']);
const WPDB_QUERY = new Set(['->query', '->get_row', '->get_var', '->get_results', '->get_col', '->prepare', '->insert', '->update', '->delete', '->replace']);

function resolvePhpClassName(raw: string, file: FileCtx): string {
  const rootQualified = raw.startsWith('\\');
  const written = raw.replace(/^\\+/, '');
  if (rootQualified) return written;
  const [head = '', ...tail] = written.split('\\');
  const imported = file.aliases.get(head.toLowerCase());
  if (imported !== undefined) return tail.length === 0 ? imported : `${imported}\\${tail.join('\\')}`;
  return file.namespace === '' ? written : `${file.namespace}\\${written}`;
}

function restMethodValue(node: Node | null, file: FileCtx): HttpMethod[] | null {
  if (node === null) return null;
  const literal = stringLiteral(node);
  if (literal !== null) {
    const methods: HttpMethod[] = [];
    for (const part of literal.split(',').map((value) => value.trim()).filter(Boolean)) {
      const method = normalizeHttpMethod(part);
      if (method === null) return [];
      methods.push(method);
    }
    return [...new Set(methods)];
  }
  if (node.type === 'array_creation_expression') {
    const methods: HttpMethod[] = [];
    for (const item of node.namedChildren) {
      if (!item || item.type !== 'array_element_initializer') continue;
      const value = item.namedChild(item.namedChildCount - 1);
      const nested = restMethodValue(value, file);
      if (nested === null) return null;
      methods.push(...nested);
    }
    return [...new Set(methods)];
  }
  if (node.type === 'class_constant_access_expression') {
    const owner = resolvePhpClassName(node.namedChild(0)?.text ?? '', file);
    if (owner.toLowerCase() !== 'wp_rest_server') return [];
    const constant = node.namedChild(node.namedChildCount - 1)?.text ?? '';
    if (constant === 'READABLE') return ['GET'];
    if (constant === 'CREATABLE') return ['POST'];
    if (constant === 'EDITABLE') return ['POST', 'PUT', 'PATCH'];
    if (constant === 'DELETABLE') return ['DELETE'];
    if (constant === 'ALLMETHODS') return ['ANY'];
  }
  return null;
}

function routeConfigMethods(config: Node, file: FileCtx): { dynamic: boolean; methods: HttpMethod[] } {
  if (config.type !== 'array_creation_expression') return { dynamic: true, methods: [] };
  let result: { present: boolean; value: Node | null } = { present: false, value: null };
  for (const item of config.namedChildren) {
    if (!item || item.type !== 'array_element_initializer') continue;
    if (item.namedChildCount === 1) {
      if (item.namedChild(0)?.type === 'variadic_unpacking') result = { present: true, value: null };
      continue;
    }
    const key = item.namedChild(0);
    const literal = stringLiteral(key);
    if (literal === 'methods') result = { present: true, value: item.namedChild(item.namedChildCount - 1) };
    else if (literal !== null
      || key?.type === 'integer'
      || key?.type === 'float'
      || key?.type === 'boolean'
      || key?.type === 'null'
      || key?.type === 'unary_op_expression'
      || ((key?.type === 'string' || key?.type === 'encapsed_string') && key.namedChildCount === 0)) {
      continue;
    } else result = { present: true, value: null };
  }
  if (!result.present) return { dynamic: false, methods: ['ANY'] };
  const methods = restMethodValue(result.value, file);
  return methods === null ? { dynamic: true, methods: [] } : { dynamic: false, methods };
}

interface WordPressNumericRouteKey {
  identity: string;
  integerValue?: bigint;
}

const PHP_INT_MIN = -9223372036854775808n;
const PHP_INT_MAX = 9223372036854775807n;
const PHP_INT_MODULUS = 18446744073709551616n;

function integerRouteKey(value: bigint): WordPressNumericRouteKey {
  let normalized = value % PHP_INT_MODULUS;
  if (normalized < 0n) normalized += PHP_INT_MODULUS;
  if (normalized > PHP_INT_MAX) normalized -= PHP_INT_MODULUS;
  if (normalized === 0n) normalized = 0n;
  return { identity: `integer:${normalized}`, integerValue: normalized };
}

function parsePhpIntegerLiteral(raw: string): bigint | null {
  let text = raw.replaceAll('_', '').replaceAll(/\s/g, '');
  let sign = 1n;
  if (text.startsWith('-')) {
    sign = -1n;
    text = text.slice(1);
  } else if (text.startsWith('+')) text = text.slice(1);
  let digits = text;
  let radix = 10;
  if (/^0[xX][0-9a-fA-F]+$/.test(text)) {
    digits = text.slice(2);
    radix = 16;
  } else if (/^0[bB][01]+$/.test(text)) {
    digits = text.slice(2);
    radix = 2;
  } else if (/^0[oO][0-7]+$/.test(text)) {
    digits = text.slice(2);
    radix = 8;
  } else if (/^0[0-7]+$/.test(text) && text.length > 1) {
    digits = text.slice(1);
    radix = 8;
  } else if (!/^(?:0|[1-9][0-9]*)$/.test(text)) return null;
  const prefixes = new Map([[2, '0b'], [8, '0o'], [10, ''], [16, '0x']]);
  const prefix = prefixes.get(radix);
  if (prefix === undefined) return null;
  try {
    return sign * BigInt(`${prefix}${digits === '' ? '0' : digits}`);
  } catch {
    return null;
  }
}

function phpIntegerLiteralRouteKey(raw: string): WordPressNumericRouteKey | null {
  const exact = parsePhpIntegerLiteral(raw);
  if (exact === null) return null;
  if (exact >= PHP_INT_MIN && exact <= PHP_INT_MAX) return integerRouteKey(exact);
  const rounded = Number(exact);
  return Number.isFinite(rounded) ? integerRouteKey(BigInt(Math.trunc(rounded))) : null;
}

function wordPressNumericRouteKey(node: Node | null): WordPressNumericRouteKey | null {
  if (node?.type === 'integer') return phpIntegerLiteralRouteKey(node.text);
  if (node?.type === 'float') {
    const value = Math.trunc(Number(node.text.replaceAll('_', '')));
    return Number.isFinite(value) ? integerRouteKey(BigInt(value)) : null;
  }
  if (node?.type === 'boolean') return integerRouteKey(node.text.toLowerCase() === 'true' ? 1n : 0n);
  if (node?.type === 'unary_op_expression') {
    const argument = node.childForFieldName('argument');
    if (argument?.type === 'integer') {
      const unsigned = parsePhpIntegerLiteral(argument.text);
      if (unsigned === null) return null;
      const value = node.text.trimStart().startsWith('-') ? -unsigned : unsigned;
      if (value >= PHP_INT_MIN && value <= PHP_INT_MAX) return integerRouteKey(value);
      const rounded = Number(value);
      return Number.isFinite(rounded) ? integerRouteKey(BigInt(Math.trunc(rounded))) : null;
    }
    if (argument?.type === 'float') {
      const value = Math.trunc(Number(argument.text.replaceAll('_', '')));
      if (!Number.isFinite(value)) return null;
      return integerRouteKey(BigInt(node.text.trimStart().startsWith('-') ? -value : value));
    }
    return null;
  }
  const literal = stringLiteral(node);
  if (literal === null) return null;
  if (!/^\s*[+-]?(?:(?:[0-9]+(?:\.[0-9]*)?)|(?:\.[0-9]+))(?:[eE][+-]?[0-9]+)?\s*$/.test(literal)) return null;
  if (/^(?:0|-[1-9][0-9]*|[1-9][0-9]*)$/.test(literal)) {
    const value = parsePhpIntegerLiteral(literal);
    const coerced = value === null || value < PHP_INT_MIN || value > PHP_INT_MAX
      ? null
      : integerRouteKey(value);
    if (coerced !== null) return coerced;
  }
  return { identity: `numeric-string:${literal}` };
}

function isWordPressNumericRouteKey(node: Node | null): boolean {
  return wordPressNumericRouteKey(node) !== null;
}

function restMethods(call: Node, file: FileCtx): { dynamic: boolean; methods: HttpMethod[] } {
  const config = argAt(call, 2);
  if (config === null) return { dynamic: false, methods: ['ANY'] };
  if (config.type !== 'array_creation_expression') return { dynamic: true, methods: [] };
  const direct = routeConfigMethods(config, file);
  const items = config.namedChildren.filter((item): item is Node =>
    item !== null && item.type === 'array_element_initializer');
  const hasMethodsKey = items.some((item) => stringLiteral(item.namedChild(0)) === 'methods');
  if (hasMethodsKey || items.length === 0) return direct;
  const numericItems = new Map<string, Node | null>();
  // PHP 8.3+ advances an implicit array key from the greatest integer key even when it is negative.
  let greatestIntegerKey: bigint | undefined;
  let nextIndex = 0n;
  let automaticIndexAvailable = true;
  let unknownDefinition = false;
  for (const item of items) {
    if (item.namedChildCount === 1) {
      const value = item.namedChild(0);
      if (value?.type === 'variadic_unpacking') unknownDefinition = true;
      else {
        if (!automaticIndexAvailable) {
          unknownDefinition = true;
          continue;
        }
        numericItems.set(`integer:${nextIndex}`, value);
        greatestIntegerKey = greatestIntegerKey === undefined || nextIndex > greatestIntegerKey
          ? nextIndex
          : greatestIntegerKey;
        nextIndex++;
        automaticIndexAvailable = greatestIntegerKey < PHP_INT_MAX;
      }
      continue;
    }
    const key = wordPressNumericRouteKey(item.namedChild(0));
    if (key === null) continue;
    numericItems.set(key.identity, item.namedChild(item.namedChildCount - 1));
    if (key.integerValue !== undefined
      && (greatestIntegerKey === undefined || key.integerValue > greatestIntegerKey)) {
      greatestIntegerKey = key.integerValue;
      automaticIndexAvailable = greatestIntegerKey < PHP_INT_MAX;
      if (automaticIndexAvailable) nextIndex = greatestIntegerKey + 1n;
    }
  }
  const unsupportedOptions = items.filter((item) => item.namedChildCount > 1
    && !isWordPressNumericRouteKey(item.namedChild(0))
    && stringLiteral(item.namedChild(0)) !== 'args');
  if (numericItems.size === 0 && !unknownDefinition) return direct;
  if (unsupportedOptions.length > 0 || unknownDefinition) return { dynamic: true, methods: [] };
  const methods: HttpMethod[] = [];
  for (const item of numericItems.values()) {
    if (item === null) return { dynamic: true, methods: [] };
    const result = routeConfigMethods(item, file);
    if (result.dynamic) return result;
    methods.push(...result.methods);
  }
  return { dynamic: false, methods: [...new Set(methods)] };
}

function conf(dynamic: boolean): EdgeConfidence {
  return dynamic ? 'inferred' : 'extracted';
}

/**
 * Resolve a callback argument to the node that should own the outgoing edge.
 * Returns the file ref for closures (anonymous, but the file genuinely owns it)
 * and null when nothing statically resolves — tallied by the caller, never guessed.
 */
function callbackOrigin(
  repo: RepoCtx,
  file: FileCtx,
  call: Node,
  argIndex: number,
  enclosing: string | null
): NodeRef | null {
  const cb = callbackFromArg(argAt(call, argIndex));
  switch (cb.form) {
    case 'closure':
      return file.fileRef;
    case 'function':
      // NOT resolved here. `functionsByShort` is populated as the walk visits
      // `function_definition` nodes, so an inline lookup resolves against a
      // half-built index and depends on `git ls-files` byte order: a callback in
      // modules/listeners.php registering a function declared in
      // modules/recovery.php sees an empty index and silently emits nothing.
      // Uniqueness of the short name does not help — the defect is ordering.
      // Deferred to `resolveDeferred` by the caller, same as named classes.
      return null;
    case 'class-method':
      // EVERY class-method callback defers — `$this`/`self::` included. Resolving
      // those inline skipped `resolveDeferred`'s methodQns existence check, so a
      // callback naming a method its class does not declare emitted an edge the
      // engine dropped generically (engine.ts:190) — invisible to the
      // unresolved-callback tally that Step 4b bounds, on the path carrying ~95%
      // of registrations. The check cannot move inline instead: `methodQns` is
      // still being filled during the walk, and a method is routinely declared
      // after the register() that names it. Measured 2026-08-22: deferring these
      // leaves listens_to unchanged at 743 on the measured consumer repo.
      return null;
    default:
      return null;
  }
}

/**
 * Callbacks that cannot resolve until the whole repo has been walked (R5):
 * named classes AND plain-string functions. Both index into tables that are
 * still being filled during the walk, so both defer. Returns true when a
 * deferred record was pushed.
 */
function deferNamedCallback(
  repo: RepoCtx,
  file: FileCtx,
  call: Node,
  argIndex: number,
  enclosing: string | null,
  hookRef: NodeRef
): boolean {
  const cb = callbackFromArg(argAt(call, argIndex));

  if (cb.form === 'function') {
    repo.deferred.push({
      from: hookRef,
      relation: 'listens_to',
      cls: { form: 'named', name: '' }, // unused on the fn path
      fn: cb.fn,
      enclosing,
      file,
      line: lineOf(call),
      invert: true,
    });
    return true;
  }

  if (cb.form !== 'class-method') return false;
  // `$this`/`self::` outside any class has nothing to resolve against.
  if (cb.cls.form !== 'named' && enclosing === null) return false;
  // The edge runs callback ──listens_to──▶ hook, but at walk time the hook is
  // the end we know and the callback's class is what needs the completed class
  // table. `invert: true` makes the resolver put the resolved method on the FROM
  // side; without it every hook edge would point backwards.
  repo.deferred.push({
    from: hookRef,
    relation: 'listens_to',
    cls: cb.cls,
    member: cb.method,
    enclosing,
    file,
    line: lineOf(call),
    invert: true,
  });
  return true;
}

export function handleWordPressCall(
  repo: RepoCtx,
  file: FileCtx,
  call: Node,
  called: string,
  enclosing: string | null,
  identity: ServiceIdentity,
  contractSkips: ContractSkipTallies,
): void {
  // ---- hooks: registration (listens_to) ------------------------------------
  if (HOOK_REGISTER.has(called)) {
    const nameArg = surfaceArg(repo, call, 0, enclosing);
    if (!nameArg) {
      repo.tally.dynamicNames++;
      return;
    }
    if (nameArg.dynamic) repo.tally.dynamicNames++;
    const hookQn = `hook:${nameArg.value}`;
    repo.nodes.push(rendezvousNode('hook', nameArg.value, hookQn));
    const hookRef: NodeRef = { kind: 'hook', qualifiedName: hookQn };

    const origin = callbackOrigin(repo, file, call, 1, enclosing);
    if (origin) {
      repo.edges.push({
        from: origin,
        to: hookRef,
        relation: 'listens_to',
        confidence: conf(nameArg.dynamic),
        metadata: { line: lineOf(call), via: called },
      });
    } else if (!deferNamedCallback(repo, file, call, 1, enclosing, hookRef)) {
      repo.tally.unresolvedCallbacks++;
    }

    // wp_ajax_* / admin_post_* hook names are HTTP entry points too (spec §3.1).
    const ajax = /^wp_ajax_(nopriv_)?(.+)$/.exec(nameArg.value);
    const adminPost = /^admin_post_(nopriv_)?(.+)$/.exec(nameArg.value);
    const routeName = ajax ? `wp-ajax/${ajax[2]}` : adminPost ? `admin-post/${adminPost[2]}` : null;
    if (routeName !== null) {
      const routeQn = `route:${routeName}`;
      repo.nodes.push({
        kind: 'endpoint',
        name: routeName,
        qualifiedName: routeQn,
        filePath: file.abs,
        line: lineOf(call),
        lang: 'php',
        metadata: fileOwnedMeta(file),
      });
      repo.edges.push({
        from: file.fileRef,
        to: { kind: 'endpoint', qualifiedName: routeQn },
        relation: 'serves_route',
        confidence: conf(nameArg.dynamic),
      });
    }
    return;
  }

  // ---- hooks: firing (fires) ----------------------------------------------
  if (HOOK_FIRE.has(called)) {
    const nameArg = surfaceArg(repo, call, 0, enclosing);
    if (!nameArg) {
      repo.tally.dynamicNames++;
      return;
    }
    if (nameArg.dynamic) repo.tally.dynamicNames++;
    const hookQn = `hook:${nameArg.value}`;
    repo.nodes.push(rendezvousNode('hook', nameArg.value, hookQn));
    repo.edges.push({
      from: file.fileRef,
      to: { kind: 'hook', qualifiedName: hookQn },
      relation: 'fires',
      confidence: conf(nameArg.dynamic),
      metadata: { line: lineOf(call), via: called },
    });
    return;
  }

  // ---- REST routes ---------------------------------------------------------
  if (called === 'register_rest_route') {
    const ns = surfaceArg(repo, call, 0, enclosing);
    const route = surfaceArg(repo, call, 1, enclosing);
    if (!ns || !route || ns.dynamic || route.dynamic) {
      contractSkips.dynamic_http_route++;
      return;
    }
    const methodResult = restMethods(call, file);
    if (methodResult.dynamic) {
      contractSkips.dynamic_http_method++;
      return;
    }
    const normalizedRoute = normalizeRoutePath(`/${ns.value.replace(/\/$/, '')}/${route.value.replace(/^\//, '')}`);
    if (normalizedRoute === null) return;
    for (const method of methodResult.methods) {
      const qn = endpointQName(identity.id, method, normalizedRoute);
      repo.nodes.push({
        kind: 'endpoint',
        name: `${method} ${normalizedRoute}`,
        qualifiedName: qn,
        line: lineOf(call),
        lang: 'php',
        metadata: {
          contract: 'http-endpoint-v1',
          service_id: identity.id,
          service_aliases: identity.aliases,
          method,
          path: normalizedRoute,
        },
      });
      repo.edges.push({
        from: file.fileRef,
        to: { kind: 'endpoint', qualifiedName: qn },
        relation: 'serves_route',
        metadata: { line: lineOf(call) },
      });
    }
    return;
  }

  // ---- admin pages ---------------------------------------------------------
  const slugIndex = ADMIN_PAGE_SLUG_INDEX.get(called);
  if (slugIndex !== undefined) {
    // The slug index is KNOWN per function, so it is read directly. A previous
    // revision scanned from index 2 for the first slug-shaped literal, which
    // always landed on the CAPABILITY argument ('manage_options') — collapsing
    // every admin page in the repo into one endpoint node. WordPress signatures:
    //   add_menu_page($page_title, $menu_title, $capability, $menu_slug, …)      → 3
    //   add_submenu_page($parent, $page_title, $menu_title, $cap, $menu_slug, …) → 4
    //   add_options_page/add_management_page($page, $menu, $cap, $menu_slug, …)  → 3
    // Title args are routinely __()-wrapped, so a shape heuristic cannot
    // distinguish them from a slug — the index must be known, never guessed.
    const slug = surfaceArg(repo, call, slugIndex, enclosing);
    if (!slug || slug.dynamic || slug.value === '') {
      repo.tally.dynamicNames++;
      return;
    }
    const label = `wp-admin/admin.php?page=${slug.value}`;
    const qn = `route:${label}`;
    repo.nodes.push({
      kind: 'endpoint', name: label, qualifiedName: qn,
      filePath: file.abs, line: lineOf(call), lang: 'php',
      metadata: fileOwnedMeta(file),
    });
    repo.edges.push({
      from: file.fileRef, to: { kind: 'endpoint', qualifiedName: qn },
      relation: 'serves_route', metadata: { line: lineOf(call), via: called },
    });
    return;
  }

  // ---- cron ----------------------------------------------------------------
  if (CRON_SCHEDULE.has(called)) {
    // wp_schedule_event(timestamp, recurrence, hook); wp_schedule_single_event(timestamp, hook).
    const hookArg = surfaceArg(repo, call, called === 'wp_schedule_event' ? 2 : 1, enclosing);
    if (!hookArg) {
      repo.tally.dynamicNames++;
      return;
    }
    const jobQn = `cron:${hookArg.value}`;
    repo.nodes.push({
      kind: 'scheduled_job', name: hookArg.value, qualifiedName: jobQn,
      filePath: file.abs, line: lineOf(call), lang: 'php',
      metadata: fileOwnedMeta(file),
    });
    repo.edges.push({
      from: { kind: 'hook', qualifiedName: `hook:${hookArg.value}` },
      to: { kind: 'scheduled_job', qualifiedName: jobQn },
      relation: 'scheduled_by',
      confidence: conf(hookArg.dynamic),
      metadata: { line: lineOf(call) },
    });
    repo.nodes.push(rendezvousNode('hook', hookArg.value, `hook:${hookArg.value}`));
    return;
  }

  // ---- shortcodes ----------------------------------------------------------
  if (called === 'add_shortcode') {
    const tag = surfaceArg(repo, call, 0, enclosing);
    if (!tag) {
      repo.tally.dynamicNames++;
      return;
    }
    const qn = `shortcode:${tag.value}`;
    repo.nodes.push(rendezvousNode('shortcode', tag.value, qn));
    const scRef: NodeRef = { kind: 'shortcode', qualifiedName: qn };
    const origin = callbackOrigin(repo, file, call, 1, enclosing);
    if (origin) {
      repo.edges.push({
        from: origin,
        to: scRef,
        relation: 'listens_to',
        confidence: conf(tag.dynamic),
        metadata: { line: lineOf(call) },
      });
    } else if (!deferNamedCallback(repo, file, call, 1, enclosing, scRef)) {
      // No silent `?? file.fileRef` fallback: attributing an unresolved callback
      // to the registering file invents an edge that looks resolved. Tally it.
      repo.tally.unresolvedCallbacks++;
    }
    return;
  }

  // ---- options -------------------------------------------------------------
  if (OPTION_READ.has(called) || OPTION_WRITE.has(called)) {
    const key = surfaceArg(repo, call, 0, enclosing);
    if (!key) {
      repo.tally.dynamicNames++;
      return;
    }
    const qn = `option:${key.value}`;
    repo.nodes.push(rendezvousNode('option', key.value, qn));
    repo.edges.push({
      from: file.fileRef,
      to: { kind: 'option', qualifiedName: qn },
      relation: OPTION_READ.has(called) ? 'reads_option' : 'writes_option',
      confidence: conf(key.dynamic),
      metadata: { line: lineOf(call), via: called },
    });
    return;
  }

  // ---- capabilities --------------------------------------------------------
  if (CAP_CHECK.has(called) || CAP_GRANT.has(called)) {
    // current_user_can(cap) → 0; user_can/author_can($user, cap) → 1;
    // $role->add_cap(cap) / ->remove_cap(cap) → 0.
    const argIndex = called === 'current_user_can' || CAP_GRANT.has(called) ? 0 : 1;
    const cap = surfaceArg(repo, call, argIndex, enclosing);
    if (!cap) {
      repo.tally.dynamicNames++;
      return;
    }
    const qn = `cap:${cap.value}`;
    repo.nodes.push(rendezvousNode('capability', cap.value, qn));
    repo.edges.push({
      from: file.fileRef,
      to: { kind: 'capability', qualifiedName: qn },
      relation: 'secured_by',
      confidence: conf(cap.dynamic),
      metadata: { line: lineOf(call), via: called },
    });
    return;
  }

  // ---- assets --------------------------------------------------------------
  if (ASSET_ENQUEUE.has(called)) {
    const handle = surfaceArg(repo, call, 0, enclosing);
    if (!handle) {
      repo.tally.dynamicNames++;
      return;
    }
    const qn = `asset:${handle.value}`;
    repo.nodes.push(rendezvousNode('asset', handle.value, qn));
    repo.edges.push({
      from: file.fileRef,
      to: { kind: 'asset', qualifiedName: qn },
      relation: 'depends_on',
      confidence: conf(handle.dynamic),
      metadata: { line: lineOf(call), via: called },
    });
    // $deps array (arg 2) → asset ──depends_on──▶ asset
    const deps = argAt(call, 2);
    if (deps && deps.type === 'array_creation_expression') {
      for (const item of deps.namedChildren) {
        if (!item || item.type !== 'array_element_initializer') continue;
        const dep = stringLiteral(item.namedChild(0));
        if (dep === null || dep === '') continue;
        const depQn = `asset:${dep}`;
        repo.nodes.push(rendezvousNode('asset', dep, depQn));
        repo.edges.push({
          from: { kind: 'asset', qualifiedName: qn },
          to: { kind: 'asset', qualifiedName: depQn },
          relation: 'depends_on',
          metadata: { line: lineOf(call) },
        });
      }
    }
    return;
  }

  // ---- $wpdb table references → php-owned wp_table nodes (R8) --------------
  //
  // These are NOT db-owned `table` nodes and must never pretend to be. A static
  // reader cannot know a WordPress table's physical name: `$wpdb->prefix` is
  // install-configurable, so `{$wpdb->prefix}acmeshop_tips` is `wp_acmeshop_tips`
  // on one install and `xyz_acmeshop_tips` on another. Separately, the db
  // extractor speaks PostgreSQL and MySQL (plan 34), but never THIS install's DB and
  // names tables `schema.table`, while a WordPress install runs MySQL — so a `public.<x>`
  // target would be wrong twice over and would never resolve.
  //
  // What PHP genuinely knows is the LOGICAL suffix, so that is what it emits:
  // a `wp_table` rendezvous node keyed `wptable:<suffix>`. Same shape as
  // shell.ts's `env:` nodes, which exist with no environment introspection.
  // The wp-prefix linker (plan 34) joins these to MySQL-introspected tables by prefix.
  if (WPDB_QUERY.has(called)) {
    const sqlArg = argAt(call, 0);
    if (!sqlArg) return;
    // {$wpdb->prefix}acmeshop_tips → the string_content immediately after the
    // member_access_expression is the un-prefixed suffix (spike-verified).
    if (sqlArg.type === 'encapsed_string') {
      const parts = sqlArg.namedChildren.filter((c): c is Node => c !== null);
      for (let i = 0; i < parts.length - 1; i++) {
        const cur = parts[i];
        const next = parts[i + 1];
        if (!cur || !next) continue;
        if (cur.type !== 'member_access_expression' || next.type !== 'string_content') continue;
        if (!/->\s*(prefix|base_prefix)$/.test(cur.text.replace(/\s+/g, ''))) continue;
        const suffix = /^([a-z0-9_]+)/i.exec(next.text)?.[1];
        if (suffix === undefined || suffix === '') continue;
        const key = suffix.toLowerCase();
        const qn = `wptable:${key}`;
        repo.nodes.push(rendezvousNode('wp_table', key, qn));
        repo.edges.push({
          from: file.fileRef,
          to: { kind: 'wp_table', qualifiedName: qn },
          relation: 'references_table',
          confidence: 'inferred',
          metadata: { line: lineOf(call), via: 'wpdb-prefix', unprefixed: true },
        });
      }
    }
    return;
  }
}
