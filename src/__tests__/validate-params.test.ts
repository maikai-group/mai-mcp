/**
 * Boundary validation for tool params. The MCP SDK's low-level API does NOT
 * enforce inputSchema, and neither does the client — so missing/misnamed
 * params used to blind-cast through the dispatch and surface as opaque
 * TypeErrors deep in the call path ("Cannot read properties of undefined").
 * Live failure 2026-06-12: an agent dropped `evidence` from mai_progress,
 * read the TypeError as a server bug, and abandoned the capture.
 */
import { describe, it, expect } from 'vitest';
import { specFromInputSchema, validateRequiredParams, rejectMergedParams } from '../validate-params.js';

describe('specFromInputSchema', () => {
  it('splits schema properties into required and optional', () => {
    const spec = specFromInputSchema({
      properties: { milestone: {}, evidence: {}, mode: {} },
      required: ['milestone', 'evidence'],
    });
    expect(spec.required).toEqual(['milestone', 'evidence']);
    expect(spec.optional).toEqual(['mode']);
  });

  it('handles a schema with no required list (all params optional)', () => {
    const spec = specFromInputSchema({ properties: { days: {}, limit: {} } });
    expect(spec.required).toEqual([]);
    expect(spec.optional).toEqual(['days', 'limit']);
  });
});

describe('validateRequiredParams', () => {
  const progressSpec = { required: ['milestone', 'evidence'], optional: [] };

  it('passes when all required params are present', () => {
    expect(() =>
      validateRequiredParams(
        'mai_progress',
        { milestone: 'shipped the thing', evidence: { type: 'progress', file_path: 'x.ts' } },
        progressSpec
      )
    ).not.toThrow();
  });

  it('throws naming the missing param', () => {
    expect(() => validateRequiredParams('mai_prime', {}, { required: ['task_description'], optional: ['mode'] }))
      .toThrow(/missing required parameter.*'task_description'/);
  });

  it('lists the keys actually passed, so wrong-key mistakes self-identify', () => {
    // The observed live failure: `summary` passed instead of `milestone`.
    expect(() =>
      validateRequiredParams('mai_progress', { summary: 'x', evidence: { type: 'progress' } }, progressSpec)
    ).toThrow(/You passed: summary, evidence/);
  });

  it('flags unrecognized keys as the likely culprit', () => {
    expect(() =>
      validateRequiredParams('mai_progress', { summary: 'x', evidence: { type: 'progress' } }, progressSpec)
    ).toThrow(/Unrecognized: summary/);
  });

  it('treats null as missing (JSON payloads carry null, not undefined)', () => {
    expect(() =>
      validateRequiredParams('mai_progress', { milestone: 'x', evidence: null }, progressSpec)
    ).toThrow(/missing required parameter.*'evidence'/);
  });

  it('does not throw on extra keys when all required params are present', () => {
    expect(() =>
      validateRequiredParams(
        'mai_progress',
        { milestone: 'x', evidence: { type: 'progress', file_path: 'y.ts' }, stray: true },
        progressSpec
      )
    ).not.toThrow();
  });
});

describe('rejectMergedParams', () => {
  it('catches reasoning/source merged into description via leaked parameter markup', () => {
    // The observed live failure: description swallowed reasoning + source as escaped XML.
    const params = {
      decision_type: 'workflow',
      description:
        'Plan 4 EXECUTED — pushes await review.</parameter>\n<parameter name="reasoning">Records outcome.</parameter>\n<parameter name="source">agent-inferred',
      citation: { kind: 'extends', extends_id: 'abc', how: 'records it' },
    };
    expect(() => rejectMergedParams('mai_remember', params)).toThrow(/only the required parameters/i);
    expect(() => rejectMergedParams('mai_remember', params)).toThrow(/'description'/);
  });

  it('scans nested objects (e.g. citation) for markup too', () => {
    const params = { citation: { kind: 'novel', justification: 'x</parameter><parameter name="source">y' } };
    expect(() => rejectMergedParams('mai_remember', params)).toThrow(/'citation\.justification'/);
  });

  it('passes clean params untouched', () => {
    const params = {
      description: 'Token-bucket rate limiting at the gateway, 100 req/min per key.',
      reasoning: 'Allows bursts while capping sustained throughput.',
      source: 'agent-inferred',
      citation: { kind: 'novel', justification: 'Searched; nothing related exists, so this is new.' },
    };
    expect(() => rejectMergedParams('mai_remember', params)).not.toThrow();
  });
});
