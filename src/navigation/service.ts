import { getProjectId } from '../db.js';
import { resolveJevConfig } from '../providers/runtime.js';
import type { ResolvedJevConfig } from '../providers/runtime.js';
import { normalizeInput } from './input.js';
import { createPorts, digest } from './retrieval.js';
import { evaluate, makeRequest, ProviderError } from './provider.js';
import { LIMITS, emptyReport } from './types.js';
import type { Input, Config, Evidence, Action, Batch, Ports, Evaluate, Report } from './types.js';

export interface RunDeps { ports: Ports; evaluate: Evaluate; now: () => number }
export function actionsFor(input: Input, evidence: readonly Evidence[], visited: ReadonlySet<string>): Action[] {
  const choices = new Map<string, Action>();
  for (const term of input.terms) {
    const key = digest(term);
    choices.set(`code_${key}`, { id: `code_${key}`, kind: 'code', query: term });
    choices.set(`memory_${key}`, { id: `memory_${key}`, kind: 'memory', query: term });
  }
  for (const item of evidence) if (item.nodeId) {
    choices.set(`expand_${item.nodeId}`, { id: `expand_${item.nodeId}`, kind: 'expand', nodeId: item.nodeId });
    choices.set(`source_${item.nodeId}`, { id: `source_${item.nodeId}`, kind: 'source', nodeId: item.nodeId });
    if (item.nodeName?.trim()) {
      const query = item.nodeName.slice(0, 100);
      const key = digest(query);
      choices.set(`memory_${key}`, { id: `memory_${key}`, kind: 'memory', query });
    }
  }
  return [...choices.values()].filter(action => !visited.has(action.id));
}
async function dispatch(action: Action, ports: Ports): Promise<Batch> {
  switch (action.kind) {
    case 'code': return ports.code(action.query);
    case 'memory': return ports.memory(action.query);
    case 'expand': return ports.expand(action.nodeId);
    case 'source': return ports.source(action.nodeId);
  }
}

export function fitState(input: Input, evidence: readonly Evidence[], actions: readonly Action[], config: Config):
  { evidence: Evidence[]; actions: Action[]; omitted: number } {
  const kept = [...evidence];
  let offered = actions.slice(0, LIMITS.actions);
  while (true) {
    const nodes = new Set(kept.map(item => item.nodeId).filter(id => id !== undefined));
    offered = offered.filter(action => !('nodeId' in action) || nodes.has(action.nodeId));
    if (Buffer.byteLength(JSON.stringify(makeRequest(input, kept, offered, config)), 'utf8') <= LIMITS.requestBytes) {
      return { evidence: kept, actions: offered, omitted: evidence.length - kept.length + actions.length - offered.length };
    }
    if (kept.length) kept.pop();
    else if (offered.length) offered.pop();
    else throw new ProviderError('oversize', 0);
  }
}

