/**
 * Pure allocation tests (plan 38 task 1): approved floors, demand-capped
 * proportional scaling, deterministic priority, actual-residual redistribution,
 * prefix accounting, and fail-closed guards. No database, no filesystem.
 */
import { describe, expect, it } from 'vitest';
import {
  PRIME_SOURCE_FLOORS,
  PRIME_SOURCE_KEYS,
  allocatePrimeBudget,
  demandCapPrimeMinimum,
  preparePrimeSource,
  renderPrimeAllocation,
  type PreparedPrimeSource,
  type PrimeAllocation,
  type PrimeSourceKey,
} from '../prime-budget.js';
import { budgetRows } from '../read-budget.js';

/** A prepared source whose renderer fills its budget exactly — no residual. */
function fillingSource(key: PrimeSourceKey, minimumChars: number, fullChars: number): PreparedPrimeSource {
  const minimum = 'm'.repeat(minimumChars);
  const full = 'f'.repeat(fullChars);
  return {
    key,
    minimum,
    full,
    render: (charBudget: number) => (charBudget >= full.length ? full : 'f'.repeat(charBudget)),
  };
}

/** A prepared source whose degraded render is a fixed length, leaving residual. */
function stickySource(
  key: PrimeSourceKey,
  minimumChars: number,
  fullChars: number,
  degradedChars: number,
): PreparedPrimeSource {
  const minimum = 'm'.repeat(minimumChars);
  const full = 'f'.repeat(fullChars);
  return {
    key,
    minimum,
    full,
    render: (charBudget: number) =>
      charBudget >= full.length ? full : 'd'.repeat(Math.min(degradedChars, charBudget)),
  };
}

function countingSource(source: PreparedPrimeSource): { source: PreparedPrimeSource; calls: number[] } {
  const calls: number[] = [];
  return {
    calls,
    source: {
      key: source.key,
      minimum: source.minimum,
      full: source.full,
      render: (charBudget: number) => {
        calls.push(charBudget);
        return source.render(charBudget);
      },
    },
  };
}

const allocationOf = (available: number, shares: [PrimeSourceKey, number][]): PrimeAllocation => ({
  available,
  shares: new Map<PrimeSourceKey, number>(shares),
});

const totalShares = (allocation: PrimeAllocation): number =>
  PRIME_SOURCE_KEYS.reduce((sum, key) => sum + (allocation.shares.get(key) ?? 0), 0);

const withFloors = (overrides: Partial<Record<PrimeSourceKey, number>>, body: () => void): void => {
  const original: Partial<Record<PrimeSourceKey, number>> = {};
  for (const key of Object.keys(overrides)) {
    if (!PRIME_SOURCE_KEYS.some((known) => known === key)) throw new Error(`unknown key ${key}`);
  }
  try {
    for (const key of PRIME_SOURCE_KEYS) {
      const override = overrides[key];
      if (override === undefined) continue;
      original[key] = PRIME_SOURCE_FLOORS[key];
      PRIME_SOURCE_FLOORS[key] = override;
    }
    body();
  } finally {
    for (const key of PRIME_SOURCE_KEYS) {
      const previous = original[key];
      if (previous !== undefined) PRIME_SOURCE_FLOORS[key] = previous;
    }
  }
};

describe('approved policy', () => {
  it('pins the source order and the 4,800-character floor total', () => {
    expect([...PRIME_SOURCE_KEYS]).toEqual([
      'search', 'topics', 'board', 'claims', 'graph', 'shared', 'timeline',
    ]);
    expect(PRIME_SOURCE_KEYS.reduce((sum, key) => sum + PRIME_SOURCE_FLOORS[key], 0)).toBe(4800);
    expect(PRIME_SOURCE_FLOORS).toEqual({
      search: 1900, topics: 500, board: 600, claims: 400, graph: 400, shared: 400, timeline: 600,
    });
  });
});

