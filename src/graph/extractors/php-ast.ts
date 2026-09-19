// Shared PHP AST readers for the php extractor (plan 33). Both php.ts
// (structure) and php-wordpress.ts (WP semantics) read arguments, string
// literals and callback shapes the same way; duplicating these readers is the
// drift failure mode, so they live here.
//
// Node type names below are verified against tree-sitter-php@0.24.2
// (spike 2026-08-19), not inferred:
//   function_call_expression > name , arguments > argument
//   string > string_content                     (plain literal)
//   encapsed_string > string_content | variable_name | member_access_expression
//   array_creation_expression > array_element_initializer
//   class_constant_access_expression > (name | qualified_name | relative_scope) + name
//   namespace_use_declaration > namespace_use_clause > qualified_name [+ alias name]
//   anonymous_function                          (closure)
import path from 'node:path';
import type { Node } from 'web-tree-sitter';
import type { EdgeConfidence, GraphRelation } from '../registry.js';
import type { ExtractedEdge, ExtractedNode, NodeRef } from '../types.js';

/** A class reference exactly as written, before namespace resolution. */
export interface RawClassRef {
  /** `this` → enclosing class; `relative` → self/static/parent; `named` → written name. */
  form: 'this' | 'relative' | 'named';
  /** For `relative`: 'self' | 'static' | 'parent'. For `named`: the written name. */
  name: string;
}

/** A callback argument as written. */
export type RawCallback =
  | { form: 'class-method'; cls: RawClassRef; method: string }
  | { form: 'function'; fn: string }
  | { form: 'closure' }
  | { form: 'unresolved' };

/** Per-file resolution context. */
export interface FileCtx {
  abs: string;
  /** `${repoBase}/${relPosix}` */
  qn: string;
  fileRef: NodeRef;
  /** e.g. 'AcmeShop\\Core', or '' at global scope. */
  namespace: string;
  /** lowercase class alias/short name → FQCN, from class `use` declarations. */
  aliases: Map<string, string>;
  /** lowercase local function alias → imported function identity. */
  functionAliases: Map<string, string>;
  /** case-sensitive local constant alias → imported constant identity. */
  constantAliases: Map<string, string>;
  isTest: boolean;
}

/** A reference that cannot be resolved until the whole repo has been walked. */
export interface DeferredRef {
  /** The known end of the edge. With `invert`, this becomes the TO side. */
  from: NodeRef;
  relation: GraphRelation;
  cls: RawClassRef;
  /** Method name when targeting a method; omitted when targeting the class. */
  member?: string;
  /** FQCN of the class enclosing the reference, for `this`/self/static. */
  enclosing: string | null;
  file: FileCtx;
  line: number;
  /**
   * Resolve against `functionsByShort` instead of the class tables. Set for a
   * plain-string function callback; `cls`/`member` are ignored when present.
   * Function callbacks MUST defer for the same reason class callbacks do — see
   * the ordering note on `RepoCtx.functionsByShort`.
   */
  fn?: string;
  /**
   * Emit `resolved ──rel──▶ from` instead of `from ──rel──▶ resolved`.
   * Required for `listens_to`: the edge runs callback→hook, but the hook is the
   * end we know at walk time and the callback class is what needs resolving.
   * Without this the hook would become the edge's source and every hook graph
   * would point backwards.
   */
  invert?: boolean;
}

export interface PhpTally {
  unresolvedCallbacks: number;
  unresolvedClasses: number;
  ambiguousShortNames: number;
  dynamicNames: number;
}

/** Per-repo accumulator. */
export interface RepoCtx {
  repoBase: string;
  repoRoot: string;
  nodes: ExtractedNode[];
  edges: ExtractedEdge[];
  /** FQCN → node qualifiedName. */
  classByFqcn: Map<string, string>;
  /** short name → FQCNs (>1 ⇒ ambiguous). */
  classesByShort: Map<string, string[]>;
  /** short function name → node qualifiedNames. */
  functionsByShort: Map<string, string[]>;
  /** Every emitted method/function node qualifiedName, for existence checks. */
  methodQns: Set<string>;
  deferred: DeferredRef[];
  /** `FQCN::CONST` → its string-literal value (R13), from `prescanConstants`. */
  constants: Map<string, string>;
  tally: PhpTally;
}

export function newTally(): PhpTally {
  return { unresolvedCallbacks: 0, unresolvedClasses: 0, ambiguousShortNames: 0, dynamicNames: 0 };
}

