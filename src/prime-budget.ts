/**
 * The pure allocation leaf for task-scoped `mai_prime` (plan 38), beside
 * `read-budget.ts`: the closed source-key set, the approved floors and priority
 * order, the exact adaptive allocator, and the prefix-aware prepared-source
 * primitive.
 *
 * Nothing here queries, reads the filesystem, mints a token, or calls a
 * producer. A prepared source arrives with its work already done and its
 * presentation overhead already inside `full`, so allocation is pure character
 * arithmetic over immutable strings and length accounting stays additive.
 */
export const PRIME_SOURCE_KEYS = [
  'search', 'topics', 'board', 'claims', 'graph', 'shared', 'timeline',
] as const;
export type PrimeSourceKey = (typeof PRIME_SOURCE_KEYS)[number];

export const PRIME_SOURCE_FLOORS: Record<PrimeSourceKey, number> = {
  search: 1900,
  topics: 500,
  board: 600,
  claims: 400,
  graph: 400,
  shared: 400,
  timeline: 600,
};

export interface PreparedPrimeText {
  minimum: string;
  full: string;
  /** Undefined is the byte-compatible full lane; a number is a character-only cap. */
  render(charBudget?: number): string;
}

export interface PreparedPrimeSource {
  key: PrimeSourceKey;
  minimum: string;
  full: string;
  render(charBudget: number): string;
}

export interface PrimeAllocation {
  available: number;
  shares: ReadonlyMap<PrimeSourceKey, number>;
}

export interface PrimeRenderedAllocation {
  available: number;
  initialShares: ReadonlyMap<PrimeSourceKey, number>;
  finalShares: ReadonlyMap<PrimeSourceKey, number>;
  firstFragments: ReadonlyMap<PrimeSourceKey, string>;
  fragments: ReadonlyMap<PrimeSourceKey, string>;
  usedChars: number;
}

const keyOrder = (key: PrimeSourceKey): number => PRIME_SOURCE_KEYS.indexOf(key);

function assertBudgetNumber(label: string, value: number): void {
  if (!Number.isInteger(value) || value < 0) {
    throw new Error(`prime ${label} must be a non-negative integer, received ${String(value)}`);
  }
}

/**
 * The effective minimum. A source whose complete render is no longer than its
 * preferred recovery sentence keeps the complete string as its minimum, so it
 * is never classified degraded and never spends characters saying less.
 */
export function demandCapPrimeMinimum(full: string, recoveryMinimum: string): string {
  if ((full === '') !== (recoveryMinimum === '')) {
    throw new Error('prime prepared text is empty exactly when its recovery minimum is empty');
  }
  if (full === '') return '';
  return full.length <= recoveryMinimum.length ? full : recoveryMinimum;
}

function assertPreparedInvariants(source: PreparedPrimeSource): void {
  if ((source.full === '') !== (source.minimum === '')) {
    throw new Error(`prime source ${source.key} is empty exactly when its minimum is empty`);
  }
  if (source.minimum.length > source.full.length) {
    throw new Error(
      `prime source ${source.key} minimum ${source.minimum.length} exceeds demand ${source.full.length}`,
    );
  }
}

function orderedActiveSources(sources: readonly PreparedPrimeSource[]): PreparedPrimeSource[] {
  const seen = new Set<PrimeSourceKey>();
  for (const source of sources) {
    if (seen.has(source.key)) throw new Error(`prime source ${source.key} appears more than once`);
    seen.add(source.key);
    assertPreparedInvariants(source);
  }
  return sources
    .filter((source) => source.full.length > 0)
    .slice()
    .sort((a, b) => keyOrder(a.key) - keyOrder(b.key));
}

/**
 * Exact adaptive assignment: structural minima first, then demand-capped
 * discretionary floors scaled by largest remainders, then leftover capacity in
 * approved priority order. Integer shares conserve every available character.
 */
