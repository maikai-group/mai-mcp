// Graph canvas view (spec §3). Every piece of state lives in the view-model
// store; this component is the glue between the store, the imperative cytoscape
// controller and the API. The 3D view is added in Task 8 — its absence here is
// deliberate, not an omission.
import { lazy, Suspense, useCallback, useEffect, useMemo, useRef, useState, type CSSProperties } from 'react';
import type { ElementDefinition } from 'cytoscape';
import { apiGet } from '../../lib/api';
import { useProjects } from '../../shell/project';
import { useSettings } from '../../shell/settings';
import { useToast } from '../../shell/toast';
import { themeById, type GraphTheme, type ThemeId } from '../../lib/themes';
import { createCanvas, ZOOM_PRECISION, type CanvasController } from './canvas';
import { createCurrents, type CurrentsController } from './currents';
import { underlaySpecFromTheme } from './stylesheet';
import { DEFAULT_OBJECTIVE, DEPTH_SPREAD_MIN, graphKindCounts, graphNodeFacts, recentNodeIds, visibleElements, zModeAvailability, type ObjectivePower, type ZMode, type ZNode } from './model';
import { overviewToElements, neighborsToElements, fullToElements } from './elements';
import { graphStore } from './store';
import { useGraphState } from './useGraphStore';
import { Spotlight } from './Spotlight';
import { Legend } from './Legend';
import { ThemePicker } from './ThemePicker';
import { ObjectiveBar } from './ObjectiveBar';
import { FreshnessBanner } from './FreshnessBanner';
import { ZModePicker } from './ZModePicker';
import { HeroToggle } from './HeroToggle';
import { hasWebGL, WEBGL_UNAVAILABLE_MESSAGE, type ContextGetter } from './three/webgl';
import type { CameraRequest, LandscapeProps } from './three/Landscape';
import { Drawer } from './Drawer';
import type { GraphFull, GraphNeighborsJson, GraphOverview } from '../../lib/types';

/** One typed bridge from theme chrome tokens to inherited CSS variables. The
 * named Riverbed surfaces consume these variables; none chooses a theme id. */
export interface GraphChromeStyle extends CSSProperties {
  '--graph-panel': string;
  '--graph-border': string;
  '--graph-accent': string;
  '--graph-text': string;
  '--graph-text-dim': string;
}

export function graphChromeStyle(theme: GraphTheme): GraphChromeStyle {
  return {
    background: theme.background.base,
    '--graph-panel': theme.chrome.panel,
    '--graph-border': theme.chrome.border,
    '--graph-accent': theme.chrome.accent,
    '--graph-text': theme.chrome.text,
    '--graph-text-dim': theme.chrome.textDim,
  };
}

/** One epoch for every asynchronous mutation of the graph/store/canvas. A
 * project change invalidates the epoch; a later request supersedes an earlier
 * one even within the same project. */
export interface GraphRequestEpoch {
  begin(): number;
  isCurrent(request: number): boolean;
  invalidate(): void;
}

export function createGraphRequestEpoch(): GraphRequestEpoch {
  let current = 0;
  return {
    begin: () => { current += 1; return current; },
    isCurrent: (request) => request === current,
    invalidate: () => { current += 1; },
  };
}

/** Load and commit only while this request still owns the graph epoch. The
 * boolean is load-bearing for promotion: a stale expansion must not set heart. */
export async function runGraphRequest<T>(
  epoch: GraphRequestEpoch,
  load: () => Promise<T>,
  apply: (value: T) => void,
  onCurrentError: () => void = () => {},
): Promise<boolean> {
  const request = epoch.begin();
  try {
    const value = await load();
    if (!epoch.isCurrent(request)) return false;
    apply(value);
    return true;
  } catch {
    if (epoch.isCurrent(request)) onCurrentError();
    return false;
  }
}

export function LandscapeChunkFailure({ onFailure }: LandscapeProps) {
  useEffect(() => { onFailure(WEBGL_UNAVAILABLE_MESSAGE); }, [onFailure]);
  // An empty fragment, not null: React.lazy infers its generic from the first
  // branch (Landscape returns JSX.Element), so a null-returning fallback does
  // not unify. Both render nothing.
  return <></>;
}

