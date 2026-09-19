// Pure graph policy (spec §3.3/§3.4). No React, no DOM, no cytoscape runtime:
// every function here is a total function of its arguments, which is why the
// objective mapping, label policy, Z accessors and mode availability are all
// unit-tested rather than eyeballed on a canvas.
import type { ElementDefinition } from 'cytoscape';

// ---------------------------------------------------------------- objectives

/** Microscope objectives (spec §3.3) — magnification, not raw zoom. */
export type ObjectivePower = 4 | 10 | 40 | 100;

export interface Objective {
  power: ObjectivePower;
  /** cytoscape zoom level. All four sit strictly inside minZoom 0.1 / maxZoom 3. */
  zoom: number;
  label: string;
}

/** A table, not a formula (D4): a formula would need inverting and would drift
 * from cytoscape's zoom bounds. Ascending by zoom — zoomToObjective relies on it
 * only for readability, not correctness. */
export const OBJECTIVES: readonly Objective[] = [
  { power: 4, zoom: 0.35, label: '4×' },
  { power: 10, zoom: 0.75, label: '10×' },
  { power: 40, zoom: 1.5, label: '40×' },
  { power: 100, zoom: 2.6, label: '100×' },
];

export const DEFAULT_OBJECTIVE: ObjectivePower = 10;

export function objectiveToZoom(power: ObjectivePower): number {
  const found = OBJECTIVES.find((o) => o.power === power);
  return found ? found.zoom : OBJECTIVES[1].zoom;
}

/** Nearest objective to a raw zoom — this is what the wheel snaps the indicator
 * to. Total for any finite or non-finite input. */
export function zoomToObjective(zoom: number): ObjectivePower {
  // Total over the whole float domain, and each non-finite case is answered on
  // its meaning rather than lumped into a default: NaN is "no information", so
  // it yields the default; ±Infinity are the limits of zooming in and out, so
  // they saturate to the tightest and widest objective. cy.zoom() is clamped to
  // [0.1, 3] by minZoom/maxZoom so none of these can arrive from the real
  // caller — this is about the function being honest, not defensive.
  if (Number.isNaN(zoom)) return DEFAULT_OBJECTIVE;
  if (zoom === Number.POSITIVE_INFINITY) return OBJECTIVES[OBJECTIVES.length - 1].power;
  if (zoom === Number.NEGATIVE_INFINITY) return OBJECTIVES[0].power;
  let best = OBJECTIVES[0];
  for (const o of OBJECTIVES) {
    if (Math.abs(o.zoom - zoom) < Math.abs(best.zoom - zoom)) best = o;
  }
  return best.power;
}

// -------------------------------------------------------------- label policy

export interface LabelInput {
  power: ObjectivePower;
  /** A top-degree landing node from the overview payload (old A1). */
  isLanding: boolean;
  isHeart: boolean;
  isSelected: boolean;
}

/** Landing nodes are ALWAYS labelled; finer nodes label at higher objectives
 * (spec §3.3). The heart and the selection always carry their name. */
export function labelPolicy(i: LabelInput): boolean {
  if (i.isHeart || i.isSelected || i.isLanding) return true;
  return i.power >= 40;
}

// ------------------------------------------------------------ hop distances

interface EdgeEnds { source: string; target: string }

/** Undirected BFS hop count from the heart. Nodes unreachable from the heart are
 * absent from the map; concentric treats an absent level as the outermost ring
 * (see canvas.ts). Total, and safe on a cyclic graph. */
export function hopDistances(edges: readonly EdgeEnds[], heartId: string): Map<string, number> {
  const adjacency = new Map<string, string[]>();
  const link = (a: string, b: string) => {
    const list = adjacency.get(a);
    if (list) list.push(b);
    else adjacency.set(a, [b]);
  };
  for (const e of edges) {
    link(e.source, e.target);
    link(e.target, e.source);
  }
  const distance = new Map<string, number>([[heartId, 0]]);
  let frontier = [heartId];
  let hop = 0;
  while (frontier.length > 0) {
    hop += 1;
    const next: string[] = [];
    for (const id of frontier) {
      for (const neighbor of adjacency.get(id) ?? []) {
        if (!distance.has(neighbor)) {
          distance.set(neighbor, hop);
          next.push(neighbor);
        }
      }
    }
    frontier = next;
  }
  return distance;
}