export function lineOf(node: Node): number {
  return node.startPosition.row + 1;
}

/** True when any path segment is `test` or `tests` (R9). */
export function isTestPath(relPosix: string): boolean {
  return relPosix.split('/').some((seg) => seg === 'test' || seg === 'tests');
}

/** The i-th `argument` child of a `function_call_expression`/`member_call_expression`. */
export function argAt(call: Node, i: number): Node | null {
  const args = call.childForFieldName('arguments');
  if (!args) return null;
  const list = args.namedChildren.filter((c): c is Node => c !== null && c.type === 'argument');
  const arg = list[i];
  if (!arg) return null;
  // `argument` wraps the real expression; unwrap to its single named child.
  return arg.namedChildCount > 0 ? arg.namedChild(arg.namedChildCount - 1) : arg;
}

/**
 * Resolve one PHP `escape_sequence` token to the character it denotes.
 * Single-quoted PHP recognises only `\\` and `\'`; every other backslash pair is
 * literal. Double-quoted adds the usual C-style set. Anything unrecognised is
 * returned verbatim, which is exactly PHP's own behaviour — never dropped.
 */
function unescapePhp(seq: string): string {
  switch (seq) {
    case '\\\\': return '\\';
    case "\\'": return "'";
    case '\\"': return '"';
    case '\\n': return '\n';
    case '\\t': return '\t';
    case '\\r': return '\r';
    case '\\$': return '$';
    default: return seq;
  }
}

/**
 * A literal with no interpolation, single- OR double-quoted.
 *
 * In tree-sitter-php a double-quoted literal is an `encapsed_string`, NOT a
 * `string` — they are different node types. Accepting only `string` would make
 * `array( $this, "boot" )` and `array( "jquery" )` read as unresolvable.
 * The target repo happens to be uniformly single-quoted today, which is exactly
 * why that bug would ship unnoticed and bite on the next file someone writes.
 *
 * Widened here, at the single reader, rather than by swapping five call sites to
 * `literalOrTemplate` — one reader cannot drift out of step with itself.
 * Interpolated strings still return null: they have a non-`string_content`
 * child and belong to `literalOrTemplate`.
 */
export function stringLiteral(node: Node | null): string | null {
  if (!node) return null;
  if (node.type !== 'string' && node.type !== 'encapsed_string') return null;
  const parts = node.namedChildren.filter((c): c is Node => c !== null);
  // A literal containing a backslash or an escaped quote is split into MULTIPLE
  // string_content nodes with `escape_sequence` nodes between them — verified
  // against tree-sitter-php@0.24.2:
  //   'AcmeShop\\Lib\\Helper' → string_content "AcmeShop", escape_sequence "\\",
  //                           string_content "Lib",    escape_sequence "\\",
  //                           string_content "Helper"
  // Rejecting anything that is not string_content would therefore return null
  // for every namespaced class written as a string — including the real
  // `array( 'Ns\\Sub\\Driver', 'method' )` form real WordPress plugins use — and
  // it would fail silently, as an unresolved callback. Escapes are unescaped
  // here; only genuine INTERPOLATION (a variable or member access inside the
  // string) disqualifies a node, and that belongs to literalOrTemplate.
  if (parts.some((c) => c.type !== 'string_content' && c.type !== 'escape_sequence')) return null;
  const text = parts
    .map((c) => (c.type === 'escape_sequence' ? unescapePhp(c.text) : c.text))
    .join('');
  // An EMPTY literal (`add_action('', $cb)`) must read as "no literal", not as
  // the empty string: engine.ts:54 throws on a node with an empty name and
  // aborts the WHOLE graph build for every extractor, not just this one.
  // Returning null here lets every handler's existing `if (!x)` guard catch it.
  return text === '' ? null : text;
}

/**
 * A literal, or an interpolated `encapsed_string` rendered as a template with
 * `{$…}` placeholders. `dynamic` drives EdgeConfidence: literals are
 * `extracted`, templates are `inferred` (spec §4.3).
 */