const Landscape = lazy(async () => {
  try {
    const mod = await import('./three/Landscape');
    return { default: mod.Landscape };
  } catch {
    return { default: LandscapeChunkFailure };
  }
});

export interface WebGLGate {
  webglOk: boolean;
  notice: string | null;
  clearNotice(): void;
  fail(why: string): void;
}

export function useWebGLGate(
  view: '2d' | '3d',
  setView: (view: '2d' | '3d') => void,
  getContext?: ContextGetter,
): WebGLGate {
  const toast = useToast();
  const [webglOk, setWebglOk] = useState(() => hasWebGL(getContext));
  const [notice, setNotice] = useState<string | null>(null);
  const fail = useCallback((why: string) => {
    setWebglOk(false);
    setNotice(why);
    setView('2d');
    toast.push('error', why);
  }, [setView, toast]);
  useEffect(() => {
    // Initial capability absence is explanatory, not exceptional: do not toast.
    if (!webglOk && view === '3d') {
      setNotice(WEBGL_UNAVAILABLE_MESSAGE);
      setView('2d');
    } else if (!webglOk) setNotice(WEBGL_UNAVAILABLE_MESSAGE);
  }, [webglOk, view, setView]);
  return { webglOk, notice, clearNotice: () => setNotice(null), fail };
}

export interface HeroState {
  elements: ElementDefinition[];
  truncated: GraphFull['truncated'];
}

export interface HeroMode {
  hero: HeroState | null;
  heroLoading: boolean;
  /** Non-null whenever EITHER axis was capped (Plan 47's cap note, carried
   * through unchanged): a note that only covered
   * nodes would render nothing when the edge cap bites alone, which is the
   * silence on exactly the axis the server measures most carefully. */
  truncatedNote: string | null;
  enterHero: () => Promise<void>;
  leaveHero: () => void;
}

