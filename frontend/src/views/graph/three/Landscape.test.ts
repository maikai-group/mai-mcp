import { describe, it, expect } from 'vitest';
import { kindStyle } from '../../../lib/kinds';
import { themeById } from '../../../lib/themes';
import { neighborsToElements } from '../elements';
import { DEPTH_SPREAD_MIN, EXPLORATION_NODE_CEILING, depthSpread } from '../model';
import { edgeWidth } from '../stylesheet';
import { FALLBACK_RELATION, relationStyle } from '../../../lib/relations';
import {
  EXPLORATION_LINK_OPACITY, HALO_RADIUS_MARGIN, LABEL_HEIGHT, MIN_FRAME_DISTANCE, NODE_REL_SIZE,
  cameraAt, cameraTarget, createHaloMaterial, createHaloTexture, edgeColor, glowScaleFor, haloScalar, sceneFrame,
  heroLinkOpacity, labelOffsetY, makeLabelSprite, nodeResolutionFor, nodeVolume, radialHaloRgba, threeNodeTreatment, toGraphData,
  type CanvasFactory,
} from './Landscape';
import { fakeCanvasFactory } from './fake-canvas';

const elements = [
  { data: { id: 'a', label: 'a', kind: 'table', degree: 4, lastTouched: '2026-06-01T00:00:00Z', confidence: 0.9 } },
  { data: { id: 'b', label: 'b', kind: 'endpoint', degree: 1, lastTouched: '2026-08-18T00:00:00Z', confidence: null } },
  { data: { id: 'e1', source: 'a', target: 'b', relation: 'calls', strength: 5 } },
  { data: { id: 'e2', source: 'a', target: 'ghost', relation: 'calls', strength: 1 } },
];

describe('toGraphData', () => {
  it('pins fz from the Z mode and keeps x/y free', () => {
    const d = toGraphData(elements, [], 'time', Date.parse('2026-08-18T00:00:00Z'));
    expect(d.nodes.map((n) => n.id)).toEqual(['a', 'b']);
    expect(d.nodes[0].fz ?? Number.NaN).toBeLessThan(d.nodes[1].fz ?? Number.NaN);
    for (const n of d.nodes) expect('fx' in n).toBe(false);
  });

  it('drops links whose endpoint is not in the node set', () => {
    const d = toGraphData(elements, [], 'time', Date.now());
    expect(d.links.map((l) => l.target)).toEqual(['b']);
  });

  it('never emits a non-finite fz in any mode', () => {
    for (const mode of ['time', 'abstraction', 'confidence'] as const) {
      for (const n of toGraphData(elements, [], mode, Date.now()).nodes) {
        expect(Number.isFinite(n.fz)).toBe(true);
      }
    }
  });

  it('falls back to strength 1 when the payload has no strength (old server)', () => {
    const normalized = neighborsToElements({
      center: 'a', capped: false,
      nodes: [
        { id: 'a', name: 'a', kind: 'file', qualified_name: null, file_path: null, line: null, degree: 1, lastTouched: null, confidence: null },
        { id: 'b', name: 'b', kind: 'file', qualified_name: null, file_path: null, line: null, degree: 1, lastTouched: null, confidence: null },
      ],
      edges: [{ source: 'a', target: 'b', relation: 'imports' }],
    });
    const d = toGraphData(normalized, [], 'abstraction', Date.now());
    expect(d.links[0].strength).toBe(1);
    expect(edgeWidth(themeById('organism'), d.links[0].strength))
      .toBe(edgeWidth(themeById('organism'), normalized.find((e) => e.data?.source === 'a')?.data?.strength));
  });

  it('derives node tint, opacity and glow from the active theme', () => {
    const semantic = kindStyle('function').color;
    const organism = threeNodeTreatment(themeById('organism'), semantic);
    const atlas = threeNodeTreatment(themeById('atlas'), semantic);
    expect(atlas.color).not.toBe(organism.color);
    expect(atlas.opacity).not.toBe(organism.opacity);
    expect(atlas.glowOpacity).not.toBe(organism.glowOpacity);
    expect(atlas.glowScale).not.toBe(organism.glowScale);
  });

  it('uses a populated radial falloff map instead of an untextured square sprite', () => {
    const size = 9;
    const pixels = radialHaloRgba(size);
    const alpha = (x: number, y: number): number => pixels[(y * size + x) * 4 + 3];
    expect(alpha(4, 4)).toBeGreaterThan(alpha(0, 0));
    expect(alpha(0, 0)).toBe(0);
    const texture = createHaloTexture(size);
    const material = createHaloMaterial(themeById('organism'), kindStyle('function').color, texture);
    expect(material.map).toBe(texture);
    expect(material.map).not.toBeNull();
    material.dispose();
    texture.dispose();
  });

  it('applies hidden kinds to nodes and incident links before 3D projection', () => {
    const d = toGraphData(elements, ['endpoint'], 'time', Date.now());
    expect(d.nodes.map((n) => n.id)).toEqual(['a']);
    expect(d.links).toEqual([]);
  });

  it('targets the selected live node coordinates, with a pre-settle fallback', () => {
    expect(cameraTarget({ id: 'a', x: 12, y: -8, z: 40 })).toEqual({
      position: { x: 12, y: -8, z: 340 },
      lookAt: { x: 12, y: -8, z: 40 },
    });
    expect(cameraTarget({ id: 'a', fz: 25 })).toEqual({
      position: { x: 0, y: 0, z: 325 },
      lookAt: { x: 0, y: 0, z: 25 },
    });
  });
});

