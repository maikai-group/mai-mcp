import { describe, it, expect } from 'vitest';
import { overviewToElements, neighborsToElements, fullToElements, mergeElements, edgeId, normalizeStrength } from './elements';
import { zModeAvailability, type ZNode } from './model';
import type { GraphOverview, GraphNeighborsJson, GraphFull } from '../../lib/types';

const overview: GraphOverview = {
  modules: [{ label: 'repo/src', nodeCount: 2, kinds: { function: 2 } }],
  links: [{ a: 'repo/src', b: 'db schema', weight: 1 }],
  topNodes: [
    { id: 'n1', kind: 'function', name: 'foo', module: 'repo/src', degree: 5, qualified_name: 'q/foo', file_path: '/r/foo.ts', line: 5, lastTouched: null, confidence: null },
    { id: 'n2', kind: 'function', name: 'bar', module: 'repo/src', degree: 3, qualified_name: 'q/bar', file_path: '/r/bar.ts', line: 10, lastTouched: null, confidence: null },
  ],
  topEdges: [{ source: 'n1', target: 'n2', relation: 'calls' }],
};

const neighbors: GraphNeighborsJson = {
  center: 'n2',
  capped: false,
  nodes: [
    { id: 'n2', kind: 'function', name: 'bar', qualified_name: 'q/bar', file_path: '/r/bar.ts', line: 10, degree: 3, lastTouched: null, confidence: null },
    { id: 'n3', kind: 'table', name: 'widgets', qualified_name: 'public.widgets', file_path: null, line: null, degree: 1, lastTouched: null, confidence: null },
  ],
  edges: [{ source: 'n2', target: 'n3', relation: 'reads_table' }],
};

describe('overviewToElements', () => {
  it('maps topNodes → nodes with module + topEdges → edges', () => {
    const els = overviewToElements(overview);
    const nodes = els.filter((e) => e.data?.source == null);
    const edges = els.filter((e) => e.data?.source != null);
    expect(nodes).toHaveLength(2);
    expect(edges).toHaveLength(1);
    expect(nodes[0].data?.module).toBe('repo/src');
    expect(edges[0].data?.id).toBe(edgeId('n1', 'n2', 'calls'));
  });
});

describe('neighborsToElements', () => {
  it('flags the center node and carries file_path/line', () => {
    const els = neighborsToElements(neighbors);
    const center = els.find((e) => e.data?.id === 'n2');
    const table = els.find((e) => e.data?.id === 'n3');
    expect(center?.data?.center).toBe(1);
    expect(table?.data?.file_path).toBeNull();
    expect(center?.data?.file_path).toBe('/r/bar.ts');
  });
});

describe('mergeElements', () => {
  it('dedupes by id, existing wins', () => {
    const a = overviewToElements(overview);
    const b = neighborsToElements(neighbors);
    const merged = mergeElements(a, b);
    const ids = merged.filter((e) => e.data?.source == null).map((e) => e.data?.id);
    expect(new Set(ids).size).toBe(ids.length); // no dupes
    expect(ids).toContain('n1');
    expect(ids).toContain('n3'); // new node from expansion
    // n2 kept from existing (overview version, which has module set)
    const n2 = merged.find((e) => e.data?.id === 'n2');
    expect(n2?.data?.module).toBe('repo/src');
  });

  it('adds the new expansion edge', () => {
    const merged = mergeElements(overviewToElements(overview), neighborsToElements(neighbors));
    expect(merged.some((e) => e.data?.id === edgeId('n2', 'n3', 'reads_table'))).toBe(true);
  });

  it('drops edges whose endpoints are absent', () => {
    const orphanEdge = [{ group: 'edges' as const, data: { id: 'x__r__y', source: 'x', target: 'y', relation: 'r' } }];
    const merged = mergeElements(overviewToElements(overview), orphanEdge);
    expect(merged.some((e) => e.data?.id === 'x__r__y')).toBe(false);
  });

  it('preserves all existing nodes', () => {
    const merged = mergeElements(overviewToElements(overview), []);
    expect(merged.filter((e) => e.data?.source == null)).toHaveLength(2);
  });
});

