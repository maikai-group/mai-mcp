// 3D landscape (spec §3.4). Same view-model, same landing set, same theme token
// as the 2D renderer — a different projection, not a different graph.
//
// The library is loaded with a DYNAMIC import (D8): three.js is ~600 kB and the
// 2D view must not pay for it. That is also why this component is the only file
// that names the package.
//
// TYPING (D13, verified by compiling against the pinned 1.80.0 declaration —
// §0.2): the export is `declare const ForceGraph3D: IForceGraph3D` whose only
// signature is `new(element, configOptions?)`. `ForceGraph3DInstance` is
// exported, so the instance needs no cast; the const's generics are already
// fixed, so accessors receive the library's `NodeObject`/`LinkObject` and the
// app's payload is read back off them by widening assignment. Zero assertions.
import { useCallback, useEffect, useMemo, useRef, useState, type MutableRefObject } from 'react';
import type { ElementDefinition } from 'cytoscape';
import type { ForceGraph3DInstance, NodeObject, LinkObject } from '3d-force-graph';
import {
  AdditiveBlending, CanvasTexture, Color, DataTexture, Group, LinearFilter, PerspectiveCamera, RGBAFormat, Sprite, SpriteMaterial,
} from 'three';
import { kindStyle } from '../../../lib/kinds';
import { relationStyle } from '../../../lib/relations';
import type { GraphTheme } from '../../../lib/themes';
import { DEFAULT_OBJECTIVE, depthSpread, EXPLORATION_NODE_CEILING, labelPolicy, objectiveDistance, visibleElements, zValues, type ObjectivePower, type ZMode, type ZNode } from '../model';
import { edgeWidth } from '../stylesheet';
import { WEBGL_UNAVAILABLE_MESSAGE } from './webgl';

/** The payload this app rides on each node/link. Every field optional so the
 * library types and these are assignable BOTH ways — that mutual assignability
 * is what removes the casts. `index` is present on LinkFields because TypeScript
 * rejects a widening to a type with no property in common (TS2559). */
export interface NodeFields { label?: string; kind?: string; degree?: number; fz?: number; isLanding?: number }
export interface LinkFields { strength?: number; index?: number; relation?: string }
export type Node3D = NodeObject & NodeFields;
export type Link3D = LinkObject<NodeObject> & LinkFields;

const nodeFields = (n: NodeObject): NodeFields => n;
const linkFields = (l: LinkObject<NodeObject>): LinkFields => l;

export interface ThreeNodeTreatment {
  color: string;
  opacity: number;
  glowOpacity: number;
  glowScale: number;
}

/** Semantic kind remains the base colour; the active theme supplies tint,
 * opacity and halo treatment. Pure so live-theme parity is testable without a
 * WebGL context. */
export function threeNodeTreatment(theme: GraphTheme, kindColor: string): ThreeNodeTreatment {
  const mixed = new Color(kindColor).lerp(new Color(theme.node.tintColor), theme.node.tintMix);
  return {
    color: mixed.getStyle(),
    opacity: theme.node.body === 'hollow' ? 0.22 : theme.node.fillOpacity,
    glowOpacity: theme.node.haloOpacity,
    glowScale: glowScaleFor(theme),
  };
}

/** Deterministic white radial falloff. The material tint supplies semantic
 * colour; alpha reaches zero at every edge, so no billboard square is visible. */
export function radialHaloRgba(size = 64): Uint8Array {
  if (!Number.isInteger(size) || size < 3) throw new RangeError('halo texture size must be an integer >= 3');
  const data = new Uint8Array(size * size * 4);
  const centre = (size - 1) / 2;
  for (let y = 0; y < size; y += 1) {
    for (let x = 0; x < size; x += 1) {
      const distance = Math.hypot(x - centre, y - centre) / centre;
      const linear = Math.max(0, 1 - distance);
      const alpha = linear * linear * (3 - 2 * linear);
      const offset = (y * size + x) * 4;
      data[offset] = 255;
      data[offset + 1] = 255;
      data[offset + 2] = 255;
      data[offset + 3] = Math.round(alpha * 255);
    }
  }
  return data;
}

export function createHaloTexture(size = 64): DataTexture {
  const texture = new DataTexture(radialHaloRgba(size), size, size, RGBAFormat);
  texture.minFilter = LinearFilter;
  texture.magFilter = LinearFilter;
  texture.needsUpdate = true;
  return texture;
}

export function createHaloMaterial(
  theme: GraphTheme,
  kindColor: string,
  texture: DataTexture,
): SpriteMaterial {
  const treatment = threeNodeTreatment(theme, kindColor);
  return new SpriteMaterial({
    map: texture,
    color: treatment.color,
    opacity: treatment.glowOpacity,
    transparent: true,
    blending: AdditiveBlending,
    depthWrite: false,
  });
}