describe('allocatePrimeBudget', () => {
  it('gives empty sources zero and hands their floors to search first', () => {
    const search = fillingSource('search', 40, 9000);
    const empty = (key: PrimeSourceKey): PreparedPrimeSource =>
      ({ key, minimum: '', full: '', render: () => '' });
    const allocation = allocatePrimeBudget(5488, 2065, [
      search, empty('topics'), empty('board'), empty('claims'), empty('graph'),
      empty('shared'), empty('timeline'),
    ]);
    expect(allocation.available).toBe(3423);
    expect(allocation.shares.get('topics')).toBe(0);
    expect(allocation.shares.get('board')).toBe(0);
    expect(allocation.shares.get('claims')).toBe(0);
    expect(allocation.shares.get('search')).toBe(3423);
  });

  it('returns the residual of a source that demands less than its floor', () => {
    const search = fillingSource('search', 10, 100);
    const timeline = fillingSource('timeline', 10, 9000);
    const allocation = allocatePrimeBudget(2000, 0, [search, timeline]);
    expect(allocation.shares.get('search')).toBe(100);
    expect(allocation.shares.get('timeline')).toBe(1900);
    expect(totalShares(allocation)).toBe(2000);
  });

  it('gives every oversized source exactly its floor when 4,800 characters are available', () => {
    const sources = PRIME_SOURCE_KEYS.map((key) => fillingSource(key, 10, 9000));
    const allocation = allocatePrimeBudget(4800, 0, sources);
    for (const key of PRIME_SOURCE_KEYS) {
      expect(allocation.shares.get(key)).toBe(PRIME_SOURCE_FLOORS[key]);
    }
    expect(totalShares(allocation)).toBe(4800);
  });

  it('conserves every character at the exact 5,488/2,065 hard-envelope boundary', () => {
    const sources = PRIME_SOURCE_KEYS.map((key) => fillingSource(key, 10, 9000));
    const first = allocatePrimeBudget(5488, 2065, sources);
    const second = allocatePrimeBudget(5488, 2065, sources);
    expect(first.available).toBe(3423);
    expect(totalShares(first)).toBe(3423);
    for (const key of PRIME_SOURCE_KEYS) {
      expect(first.shares.get(key)).toBeGreaterThanOrEqual(10);
      expect(first.shares.get(key)).toBe(second.shares.get(key));
    }
  });

  it('scales demand-capped targets, not post-clamp floors, under scarcity', () => {
    withFloors({ search: 100, topics: 100, board: 100 }, () => {
      const allocation = allocatePrimeBudget(100, 0, [
        fillingSource('search', 10, 20),
        fillingSource('topics', 10, 100),
        fillingSource('board', 10, 100),
      ]);
      expect(allocation.shares.get('search')).toBe(14);
      expect(allocation.shares.get('topics')).toBe(43);
      expect(allocation.shares.get('board')).toBe(43);
      expect(totalShares(allocation)).toBe(100);
    });
  });

  it('offers initial capacity in search → topics → board → claims → graph → shared → timeline order', () => {
    withFloors({ search: 20, topics: 20, board: 20, claims: 20, graph: 20, shared: 20, timeline: 20 }, () => {
      const sources = PRIME_SOURCE_KEYS.map((key) => fillingSource(key, 10, 9000));
      // 140 satisfies every floor; the 25 surplus walks the priority order.
      const allocation = allocatePrimeBudget(165, 0, sources);
      expect(allocation.shares.get('search')).toBe(45);
      expect(allocation.shares.get('topics')).toBe(20);
      expect(totalShares(allocation)).toBe(165);
    });
  });

  it('fails closed on duplicate keys and on non-integer or negative budgets', () => {
    const source = fillingSource('search', 10, 100);
    expect(() => allocatePrimeBudget(100, 0, [source, source])).toThrow(/appears more than once/);
    expect(() => allocatePrimeBudget(-1, 0, [source])).toThrow(/non-negative integer/);
    expect(() => allocatePrimeBudget(100.5, 0, [source])).toThrow(/non-negative integer/);
    expect(() => allocatePrimeBudget(100, 0.5, [source])).toThrow(/non-negative integer/);
  });

  it('fails closed when structural minima exceed the available characters', () => {
    expect(() =>
      allocatePrimeBudget(100, 0, [fillingSource('search', 80, 900), fillingSource('topics', 80, 900)]),
    ).toThrow('prime structural minimum exceeds available budget');
  });
});