export function literalOrTemplate(node: Node | null): { value: string; dynamic: boolean } | null {
  if (!node) return null;
  const plain = stringLiteral(node);
  if (plain !== null) return { value: plain, dynamic: false };
  if (node.type !== 'encapsed_string') return null;
  let out = '';
  let dynamic = false;
  for (const child of node.namedChildren) {
    if (!child) continue;
    if (child.type === 'string_content') {
      out += child.text;
    } else if (child.type === 'escape_sequence') {
      // An escape is STATIC text, not interpolation. Treating it as dynamic
      // would downgrade a perfectly literal hook name to `inferred` confidence
      // and corrupt its identity with a `{$}` placeholder.
      out += unescapePhp(child.text);
    } else {
      dynamic = true;
      out += '{$}';
    }
  }
  if (out === '' || out === '{$}') return null; // fully variable — unusable
  return { value: out, dynamic };
}

/** Read a class reference from a `class_constant_access_expression` operand. */
function classRefFromScope(node: Node): RawClassRef | null {
  if (node.type === 'relative_scope') return { form: 'relative', name: node.text };
  if (node.type === 'name') return { form: 'named', name: node.text };
  if (node.type === 'qualified_name') return { form: 'named', name: node.text };
  return null;
}

/**
 * Read a callback argument. Shapes verified by spike:
 *   array( $this, 'boot' )            → array_creation_expression
 *   [ self::class, 'filt' ]           → array_creation_expression
 *   [ Cart_Recovery::class, 'm' ]     → array_creation_expression
 *   'ww_tip_cb' / 'Ns\Foo::method'    → string
 *   function( $x ) {}                 → anonymous_function
 */
export function callbackFromArg(arg: Node | null): RawCallback {
  if (!arg) return { form: 'unresolved' };

  if (arg.type === 'anonymous_function' || arg.type === 'arrow_function') {
    return { form: 'closure' };
  }

  const literal = stringLiteral(arg);
  if (literal !== null && literal !== '') {
    const sep = literal.indexOf('::');
    if (sep > 0) {
      return {
        form: 'class-method',
        cls: { form: 'named', name: literal.slice(0, sep) },
        method: literal.slice(sep + 2),
      };
    }
    return { form: 'function', fn: literal };
  }

  if (arg.type === 'array_creation_expression') {
    const items = arg.namedChildren.filter(
      (c): c is Node => c !== null && c.type === 'array_element_initializer'
    );
    if (items.length !== 2) return { form: 'unresolved' };
    const target = items[0]?.namedChild(0);
    const methodNode = items[1]?.namedChild(0) ?? items[1] ?? null;
    const method = stringLiteral(methodNode);
    if (!target || method === null || method === '') return { form: 'unresolved' };

    if (target.type === 'variable_name') {
      const varName = target.namedChild(0)?.text ?? '';
      if (varName === 'this') return { form: 'class-method', cls: { form: 'this', name: 'this' }, method };
      return { form: 'unresolved' }; // some other variable — not statically known
    }
    if (target.type === 'class_constant_access_expression') {
      const scope = target.namedChild(0);
      const ref = scope ? classRefFromScope(scope) : null;
      if (ref) return { form: 'class-method', cls: ref, method };
      return { form: 'unresolved' };
    }
    const asString = stringLiteral(target);
    if (asString !== null && asString !== '') {
      return { form: 'class-method', cls: { form: 'named', name: asString }, method };
    }
  }

  return { form: 'unresolved' };
}

/** Normalise a written class name against a file's namespace + use map (R5). */
export function resolveClassName(
  raw: RawClassRef,
  enclosing: string | null,
  file: FileCtx,
  repo: RepoCtx
): { fqcn: string; confidence: EdgeConfidence } | null {
  if (raw.form === 'this') {
    return enclosing ? { fqcn: enclosing, confidence: 'extracted' } : null;
  }
  if (raw.form === 'relative') {
    // parent:: needs the base class, which requires inheritance resolution we
    // deliberately do not do here — skipped and tallied, never guessed.
    if (raw.name === 'self' || raw.name === 'static') {
      return enclosing ? { fqcn: enclosing, confidence: 'extracted' } : null;
    }
    return null;
  }

  const written = raw.name.replace(/^\\+/, '');
  if (raw.name.startsWith('\\')) {
    return repo.classByFqcn.has(written) ? { fqcn: written, confidence: 'extracted' } : null;
  }

  const [head, ...rest] = written.split('\\');
  const alias = head !== undefined ? file.aliases.get(head.toLowerCase()) : undefined;
  if (alias !== undefined) {
    const fqcn = rest.length > 0 ? `${alias}\\${rest.join('\\')}` : alias;
    if (repo.classByFqcn.has(fqcn)) return { fqcn, confidence: 'extracted' };
  }

  if (file.namespace !== '') {
    const scoped = `${file.namespace}\\${written}`;
    if (repo.classByFqcn.has(scoped)) return { fqcn: scoped, confidence: 'extracted' };
  }

  if (repo.classByFqcn.has(written)) return { fqcn: written, confidence: 'extracted' };

  const short = written.split('\\').pop() ?? written;
  const candidates = repo.classesByShort.get(short) ?? [];
  if (candidates.length === 1) {
    const only = candidates[0];
    if (only !== undefined) return { fqcn: only, confidence: 'inferred' };
  }
  if (candidates.length > 1) repo.tally.ambiguousShortNames++;
  return null;
}

