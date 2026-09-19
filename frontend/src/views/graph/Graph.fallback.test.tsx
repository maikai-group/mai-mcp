import { useCallback, useState } from 'react';
import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, fireEvent, cleanup } from '@testing-library/react';
import { themeById } from '../../lib/themes';
import { ToastProvider } from '../../shell/toast';
import { LandscapeChunkFailure, createGraphRequestEpoch, useHeroMode, useWebGLGate, type GraphRequestEpoch } from './Graph';
import { HeroToggle } from './HeroToggle';
import type { GraphFull } from '../../lib/types';
import { WEBGL_UNAVAILABLE_MESSAGE, type ContextGetter } from './three/webgl';
import type { ObjectivePower, ZMode } from './model';

afterEach(cleanup);

function Harness({ getContext }: { getContext: ContextGetter }) {
  const [view, setView] = useState<'2d' | '3d'>('3d');
  const gate = useWebGLGate(view, setView, getContext);
  return (
    <div data-authoritative-view={view} data-webgl-capable={gate.webglOk ? '1' : '0'}>
      {gate.notice !== null && <p role="status">{gate.notice}</p>}
      <button type="button" onClick={() => gate.fail(WEBGL_UNAVAILABLE_MESSAGE)}>import failure</button>
      <button type="button" onClick={() => gate.fail(WEBGL_UNAVAILABLE_MESSAGE)}>context loss</button>
    </div>
  );
}

const renderHarness = (getContext: ContextGetter) => render(
  <ToastProvider><Harness getContext={getContext} /></ToastProvider>,
);

describe('Graph WebGL fallback integration', () => {
  it('routes a lazy Landscape chunk failure through the same callback', async () => {
    const onFailure = vi.fn();
    render(<LandscapeChunkFailure elements={[]} hiddenKinds={[]}
      theme={themeById('organism')} zMode="time" selectedId={null}
      onSelect={() => {}} onFailure={onFailure} />);
    await vi.waitFor(() => expect(onFailure).toHaveBeenCalledWith(WEBGL_UNAVAILABLE_MESSAGE));
  });

  it('forces a stale 3D state to 2D when the sole initial probe fails', async () => {
    renderHarness(() => null);
    const status = await screen.findByRole('status');
    expect(status.textContent).toBe(WEBGL_UNAVAILABLE_MESSAGE);
    expect(status.parentElement?.getAttribute('data-authoritative-view')).toBe('2d');
    expect(status.parentElement?.getAttribute('data-webgl-capable')).toBe('0');
    expect(screen.queryByRole('button', { name: 'dismiss' })).toBeNull();
  });

  it('forces 2D and toasts after an import failure', () => {
    renderHarness(() => ({}));
    fireEvent.click(screen.getByText('import failure'));
    const statuses = screen.getAllByRole('status');
    expect(statuses.map((status) => status.textContent).every((text) => text?.includes(WEBGL_UNAVAILABLE_MESSAGE))).toBe(true);
    expect(document.querySelector('[data-authoritative-view="2d"]')).toBeTruthy();
    expect(document.querySelector('[data-webgl-capable="0"]')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'dismiss' })).toBeTruthy();
  });

  it('forces 2D and toasts after context loss', () => {
    renderHarness(() => ({}));
    fireEvent.click(screen.getByText('context loss'));
    const statuses = screen.getAllByRole('status');
    expect(statuses.map((status) => status.textContent).every((text) => text?.includes(WEBGL_UNAVAILABLE_MESSAGE))).toBe(true);
    expect(document.querySelector('[data-authoritative-view="2d"]')).toBeTruthy();
    expect(document.querySelector('[data-webgl-capable="0"]')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'dismiss' })).toBeTruthy();
  });
});

