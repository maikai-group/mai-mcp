import { describe, it, expect } from 'vitest';
import { triageReduce, actionTargets, initialTriage, type TriageState } from './triage';
import type { ReviewRow } from '../../lib/types';

const row = (id: string): ReviewRow => ({
  kind: 'decision' as const,
  id, decision_type: 'arch', description: `d-${id}`, reasoning: null,
  confidence: 0.5, source: 'agent-inferred', keywords: [], timestamp: '2026-07-23T00:00:00Z',
});
const rows = [row('a'), row('b'), row('c')];
const loaded: TriageState = { rows, cursor: 0, selected: new Set() };

describe('triageReduce', () => {
  it('load resets cursor + selection', () => {
    const s = triageReduce({ rows: [], cursor: 5, selected: new Set(['x']) }, { type: 'load', rows });
    expect(s.cursor).toBe(0);
    expect(s.selected.size).toBe(0);
    expect(s.rows).toHaveLength(3);
  });

  it('move down advances the cursor', () => {
    expect(triageReduce(loaded, { type: 'move', delta: 1 }).cursor).toBe(1);
  });

  it('move clamps at the top', () => {
    expect(triageReduce(loaded, { type: 'move', delta: -1 }).cursor).toBe(0);
  });

  it('move clamps at the bottom', () => {
    const atEnd = { ...loaded, cursor: 2 };
    expect(triageReduce(atEnd, { type: 'move', delta: 1 }).cursor).toBe(2);
  });

  it('focus sets the cursor, clamped to range', () => {
    expect(triageReduce(loaded, { type: 'focus', index: 2 }).cursor).toBe(2);
    expect(triageReduce(loaded, { type: 'focus', index: 99 }).cursor).toBe(2);
    expect(triageReduce(loaded, { type: 'focus', index: -3 }).cursor).toBe(0);
  });

  it('toggleSelect adds then removes the cursor row', () => {
    const on = triageReduce(loaded, { type: 'toggleSelect' });
    expect([...on.selected]).toEqual(['a']);
    const off = triageReduce(on, { type: 'toggleSelect' });
    expect(off.selected.size).toBe(0);
  });

  it('toggleSelect is a no-op on an empty queue', () => {
    const empty = triageReduce(initialTriage, { type: 'toggleSelect' });
    expect(empty).toBe(initialTriage);
  });

  it('remove filters rows and drops them from the selection', () => {
    const withSel = { ...loaded, cursor: 1, selected: new Set(['a', 'b']) };
    const s = triageReduce(withSel, { type: 'remove', ids: ['a'] });
    expect(s.rows.map((r) => r.id)).toEqual(['b', 'c']);
    expect([...s.selected]).toEqual(['b']);
  });

  it('remove re-clamps the cursor when the tail is deleted', () => {
    const atEnd = { ...loaded, cursor: 2, selected: new Set<string>() };
    const s = triageReduce(atEnd, { type: 'remove', ids: ['c'] });
    expect(s.rows.map((r) => r.id)).toEqual(['a', 'b']);
    expect(s.cursor).toBe(1); // clamped from 2 → last index 1
  });

  it('remove to empty resets the cursor to 0', () => {
    const s = triageReduce({ ...loaded, cursor: 2 }, { type: 'remove', ids: ['a', 'b', 'c'] });
    expect(s.rows).toHaveLength(0);
    expect(s.cursor).toBe(0);
  });
});

describe('actionTargets', () => {
  it('returns the cursor row when nothing is selected', () => {
    expect(actionTargets({ ...loaded, cursor: 1 })).toEqual(['b']);
  });
  it('returns the selection when non-empty (ignoring cursor)', () => {
    expect(actionTargets({ ...loaded, cursor: 0, selected: new Set(['b', 'c']) }).sort()).toEqual(['b', 'c']);
  });
  it('returns empty on an empty queue', () => {
    expect(actionTargets(initialTriage)).toEqual([]);
  });
});
