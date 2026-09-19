// Cytoscape controller (spec §3.3). The stylesheet is GENERATED from the active
// theme token (stylesheet.ts) — this file holds no colour, no font and no theme
// id. Layout is the theme's own choice: Organism radiates concentrically around
// the heart, every other theme keeps cose.
import cytoscape, { type Core, type ElementDefinition, type NodeSingular } from 'cytoscape';
import type { GraphTheme } from '../../lib/themes';
import { cytoscapeStyleFromTheme } from './stylesheet';
import {
  hopDistances, isRecent, labelPolicy, objectiveToZoom, zoomToObjective,
  type ObjectivePower,
} from './model';

/** Decimal places the rendered zoom is serialized to. One stable precision
 * shared by the emitter and the DOM observable, so a resize that changes
 * nothing produces a byte-identical value. */
export const ZOOM_PRECISION = 4;

const COSE_LAYOUT: cytoscape.LayoutOptions = {
  name: 'cose',
  animate: false,
  fit: true,
  padding: 40,
  nodeRepulsion: () => 12000,
  idealEdgeLength: () => 90,
  edgeElasticity: () => 100,
  gravity: 0.3,
  componentSpacing: 80,
  randomize: true,
};

export interface CanvasController {
  cy: Core;
  /** Swap the active theme: regenerate the stylesheet and re-run the layout the
   * new theme asks for. Never refetches (spec §3.5). */
  setTheme(theme: GraphTheme): void;
  setElements(els: ElementDefinition[]): void;
  merge(els: ElementDefinition[]): void;
  resize(): void;
  fit(): void;
  /** Re-apply the store-authoritative filter to every currently-loaded node,
   * including nodes added by a later merge. */
  setHiddenKinds(kinds: readonly string[]): void;
  /** Promote a node to the heart and re-radiate (spec §3.3). Null clears it. */
  setHeart(id: string | null): void;
  setObjective(power: ObjectivePower): void;
  focusNode(id: string): void;
  exportPng(): string;
  onNodeSelect(cb: (id: string | null) => void): void;
  /** Double-click / right-click: this node becomes the heart. */
  onNodePromote(cb: (id: string) => void): void;
  /** Fires when the wheel moves the zoom into a different objective band. */
  onObjectiveChange(cb: (power: ObjectivePower) => void): void;
  /** Fires when the rendered zoom changes, at the precision the view-model
   * serializes. The store owns the value; React never reads it from here. */
  onZoomChange(cb: (zoom: number) => void): void;
  destroy(): void;
}