function fullPayload(truncated: GraphFull['truncated']): GraphFull {
  return {
    nodes: [
      { id: 'h', kind: 'function', name: 'hub', degree: 3, qualified_name: null, file_path: null, line: null, lastTouched: null, confidence: null, isLanding: 1 },
      { id: 'a', kind: 'function', name: 'a', degree: 1, qualified_name: null, file_path: null, line: null, lastTouched: null, confidence: null, isLanding: 0 },
      { id: 'b', kind: 'function', name: 'b', degree: 1, qualified_name: null, file_path: null, line: null, lastTouched: null, confidence: null, isLanding: 0 },
    ],
    edges: [{ source: 'h', target: 'a', relation: 'calls' }, { source: 'h', target: 'b', relation: 'calls' }],
    truncated,
  };
}

const UNTRUNCATED: GraphFull['truncated'] = { nodes: false, edges: false, nodeTotal: 3, edgeTotal: 2 };

function HeroHarness({ initialView, fetchFull, setView, notifyError, epoch }: {
  initialView: '2d' | '3d';
  fetchFull: () => Promise<GraphFull>;
  setView: (view: '2d' | '3d') => void;
  notifyError: (message: string) => void;
  epoch?: GraphRequestEpoch;
}) {
  const [view, setLocalView] = useState<'2d' | '3d'>(initialView);
  const [webglOk, setWebglOk] = useState(true);
  const [project, setProject] = useState('alpha');
  const [ownEpoch] = useState(() => epoch ?? createGraphRequestEpoch());
  const [zMode, setZMode] = useState<ZMode>('abstraction');
  const [camera, setCamera] = useState<string[]>([]);
  const requestCamera = useCallback((target: 'fit' | ObjectivePower | null, onSettle = false): void => {
    setCamera((prev) => [...prev, target === null ? 'cancel' : `${target}${onSettle ? ':settle' : ''}`]);
  }, []);
  const hero = useHeroMode(view, setView, webglOk, notifyError, fetchFull, project, ownEpoch, zMode, setZMode, requestCamera);
  return (
    <div data-hero-elements={hero.hero === null ? '' : String(hero.hero.elements.length)} data-harness-view={view}
      data-harness-project={project} data-harness-zmode={zMode} data-camera={camera.join(',')}>
      <button type="button" onClick={() => setZMode('time')}>pick time</button>
      <button type="button" onClick={() => setProject('beta')}>switch project</button>
      <button type="button" onClick={() => setLocalView('2d')}>go 2d</button>
      <HeroToggle
        active={hero.hero !== null}
        loading={hero.heroLoading}
        disabled={!webglOk}
        disabledReason={webglOk ? null : WEBGL_UNAVAILABLE_MESSAGE}
        truncatedNote={hero.truncatedNote}
        onToggle={() => { if (hero.hero !== null) hero.leaveHero(); else void hero.enterHero(); }}
      />
      <button type="button" onClick={() => setWebglOk(false)}>lose webgl</button>
    </div>
  );
}

const heroButton = (): Element => {
  const button = document.querySelector('[data-hero-mode]');
  if (button === null) throw new Error('hero toggle is not rendered');
  return button;
};
const heroMode = () => heroButton().getAttribute('data-hero-mode');
const cameraTrace = (): string => document.querySelector('[data-camera]')?.getAttribute('data-camera') ?? '';

