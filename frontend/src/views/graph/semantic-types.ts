export type CodeProvider = 'off' | 'local' | 'openai' | 'voyage';
export type MatchMethod = 'semantic' | 'lexical';
export type DocumentMode = 'declaration' | 'metadata';
export const DOCUMENT_VERSION = 'code-symbol/1';
export const LIMITS = Object.freeze({
  queryChars: 1000, resultDefault: 10, resultMax: 30,
  sourceBytes: 2 * 1024 * 1024, documentChars: 2400,
  corpusNodes: 20000, vectorPage: 128, indexPage: 32,
  excerptChars: 360, cloudMs: 5000, localMs: 20000,
  queryMs: 25000, cancelPollMs: 500, heartbeatMs: 5000,
  abandonedMs: 30000,
});
export interface StableNode {
  projectId: string;
  identity: string;
  nodeId: string;
  kind: string;
  name: string;
  qualifiedName: string;
  extractedBy: string;
  physicalPath: string | null;
  line: number | null;
  signature: string | null;
  language: string | null;
}
export interface CodeDocument {
  node: StableNode;
  version: typeof DOCUMENT_VERSION;
  mode: DocumentMode;
  sourceHash: string | null;
  fingerprint: string;
  text: string;
  truncated: boolean;
}
export interface CodePolicy {
  provider: CodeProvider;
  revision: number;
  consentVersion: 'code-and-lessons/1' | null;
}
export type SearchState = 'ready' | 'partial' | 'fallback';
export type SearchReason = 'off' | 'not_indexed' | 'model_missing'
  | 'provider_unavailable' | 'worker_busy' | 'stale_source'
  | 'coverage_incomplete' | 'corpus_limit' | 'policy_changed' | 'no_semantic_hits' | 'query_timeout' | 'database_unavailable';
export interface CodeHit {
  id: string;
  identity: string;
  name: string;
  kind: string;
  qualified_name: string;
  file_path: string | null;
  line: number | null;
  method: MatchMethod;
  document_mode: DocumentMode | null;
  score: number;
  excerpt: string | null;
  freshness: {
    state: 'verified' | 'metadata_only' | 'unverified';
    source_hash: string | null;
    document_fingerprint: string | null;
    document_version: string | null;
    indexed_at: string | null;
    verified_at: string | null;
  };
}
export interface CodeSearch {
  state: SearchState;
  reasons: SearchReason[];
  model: string | null;
  coverage: {
    eligible: number; current: number; skipped: number; capped: boolean;
    declaration: { eligible: number; current: number };
    metadata: { eligible: number; current: number };
    complete: boolean;
  };
  nodes: CodeHit[];
}
export interface SearchInput { query: string; kind?: string; limit: number }

export interface IndexJob { id:string; state:"running"|"completed"|"partial"|"cancelled"|"failed"; scanned:number; written:number; reused:number; skipped:number; reason:string|null }
export interface SemanticStatus {policy:CodePolicy;model:string|null;coverage:CodeSearch["coverage"];job:IndexJob|null}