export function useHeroMode(
  view: '2d' | '3d',
  setView: (view: '2d' | '3d') => void,
  webglOk: boolean,
  notifyError: (message: string) => void,
  fetchFull: () => Promise<GraphFull>,
  /** The selected project. Hero is a per-project overlay: a change here clears
   * it, so `renderedElements` can never outlive the project it was fetched for
   * (review finding 2b9e2837). */
  project: string,
  /** The component's ONE request epoch. The hero fetch rides it like every
   * other graph read, so a slower prior project's /graph/full cannot install
   * itself after the switch (2b9e2837). */
  epoch: GraphRequestEpoch,
  /** The store's Z-mode and its setter (plan 48b R1/R2): entry remembers the
   * current mode and sets `free`; every exit restores what was remembered. */
  zMode: ZMode,
  setZMode: (mode: ZMode) => void,
  /** The sole camera-request producer (R3). Entry asks for a settle-deferred
   * fit; every exit cancels it with `null`, because hero can close while the
   * landscape stays mounted and a stale fit would land on the exploration
   * cloud the user just returned to. */
  requestCamera: (target: 'fit' | ObjectivePower | null, onSettle?: boolean) => void,
): HeroMode {
  const [hero, setHero] = useState<HeroState | null>(null);
  const [heroLoading, setHeroLoading] = useState(false);
  // The Z-mode active BEFORE entry, or null outside hero. A mode picked inside
  // hero is deliberately not written here (R2).
  const rememberedRef = useRef<ZMode | null>(null);

  // ONE exit path for every route out of hero: clear the overlay, disarm any
  // pending fit, and restore the remembered Z-mode (R2).
  const exitHero = useCallback(() => {
    setHero(null);
    requestCamera(null);
    const remembered = rememberedRef.current;
    rememberedRef.current = null;
    if (remembered !== null) setZMode(remembered);
  }, [requestCamera, setZMode]);
  const exitRef = useRef(exitHero);
  exitRef.current = exitHero;

  // The capability-absent WebGL route (R2): however WebGL went away — probe
  // failure at mount or a later fail() — webglOk flips false and hero state
  // clears HERE, where setHero is in scope.
  useEffect(() => {
    if (!webglOk) exitRef.current();
  }, [webglOk]);

  // A project switch resets the store (loadLanding) but the hero overlay lives
  // here, so it must reset here too (finding 2b9e2837).
  useEffect(() => {
    exitRef.current();
  }, [project]);

  // Hero implies 3D (locked decision 1) in BOTH directions (finding 3f0088f3).
  useEffect(() => {
    if (view === '2d') exitRef.current();
  }, [view]);

  // The FIFTH route out of hero: the Graph tab UNMOUNTS. `Shell.tsx:127`
  // renders <Graph /> from inside a switch, so changing tabs destroys this
  // hook and its rememberedRef, while `graphStore` — a module singleton
  // (`store.ts:153`) — keeps `zMode: 'free'` for the rest of the session. The
  // four effects above cannot see that route: they run inside a component that
  // no longer exists. Restore from the unmount cleanup, and touch the STORE
  // only — setHero on an unmounting component is a no-op. The
  // setter is read through a ref and the deps are EMPTY on purpose: a
  // dependency on `setZMode` would re-run the effect whenever its identity
  // changed and fire this cleanup while hero is still open.
  const setZModeRef = useRef(setZMode);
  setZModeRef.current = setZMode;
  useEffect(() => () => {
    const remembered = rememberedRef.current;
    if (remembered === null) return;
    rememberedRef.current = null;
    setZModeRef.current(remembered);
  }, []);

  const enterHero = useCallback(async () => {
    setHeroLoading(true);
    let failure: string | null = null;
    try {
      await runGraphRequest(
        epoch,
        async () => {
          try {
            return await fetchFull();
          } catch (err) {
            failure = err instanceof Error ? err.message : 'could not load the full graph';
            throw err;
          }
        },
        (full) => {
          setHero({ elements: fullToElements(full), truncated: full.truncated });
          // Hero implies 3D (locked decision 1) and opens as the free cloud
          // (plan 48b R1): remember the mode we are leaving so exit restores it.
          if (rememberedRef.current === null) rememberedRef.current = zMode;
          setZMode('free');
          requestCamera('fit', true);
          if (view !== '3d') setView('3d');
        },
        // A failed or superseded entry remembers nothing and arms nothing.
        () => notifyError(failure ?? 'could not load the full graph'),
      );
    } finally {
      setHeroLoading(false);
    }
  }, [epoch, fetchFull, notifyError, requestCamera, setView, setZMode, view, zMode]);

  const leaveHero = useCallback(() => exitRef.current(), []);

  const truncatedNote = useMemo(() => {
    if (hero === null) return null;
    const t = hero.truncated;
    if (!t.nodes && !t.edges) return null;
    const nodeCount = hero.elements.filter((e) => e.data?.source == null).length;
    const edgeCount = hero.elements.length - nodeCount;
    const parts = [
      t.nodes ? `${nodeCount.toLocaleString()} of ${t.nodeTotal.toLocaleString()} nodes` : null,
      t.edges ? `${edgeCount.toLocaleString()} of ${t.edgeTotal.toLocaleString()} edges` : null,
    ];
    return parts.filter((part) => part !== null).join(' · ');
  }, [hero]);

  return { hero, heroLoading, truncatedNote, enterHero, leaveHero };
}

/** R9 routing, exported and pure: which canvas answers the PNG request is
 * decided by the live view, and this is the one place that decides it. */
export function routeExportPng(
  view: '2d' | '3d',
  landscapeExport: (() => string | null) | null,
  cyExport: (() => string | null) | null,
): string | null {
  const exporter = view === '3d' ? landscapeExport : cyExport;
  return exporter === null ? null : exporter();
}

/** R3 routing, the mirror of routeExportPng: which renderer answers Fit is
 * decided by the live view, in one place. */
export function routeFit(
  view: '2d' | '3d',
  landscapeFit: (() => void) | null,
  cyFit: (() => void) | null,
): void {
  const fit = view === '3d' ? landscapeFit : cyFit;
  if (fit !== null) fit();
}

