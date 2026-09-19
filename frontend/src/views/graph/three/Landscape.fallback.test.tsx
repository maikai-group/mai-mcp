import { useState } from 'react';
import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, fireEvent, cleanup } from '@testing-library/react';
import { Camera, DataTexture, PerspectiveCamera, SpriteMaterial } from 'three';
import { WEBGL_UNAVAILABLE_MESSAGE } from './webgl';
import { themeById } from '../../../lib/themes';
import { ToastProvider } from '../../../shell/toast';
import { useWebGLGate } from '../Graph';
import type { LinkObject, NodeObject } from '3d-force-graph';
import { CanvasTexture, Group, Sprite } from 'three';
import { LABEL_HEIGHT, NODE_REL_SIZE, edgeColor, heroLinkOpacity, labelOffsetY, nodeResolutionFor, nodeVolume, toGraphData, type Link3D, type Node3D } from './Landscape';
import { fakeCanvasFactory } from './fake-canvas';

/** The accessor-chain members the landscape reads on the live instance. Only
 * `nodeResolution` is new here; `cameraPosition(...)` is already read by Plan
 * 47's selection fly-to and `camera()` by its PNG export, while `onEngineStop`
 * is read by Plan 48b — none of them is stubbed on any double today, which is why
 * declaring the whole chain is worth more than declaring this plan's share.
 * Every FakeGraph implements it, so a missing stub is a type error, not a
 * `g.nodeResolution is not a function` at render time. */
interface Plan48Chain {
  nodeResolution: (value: number) => unknown;
  onEngineStop: (callback: () => void) => unknown;
  camera: () => unknown;
  cameraPosition: (position?: { x: number; y: number; z: number }, lookAt?: { x: number; y: number; z: number }, ms?: number) => unknown;
}

const theme = themeById('organism');
const base = {
  elements: [], hiddenKinds: [], theme, zMode: 'time' as const, selectedId: null,
  onSelect: () => {},
};

afterEach(() => { cleanup(); vi.restoreAllMocks(); vi.resetModules(); });

