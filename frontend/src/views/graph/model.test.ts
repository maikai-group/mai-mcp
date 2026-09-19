import { describe, it, expect } from 'vitest';
import {
  OBJECTIVES, DEFAULT_OBJECTIVE, objectiveToZoom, zoomToObjective,
  labelPolicy, hopDistances, topDegreeNodeId, isRecent, recentNodeIds,
  zValues, zModeAvailability, zModeUnavailableReason, Z_NEUTRAL, Z_MODES,
  graphKindCounts, graphNodeFacts, visibleElements,
  depthSpread, DEPTH_SPREAD_K, DEPTH_SPREAD_MIN, EXPLORATION_NODE_CEILING, objectiveDistance,
  type ZNode,
} from './model';

describe('objectives', () => {
  it('offers exactly 4×/10×/40×/100× inside cytoscape zoom bounds', () => {
    expect(OBJECTIVES.map((o) => o.power)).toEqual([4, 10, 40, 100]);
    expect(OBJECTIVES.map((o) => o.label)).toEqual(['4×', '10×', '40×', '100×']);
    for (const o of OBJECTIVES) {
      expect(o.zoom).toBeGreaterThan(0.1);
      expect(o.zoom).toBeLessThan(3);
    }
  });

  it('round-trips power → zoom → power', () => {
    for (const o of OBJECTIVES) expect(zoomToObjective(objectiveToZoom(o.power))).toBe(o.power);
  });

  it('snaps a raw wheel zoom to the nearest objective', () => {
    expect(zoomToObjective(0.2)).toBe(4);
    expect(zoomToObjective(0.6)).toBe(10);
    expect(zoomToObjective(1.4)).toBe(40);
    expect(zoomToObjective(2.9)).toBe(100);
  });

  it('is total for a non-finite zoom, saturating rather than defaulting', () => {
    expect(zoomToObjective(NaN)).toBe(DEFAULT_OBJECTIVE);
    expect(zoomToObjective(Infinity)).toBe(100);
    expect(zoomToObjective(-Infinity)).toBe(4);
  });
});

describe('labelPolicy', () => {
  const base = { isLanding: false, isHeart: false, isSelected: false } as const;
  it('always labels landing nodes, the heart and the selection', () => {
    expect(labelPolicy({ ...base, power: 4, isLanding: true })).toBe(true);
    expect(labelPolicy({ ...base, power: 4, isHeart: true })).toBe(true);
    expect(labelPolicy({ ...base, power: 4, isSelected: true })).toBe(true);
  });
  it('labels fine nodes only at high objectives', () => {
    expect(labelPolicy({ ...base, power: 4 })).toBe(false);
    expect(labelPolicy({ ...base, power: 10 })).toBe(false);
    expect(labelPolicy({ ...base, power: 40 })).toBe(true);
    expect(labelPolicy({ ...base, power: 100 })).toBe(true);
  });
});

describe('hopDistances', () => {
  const edges = [
    { source: 'a', target: 'b' },
    { source: 'b', target: 'c' },
    { source: 'c', target: 'a' }, // cycle
    { source: 'c', target: 'd' },
  ];
  it('counts undirected hops from the heart and terminates on a cycle', () => {
    const d = hopDistances(edges, 'a');
    expect(d.get('a')).toBe(0);
    expect(d.get('b')).toBe(1);
    expect(d.get('c')).toBe(1);
    expect(d.get('d')).toBe(2);
  });
  it('omits unreachable nodes rather than guessing a level', () => {
    expect(hopDistances(edges, 'a').has('zzz')).toBe(false);
    expect(hopDistances([], 'a').get('a')).toBe(0);
  });
});

describe('topDegreeNodeId', () => {
  it('picks the highest degree, breaking ties by lowest id', () => {
    const els = [
      { data: { id: 'n2', degree: 9 } },
      { data: { id: 'n1', degree: 9 } },
      { data: { id: 'n3', degree: 2 } },
      { data: { id: 'e1', source: 'n1', target: 'n2' } }, // edge, ignored
    ];
    expect(topDegreeNodeId(els)).toBe('n1');
  });
  it('is null for an empty graph', () => {
    expect(topDegreeNodeId([])).toBeNull();
  });
});

