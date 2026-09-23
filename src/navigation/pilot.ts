import { runNavigation } from './service.js';
import type { RunDeps } from './service.js';
import { makeRequest, ProviderError } from './provider.js';
import type { RequestBody } from './provider.js';
import type { Batch, Config, Evaluation, Evidence, Input, Ports, Report } from './types.js';

export type PilotMode = 'prepare' | 'live';
export interface RetrievalEvent {
  kind: keyof Ports;
  argument: string;
  batch: Batch | null;
  error: 'retrieval_unavailable' | null;
}
export interface AssessmentEvent {
  request: RequestBody;
  requestBytes: number;
  evidenceTextBytes: number;
  elapsedMs: number;
  synthetic: boolean;
  result: Evaluation | null;
  failure: { code: string; attempts: number } | null;
}
export interface PilotCapture {
  schema: 1;
  mode: PilotMode;
  input: Input;
  initialEvidence: Evidence[] | null;
  retrievals: RetrievalEvent[];
  assessments: AssessmentEvent[];
  report: Report;
  elapsedMs: number;
  unknownUsageAttempts: number;
  usageComplete: boolean;
  attemptedRequestBytes: number;
}

export async function captureNavigation(
  mode: PilotMode, input: Input, config: Config,
  deps: RunDeps, signal: AbortSignal,
): Promise<PilotCapture> {
  const start = deps.now();
  const retrievals: RetrievalEvent[] = [];
  const assessments: AssessmentEvent[] = [];
  let initialEvidence: Evidence[] | null = null;
  const wrap = (kind: keyof Ports, read: Ports['code']): Ports['code'] => async argument => {
    try {
      const batch = await read(argument);
      retrievals.push({ kind, argument, batch: structuredClone(batch), error: null });
      return batch;
    } catch {
      retrievals.push({ kind, argument, batch: null, error: 'retrieval_unavailable' });
      throw new Error('retrieval_unavailable');
    }
  };
  const ports: Ports = {
    code: wrap('code', deps.ports.code), memory: wrap('memory', deps.ports.memory),
    seed: wrap('seed', deps.ports.seed), source: wrap('source', deps.ports.source),
    expand: wrap('expand', deps.ports.expand),
  };
  const report = await runNavigation(input, config, {
    ports, now: deps.now,
    evaluate: async (question, evidence, actions, resolved, abort) => {
      initialEvidence ??= structuredClone([...evidence]);
      const request = structuredClone(makeRequest(question, evidence, actions, resolved));
      const event: AssessmentEvent = {
        request, requestBytes: Buffer.byteLength(JSON.stringify(request), 'utf8'),
        evidenceTextBytes: evidence.reduce((n, item) => n + Buffer.byteLength(item.text, 'utf8'), 0),
        elapsedMs: 0, synthetic: mode === 'prepare', result: null, failure: null,
      };
      assessments.push(event);
      const began = deps.now();
      try {
        const result: Evaluation = mode === 'prepare'
          ? { model: resolved.model, choice: 'stop', confidence: 0, scores: {},
              inputTokens: 0, outputTokens: 0, attempts: 0 }
          : await deps.evaluate(question, evidence, actions, resolved, abort);
        event.result = structuredClone(result);
        return result;
      } catch (error) {
        event.failure = error instanceof ProviderError
          ? { code: error.code, attempts: error.attempts }
          : { code: 'provider_unavailable', attempts: 0 };
        throw error;
      } finally {
        event.elapsedMs = Math.max(0, deps.now() - began);
      }
    },
  }, signal);
  return {
    schema: 1, mode, input: structuredClone(input), initialEvidence,
    retrievals, assessments, report, elapsedMs: Math.max(0, deps.now() - start),
    unknownUsageAttempts: assessments.reduce((n, event) => n + (event.synthetic ? 0
      : event.failure?.attempts ?? Math.max(0, (event.result?.attempts ?? 0) - 1)), 0),
    usageComplete: assessments.every(event => event.synthetic
      || (event.failure === null && event.result?.attempts === 1)),
    attemptedRequestBytes: assessments.reduce((n, event) => n + event.requestBytes
      * (event.synthetic ? 0 : event.failure?.attempts ?? event.result?.attempts ?? 0), 0),
  };
}

export function scoreTopK(ids: readonly string[], relevant: readonly string[], k = 10): {
  returned: number; hits: number; precision: number; recall: number | null;
} {
  if (!Number.isSafeInteger(k) || k < 1 || new Set(ids).size !== ids.length
    || new Set(relevant).size !== relevant.length
    || [...ids, ...relevant].some(id => !id.trim())) throw new Error('invalid ranking');
  const selected = ids.slice(0, k);
  const expected = new Set(relevant);
  const hits = selected.filter(id => expected.has(id)).length;
  return { returned: selected.length, hits,
    precision: selected.length ? hits / selected.length : 0,
    recall: relevant.length ? hits / relevant.length : null };
}
