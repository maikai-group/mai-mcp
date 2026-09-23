export type Intent = 'layout' | 'impact' | 'decisions' | 'family';
export interface Context { label: string; text: string }
export interface Input {
  question: string;
  intent: Intent;
  seed_nodes: string[];
  terms: string[];
  context: Context[];
  mechanism?: string;
}
export interface Config { key: string; model: string }
export const LIMITS = Object.freeze({
  evidence: 32, actions: 32, steps: 3, evaluations: 4,
  requestBytes: 48 * 1024, responseBytes: 64 * 1024,
  attemptMs: 10_000, providerAttempts: 3, scheduleMs: 60_000,
  retryMs: 500, retryMaxMs: 5_000, retryJitter: 0.25,
});
export interface Evidence {
  id: string;
  kind: 'node' | 'edge' | 'source' | 'memory' | 'context';
  ref: string;
  text: string;
  freshness: string;
  hash: string | null;
  nodeId?: string;
  nodeName?: string;
  score?: number;
  truncated: boolean;
}
export type Action =
  | { id: string; kind: 'code' | 'memory'; query: string }
  | { id: string; kind: 'expand' | 'source'; nodeId: string };
export interface Batch { evidence: Evidence[]; gaps: string[] }
export interface Ports {
  code(query: string): Promise<Batch>;
  memory(query: string): Promise<Batch>;
  seed(nodeId: string): Promise<Batch>;
  expand(nodeId: string): Promise<Batch>;
  source(nodeId: string): Promise<Batch>;
}
export interface Evaluation {
  model: string;
  choice: string;
  confidence: number;
  scores: Record<string, number>;
  inputTokens: number;
  outputTokens: number;
  attempts: number;
}
export type Evaluate = (
  input: Input, evidence: readonly Evidence[], actions: readonly Action[],
  config: Config, signal: AbortSignal,
) => Promise<Evaluation>;
export type Status = 'evidence' | 'partial' | 'disabled' | 'unavailable'
  | 'busy' | 'cancelled' | 'insufficient_context';
export interface Report {
  status: Status;
  stop: string;
  model: string | null;
  rubric: 'mai-navigation/1';
  evidence: Evidence[];
  gaps: string[];
  trace: string[];
  omitted: number;
  actionsRemaining: number;
  evaluations: number;
  attempts: number;
  inputTokens: number;
  outputTokens: number;
}
export function emptyReport(status: Status, stop: string): Report {
  return { status, stop, model: null, rubric: 'mai-navigation/1',
    evidence: [], gaps: [], trace: [], omitted: 0, actionsRemaining: 0,
    evaluations: 0, attempts: 0, inputTokens: 0, outputTokens: 0 };
}
