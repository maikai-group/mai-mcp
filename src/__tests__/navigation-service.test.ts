import { describe, expect, it, vi } from 'vitest';
import type { Batch, Evidence, Evaluate, Ports } from '../navigation/types.js';
import { normalizeInput } from '../navigation/input.js';
import { runNavigation } from '../navigation/service.js';
const config = { key: 'test-only', model: 'jev-1.13.0' };
const empty = (): Promise<Batch> => Promise.resolve({ evidence: [], gaps: [] });
function node(id: string, text: string): Evidence {
  return { id: `n_${id}`, kind: 'node', nodeId: id, nodeName: id, ref: `${id}.ts:1`,
    text, hash: null, freshness: 'fixture', truncated: false };
}
it('discovers a causal sibling through a selected graph expansion', async () => {
  const a = node('a', 'Guard applied only after persistence');
  const sibling = node('b', 'Check occurs after database insert');
  const distractor = node('c', 'Guard clause protects the insert before it executes');
  const expand = vi.fn<Ports['expand']>().mockResolvedValue({ evidence: [sibling], gaps: [] });
  const ports: Ports = { code: async () => ({ evidence: [a, distractor], gaps: [] }),
    memory: empty, seed: empty, expand, source: empty };
  const assess = vi.fn<Evaluate>().mockImplementation(async (_input, evidence, actions) => {
    const next = actions.find(action => action.kind === 'expand' && action.nodeId === 'a');
    return { model: config.model, choice: next?.id ?? 'stop', confidence: 0.8,
      scores: Object.fromEntries(evidence.map(item => [item.id, item.nodeId === 'c' ? 0.1 : 0.9])),
      inputTokens: 20, outputTokens: 0, attempts: 1 };
  });
  const input = normalizeInput({ intent: 'family', question: 'Where does validation happen too late?',
    mechanism: 'A persistent write occurs before the rejecting guard.',
    context: [{ label: 'Plan Task 9', text: 'Insert, then validate.' }] });
  const result = await runNavigation(input, config, { ports, evaluate: assess, now: Date.now },
    new AbortController().signal);
  expect(expand).toHaveBeenCalledWith('a');
  expect(result.evidence.find(item => item.nodeId === 'b')?.score).toBe(0.9);
  expect(result.evidence.find(item => item.nodeId === 'c')?.score).toBe(0.1);
  expect(result.gaps.join(' ')).toContain('supplied plan excerpts');
  expect(result.trace.join(' ')).toContain('expand_a');
  expect(result.status).toBe('partial');
});

import { createNavigator, fitState } from '../navigation/service.js';
import { renderNavigation } from '../navigation/render.js';
import { emptyReport, LIMITS } from '../navigation/types.js';
import type { Report } from '../navigation/types.js';
import type { NavigatorDeps } from '../navigation/service.js';
import { ProviderError, makeRequest } from '../navigation/provider.js';
const base = { question: 'layout', intent: 'layout' };
const normalized = normalizeInput(base);
function portsFor(evidence: Evidence[] = []): Ports {
  return { code: async () => ({ evidence, gaps: [] }), memory: empty, seed: empty, source: empty, expand: empty };
}
const stop: Evaluate = async (_input, evidence) => ({ model: config.model, choice: 'stop', confidence: 1,
  scores: Object.fromEntries(evidence.map(item => [item.id, 0.5])), inputTokens: 1, outputTokens: 2, attempts: 1 });