/** The project heart: highest degree, ties broken by id so the seed is stable
 * across reloads. Null for an empty graph. */
export function topDegreeNodeId(elements: readonly ElementDefinition[]): string | null {
  let bestId: string | null = null;
  let bestDegree = -1;
  for (const el of elements) {
    const data = el.data;
    if (data == null || data.id == null || data.source != null) continue;
    const id = String(data.id);
    const degree = Number(data.degree ?? 0);
    const d = Number.isFinite(degree) ? degree : 0;
    if (d > bestDegree || (d === bestDegree && bestId != null && id < bestId)) {
      bestDegree = d;
      bestId = id;
    }
  }
  return bestId;
}

// ------------------------------------------------------------ store selectors

export interface GraphNodeFacts {
  id: string;
  name: string;
  kind: string;
  qualified_name: string | null;
  file_path: string | null;
  line: number | null;
  degree: number;
}

const textOrNull = (value: unknown): string | null =>
  typeof value === 'string' ? value : null;

const finiteOrNull = (value: unknown): number | null =>
  typeof value === 'number' && Number.isFinite(value) ? value : null;

/** Renderer-independent node facts for Drawer and heart chrome. The store's
 * element projection is the authority; Cytoscape and Three are write-only
 * render targets from the React shell's perspective (R1/R8). */
export function graphNodeFacts(
  elements: readonly ElementDefinition[],
  id: string,
): GraphNodeFacts | null {
  const node = elements.find((element) =>
    element.data?.source == null && String(element.data?.id ?? '') === id);
  if (node?.data == null) return null;
  const data = node.data;
  return {
    id,
    name: textOrNull(data.label) ?? textOrNull(data.name) ?? id,
    kind: textOrNull(data.kind) ?? 'unknown',
    qualified_name: textOrNull(data.qualified_name),
    file_path: textOrNull(data.file_path),
    line: finiteOrNull(data.line),
    degree: finiteOrNull(data.degree) ?? 0,
  };
}

/** Kind counts over the store projection, never a renderer's loaded subset. */
export function graphKindCounts(
  elements: readonly ElementDefinition[],
): Map<string, number> {
  const counts = new Map<string, number>();
  for (const element of elements) {
    if (element.data?.source != null) continue;
    const kind = textOrNull(element.data?.kind) ?? 'unknown';
    counts.set(kind, (counts.get(kind) ?? 0) + 1);
  }
  return counts;
}

// --------------------------------------------------------------- visibility

/** One renderer-independent visibility projection (R1/R8). Hidden kinds live
 * in the store; both renderers consume this policy so filters cannot drift.
 * Incident edges disappear with a hidden endpoint. */
export function visibleElements(
  elements: readonly ElementDefinition[],
  hiddenKinds: readonly string[],
): ElementDefinition[] {
  const hidden = new Set(hiddenKinds);
  const visibleNodeIds = new Set(
    elements
      .filter((e) => e.data?.source == null && !hidden.has(String(e.data?.kind ?? 'unknown')))
      .map((e) => String(e.data?.id)),
  );
  return elements.filter((e) => {
    if (e.data?.source == null) return visibleNodeIds.has(String(e.data?.id));
    return visibleNodeIds.has(String(e.data.source)) && visibleNodeIds.has(String(e.data.target));
  });
}

// ------------------------------------------------------------------- recency

export const PULSE_WINDOW_DAYS = 7;
const DAY_MS = 86_400_000;

/** 7-day pulse (spec §3.3). Total: null, empty and unparseable → false. */
export function isRecent(lastTouched: string | null | undefined, nowMs: number, days = PULSE_WINDOW_DAYS): boolean {
  if (lastTouched == null || lastTouched === '') return false;
  const t = Date.parse(lastTouched);
  if (!Number.isFinite(t)) return false;
  return nowMs - t <= days * DAY_MS && t <= nowMs;
}