/**
 * Volume for a node of the given degree.
 *
 * 3d-force-graph treats nodeVal as VOLUME and derives radius from its cube root.
 * The pre-plan-47 accessor was `1 + Math.min(18, Math.sqrt(degree))`, which
 * composed to radius ∝ degree^(1/6): a degree-64 node rendered at roughly twice
 * the radius of a degree-1 node, so hubs did not read as hubs and every dot
 * looked the same size.
 *
 * Feeding degree in linearly makes radius ∝ degree^(1/3) — the ordinary,
 * legible mapping. The cap stays (locked decision 5): unbounded, one mega-hub
 * swallows the frame.
 */
export function nodeVolume(degree: unknown): number {
  const d = typeof degree === 'number' && Number.isFinite(degree) && degree > 0 ? degree : 0;
  return 1 + Math.min(400, d);
}

/** 4 is the library's current default; pinning it makes the radius arithmetic
 * below independent of a dependency's default changing under us. */
export const NODE_REL_SIZE = 4;

/**
 * Sphere segments by density (plan 48a R4). The library default of 8 draws
 * visibly faceted spheres — 128 triangles each — and Plan 47's degree-scaled
 * hubs made the facets larger, not smaller. Cost is segments² × 2 triangles per
 * node, so the tiers trade smoothness for interactivity as the count grows:
 * 24 (1,152) for every landing set, 16 (512) to 5,000 nodes, 12 (288) above —
 * 7.2 M triangles at MAX_HERO_NODES, against today's 3.2 M. Total: a
 * non-finite count is exploration.
 */
export function nodeResolutionFor(nodeCount: unknown): number {
  const n = typeof nodeCount === 'number' && Number.isFinite(nodeCount) && nodeCount > 0 ? nodeCount : 0;
  if (n <= EXPLORATION_NODE_CEILING) return 24;
  if (n <= 5_000) return 16;
  return 12;
}

/** How far past the sphere's silhouette the halo reaches, as a radius ratio. */
export const HALO_RADIUS_MARGIN = 1.25;

/** ONE owner for the halo-padding → scale formula. Extracted so haloScalar and
 * threeNodeTreatment cannot drift apart — the formula lived inline in
 * threeNodeTreatment before this plan. */
export function glowScaleFor(theme: GraphTheme): number {
  return 1 + theme.node.haloPadding / 12;
}

/**
 * FULL sprite extent for a node's halo. Sprite geometry is a unit quad spanning
 * ±0.5, so scale is a full extent and HALF of it is what must clear the sphere
 * radius `cbrt(nodeVolume) × NODE_REL_SIZE` — hence the explicit × 2. Dropping
 * that factor reproduces the pre-plan defect: a halo drawn entirely inside the
 * sphere, invisible on every fill-bodied theme.
 *
 * glowScale depends only on the theme, not the kind colour, so this stays pure
 * in (theme, degree).
 */
export function haloScalar(theme: GraphTheme, degree: unknown): number {
  const radius = Math.cbrt(nodeVolume(degree)) * NODE_REL_SIZE;
  return Math.max(10, radius * 2 * HALO_RADIUS_MARGIN) * glowScaleFor(theme);
}

/**
 * Edge colour. Pre-plan-47 every edge was `t.chrome.border` regardless of what it
 * meant, so edges read as flat scaffolding.
 *
 * The registry is `relationStyle` (lib/relations.ts), NOT `kindStyle`. Relations
 * and node kinds are disjoint vocabularies — the 21 entries of GRAPH_RELATIONS
 * (`src/graph/registry.ts:33`) and the 15 keys of KIND_STYLES intersect in
 * exactly zero elements, so `kindStyle(relation)` would return FALLBACK_KIND for
 * every edge: one flat grey, the precise defect R6 exists to remove. The 2D
 * renderer already resolves edge colour this way at `stylesheet.ts:120-121`, so
 * using the same registry is what keeps the two projections one visual language.
 *
 * Verify before trusting this comment by READING the two vocabularies side by
 * side: src/graph/registry.ts:33-55 (GRAPH_RELATIONS) against
 * frontend/src/lib/kinds.ts:5-22 (KIND_STYLES keys). (A node -e require() of a
 * .ts file cannot run; reading is the check.)
 */
export function edgeColor(theme: GraphTheme, relation: unknown): string {
  const named = typeof relation === 'string' && relation.length > 0 ? relation : null;
  if (named === null) return theme.chrome.border;
  return relationStyle(named).color;
}

/** What the 3D exploration view runs at TODAY: linkOpacity is never called, so
 * the library default applies (three-forcegraph.mjs:549-551). Pinned as a named
 * constant because R2 makes it a ceiling: exploration must render exactly as
 * it did before this plan. */
export const EXPLORATION_LINK_OPACITY = 0.2;

