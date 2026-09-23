import { afterEach, describe, expect, it, vi } from 'vitest';
import { decodeEvaluation, evaluate, makeRequest } from '../navigation/provider.js';
import { normalizeInput } from '../navigation/input.js';
const config = { key: 'never-return-this-key', model: 'jev-1.13.0' };
const input = normalizeInput({ question: 'Where is the guard?', intent: 'layout' });
const body = makeRequest(input, [], [], config);
const good = { model: 'jev-1.13.0', answers: { next: {
  type: 'choice', choice: 'stop', probabilities: { stop: 1 }, confidence: 1,
} }, usage: { input_tokens: 11, output_tokens: 2 } };
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); vi.useRealTimers(); });
describe('Jev transport', () => {
  it('uses the typed endpoint without exposing the key in state', async () => {
    const http = vi.fn<typeof fetch>().mockResolvedValue(new Response(JSON.stringify(good)));
    vi.stubGlobal('fetch', http);
    expect(await evaluate(input, [], [], config, new AbortController().signal))
      .toMatchObject({ choice: 'stop', attempts: 1, inputTokens: 11 });
    const call = http.mock.calls[0];
    if (!call) throw Error('Expected request');
    expect(call[0]).toBe('https://api.typesafe.ai/v1/systemone');
    expect(call[1]?.redirect).toBe('error');
    expect(call[1]?.body).not.toContain(config.key);
  });
  it.each([
    { ...good, answers: {} },
    { ...good, answers: { next: { type: 'choice', choice: 'shell', probabilities: { shell: 1 }, confidence: 1 } } },
    { ...good, usage: { input_tokens: -1, output_tokens: 0 } },
    { ...good, answers: { next: { type: 'choice', choice: 'stop', probabilities: { stop: 0.2 }, confidence: 1 } } },
  ])('rejects malformed response %#', raw => {
    expect(() => decodeEvaluation(raw, body, 1)).toThrow('Jev invalid_response');
  });
  it('classifies a structural mismatch without retaining response content', () => {
    let caught: unknown;
    try { decodeEvaluation({ ...good, answers: {} }, body, 1); } catch (error) { caught = error; }
    expect(caught).toMatchObject({ code: 'invalid_response', mismatch: 'answer_keys', attempts: 1 });
    expect(JSON.stringify(caught)).not.toContain(config.key);
  });
  it('accepts two-decimal Choice probabilities whose rounded total is 0.99', () => {
    const actions = [
      { id: 'code_one', kind: 'code' as const, query: 'one' },
      { id: 'code_two', kind: 'code' as const, query: 'two' },
    ];
    const request = makeRequest(input, [], actions, config);
    const rounded = { ...good, answers: { next: {
      type: 'choice', choice: 'code_one',
      probabilities: { stop: 0.33, code_one: 0.33, code_two: 0.33 }, confidence: 0.5,
    } } };
    expect(decodeEvaluation(rounded, request, 1)).toMatchObject({ choice: 'code_one' });
  });
  it('does not retry auth failures or return the raw body', async () => {
    const http = vi.fn<typeof fetch>().mockResolvedValue(new Response(config.key, { status: 401 }));
    vi.stubGlobal('fetch', http);
    await expect(evaluate(input, [], [], config, new AbortController().signal)).rejects.toThrow('Jev auth');
    expect(http).toHaveBeenCalledOnce();
  });
  it('makes no request after cancellation', async () => {
    const http = vi.fn<typeof fetch>(); vi.stubGlobal('fetch', http);
    const controller = new AbortController(); controller.abort();
    await expect(evaluate(input, [], [], config, controller.signal)).rejects.toThrow('Jev cancelled');
    expect(http).not.toHaveBeenCalled();
  });
});

