/**
 * Regression guard for the session-log slug timezone bug (first live consumer ride,
 * 2026-06-11): the slug must follow LOCAL wall-clock time, not UTC, or a session
 * running past ~8pm in a western tz splits across two log files mid-session.
 * The component-formula assertion fails the instant anyone reverts to
 * toISOString() in any tz where local ≠ UTC (e.g. Toronto evenings).
 */
import { describe, expect, it } from 'vitest';
import { todayStamp, timeStamp } from '../notes.js';

describe('tracking-log stamps use local time', () => {
  it('todayStamp is YYYY-MM-DD and matches local date components', () => {
    expect(todayStamp()).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    const d = new Date();
    const expected = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(
      d.getDate()
    ).padStart(2, '0')}`;
    expect(todayStamp()).toBe(expected);
  });

  it('timeStamp is HH:MM:SS and matches local time components', () => {
    expect(timeStamp()).toMatch(/^\d{2}:\d{2}:\d{2}$/);
    // Compare on hour+minute to avoid a second-rollover flake between calls.
    expect(timeStamp().slice(0, 5)).toBe(
      `${String(new Date().getHours()).padStart(2, '0')}:${String(new Date().getMinutes()).padStart(2, '0')}`
    );
  });
});