/**
 * Density-appropriate opacity (R6) that leaves exploration untouched (R2).
 * At overview densities (≲ 1,200 edges) the attenuation term is 1 and the min()
 * returns EXPLORATION_LINK_OPACITY — the exact value the view renders at today
 * (every theme token is 0.5–0.7, all above the cap). At hero densities the
 * attenuated token drops below the cap and takes over, bottoming out at
 * 0.2 × theme.edge.opacity at 60,000 edges, so tens of thousands of additive
 * strokes read as structure rather than fog while keeping the theme's relative
 * character. Pure, so the curve is testable without a renderer.
 */
export function heroLinkOpacity(theme: GraphTheme, linkCount: number): number {
  const attenuation = Math.min(1, Math.max(0.2, 1200 / Math.max(1, linkCount)));
  return Math.min(EXPLORATION_LINK_OPACITY, theme.edge.opacity * attenuation);
}

/** Scene-unit height of a rendered label. Tuned against NODE_REL_SIZE so a label
 * reads beside a mid-sized node without dwarfing a leaf. */
export const LABEL_HEIGHT = 8;

/**
 * Y offset of a label's CENTRE above its node's centre. The sphere radius is
 * degree-scaled (cbrt(nodeVolume) × NODE_REL_SIZE, up to ≈ 29.6 at the cap), so
 * a FIXED offset buries the text: at LABEL_HEIGHT = 8, any node of degree ≥ 7
 * already has radius ≥ 8 and the label would render inside its own sphere —
 * and labels only render on the top-64-degree hubs, i.e. exactly the buried
 * ones. Offset = radius + half the label height + a 2-unit gap, so the label's
 * bottom edge always floats just above the silhouette.
 */
export function labelOffsetY(degree: unknown): number {
  return Math.cbrt(nodeVolume(degree)) * NODE_REL_SIZE + LABEL_HEIGHT / 2 + 2;
}

/**
 * A text sprite drawn from the theme's OWN label tokens (themes.ts
 * NodeTreatment.labelColor/labelFont/labelSize/labelOutline) — the same four
 * values the 2D renderer styles labels with, so the projections cannot drift.
 *
 * Returns null when text is empty or a 2D context is unavailable, and a null is
 * "no label", never a thrown render.
 *
 * `createCanvas` is injectable because THIS REPO'S JSDOM HAS NO CANVAS BACKEND —
 * verified: `getContext('2d')` returns null and logs "Not implemented:
 * HTMLCanvasElement's getContext() method: without installing the canvas npm
 * package", and no canvas package is installed. Without the seam every label
 * assertion would take the null branch and pass vacuously, so R4 would ship with
 * no runnable proof at all. Tests inject a fake canvas whose 2D context records
 * its calls; production uses `defaultCanvasFactory` and is unchanged.
 */
export type CanvasFactory = () => HTMLCanvasElement;

export const defaultCanvasFactory: CanvasFactory = () => document.createElement('canvas');

export function makeLabelSprite(
  text: string,
  theme: GraphTheme,
  createCanvas: CanvasFactory = defaultCanvasFactory,
): Sprite | null {
  if (text.length === 0) return null;
  const canvas = createCanvas();
  const measureCtx = canvas.getContext('2d');
  if (measureCtx === null) return null;
  const font = `${theme.node.labelSize * 4}px ${theme.node.labelFont}`;
  measureCtx.font = font;
  const width = Math.ceil(measureCtx.measureText(text).width) + 16;
  const height = theme.node.labelSize * 6;
  canvas.width = width;
  canvas.height = height;

  // Setting canvas.width/height RESETS the 2D context's state — font included —
  // so the font must be re-assigned after the resize. `getContext` returns the
  // same object; it is the state that was cleared, not the context.
  const ctx = canvas.getContext('2d');
  if (ctx === null) return null;
  ctx.font = font;
  ctx.textBaseline = 'middle';
  ctx.lineWidth = 4;
  ctx.strokeStyle = theme.node.labelOutline;
  ctx.strokeText(text, 8, height / 2);
  ctx.fillStyle = theme.node.labelColor;
  ctx.fillText(text, 8, height / 2);

  const texture = new CanvasTexture(canvas);
  texture.minFilter = LinearFilter;
  const material = new SpriteMaterial({ map: texture, transparent: true, depthWrite: false });
  const sprite = new Sprite(material);
  sprite.scale.set((width / height) * LABEL_HEIGHT, LABEL_HEIGHT, 1);
  return sprite;
}

function makeNodeGlow(
  theme: GraphTheme,
  kindColor: string,
  texture: DataTexture,
  materials: Set<SpriteMaterial>,
  degree: unknown,
): Sprite {
  const material = createHaloMaterial(theme, kindColor, texture);
  materials.add(material);
  const sprite = new Sprite(material);
  sprite.scale.setScalar(haloScalar(theme, degree));
  return sprite;
}

/** Pure: elements + Z-mode → the graph data the renderer consumes. Exported so
 * the projection is testable without WebGL. */