/** Store-authoritative pulse ids for both visual layers. */
export function recentNodeIds(
  elements: readonly ElementDefinition[],
  nowMs: number,
): Set<string> {
  return new Set(elements.flatMap((element) => {
    if (element.data?.source != null) return [];
    const id = textOrNull(element.data?.id);
    const touched = textOrNull(element.data?.lastTouched);
    return id !== null && isRecent(touched, nowMs) ? [id] : [];
  }));
}

// -------------------------------------------------------------------- Z axis

export type ZMode = 'time' | 'abstraction' | 'confidence' | 'free';

/** `free` is listed LAST: it is the hero default (plan 48), not a semantic
 * axis, and the picker reads this order. */
export const Z_MODES: readonly ZMode[] = ['time', 'abstraction', 'confidence', 'free'];
export const DEFAULT_Z_MODE: ZMode = 'time';

/** Neutral plane. Every null accessor lands here — never NaN into the layout
 * (spec §5). */
export const Z_NEUTRAL = 0.5;

/** Abstraction ladder (spec §3.4): db kinds < files/modules < surfaces.
 * Derived from `kind`, stored nowhere. Unknown kinds sit on the neutral plane. */
const ABSTRACTION_TIER: Record<string, number> = {
  table: 0, column: 0, policy: 0,
  file: 0.5, script: 0.5, module: 0.5, class: 0.5, function: 0.5, method: 0.5,
  endpoint: 1, command: 1, package_script: 1, scheduled_job: 1, mcp_server: 1, env_var: 1,
};

export interface ZNode {
  id: string;
  kind: string;
  lastTouched: string | null;
  confidence: number | null;
}

/**
 * Z coordinates in [0, 1] for every node, by mode. Computed over the whole set
 * because `time` needs the set's own min/max to normalise — which is why this is
 * a set function, not a per-node accessor.
 */
export function zValues(mode: ZMode, nodes: readonly ZNode[], nowMs: number): Map<string, number> {
  const out = new Map<string, number>();
  // free: no pinned depth at all — the force simulation owns z (plan 48a R1).
  // An empty map is the contract: toGraphData omits fz for every node.
  if (mode === 'free') return out;
  if (mode === 'abstraction') {
    for (const n of nodes) out.set(n.id, ABSTRACTION_TIER[n.kind] ?? Z_NEUTRAL);
    return out;
  }
  if (mode === 'confidence') {
    for (const n of nodes) {
      const c = n.confidence;
      out.set(n.id, typeof c === 'number' && Number.isFinite(c) ? Math.min(1, Math.max(0, c)) : Z_NEUTRAL);
    }
    return out;
  }
  // time: bedrock below, recent work at the surface.
  const times = new Map<string, number>();
  for (const n of nodes) {
    if (n.lastTouched == null) continue;
    const t = Date.parse(n.lastTouched);
    if (Number.isFinite(t)) times.set(n.id, t);
  }
  const values = [...times.values()];
  const min = values.length > 0 ? Math.min(...values) : 0;
  const max = values.length > 0 ? Math.max(...values) : 0;
  const span = max - min;
  for (const n of nodes) {
    const t = times.get(n.id);
    if (t === undefined) out.set(n.id, Z_NEUTRAL);
    else if (span === 0) out.set(n.id, 1);
    else out.set(n.id, (t - min) / span);
    void nowMs;
  }
  return out;
}

/**
 * Which Z-modes are offerable for the loaded set (D7 / R9). `abstraction` is
 * always available — it is derived from `kind`, which every node has. The other
 * two need the additive payload fields, so an old server (or a project with no
 * git evidence / no linked decisions) greys them out instead of fabricating a
 * plane.
 */