it.each([429, 529])('retries %s exactly once', async status => {
  vi.useFakeTimers();
  const http = vi.fn<typeof fetch>().mockResolvedValueOnce(new Response('', { status }))
    .mockResolvedValueOnce(new Response(JSON.stringify(good)));
  vi.stubGlobal('fetch', http);
  const pending = evaluate(input, [], [], config, new AbortController().signal);
  await vi.advanceTimersByTimeAsync(500);
  expect(await pending).toMatchObject({ attempts: 2 });
  expect(http).toHaveBeenCalledTimes(2);
});
it.each([408, 500, 502, 503, 504])('retries transient HTTP %s', async status => {
  vi.useFakeTimers();
  vi.spyOn(Math, 'random').mockReturnValue(0);
  const http = vi.fn<typeof fetch>().mockResolvedValueOnce(new Response('', { status }))
    .mockResolvedValueOnce(new Response(JSON.stringify(good)));
  vi.stubGlobal('fetch', http);
  const pending = evaluate(input, [], [], config, new AbortController().signal);
  await vi.advanceTimersByTimeAsync(500);
  expect(await pending).toMatchObject({ attempts: 2 });
  expect(http).toHaveBeenCalledTimes(2);
});
it('retries a transient network failure', async () => {
  vi.useFakeTimers();
  vi.spyOn(Math, 'random').mockReturnValue(0);
  const http = vi.fn<typeof fetch>().mockRejectedValueOnce(new TypeError('offline'))
    .mockResolvedValueOnce(new Response(JSON.stringify(good)));
  vi.stubGlobal('fetch', http);
  const pending = evaluate(input, [], [], config, new AbortController().signal);
  await vi.advanceTimersByTimeAsync(500);
  expect(await pending).toMatchObject({ attempts: 2 });
  expect(http).toHaveBeenCalledTimes(2);
});
it('honours a bounded retry-after-ms response header', async () => {
  const http = vi.fn<typeof fetch>()
    .mockResolvedValueOnce(new Response(null, { status: 503, headers: { 'retry-after-ms': '1200' } }))
    .mockResolvedValueOnce(new Response(JSON.stringify(good)));
  vi.stubGlobal('fetch', http);
  const pending = evaluate(input, [], [], config, new AbortController().signal);
  await new Promise(resolve => setTimeout(resolve, 650));
  expect(http).toHaveBeenCalledOnce();
  expect(await pending).toMatchObject({ attempts: 2 });
  expect(http).toHaveBeenCalledTimes(2);
});
it('caps a long retry-after-ms response header at the configured maximum', async () => {
  vi.spyOn(Math, 'random').mockReturnValue(0);
  const http = vi.fn<typeof fetch>()
    .mockResolvedValueOnce(new Response(null, { status: 503, headers: { 'retry-after-ms': '10000' } }))
    .mockResolvedValueOnce(new Response(JSON.stringify(good)));
  vi.stubGlobal('fetch', http);
  const controller = new AbortController();
  const pending = evaluate(input, [], [], config, controller.signal)
    .then(value => ({ value }), error => ({ error }));
  await new Promise(resolve => setTimeout(resolve, 650));
  expect(http).toHaveBeenCalledOnce();
  controller.abort();
  expect(await pending).toMatchObject({ error: { code: 'cancelled', attempts: 1 } });
});
it('does not retry a structurally invalid successful response', async () => {
  const http = vi.fn<typeof fetch>().mockResolvedValue(new Response(JSON.stringify({ ...good, answers: {} })));
  vi.stubGlobal('fetch', http);
  await expect(evaluate(input, [], [], config, new AbortController().signal)).rejects
    .toMatchObject({ code: 'invalid_response', mismatch: 'answer_keys', attempts: 1 });
  expect(http).toHaveBeenCalledOnce();
});
it('terminates after the bounded transient-response attempts', async () => {
  vi.useFakeTimers();
  vi.spyOn(Math, 'random').mockReturnValue(0);
  const http = vi.fn<typeof fetch>().mockImplementation(async () => new Response('', { status: 529 }));
  vi.stubGlobal('fetch', http);
  const pending = expect(evaluate(input, [], [], config, new AbortController().signal)).rejects.toMatchObject({ code: 'http', attempts: 3 });
  await vi.advanceTimersByTimeAsync(1500); await pending;
  expect(http).toHaveBeenCalledTimes(3);
});
it('cancels during retry delay', async () => {
  vi.useFakeTimers();
  const http = vi.fn<typeof fetch>().mockResolvedValue(new Response('', { status: 429 }));
  vi.stubGlobal('fetch', http);
  const controller = new AbortController();
  const pending = expect(evaluate(input, [], [], config, controller.signal)).rejects.toMatchObject({ code: 'cancelled', attempts: 1 });
  await vi.advanceTimersByTimeAsync(0); controller.abort(); await pending;
  expect(http).toHaveBeenCalledOnce();
});
it('cancels a waiting response stream', async () => {
  const cancel = vi.fn();
  const http = vi.fn<typeof fetch>().mockResolvedValue(new Response(new ReadableStream({ cancel })));
  vi.stubGlobal('fetch', http);
  const controller = new AbortController();
  const pending = expect(evaluate(input, [], [], config, controller.signal)).rejects.toMatchObject({ code: 'cancelled' });
  await Promise.resolve(); await Promise.resolve(); controller.abort(); await pending;
  expect(cancel).toHaveBeenCalledOnce();
});
it('bounds actual streamed bytes without Content-Length', async () => {
  const cancel = vi.fn();
  vi.stubGlobal('fetch', vi.fn<typeof fetch>().mockResolvedValue(new Response(new ReadableStream({
    start(c) { c.enqueue(new Uint8Array(32768)); c.enqueue(new Uint8Array(32769)); }, cancel,
  }))));
  await expect(evaluate(input, [], [], config, new AbortController().signal)).rejects.toMatchObject({ code: 'oversize' });
  expect(cancel).toHaveBeenCalledOnce();
});
it.each([new Uint8Array([255]), new TextEncoder().encode('{broken')])('rejects invalid response encoding %#', async bytes => {
  vi.stubGlobal('fetch', vi.fn<typeof fetch>().mockResolvedValue(new Response(bytes)));
  await expect(evaluate(input, [], [], config, new AbortController().signal)).rejects.toMatchObject({ code: 'invalid_response' });
});
it('rejects an omitted Noul answer', () => {
  const request = makeRequest(input, [{ id: 'one', kind: 'context', ref: 'plan', text: 'guard', freshness: 'caller', hash: null, truncated: false }], [], config);
  expect(() => decodeEvaluation(good, request, 1)).toThrow('Jev invalid_response');
});
it('maps attempt timeout without disclosing transport diagnostics', async () => {
  vi.useFakeTimers();
  vi.spyOn(Math, 'random').mockReturnValue(0);
  const timeout = vi.spyOn(AbortSignal, 'timeout').mockImplementation(() => AbortSignal.abort());
  vi.stubGlobal('fetch', vi.fn<typeof fetch>().mockRejectedValue(Error(config.key)));
  try {
    const pending = expect(evaluate(input, [], [], config, new AbortController().signal)).rejects.toMatchObject({ code: 'timeout', attempts: 3 });
    await vi.advanceTimersByTimeAsync(0);
    await vi.advanceTimersByTimeAsync(500);
    await vi.advanceTimersByTimeAsync(1_000);
    await pending;
  } finally { timeout.mockRestore(); }
});
it('accepts an offered retrieval with Noul scores and rejects a nonmaximum choice', async () => {
  const evidence = [{ id: 'one', kind: 'context' as const, ref: 'plan', text: 'guard', freshness: 'caller', hash: null, truncated: false }];
  const actions = [{ id: 'code_one', kind: 'code' as const, query: 'guard' }];
  const response = { ...good, answers: {
    next: { type: 'choice', choice: 'code_one', probabilities: { stop: 0.2, code_one: 0.8 }, confidence: 0.6 },
    r_one: { type: 'noul', noul: 0.7 },
  } };
  vi.stubGlobal('fetch', vi.fn<typeof fetch>().mockResolvedValue(new Response(JSON.stringify(response))));
  expect(await evaluate(input, evidence, actions, config, new AbortController().signal)).toEqual({
    model: config.model, choice: 'code_one', confidence: 0.6, scores: { one: 0.7 }, inputTokens: 11, outputTokens: 2, attempts: 1,
  });
  expect(() => decodeEvaluation({ ...response, answers: { ...response.answers, next: { ...response.answers.next, choice: 'stop' } } }, makeRequest(input, evidence, actions, config), 1)).toThrow('Jev invalid_response');
});