export function toGraphData(
  elements: readonly ElementDefinition[],
  hiddenKinds: readonly string[],
  mode: ZMode,
  nowMs: number,
  spread?: number,
): { nodes: Node3D[]; links: Link3D[] } {
  const projected = visibleElements(elements, hiddenKinds);
  const nodeEls = projected.filter((e) => e.data != null && e.data.id != null && e.data.source == null);
  const zNodes: ZNode[] = nodeEls.map((e) => ({
    id: String(e.data?.id),
    kind: String(e.data?.kind ?? 'unknown'),
    lastTouched: typeof e.data?.lastTouched === 'string' ? e.data.lastTouched : null,
    confidence: typeof e.data?.confidence === 'number' ? e.data.confidence : null,
  }));
  const z = zValues(mode, zNodes, nowMs);
  // The depth range scales with the projection's own size (plan 48a R2): 400
  // for every landing set, √n above the crossover. The parameter survives so
  // tests can pin a range without a 15,000-node fixture.
  const range = spread ?? depthSpread(zNodes.length);
  const nodes: Node3D[] = zNodes.map((n, i) => {
    const base: Node3D = {
      id: n.id,
      label: String(nodeEls[i].data?.label ?? n.id),
      kind: n.kind,
      degree: Number(nodeEls[i].data?.degree ?? 0),
      isLanding: Number(nodeEls[i].data?.isLanding ?? 0),
    };
    // free: no fz at all — the simulation owns depth (R1). Any other mode pins
    // it: x/y stay free for the force simulation (spec §3.4).
    if (mode === 'free') return base;
    return { ...base, fz: ((z.get(n.id) ?? 0.5) - 0.5) * range };
  });
  const known = new Set(nodes.map((n) => n.id));
  const links: Link3D[] = projected
    .filter((e) => e.data?.source != null && known.has(String(e.data.source)) && known.has(String(e.data.target)))
    .map((e) => ({
      source: String(e.data?.source),
      target: String(e.data?.target),
      strength: typeof e.data?.strength === 'number' ? e.data.strength : 1,
      relation: typeof e.data?.relation === 'string' ? e.data.relation : undefined,
    }));
  return { nodes, links };
}

export interface CameraTarget {
  position: { x: number; y: number; z: number };
  lookAt: { x: number; y: number; z: number };
}

export interface SceneFrame {
  centre: { x: number; y: number; z: number };
  /** Camera distance from the centre at which every node is inside the view. */
  distance: number;
}

/**
 * One camera command, executed exactly once (R3). Plan 48b-2 constructs these;
 * this plan only honours them.
 *
 * `id` is the whole mechanism. It is strictly increasing per producer, and the
 * landscape retires an id only by executing it, so re-requesting the target the
 * camera already shows still moves the camera. That matters because the user
 * can orbit and zoom by hand at any time: any design that compares a request
 * against a remembered value has a dead button waiting behind the next drag.
 */
export interface CameraRequest {
  /** `'fit'` IS the 4× frame; a power magnifies it by the 2D table's ratios. */
  target: 'fit' | ObjectivePower;
  /** Wait for the next `onEngineStop` instead of moving now (hero entry). */
  onSettle: boolean;
  /** Strictly increasing, and 1-BASED. The consumer starts its executed-id
   * record at 0 and skips anything `<= ` it, so `id: 0` and any negative id
   * are unexecutable by construction. TypeScript cannot express "positive
   * integer", so the guarantee lives with the producer: Plan 48b-2's
   * `requestCamera` is the sole constructor of a CameraRequest, and it
   * pre-increments a ref that starts at 0, so the first id it ever issues is
   * 1. A hand-built `{id: 0}` request is silently ignored — acceptable
   * because no such producer exists, and named here so the next one knows. */
  id: number;
}

/** Floor for the FIT frame (and the degenerate-set frame): below it the fit
 * camera would sit inside a node. Objective steps apply no floor of their own,
 * but they are magnifications OF the fit frame, so they inherit this one as
 * their base. On any graph small enough for this clamp to bind, the fit frame
 * is exactly 300, so 100× cannot land closer than 300 * 0.35 / 2.6 = 40.4 —
 * a floor the step never applies but can never escape either. That is intended
 * (100× on a small graph means a camera inside the cloud, spec C6), but it is
 * inheritance, not a bypass. The only other limits are the camera's near plane
 * and the `distance <= 0` guard in `moveCameraTo`. */
export const MIN_FRAME_DISTANCE = 300;
const FRAME_PADDING = 1.15;

/**
 * The bounding centre of the live node positions and the distance at which
 * their bounding sphere fills the narrower half of the view (spec C4).
 * Pure over the positions; non-finite coordinates are skipped; an empty or
 * degenerate set yields MIN_FRAME_DISTANCE, never 0 or NaN.
 */
