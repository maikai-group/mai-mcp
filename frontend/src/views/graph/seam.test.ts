// R2, permanently: graph feature files never create a second persistence
// system, and Graph.tsx is the sole bridge to Plan 30's settings context.
// Committed rather than run once, because the directory keeps growing.
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const BROWSER_STORAGE_RE = /localStorage|sessionStorage/;
const SETTINGS_IMPORT_RE = /from ['"]\.\.\/\.\.\/shell\/settings['"]/;
const THEME_KEY_RE = /['"]graph\.theme['"]/;

const walk = (dir: string): string[] =>
  fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) =>
    e.isDirectory() ? walk(path.join(dir, e.name)) : [path.join(dir, e.name)]);

const sources = (): string[] =>
  walk(here).filter((f) => /\.tsx?$/.test(f) && !/\.test\.tsx?$/.test(f));

describe('R2 — one theme-persistence seam', () => {
  it('forbids browser storage in every graph production file, at any depth', () => {
    const files = sources();
    expect(files.length).toBeGreaterThanOrEqual(3); // never vacuous
    const offenders = files
      .map((f) => path.relative(here, f))
      .filter((rel) => BROWSER_STORAGE_RE.test(fs.readFileSync(path.join(here, rel), 'utf8')));
    expect(offenders).toEqual([]);
  });

  it('allows exactly Graph.tsx to import the shell settings context', () => {
    const consumers = sources()
      .map((f) => path.relative(here, f))
      .filter((rel) => SETTINGS_IMPORT_RE.test(fs.readFileSync(path.join(here, rel), 'utf8')));
    expect(consumers).toEqual(['Graph.tsx']);
    const graph = fs.readFileSync(path.join(here, 'Graph.tsx'), 'utf8');
    expect(graph).toMatch(/useSettings/);
    expect(graph).toMatch(/settings\['graph\.theme'\]/);
    expect(graph).toMatch(/setSetting\('graph\.theme'/);
    // Plan 47: the HEART lookup still reads the store (the heart is a landing-set
    // concept hero mode neither selects nor moves); the DETAIL lookup moved to
    // renderedElements. A substring pin matches either site — this anchors the
    // heart one. Do not "fix" the asymmetry.
    expect(graph).toContain('graphNodeFacts(state.elements');
    expect(graph).toContain('graphKindCounts(renderedElements)');
    // Plan 47: recentNodeIds feeds the 2D currents underlay, which renders from
    // cytoscape's own elements — deliberately NOT the hero set (locked decision 3).
    expect(graph).toContain('recentNodeIds(state.elements');
    expect(graph).not.toMatch(/readDetail|\.kindCounts\(|\.heartDegree\(|\.recentIds\(|node\.data\(\{/);

    const selection = graph.match(
      /\/\/ STORE_TO_2D_SELECTION_BEGIN([\s\S]*?)\/\/ STORE_TO_2D_SELECTION_END/,
    );
    expect(selection).not.toBeNull();
    if (selection === null) throw new Error('store-to-2D selection block is absent');
    expect(selection[1]).toMatch(/current\.unselect\(\)/);
    expect(selection[1]).toMatch(/node\.select\(\)/);
    const outsideSelection = graph.replace(selection[0], '');
    expect(outsideSelection).not.toMatch(/\.(?:select|unselect)\(\)/);
    expect(graph).toMatch(/pickFromSpotlight[\s\S]*graphStore\.select\(id\)/);
    expect(graph).toMatch(/onClose=\{\(\) => \{ graphStore\.select\(null\); \}\}/);
    // Plan 48a R3: exploration's depth range is 400 by construction, however
    // far the user expands; only hero lets the range follow the node count.
    // The pin carries the WHOLE conditional, not just the prop name, which is
    // what makes it redden on both mutants: G1 drops the prop, G2 inverts the
    // predicate. Anchored on the newline and indentation that precede a JSX
    // attribute, per this file's convention (Plan 47's three pins at :44-48);
    // at THIS site the anchor is belt-and-braces, because no Graph.tsx
    // attribute name ends in `depthRange`.
    expect(graph).toMatch(/\n\s+depthRange=\{heroMode\.hero === null \? DEPTH_SPREAD_MIN : undefined\}/);
    // Plan 48b R1/R3: every camera move reaches the landscape ONLY through
    // this mount prop, and Fit reaches it only through this route call (Plan
    // 48a's depthRange pin sits beside them, untouched). Every pure piece
    // behind them is unit-pinned, so the composition is pinned here. The prop
    // pin is anchored on the newline and indentation that precede a JSX
    // attribute, NOT a bare substring: the root div already carries
    // `data-objective={state.objective}` (Graph.tsx:516), and a bare
    // toContain("objective={state.objective}") is satisfied by it, so a pin
    // written that way could never fail. Verified at plan time: every regex
    // below is false against Graph.tsx at HEAD and true once Step 2 is applied.
    expect(graph).toMatch(/\n\s+cameraRequest=\{cameraRequest\}/);
    expect(graph).toContain("routeFit(state.view, () => requestCamera('fit'),");
    // R3's producer census, structurally. The picker must forward the power it
    // was HANDED, not a constant — the argument is the part no other gate in
    // this plan observes, and mutant H15 is what makes that concrete. This is a
    // source pin and is labelled as one: reaching the handler behaviourally
    // would mean mounting the whole Graph tab with a stubbed landscape.
    expect(graph).toMatch(/onPick=\{\(power\) => \{ graphStore\.setObjective\(power\); requestCamera\(power\); \}\}/);
    // The bar follows the camera in 3D and the store in 2D.
    expect(graph).toContain("active={state.view === '3d' ? cameraObjective : state.objective}");
    // The id counter must live in a ref that a cancel cannot rewind. Derived
    // from the request state it would restart at 1 after every `null`, and
    // Plan 48b-1's landscape ignores any id it has already executed — so the
    // camera would go quiet for the rest of the session (mutant H11).
    expect(graph).toContain('const cameraRequestIdRef = useRef(0);');
    // The highlight is written on the MOVE path only, from the target it was
    // handed: a cancel must not touch it (H17) and a constant must not stand
    // in for the target (H18).
    expect(graph).toContain("setCameraObjective(target === 'fit' ? 4 : target);");
  });

  it('R3: no store-objective path to the camera, and no state-derived request id', () => {
    const graph = fs.readFileSync(path.join(here, 'Graph.tsx'), 'utf8');
    // The absence R3 actually guarantees: the store value cytoscape's zoom band
    // rewrites must never become a camera request. Pinned STRUCTURALLY on
    // purpose — R3's claim is that no path EXISTS, and only a source pin can
    // observe an absence. A behavioural case could show at most that one known
    // path does not fire, which is exactly the reasoning that failed three
    // review passes on the predecessor plan.
    expect(graph).not.toMatch(/requestCamera\(state\.objective\)/);
    // And the id counter must not be derived from the request state, which a
    // cancel would rewind to 0 (mutant H11).
    expect(graph).not.toMatch(/id: \(prev\?\.id \?\? 0\) \+ 1/);
  });

  it('allows exactly Graph.tsx to consume the graph.theme key', () => {
    const consumers = sources()
      .map((f) => path.relative(here, f))
      .filter((rel) => THEME_KEY_RE.test(fs.readFileSync(path.join(here, rel), 'utf8')));
    expect(consumers).toEqual(['Graph.tsx']);
  });

  it('keeps themes.ts inert data (D3)', () => {
    const themes = fs.readFileSync(path.join(here, '..', '..', 'lib', 'themes.ts'), 'utf8');
    expect(BROWSER_STORAGE_RE.test(themes)).toBe(false);
    expect(SETTINGS_IMPORT_RE.test(themes)).toBe(false);
    expect(THEME_KEY_RE.test(themes)).toBe(false);
  });

  it('threads every chrome token into inherited variables at the Graph root', () => {
    const graph = fs.readFileSync(path.join(here, 'Graph.tsx'), 'utf8');
    for (const token of ['panel', 'border', 'accent', 'text', 'textDim']) {
      expect(graph).toContain(`theme.chrome.${token}`);
    }
    for (const variable of ['panel', 'border', 'accent', 'text', 'text-dim']) {
      expect(graph).toContain(`--graph-${variable}`);
    }
    expect(graph).toMatch(/style=\{graphChromeStyle\(theme\)\}/);
  });

  it('keeps every named graph-chrome surface variable-backed', () => {
    const required: Record<string, readonly string[]> = {
      'Graph.tsx': ['panel', 'border', 'accent', 'text', 'text-dim'],
      'Legend.tsx': ['panel', 'border', 'accent', 'text-dim'],
      'Drawer.tsx': ['panel', 'border', 'accent', 'text', 'text-dim'],
      'Spotlight.tsx': ['panel', 'border', 'accent', 'text', 'text-dim'],
      'ThemePicker.tsx': ['panel', 'border', 'text-dim'],
      'ObjectiveBar.tsx': ['border', 'accent', 'text-dim'],
      'FreshnessBanner.tsx': ['panel', 'border', 'text-dim'],
      'HeroToggle.tsx': ['border', 'accent', 'text-dim'],
    };
    const fixedChrome = /\b(?:bg|border)-deep-\d|text-ink(?:-(?:dim|faint))?|(?:text|border)-flow-\d/;
    for (const [rel, variables] of Object.entries(required)) {
      const body = fs.readFileSync(path.join(here, rel), 'utf8');
      for (const variable of variables) expect(body).toContain(`var(--graph-${variable})`);
      expect(body).not.toMatch(fixedChrome);
    }
    const drawer = fs.readFileSync(path.join(here, 'Drawer.tsx'), 'utf8');
    const sharedState = fs.readFileSync(path.join(here, '../../components/ViewHeader.tsx'), 'utf8');
    const prose = fs.readFileSync(path.join(here, '../../components/markdown.css'), 'utf8');
    expect(drawer).toContain('className="graph-prose"');
    expect(drawer).toContain('className="text-[var(--graph-text-dim)]"');
    expect(sharedState).toMatch(/PanelState[\s\S]*className\?: string/);
    expect(prose).toMatch(/\.mai-prose\.graph-prose\s*\{[\s\S]*--color-ink:\s*var\(--graph-text\)/);
    expect(prose).toMatch(/\.mai-prose\.graph-prose\s*\{[\s\S]*--color-deep-800:\s*var\(--graph-panel\)/);
    // Task 8 creates this selector after the test first lands. Once present it
    // enters the same invariant automatically; Task 7 remains runnable before it exists.
    const zPicker = path.join(here, 'ZModePicker.tsx');
    if (fs.existsSync(zPicker)) {
      const body = fs.readFileSync(zPicker, 'utf8');
      for (const variable of ['border', 'accent', 'text-dim']) {
        expect(body).toContain(`var(--graph-${variable})`);
      }
      expect(body).not.toMatch(fixedChrome);
    }
  });
});
