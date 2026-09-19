/**
 * The pure leaf for mai-graph wave 2 (plan 39): the public input shapes, the
 * named caps, and cast-free fail-closed parsers from `unknown`.
 *
 * There is no string DSL and no arbitrary SQL. Every accepted value is either a
 * literal registered vocabulary string, a bounded scalar, or a clamped integer,
 * and an invalid input is rejected HERE — before any database work happens.
 */
import { GRAPH_RELATIONS, NODE_KINDS, type GraphRelation, type NodeKind } from './registry.js';

export const GRAPH_QUERY_SEED_CAP = 20;
export const GRAPH_QUERY_EDGE_CAP = 100;
export const GRAPH_QUERY_DEFAULT_LIMIT = 20;
export const GRAPH_QUERY_RESULT_CAP = 50;
export const GRAPH_QUERY_STEP_CAP = 3;
/** Maximum entries in any one filter list (kinds / relations / target_kinds). */
export const GRAPH_QUERY_LIST_CAP = 8;
/** Maximum length of a literal text seed. */
export const GRAPH_QUERY_TEXT_MAX = 200;

export const GRAPH_QUERY_DIRECTIONS = ['outgoing', 'incoming', 'both'] as const;
export type GraphQueryDirection = (typeof GRAPH_QUERY_DIRECTIONS)[number];

/** The only kinds dead-code analysis may consider (spec §4.1). */
export const DEAD_CODE_KINDS = ['function', 'class', 'component'] as const;
export type DeadCodeKind = (typeof DEAD_CODE_KINDS)[number];

// ---------- public input shapes ----------

export interface GraphQuerySeed {
  node_id?: string;
  query?: string;
  kinds?: string[];
  path_prefix?: string;
}
export interface GraphQueryStep {
  direction: GraphQueryDirection;
  relations?: string[];
  target_kinds?: string[];
}
export interface GraphQueryInput {
  seed: GraphQuerySeed;
  steps?: GraphQueryStep[];
  limit?: number;
}
export interface GraphDeadCodeInput {
  kinds?: DeadCodeKind[];
  path_prefix?: string;
  limit?: number;
}

// ---------- normalized (engine-facing) shapes ----------

export interface NormalizedGraphQuerySeed {
  nodeId: string | null;
  query: string | null;
  kinds: NodeKind[];
  pathPrefix: string | null;
}
export interface NormalizedGraphQueryStep {
  direction: GraphQueryDirection;
  relations: GraphRelation[];
  targetKinds: NodeKind[];
}
export interface NormalizedGraphQuery {
  seed: NormalizedGraphQuerySeed;
  steps: NormalizedGraphQueryStep[];
  limit: number;
}
export interface NormalizedGraphDeadCode {
  kinds: DeadCodeKind[];
  pathPrefix: string | null;
  limit: number;
}

export type NormalizeResult<T> = { ok: true; value: T } | { ok: false; message: string };

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
/** NUL, every other C0 control, and DEL. */
const CONTROL_RE = /[\u0000-\u001F\u007F]/;

const fail = (message: string): NormalizeResult<never> => ({ ok: false, message });

/**
 * Own DATA properties only. Getters, setters, symbol keys, arrays, null and
 * primitives are all rejected: a prototype-smuggled or accessor-backed value
 * never reaches validation, because it never becomes an own data property here.
 */
function ownDataProperties(
  value: unknown, path: string,
): NormalizeResult<Record<string, unknown>> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    return fail(`${path} must be a JSON object`);
  }
  if (Object.getOwnPropertySymbols(value).length > 0) {
    return fail(`${path} must not carry symbol keys`);
  }
  const record: Record<string, unknown> = Object.create(null);
  for (const name of Object.getOwnPropertyNames(value)) {
    const descriptor = Object.getOwnPropertyDescriptor(value, name);
    if (descriptor === undefined || descriptor.get !== undefined || descriptor.set !== undefined) {
      return fail(`${path}.${name} must be a plain data property`);
    }
    record[name] = descriptor.value;
  }
  return { ok: true, value: record };
}

function rejectUnknownKeys(
  record: Record<string, unknown>, allowed: readonly string[], path: string,
): NormalizeResult<true> {
  for (const key of Object.getOwnPropertyNames(record)) {
    if (!allowed.includes(key)) {
      return fail(`${path}.${key} is not a recognized key (allowed: ${allowed.join(', ')})`);
    }
  }
  return { ok: true, value: true };
}

