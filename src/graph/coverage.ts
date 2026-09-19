/**
 * Exhaustive graph policy for wave 2 (plan 39): what every registered relation
 * MEANS, which kinds are operational roots or public boundaries, and exactly
 * which extractor/kind pairs may take part in dead-code analysis.
 *
 * Everything here is literal and frozen. A future relation fails TypeScript
 * until it is classified, and extractor coverage is never inferred from a name
 * prefix or regex — an unsupported pair must be silent, not guessed.
 */
import { GRAPH_RELATIONS, type GraphRelation, type NodeKind } from './registry.js';
import { DEAD_CODE_KINDS, type DeadCodeKind } from './query-language.js';

export type GraphRelationRole = 'use' | 'ownership' | 'root' | 'context';

/**
 * `use` — evidence the target is actually used.
 * `ownership` — structural containment/authorship, never use on its own.
 * `root` — an operational entry point reaching the node.
 * `context` — correlation only.
 */
export const GRAPH_RELATION_ROLE = {
  imports: 'use', exports: 'ownership', calls: 'use', defines: 'ownership',
  references_table: 'use', reads_env: 'use', invokes: 'use',
  scheduled_by: 'root', serves_route: 'root', co_changed_with: 'context',
  fk_to: 'context', secured_by: 'root', inherits: 'use', depends_on: 'use',
  fires: 'root', listens_to: 'root', reads_option: 'use', writes_option: 'use',
  http_calls: 'use', emits: 'use', listens_on: 'root',
} satisfies Record<GraphRelation, GraphRelationRole>;

/** Operational roots: reaching one of these within a hop is not dead code. */
export const DEAD_CODE_ROOT_KINDS = [
  'endpoint', 'hook', 'scheduled_job', 'mcp_server', 'shortcode', 'capability', 'event_channel',
] as const;

/** Public/operational/data boundaries — any of them makes impact HIGH. */
export const IMPACT_BOUNDARY_KINDS = [
  'endpoint', 'table', 'policy', 'scheduled_job', 'mcp_server', 'event_channel',
] as const;
export const IMPACT_BOUNDARY_RELATIONS = [
  'serves_route', 'references_table', 'fk_to', 'secured_by', 'scheduled_by',
  'http_calls', 'emits', 'listens_on',
] as const;

const relationsWithRole = (role: GraphRelationRole): GraphRelation[] =>
  GRAPH_RELATIONS.filter((relation) => GRAPH_RELATION_ROLE[relation] === role);

/** Incoming edges of these relations are launch USE evidence (spec §4.2). */
export const USE_RELATIONS: readonly GraphRelation[] = relationsWithRole('use');
/** Relations that connect a node to an operational root. */
export const ROOT_RELATIONS: readonly GraphRelation[] = relationsWithRole('root');

export type DeadCodeCoverage = 'complete' | 'partial';

/**
 * The literal extractor×kind coverage table. `partial` means the extractor
 * emits enough use edges for the negative claim to be worth reporting as a
 * CANDIDATE; `complete` is reserved for a future evidence-backed extractor and
 * is deliberately absent at launch, so no launch candidate can be `strong`.
 * Every pair not listed here is unsupported — including `tier2-future`, every
 * `component` pair, every TypeScript pair, and Python/tier-2 `class`.
 */
export const DEAD_CODE_COVERAGE: Readonly<Record<string, DeadCodeCoverage>> = {
  'php:function': 'partial',
  'php:class': 'partial',
  'cpp:function': 'partial',
  'cpp:class': 'partial',
  'swift:function': 'partial',
  'swift:class': 'partial',
  'kotlin:function': 'partial',
  'kotlin:class': 'partial',
  'python:function': 'partial',
  'tier2-go:function': 'partial',
  'tier2-rust:function': 'partial',
  'tier2-java:function': 'partial',
  'tier2-csharp:function': 'partial',
};

/** Exact-pair lookup. Never a prefix or regex match; unknown pairs are null. */
export function deadCodeCoverage(extractor: string, kind: string): DeadCodeCoverage | null {
  const key = `${extractor}:${kind}`;
  if (!Object.prototype.hasOwnProperty.call(DEAD_CODE_COVERAGE, key)) return null;
  return DEAD_CODE_COVERAGE[key] ?? null;
}

export const isDeadCodeKind = (kind: string): kind is DeadCodeKind =>
  DEAD_CODE_KINDS.some((known) => known === kind);

export const isDeadCodeRootKind = (kind: string): boolean =>
  DEAD_CODE_ROOT_KINDS.some((known) => known === kind);

export const isImpactBoundaryKind = (kind: string): boolean =>
  IMPACT_BOUNDARY_KINDS.some((known) => known === kind);

export const isImpactBoundaryRelation = (relation: string): boolean =>
  IMPACT_BOUNDARY_RELATIONS.some((known) => known === relation);

/** Compile-time proof that every boundary/root literal is a real node kind. */
const ROOT_KIND_CHECK: readonly NodeKind[] = DEAD_CODE_ROOT_KINDS;
const BOUNDARY_KIND_CHECK: readonly NodeKind[] = IMPACT_BOUNDARY_KINDS;
const BOUNDARY_RELATION_CHECK: readonly GraphRelation[] = IMPACT_BOUNDARY_RELATIONS;
void ROOT_KIND_CHECK;
void BOUNDARY_KIND_CHECK;
void BOUNDARY_RELATION_CHECK;
