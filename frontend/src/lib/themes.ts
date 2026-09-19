// Graph themes (spec §3.2) as INERT DATA. A theme is a token object; the
// cytoscape stylesheet and the underlay painter are generated from it
// (stylesheet.ts), and the 3D renderer reads the same token. There are
// deliberately no per-theme code branches anywhere else in the graph views —
// adding one is what the structural gate in stylesheet.test.ts forbids.
//
// Kind colours are NOT here: kindStyle() in ../lib/kinds.ts owns them and they
// are constant across themes. Themes are atmosphere, not information design.
//
// This module performs NO I/O. Persistence of the operator's choice lives in
// Plan 30's shell settings context; Graph.tsx is the sole graph-feature bridge
// to that operator-settings seam (R2/D3).

export type ThemeId = 'organism' | 'observatory' | 'atlas' | 'signal';

export interface BackgroundSpec {
  /** Painted behind everything; also the PNG export background. */
  base: string;
  /** Radial wash stops, centre first, outermost last. CSS colour strings. */
  gradient: readonly string[];
  /** Decorative field drawn under the nodes by the underlay painter. */
  field: 'starfield' | 'grid' | 'none';
  /** Field ink. Ignored when field is 'none'. */
  fieldColor: string;
  /** Multiplier applied to the module-glow alpha (0 disables module glows). */
  moduleGlow: number;
}

export interface NodeTreatment {
  /** Mixed into semantic kind colours in 3D; 2D keeps kind as the base too. */
  tintColor: string;
  tintMix: number;
  /** 'fill' = solid body; 'hollow' = transparent body, coloured ring only. */
  body: 'fill' | 'hollow';
  fillOpacity: number;
  borderWidth: number;
  /** Overlay ring padding in px; 0 disables the halo. */
  haloPadding: number;
  haloOpacity: number;
  labelColor: string;
  labelFont: string;
  labelSize: number;
  labelOutline: string;
}

export interface EdgeTreatment {
  curve: 'bezier' | 'straight' | 'haystack';
  opacity: number;
  /** Vessel width = baseWidth + strength * strengthScale, capped at maxWidth. */
  baseWidth: number;
  strengthScale: number;
  maxWidth: number;
  arrowScale: number;
}

export interface ChromeAccents {
  panel: string;
  border: string;
  accent: string;
  text: string;
  textDim: string;
}

export interface GraphTheme {
  id: ThemeId;
  name: string;
  background: BackgroundSpec;
  node: NodeTreatment;
  edge: EdgeTreatment;
  chrome: ChromeAccents;
  /** The heart's colour — anatomy (focus), not category (spec §3.3). */
  heartColor: string;
  /** Layout for this theme (D5). Both ship inside cytoscape 3.34. */
  layout: 'concentric' | 'cose';
  /** Pulse is the Organism's 7-day heartbeat; other themes opt out. */
  pulse: boolean;
}

const ORGANISM: GraphTheme = {
  id: 'organism',
  name: 'Organism',
  background: {
    base: '#04100f',
    gradient: ['rgba(45,212,191,0.10)', 'rgba(6,20,24,0.65)', '#04100f'],
    field: 'none',
    fieldColor: '#0d3b38',
    moduleGlow: 1,
  },
  node: {
    tintColor: '#2dd4bf', tintMix: 0.12,
    body: 'fill',
    fillOpacity: 0.88,
    borderWidth: 1.4,
    haloPadding: 4,
    haloOpacity: 0.16,
    labelColor: '#cbd5e1',
    labelFont: 'ui-monospace, monospace',
    labelSize: 9,
    labelOutline: '#04100f',
  },
  edge: { curve: 'bezier', opacity: 0.5, baseWidth: 1, strengthScale: 0.55, maxWidth: 7, arrowScale: 0.6 },
  chrome: { panel: 'rgba(10,34,41,0.85)', border: '#0d3b38', accent: '#2dd4bf', text: '#e2e8f0', textDim: '#94a3b8' },
  heartColor: '#f43f5e',
  layout: 'concentric',
  pulse: true,
};