export function allocatePrimeBudget(
  totalBudget: number,
  envelopeChars: number,
  sources: readonly PreparedPrimeSource[],
): PrimeAllocation {
  assertBudgetNumber('total budget', totalBudget);
  assertBudgetNumber('envelope chars', envelopeChars);
  const active = orderedActiveSources(sources);
  const available = Math.max(0, totalBudget - envelopeChars);
  const shares = new Map<PrimeSourceKey, number>(PRIME_SOURCE_KEYS.map((key) => [key, 0]));

  const minimumChars = active.reduce((sum, source) => sum + source.minimum.length, 0);
  if (minimumChars > available) throw new Error('prime structural minimum exceeds available budget');

  const targets = new Map<PrimeSourceKey, number>();
  for (const source of active) {
    const capped = Math.min(PRIME_SOURCE_FLOORS[source.key], source.full.length);
    targets.set(source.key, Math.max(0, capped - source.minimum.length));
  }
  const remaining = available - minimumChars;
  const discretionarySum = active.reduce((sum, source) => sum + (targets.get(source.key) ?? 0), 0);

  const scaled = new Map<PrimeSourceKey, number>();
  if (discretionarySum <= remaining) {
    for (const source of active) scaled.set(source.key, targets.get(source.key) ?? 0);
  } else {
    const remainders: { key: PrimeSourceKey; remainder: number }[] = [];
    let distributed = 0;
    for (const source of active) {
      const target = targets.get(source.key) ?? 0;
      const base = Math.floor((target * remaining) / discretionarySum);
      scaled.set(source.key, base);
      distributed += base;
      // Integer remainders only — a float comparison here is not deterministic.
      remainders.push({ key: source.key, remainder: (target * remaining) % discretionarySum });
    }
    const ranked = remainders
      .slice()
      .sort((a, b) => b.remainder - a.remainder || keyOrder(a.key) - keyOrder(b.key));
    let leftover = remaining - distributed;
    for (const entry of ranked) {
      if (leftover <= 0) break;
      scaled.set(entry.key, (scaled.get(entry.key) ?? 0) + 1);
      leftover -= 1;
    }
  }

  let assignedChars = 0;
  for (const source of active) {
    const share = Math.min(source.minimum.length + (scaled.get(source.key) ?? 0), source.full.length);
    shares.set(source.key, share);
    assignedChars += share;
  }

  let capacity = available - assignedChars;
  for (const key of PRIME_SOURCE_KEYS) {
    if (capacity <= 0) break;
    const source = active.find((candidate) => candidate.key === key);
    if (source === undefined) continue;
    const current = shares.get(key) ?? 0;
    const grant = Math.min(capacity, source.full.length - current);
    if (grant <= 0) continue;
    shares.set(key, current + grant);
    capacity -= grant;
  }

  const total = PRIME_SOURCE_KEYS.reduce((sum, key) => sum + (shares.get(key) ?? 0), 0);
  if (total > available) {
    throw new Error(`prime allocation assigned ${total} chars beyond ${available} available`);
  }
  for (const source of active) {
    const share = shares.get(source.key) ?? 0;
    if (share > source.full.length) {
      throw new Error(`prime source ${source.key} share ${share} exceeds demand ${source.full.length}`);
    }
    if (share < source.minimum.length) {
      throw new Error(`prime source ${source.key} share ${share} below minimum ${source.minimum.length}`);
    }
  }
  return { available, shares };
}

/**
 * The spec's fit/redistribute protocol. Every source renders once at its
 * initial share; the ACTUAL residual is released by baselining final shares at
 * rendered lengths, then offered once in priority order to first-pass degraded
 * sources that can activate a strictly larger second attempt. A source renders
 * at most twice, and returned fragments — not shares — are the conservation
 * authority.
 */