export function Graph() {
  const { project } = useProjects();
  const { settings, setSetting } = useSettings();
  const state = useGraphState();
  const theme = themeById(state.themeId);

  const cyRef = useRef<HTMLDivElement>(null);
  const currentsRef = useRef<HTMLCanvasElement>(null);
  const ctrlRef = useRef<CanvasController | null>(null);
  const currentsCtrlRef = useRef<CurrentsController | null>(null);
  const lastSelectedRef = useRef<string | null>(null);
  const traceFromRef = useRef<string | null>(null);
  const requestEpochRef = useRef(createGraphRequestEpoch());
  const landscapeExportRef = useRef<(() => string | null) | null>(null);
  // R3: the ONE producer of camera requests. `null` cancels a request still
  // waiting on the engine. The id counter lives in a ref, NOT in the request
  // state, so cancelling never rewinds it: Plan 48b-1's landscape ignores any
  // id it has already executed, and a counter that restarted at 1 after a
  // cancel would be silently swallowed for the rest of the session.
  const cameraRequestIdRef = useRef(0);
  const [cameraRequest, setCameraRequest] = useState<CameraRequest | null>(null);
  // What the objective bar highlights in 3D. Written in ONE place — inside
  // requestCamera below, on the move path only — and read in one, the bar. It
  // gates no camera move, so unlike the design this replaced it can never
  // swallow a request; the worst it can do is look stale. Two producers of
  // that staleness, both accepted (finding 7c1e70c3): a hand-orbit, and a
  // hero entry cancelled inside the settle window — the highlight is written
  // when a request is CONSTRUCTED, but hero's fit is settle-deferred, so
  // exiting before the engine stops leaves 4× lit with the camera unmoved.
  //
  // Deliberately NOT derived from `cameraRequest`: a cancel nulls that request
  // without moving the camera, so a derived highlight would snap back to 10×
  // on every hero exit while the camera stayed exactly where it was.
  const [cameraObjective, setCameraObjective] = useState<ObjectivePower>(DEFAULT_OBJECTIVE);
  const requestCamera = useCallback((target: 'fit' | ObjectivePower | null, onSettle = false): void => {
    if (target === null) { setCameraRequest(null); return; }
    setCameraObjective(target === 'fit' ? 4 : target);   // a fit IS the 4× frame
    cameraRequestIdRef.current += 1;
    setCameraRequest({ target, onSettle, id: cameraRequestIdRef.current });
  }, []);

  // A camera request is a 3D concept. Leaving the landscape drops any
  // outstanding one, so returning to 3D later never replays a stale command
  // (Plan 48b-1 R5). Without this, picking 40× in 2D and then switching to 3D
  // would move the camera the moment the landscape mounted.
  useEffect(() => {
    if (state.view !== '3d' && cameraRequest !== null) requestCamera(null);
  }, [state.view, cameraRequest, requestCamera]);

  /** One reusable reset-to-landing path for project changes and ⌂ (old A3/R5).
   * A request generation prevents a slower prior project from overwriting the
   * current one. resetToLanding clears expansion, selection and filters. */
  const loadLanding = useCallback(async (): Promise<void> => {
    const ctrl = ctrlRef.current;
    if (!ctrl || !project) return;
    graphStore.setStatus('loading');
    graphStore.setFreshness(null);
    await runGraphRequest(
      requestEpochRef.current,
      () => apiGet<{ overview: GraphOverview }>('/graph/overview'),
      (r) => {
      const els = overviewToElements(r.overview);
      graphStore.setFreshness(r.overview.freshness ?? null);
      graphStore.resetToLanding(els);
      ctrl.setElements(els);
      ctrl.setHeart(graphStore.getSnapshot().heartId);
      currentsCtrlRef.current?.setOverview(r.overview);
      },
      () => graphStore.setStatus('empty'),
    );
  }, [project]);

  /** Fetch a node's neighborhood and merge its authoritative element projection
   * into both the store and the 2D render target. */
  const expand = useCallback(async (id: string): Promise<boolean> => {
    const ctrl = ctrlRef.current;
    if (!ctrl || !project) return false;
    return runGraphRequest(
      requestEpochRef.current,
      () => apiGet<{ neighbors: GraphNeighborsJson }>('/graph/neighbors', { id, format: 'json', depth: 1 }),
      (r) => {
      const els = neighborsToElements(r.neighbors);
      graphStore.mergeElements(els);
      ctrl.merge(els);
      ctrl.setHiddenKinds(graphStore.getSnapshot().hiddenKinds);
      currentsCtrlRef.current?.redraw();
      },
    );
  }, [project]);

  /** Double-click: this node becomes the heart AND its neighborhood is pulled in
   * (spec §3.3 — re-centering subsumes the old expand gesture). */
  const promote = useCallback(async (id: string) => {
    if (!(await expand(id))) return;
    graphStore.setHeart(id);
    ctrlRef.current?.setHeart(id);
  }, [expand]);

  // The canvas registers once, but project may be selected asynchronously after
  // that mount. Delegate through a live ref so promotion never keeps the first
  // render's empty-project closure.
  const promoteRef = useRef(promote);
  promoteRef.current = promote;

  const pickFromSpotlight = useCallback(async (id: string) => {
    const ctrl = ctrlRef.current;
    if (!ctrl) return;
    // A landing node is already drawable: select/focus it without expanding.
    // This preserves the semantic distinction that double-click (promotion)
    // pulls in its neighborhood. A search hit outside the loaded set must be
    // expanded once before it can be selected on either renderer.
    if (graphNodeFacts(graphStore.getSnapshot().elements, id) === null) {
      if (!(await expand(id))) return;
    }
    graphStore.select(id);
    ctrlRef.current?.focusNode(id);
  }, [expand]);

  // Mount cytoscape + currents once.
  useEffect(() => {
    if (!cyRef.current || !currentsRef.current) { graphStore.setStatus('nocy'); return; }
    const mountTheme = themeById(graphStore.getSnapshot().themeId);
    const ctrl = createCanvas(cyRef.current, mountTheme);
    const currents = createCurrents(ctrl.cy, currentsRef.current, underlaySpecFromTheme(mountTheme));
    ctrlRef.current = ctrl;
    currentsCtrlRef.current = currents;

    ctrl.onNodeSelect((id) => {
      if (id == null) { graphStore.select(null); return; }
      const prev = lastSelectedRef.current;
      if (prev && prev !== id) traceFromRef.current = prev;
      lastSelectedRef.current = id;
      graphStore.select(id);
    });
    ctrl.onNodePromote((id) => { void promoteRef.current(id); });
    ctrl.onObjectiveChange((power) => { graphStore.setObjective(power); });
    ctrl.onZoomChange((zoom) => { graphStore.setZoom(zoom); });

    // Re-fit when the container resizes — handles the 0→full first paint that
    // lesson 64642d21 records (cytoscape caches viewport dimensions at init).
    const ro = new ResizeObserver(() => { ctrl.resize(); currents.redraw(); });
    ro.observe(cyRef.current);

    return () => {
      ro.disconnect();
      currents.destroy();
      ctrl.destroy();
      ctrlRef.current = null;
      currentsCtrlRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Landing load whenever the project changes; ⌂ calls this exact same path.
  useEffect(() => {
    void loadLanding();
    return () => { requestEpochRef.current.invalidate(); };
  }, [loadLanding]);

  // Plan 30's settings context is the only persistence owner. It also performs
  // optimistic rollback; this sync effect restores the local view if a save
  // fails. The graph never touches browser storage or a settings endpoint.
  useEffect(() => {
    graphStore.setTheme(settings['graph.theme']);
  }, [settings]);

  const pickTheme = useCallback((id: ThemeId) => {
    graphStore.setTheme(id);
    void setSetting('graph.theme', id);
  }, [setSetting]);

  // Theme switch re-renders from the store — never refetches (spec §3.5).
  useEffect(() => {
    ctrlRef.current?.setTheme(theme);
    currentsCtrlRef.current?.setTheme(underlaySpecFromTheme(theme));
  }, [theme]);

  // Both visual layers receive pulse membership from the same store projection;
  // neither renderer is allowed to become a second recency authority.
  useEffect(() => {
    const ids = theme.pulse ? recentNodeIds(state.elements, Date.now()) : new Set<string>();
    currentsCtrlRef.current?.setPulseIds(ids);
  }, [theme, state.elements]);

  useEffect(() => {
    ctrlRef.current?.setObjective(state.objective);
  }, [state.objective]);

  // Hidden kinds are store-authoritative. Re-apply after every filter change
  // and element merge so newly loaded 2D nodes cannot escape the filter.
  useEffect(() => {
    ctrlRef.current?.setHiddenKinds(state.hiddenKinds);
  }, [state.hiddenKinds, state.elements]);

  // THE cross-view selection path (R1/R8). The store is the only authority: 2D
  // clicks and 3D clicks both write `selectedId`, and this ONE effect pushes it
  // back into cytoscape. Without it, selecting in 3D and returning to 2D left
  // the canvas with nothing visually selected while the drawer showed a node —
  // the two views disagreeing about the same state, which is exactly what R1
  // exists to make impossible. Guarded against feedback loops: cytoscape's own
  // select/unselect handler writes the same value, so re-applying an already-
  // selected node is a no-op.
  // STORE_TO_2D_SELECTION_BEGIN — the permanent seam test requires every
  // programmatic Cytoscape select/unselect operation to remain in this block.
  useEffect(() => {
    const cy = ctrlRef.current?.cy;
    if (!cy) return;
    const wanted = state.selectedId;
    const current = cy.$(':selected');
    if (wanted === null) {
      if (current.length > 0) current.unselect();
      return;
    }
    if (current.length === 1 && current[0].id() === wanted) return;
    current.unselect();
    const node = cy.getElementById(wanted);
    if (!node.empty()) node.select();
  }, [state.selectedId, state.elements]);
  // STORE_TO_2D_SELECTION_END

  const webgl = useWebGLGate(state.view, graphStore.setView);
  const toast = useToast();
  const notifyHeroError = useCallback(
    (message: string) => toast.push('error', message),
    [toast],
  );
  const fetchFullGraph = useCallback(
    () => apiGet<{ full: GraphFull }>('/graph/full').then((r) => r.full),
    [],
  );
  const heroMode = useHeroMode(
    state.view, graphStore.setView, webgl.webglOk, notifyHeroError, fetchFullGraph,
    project, requestEpochRef.current, state.zMode, graphStore.setZMode, requestCamera,
  );

  // THE seam. Every consumer of "what is on screen" reads this, never
  // state.elements directly, so the landscape and the Z-mode availability can
  // never disagree about which graph is being rendered (R3).
  const renderedElements = heroMode.hero !== null ? heroMode.hero.elements : state.elements;

  // R7 — one failure path, not two: hero clears in FRONT of the existing
  // hand-back, which stays byte-for-byte unchanged.
  const onLandscapeFailure = useCallback((why: string) => {
    heroMode.leaveHero();   // never strand the user on a dead hero canvas
    webgl.fail(why);        // the existing hand-back, byte-for-byte unchanged
  }, [heroMode.leaveHero, webgl.fail]);

  const zNodes: ZNode[] = renderedElements
    .filter((e) => e.data != null && e.data.id != null && e.data.source == null)
    .map((e) => ({
      id: String(e.data?.id),
      kind: String(e.data?.kind ?? 'unknown'),
      lastTouched: typeof e.data?.lastTouched === 'string' ? e.data.lastTouched : null,
      confidence: typeof e.data?.confidence === 'number' ? e.data.confidence : null,
    }));
  const availability = zModeAvailability(zNodes);

  // The DETAIL lookup reads what is drawn (clicking a hero node opens its real
  // facts); the HEART lookup stays on the store — the heart is a landing-set
  // concept hero mode neither selects nor moves.
  const detail = state.selectedId ? graphNodeFacts(renderedElements, state.selectedId) : null;
  const counts = graphKindCounts(renderedElements);
  const heart = state.heartId ? graphNodeFacts(state.elements, state.heartId) : null;

  function exportPng() {
    const ctrl = ctrlRef.current;
    const uri = routeExportPng(
      state.view,
      landscapeExportRef.current,
      ctrl === null ? null : () => ctrl.exportPng() ?? null,
    );
    if (!uri) return;
    const a = document.createElement('a');
    a.href = uri;
    a.download = `mai-graph-${project || 'graph'}.png`;
    a.click();
  }

  return (
    <div
      className={'relative grid h-full w-full overflow-hidden ' + (detail
        ? 'min-[900px]:grid-cols-[13rem_minmax(0,1fr)_24rem]'
        : 'min-[900px]:grid-cols-[13rem_minmax(0,1fr)]')}
      style={graphChromeStyle(theme)}
      data-graph-shell="riverbed"
      data-graph-status={state.status}
      data-node-count={renderedElements.filter((e) => e.data?.source == null).length}
      data-visible-node-count={visibleElements(renderedElements, state.hiddenKinds).filter((e) => e.data?.source == null).length}
      data-theme={state.themeId}
      data-view={state.view}
      data-project={project}
      data-selected={state.selectedId ?? ''}
      data-heart={state.heartId ?? ''}
      data-objective={state.objective}
      data-zoom={state.zoom.toFixed(ZOOM_PRECISION)}
    >
      {/* Theme-neutral Riverbed control bank. This is local graph navigation,
          inside the existing app Shell/Nav — never a second app sidebar. */}
      <aside
        data-graph-controls="desktop"
        className="relative z-30 hidden min-w-0 flex-col border-r border-[var(--graph-border)] bg-[var(--graph-panel)] p-4 text-[var(--graph-text)] min-[900px]:flex"
      >
        <p className="text-[0.62rem] font-semibold uppercase tracking-[0.16em] text-[var(--graph-text-dim)]">Project</p>
        <div className="mt-2 rounded-lg border border-[var(--graph-border)] bg-[var(--graph-panel)] p-3">
          <p className="truncate text-sm font-semibold text-[var(--graph-text)]">{project || 'No project'}</p>
          <p className="mt-1 text-[0.68rem] text-[var(--graph-text-dim)]">{counts.size} kinds · {state.elements.filter((e) => e.data?.source == null).length} loaded nodes</p>
        </div>
        <p className="mb-2 mt-6 text-[0.62rem] font-semibold uppercase tracking-[0.16em] text-[var(--graph-text-dim)]">Currents</p>
        {state.status === 'ready' && (
          <div data-graph-filter-bank="desktop" className="[&>div]:static [&>div]:max-w-none [&>div]:border-0 [&>div]:bg-transparent [&>div]:p-0">
            <Legend
              counts={counts}
              hidden={state.hiddenKinds}
              onToggle={(kind) => {
                graphStore.toggleKind(kind);
                currentsCtrlRef.current?.redraw();
              }}
              onShowAll={() => {
                graphStore.showAllKinds();
                currentsCtrlRef.current?.redraw();
              }}
            />
          </div>
        )}
        <p className="mb-2 mt-6 text-[0.62rem] font-semibold uppercase tracking-[0.16em] text-[var(--graph-text-dim)]">Appearance</p>
        <ThemePicker active={state.themeId} onPick={pickTheme} />
      </aside>

      <section data-graph-canvas-region className="relative min-w-0 overflow-hidden">
        <canvas ref={currentsRef} className="pointer-events-none absolute inset-0 z-0" />
        {/* cytoscape forces its container to position:relative, so fill via h/w-full
            in normal flow rather than absolute inset-0 (lesson 64642d21). */}
        <div ref={cyRef} className="relative z-10 h-full w-full" data-graph-canvas="2d" />
        {state.view === '3d' && (
          <Suspense fallback={null}>
            <Landscape
              elements={renderedElements}
              hiddenKinds={state.hiddenKinds}
              theme={theme}
              zMode={state.zMode}
              selectedId={state.selectedId}
              onSelect={(id) => graphStore.select(id)}
              onFailure={onLandscapeFailure}
              exportRef={landscapeExportRef}
              depthRange={heroMode.hero === null ? DEPTH_SPREAD_MIN : undefined}
              cameraRequest={cameraRequest}
            />
          </Suspense>
        )}

        <Spotlight onPick={pickFromSpotlight} />
        <FreshnessBanner freshness={state.freshness} />

        {/* On narrow screens the control bank collapses onto the canvas rather
            than removing filters or theme choice. */}
        {state.status === 'ready' && (
          <div data-graph-filter-bank="mobile" className="min-[900px]:hidden">
            <Legend
              counts={counts}
              hidden={state.hiddenKinds}
              onToggle={(kind) => {
                graphStore.toggleKind(kind);
                currentsCtrlRef.current?.redraw();
              }}
              onShowAll={() => {
                graphStore.showAllKinds();
                currentsCtrlRef.current?.redraw();
              }}
            />
          </div>
        )}

        <div data-graph-canvas-controls className="absolute right-4 top-4 z-20 flex items-center gap-2">
          <ObjectiveBar
            active={state.view === '3d' ? cameraObjective : state.objective}
            onPick={(power) => { graphStore.setObjective(power); requestCamera(power); }}
            onReset={() => { void loadLanding(); }}
            onFit={() => routeFit(state.view, () => requestCamera('fit'), ctrlRef.current === null ? null : () => ctrlRef.current?.fit())}
          />
          <div className="min-[900px]:hidden">
            <ThemePicker active={state.themeId} onPick={pickTheme} label="graph theme mobile" />
          </div>
          {state.view === '3d' && (
            <ZModePicker active={state.zMode} availability={availability} onPick={(m) => graphStore.setZMode(m)} />
          )}
          <HeroToggle
            active={heroMode.hero !== null}
            loading={heroMode.heroLoading}
            disabled={!webgl.webglOk}
            disabledReason={webgl.webglOk ? null : WEBGL_UNAVAILABLE_MESSAGE}
            truncatedNote={heroMode.truncatedNote}
            onToggle={() => {
              if (heroMode.hero !== null) heroMode.leaveHero();
              else void heroMode.enterHero();
            }}
          />
          <button
            type="button"
            data-view-toggle={state.view}
            data-webgl={webgl.webglOk ? 'ok' : 'unavailable'}
            disabled={!webgl.webglOk}
            aria-describedby={!webgl.webglOk ? 'graph-webgl-notice' : undefined}
            onClick={() => {
              if (state.view === '3d') { webgl.clearNotice(); heroMode.leaveHero(); graphStore.setView('2d'); return; }
              webgl.clearNotice();
              graphStore.setView('3d');
            }}
            className="rounded-md border border-[var(--graph-border)] bg-[var(--graph-panel)] px-3 py-1.5 text-xs text-[var(--graph-text-dim)] backdrop-blur disabled:opacity-35"
          >
            {state.view === '2d' ? '3D' : '2D'}
          </button>
          <button
            type="button"
            onClick={exportPng}
            className="rounded-md border border-[var(--graph-border)] bg-[var(--graph-panel)] px-3 py-1.5 text-xs text-[var(--graph-text-dim)] backdrop-blur transition-colors hover:border-[var(--graph-accent)] hover:text-[var(--graph-text)]"
          >
            ↓ PNG
          </button>
        </div>

        {heart && state.status === 'ready' && (
          <div data-heart-vessels={heart.degree} className="absolute bottom-4 right-4 z-20 rounded-md border border-[var(--graph-border)] bg-[var(--graph-panel)] px-3 py-1.5 text-[0.68rem] text-[var(--graph-text-dim)] backdrop-blur">
            {heart.name} — the heart · {heart.degree} vessels
          </div>
        )}

        {webgl.notice !== null && (
          <div id="graph-webgl-notice" role="status" data-webgl-notice="1"
            className="absolute bottom-16 left-4 z-30 max-w-[60%] rounded-md border border-[var(--graph-border)] bg-[var(--graph-panel)] px-3 py-1.5 text-[0.68rem] text-[var(--graph-text-dim)] backdrop-blur">
            {webgl.notice}
          </div>
        )}

        {state.status === 'loading' && (
          <div className="absolute inset-0 z-20 flex items-center justify-center text-sm text-[var(--graph-text-dim)]">settling the organism…</div>
        )}
        {state.status === 'empty' && (
          <div className="absolute inset-0 z-20 flex items-center justify-center text-center text-sm text-[var(--graph-text-dim)]">
            no graph yet — run: <span className="ml-1 font-mono text-[var(--graph-accent)]">mai graph build --project {project}</span>
          </div>
        )}
      </section>

      {detail && (
        <Drawer
          detail={detail}
          traceFromId={traceFromRef.current}
          isHeart={detail.id === state.heartId}
          vesselCount={detail.degree}
          onExpand={(id) => void expand(id)}
          onClose={() => { graphStore.select(null); }}
        />
      )}
    </div>
  );
}