const THEMES = ['organism', 'observatory', 'atlas', 'signal'] as const;

describe('nodeVolume — degree-legible sizing (plan 47 R5)', () => {
  it('is strictly increasing in degree up to the cap', () => {
    let prev = nodeVolume(0);
    for (let d = 1; d <= 400; d += 1) {
      const v = nodeVolume(d);
      expect(v).toBeGreaterThan(prev);
      prev = v;
    }
  });

  it('gives a degree-64 node at least 2.5× the RADIUS of a degree-1 node, where the pre-plan accessor gave 1.65×', () => {
    const radiusRatio = Math.cbrt(nodeVolume(64) / nodeVolume(1));
    expect(radiusRatio).toBeGreaterThanOrEqual(2.5);
    // The pre-plan accessor, as a computed expression rather than a coincidence.
    const prePlan = (degree: number): number => 1 + Math.min(18, Math.sqrt(degree));
    const prePlanRatio = Math.cbrt(prePlan(64) / prePlan(1));
    expect(prePlanRatio).toBeCloseTo(Math.cbrt(9 / 2), 6);
    expect(prePlanRatio).toBeLessThan(2);
    expect(radiusRatio).toBeGreaterThan(prePlanRatio);
  });

  it('is capped: degree 400 and degree 40,000 return the same volume', () => {
    expect(nodeVolume(40_000)).toBe(nodeVolume(400));
    expect(nodeVolume(401)).toBe(nodeVolume(400));
  });

  it('is total — null, undefined, NaN, negative and string degrees return the floor', () => {
    for (const bad of [null, undefined, Number.NaN, -5, '12', Number.POSITIVE_INFINITY]) {
      expect(nodeVolume(bad)).toBe(nodeVolume(0));
    }
    expect(nodeVolume(0)).toBe(1);
  });
});

describe('edgeColor — relation-coloured edges (plan 47 R6)', () => {
  const organism = themeById('organism');

  it('returns the registry colour for a known relation', () => {
    expect(edgeColor(organism, 'calls')).toBe(relationStyle('calls').color);
    expect(edgeColor(organism, 'calls')).not.toBe(organism.chrome.border);
  });

  it('falls back to theme.chrome.border for an empty or non-string relation, and to the registry fallback for an unknown name', () => {
    for (const t of THEMES) {
      const theme = themeById(t);
      // Every theme's border differs from FALLBACK_RELATION.color (#64748b), so
      // dropping the guard (mutant L5) changes the string visibly.
      expect(theme.chrome.border).not.toBe(FALLBACK_RELATION.color);
      expect(edgeColor(theme, '')).toBe(theme.chrome.border);
      expect(edgeColor(theme, undefined)).toBe(theme.chrome.border);
      expect(edgeColor(theme, 42)).toBe(theme.chrome.border);
    }
    expect(edgeColor(organism, 'no-such-relation')).toBe(FALLBACK_RELATION.color);
  });

  it('gives two different relations two different colours', () => {
    expect(edgeColor(organism, 'calls')).not.toBe(edgeColor(organism, 'imports'));
  });
});