export function renderPrimeAllocation(
  allocation: PrimeAllocation,
  sources: readonly PreparedPrimeSource[],
): PrimeRenderedAllocation {
  const byKey = new Map<PrimeSourceKey, PreparedPrimeSource>();
  for (const source of sources) {
    if (byKey.has(source.key)) throw new Error(`prime source ${source.key} appears more than once`);
    assertPreparedInvariants(source);
    byKey.set(source.key, source);
  }

  const initialShares = new Map<PrimeSourceKey, number>();
  const finalShares = new Map<PrimeSourceKey, number>();
  const firstFragments = new Map<PrimeSourceKey, string>();
  const fragments = new Map<PrimeSourceKey, string>();

  for (const key of PRIME_SOURCE_KEYS) {
    const share = allocation.shares.get(key) ?? 0;
    const source = byKey.get(key);
    if (source === undefined || source.full.length === 0) {
      initialShares.set(key, 0);
      finalShares.set(key, 0);
      firstFragments.set(key, '');
      fragments.set(key, '');
      continue;
    }
    initialShares.set(key, share);
    const fragment = source.render(share);
    if (fragment.length > share) {
      throw new Error(`prime source ${key} rendered ${fragment.length} chars beyond share ${share}`);
    }
    if (fragment.length < source.minimum.length) {
      throw new Error(`prime source ${key} rendered below its structural minimum`);
    }
    if (share >= source.full.length && fragment !== source.full) {
      throw new Error(`prime source ${key} did not return its complete string at full demand`);
    }
    firstFragments.set(key, fragment);
    fragments.set(key, fragment);
    // Release the actual residual before any grant: never baseline on shares.
    finalShares.set(key, fragment.length);
  }

  let pool = PRIME_SOURCE_KEYS.reduce(
    (sum, key) => sum + (initialShares.get(key) ?? 0) - (firstFragments.get(key) ?? '').length,
    0,
  );

  for (const key of PRIME_SOURCE_KEYS) {
    if (pool <= 0) break;
    const source = byKey.get(key);
    if (source === undefined || source.full.length === 0) continue;
    const first = firstFragments.get(key) ?? '';
    if (first === source.full) continue; // complete, not degraded
    const initialShare = initialShares.get(key) ?? 0;
    const activationGap = initialShare - first.length;
    // A grant that cannot exceed the gap would re-render at the same budget:
    // consume nothing and leave the pool for the next degraded source.
    if (pool <= activationGap) continue;
    const grant = Math.min(pool, source.full.length - first.length);
    if (grant <= 0) continue;
    const secondBudget = first.length + grant;
    if (secondBudget <= initialShare) {
      throw new Error(`prime source ${key} second render would not exceed its first attempt`);
    }
    const second = source.render(secondBudget);
    if (second.length > secondBudget) {
      throw new Error(`prime source ${key} re-rendered ${second.length} chars beyond ${secondBudget}`);
    }
    if (second.length < source.minimum.length) {
      throw new Error(`prime source ${key} re-rendered below its structural minimum`);
    }
    fragments.set(key, second);
    finalShares.set(key, secondBudget);
    pool -= grant;
  }

  const usedChars = PRIME_SOURCE_KEYS.reduce(
    (sum, key) => sum + (fragments.get(key) ?? '').length,
    0,
  );
  if (usedChars > allocation.available) {
    throw new Error(`prime render used ${usedChars} chars beyond ${allocation.available} available`);
  }
  const finalShareChars = PRIME_SOURCE_KEYS.reduce((sum, key) => sum + (finalShares.get(key) ?? 0), 0);
  if (finalShareChars > allocation.available) {
    throw new Error(`prime final shares total ${finalShareChars} beyond ${allocation.available} available`);
  }
  for (const key of PRIME_SOURCE_KEYS) {
    const source = byKey.get(key);
    const share = finalShares.get(key) ?? 0;
    const fragment = fragments.get(key) ?? '';
    if (fragment.length > share) {
      throw new Error(`prime source ${key} final fragment exceeds its final share`);
    }
    if (source !== undefined && share > source.full.length) {
      throw new Error(`prime source ${key} final share ${share} exceeds demand ${source.full.length}`);
    }
  }

  return { available: allocation.available, initialShares, finalShares, firstFragments, fragments, usedChars };
}

/**
 * Wrap prepared body text in its owned presentation prefix (leading separator
 * plus section heading), so framing overhead is part of demand and the outer
 * composer never slices structural content.
 */
export function preparePrimeSource(
  key: PrimeSourceKey,
  prefix: string,
  prepared: PreparedPrimeText,
): PreparedPrimeSource {
  if (prepared.full === '') {
    if (prepared.minimum !== '') {
      throw new Error(`prime source ${key} has an empty demand but a non-empty minimum`);
    }
    return { key, minimum: '', full: '', render: () => '' };
  }
  if (prepared.minimum === '') {
    throw new Error(`prime source ${key} has a non-empty demand but an empty minimum`);
  }
  const minimum = prefix + prepared.minimum;
  const full = prefix + prepared.full;
  if (minimum.length > full.length) {
    throw new Error(`prime source ${key} minimum ${minimum.length} exceeds demand ${full.length}`);
  }
  return {
    key,
    minimum,
    full,
    render(charBudget: number): string {
      if (!Number.isInteger(charBudget)) {
        throw new Error(`prime source ${key} share must be an integer, received ${String(charBudget)}`);
      }
      if (charBudget < minimum.length) {
        throw new Error(`prime source ${key} share ${charBudget} below structural minimum ${minimum.length}`);
      }
      // Exact demand returns the stored bytes: prime ignores the inherited
      // three-row MCP threshold, which would otherwise degrade a fitting source.
      if (charBudget >= full.length) return full;
      const body = prepared.render(charBudget - prefix.length);
      const out = prefix + body;
      if (out.length > charBudget) {
        throw new Error(`prime source ${key} rendered ${out.length} chars beyond share ${charBudget}`);
      }
      if (out.length < minimum.length) {
        throw new Error(`prime source ${key} rendered below its structural minimum`);
      }
      return out;
    },
  };
}