describe('renderPrimeAllocation', () => {
  it('baselines final shares on actual lengths and grants the pool once', () => {
    const search = stickySource('search', 10, 200, 40);
    const topics = stickySource('topics', 10, 200, 40);
    const rendered = renderPrimeAllocation(
      allocationOf(100, [['search', 50], ['topics', 50]]),
      [search, topics],
    );
    expect(rendered.firstFragments.get('search')?.length).toBe(40);
    expect(rendered.firstFragments.get('topics')?.length).toBe(40);
    expect(rendered.finalShares.get('search')).toBe(60);
    expect(rendered.finalShares.get('topics')).toBe(40);
    const shareTotal = PRIME_SOURCE_KEYS.reduce((sum, key) => sum + (rendered.finalShares.get(key) ?? 0), 0);
    expect(shareTotal).toBe(100);
    expect(shareTotal).not.toBe(120);
  });

  it('skips a degraded source whose grant cannot exceed its activation gap', () => {
    const search = stickySource('search', 10, 200, 40);
    const topics = fillingSource('topics', 10, 200);
    const rendered = renderPrimeAllocation(
      allocationOf(100, [['search', 50], ['topics', 50]]),
      [search, topics],
    );
    expect(rendered.firstFragments.get('search')?.length).toBe(40);
    expect(rendered.firstFragments.get('topics')?.length).toBe(50);
    expect(rendered.finalShares.get('search')).toBe(40); // gap 10, pool 10 → consumes nothing
    expect(rendered.finalShares.get('topics')).toBe(60);
    expect(rendered.fragments.get('topics')?.length).toBe(60);
    expect(rendered.usedChars).toBe(100);
    expect(rendered.usedChars).toBeLessThanOrEqual(100);
  });

  it('lets first-pass residual materially lengthen priority recall, rendering at most twice', () => {
    const search = countingSource(fillingSource('search', 10, 9000));
    const timeline = countingSource(stickySource('timeline', 10, 9000, 100));
    const allocation = allocationOf(2000, [['search', 1000], ['timeline', 1000]]);
    const rendered = renderPrimeAllocation(allocation, [search.source, timeline.source]);
    expect(rendered.firstFragments.get('search')?.length).toBe(1000);
    expect(rendered.firstFragments.get('timeline')?.length).toBe(100);
    // 900 released by timeline lands on search: 1000 → 1900.
    expect(rendered.fragments.get('search')?.length).toBe(1900);
    expect(rendered.finalShares.get('search')).toBe(1900);
    expect(rendered.usedChars).toBe(2000);
    expect(search.calls).toEqual([1000, 1900]);
    expect(timeline.calls).toEqual([1000]);
  });

  it('reports empty sources as zero-share, zero-fragment receipts', () => {
    const rendered = renderPrimeAllocation(
      allocationOf(3423, [['search', 3423]]),
      [fillingSource('search', 10, 9000), { key: 'topics', minimum: '', full: '', render: () => '' }],
    );
    expect(rendered.initialShares.get('topics')).toBe(0);
    expect(rendered.finalShares.get('topics')).toBe(0);
    expect(rendered.firstFragments.get('topics')).toBe('');
    expect(rendered.fragments.get('topics')).toBe('');
    expect(rendered.usedChars).toBe(3423);
  });

  it('fails closed when a renderer overflows its share', () => {
    const liar: PreparedPrimeSource = {
      key: 'search',
      minimum: 'm'.repeat(10),
      full: 'f'.repeat(200),
      render: () => 'f'.repeat(120),
    };
    expect(() => renderPrimeAllocation(allocationOf(100, [['search', 50]]), [liar])).toThrow(
      /beyond share 50/,
    );
  });
});