export function createCanvas(
  container: HTMLElement,
  theme: GraphTheme,
  now: () => number = Date.now,
): CanvasController {
  const cy = cytoscape({
    container,
    elements: [],
    style: cytoscapeStyleFromTheme(theme),
    wheelSensitivity: 0.2,
    minZoom: 0.1,
    maxZoom: 3,
  });

  let activeTheme = theme;
  let heartId: string | null = null;
  let hiddenKinds = new Set<string>();
  let objective: ObjectivePower = zoomToObjective(cy.zoom());
  let objectiveListener: ((power: ObjectivePower) => void) | null = null;
  let zoomListener: ((zoom: number) => void) | null = null;
  let lastZoomEmitted = '';

  /** Landing/heart/selection-aware labelling (old A1 / R5), applied through the
   * pure policy so the rule is unit-tested rather than inlined here. */
  const applyLabels = (): void => {
    cy.batch(() => {
      cy.nodes().forEach((n: NodeSingular) => {
        const show = labelPolicy({
          power: objective,
          isLanding: Number(n.data('isLanding') ?? 0) === 1,
          isHeart: n.id() === heartId,
          isSelected: n.selected(),
        });
        if (show) n.addClass('labels-on');
        else n.removeClass('labels-on');
      });
    });
  };

  /** 7-day pulse (spec §3.3). A theme that opts out never gets the class, which
   * is a token read — not a per-theme branch. */
  const applyRecency = (): void => {
    const nowMs = now();
    cy.batch(() => {
      cy.nodes().forEach((n: NodeSingular) => {
        const raw = n.data('lastTouched');
        const recent = activeTheme.pulse && isRecent(typeof raw === 'string' ? raw : null, nowMs);
        if (recent) n.addClass('recent');
        else n.removeClass('recent');
      });
    });
  };

  const applyHeartClass = (): void => {
    cy.batch(() => {
      cy.nodes().removeClass('heart');
      if (heartId !== null) cy.getElementById(heartId).addClass('heart');
    });
  };

  const applyVisibility = (): void => {
    cy.batch(() => {
      cy.nodes().forEach((node) => {
        if (hiddenKinds.has(String(node.data('kind')))) node.addClass('hidden-kind');
        else node.removeClass('hidden-kind');
      });
    });
  };

  const runLayout = (): void => {
    if (activeTheme.layout === 'concentric' && heartId !== null && !cy.getElementById(heartId).empty()) {
      const ends = cy.edges().map((e) => ({ source: e.source().id(), target: e.target().id() }));
      const hops = hopDistances(ends, heartId);
      // Unreachable nodes sit one ring beyond the furthest reachable one rather
      // than being dropped or stacked on the heart.
      const maxHop = Math.max(0, ...hops.values());
      const outer = maxHop + 1;
      cy.layout({
        name: 'concentric',
        animate: false,
        fit: true,
        padding: 40,
        minNodeSpacing: 24,
        // Higher value = closer to the centre, so invert the hop count.
        concentric: (node: NodeSingular) => outer - (hops.get(node.id()) ?? outer),
        levelWidth: () => 1,
      }).run();
    } else {
      cy.layout(COSE_LAYOUT).run();
    }
    applyHeartClass();
    applyVisibility();
    applyRecency();
    applyLabels();
  };

  cy.on('zoom', () => {
    const next = zoomToObjective(cy.zoom());
    if (next !== objective) {
      objective = next;
      applyLabels();
      if (objectiveListener) objectiveListener(next);
    }
    // Deduped on the serialized precision so an animation's intermediate
    // frames do not churn the store; the store, not this controller, is what
    // React renders from (plan 29 A18).
    const serialized = cy.zoom().toFixed(ZOOM_PRECISION);
    if (serialized !== lastZoomEmitted) {
      lastZoomEmitted = serialized;
      if (zoomListener) zoomListener(cy.zoom());
    }
  });
  cy.on('select unselect', 'node', applyLabels);

  return {
    cy,
    setTheme(next) {
      activeTheme = next;
      cy.style(cytoscapeStyleFromTheme(next));
      runLayout();
    },
    setElements(els) {
      cy.resize(); // pick up the real container size before fitting (lesson 64642d21)
      cy.elements().remove();
      cy.add(els);
      runLayout();
    },
    merge(els) {
      const existingIds = new Set(cy.elements().map((e) => e.id()));
      const fresh = els.filter((e) => {
        const id = e.data?.id;
        return id != null && !existingIds.has(String(id));
      });
      if (fresh.length === 0) return;
      cy.add(fresh);
      runLayout();
    },
    resize() {
      // Renderer dimensions only — NEVER refit. A container resize is not a
      // request to reframe: refitting would cancel focusNode's centring and
      // throw away the operator's pan and zoom. The initial 0→full paint is
      // still fitted by setElements' runLayout (lesson 64642d21), and `Fit`
      // remains the explicit way to reframe (plan 29 A15).
      //
      // Preserving raw pan is NOT enough: the anatomy drawer takes 24rem off
      // the canvas width, so a node centred before the resize ends up ~192px
      // right of the new centre. Hold the CENTRED MODEL POINT instead, so zoom
      // is untouched and the focused node stays where the operator put it.
      const zoom = cy.zoom();
      const pan = cy.pan();
      const centre = {
        x: (cy.width() / 2 - pan.x) / zoom,
        y: (cy.height() / 2 - pan.y) / zoom,
      };
      cy.resize();
      cy.pan({
        x: cy.width() / 2 - centre.x * zoom,
        y: cy.height() / 2 - centre.y * zoom,
      });
    },
    fit() {
      cy.resize();
      cy.fit(undefined, 40);
    },
    setHiddenKinds(kinds) {
      hiddenKinds = new Set(kinds);
      applyVisibility();
    },
    setHeart(id) {
      if (id !== null && cy.getElementById(id).empty()) return;
      heartId = id;
      runLayout();
    },
    setObjective(power) {
      objective = power;
      cy.zoom({ level: objectiveToZoom(power), renderedPosition: { x: cy.width() / 2, y: cy.height() / 2 } });
      applyLabels();
    },
    focusNode(id) {
      const node = cy.getElementById(id);
      if (node.empty()) return;
      // Re-centre on completion: selecting a node mounts the 24rem anatomy
      // drawer, and that resize lands mid-animation — so the animation would
      // otherwise finish centring for the pre-drawer geometry and leave the
      // node ~192px off. Settling once at the end makes focus independent of
      // when the resize happens (plan 29 A15).
      cy.animate(
        { center: { eles: node }, zoom: Math.max(cy.zoom(), objectiveToZoom(40)) },
        { duration: 400, complete: () => { cy.center(node); } },
      );
    },
    exportPng() {
      return cy.png({ full: true, bg: activeTheme.background.base, scale: 2 });
    },
    onNodeSelect(cb) {
      cy.on('select', 'node', (e) => cb(e.target.id()));
      cy.on('unselect', 'node', () => cb(null));
    },
    onNodePromote(cb) {
      // Double-click is the spec's gesture; right-click is the trackpad-friendly
      // alias for the same action, not a second behaviour.
      cy.on('dbltap', 'node', (e) => cb(e.target.id()));
      cy.on('cxttap', 'node', (e) => cb(e.target.id()));
    },
    onObjectiveChange(cb) {
      objectiveListener = cb;
    },
    onZoomChange(cb) {
      zoomListener = cb;
    },
    destroy() {
      cy.destroy();
    },
  };
}
