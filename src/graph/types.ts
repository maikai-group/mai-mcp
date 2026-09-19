// mai-graph extractor contract (spec §3): extractors are PURE — they receive
// repo paths (and optionally a dev-DB URL) and emit nodes + edges. The engine
// owns all persistence. Edges reference nodes by (kind, qualifiedName); the
// engine resolves refs to ids against the project's whole graph at insert time.
import type { EdgeConfidence, ExtractorVocabulary, GraphRelation, NodeKind } from './registry.js';

export interface ExtractorInput {
  projectId: string;
  repoPaths: string[];
  /** Dev-DB URL for introspection extractors. NEVER persisted (locked decision
   * 2026-06-11) — arrives per invocation or from MAI_GRAPH_DB_URL. */
  dbUrl?: string;
  /** 4b incremental updates — unused in 4a, part of the stable interface. */
  changedFiles?: string[];
  /** Absolute path prefixes excluded from graph enumeration (projects.metadata.graph_excludes). */
  excludes?: string[];
}

export interface NodeRef {
  kind: NodeKind;
  qualifiedName: string;
}

export interface ExtractedNode {
  kind: NodeKind;
  name: string;
  /** Required by the engine even though the DB column is nullable — the
   * UNIQUE(project_id, kind, qualified_name) splice contract depends on it. */
  qualifiedName: string;
  filePath?: string;
  line?: number;
  lang?: string;
  signature?: string;
  /** SHA-256 hex of the exact defining file text consumed by this extractor.
   * Optional when no defining source evidence is available. */
  contentHash?: string;
  metadata?: Record<string, unknown>;
}

export interface ExtractedEdge {
  from: NodeRef;
  to: NodeRef;
  relation: GraphRelation;
  /** Default 'extracted'. */
  confidence?: EdgeConfidence;
  /** Default 1.0. */
  weight?: number;
  metadata?: Record<string, unknown>;
}

export interface ContractSkipTallies {
  dynamic_http_url: number;
  dynamic_http_method: number;
  dynamic_http_route: number;
  dynamic_event_channel: number;
}

export interface ExtractorOutput {
  nodes: ExtractedNode[];
  edges: ExtractedEdge[];
  contractSkips?: ContractSkipTallies;
}

export interface GraphExtractor {
  /** Lands in graph_nodes.extracted_by — lowercase, ≤32 chars. */
  name: string;
  vocabulary: ExtractorVocabulary;
  extract(input: ExtractorInput): Promise<ExtractorOutput>;
}