describe('visibility projection', () => {
  it('removes hidden-kind nodes and every incident edge, including merged nodes', () => {
    const elements = [
      { data: { id: 'a', label: 'a.ts', kind: 'file', file_path: 'src/a.ts', line: 4, degree: 9 } },
      { data: { id: 'b', kind: 'function' } },
      { data: { id: 'c', kind: 'function' } }, // representative later merge
      { data: { id: 'ab', source: 'a', target: 'b' } },
      { data: { id: 'ac', source: 'a', target: 'c' } },
    ];
    expect(visibleElements(elements, ['function']).map((e) => e.data?.id)).toEqual(['a']);
    expect(graphKindCounts(elements)).toEqual(new Map([['file', 1], ['function', 2]]));
    expect(graphNodeFacts(elements, 'a')).toEqual({
      id: 'a', name: 'a.ts', kind: 'file', qualified_name: null,
      file_path: 'src/a.ts', line: 4, degree: 9,
    });
    expect(graphNodeFacts(elements, 'missing')).toBeNull();
  });
});

describe('isRecent', () => {
  const now = Date.parse('2026-08-18T00:00:00Z');
  it('is true inside the 7-day window and false outside it', () => {
    expect(isRecent('2026-08-17T00:00:00Z', now)).toBe(true);
    expect(isRecent('2026-08-11T12:00:00Z', now)).toBe(true);   // 6.5 days
    // The boundary is inclusive (`<=`), so exactly 7 days still counts.
    expect(isRecent('2026-08-11T00:00:00Z', now)).toBe(true);   // 7.0 days
    expect(isRecent('2026-08-10T23:59:59Z', now)).toBe(false);  // 7.0 days + 1s
    expect(isRecent('2026-08-01T00:00:00Z', now)).toBe(false);
    expect(recentNodeIds([
      { data: { id: 'recent', lastTouched: '2026-08-17T00:00:00Z' } },
      { data: { id: 'old', lastTouched: '2026-08-01T00:00:00Z' } },
    ], now)).toEqual(new Set(['recent']));
  });
  it('is total for null, empty and unparseable input', () => {
    expect(isRecent(null, now)).toBe(false);
    expect(isRecent(undefined, now)).toBe(false);
    expect(isRecent('', now)).toBe(false);
    expect(isRecent('not-a-date', now)).toBe(false);
  });
});

describe('Z axis', () => {
  const now = Date.parse('2026-08-18T00:00:00Z');
  const nodes: ZNode[] = [
    { id: 'old', kind: 'function', lastTouched: '2026-06-11T00:00:00Z', confidence: 0.8 },
    { id: 'new', kind: 'table', lastTouched: '2026-08-18T00:00:00Z', confidence: null },
    { id: 'none', kind: 'endpoint', lastTouched: null, confidence: null },
  ];

  it('time normalises to [0,1] with the oldest at the bedrock', () => {
    const z = zValues('time', nodes, now);
    expect(z.get('old')).toBe(0);
    expect(z.get('new')).toBe(1);
    expect(z.get('none')).toBe(Z_NEUTRAL);
  });

  it('abstraction ranks db < code < surface, unknown kinds neutral', () => {
    const z = zValues('abstraction', nodes, now);
    expect(z.get('new')).toBe(0);        // table
    expect(z.get('old')).toBe(0.5);      // function
    expect(z.get('none')).toBe(1);       // endpoint
    expect(zValues('abstraction', [{ id: 'x', kind: 'martian', lastTouched: null, confidence: null }], now).get('x'))
      .toBe(Z_NEUTRAL);
  });

  it('confidence clamps to [0,1] and puts unlinked nodes on the neutral plane', () => {
    const z = zValues('confidence', nodes, now);
    expect(z.get('old')).toBeCloseTo(0.8);
    expect(z.get('new')).toBe(Z_NEUTRAL);
    const clamped = zValues('confidence', [{ id: 'x', kind: 'file', lastTouched: null, confidence: 4 }], now);
    expect(clamped.get('x')).toBe(1);
  });

  it('never emits NaN in any mode', () => {
    const junk: ZNode[] = [{ id: 'j', kind: 'file', lastTouched: 'garbage', confidence: Number.NaN }];
    for (const mode of Z_MODES) {
      for (const v of zValues(mode, junk, now).values()) expect(Number.isFinite(v)).toBe(true);
    }
  });

  it('free pins nothing: an empty map, always available, listed last', () => {
    expect(zValues('free', nodes, now).size).toBe(0);
    expect(zModeAvailability([]).free).toBe(true);
    expect(zModeAvailability(nodes).free).toBe(true);
    expect(Z_MODES[Z_MODES.length - 1]).toBe('free');
    expect(zModeUnavailableReason('free')).toContain('Always available');
  });

  it('greys a mode whose input is absent, never fabricating a plane', () => {
    expect(zModeAvailability(nodes)).toEqual({ time: true, abstraction: true, confidence: true, free: true });
    const bare: ZNode[] = [{ id: 'x', kind: 'file', lastTouched: null, confidence: null }];
    expect(zModeAvailability(bare)).toEqual({ time: false, abstraction: true, confidence: false, free: true });
    expect(zModeAvailability([])).toEqual({ time: false, abstraction: true, confidence: false, free: true });
  });

  it('gives every mode a real sentence for the tooltip', () => {
    for (const mode of Z_MODES) {
      expect(zModeUnavailableReason(mode).length).toBeGreaterThan(20);
      expect(zModeUnavailableReason(mode)).not.toMatch(/N\/A|TODO/);
    }
  });
});