describe('halo and opacity geometry (plan 47 Diagnosis item 4, R6)', () => {
  it('the halo half-extent clears the sphere on every halo-bearing theme at degrees 1, 64 and 400', () => {
    for (const t of THEMES) {
      const theme = themeById(t);
      if (theme.node.haloOpacity <= 0) continue;
      for (const d of [1, 64, 400]) {
        const radius = Math.cbrt(nodeVolume(d)) * NODE_REL_SIZE;
        expect(haloScalar(theme, d) / 2).toBeGreaterThan(radius);
      }
    }
    expect(HALO_RADIUS_MARGIN).toBeGreaterThan(1);
    // ONE owner for the glow-scale formula.
    for (const t of THEMES) expect(threeNodeTreatment(themeById(t), '#ffffff').glowScale).toBe(glowScaleFor(themeById(t)));
  });

  it('heroLinkOpacity attenuates with density and preserves exploration (R2)', () => {
    for (const t of THEMES) {
      const theme = themeById(t);
      expect(heroLinkOpacity(theme, 100)).toBe(EXPLORATION_LINK_OPACITY);
      expect(heroLinkOpacity(theme, 60_000)).toBeLessThan(heroLinkOpacity(theme, 100));
      expect(heroLinkOpacity(theme, 60_000)).toBeCloseTo(0.2 * theme.edge.opacity, 12);
      for (const n of [0, 1, 100, 1_200, 5_000, 25_000, 60_000, 1_000_000]) {
        expect(heroLinkOpacity(theme, n)).toBeLessThanOrEqual(EXPLORATION_LINK_OPACITY);
      }
    }
    expect(EXPLORATION_LINK_OPACITY).toBe(0.2);
  });

  it('toGraphData carries relation on links and isLanding on nodes for the accessors to read', () => {
    const d = toGraphData([
      { data: { id: 'a', label: 'a', kind: 'function', degree: 3, isLanding: 1 } },
      { data: { id: 'b', label: 'b', kind: 'function', degree: 1, isLanding: 0 } },
      { data: { id: 'e', source: 'a', target: 'b', relation: 'imports', strength: 2 } },
    ], [], 'abstraction', Date.now());
    expect(d.nodes.map((n) => n.isLanding)).toEqual([1, 0]);
    expect(d.links[0].relation).toBe('imports');
  });
});

describe('makeLabelSprite / labelOffsetY — hub labels (plan 47 R4)', () => {
  it('returns null for empty text, and null when the factory yields no 2D context (the real-jsdom behaviour)', () => {
    const nullFactory: CanvasFactory = () => {
      const canvas = document.createElement('canvas');
      canvas.getContext = () => null;
      return canvas;
    };
    expect(makeLabelSprite('', themeById('organism'), fakeCanvasFactory().factory)).toBeNull();
    expect(makeLabelSprite('hub', themeById('organism'), nullFactory)).toBeNull();
  });

  it('reads all four theme label tokens — a hardcoded value fails under two themes', () => {
    for (const id of ['organism', 'atlas'] as const) {
      const theme = themeById(id);
      const fake = fakeCanvasFactory();
      const sprite = makeLabelSprite('hub', theme, fake.factory);
      expect(sprite).not.toBeNull();
      const rec = fake.recorder;
      // Every token must be assigned AFTER the resize reset — a real resize
      // clears all of them, so a pre-resize assignment never reaches the
      // drawn label (mutant B5 for the font; the same shape for the rest).
      expect(rec.afterResize.font).toEqual([`${theme.node.labelSize * 4}px ${theme.node.labelFont}`]);
      expect(rec.afterResize.fillStyle).toEqual([theme.node.labelColor]);
      expect(rec.afterResize.strokeStyle).toEqual([theme.node.labelOutline]);
      expect(rec.afterResize.lineWidth).toEqual([4]);
      expect(rec.strokeTexts).toEqual([['hub', 8, theme.node.labelSize * 3]]);
      expect(rec.fillTexts).toEqual([['hub', 8, theme.node.labelSize * 3]]);
    }
  });

  it('sprite aspect ratio tracks the width measureText reported', () => {
    const theme = themeById('observatory');
    const narrow = fakeCanvasFactory(40);
    const wide = fakeCanvasFactory(400);
    const a = makeLabelSprite('x', theme, narrow.factory);
    const b = makeLabelSprite('x', theme, wide.factory);
    expect(a).not.toBeNull();
    expect(b).not.toBeNull();
    if (a === null || b === null) return;
    const height = theme.node.labelSize * 6;
    expect(a.scale.y).toBe(LABEL_HEIGHT);
    expect(a.scale.x).toBeCloseTo(((40 + 16) / height) * LABEL_HEIGHT, 9);
    expect(b.scale.x).toBeCloseTo(((400 + 16) / height) * LABEL_HEIGHT, 9);
    expect(b.scale.x).toBeGreaterThan(a.scale.x);
  });

  it('the label clears its own sphere at degrees 7, 64 and 400', () => {
    for (const d of [7, 64, 400]) {
      const radius = Math.cbrt(nodeVolume(d)) * NODE_REL_SIZE;
      expect(labelOffsetY(d) - LABEL_HEIGHT / 2).toBeGreaterThan(radius);
    }
    expect(labelOffsetY(400)).toBeGreaterThan(labelOffsetY(7));
  });
});

