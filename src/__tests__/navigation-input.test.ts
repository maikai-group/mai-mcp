import { describe, expect, it } from 'vitest';
import { normalizeInput } from '../navigation/input.js';
const base = { question: 'Where is approval checked?', intent: 'layout' };
describe('navigation input', () => {
  it('preserves supplied excerpt bytes and normalizes UUIDs', () => {
    const result = normalizeInput({ ...base,
      seed_nodes: ['AAAAAAAA-AAAA-AAAA-AAAA-AAAAAAAAAAAA'],
      context: [{ label: 'Task 7', text: '  exact\n' }] });
    expect(result.seed_nodes).toEqual(['aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa']);
    expect(result.context[0]?.text).toBe('  exact\n');
  });
  it.each([null, [], 3, { ...base, project_id: 'foreign' },
    { ...base, question: 'x'.repeat(1001) }, { ...base, terms: ['same', 'same'] },
    { ...base, seed_nodes: ['bad'] }, { ...base, mechanism: 'extra' },
    { ...base, intent: 'family' }, { ...base, context: [{ label: 'x', text: '' }] },
    { ...base, context: Array.from({ length: 13 }, (_, n) => ({ label: `${n}`, text: 'x' })) },
  ])('rejects invalid payload %#', raw => expect(() => normalizeInput(raw)).toThrow());
  it('rejects getters without evaluating them', () => {
    let invoked = false;
    const raw = Object.defineProperty({ ...base }, 'terms', { get() { invoked = true; return []; } });
    expect(() => normalizeInput(raw)).toThrow();
    expect(invoked).toBe(false);
  });

});
