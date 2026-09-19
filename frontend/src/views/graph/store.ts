// The graph view-model (spec §3.1): one plain-state store, hand-rolled
// subscribe/notify, no state library. BOTH renderers, Legend, Drawer and the
// pickers read and write ONLY through this — which is what makes cross-view
// parity (identical filters, selection and neighbourhood; the switch preserves
// all three) true by construction rather than by discipline.
//
// Spotlight is deliberately NOT a client (plan 29 D11): its query box is local,
// ephemeral UI, it is mounted once outside the 2D/3D branch so it never unmounts
// on a view switch, and a store round-trip would buy behaviour it already has.
//
// React-free on purpose: every transition below is testable as a plain function
// call. useGraphStore.ts is the four-line React bridge.
import type { ElementDefinition } from 'cytoscape';
import { DEFAULT_THEME_ID, resolveThemeId, type ThemeId } from '../../lib/themes';
import { DEFAULT_OBJECTIVE, DEFAULT_Z_MODE, topDegreeNodeId, type ObjectivePower, type ZMode } from './model';

// -------------------------------------------------------------------- state

export type GraphStatus = 'loading' | 'ready' | 'empty' | 'nocy';
export type GraphViewMode = '2d' | '3d';

/** Both freshness axes, already rendered to display strings by the server
 * (R10) — the frontend never composes freshness wording. */
export interface FreshnessLine {
  tone: 'ok' | 'warn' | 'info';
  text: string;
}
export interface FreshnessBanner {
  code: FreshnessLine;
  db: FreshnessLine;
}

export interface GraphViewState {
  status: GraphStatus;
  elements: readonly ElementDefinition[];
  selectedId: string | null;
  /** The focus node. Null until the first landing load. */
  heartId: string | null;
  /** The project's own top-degree hub — where ⌂ returns to. */
  projectHeartId: string | null;
  hiddenKinds: readonly string[];
  themeId: ThemeId;
  view: GraphViewMode;
  objective: ObjectivePower;
  /** Rendered cytoscape zoom, reported by the renderer through onZoomChange.
   * Held here so React renders it from the store rather than querying the
   * controller — one read authority (R1). */
  zoom: number;
  zMode: ZMode;
  freshness: FreshnessBanner | null;
}

export function initialGraphState(): GraphViewState {
  return {
    status: 'loading',
    elements: [],
    selectedId: null,
    heartId: null,
    projectHeartId: null,
    hiddenKinds: [],
    themeId: DEFAULT_THEME_ID,
    view: '2d',
    objective: DEFAULT_OBJECTIVE,
    zoom: 1,
    zMode: DEFAULT_Z_MODE,
    freshness: null,
  };
}

export interface GraphStore {
  getSnapshot(): GraphViewState;
  subscribe(listener: () => void): () => void;
  setStatus(status: GraphStatus): void;
  /** Landing load: replaces the element set and re-seeds the project heart. */
  resetToLanding(elements: readonly ElementDefinition[]): void;
  /** Expansion: adds elements, preserving selection, heart and hidden kinds. */
  mergeElements(elements: readonly ElementDefinition[]): void;
  select(id: string | null): void;
  /** Double-click promotion (spec §3.3). Ignored for an unknown id. */
  setHeart(id: string): void;
  toggleKind(kind: string): void;
  showAllKinds(): void;
  /** Accepts any string: this is the persistence seam, so validation lives
   * HERE (via resolveThemeId) rather than at every call site. That is also what
   * lets a corrupt-id test pass a bad value without a type assertion. */
  setTheme(id: string | null | undefined): void;
  setView(view: GraphViewMode): void;
  setObjective(power: ObjectivePower): void;
  setZoom(zoom: number): void;
  setZMode(mode: ZMode): void;
  setFreshness(freshness: FreshnessBanner | null): void;
}

const isNode = (el: ElementDefinition): boolean => el.data != null && el.data.id != null && el.data.source == null;

export function createGraphStore(initial: GraphViewState = initialGraphState()): GraphStore {
  let state = initial;
  const listeners = new Set<() => void>();

  const commit = (next: Partial<GraphViewState>): void => {
    state = { ...state, ...next };
    for (const listener of [...listeners]) listener();
  };

  const knows = (id: string): boolean => state.elements.some((el) => isNode(el) && String(el.data?.id) === id);

  return {
    getSnapshot: () => state,
    subscribe(listener) {
      listeners.add(listener);
      return () => { listeners.delete(listener); };
    },
    setStatus(status) { commit({ status }); },
    resetToLanding(elements) {
      const heart = topDegreeNodeId(elements);
      commit({
        elements: [...elements],
        projectHeartId: heart,
        heartId: heart,
        selectedId: null,
        hiddenKinds: [],
        status: elements.length === 0 ? 'empty' : 'ready',
      });
    },
    mergeElements(elements) {
      const seen = new Set(state.elements.map((el) => String(el.data?.id)));
      const fresh = elements.filter((el) => el.data?.id != null && !seen.has(String(el.data.id)));
      if (fresh.length === 0) return;
      commit({ elements: [...state.elements, ...fresh] });
    },
    select(id) { commit({ selectedId: id }); },
    setHeart(id) { if (knows(id)) commit({ heartId: id, selectedId: id }); },
    toggleKind(kind) {
      const hidden = state.hiddenKinds.includes(kind)
        ? state.hiddenKinds.filter((k) => k !== kind)
        : [...state.hiddenKinds, kind];
      commit({ hiddenKinds: hidden });
    },
    showAllKinds() { commit({ hiddenKinds: [] }); },
    setTheme(id) {
      const themeId = resolveThemeId(id);
      commit({ themeId });
    },
    setView(view) { commit({ view }); },
    setObjective(objective) { commit({ objective }); },
    setZoom(zoom) { if (Number.isFinite(zoom) && zoom !== state.zoom) commit({ zoom }); },
    setZMode(zMode) { commit({ zMode }); },
    setFreshness(freshness) { commit({ freshness }); },
  };
}

/** The app's single instance. Tests build their own with createGraphStore(). */
export const graphStore: GraphStore = createGraphStore();
