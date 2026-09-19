/** Hourly graph-update throttle for turn-based triggers (Codex notify chain).
 * Codex has no session end, so the graph went stale until a manual run; the
 * throttle lets every turn OFFER an update while at most one per interval runs. */
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  claimGraphUpdate,
  throttleStatePath,
  GRAPH_UPDATE_INTERVAL_MS,
} from '../scripts/graph-update-throttle.js';

describe('graph-update-throttle', () => {
  it('defaults to an hourly cadence', () => {
    expect(GRAPH_UPDATE_INTERVAL_MS).toBe(3_600_000);
  });

  it('first claim wins and marks the state file; a fresh file blocks the next claim', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mai-graph-throttle-'));
    expect(claimGraphUpdate('demo-app', GRAPH_UPDATE_INTERVAL_MS, dir)).toBe(true);
    expect(fs.existsSync(throttleStatePath('demo-app', dir))).toBe(true);
    expect(claimGraphUpdate('demo-app', GRAPH_UPDATE_INTERVAL_MS, dir)).toBe(false);
  });

  it('claims again once the state file is older than the interval', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mai-graph-throttle-'));
    expect(claimGraphUpdate('demo-app', GRAPH_UPDATE_INTERVAL_MS, dir)).toBe(true);
    // Backdate the marker past the interval — as if an hour elapsed.
    const stale = new Date(Date.now() - GRAPH_UPDATE_INTERVAL_MS - 1000);
    fs.utimesSync(throttleStatePath('demo-app', dir), stale, stale);
    expect(claimGraphUpdate('demo-app', GRAPH_UPDATE_INTERVAL_MS, dir)).toBe(true);
    // ...and the claim re-marks it, so the very next turn is throttled again.
    expect(claimGraphUpdate('demo-app', GRAPH_UPDATE_INTERVAL_MS, dir)).toBe(false);
  });

  it('throttles per project — one slug claiming does not block another', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mai-graph-throttle-'));
    expect(claimGraphUpdate('demo-app', GRAPH_UPDATE_INTERVAL_MS, dir)).toBe(true);
    expect(claimGraphUpdate('demo-two', GRAPH_UPDATE_INTERVAL_MS, dir)).toBe(true);
  });

  it('sanitizes the slug in the state path (no traversal)', () => {
    const p = throttleStatePath('../../etc/passwd', '/tmp/base');
    expect(p.startsWith('/tmp/base/')).toBe(true);
    expect(p).not.toContain('..');
  });
});