describe('projection depth (plan 48a R1/R2)', () => {
  const els = [
    { data: { id: 'a', label: 'a', kind: 'table', degree: 4, lastTouched: '2026-06-01T00:00:00Z', confidence: 0.9 } },
    { data: { id: 'b', label: 'b', kind: 'endpoint', degree: 1, lastTouched: '2026-08-18T00:00:00Z', confidence: null } },
    { data: { id: 'e1', source: 'a', target: 'b', relation: 'calls', strength: 5 } },
  ];

  it('free mode emits no fz on any node and leaves links intact', () => {
    const d = toGraphData(els, [], 'free', Date.now());
    for (const n of d.nodes) expect('fz' in n).toBe(false);
    expect(d.links).toHaveLength(1);
  });

  it('the other three modes pin fz exactly as before plan 48 at landing size', () => {
    for (const mode of ['time', 'abstraction', 'confidence'] as const) {
      const d = toGraphData(els, [], mode, Date.parse('2026-08-18T00:00:00Z'));
      const explicit = toGraphData(els, [], mode, Date.parse('2026-08-18T00:00:00Z'), 400);
      expect(d.nodes.map((n) => n.fz)).toEqual(explicit.nodes.map((n) => n.fz));
      for (const n of d.nodes) expect(Math.abs(n.fz ?? Number.NaN)).toBeLessThanOrEqual(200);
    }
  });

  it('the pinned range follows depthSpread of the VISIBLE node count', () => {
    // Three kinds cycle through the three abstraction tiers (table 0, function
    // 0.5, endpoint 1). Hiding `function` leaves BOTH outer tiers visible, so
    // the surviving projection has a non-degenerate spread to measure — a
    // single-kind survivor set would pin every node to one plane and prove
    // nothing about the range.
    const kinds = ['table', 'function', 'endpoint'];
    const many = Array.from({ length: 1_000 }, (_, i) => ({ data: { id: `n${i}`, label: `n${i}`, kind: kinds[i % 3], degree: 1 } }));
    const d = toGraphData(many, [], 'abstraction', Date.now());
    const zs = d.nodes.map((n) => n.fz ?? 0);
    expect(Math.max(...zs) - Math.min(...zs)).toBeCloseTo(depthSpread(1_000), 6);
    expect(depthSpread(1_000)).toBeGreaterThan(400);
    const hidden = toGraphData(many, ['function'], 'abstraction', Date.now());
    expect(hidden.nodes).toHaveLength(667);
    const hz = hidden.nodes.map((n) => n.fz ?? 0);
    // 667 ≠ 1,000, so a range derived from elements.length is visibly wrong here.
    expect(Math.max(...hz) - Math.min(...hz)).toBeCloseTo(depthSpread(667), 6);
    expect(depthSpread(667)).not.toBeCloseTo(depthSpread(1_000), 6);
  });

  it('an explicit depthRange overrides the count-derived range (R3, exploration by construction)', () => {
    const kinds = ['table', 'function', 'endpoint'];
    const many = Array.from({ length: 1_000 }, (_, i) => ({ data: { id: `n${i}`, label: `n${i}`, kind: kinds[i % 3], degree: 1 } }));
    const pinned = toGraphData(many, [], 'abstraction', Date.now(), DEPTH_SPREAD_MIN);
    const zs = pinned.nodes.map((n) => n.fz ?? 0);
    expect(Math.max(...zs) - Math.min(...zs)).toBeCloseTo(DEPTH_SPREAD_MIN, 6);
  });
});

/** Triangles a sphere of `segments` costs — the budget the tiers are chosen
 * against. Test-local on purpose (a production export with one test consumer
 * is dead code by the repo's own tooling). */