export async function runNavigation(input: Input, config: Config, deps: RunDeps, incoming: AbortSignal): Promise<Report> {
  const report = emptyReport('evidence', 'complete');
  const deadline = deps.now() + LIMITS.scheduleMs;
  const clock = new AbortController();
  const timer = setTimeout(() => clock.abort(), LIMITS.scheduleMs);
  const signal = AbortSignal.any([incoming, clock.signal]);
  const visited = new Set<string>();
  const items = new Map<string, Evidence>();
  const protectedIds = new Set<string>();
  let lastAssessed = new Set<string>();
  const ranked = () => [...items.values()].sort((a, b) => (b.score ?? -1) - (a.score ?? -1));
  const prioritized = () => ranked().sort((a, b) => Number(protectedIds.has(b.id)) - Number(protectedIds.has(a.id)));
  const interrupted = (): boolean => {
    if (incoming.aborted) { report.status = 'cancelled'; report.stop = 'cancelled'; return true; }
    if (clock.signal.aborted || deps.now() >= deadline) {
      report.status = items.size ? 'partial' : 'unavailable'; report.stop = 'deadline'; return true;
    }
    return false;
  };
  const merge = (batch: Batch, protect = false) => {
    report.gaps.push(...batch.gaps);
    const fresh = new Set<string>();
    for (const raw of batch.evidence) {
      if (raw.kind === 'memory' && raw.ref.length > 512) {
        report.omitted++; report.gaps.push('Oversized memory reference omitted; inspect ordinary search.'); continue;
      }
      const shortened = raw.ref.length > 512 || (raw.nodeName?.length ?? 0) > 512;
      const item: Evidence = { ...raw, text: raw.text.slice(0, 2400), ref: raw.ref.slice(0, 512),
        ...(raw.nodeName === undefined ? {} : { nodeName: raw.nodeName.slice(0, 512) }),
        truncated: raw.truncated || raw.text.length > 2400 || shortened };
      if (shortened) report.gaps.push('A non-memory reference or name was shortened.');
      const previous = items.get(item.id);
      if (previous?.text === item.text && previous.hash === item.hash && previous.score !== undefined) item.score = previous.score;
      else { delete item.score; lastAssessed.delete(item.id); }
      items.set(item.id, item); fresh.add(item.id);
      if (protect) protectedIds.add(item.id);
    }
    const ordered = [...items.values()].sort((a, b) =>
      Number(protectedIds.has(b.id)) - Number(protectedIds.has(a.id))
      || Number(fresh.has(b.id)) - Number(fresh.has(a.id)) || (b.score ?? -1) - (a.score ?? -1));
    if (ordered.length > LIMITS.evidence) {
      report.omitted += ordered.length - LIMITS.evidence;
      report.gaps.push('Evidence cap reached; additional evidence omitted.');
      items.clear(); for (const item of ordered.slice(0, LIMITS.evidence)) items.set(item.id, item);
    }
  };
  const retrieve = async (kind: string, read: () => Promise<Batch>, protect = false) => {
    if (interrupted()) return;
    try { const batch = await read(); merge(batch, protect); }
    catch { report.gaps.push(`${kind} retrieval unavailable; inspect with ordinary mai tools.`); }
    interrupted();
  };
  try {
    merge({ evidence: input.context.map(context => ({ id: `c_${digest(`${context.label}\0${context.text}`)}`,
      kind: 'context', ref: context.label, text: context.text, hash: digest(context.text),
      freshness: 'caller-supplied; not source-verified', truncated: false })), gaps: [] }, true);
    if (input.intent === 'family') report.gaps.push('Only supplied plan excerpts were assessed; continue the required family sweep.');
    for (const id of input.seed_nodes) {
      await retrieve('seed', () => deps.ports.seed(id), true);
      if (interrupted()) break;
    }
    await retrieve('code', () => deps.ports.code(input.question));
    await retrieve('memory', () => deps.ports.memory(input.question));
    if (!interrupted() && items.size === 0 && actionsFor(input, [], visited).length === 0) {
      report.status = 'insufficient_context'; report.stop = 'no_attributable_evidence';
      report.gaps.push('No attributable evidence; supply known seeds, terms or labelled excerpts.');
    } else while (!interrupted() && report.evaluations < LIMITS.evaluations) {
      const finalRound = report.evaluations === LIMITS.evaluations - 1;
      const known = actionsFor(input, prioritized(), visited);
      const fitted = fitState(input, prioritized(), finalRound ? [] : known, config);
      report.omitted += fitted.omitted;
      if (fitted.omitted) report.gaps.push('Request state or action budget omitted complete items.');
      let result;
      try { result = await deps.evaluate(input, fitted.evidence, fitted.actions, config, signal); }
      catch (error) {
        const attempts = error instanceof ProviderError ? error.attempts : 0;
        report.attempts += attempts;
        if (attempts) report.gaps.push('Usage unknown for failed HTTP attempts; known tokens are incomplete.');
        if (error instanceof ProviderError && error.code === 'invalid_response' && error.mismatch) {
          report.gaps.push(`Provider response rejected (${error.mismatch}); no response content retained.`);
        }
        if (!interrupted()) {
          report.status = items.size ? 'partial' : 'unavailable';
          report.stop = error instanceof ProviderError ? error.code : 'provider_unavailable';
          report.gaps.push('Provider evaluation unavailable; retained evidence has no new verified assessment.');
        }
        break;
      }
      report.evaluations++; report.attempts += result.attempts;
      report.inputTokens += result.inputTokens; report.outputTokens += result.outputTokens;
      report.model = result.model;
      if (result.attempts > 1) report.gaps.push('Usage unknown for retried HTTP attempts; known tokens cover valid responses only.');
      if (interrupted()) break;
      for (const item of items.values()) delete item.score;
      lastAssessed = new Set<string>();
      for (const sent of fitted.evidence) {
        const item = items.get(sent.id), score = result.scores[sent.id];
        if (item && typeof score === 'number' && Number.isFinite(score) && score >= 0 && score <= 1) {
          item.score = score; lastAssessed.add(sent.id);
        }
      }
      const chosen = fitted.actions.find(action => action.id === result.choice);
      if (result.choice !== 'stop' && !chosen) {
        report.status = items.size ? 'partial' : 'unavailable'; report.stop = 'invalid_choice';
        report.gaps.push('Provider selected an unoffered action; nothing dispatched.'); break;
      }
      report.trace.push(`${result.choice}; selection confidence=${result.confidence}`);
      if (!chosen) { report.stop = finalRound && known.length ? 'work_cap' : 'stop'; break; }
      visited.add(chosen.id);
      await retrieve(chosen.kind, () => dispatch(chosen, deps.ports));
    }
  } catch (error) {
    if (!interrupted()) {
      report.status = items.size ? 'partial' : 'unavailable';
      report.stop = error instanceof ProviderError ? error.code : 'navigation_unavailable';
      report.gaps.push('Navigation stopped; inspect retained references using ordinary tools.');
    }
  } finally { clearTimeout(timer); }
  report.evidence = ranked();
  report.actionsRemaining = actionsFor(input, prioritized(), visited).length;
  if (report.evidence.some(item => !lastAssessed.has(item.id))) report.gaps.push('Some retained evidence was not assessed in the last evaluation.');
  if (report.evidence.some(item => item.truncated)) report.gaps.push('Evidence contains bounded excerpts or shortened references.');
  if (report.stop === 'work_cap') report.gaps.push('Follow-up retrieval cap reached; continue with ordinary tools or a narrower question.');
  report.gaps = [...new Set(report.gaps)];
  if (report.status === 'evidence' && (report.gaps.length || report.omitted)) report.status = 'partial';
  return report;
}