function boundedText(raw: unknown, path: string, max: number): NormalizeResult<string> {
  if (typeof raw !== 'string') return fail(`${path} must be a string`);
  if (raw.length === 0) return fail(`${path} must not be empty`);
  if (raw.length > max) return fail(`${path} must be at most ${max} characters`);
  if (CONTROL_RE.test(raw)) return fail(`${path} must not contain control characters`);
  return { ok: true, value: raw };
}

function clampedLimit(raw: unknown, path: string, fallback: number): NormalizeResult<number> {
  if (raw === undefined) return { ok: true, value: fallback };
  if (typeof raw !== 'number') return fail(`${path} must be a number`);
  if (!Number.isFinite(raw)) return fail(`${path} must be a finite number`);
  if (!Number.isInteger(raw)) return fail(`${path} must be an integer`);
  return { ok: true, value: Math.max(1, Math.min(GRAPH_QUERY_RESULT_CAP, raw)) };
}

/** A unique list of exact registered strings, capped at `GRAPH_QUERY_LIST_CAP`. */
function registeredList(
  raw: unknown, path: string, allowed: readonly string[],
): NormalizeResult<string[]> {
  if (!Array.isArray(raw)) return fail(`${path} must be an array`);
  if (raw.length === 0) return fail(`${path} must not be empty — omit it instead`);
  if (raw.length > GRAPH_QUERY_LIST_CAP) {
    return fail(`${path} must have at most ${GRAPH_QUERY_LIST_CAP} entries`);
  }
  const seen: string[] = [];
  for (let i = 0; i < raw.length; i++) {
    const entry: unknown = raw[i];
    if (typeof entry !== 'string') return fail(`${path}[${i}] must be a string`);
    if (!allowed.includes(entry)) return fail(`${path}[${i}] is not a registered value: ${entry}`);
    if (seen.includes(entry)) return fail(`${path}[${i}] is a duplicate: ${entry}`);
    seen.push(entry);
  }
  return { ok: true, value: seen };
}

const asNodeKinds = (values: readonly string[]): NodeKind[] =>
  NODE_KINDS.filter((kind) => values.includes(kind));
const asRelations = (values: readonly string[]): GraphRelation[] =>
  GRAPH_RELATIONS.filter((relation) => values.includes(relation));
const asDeadCodeKinds = (values: readonly string[]): DeadCodeKind[] =>
  DEAD_CODE_KINDS.filter((kind) => values.includes(kind));

function normalizeSeed(raw: unknown): NormalizeResult<NormalizedGraphQuerySeed> {
  const object = ownDataProperties(raw, 'seed');
  if (!object.ok) return object;
  const unknownKey = rejectUnknownKeys(object.value, ['node_id', 'query', 'kinds', 'path_prefix'], 'seed');
  if (!unknownKey.ok) return unknownKey;

  const hasNodeId = object.value.node_id !== undefined;
  const hasQuery = object.value.query !== undefined;
  if (hasNodeId === hasQuery) {
    return fail('seed must carry exactly one of node_id or query');
  }

  if (hasNodeId) {
    if (typeof object.value.node_id !== 'string' || !UUID_RE.test(object.value.node_id)) {
      return fail('seed.node_id must be a UUID');
    }
    if (object.value.kinds !== undefined || object.value.path_prefix !== undefined) {
      return fail('seed.node_id takes no kinds or path_prefix refiners');
    }
    return {
      ok: true,
      value: { nodeId: object.value.node_id, query: null, kinds: [], pathPrefix: null },
    };
  }

  const query = boundedText(object.value.query, 'seed.query', GRAPH_QUERY_TEXT_MAX);
  if (!query.ok) return query;
  let kinds: NodeKind[] = [];
  if (object.value.kinds !== undefined) {
    const list = registeredList(object.value.kinds, 'seed.kinds', NODE_KINDS);
    if (!list.ok) return list;
    kinds = asNodeKinds(list.value);
  }
  let pathPrefix: string | null = null;
  if (object.value.path_prefix !== undefined) {
    const prefix = boundedText(object.value.path_prefix, 'seed.path_prefix', GRAPH_QUERY_TEXT_MAX);
    if (!prefix.ok) return prefix;
    pathPrefix = prefix.value;
  }
  return { ok: true, value: { nodeId: null, query: query.value, kinds, pathPrefix } };
}