describe('depthSpread (plan 48a R2/R3)', () => {
  it('is exactly 400 for every landing set, up to and including the crossover', () => {
    for (const n of [0, 1, 45, 71, 211, EXPLORATION_NODE_CEILING]) expect(depthSpread(n)).toBe(DEPTH_SPREAD_MIN);
  });

  it('the crossover sits above the largest live overview (211 nodes)', () => {
    expect(EXPLORATION_NODE_CEILING).toBeGreaterThan(211);
    expect(EXPLORATION_NODE_CEILING).toBe(316);
  });

  it('grows with the square root above the crossover, continuously', () => {
    expect(depthSpread(EXPLORATION_NODE_CEILING + 1)).toBeGreaterThanOrEqual(DEPTH_SPREAD_MIN);
    expect(depthSpread(EXPLORATION_NODE_CEILING + 1) - DEPTH_SPREAD_MIN).toBeLessThan(1);
    let prev = depthSpread(316);
    for (const n of [400, 1_000, 5_000, 15_083, 25_000]) {
      const v = depthSpread(n);
      expect(v).toBeGreaterThan(prev);
      prev = v;
    }
    expect(depthSpread(10_000) / depthSpread(2_500)).toBeCloseTo(2, 9);
  });

  it('pins the calibrated hero value: a third of the 8,280-unit width', () => {
    expect(DEPTH_SPREAD_K).toBe(22.5);
    expect(depthSpread(15_083)).toBeCloseTo(2763.5, 0);
    expect(Math.abs(depthSpread(15_083) - 8_280 / 3)).toBeLessThan(10);
  });

  it('is total — non-finite, negative and non-number counts are exploration', () => {
    for (const bad of [Number.NaN, -1, Number.POSITIVE_INFINITY, null, undefined, '15083']) {
      expect(depthSpread(bad)).toBe(DEPTH_SPREAD_MIN);
    }
  });
});

describe('objectiveDistance — exported here, consumed by plan 48b R3', () => {
  it('4× is the frame distance and the other powers follow the 2D ratios', () => {
    expect(objectiveDistance(4, 1_000)).toBe(1_000);
    expect(objectiveDistance(10, 1_000)).toBeCloseTo(1_000 * 0.35 / 0.75, 9);
    expect(objectiveDistance(40, 1_000)).toBeCloseTo(1_000 * 0.35 / 1.5, 9);
    expect(objectiveDistance(100, 1_000)).toBeCloseTo(1_000 * 0.35 / 2.6, 9);
    expect(objectiveDistance(100, 1_000)).toBeLessThan(objectiveDistance(40, 1_000));
    expect(objectiveToZoom(4)).toBe(0.35);
  });

  it('is total on the frame distance', () => {
    for (const bad of [0, -5, Number.NaN, Number.POSITIVE_INFINITY]) expect(objectiveDistance(10, bad)).toBe(0);
  });
});