describe('additive showcase fields', () => {
  it('carries strength, lastTouched, confidence and isLanding off the overview', () => {
    const els = overviewToElements({
      modules: [], links: [],
      topNodes: [{ id: 'n1', kind: 'function', name: 'f', module: 'm', degree: 4, qualified_name: 'm/f', file_path: '/r/f.ts', line: 4, lastTouched: '2026-08-18T00:00:00.000Z', confidence: 0.9 }],
      topEdges: [{ source: 'n1', target: 'n2', relation: 'calls', strength: 3 }],
    });
    const node = els.find((e) => e.data?.id === 'n1');
    expect(node?.data?.lastTouched).toBe('2026-08-18T00:00:00.000Z');
    expect(node?.data?.confidence).toBe(0.9);
    expect(node?.data?.isLanding).toBe(1);
    expect(node?.data?.degree).toBe(4);
    expect(node?.data?.file_path).toBe('/r/f.ts');
    expect(els.find((e) => e.data?.source === 'n1')?.data?.strength).toBe(3);
  });

  it('marks neighborhood nodes as non-landing and carries their fields', () => {
    const els = neighborsToElements({
      center: 'c', capped: false,
      nodes: [{ id: 'c', kind: 'file', name: 'c.ts', qualified_name: null, file_path: null, line: null, degree: 12, lastTouched: null, confidence: null }],
      edges: [{ source: 'c', target: 'c', relation: 'imports', strength: 1 }],
    });
    const node = els.find((e) => e.data?.id === 'c');
    expect(node?.data?.isLanding).toBe(0);
    expect(node?.data?.lastTouched).toBeNull();
    expect(node?.data?.confidence).toBeNull();
    expect(node?.data?.degree).toBe(12);
  });

  it('normalizes an old-server edge without strength once for both renderers', () => {
    const els = neighborsToElements({
      center: 'a', capped: false,
      nodes: [
        { id: 'a', kind: 'file', name: 'a', qualified_name: null, file_path: null, line: null, degree: 1, lastTouched: null, confidence: null },
        { id: 'b', kind: 'file', name: 'b', qualified_name: null, file_path: null, line: null, degree: 1, lastTouched: null, confidence: null },
      ],
      edges: [{ source: 'a', target: 'b', relation: 'imports' }],
    });
    expect(els.find((e) => e.data?.source === 'a')?.data?.strength).toBe(1);
  });
});

