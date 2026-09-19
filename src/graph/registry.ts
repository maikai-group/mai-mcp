// mai-graph vocabulary registry (spec §2): the DB columns are open TEXT — ALL
// compile-time safety for kinds/relations lives here. New extractors (prose §7,
// shell/glue/python in 4b) extend these unions + their extractor's vocabulary;
// the DB never needs a migration for vocabulary growth.

export const NODE_KINDS = [
  'file',
  'function',
  'class',
  'component',
  'endpoint',
  'http_call',
  'event_channel',
  'table',
  'column',
  'policy',
  'script',
  'command',
  'env_var',
  'package_script',
  'scheduled_job',
  'mcp_server',
  'module',
  'hook',
  'option',
  'capability',
  'shortcode',
  'asset',
  'wp_table',
] as const;
export type NodeKind = (typeof NODE_KINDS)[number];

export const GRAPH_RELATIONS = [
  'imports',
  'exports',
  'calls',
  'defines',
  'references_table',
  'reads_env',
  'invokes',
  'scheduled_by',
  'serves_route',
  'co_changed_with',
  'fk_to',
  'secured_by',
  'inherits',
  'depends_on',
  'fires',
  'listens_to',
  'reads_option',
  'writes_option',
  'http_calls',
  'emits',
  'listens_on',
] as const;
export type GraphRelation = (typeof GRAPH_RELATIONS)[number];

/** extracted: parsed from source. inferred: heuristic (e.g. SQL-in-string table
 * refs). behavioral: derived from history (4c). */
export type EdgeConfidence = 'extracted' | 'inferred' | 'behavioral';

/** What an extractor is allowed to emit — the engine validates against this. */
export interface ExtractorVocabulary {
  kinds: readonly NodeKind[];
  relations: readonly GraphRelation[];
}

/** Kinds NOT owned by a single file or extractor: exempt from full-splice
 * deletes, reclaimed instead by the orphan sweep
 * (engine.sweepOrphanSharedNodes) after each build/update.
 *
 * Two distinct reasons land a kind here:
 *   - multi-EXTRACTOR: `command` comes from both shell and glue; deleting one
 *     extractor's copy would cascade away the other's edges through it.
 *   - multi-FILE (plan 33): a WP `hook`/`option`/`capability`/`shortcode`/
 *     `asset` is one rendezvous node that many files meet at. These are emitted
 *     with NO file_path precisely so the incremental splice (engine.ts:292,
 *     `file_path = ANY($2)`) cannot match them — a file-owned hook node would be
 *     deleted when its first-seen file stopped firing it, silently cascading
 *     away every OTHER file's still-valid listens_to edge.
 */
export const SHARED_KINDS: ReadonlySet<string> = new Set([
  'command',
  'hook',
  'option',
  'capability',
  'shortcode',
  'asset',
  'wp_table',
  'endpoint',
  'event_channel',
]);
