import { describe, it, expect } from 'vitest';
import { hasWebGL, WEBGL_UNAVAILABLE_MESSAGE } from './webgl';

describe('hasWebGL', () => {
  it('is true when any 3D context resolves', () => {
    expect(hasWebGL((k) => (k === 'webgl' ? {} : null))).toBe(true);
    expect(hasWebGL((k) => (k === 'webgl2' ? {} : null))).toBe(true);
  });

  it('is false when every context is null — the fallback case', () => {
    expect(hasWebGL(() => null)).toBe(false);
  });

  it('is false, not throwing, when the getter throws', () => {
    expect(hasWebGL(() => { throw new Error('blocked'); })).toBe(false);
  });

  it('has a plain message with no jargon and no blame', () => {
    expect(WEBGL_UNAVAILABLE_MESSAGE).toContain('2D view is unaffected');
  });
});