describe('fullToElements (plan 47 hero payload)', () => {
  const full: GraphFull = {
    nodes: [
      { id: 'h1', kind: 'function', name: 'hub', degree: 40, qualified_name: 'q/hub', file_path: '/r/hub.ts', line: 1, lastTouched: '2026-08-30T00:00:00.000Z', confidence: 0.8, isLanding: 1 },
      { id: 'l1', kind: 'function', name: 'leaf', degree: 1, qualified_name: 'q/leaf', file_path: '/r/leaf.ts', line: 9, lastTouched: null, confidence: null, isLanding: 0 },
      { id: 't1', kind: 'table', name: 'widgets', degree: 2, qualified_name: 'public.widgets', file_path: null, line: null, lastTouched: null, confidence: null, isLanding: 0 },
    ],
    edges: [
      { source: 'h1', target: 'l1', relation: 'calls', strength: 3 },
      { source: 'h1', target: 't1', relation: 'reads_table' },
    ],
    truncated: { nodes: false, edges: false, nodeTotal: 3, edgeTotal: 2 },
  };
  const nodesOf = (els: ReturnType<typeof fullToElements>) => els.filter((e) => e.data?.source == null);
  const edgesOf = (els: ReturnType<typeof fullToElements>) => els.filter((e) => e.data?.source != null);

  it('round-trips node and edge counts exactly', () => {
    const els = fullToElements(full);
    expect(nodesOf(els)).toHaveLength(3);
    expect(edgesOf(els)).toHaveLength(2);
    expect(nodesOf(els).every((e) => e.group === 'nodes')).toBe(true);
    expect(edgesOf(els).every((e) => e.group === 'edges')).toBe(true);
  });

  it('carries isLanding through unchanged (1 stays 1, 0 stays 0) — R4', () => {
    const els = fullToElements(full);
    expect(els.find((e) => e.data?.id === 'h1')?.data?.isLanding).toBe(1);
    expect(els.find((e) => e.data?.id === 'l1')?.data?.isLanding).toBe(0);
    expect(els.find((e) => e.data?.id === 't1')?.data?.isLanding).toBe(0);
  });

  it('keeps lastTouched and confidence, including explicit null', () => {
    const els = fullToElements(full);
    const hub = els.find((e) => e.data?.id === 'h1')?.data;
    const leaf = els.find((e) => e.data?.id === 'l1')?.data;
    expect(hub?.lastTouched).toBe('2026-08-30T00:00:00.000Z');
    expect(hub?.confidence).toBe(0.8);
    expect(leaf?.lastTouched).toBeNull();
    expect(leaf?.confidence).toBeNull();
    expect(leaf !== undefined && 'lastTouched' in leaf).toBe(true);
    expect(leaf !== undefined && 'confidence' in leaf).toBe(true);
  });

  it('uses the shared edgeId so mergeElements dedupes hero and neighbour edges identically', () => {
    const els = fullToElements(full);
    expect(edgesOf(els).map((e) => e.data?.id)).toEqual([
      edgeId('h1', 'l1', 'calls'), edgeId('h1', 't1', 'reads_table'),
    ]);
    const merged = mergeElements(els, neighborsToElements({
      center: 'h1', capped: false,
      nodes: [
        { id: 'h1', kind: 'function', name: 'hub', qualified_name: 'q/hub', file_path: '/r/hub.ts', line: 1, degree: 40, lastTouched: null, confidence: null },
        { id: 'l1', kind: 'function', name: 'leaf', qualified_name: 'q/leaf', file_path: '/r/leaf.ts', line: 9, degree: 1, lastTouched: null, confidence: null },
      ],
      edges: [{ source: 'h1', target: 'l1', relation: 'calls' }],
    }));
    expect(edgesOf(merged).filter((e) => e.data?.id === edgeId('h1', 'l1', 'calls'))).toHaveLength(1);
  });

  it('normalises a missing strength to 1 through the shared normalizeStrength', () => {
    const els = fullToElements(full);
    const withStrength = els.find((e) => e.data?.id === edgeId('h1', 'l1', 'calls'))?.data;
    const without = els.find((e) => e.data?.id === edgeId('h1', 't1', 'reads_table'))?.data;
    expect(withStrength?.strength).toBe(3);
    expect(without?.strength).toBe(normalizeStrength(undefined));
    expect(without?.strength).toBe(1);
  });

  it('satisfies zModeAvailability for all four modes when the payload carries both fields — R3', () => {
    const zNodes: ZNode[] = nodesOf(fullToElements(full)).map((e) => ({
      id: String(e.data?.id),
      kind: String(e.data?.kind),
      lastTouched: typeof e.data?.lastTouched === 'string' ? e.data.lastTouched : null,
      confidence: typeof e.data?.confidence === 'number' ? e.data.confidence : null,
    }));
    expect(zModeAvailability(zNodes)).toEqual({ time: true, abstraction: true, confidence: true, free: true });
    const bare: ZNode[] = nodesOf(fullToElements({ ...full, nodes: full.nodes.map((n) => ({ ...n, lastTouched: null, confidence: null })) }))
      .map((e) => ({ id: String(e.data?.id), kind: String(e.data?.kind), lastTouched: null, confidence: null }));
    expect(zModeAvailability(bare)).toEqual({ time: false, abstraction: true, confidence: false, free: true });
  });
});