function normalizeStep(raw: unknown, index: number): NormalizeResult<NormalizedGraphQueryStep> {
  const path = `steps[${index}]`;
  const object = ownDataProperties(raw, path);
  if (!object.ok) return object;
  const unknownKey = rejectUnknownKeys(object.value, ['direction', 'relations', 'target_kinds'], path);
  if (!unknownKey.ok) return unknownKey;

  const direction: unknown = object.value.direction;
  if (typeof direction !== 'string' || !GRAPH_QUERY_DIRECTIONS.some((d) => d === direction)) {
    return fail(`${path}.direction must be one of ${GRAPH_QUERY_DIRECTIONS.join(', ')}`);
  }
  const chosen = GRAPH_QUERY_DIRECTIONS.find((d) => d === direction);
  if (chosen === undefined) return fail(`${path}.direction must be one of ${GRAPH_QUERY_DIRECTIONS.join(', ')}`);

  let relations: GraphRelation[] = [];
  if (object.value.relations !== undefined) {
    const list = registeredList(object.value.relations, `${path}.relations`, GRAPH_RELATIONS);
    if (!list.ok) return list;
    relations = asRelations(list.value);
  }
  let targetKinds: NodeKind[] = [];
  if (object.value.target_kinds !== undefined) {
    const list = registeredList(object.value.target_kinds, `${path}.target_kinds`, NODE_KINDS);
    if (!list.ok) return list;
    targetKinds = asNodeKinds(list.value);
  }
  return { ok: true, value: { direction: chosen, relations, targetKinds } };
}

/** Parse an arbitrary MCP/CLI payload into a bounded query. Zero DB work. */
export function normalizeGraphQuery(input: unknown): NormalizeResult<NormalizedGraphQuery> {
  const object = ownDataProperties(input, 'input');
  if (!object.ok) return object;
  const unknownKey = rejectUnknownKeys(object.value, ['seed', 'steps', 'limit'], 'input');
  if (!unknownKey.ok) return unknownKey;
  if (object.value.seed === undefined) return fail('input.seed is required');

  const seed = normalizeSeed(object.value.seed);
  if (!seed.ok) return seed;

  const steps: NormalizedGraphQueryStep[] = [];
  if (object.value.steps !== undefined) {
    const rawSteps: unknown = object.value.steps;
    if (!Array.isArray(rawSteps)) return fail('input.steps must be an array');
    if (rawSteps.length > GRAPH_QUERY_STEP_CAP) {
      return fail(`input.steps must have at most ${GRAPH_QUERY_STEP_CAP} entries`);
    }
    for (let i = 0; i < rawSteps.length; i++) {
      const step = normalizeStep(rawSteps[i], i);
      if (!step.ok) return step;
      steps.push(step.value);
    }
  }

  const limit = clampedLimit(object.value.limit, 'input.limit', GRAPH_QUERY_DEFAULT_LIMIT);
  if (!limit.ok) return limit;
  return { ok: true, value: { seed: seed.value, steps, limit: limit.value } };
}

/** Parse an arbitrary MCP/CLI payload into a bounded dead-code scan. Zero DB work. */
export function normalizeGraphDeadCode(input: unknown): NormalizeResult<NormalizedGraphDeadCode> {
  const object = ownDataProperties(input, 'input');
  if (!object.ok) return object;
  const unknownKey = rejectUnknownKeys(object.value, ['kinds', 'path_prefix', 'limit'], 'input');
  if (!unknownKey.ok) return unknownKey;

  let kinds: DeadCodeKind[] = [...DEAD_CODE_KINDS];
  if (object.value.kinds !== undefined) {
    const list = registeredList(object.value.kinds, 'input.kinds', DEAD_CODE_KINDS);
    if (!list.ok) return list;
    kinds = asDeadCodeKinds(list.value);
  }
  let pathPrefix: string | null = null;
  if (object.value.path_prefix !== undefined) {
    const prefix = boundedText(object.value.path_prefix, 'input.path_prefix', GRAPH_QUERY_TEXT_MAX);
    if (!prefix.ok) return prefix;
    pathPrefix = prefix.value;
  }
  const limit = clampedLimit(object.value.limit, 'input.limit', GRAPH_QUERY_DEFAULT_LIMIT);
  if (!limit.ok) return limit;
  return { ok: true, value: { kinds, pathPrefix, limit: limit.value } };
}