describe('hero mode hook (plan 47 Task 5)', () => {
  it('enterHero fetches exactly once and flips the toggle on with the payload rendered', async () => {
    const fetchFull = vi.fn(async () => fullPayload(UNTRUNCATED));
    render(<ToastProvider><HeroHarness initialView="3d" fetchFull={fetchFull} setView={() => {}} notifyError={() => {}} /></ToastProvider>);
    expect(heroMode()).toBe('off');
    fireEvent.click(heroButton());
    await vi.waitFor(() => expect(heroMode()).toBe('on'));
    expect(fetchFull).toHaveBeenCalledTimes(1);
    expect(document.querySelector('[data-hero-elements="5"]')).toBeTruthy(); // 3 nodes + 2 edges
  });

  it('leaveHero clears hero with NO refetch of anything', async () => {
    const fetchFull = vi.fn(async () => fullPayload(UNTRUNCATED));
    render(<ToastProvider><HeroHarness initialView="3d" fetchFull={fetchFull} setView={() => {}} notifyError={() => {}} /></ToastProvider>);
    fireEvent.click(heroButton());
    await vi.waitFor(() => expect(heroMode()).toBe('on'));
    fireEvent.click(heroButton());
    await vi.waitFor(() => expect(heroMode()).toBe('off'));
    expect(fetchFull).toHaveBeenCalledTimes(1);
    expect(document.querySelector('[data-hero-elements=""]')).toBeTruthy();
  });

  it('entering from 2D switches to 3D; entering from 3D leaves the projection alone', async () => {
    const from2d = vi.fn();
    render(<ToastProvider><HeroHarness initialView="2d" fetchFull={async () => fullPayload(UNTRUNCATED)} setView={from2d} notifyError={() => {}} /></ToastProvider>);
    fireEvent.click(heroButton());
    await vi.waitFor(() => expect(from2d).toHaveBeenCalledWith('3d'));
    cleanup();
    const from3d = vi.fn();
    render(<ToastProvider><HeroHarness initialView="3d" fetchFull={async () => fullPayload(UNTRUNCATED)} setView={from3d} notifyError={() => {}} /></ToastProvider>);
    fireEvent.click(heroButton());
    await vi.waitFor(() => expect(heroMode()).toBe('on'));
    expect(from3d).not.toHaveBeenCalled();
  });

  it('renders the truncation note in all four states, including edge-capped alone', async () => {
    const cases: Array<[GraphFull['truncated'], string | null]> = [
      [{ nodes: true, edges: false, nodeTotal: 25_100, edgeTotal: 2 }, '3 of 25,100 nodes'],
      [{ nodes: false, edges: true, nodeTotal: 3, edgeTotal: 60_500 }, '2 of 60,500 edges'],
      [{ nodes: true, edges: true, nodeTotal: 25_100, edgeTotal: 60_500 }, '3 of 25,100 nodes · 2 of 60,500 edges'],
      [UNTRUNCATED, null],
    ];
    for (const [truncated, expected] of cases) {
      cleanup();
      render(<ToastProvider><HeroHarness initialView="3d" fetchFull={async () => fullPayload(truncated)} setView={() => {}} notifyError={() => {}} /></ToastProvider>);
      fireEvent.click(heroButton());
      await vi.waitFor(() => expect(heroMode()).toBe('on'));
      const note = document.querySelector('[data-hero-truncated="1"]');
      if (expected === null) expect(note).toBeNull();
      else expect(note?.textContent).toBe(expected);
    }
  });

  it('a rejected fetch leaves hero off and reports the rejection message', async () => {
    const notifyError = vi.fn();
    render(<ToastProvider><HeroHarness initialView="3d" fetchFull={async () => { throw new Error('graph/full exploded'); }} setView={() => {}} notifyError={notifyError} /></ToastProvider>);
    fireEvent.click(heroButton());
    await vi.waitFor(() => expect(notifyError).toHaveBeenCalledWith('graph/full exploded'));
    expect(heroMode()).toBe('off');
  });

  it('losing WebGL while hero is active clears hero — the capability-absent route (R7)', async () => {
    render(<ToastProvider><HeroHarness initialView="3d" fetchFull={async () => fullPayload(UNTRUNCATED)} setView={() => {}} notifyError={() => {}} /></ToastProvider>);
    fireEvent.click(heroButton());
    await vi.waitFor(() => expect(heroMode()).toBe('on'));
    fireEvent.click(screen.getByText('lose webgl'));
    await vi.waitFor(() => expect(heroMode()).toBe('off'));
    // 7. Refusal at the toggle: disabled, with the reason in `title`.
    const button = heroButton();
    expect(button.hasAttribute('disabled')).toBe(true);
    expect(button.getAttribute('title')).toBe(WEBGL_UNAVAILABLE_MESSAGE);
  });

  it('a project switch clears hero — the overlay never outlives its project (2b9e2837)', async () => {
    const fetchFull = vi.fn(async () => fullPayload(UNTRUNCATED));
    render(<ToastProvider><HeroHarness initialView="3d" fetchFull={fetchFull} setView={() => {}} notifyError={() => {}} /></ToastProvider>);
    fireEvent.click(heroButton());
    await vi.waitFor(() => expect(heroMode()).toBe('on'));
    fireEvent.click(screen.getByText('switch project'));
    await vi.waitFor(() => expect(heroMode()).toBe('off'));
    expect(document.querySelector('[data-harness-project="beta"]')).toBeTruthy();
    expect(document.querySelector('[data-hero-elements=""]')).toBeTruthy();
    expect(fetchFull).toHaveBeenCalledTimes(1);
  });

  it('a hero fetch that resolves after the epoch moved on is dropped, not installed (2b9e2837)', async () => {
    const epoch = createGraphRequestEpoch();
    let resolveFull: (full: GraphFull) => void = () => {};
    const slow = new Promise<GraphFull>((done) => { resolveFull = done; });
    const notifyError = vi.fn();
    render(<ToastProvider><HeroHarness initialView="3d" fetchFull={() => slow} setView={() => {}} notifyError={notifyError} epoch={epoch} /></ToastProvider>);
    fireEvent.click(heroButton());
    await vi.waitFor(() => expect(heroButton().textContent).toBe('loading…'));
    epoch.invalidate(); // the project switched while /graph/full was in flight
    resolveFull(fullPayload(UNTRUNCATED));
    await vi.waitFor(() => expect(heroButton().textContent).toBe('everything'));
    expect(heroMode()).toBe('off');
    expect(notifyError).not.toHaveBeenCalled(); // superseded, not failed
  });

  it('leaving 3D leaves hero — the invariant is symmetric (3f0088f3)', async () => {
    render(<ToastProvider><HeroHarness initialView="3d" fetchFull={async () => fullPayload(UNTRUNCATED)} setView={() => {}} notifyError={() => {}} /></ToastProvider>);
    fireEvent.click(heroButton());
    await vi.waitFor(() => expect(heroMode()).toBe('on'));
    fireEvent.click(screen.getByText('go 2d'));
    await vi.waitFor(() => expect(heroMode()).toBe('off'));
    expect(document.querySelector('[data-harness-view="2d"]')).toBeTruthy();
  });

  it('entry remembers the prior Z-mode, opens free, and arms one fit (plan 48b R1)', async () => {
    render(<ToastProvider><HeroHarness initialView="3d" fetchFull={async () => fullPayload(UNTRUNCATED)} setView={() => {}} notifyError={() => {}} /></ToastProvider>);
    expect(document.querySelector('[data-harness-zmode="abstraction"]')).toBeTruthy();
    fireEvent.click(heroButton());
    await vi.waitFor(() => expect(heroMode()).toBe('on'));
    expect(document.querySelector('[data-harness-zmode="free"]')).toBeTruthy();
    // R1 says hero entry arms EXACTLY ONE fit, so count them rather than
    // matching the suffix: `/fit:settle$/` is satisfied by a trace that armed
    // three, and a re-fit mutant survives all 141 graph tests on it, dying
    // only at the Step 5 census (finding `618ff66d`). An "exactly one" claim
    // asserted by something that cannot count is the species this plan's whole
    // review history is about.
    expect(cameraTrace().split(',').filter((e) => e === 'fit:settle')).toHaveLength(1);
  });

  it('every exit path restores the remembered Z-mode: toggle, 2D, project switch, WebGL loss (plan 48b R2)', async () => {
    const exits: Array<[string, () => void]> = [
      ['toggle', () => fireEvent.click(heroButton())],
      ['go 2d', () => fireEvent.click(screen.getByText('go 2d'))],
      ['switch project', () => fireEvent.click(screen.getByText('switch project'))],
      ['lose webgl', () => fireEvent.click(screen.getByText('lose webgl'))],
    ];
    for (const [, exit] of exits) {
      cleanup();
      render(<ToastProvider><HeroHarness initialView="3d" fetchFull={async () => fullPayload(UNTRUNCATED)} setView={() => {}} notifyError={() => {}} /></ToastProvider>);
      fireEvent.click(heroButton());
      await vi.waitFor(() => expect(heroMode()).toBe('on'));
      expect(document.querySelector('[data-harness-zmode="free"]')).toBeTruthy();
      exit();
      await vi.waitFor(() => expect(heroMode()).toBe('off'));
      expect(document.querySelector('[data-harness-zmode="abstraction"]')).toBeTruthy();
      // Every exit cancels the settle-deferred fit, so it cannot land on the
      // exploration cloud after the Z-mode restore relayouts the graph. All
      // four variants produce the same trace, `cancel,fit:settle,cancel`; the
      // suffix is asserted because the INVARIANT is that an exit ends in a
      // cancel, while the leading element is an artefact of React's mount.
      expect(cameraTrace()).toMatch(/fit:settle,cancel$/);
    }
  });

  it('a mode picked inside hero is not remembered; a failed entry remembers nothing (plan 48b R2)', async () => {
    render(<ToastProvider><HeroHarness initialView="3d" fetchFull={async () => fullPayload(UNTRUNCATED)} setView={() => {}} notifyError={() => {}} /></ToastProvider>);
    fireEvent.click(heroButton());
    await vi.waitFor(() => expect(heroMode()).toBe('on'));
    fireEvent.click(screen.getByText('pick time'));
    expect(document.querySelector('[data-harness-zmode="time"]')).toBeTruthy();
    fireEvent.click(heroButton());
    await vi.waitFor(() => expect(heroMode()).toBe('off'));
    expect(document.querySelector('[data-harness-zmode="abstraction"]')).toBeTruthy();
    cleanup();
    const notifyError = vi.fn();
    render(<ToastProvider><HeroHarness initialView="3d" fetchFull={async () => { throw new Error('nope'); }} setView={() => {}} notifyError={notifyError} /></ToastProvider>);
    fireEvent.click(heroButton());
    await vi.waitFor(() => expect(notifyError).toHaveBeenCalledWith('nope'));
    expect(document.querySelector('[data-harness-zmode="abstraction"]')).toBeTruthy();
    // A failed entry asks for no MOVE at all. Asserted as "every element is a
    // cancel" rather than not.toContain('fit'): that substring negation still
    // passed a mutant that armed a POWER on the failure path (finding
    // f171eb8f), and weakening a gate to fit an observation is how a gate
    // stops being one. This form is exact about the invariant without pinning
    // how many mount-time cancels precede it.
    expect(cameraTrace().split(',').filter((e) => e !== '' && e !== 'cancel')).toEqual([]);
  });

  it('restores the remembered Z-mode when the Graph tab UNMOUNTS — the fifth exit (plan 48b R2)', async () => {
    // `Shell.tsx:127` renders <Graph /> from a switch, so a tab change unmounts
    // the hook while `graphStore` keeps zMode for the session. The shared
    // harness cannot observe the restore, because its own state dies with it —
    // so record the setter calls OUTSIDE the tree and read them after unmount.
    const picks: ZMode[] = [];
    const ownEpoch = createGraphRequestEpoch();
    function UnmountHarness() {
      const [zMode, setZMode] = useState<ZMode>('abstraction');
      const record = (mode: ZMode): void => { picks.push(mode); setZMode(mode); };
      const hero = useHeroMode('3d', () => {}, true, () => {}, async () => fullPayload(UNTRUNCATED), 'p', ownEpoch, zMode, record, () => {});
      return <button type="button" onClick={() => { void hero.enterHero(); }}>enter hero</button>;
    }
    const mounted = render(<ToastProvider><UnmountHarness /></ToastProvider>);
    fireEvent.click(screen.getByText('enter hero'));
    await vi.waitFor(() => expect(picks).toEqual(['free']));
    mounted.unmount();
    expect(picks).toEqual(['free', 'abstraction']);
  });
});
