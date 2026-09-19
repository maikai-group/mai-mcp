import { describe, it, expect, vi, afterEach } from 'vitest';
import { relativeTime, shortId } from './format';

describe('relativeTime', () => {
  afterEach(() => vi.useRealTimers());
  it('bucketizes ages', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-07-23T12:00:00Z'));
    expect(relativeTime('2026-07-23T11:59:40Z')).toBe('just now');
    expect(relativeTime('2026-07-23T11:48:00Z')).toBe('12m');
    expect(relativeTime('2026-07-23T09:00:00Z')).toBe('3h');
    expect(relativeTime('2026-07-21T12:00:00Z')).toBe('2d');
    expect(relativeTime('2026-06-01T12:00:00Z')).toBe('2026-06-01');
  });
  it('handles invalid input', () => {
    expect(relativeTime('not-a-date')).toBe('');
  });
});

describe('shortId', () => {
  it('truncates to 8 chars', () => {
    expect(shortId('abcdef1234567890')).toBe('abcdef12');
    expect(shortId('short')).toBe('short');
  });
});