describe('preparePrimeSource', () => {
  const prefix = '\n\n---\n\n';

  it('counts the prefix in minimum, demand, and every rendered fragment', () => {
    const body = 'b'.repeat(300);
    const recovery = '_mai_search for prior decisions and lessons._';
    const source = preparePrimeSource('search', prefix, {
      minimum: recovery,
      full: body,
      render: (charBudget?: number) =>
        charBudget === undefined || charBudget >= body.length ? body : recovery,
    });
    expect(source.minimum).toBe(prefix + recovery);
    expect(source.full).toBe(prefix + body);
    expect(source.full.length).toBe(prefix.length + 300);
    expect(source.render(source.minimum.length)).toBe(prefix + recovery);
    expect(source.render(source.full.length)).toBe(source.full);
    expect(() => source.render(source.minimum.length - 1)).toThrow(/below structural minimum/);
    // The prefix is charged to the final share, not smuggled past the budget.
    const rendered = renderPrimeAllocation(
      allocationOf(600, [['search', 600]]),
      [source],
    );
    expect(rendered.finalShares.get('search')).toBe(prefix.length + body.length);
    expect(rendered.fragments.get('search')).toBe(prefix + body);
  });

  it('returns the byte-identical full string at exact demand, ignoring the three-row threshold', () => {
    const rows = ['a', 'b', 'c', 'd'];
    const renderFull = (items: readonly string[]): string => items.join('\n');
    const body = renderFull(rows);
    const recovery = '_mai_graph_find for structure matches._';
    const minimum = demandCapPrimeMinimum(body, recovery);
    const prepared = {
      minimum,
      full: body,
      render: (charBudget?: number) =>
        budgetRows(
          charBudget === undefined ? undefined : { fullRows: 3, charBudget },
          rows, renderFull, (row: string) => row, '', 'row',
          'narrow query/kind/limit, call mai_graph_find, or run mai graph find in the CLI',
        ),
    };
    // The four one-character rows exceed the inherited three-row threshold, so
    // the generic helper cannot even serve exact demand …
    expect(() => prepared.render(body.length)).toThrow(/pointer exceeds cap/);
    const source = preparePrimeSource('graph', '', prepared);
    // … but prime returns the stored bytes because the budget covers demand.
    expect(source.render(source.full.length)).toBe(body);
  });

  it('treats a source shorter than its recovery shell as complete, never degraded', () => {
    const body = 'x'.repeat(22);
    const recovery = `_mai_timeline for recent activity${'.'.repeat(16)}_`;
    expect(body.length).toBe(22);
    expect(recovery.length).toBe(50);
    const minimum = demandCapPrimeMinimum(body, recovery);
    expect(minimum).toBe(body);
    const source = preparePrimeSource('timeline', '', {
      minimum,
      full: body,
      render: (charBudget?: number) =>
        charBudget === undefined || charBudget >= body.length ? body : minimum,
    });
    expect(source.minimum).toBe(source.full);
    expect(source.render(source.minimum.length)).toBe(body);
    const rendered = renderPrimeAllocation(allocationOf(100, [['timeline', 60]]), [source]);
    expect(rendered.fragments.get('timeline')).toBe(body);
    expect(rendered.finalShares.get('timeline')).toBe(body.length);
  });

  it('keeps an empty prepared value empty and rejects mismatched empties', () => {
    const empty = preparePrimeSource('shared', prefix, { minimum: '', full: '', render: () => '' });
    expect(empty.minimum).toBe('');
    expect(empty.full).toBe('');
    expect(empty.render(0)).toBe('');
    expect(() =>
      preparePrimeSource('shared', prefix, { minimum: 'x', full: '', render: () => '' }),
    ).toThrow(/empty demand but a non-empty minimum/);
    expect(() =>
      preparePrimeSource('shared', prefix, { minimum: '', full: 'x', render: () => 'x' }),
    ).toThrow(/non-empty demand but an empty minimum/);
  });
});

describe('demandCapPrimeMinimum', () => {
  it('caps a short full string to itself and keeps a long one on its recovery shell', () => {
    expect(demandCapPrimeMinimum('short', 'a much longer recovery sentence')).toBe('short');
    expect(demandCapPrimeMinimum('a'.repeat(500), 'recovery')).toBe('recovery');
    expect(demandCapPrimeMinimum('', '')).toBe('');
    expect(() => demandCapPrimeMinimum('', 'recovery')).toThrow(/empty exactly when/);
    expect(() => demandCapPrimeMinimum('full', '')).toThrow(/empty exactly when/);
  });
});
