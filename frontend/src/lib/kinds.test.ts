import { describe, it, expect } from 'vitest';
import { kindStyle, FALLBACK_KIND } from './kinds';
import { relationStyle, FALLBACK_RELATION } from './relations';

describe('kindStyle', () => {
  it('maps a known kind', () => {
    expect(kindStyle('function').color).toBe('#2dd4bf');
    expect(kindStyle('table').shape).toBe('rectangle');
  });
  it('falls back for an unknown kind', () => {
    expect(kindStyle('totally-unknown-kind')).toEqual(FALLBACK_KIND);
  });
});

describe('relationStyle', () => {
  it('maps a known relation', () => {
    expect(relationStyle('calls').lineStyle).toBe('solid');
    expect(relationStyle('imports').lineStyle).toBe('dashed');
    expect(relationStyle('fk_to').lineStyle).toBe('dotted');
  });
  it('falls back for an unknown relation', () => {
    expect(relationStyle('made-up')).toEqual(FALLBACK_RELATION);
  });
});