export function sceneFrame(
  nodes: readonly { x?: number; y?: number; z?: number }[],
  fovDegrees: number,
  aspect: number,
): SceneFrame {
  const pts = nodes.flatMap((n) =>
    typeof n.x === 'number' && typeof n.y === 'number' && typeof n.z === 'number'
      && Number.isFinite(n.x) && Number.isFinite(n.y) && Number.isFinite(n.z)
      ? [{ x: n.x, y: n.y, z: n.z }] : []);
  if (pts.length === 0) return { centre: { x: 0, y: 0, z: 0 }, distance: MIN_FRAME_DISTANCE };
  const lo = { x: Infinity, y: Infinity, z: Infinity };
  const hi = { x: -Infinity, y: -Infinity, z: -Infinity };
  for (const p of pts) {
    lo.x = Math.min(lo.x, p.x); lo.y = Math.min(lo.y, p.y); lo.z = Math.min(lo.z, p.z);
    hi.x = Math.max(hi.x, p.x); hi.y = Math.max(hi.y, p.y); hi.z = Math.max(hi.z, p.z);
  }
  const centre = { x: (lo.x + hi.x) / 2, y: (lo.y + hi.y) / 2, z: (lo.z + hi.z) / 2 };
  let radius = 0;
  for (const p of pts) radius = Math.max(radius, Math.hypot(p.x - centre.x, p.y - centre.y, p.z - centre.z));
  const vFov = (Number.isFinite(fovDegrees) && fovDegrees > 0 ? fovDegrees : 75) * Math.PI / 180;
  const ratio = Number.isFinite(aspect) && aspect > 0 ? aspect : 1;
  const hFov = 2 * Math.atan(Math.tan(vFov / 2) * ratio);
  const halfFov = Math.min(vFov, hFov) / 2;
  const distance = Math.max(MIN_FRAME_DISTANCE, (radius / Math.sin(halfFov)) * FRAME_PADDING);
  return { centre, distance };
}

/** Where the camera goes to sit `distance` from `centre` along its CURRENT
 * direction — the user's viewing angle survives a fit or a zoom step. A camera
 * at the centre (zero direction) looks in from +z. */
export function cameraAt(
  current: { x: number; y: number; z: number },
  centre: { x: number; y: number; z: number },
  distance: number,
): { x: number; y: number; z: number } {
  const dx = current.x - centre.x; const dy = current.y - centre.y; const dz = current.z - centre.z;
  const len = Math.hypot(dx, dy, dz);
  const dir = len > 0 ? { x: dx / len, y: dy / len, z: dz / len } : { x: 0, y: 0, z: 1 };
  return { x: centre.x + dir.x * distance, y: centre.y + dir.y * distance, z: centre.z + dir.z * distance };
}

/** Resolve the camera target from the LIVE force-simulated node. Before the
 * simulation settles, missing x/y deliberately fall back to the origin while
 * preserving the semantic fz/z plane. */
export function cameraTarget(node: NodeObject): CameraTarget {
  const finite = (value: unknown, fallback: number): number =>
    typeof value === 'number' && Number.isFinite(value) ? value : fallback;
  const fallbackZ = finite(nodeFields(node).fz, 0);
  const x = finite(node.x, 0);
  const y = finite(node.y, 0);
  const z = finite(node.z, fallbackZ);
  return { position: { x, y, z: z + 300 }, lookAt: { x, y, z } };
}

export interface LandscapeProps {
  elements: readonly ElementDefinition[];
  hiddenKinds: readonly string[];
  theme: GraphTheme;
  zMode: ZMode;
  selectedId: string | null;
  onSelect: (id: string) => void;
  /** Late failure: hand control back to 2D (R8). */
  onFailure: (why: string) => void;
  /** Injectable canvas creation, defaulted for production. Exists because this
   * repo's jsdom has no canvas backend: without injection the accessor's label
   * path is untestable — see makeLabelSprite's comment. */
  canvasFactory?: CanvasFactory;
  /** R9: the hero picture lives on the WebGL canvas, which cytoscape's exporter
   * cannot capture. Assigned in an effect, cleared on unmount. Additive control
   * prop; the data contract (`elements`) is untouched. */
  exportRef?: MutableRefObject<(() => string | null) | null>;
  /** R2/R3: the one camera control. The landscape executes a request once per
   * `id` and remembers nothing else. Undefined or null means no request is
   * outstanding, and no request-driven move happens. Plan 47's selection
   * fly-to is a separate writer and is unaffected by this prop. */
  cameraRequest?: CameraRequest | null;
  /** R3: the depth range the projection pins to. Exploration passes
   * DEPTH_SPREAD_MIN so its range is 400 BY CONSTRUCTION however far the user
   * expands; hero leaves it undefined so the range follows the node count. */
  depthRange?: number;
}