const sphereTriangles = (segments: number): number => segments * segments * 2;
/** Mirrors src/graph/full.ts:54 — the server-side hero cap. The frontend cannot
 * import it, so the literal is NAMED here so a grep for MAX_HERO_NODES finds
 * this budget test when the cap moves. */
const MAX_HERO_NODES = 25_000;

describe('nodeResolutionFor (plan 48a R4)', () => {
  it('is 24 for every landing set, 16 to 5,000, 12 above, and total', () => {
    for (const n of [0, 1, 45, 211, EXPLORATION_NODE_CEILING]) expect(nodeResolutionFor(n)).toBe(24);
    expect(nodeResolutionFor(EXPLORATION_NODE_CEILING + 1)).toBe(16);
    // The boundary is ALSO pinned as literals, because nodeResolutionFor
    // reuses EXPLORATION_NODE_CEILING — a DEPTH-derived quantity — as its
    // resolution tier edge, so re-calibrating DEPTH_SPREAD_K moves the 24→16
    // step (at K = 30 it lands at 177). The SYMBOL-based assertions above all
    // move with the constant and would stay green; what catches a
    // re-calibration is a hardcoded number, which the `211` entry in the loop
    // above already provides and these two make explicit. Locked decision 2
    // fixes this edge at 316 — the last count that still returns 24, with 317
    // the first that returns 16 — so the numbers are the contract, not the symbol.
    expect(nodeResolutionFor(316)).toBe(24);
    expect(nodeResolutionFor(317)).toBe(16);
    expect(nodeResolutionFor(5_000)).toBe(16);
    expect(nodeResolutionFor(5_001)).toBe(12);
    expect(nodeResolutionFor(25_000)).toBe(12);
    for (const bad of [Number.NaN, -1, null, '12']) expect(nodeResolutionFor(bad)).toBe(24);
  });

  it('keeps the hero triangle budget under 8 M and above today\'s default', () => {
    expect(MAX_HERO_NODES * sphereTriangles(nodeResolutionFor(MAX_HERO_NODES))).toBeLessThan(8_000_000);
    expect(sphereTriangles(nodeResolutionFor(45))).toBeGreaterThan(sphereTriangles(8));
  });
});

describe('sceneFrame / cameraAt (spec C4)', () => {
  it('centres the bounding box and clears the bounding sphere for the narrower half-fov', () => {
    const cube = [{ x: -100, y: -100, z: -100 }, { x: 100, y: 100, z: 100 }];
    const f = sceneFrame(cube, 75, 1.5);
    expect(f.centre).toEqual({ x: 0, y: 0, z: 0 });
    const radius = Math.hypot(100, 100, 100);
    const halfFov = (75 * Math.PI / 180) / 2; // vertical is the narrower at aspect 1.5
    expect(f.distance).toBeCloseTo((radius / Math.sin(halfFov)) * 1.15, 6);
    const wide = sceneFrame(cube, 75, 0.5);   // horizontal narrower at aspect 0.5
    expect(wide.distance).toBeGreaterThan(f.distance);
  });

  it('is total: empty, single-node and non-finite sets yield the minimum frame', () => {
    expect(sceneFrame([], 75, 1)).toEqual({ centre: { x: 0, y: 0, z: 0 }, distance: MIN_FRAME_DISTANCE });
    expect(sceneFrame([{ x: 5, y: 5, z: 5 }], 75, 1).distance).toBe(MIN_FRAME_DISTANCE);
    expect(sceneFrame([{ x: Number.NaN, y: 0, z: 0 }, { x: 1, y: 1, z: 1 }], 75, 1).distance).toBe(MIN_FRAME_DISTANCE);
    expect(sceneFrame([{ x: -100, y: 0, z: 0 }, { x: 100, y: 0, z: 0 }], Number.NaN, Number.NaN).distance).toBeGreaterThan(0);
  });

  it('cameraAt keeps the current direction and falls back to +z from the centre', () => {
    expect(cameraAt({ x: 0, y: 0, z: 10 }, { x: 0, y: 0, z: 0 }, 500)).toEqual({ x: 0, y: 0, z: 500 });
    const diag = cameraAt({ x: 3, y: 4, z: 0 }, { x: 0, y: 0, z: 0 }, 10);
    expect(diag.x).toBeCloseTo(6, 9); expect(diag.y).toBeCloseTo(8, 9); expect(diag.z).toBe(0);
    expect(cameraAt({ x: 1, y: 1, z: 1 }, { x: 1, y: 1, z: 1 }, 42)).toEqual({ x: 1, y: 1, z: 43 });
  });
});