describe('WebGL fallback', () => {
  it('reports a dynamic-import failure through the one fallback callback', async () => {
    vi.doMock('3d-force-graph', () => { throw new Error('chunk load failed'); });
    const onFailure = vi.fn();
    const { Landscape: Fresh } = await import('./Landscape');
    render(<Fresh {...base} onFailure={onFailure} />);
    await vi.waitFor(() => expect(onFailure).toHaveBeenCalledWith(WEBGL_UNAVAILABLE_MESSAGE));
  });

  it('destroys a partially configured renderer and its halo resources exactly once', async () => {
    let destructors = 0;
    const materialDispose = vi.spyOn(SpriteMaterial.prototype, 'dispose');
    const textureDispose = vi.spyOn(DataTexture.prototype, 'dispose');
    class FakeGraph implements Plan48Chain {
      backgroundColor() { return this; }
      linkColor() { return this; }
      linkWidth() { return this; }
      nodeLabel() { return this; }
      nodeColor() { return this; }
      nodeOpacity() { return this; }
      nodeThreeObject(make: (node: { kind: string }) => unknown) { make({ kind: 'function' }); return this; }
      nodeThreeObjectExtend() { return this; }
      nodeVal() { return this; }
      onNodeClick() { return this; }
      nodeRelSize() { return this; }
      nodeResolution() { return this; }
      onEngineStop() { return this; }
      camera() { return { fov: 75, aspect: 1.5, position: { x: 0, y: 0, z: 1000 } }; }
      cameraPosition() { return this; }
      linkOpacity() { return this; }
      graphData(data?: { nodes: unknown[]; links: unknown[] }) {
        if (data !== undefined) { this.data = data; return this; }
        return this.data ?? { nodes: [], links: [] };
      }
      data: { nodes: unknown[]; links: unknown[] } | undefined = undefined;
      refresh() { throw new Error('post-construction configuration failed'); }
      _destructor() { destructors += 1; }
    }
    vi.doMock('3d-force-graph', () => ({ default: FakeGraph }));
    const onFailure = vi.fn();
    const { Landscape: Fresh } = await import('./Landscape');
    const mounted = render(<Fresh {...base} onFailure={onFailure} />);
    await vi.waitFor(() => expect(onFailure).toHaveBeenCalledWith(WEBGL_UNAVAILABLE_MESSAGE));
    expect(destructors).toBe(1);
    expect(materialDispose).toHaveBeenCalledTimes(1);
    expect(textureDispose).toHaveBeenCalledTimes(1);
    mounted.unmount();
    expect(destructors).toBe(1);
    expect(materialDispose).toHaveBeenCalledTimes(1);
    expect(textureDispose).toHaveBeenCalledTimes(1);
  });

  it('reports webglcontextlost through the Graph toast and removes the listener on unmount', async () => {
    const canvas = document.createElement('canvas');
    class FakeGraph implements Plan48Chain {
      backgroundColor() { return this; }
      linkColor() { return this; }
      linkWidth() { return this; }
      nodeLabel() { return this; }
      nodeColor() { return this; }
      nodeOpacity() { return this; }
      nodeThreeObject() { return this; }
      nodeThreeObjectExtend() { return this; }
      nodeVal() { return this; }
      onNodeClick() { return this; }
      nodeRelSize() { return this; }
      nodeResolution() { return this; }
      onEngineStop() { return this; }
      camera() { return { fov: 75, aspect: 1.5, position: { x: 0, y: 0, z: 1000 } }; }
      cameraPosition() { return this; }
      linkOpacity() { return this; }
      graphData(data?: { nodes: unknown[]; links: unknown[] }) {
        if (data !== undefined) { this.data = data; return this; }
        return this.data ?? { nodes: [], links: [] };
      }
      data: { nodes: unknown[]; links: unknown[] } | undefined = undefined;
      renderer() { return { domElement: canvas }; }
      refresh() { return this; }
      _destructor() {}
    }
    vi.doMock('3d-force-graph', () => ({ default: FakeGraph }));
    const { Landscape: Fresh } = await import('./Landscape');
    function IntegratedFallback() {
      const [view, setView] = useState<'2d' | '3d'>('3d');
      const [selection] = useState('selection-survives');
      const gate = useWebGLGate(view, setView, () => ({}));
      return (
        <div data-authoritative-view={view} data-preserved-selection={selection}>
          {gate.notice !== null && <p role="status">{gate.notice}</p>}
          {view === '3d' && <Fresh {...base} onFailure={gate.fail} />}
        </div>
      );
    }
    const mounted = render(<ToastProvider><IntegratedFallback /></ToastProvider>);
    await vi.waitFor(() => expect(document.querySelector('[data-webgl="ok"]')).toBeTruthy());
    fireEvent(canvas, new Event('webglcontextlost', { cancelable: true }));
    await vi.waitFor(() => expect(document.querySelector('[data-authoritative-view="2d"]')).toBeTruthy());
    expect(document.querySelector('[data-preserved-selection="selection-survives"]')).toBeTruthy();
    expect(screen.getAllByRole('status').map((status) => status.textContent)
      .every((text) => text?.includes(WEBGL_UNAVAILABLE_MESSAGE))).toBe(true);
    expect(screen.getByRole('button', { name: 'dismiss' })).toBeTruthy();
    const toastCount = screen.getAllByRole('button', { name: 'dismiss' }).length;
    fireEvent(canvas, new Event('webglcontextlost', { cancelable: true }));
    expect(screen.getAllByRole('button', { name: 'dismiss' })).toHaveLength(toastCount);
    mounted.unmount();
  });

  it('re-applies a changed theme to the mounted renderer instance', async () => {
    const backgrounds: string[] = [];
    const nodeColors: unknown[] = [];
    const nodeOpacities: number[] = [];
    const nodeGlows: unknown[] = [];
    class FakeGraph implements Plan48Chain {
      backgroundColor(value: string) { backgrounds.push(value); return this; }
      linkColor() { return this; }
      linkWidth() { return this; }
      nodeLabel() { return this; }
      nodeColor(value: unknown) { nodeColors.push(value); return this; }
      nodeOpacity(value: number) { nodeOpacities.push(value); return this; }
      nodeThreeObject(value: unknown) { nodeGlows.push(value); return this; }
      nodeThreeObjectExtend() { return this; }
      nodeVal() { return this; }
      onNodeClick() { return this; }
      nodeRelSize() { return this; }
      nodeResolution() { return this; }
      onEngineStop() { return this; }
      camera() { return { fov: 75, aspect: 1.5, position: { x: 0, y: 0, z: 1000 } }; }
      cameraPosition() { return this; }
      linkOpacity() { return this; }
      graphData(data?: { nodes: unknown[]; links: unknown[] }) {
        if (data !== undefined) { this.data = data; return this; }
        return this.data ?? { nodes: [], links: [] };
      }
      data: { nodes: unknown[]; links: unknown[] } | undefined = undefined;
      renderer() { return { domElement: document.createElement('canvas') }; }
      refresh() { return this; }
      _destructor() {}
    }
    vi.doMock('3d-force-graph', () => ({ default: FakeGraph }));
    const { Landscape: Fresh } = await import('./Landscape');
    const mounted = render(<Fresh {...base} onFailure={() => {}} />);
    await vi.waitFor(() => expect(backgrounds).toContain(theme.background.base));
    const atlas = themeById('atlas');
    mounted.rerender(<Fresh {...base} theme={atlas} onFailure={() => {}} />);
    await vi.waitFor(() => expect(backgrounds).toContain(atlas.background.base));
    expect(nodeColors.length).toBeGreaterThanOrEqual(2);
    expect(nodeOpacities).toContain(theme.node.body === 'hollow' ? 0.22 : theme.node.fillOpacity);
    expect(nodeOpacities).toContain(atlas.node.body === 'hollow' ? 0.22 : atlas.node.fillOpacity);
    expect(nodeGlows.length).toBeGreaterThanOrEqual(2);
  });

  it('wires linkColor, linkOpacity, nodeVal and nodeRelSize to the pure functions (plan 47 assertions 8-10)', async () => {
    const linkColors: Array<(l: LinkObject<NodeObject>) => string> = [];
    const linkOpacities: number[] = [];
    const nodeVals: Array<(n: NodeObject) => number> = [];
    const nodeRelSizes: number[] = [];
    const calls: Array<[string, unknown]> = [];
    const constructorOptions: Array<{ rendererConfig?: { antialias?: boolean } }> = [];
    class FakeGraph implements Plan48Chain {
      constructor(_el: HTMLElement, options?: { rendererConfig?: { antialias?: boolean } }) { constructorOptions.push(options ?? {}); }
      // Seeded with 60,000 stub links BEFORE mount, so the first applyTheme
      // reads a hero-density count; the mount's own graphData() then replaces it.
      data: { nodes: unknown[]; links: unknown[] } | undefined = { nodes: [], links: new Array<unknown>(60_000).fill({}) };
      backgroundColor() { return this; }
      linkColor(fn: (l: LinkObject<NodeObject>) => string) { linkColors.push(fn); return this; }
      linkOpacity(value: number) { linkOpacities.push(value); return this; }
      linkWidth() { return this; }
      nodeLabel() { return this; }
      nodeColor() { return this; }
      nodeOpacity() { return this; }
      nodeThreeObject() { return this; }
      nodeThreeObjectExtend() { return this; }
      nodeVal(fn: (n: NodeObject) => number) { nodeVals.push(fn); return this; }
      nodeRelSize(value: number) { nodeRelSizes.push(value); return this; }
      nodeResolution(value: number) { calls.push(['nodeResolution', value]); return this; }
      onEngineStop() { return this; }
      camera() { return { fov: 75, aspect: 1.5, position: { x: 0, y: 0, z: 1000 } }; }
      cameraPosition() { return this; }
      onNodeClick() { return this; }
      graphData(data?: { nodes: unknown[]; links: unknown[] }) {
        if (data !== undefined) { calls.push(['graphData', data.nodes.length]); this.data = data; return this; }
        return this.data ?? { nodes: [], links: [] };
      }
      renderer() { return { domElement: document.createElement('canvas') }; }
      refresh() { return this; }
      _destructor() {}
    }
    vi.doMock('3d-force-graph', () => ({ default: FakeGraph }));
    const { Landscape: Fresh } = await import('./Landscape');
    const elements = [
      { data: { id: 'a', label: 'a', kind: 'function', degree: 64 } },
      { data: { id: 'b', label: 'b', kind: 'function', degree: 1 } },
      { data: { id: 'e1', source: 'a', target: 'b', relation: 'calls', strength: 1 } },
      { data: { id: 'e2', source: 'b', target: 'a', relation: 'imports', strength: 1 } },
    ];
    const mounted = render(<Fresh {...base} elements={elements} onFailure={() => {}} />);
    await vi.waitFor(() => expect(document.querySelector('[data-webgl="ok"]')).toBeTruthy());

    // 8. Only the FIRST application sees the 60,000 seed; later applications see
    // the mounted element set. Assert containment, never an exact list.
    expect(linkOpacities).toContain(heroLinkOpacity(theme, 60_000));
    expect(heroLinkOpacity(theme, 60_000)).toBeCloseTo(0.2 * theme.edge.opacity, 12);
    expect(linkOpacities.every((v) => v <= 0.2)).toBe(true);
    const linkColor = linkColors[linkColors.length - 1];
    const callsLink: Link3D = { source: 'a', target: 'b', relation: 'calls' };
    expect(linkColor(callsLink)).toBe(edgeColor(theme, 'calls'));

    // 9. nodeVal → nodeVolume, nodeRelSize → NODE_REL_SIZE.
    expect(nodeRelSizes).toContain(NODE_REL_SIZE);

    // plan 48a (R4): resolution is set at MOUNT, before the first data push …
    const firstResolution = calls.findIndex(([method]) => method === 'nodeResolution');
    const firstPush = calls.findIndex(([method]) => method === 'graphData');
    expect(firstResolution).toBeGreaterThanOrEqual(0);
    expect(firstPush).toBeGreaterThan(firstResolution);
    expect(calls[firstResolution][1]).toBe(nodeResolutionFor(2));
    // … and re-applied on every re-projection.
    const before = calls.filter(([method]) => method === 'nodeResolution').length;
    mounted.rerender(<Fresh {...base} elements={[...elements, { data: { id: 'c', label: 'c', kind: 'function', degree: 1 } }]} onFailure={() => {}} />);
    await vi.waitFor(() => expect(calls.filter(([method]) => method === 'nodeResolution').length).toBeGreaterThan(before));
    expect(constructorOptions[0]?.rendererConfig?.antialias).toBe(true);

    const nodeVal = nodeVals[nodeVals.length - 1];
    const hub: Node3D = { id: 'a', degree: 64 };
    expect(nodeVal(hub)).toBe(nodeVolume(64));
    expect(nodeVal({ id: 'b' })).toBe(nodeVolume(undefined));

    // 10. Element → toGraphData → captured accessor → two different colours.
    const projected = toGraphData(elements, [], 'abstraction', Date.now());
    const colours = projected.links.map((l) => linkColor(l));
    expect(colours).toHaveLength(2);
    expect(colours[0]).not.toBe(colours[1]);
    expect(colours).toEqual([edgeColor(theme, 'calls'), edgeColor(theme, 'imports')]);
    mounted.unmount();
  });

  it('labels only what labelPolicy allows, degree-offset, glow-wrapped, and registered for disposal (plan 47 4b assertions 4-6)', async () => {
    const objects: Array<(n: { id: string; kind: string; degree: number; label: string; isLanding: number }) => unknown> = [];
    class FakeGraph implements Plan48Chain {
      data: { nodes: unknown[]; links: unknown[] } | undefined = undefined;
      backgroundColor() { return this; }
      linkColor() { return this; }
      linkOpacity() { return this; }
      linkWidth() { return this; }
      nodeLabel() { return this; }
      nodeColor() { return this; }
      nodeOpacity() { return this; }
      nodeThreeObject(fn: (n: { id: string; kind: string; degree: number; label: string; isLanding: number }) => unknown) { objects.push(fn); return this; }
      nodeThreeObjectExtend() { return this; }
      nodeVal() { return this; }
      nodeRelSize() { return this; }
      nodeResolution() { return this; }
      onEngineStop() { return this; }
      camera() { return { fov: 75, aspect: 1.5, position: { x: 0, y: 0, z: 1000 } }; }
      cameraPosition() { return this; }
      onNodeClick() { return this; }
      graphData(data?: { nodes: unknown[]; links: unknown[] }) {
        if (data !== undefined) { this.data = data; return this; }
        return this.data ?? { nodes: [], links: [] };
      }
      renderer() { return { domElement: document.createElement('canvas') }; }
      refresh() { return this; }
      _destructor() {}
    }
    vi.doMock('3d-force-graph', () => ({ default: FakeGraph }));
    const { Landscape: Fresh } = await import('./Landscape');
    const fake = fakeCanvasFactory();
    const mounted = render(<Fresh {...base} canvasFactory={fake.factory} onFailure={() => {}} />);
    await vi.waitFor(() => expect(document.querySelector('[data-webgl="ok"]')).toBeTruthy());
    const accessor = objects[objects.length - 1];

    // 4. isLanding: 0 → bare glow; isLanding: 1 → Group of exactly two children,
    //    the label offset by labelOffsetY(degree), not a constant.
    const bare = accessor({ id: 'leaf', kind: 'function', degree: 3, label: 'leaf', isLanding: 0 });
    expect(bare).toBeInstanceOf(Sprite);
    expect(bare).not.toBeInstanceOf(Group);
    const labelled = accessor({ id: 'hub', kind: 'function', degree: 400, label: 'hub', isLanding: 1 });
    expect(labelled).toBeInstanceOf(Group);
    if (!(labelled instanceof Group)) return;
    expect(labelled.children).toHaveLength(2);
    expect(labelled.children[0]).toBeInstanceOf(Sprite);
    expect(labelled.children[1]).toBeInstanceOf(Sprite);
    expect(labelled.children[1].position.y).toBe(labelOffsetY(400));
    expect(labelled.children[1].position.y).not.toBe(LABEL_HEIGHT);
    expect(fake.recorder.fillTexts.map(([text]) => text)).toEqual(['hub']);

    // 5. A null label sprite (empty text) falls back to the bare glow.
    const unnamed = accessor({ id: 'anon', kind: 'function', degree: 400, label: '', isLanding: 1 });
    expect(unnamed).toBeInstanceOf(Sprite);
    expect(unnamed).not.toBeInstanceOf(Group);

    // 6. Every label material is registered: a theme switch disposes THIS
    //    label's material and its CanvasTexture. Glow materials are disposed on
    //    the same switch, so a prototype-level SpriteMaterial spy cannot tell
    //    the two apart (that is how mutant B4 first survived); the spies sit on
    //    the label's own instances, which only the registration path reaches.
    const labelSprite = labelled.children[1];
    if (!(labelSprite instanceof Sprite)) return;
    const materialDispose = vi.spyOn(labelSprite.material, 'dispose');
    expect(labelSprite.material.map).toBeInstanceOf(CanvasTexture);
    const textureDispose = vi.spyOn(CanvasTexture.prototype, 'dispose');
    mounted.rerender(<Fresh {...base} theme={themeById('observatory')} canvasFactory={fake.factory} onFailure={() => {}} />);
    await vi.waitFor(() => expect(materialDispose).toHaveBeenCalledTimes(1));
    expect(textureDispose).toHaveBeenCalled();
    mounted.unmount();
  });

  it('a re-projection disposes the previous projection\'s materials and lets a disposed halo texture be re-created (688e3f31, bb709a37)', async () => {
    // A double that mirrors the digest: every graphData(data) rebuilds every
    // node through the captured accessor, exactly as three-forcegraph does for
    // freshly minted node objects.
    type HeroNode = { id: string; kind: string; degree: number; label: string; isLanding: number };
    const holder: { fn: ((n: HeroNode) => unknown) | null } = { fn: null };
    const built: unknown[][] = [];
    class FakeGraph implements Plan48Chain {
      data: { nodes: HeroNode[]; links: unknown[] } | undefined = undefined;
      backgroundColor() { return this; }
      linkColor() { return this; }
      linkOpacity() { return this; }
      linkWidth() { return this; }
      nodeLabel() { return this; }
      nodeColor() { return this; }
      nodeOpacity() { return this; }
      nodeThreeObject(fn: (n: HeroNode) => unknown) { holder.fn = fn; return this; }
      nodeThreeObjectExtend() { return this; }
      nodeVal() { return this; }
      nodeRelSize() { return this; }
      nodeResolution() { return this; }
      onEngineStop() { return this; }
      camera() { return { fov: 75, aspect: 1.5, position: { x: 0, y: 0, z: 1000 } }; }
      cameraPosition() { return this; }
      onNodeClick() { return this; }
      graphData(data?: { nodes: HeroNode[]; links: unknown[] }) {
        if (data !== undefined) {
          this.data = data;
          const fn = holder.fn;
          if (fn !== null) built.push(data.nodes.map((n) => fn(n)));
          return this;
        }
        return this.data ?? { nodes: [], links: [] };
      }
      renderer() { return { domElement: document.createElement('canvas') }; }
      refresh() { return this; }
      _destructor() {}
    }
    vi.doMock('3d-force-graph', () => ({ default: FakeGraph }));
    const { Landscape: Fresh } = await import('./Landscape');
    const fake = fakeCanvasFactory();
    const first = [
      { data: { id: 'hub', label: 'hub', kind: 'function', degree: 400, isLanding: 1 } },
      { data: { id: 'leaf', label: 'leaf', kind: 'function', degree: 1, isLanding: 0 } },
    ];
    const mounted = render(<Fresh {...base} elements={first} canvasFactory={fake.factory} onFailure={() => {}} />);
    await vi.waitFor(() => expect(document.querySelector('[data-webgl="ok"]')).toBeTruthy());
    await vi.waitFor(() => expect(built.length).toBeGreaterThanOrEqual(1));
    const firstObjects = built[built.length - 1];
    const firstGroup = firstObjects[0];
    const firstGlow = firstObjects[1];
    expect(firstGroup).toBeInstanceOf(Group);
    expect(firstGlow).toBeInstanceOf(Sprite);
    if (!(firstGroup instanceof Group) || !(firstGlow instanceof Sprite)) return;
    const firstLabel = firstGroup.children[1];
    if (!(firstLabel instanceof Sprite)) return;
    const glowDispose = vi.spyOn(firstGlow.material, 'dispose');
    const labelDispose = vi.spyOn(firstLabel.material, 'dispose');
    const labelMapDispose = firstLabel.material.map === null ? null : vi.spyOn(firstLabel.material.map, 'dispose');

    // Re-project with a new element set: the first projection's materials are
    // disposed and the registries hold only the second projection's.
    const second = [{ data: { id: 'other', label: 'other', kind: 'function', degree: 2, isLanding: 0 } }];
    const before = built.length;
    mounted.rerender(<Fresh {...base} elements={second} canvasFactory={fake.factory} onFailure={() => {}} />);
    await vi.waitFor(() => expect(built.length).toBeGreaterThan(before));
    expect(glowDispose).toHaveBeenCalledTimes(1);
    expect(labelDispose).toHaveBeenCalledTimes(1);
    expect(labelMapDispose).not.toBeNull();
    expect(labelMapDispose).toHaveBeenCalledTimes(1);

    // The shared halo texture: the library disposes it per removed node in
    // production. Once disposed, the next glow must get a FRESH texture, not
    // the disposed one still pinned in the ref.
    const secondGlow = built[built.length - 1][0];
    expect(secondGlow).toBeInstanceOf(Sprite);
    if (!(secondGlow instanceof Sprite)) return;
    const sharedMap = secondGlow.material.map;
    expect(sharedMap).toBe(firstGlow.material.map); // shared until disposed
    sharedMap?.dispose();
    const fn = holder.fn;
    if (fn === null) return;
    const afterDispose = fn({ id: 'late', kind: 'function', degree: 1, label: 'late', isLanding: 0 });
    expect(afterDispose).toBeInstanceOf(Sprite);
    if (!(afterDispose instanceof Sprite)) return;
    expect(afterDispose.material.map).not.toBe(sharedMap);
    expect(afterDispose.material.map).toBeInstanceOf(DataTexture);
    mounted.unmount();
  });

  it('executes a camera request once per id — deferring to the engine stop when asked, and moving again for a NEW id with the SAME target (plan 48b-1 R1/R3/R5)', async () => {
    const moves: Array<{ position: { x: number; y: number; z: number }; lookAt: { x: number; y: number; z: number } | undefined; ms: number | undefined }> = [];
    const holder: { onStop: (() => void) | null } = { onStop: null };
    class FakeGraph implements Plan48Chain {
      data: { nodes: Array<{ id: string; x: number; y: number; z: number }>; links: unknown[] } | undefined = {
        nodes: [{ id: 'a', x: -100, y: 0, z: 0 }, { id: 'b', x: 100, y: 0, z: 0 }], links: [],
      };
      backgroundColor() { return this; }
      linkColor() { return this; }
      linkOpacity() { return this; }
      linkWidth() { return this; }
      nodeLabel() { return this; }
      nodeColor() { return this; }
      nodeOpacity() { return this; }
      nodeThreeObject() { return this; }
      nodeThreeObjectExtend() { return this; }
      nodeVal() { return this; }
      nodeRelSize() { return this; }
      nodeResolution() { return this; }
      onNodeClick() { return this; }
      onEngineStop(fn: () => void) { holder.onStop = fn; return this; }
      camera() { return new PerspectiveCamera(75, 1.5); }
      cameraPosition(position?: { x: number; y: number; z: number }, lookAt?: { x: number; y: number; z: number }, ms?: number) {
        if (position === undefined) return { x: 0, y: 0, z: 1000 };
        moves.push({ position, lookAt, ms });
        return this;
      }
      graphData(data?: { nodes: Array<{ id: string; x: number; y: number; z: number }>; links: unknown[] }) {
        if (data !== undefined) { return this; }   // keep the positioned seed: the frame is computed over LIVE positions
        return this.data ?? { nodes: [], links: [] };
      }
      renderer() { return { domElement: document.createElement('canvas') }; }
      refresh() { return this; }
      _destructor() {}
    }
    vi.doMock('3d-force-graph', () => ({ default: FakeGraph }));
    const { Landscape: Fresh, sceneFrame: frameOf } = await import('./Landscape');
    const { objectiveDistance } = await import('../model');
    const mounted = render(<Fresh {...base} onFailure={() => {}} />);
    await vi.waitFor(() => expect(document.querySelector('[data-webgl="ok"]')).toBeTruthy());
    expect(holder.onStop).not.toBeNull();
    // R5: no request means no request-driven move, and an engine stop with
    // nothing pending does nothing. (`base` passes `selectedId: null`, so Plan
    // 47's fly-to — the other `cameraPosition` writer — returns at its first
    // guard and never fires here; the double's graphData is not what protects
    // this count.)
    holder.onStop?.();
    expect(moves).toHaveLength(0);
    // A settle-deferred request waits for the stop rather than firing now.
    mounted.rerender(<Fresh {...base} cameraRequest={{ target: 'fit', onSettle: true, id: 1 }} onFailure={() => {}} />);
    await Promise.resolve();
    expect(moves).toHaveLength(0);
    holder.onStop?.();
    expect(moves).toHaveLength(1);
    const expected = frameOf([{ x: -100, y: 0, z: 0 }, { x: 100, y: 0, z: 0 }], 75, 1.5);
    expect(moves[0].lookAt).toEqual(expected.centre);
    expect(moves[0].position.z).toBeCloseTo(expected.distance, 6);   // current direction is +z from the seed camera
    expect(moves[0].ms).toBe(600);
    holder.onStop?.();   // the id is retired: a second stop fires nothing
    expect(moves).toHaveLength(1);
    // The re-arm shape of finding 3fa1ee73, one level up. React re-renders
    // with an EQUAL BUT NEW request object — the ordinary inline-literal
    // idiom — and a consumed id must stay consumed. Stated plainly: this
    // assertion is a REGRESSION PIN, not the unique killer of any row in the
    // table below, and removing it leaves every mutant still dying. Dropping
    // the effect's own id guard reddens at the "same id again" assertion
    // further down, never here. It is kept because this exact shape survived a
    // repair once, and a named case is cheaper than rediscovering it.
    mounted.rerender(<Fresh {...base} cameraRequest={{ target: 'fit', onSettle: true, id: 1 }} onFailure={() => {}} />);
    await Promise.resolve();
    holder.onStop?.();
    expect(moves).toHaveLength(1);
    // R3's discriminator. The camera is ALREADY at the fit frame and the
    // target is the same 'fit' — a design that compared values would do
    // nothing here, which is exactly the dead button finding fd6b15a8
    // describes. A new id must move it again.
    mounted.rerender(<Fresh {...base} cameraRequest={{ target: 'fit', onSettle: false, id: 2 }} onFailure={() => {}} />);
    await vi.waitFor(() => expect(moves).toHaveLength(2));
    expect(moves[1].position.z).toBeCloseTo(expected.distance, 6);
    // Re-rendering with the SAME request object must not move it a third time.
    mounted.rerender(<Fresh {...base} cameraRequest={{ target: 'fit', onSettle: false, id: 2 }} onFailure={() => {}} />);
    await Promise.resolve();
    expect(moves).toHaveLength(2);
    // An objective request steps the camera by the 2D ratios.
    mounted.rerender(<Fresh {...base} cameraRequest={{ target: 40, onSettle: false, id: 3 }} onFailure={() => {}} />);
    await vi.waitFor(() => expect(moves).toHaveLength(3));
    expect(moves[2].position.z).toBeCloseTo(objectiveDistance(40, expected.distance), 6);
    expect(moves[2].position.z).toBeLessThan(expected.distance);
    // A parked request that a LATER request overtakes is discarded, never
    // fired late. This is the ONLY case that can falsify mutant C14 — the
    // pre-2026-09-04 shape, which cleared `pendingRef` after executing and so
    // looked correct on a second bare stop while still firing a stale parked
    // request. It is why the clear was redundant and the comparison is not.
    mounted.rerender(<Fresh {...base} cameraRequest={{ target: 100, onSettle: true, id: 4 }} onFailure={() => {}} />);
    await Promise.resolve();
    expect(moves).toHaveLength(3);                       // parked, not fired
    mounted.rerender(<Fresh {...base} cameraRequest={{ target: 10, onSettle: false, id: 5 }} onFailure={() => {}} />);
    await vi.waitFor(() => expect(moves).toHaveLength(4));
    holder.onStop?.();
    expect(moves).toHaveLength(4);                       // id 4 never fires
    // A settle-deferred request that is cancelled before the engine stops
    // never fires — hero closing while the landscape stays mounted (R5).
    mounted.rerender(<Fresh {...base} cameraRequest={{ target: 'fit', onSettle: true, id: 6 }} onFailure={() => {}} />);
    await Promise.resolve();
    mounted.rerender(<Fresh {...base} cameraRequest={null} onFailure={() => {}} />);
    await Promise.resolve();
    holder.onStop?.();
    expect(moves).toHaveLength(4);
    mounted.unmount();
  });

  it('a request over an empty node set is a no-op rather than a jump to the origin (plan 48b-1 R5)', async () => {
    const moves: Array<{ x: number; y: number; z: number }> = [];
    class FakeGraph implements Plan48Chain {
      backgroundColor() { return this; }
      linkColor() { return this; }
      linkOpacity() { return this; }
      linkWidth() { return this; }
      nodeLabel() { return this; }
      nodeColor() { return this; }
      nodeOpacity() { return this; }
      nodeThreeObject() { return this; }
      nodeThreeObjectExtend() { return this; }
      nodeVal() { return this; }
      nodeRelSize() { return this; }
      nodeResolution() { return this; }
      onNodeClick() { return this; }
      onEngineStop() { return this; }
      camera() { return new PerspectiveCamera(75, 1.5); }
      cameraPosition(position?: { x: number; y: number; z: number }) {
        if (position === undefined) return { x: 0, y: 0, z: 1000 };
        moves.push(position);
        return this;
      }
      graphData(data?: { nodes: Array<{ id: string; x: number; y: number; z: number }>; links: unknown[] }) {
        if (data !== undefined) return this;
        return { nodes: [], links: [] };
      }
      renderer() { return { domElement: document.createElement('canvas') }; }
      refresh() { return this; }
      _destructor() {}
    }
    vi.doMock('3d-force-graph', () => ({ default: FakeGraph }));
    const { Landscape: Fresh } = await import('./Landscape');
    const mounted = render(<Fresh {...base} cameraRequest={{ target: 'fit', onSettle: false, id: 1 }} onFailure={() => {}} />);
    await vi.waitFor(() => expect(document.querySelector('[data-webgl="ok"]')).toBeTruthy());
    await Promise.resolve();
    expect(moves).toHaveLength(0);
    // An objective step over the same empty scene is equally a no-op.
    mounted.rerender(<Fresh {...base} cameraRequest={{ target: 100, onSettle: false, id: 2 }} onFailure={() => {}} />);
    await Promise.resolve();
    expect(moves).toHaveLength(0);
    mounted.unmount();
  });

  it('falls back to a 75° / 1.0 frame when the instance camera is not a PerspectiveCamera (plan 48b-1 R1)', async () => {
    // The nodes sit at ±2000 on purpose: inside MIN_FRAME_DISTANCE both the
    // real and the mutated fov/aspect clamp to 300, and the case would pass
    // under any literals at all (finding 39511509).
    const moves: number[] = [];
    class FakeGraph implements Plan48Chain {
      backgroundColor() { return this; }
      linkColor() { return this; }
      linkOpacity() { return this; }
      linkWidth() { return this; }
      nodeLabel() { return this; }
      nodeColor() { return this; }
      nodeOpacity() { return this; }
      nodeThreeObject() { return this; }
      nodeThreeObjectExtend() { return this; }
      nodeVal() { return this; }
      nodeRelSize() { return this; }
      nodeResolution() { return this; }
      onNodeClick() { return this; }
      onEngineStop() { return this; }
      camera() { return new Camera(); }   // NOT a PerspectiveCamera: no fov, no aspect
      cameraPosition(position?: { x: number; y: number; z: number }) {
        if (position === undefined) return { x: 0, y: 0, z: 1000 };
        moves.push(position.z);
        return this;
      }
      graphData(data?: { nodes: Array<{ id: string; x: number; y: number; z: number }>; links: unknown[] }) {
        if (data !== undefined) return this;
        return { nodes: [{ id: 'a', x: -2000, y: 0, z: 0 }, { id: 'b', x: 2000, y: 0, z: 0 }], links: [] };
      }
      renderer() { return { domElement: document.createElement('canvas') }; }
      refresh() { return this; }
      _destructor() {}
    }
    vi.doMock('3d-force-graph', () => ({ default: FakeGraph }));
    const { Landscape: Fresh, sceneFrame: frameOf, MIN_FRAME_DISTANCE } = await import('./Landscape');
    const mounted = render(<Fresh {...base} cameraRequest={{ target: 'fit', onSettle: false, id: 1 }} onFailure={() => {}} />);
    await vi.waitFor(() => expect(document.querySelector('[data-webgl="ok"]')).toBeTruthy());
    await vi.waitFor(() => expect(moves).toHaveLength(1));
    const fallback = frameOf([{ x: -2000, y: 0, z: 0 }, { x: 2000, y: 0, z: 0 }], 75, 1);
    expect(fallback.distance).toBeGreaterThan(MIN_FRAME_DISTANCE);   // the clamp must not be what makes this pass
    expect(moves[0]).toBeCloseTo(fallback.distance, 6);
    mounted.unmount();
  });

  it('a request that lands BEFORE the landscape is ready moves the camera exactly once when it becomes ready (plan 48b-1 R5, the pre-ready request)', async () => {
    const moves: number[] = [];
    let release: () => void = () => {};
    const gate = new Promise<void>((done) => { release = done; });
    class FakeGraph implements Plan48Chain {
      data: { nodes: Array<{ id: string; x: number; y: number; z: number }>; links: unknown[] } | undefined = {
        nodes: [{ id: 'a', x: -100, y: 0, z: 0 }, { id: 'b', x: 100, y: 0, z: 0 }], links: [],
      };
      backgroundColor() { return this; }
      linkColor() { return this; }
      linkOpacity() { return this; }
      linkWidth() { return this; }
      nodeLabel() { return this; }
      nodeColor() { return this; }
      nodeOpacity() { return this; }
      nodeThreeObject() { return this; }
      nodeThreeObjectExtend() { return this; }
      nodeVal() { return this; }
      nodeRelSize() { return this; }
      nodeResolution() { return this; }
      onNodeClick() { return this; }
      onEngineStop() { return this; }
      camera() { return new PerspectiveCamera(75, 1.5); }
      cameraPosition(position?: { x: number; y: number; z: number }) {
        if (position === undefined) return { x: 0, y: 0, z: 1000 };
        moves.push(position.z);
        return this;
      }
      graphData(data?: { nodes: Array<{ id: string; x: number; y: number; z: number }>; links: unknown[] }) {
        if (data !== undefined) return this;
        return this.data ?? { nodes: [], links: [] };
      }
      renderer() { return { domElement: document.createElement('canvas') }; }
      refresh() { return this; }
      _destructor() {}
    }
    // Hold the dynamic import open so a request can land during loading.
    vi.doMock('3d-force-graph', async () => { await gate; return { default: FakeGraph }; });
    const { Landscape: Fresh } = await import('./Landscape');
    const mounted = render(<Fresh {...base} onFailure={() => {}} />);
    mounted.rerender(<Fresh {...base} cameraRequest={{ target: 40, onSettle: false, id: 1 }} onFailure={() => {}} />);   // before ready
    expect(document.querySelector('[data-webgl="ok"]')).toBeNull();
    release();
    await vi.waitFor(() => expect(document.querySelector('[data-webgl="ok"]')).toBeTruthy());
    await vi.waitFor(() => expect(moves).toHaveLength(1));
    const { objectiveDistance } = await import('../model');
    const { sceneFrame: frameOf } = await import('./Landscape');
    expect(moves[0]).toBeCloseTo(objectiveDistance(40, frameOf([{ x: -100, y: 0, z: 0 }, { x: 100, y: 0, z: 0 }], 75, 1.5).distance), 6);
    mounted.unmount();
  });
});