export function Landscape({
  elements,
  hiddenKinds,
  theme,
  zMode,
  selectedId,
  onSelect,
  onFailure,
  canvasFactory = defaultCanvasFactory,
  exportRef,
  depthRange,
  cameraRequest,
}: LandscapeProps) {
  const mount = useRef<HTMLDivElement>(null);
  const graphRef = useRef<ForceGraph3DInstance | null>(null);
  const haloTextureRef = useRef<DataTexture | null>(null);
  const glowMaterialsRef = useRef(new Set<SpriteMaterial>());
  const labelMaterialsRef = useRef<Set<SpriteMaterial>>(new Set());
  const [ready, setReady] = useState(false);

  const visibleNodeCount = useMemo(
    () => visibleElements(elements, hiddenKinds).filter((e) => e.data?.source == null).length,
    [elements, hiddenKinds],
  );

  const getHaloTexture = useCallback((): DataTexture => {
    if (haloTextureRef.current === null) {
      const texture = createHaloTexture();
      // The halo texture is SHARED by every glow material, and three-forcegraph
      // disposes `material.map` for every node object it removes (its
      // _deallocate → _materialDispose), so the library disposes this texture
      // once per removed node on every re-projection. three re-uploads a
      // disposed texture on the next render, so the picture survives — but a
      // disposed texture must not stay pinned in the ref as if it were live.
      // Drop the ref on dispose so the next glow gets a fresh texture
      // (review finding bb709a37).
      texture.addEventListener('dispose', () => {
        if (haloTextureRef.current === texture) haloTextureRef.current = null;
      });
      haloTextureRef.current = texture;
    }
    return haloTextureRef.current;
  }, []);

  /** Snapshot-and-clear both registries, so the ownership window matches the
   * object lifetime: the caller disposes the snapshot AFTER the renderer has
   * replaced the objects that hold these materials (finding 688e3f31). */
  const takeNodeMaterials = useCallback((): { glow: SpriteMaterial[]; labels: SpriteMaterial[] } => {
    const glow = [...glowMaterialsRef.current];
    const labels = [...labelMaterialsRef.current];
    glowMaterialsRef.current.clear();
    labelMaterialsRef.current.clear();
    return { glow, labels };
  }, []);

  /** ONE owner of the disposal rule for both registries. Glow maps are NOT
   * disposed here: every glow material's map is the shared halo texture, whose
   * own lifetime is handled by getHaloTexture's dispose listener and by
   * destroyGraph. Each label owns its CanvasTexture, so the map dies with it. */
  const disposeNodeMaterials = useCallback((taken: { glow: SpriteMaterial[]; labels: SpriteMaterial[] }): void => {
    taken.glow.forEach((material) => material.dispose());
    taken.labels.forEach((material) => {
      material.map?.dispose();
      material.dispose();
    });
  }, []);

  const disposeGlowMaterials = useCallback((): void => {
    disposeNodeMaterials(takeNodeMaterials());
  }, [disposeNodeMaterials, takeNodeMaterials]);

  /** Take ownership away before teardown begins, so cleanup and a failed
   * initialization cannot destroy the same renderer twice. */
  const destroyGraph = useCallback((): void => {
    const graph = graphRef.current;
    graphRef.current = null;
    try { graph?._destructor(); } catch { /* teardown must not mask the 2D fallback */ }
    disposeGlowMaterials();
    haloTextureRef.current?.dispose();
    haloTextureRef.current = null;
  }, [disposeGlowMaterials]);

  /** Theme → live instance. Extracted so mount and later theme changes run the
   * SAME code: revision 1 applied the theme only at construction, so switching
   * theme while 3D was mounted left the old colours on screen. */
  const applyTheme = useCallback((g: ForceGraph3DInstance, t: GraphTheme): void => {
    disposeGlowMaterials();
    g.backgroundColor(t.background.base)
      .nodeColor((n: NodeObject) => {
        const kindColor = kindStyle(nodeFields(n).kind ?? 'unknown').color;
        return threeNodeTreatment(t, kindColor).color;
      })
      .nodeOpacity(threeNodeTreatment(t, '#ffffff').opacity)
      .nodeThreeObject((n: NodeObject) => {
        const f = nodeFields(n);
        const glow = makeNodeGlow(t, kindStyle(f.kind ?? 'unknown').color,
          getHaloTexture(), glowMaterialsRef.current, f.degree);
        // The SAME policy the 2D renderer uses. `power` is the hero objective;
        // isHeart/isSelected are not available per-node here, and labelPolicy
        // returns true for isLanding regardless of them, which is exactly the
        // hero rule.
        const labelled = labelPolicy({
          power: DEFAULT_OBJECTIVE, isLanding: f.isLanding === 1,
          isHeart: false, isSelected: false,
        });
        if (!labelled) return glow;
        // canvasFactory is the component's injectable seam (see below) — passing
        // it HERE is what makes the label path reachable from tests at all;
        // the bare two-argument call would silently pin the default factory,
        // whose jsdom canvas returns a null context, and every label assertion
        // would pass vacuously against the null branch.
        const label = makeLabelSprite(f.label ?? '', t, canvasFactory);
        if (label === null) return glow;
        // Degree-scaled, NOT a constant: labels only render on hubs, whose
        // radii outgrow any fixed offset (see labelOffsetY's comment).
        label.position.set(0, labelOffsetY(f.degree), 0);
        const group = new Group();
        group.add(glow, label);
        labelMaterialsRef.current.add(label.material);
        return group;
      })
      .nodeThreeObjectExtend(true)
      .linkColor((l: LinkObject<NodeObject>) => edgeColor(t, linkFields(l).relation))
      // linkOpacity is a GLOBAL scalar in 3d-force-graph, not a per-link
      // accessor, so it is derived from the currently-loaded link count and
      // re-applied wherever graphData changes (the two sites below).
      .linkOpacity(heroLinkOpacity(t, g.graphData().links.length))
      .linkWidth((l: LinkObject<NodeObject>) => edgeWidth(t, linkFields(l).strength ?? 1))
      .refresh();
  }, [disposeGlowMaterials, getHaloTexture, canvasFactory]);

  useEffect(() => {
    if (!mount.current) return;
    let disposed = false;
    let contextCanvas: HTMLCanvasElement | null = null;
    let contextLoss: ((event: Event) => void) | null = null;

    void (async () => {
      try {
        const mod = await import('3d-force-graph');
        if (disposed || !mount.current) return;
        const ForceGraph3D = mod.default;
        // antialias is the library default today (three-render-objects sets
        // it); pinned explicitly so a dependency default cannot regress it.
        const g = new ForceGraph3D(mount.current, { rendererConfig: { antialias: true } });
        // Cleanup owns the instance immediately after construction. Every
        // accessor/theme/refresh below may throw and must still destroy it.
        graphRef.current = g;
        g.nodeLabel((n: NodeObject) => nodeFields(n).label ?? '')
          .nodeRelSize(NODE_REL_SIZE)
          .nodeResolution(nodeResolutionFor(visibleNodeCount))
          .nodeVal((n: NodeObject) => nodeVolume(nodeFields(n).degree))
          .onNodeClick((n: NodeObject) => { const id = n.id; if (typeof id === 'string') onSelect(id); })
          .onEngineStop(() => {
            const pending = pendingRef.current;
            // Retiring the id IS the consumption, and `<=` answers both cases:
            // a second stop for a request already executed, and a parked
            // request that a LATER request overtook.
            //
            // An earlier revision also cleared `pendingRef` here. It was
            // removed on 2026-09-04 (finding 771afba5): no mutant could kill
            // that line, because the id comparison already answered every
            // case it answered. A guard no test can falsify is not defence in
            // depth, it is an untested claim.
            if (pending === null || pending.id <= doneRef.current) return;
            doneRef.current = pending.id;
            moveCameraTo(pending.target);
          });
        applyTheme(g, theme);
        g.graphData(toGraphData(elements, hiddenKinds, zMode, Date.now(), depthRange));
        g.linkOpacity(heroLinkOpacity(theme, g.graphData().links.length));
        contextCanvas = g.renderer().domElement;
        contextLoss = (event: Event) => {
          event.preventDefault();
          onFailure(WEBGL_UNAVAILABLE_MESSAGE);
        };
        contextCanvas.addEventListener('webglcontextlost', contextLoss);
        setReady(true);
      } catch {
        // The probe can pass and construction still fail — blocked GPU, lost
        // context, a chunk that will not load. Give 3D up rather than leave a
        // dead overlay on top of a live 2D canvas.
        destroyGraph();
        if (!disposed) onFailure(WEBGL_UNAVAILABLE_MESSAGE);
      }
    })();

    return () => {
      disposed = true;
      if (contextCanvas !== null && contextLoss !== null) {
        contextCanvas.removeEventListener('webglcontextlost', contextLoss);
      }
      destroyGraph();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Render and read in the SAME tick. Without preserveDrawingBuffer the drawing
  // buffer is cleared after compositing, so a toDataURL on a later tick returns
  // a blank image. Forcing one render immediately before the read avoids setting
  // preserveDrawingBuffer (typed at 3d-force-graph.d.ts:8 as rendererConfig),
  // which would cost frame rate on every 3D view, not just on export.
  //
  // Boundary: the LIVE view renders through the library's post-processing
  // composer, whose final pass today is a plain render, so this produces the
  // identical image. If a post-processing pass (bloom, say) is ever added, this
  // export must switch to rendering through that composer or the PNG will
  // silently lose the effect.
  const exportPng = useCallback((): string | null => {
    const g = graphRef.current;
    if (g === null) return null;
    g.renderer().render(g.scene(), g.camera());
    return g.renderer().domElement.toDataURL('image/png');
  }, []);

  useEffect(() => {
    if (exportRef === undefined) return;
    exportRef.current = exportPng;
    return () => { exportRef.current = null; };
  }, [exportRef, exportPng]);

  /** The one programmatic camera move THIS PLAN ADDS: fit (4×) and every
   * objective step go through here, so they cannot disagree about the frame
   * (spec C4/C6). Not the only `cameraPosition` writer in this file — Plan 47's
   * selection fly-to is a second one, below, and is deliberately untouched. */
  const moveCameraTo = useCallback((target: 'fit' | ObjectivePower): void => {
    const g = graphRef.current;
    if (g === null) return;
    const nodes = g.graphData().nodes;
    // R5: nothing to frame is a no-op, not a jump to the origin — see the
    // spec's error-handling section, the empty-node-set bullet. Cited by
    // section rather than by line: that file has been amended twice since,
    // and a line pin in a SHIPPED comment goes stale silently.
    // `sceneFrame` is deliberately TOTAL and floors the empty set to
    // MIN_FRAME_DISTANCE, which is right for its own callers but would make an
    // empty scene yank the camera to (0,0,300). Emptiness is this caller's
    // business, not the frame's, so the guard lives here.
    if (nodes.length === 0) return;
    const cam = g.camera();
    const frame = cam instanceof PerspectiveCamera
      ? sceneFrame(nodes, cam.fov, cam.aspect)
      : sceneFrame(nodes, 75, 1);
    // 'fit' IS the 4× distance; the powers step in by the 2D table's ratios,
    // adding no floor of their own (see MIN_FRAME_DISTANCE).
    const distance = target === 'fit' ? frame.distance : objectiveDistance(target, frame.distance);
    if (!Number.isFinite(distance) || distance <= 0) return;
    g.cameraPosition(cameraAt(g.cameraPosition(), frame.centre, distance), frame.centre, 600);
  }, []);

  // R3: the ONLY thing this component remembers about the camera is the last
  // request id it executed. Not the target, not the position, not an
  // objective — those are the comparisons that produce a dead button, because
  // a second producer (or the user's own mouse) can move the camera without
  // the remembered value ever hearing about it.
  const doneRef = useRef(0);
  // A settle-deferred request waits here. The engine-stop callback is
  // registered ONCE at mount, so it reads this ref rather than closing over
  // one render's props.
  const pendingRef = useRef<CameraRequest | null>(null);

  useEffect(() => {
    const request = cameraRequest ?? null;
    // Null CANCELS anything waiting on the engine. It is ONE of the two ways
    // a request is dropped without executing — the other is being overtaken by
    // a later request, handled in the engine-stop callback below. It exists
    // because hero can close while the landscape stays mounted: restoring the
    // Z-mode relayouts the graph, and without this the hero fit would fire on
    // the exploration cloud the user just returned to.
    if (request === null) { pendingRef.current = null; return; }
    if (request.id <= doneRef.current) return;
    // Readiness is checked BEFORE any id is retired: a press that lands during
    // the ~600 kB dynamic import must still be honoured once the instance is
    // live, so an id is only retired by an execution that actually happened.
    if (!ready) return;
    if (request.onSettle) { pendingRef.current = request; return; }
    doneRef.current = request.id;
    moveCameraTo(request.target);
  }, [cameraRequest, ready, moveCameraTo]);

  // Theme changes RE-APPLY to the live instance — never refetch (spec §3.5).
  useEffect(() => {
    const g = graphRef.current;
    if (g) applyTheme(g, theme);
  }, [theme, ready, applyTheme]);

  // Elements / Z-mode changes re-project the same data.
  useEffect(() => {
    const g = graphRef.current;
    if (g === null) return;
    // Every re-projection mints new node objects, so the renderer rebuilds every
    // node and the materials the previous projection registered are orphaned.
    // Snapshot them first, dispose them AFTER the replacement — until the
    // digest runs, the old materials are still attached to objects in the
    // scene (finding 688e3f31).
    const stale = takeNodeMaterials();
    g.nodeResolution(nodeResolutionFor(visibleNodeCount));
    g.graphData(toGraphData(elements, hiddenKinds, zMode, Date.now(), depthRange));
    g.linkOpacity(heroLinkOpacity(theme, g.graphData().links.length));
    disposeNodeMaterials(stale);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- `theme` is read for linkOpacity only. Listing it would re-push graphData on every theme switch, and toGraphData mints new node objects each call, so the force layout would restart on a cosmetic change; applyTheme already re-applies linkOpacity on theme changes, and the closure is rebuilt every render so the value read is always current.
  }, [elements, hiddenKinds, zMode, ready, visibleNodeCount, depthRange]);

  // Camera flies to the selection — the 3D half of the one selection path.
  useEffect(() => {
    if (selectedId === null) return;
    const g = graphRef.current;
    if (!g) return;
    const node = g.graphData().nodes.find((candidate) => candidate.id === selectedId);
    if (!node) return;
    const target = cameraTarget(node);
    g.cameraPosition(target.position, target.lookAt, 800);
  }, [selectedId, ready]);

  return <div ref={mount} className="absolute inset-0 z-10" data-webgl={ready ? 'ok' : 'loading'}
    data-3d-theme={theme.id} data-3d-selected={selectedId ?? ''}
    data-3d-node-count={visibleNodeCount} />;
}