/**
 * Provenance for a FILE-OWNED node (endpoint, scheduled_job). R9 applies to
 * every node originating in a test path, not only to language declarations —
 * an endpoint registered by a test fixture is test provenance just as much as
 * the class that registers it. Rendezvous nodes are deliberately excluded:
 * they are shared across many files, so no single file's provenance describes
 * them and tagging one would be wrong for the others.
 */
export function fileOwnedMeta(file: FileCtx): Record<string, unknown> {
  return file.isTest ? { test: true } : {};
}

/**
 * Rendezvous nodes carry NO filePath and NO line — see registry SHARED_KINDS.
 * The return type OMITS both fields, so a literal carrying `filePath` inside this
 * helper is a compile error. A caller can still spread-and-re-add, which compiles —
 * the unit test and Task 8 Step 3's DB check are what actually hold R7.
 * Throws on an empty name rather than emitting one: engine.ts:54 would reject it
 * and abort the entire multi-extractor build, so failing at the producer names
 * the real culprit instead of blaming whichever extractor ran last.
 */
export function rendezvousNode(
  kind: 'hook' | 'option' | 'capability' | 'shortcode' | 'asset' | 'wp_table',
  name: string,
  qualifiedName: string
): Omit<ExtractedNode, 'filePath' | 'line'> {
  if (name.trim() === '' || qualifiedName.trim() === '') {
    throw new Error(`php extractor: refusing to emit an empty ${kind} node (qn '${qualifiedName}')`);
  }
  return { kind, name, qualifiedName, lang: 'php' };
}

/**
 * `self::NAME` / `static::NAME` where NAME is a string-literal class constant (R13).
 * Only the RELATIVE scopes resolve: they name the enclosing class, which
 * `prescanConstants` has already recorded for this file. Cross-class `Foo::NAME`
 * is deliberately NOT resolved (decision `5e04ea93`) — its value would have to be
 * deferred, and a deferred value cannot build a node's qualifiedName.
 * Verified shape (tree-sitter-php@0.24.2): `self::X` parses as
 * `class_constant_access_expression > (relative_scope) (name)`.
 */
export function selfConstant(node: Node | null, enclosing: string | null, repo: RepoCtx): string | null {
  if (!node || node.type !== 'class_constant_access_expression') return null;
  if (enclosing === null) return null;
  const scope = node.namedChild(0);
  const member = node.namedChild(1);
  if (!scope || !member || member.type !== 'name') return null;
  if (scope.type !== 'relative_scope') return null;
  if (scope.text !== 'self' && scope.text !== 'static') return null;
  return repo.constants.get(`${enclosing}::${member.text}`) ?? null;
}

/**
 * The ONE reader every WP handler uses for a name-shaped argument: a literal, an
 * interpolated template, or a string-valued `self::CONST`. Handlers must NOT call
 * `literalOrTemplate` directly — in the consumer repo this was measured against,
 * 27 of 31 `register_rest_route` sites pass `self::REST_NAMESPACE`, and a
 * literal-only reader made every one of them invisible (4 endpoints from 31 sites).
 * Unresolvable arguments still return null, so each handler's existing `if (!x)`
 * guard tallies them exactly as before.
 */
export function surfaceArg(
  repo: RepoCtx,
  call: Node,
  index: number,
  enclosing: string | null
): { value: string; dynamic: boolean } | null {
  const node = argAt(call, index);
  const literal = literalOrTemplate(node);
  if (literal !== null) return literal;
  const konst = selfConstant(node, enclosing, repo);
  return konst !== null && konst !== '' ? { value: konst, dynamic: false } : null;
}

export function fileQName(repoBase: string, repoRoot: string, abs: string): string {
  return `${repoBase}/${path.relative(repoRoot, abs).split(path.sep).join('/')}`;
}