export interface NavigatorDeps {
  loadConfig(signal: AbortSignal): Promise<{ projectId: string; resolved: ResolvedJevConfig }>;
  run(input: Input, config: Config, projectId: string, signal: AbortSignal): Promise<Report>;
}
export function createNavigator(deps: NavigatorDeps): (raw: unknown, signal?: AbortSignal) => Promise<Report> {
  let busy = false;
  return async (raw, signal = new AbortController().signal) => {
    const input = normalizeInput(raw);
    if (signal.aborted) return emptyReport('cancelled', 'cancelled');
    if (busy) return emptyReport('busy', 'another_navigation_active');
    busy = true;
    try {
      const { projectId, resolved } = await deps.loadConfig(signal);
      if (signal.aborted) return emptyReport('cancelled', 'cancelled');
      if (resolved.state !== 'ready') return emptyReport(resolved.state, resolved.reason);
      const report = await deps.run(input, resolved.config, projectId, signal);
      return signal.aborted ? { ...report, status: 'cancelled', stop: 'cancelled' } : report;
    } catch {
      return emptyReport(signal.aborted ? 'cancelled' : 'unavailable', signal.aborted ? 'cancelled' : 'configuration_or_navigation_unavailable');
    } finally { busy = false; }
  };
}
export const navigate = createNavigator({
  async loadConfig(signal) { const projectId = await getProjectId(); return { projectId, resolved: await resolveJevConfig(projectId, signal) }; },
  run: (input, config, projectId, signal) => runNavigation(input, config, { ports: createPorts(projectId), evaluate, now: Date.now }, signal),
});