const OBSERVATORY: GraphTheme = {
  id: 'observatory',
  name: 'Observatory',
  background: {
    base: '#03040a',
    gradient: ['rgba(96,165,250,0.14)', 'rgba(9,12,28,0.7)', '#03040a'],
    field: 'starfield',
    fieldColor: '#c7d2fe',
    moduleGlow: 1.5,
  },
  node: {
    tintColor: '#818cf8', tintMix: 0.22,
    body: 'fill',
    fillOpacity: 0.9,
    borderWidth: 1,
    haloPadding: 9,
    haloOpacity: 0.3,
    labelColor: '#e0e7ff',
    labelFont: 'ui-sans-serif, system-ui, sans-serif',
    labelSize: 9,
    labelOutline: '#03040a',
  },
  edge: { curve: 'bezier', opacity: 0.6, baseWidth: 0.8, strengthScale: 0.6, maxWidth: 8, arrowScale: 0.5 },
  chrome: { panel: 'rgba(12,16,38,0.85)', border: '#1e2a5a', accent: '#818cf8', text: '#e0e7ff', textDim: '#a5b4fc' },
  heartColor: '#fb7185',
  layout: 'cose',
  pulse: false,
};

const ATLAS: GraphTheme = {
  id: 'atlas',
  name: 'Atlas',
  background: {
    base: '#f8f7f2',
    gradient: ['rgba(255,255,255,0.9)', 'rgba(248,247,242,0.95)', '#f1efe6'],
    field: 'grid',
    fieldColor: '#ddd8c8',
    moduleGlow: 0.35,
  },
  node: {
    tintColor: '#f8f7f2', tintMix: 0.08,
    body: 'fill',
    fillOpacity: 1,
    borderWidth: 2,
    haloPadding: 5,
    haloOpacity: 0.9,
    labelColor: '#2b2a26',
    labelFont: 'ui-serif, Georgia, serif',
    labelSize: 10,
    labelOutline: '#f8f7f2',
  },
  edge: { curve: 'bezier', opacity: 0.55, baseWidth: 0.9, strengthScale: 0.45, maxWidth: 6, arrowScale: 0.6 },
  chrome: { panel: 'rgba(255,255,255,0.9)', border: '#ddd8c8', accent: '#0f766e', text: '#2b2a26', textDim: '#6b675c' },
  heartColor: '#be123c',
  layout: 'cose',
  pulse: false,
};

const SIGNAL: GraphTheme = {
  id: 'signal',
  name: 'Signal',
  background: {
    base: '#000000',
    gradient: ['rgba(0,0,0,0)', 'rgba(0,0,0,0)', '#000000'],
    field: 'grid',
    fieldColor: '#1a1a1a',
    moduleGlow: 0,
  },
  node: {
    tintColor: '#22d3ee', tintMix: 0.16,
    body: 'hollow',
    fillOpacity: 0,
    borderWidth: 1.6,
    haloPadding: 0,
    haloOpacity: 0,
    labelColor: '#d4d4d4',
    labelFont: 'ui-monospace, monospace',
    labelSize: 9,
    labelOutline: '#000000',
  },
  edge: { curve: 'straight', opacity: 0.7, baseWidth: 0.7, strengthScale: 0.35, maxWidth: 4, arrowScale: 0.5 },
  chrome: { panel: 'rgba(0,0,0,0.9)', border: '#262626', accent: '#22d3ee', text: '#d4d4d4', textDim: '#737373' },
  heartColor: '#f43f5e',
  layout: 'cose',
  pulse: false,
};

/** Ship set, picker order. Organism is first because it is the default. */
export const THEMES: readonly GraphTheme[] = [ORGANISM, OBSERVATORY, ATLAS, SIGNAL];

export const DEFAULT_THEME_ID: ThemeId = 'organism';

const BY_ID = new Map<ThemeId, GraphTheme>(THEMES.map((t) => [t.id, t]));

/** A type predicate, not a cast: the narrowing is declared in the signature and
 * proven by the membership test, so R14 needs no exception (plan 29 D13). */
export function isThemeId(raw: string | null | undefined): raw is ThemeId {
  return raw != null && THEMES.some((t) => t.id === raw);
}

/** Total. Unknown, corrupt, null or undefined → the default id (spec §3.2). */
export function resolveThemeId(raw: string | null | undefined): ThemeId {
  return isThemeId(raw) ? raw : DEFAULT_THEME_ID;
}

/** Total. Never throws, never returns undefined. */
export function themeById(id: string | null | undefined): GraphTheme {
  const theme = BY_ID.get(resolveThemeId(id));
  // resolveThemeId guarantees membership; the fallback keeps the type total
  // without a non-null assertion.
  return theme ?? ORGANISM;
}