const ready: NavigatorDeps['loadConfig'] = async () => ({ projectId: 'pinned', resolved: { state: 'ready', config, revision: 1, credentialSource: 'saved' } });
it.each(['not_enabled', 'missing_key'] as const)('disabled %s never runs retrieval', async reason => {
  const run = vi.fn<NavigatorDeps['run']>();
  const call = createNavigator({ loadConfig: async () => ({ projectId: 'pinned', resolved: { state: 'disabled', reason } }), run });
  expect(await call(base)).toMatchObject({ status: 'disabled', stop: reason });
  expect(run).not.toHaveBeenCalled();
});
it('maps unavailable and configuration failure without leaking exceptions', async () => {
  const run = vi.fn<NavigatorDeps['run']>();
  const loadConfig = vi.fn<NavigatorDeps['loadConfig']>().mockResolvedValueOnce({ projectId: 'pinned', resolved: { state: 'unavailable', reason: 'store_unavailable' } }).mockRejectedValueOnce(Error(config.key));
  const call = createNavigator({ loadConfig, run });
  expect(await call(base)).toMatchObject({ status: 'unavailable', stop: 'store_unavailable' });
  expect(JSON.stringify(await call(base))).not.toContain(config.key);
  expect(run).not.toHaveBeenCalled();
});
it('passes pinned saved config and observes replacement on next call', async () => {
  const loadConfig = vi.fn<NavigatorDeps['loadConfig']>().mockImplementationOnce(ready).mockResolvedValueOnce({ projectId: 'pinned', resolved: { state: 'ready', config: { ...config, key: 'rotated' }, revision: 2, credentialSource: 'saved' } });
  const run = vi.fn<NavigatorDeps['run']>().mockResolvedValue(emptyReport('evidence', 'stop'));
  const call = createNavigator({ loadConfig, run });
  await call(base); await call(base);
  expect(run.mock.calls[0]?.slice(1, 3)).toEqual([config, 'pinned']);
  expect(run.mock.calls[1]?.[1].key).toBe('rotated');
});
it('holds the busy slot during config/run and releases it after completion and failure', async () => {
  let release: ((report: Report) => void) | undefined;
  const run = vi.fn<NavigatorDeps['run']>().mockImplementationOnce(() => new Promise(resolve => { release = resolve; }))
    .mockRejectedValueOnce(Error('private')).mockResolvedValue(emptyReport('evidence', 'stop'));
  const loadConfig = vi.fn<NavigatorDeps['loadConfig']>().mockImplementation(ready);
  const call = createNavigator({ loadConfig, run });
  const first = call(base); await Promise.resolve();
  expect(await call(base)).toMatchObject({ status: 'busy' });
  expect(loadConfig).toHaveBeenCalledOnce(); expect(run).toHaveBeenCalledOnce();
  if (!release) throw Error('run did not start'); release(emptyReport('evidence', 'stop')); await first;
  expect(await call(base)).toMatchObject({ status: 'unavailable' });
  expect(await call(base)).toMatchObject({ status: 'evidence' });
});
it('cancels during config and releases the busy slot', async () => {
  const c = new AbortController();
  const run = vi.fn<NavigatorDeps['run']>().mockResolvedValue(emptyReport('evidence', 'stop'));
  const call = createNavigator({ loadConfig: async signal => { if (signal === c.signal) c.abort(); return ready(signal); }, run });
  expect(await call(base, c.signal)).toMatchObject({ status: 'cancelled' });
  expect(run).not.toHaveBeenCalled();
  expect(await call(base)).toMatchObject({ status: 'evidence' });
});
it('rejects invalid input before configuration', async () => {
  const loadConfig = vi.fn<NavigatorDeps['loadConfig']>();
  await expect(createNavigator({ loadConfig, run: vi.fn() })({ ...base, project_id: 'foreign' })).rejects.toThrow();
  expect(loadConfig).not.toHaveBeenCalled();
});
it('cancellation waits for an active retrieval and prevents subsequent work', async () => {
  let release: ((batch: Batch) => void) | undefined;
  const code = vi.fn<Ports['code']>().mockImplementation(() => new Promise(resolve => { release = resolve; }));
  const memory = vi.fn<Ports['memory']>(); const assess = vi.fn<Evaluate>();
  const c = new AbortController();
  const pending = runNavigation(normalized, config, { ports: { ...portsFor(), code, memory }, evaluate: assess, now: Date.now }, c.signal);
  c.abort(); if (!release) throw Error('retrieval not started'); release({ evidence: [node('a', 'retained')], gaps: [] });
  const result = await pending;
  expect(result.status).toBe('cancelled'); expect(result.evidence).toHaveLength(1);
  expect(memory).not.toHaveBeenCalled(); expect(assess).not.toHaveBeenCalled();
});
it('stops scheduling after deadline observed at a retrieval boundary', async () => {
  let now = 0; const memory = vi.fn<Ports['memory']>();
  const result = await runNavigation(normalized, config, { now: () => now, evaluate: vi.fn(), ports: { ...portsFor(), memory,
    code: async () => { now = 60001; return { evidence: [node('a', 'kept')], gaps: [] }; } } }, new AbortController().signal);
  expect(result).toMatchObject({ status: 'partial', stop: 'deadline' }); expect(memory).not.toHaveBeenCalled();
});
it('unknown action never dispatches and repeated actions cannot run twice', async () => {
  const expand = vi.fn<Ports['expand']>().mockResolvedValue({ evidence: [], gaps: [] });
  for (const choice of ['shell', 'expand_a']) {
    expand.mockClear();
    const assess: Evaluate = async (...args) => ({ ...await stop(...args), choice });
    const result = await runNavigation(normalized, config, { ports: { ...portsFor([node('a', 'a')]), expand }, evaluate: assess, now: Date.now }, new AbortController().signal);
    expect(expand).toHaveBeenCalledTimes(choice === 'shell' ? 0 : 1); expect(result.stop).toBe('invalid_choice');
  }
});
it('three selected retrievals receive a fourth assessment with no offered actions', async () => {
  const assess = vi.fn<Evaluate>().mockImplementation(async (...args) => ({ ...await stop(...args), choice: args[2][0]?.id ?? 'stop' }));
  const code = vi.fn<Ports['code']>().mockResolvedValue({ evidence: [node('a', 'a')], gaps: [] });
  const memory = vi.fn<Ports['memory']>().mockResolvedValue({ evidence: [], gaps: [] });
  const result = await runNavigation(normalizeInput({ ...base, terms: ['one', 'two'] }), config, { ports: { ...portsFor(), code, memory }, evaluate: assess, now: Date.now }, new AbortController().signal);
  expect(assess).toHaveBeenCalledTimes(4); expect(assess.mock.calls[3]?.[2]).toEqual([]);
  expect(code.mock.calls.length + memory.mock.calls.length).toBe(5);
  expect(result).toMatchObject({ status: 'partial', stop: 'work_cap', attempts: 4 });
});
it('fits Unicode by encoded bytes and sheds whole evidence and its node actions', () => {
  const evidence = Array.from({ length: 32 }, (_, i) => node(`${i}`, '界'.repeat(2400)));
  const actions = evidence.map(item => ({ id: `source_${item.nodeId}`, kind: 'source' as const, nodeId: item.nodeId ?? '' }));
  const fitted = fitState(normalized, evidence, actions, config);
  expect(fitted.omitted).toBeGreaterThan(0);
  expect(Buffer.byteLength(JSON.stringify(makeRequest(normalized, fitted.evidence, fitted.actions, config)))).toBeLessThanOrEqual(LIMITS.requestBytes);
  expect(fitted.evidence.every(item => item.text.length === 2400)).toBe(true);
  expect(fitted.actions.every(action => action.kind === 'source' && fitted.evidence.some(item => item.nodeId === action.nodeId))).toBe(true);
});
it('caps retained evidence, preserves caller context, and marks stale gaps partial', async () => {
  const result = await runNavigation(normalizeInput({ ...base, context: [{ label: 'plan', text: '  exact\n' }] }), config, { ports: { ...portsFor(), code: async () => ({ evidence: Array.from({ length: 40 }, (_, i) => node(`${i}`, 'a')), gaps: ['stale and capped'] }) }, evaluate: stop, now: Date.now }, new AbortController().signal);
  expect(result.evidence).toHaveLength(32);
  expect(result.omitted).toBe(9 + 61); // Nine evidence items and 93 - 32 offered actions.
  expect(result.evidence.find(item => item.kind === 'context')?.text).toBe('  exact\n'); expect(result.status).toBe('partial');
});
it('returns insufficient context without inference for empty retrieval', async () => {
  const assess = vi.fn<Evaluate>();
  const result = await runNavigation(normalized, config, { ports: portsFor(), evaluate: assess, now: Date.now }, new AbortController().signal);
  expect(result.status).toBe('insufficient_context'); expect(assess).not.toHaveBeenCalled();
});
it('retains memory identity and records unknown usage on provider failure', async () => {
  const memory: Evidence = { id: 'memory', kind: 'memory', ref: 'decision 11111111-1111-1111-1111-111111111111 (user-approved)', text: 'rationale', hash: null, freshness: 'recorded', truncated: false };
  const result = await runNavigation(normalized, config, { ports: portsFor([memory]), evaluate: async () => { throw new ProviderError('auth', 1); }, now: Date.now }, new AbortController().signal);
  expect(result).toMatchObject({ status: 'partial', attempts: 1, stop: 'auth' });
  expect(result.evidence[0]?.ref).toBe(memory.ref); expect(result.gaps.join(' ')).toContain('Usage unknown');
});
it('reports only a privacy-safe provider mismatch category', async () => {
  const result = await runNavigation(normalized, config, { ports: portsFor([node('a', 'a')]),
    evaluate: async () => { throw new ProviderError('invalid_response', 1, 'probability_total'); },
    now: Date.now }, new AbortController().signal);
  expect(result).toMatchObject({ status: 'partial', stop: 'invalid_response' });
  expect(result.gaps.join(' ')).toContain('probability_total');
  expect(JSON.stringify(result)).not.toContain(config.key);
});
it('renders whole blocks and puts partial coverage first', () => {
  const report = { ...emptyReport('evidence', 'stop'), evidence: [node('a', 'long'.repeat(300))] };
  const rendered = renderNavigation(report, { fullRows: 3, charBudget: 1100 });
  expect(rendered).toMatch(/^# Navigation: partial/); expect(rendered).toContain('not exhaustive');
  const small = renderNavigation(report, { fullRows: 3, charBudget: 300 });
  expect(small).toMatch(/^Navigation: partial/); expect(small).toContain('0/1'); expect(small).not.toContain('###');
  expect(small.length).toBeLessThanOrEqual(300);
});