export function zModeAvailability(nodes: readonly ZNode[]): Record<ZMode, boolean> {
  return {
    time: nodes.some((n) => n.lastTouched != null),
    abstraction: true,
    confidence: nodes.some((n) => typeof n.confidence === 'number' && Number.isFinite(n.confidence)),
    // Needs no payload field: the simulation supplies depth (plan 48).
    free: true,
  };
}

/** The tooltip a greyed-out mode shows. One sentence per mode, never "N/A". */
export function zModeUnavailableReason(mode: ZMode): string {
  switch (mode) {
    case 'time':
      return 'No last-touched data in this payload — the graph has no git-evidence file history for these nodes.';
    case 'confidence':
      return 'No linked-decision confidence for these nodes. Confidence comes from decisions linked to a node; lessons carry no node link.';
    case 'free':
      return 'Always available — the force simulation places depth.';
    case 'abstraction':
      return 'Always available — derived from node kind.';
  }
}

// ---------------------------------------------------------------- depth range

/** Exploration's depth range: Plan 29's constant. Every landing set renders
 * inside exactly this many units of depth, the same range as before plan 48;
 * resolution and the objective steps are what changed for exploration
 * (R4 here, the objective steps in plan 48b; spec amendment G3). */
export const DEPTH_SPREAD_MIN = 400;

/**
 * Calibrated, not guessed (plan 48 C2). The same simulation the renderer runs
 * (d3-force-3d, 3 dimensions, link + charge −60 + center, 900 ticks — well past
 * d3's alpha floor; the renderer's own stop is wall-clock, not a tick count) over
 * a real registered project's hero payload — 15,083 nodes, 15,537 edges, depth
 * pinned to 400 — settled to an x/y extent of 8,194 × 8,280. One third of that
 * width is 2,760; 2,760 / √15,083 = 22.47. Re-run the procedure in
 * `scripts/measure-layout-extent.mjs` (Task 1 Step 1c) if the force defaults or
 * the payload shape ever change.
 */
export const DEPTH_SPREAD_K = 22.5;

/**
 * Depth range for a projection of `nodeCount` nodes. 400 for every landing
 * set (the crossover (400 / 22.5)² ≈ 316 sits above the largest live overview,
 * 211 nodes), growing with √n above it. The constant is fitted at large hero
 * scale, where strata come out about a third as deep as the layout is wide
 * (0.33 at 15,083 nodes, 0.32 at 9,503). √n is only a proxy for width, and it
 * over-deepens smaller hero graphs: at 2,189 nodes the ratio is 0.80. That is
 * a known limit of one constant, not a bug — real width needs a settled
 * layout, which does not exist here. Total: a non-finite or negative count is
 * exploration.
 */
export function depthSpread(nodeCount: unknown): number {
  const n = typeof nodeCount === 'number' && Number.isFinite(nodeCount) && nodeCount > 0 ? nodeCount : 0;
  return Math.max(DEPTH_SPREAD_MIN, DEPTH_SPREAD_K * Math.sqrt(n));
}

/** The node count at which depthSpread leaves the exploration floor. Exported
 * so the resolution tiers and the tests share it instead of restating it. */
export const EXPLORATION_NODE_CEILING = Math.floor((DEPTH_SPREAD_MIN / DEPTH_SPREAD_K) ** 2);

/**
 * A 2D objective power as a 3D camera distance (plan 48 C6). 4× IS the frame
 * distance; the other powers use the same ratios the 2D table defines, so the
 * two projections share one vocabulary. Total: an unknown power is 10×
 * (objectiveToZoom's own fallback); a non-finite frame distance is 0.
 */
export function objectiveDistance(power: ObjectivePower, frameDistance: number): number {
  if (!Number.isFinite(frameDistance) || frameDistance <= 0) return 0;
  // Ratio FIRST: `x / x` is exactly 1 in IEEE arithmetic, so 4× returns the
  // frame distance bit-for-bit. Left-to-right (`d * 0.35 / 0.35`) is off by an
  // ulp and the "4× IS the fit distance" identity would fail its exact test.
  return frameDistance * (objectiveToZoom(4) / objectiveToZoom(power));
}
