import { describe, it, expect, vi } from 'vitest';
import { createGraphRequestEpoch, routeExportPng, routeFit, runGraphRequest } from './Graph';

interface GraphPayload {
  element: string;
  heart: string;
  selection: string;
  freshness: string;
}

interface FakeGraphState {
  project: string;
  elements: string[];
  heart: string;
  selection: string;
  freshness: string;
}

interface Deferred<T> {
  promise: Promise<T>;
  resolve(value: T): void;
}

const deferred = <T>(): Deferred<T> => {
  let resolve = (_value: T): void => {};
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
};

describe('graph request epoch', () => {
  it('drops a delayed project-A expansion after project B owns the graph', async () => {
    const epoch = createGraphRequestEpoch();
    const a = deferred<GraphPayload>();
    const b = deferred<GraphPayload>();
    const state: FakeGraphState = {
      project: 'none', elements: [], heart: '', selection: '', freshness: '',
    };
    const canvas: string[] = [];
    const apply = (project: string, source: Deferred<GraphPayload>) =>
      runGraphRequest(epoch, () => source.promise, (value) => {
        state.project = project;
        state.elements = [value.element];
        state.heart = value.heart;
        state.selection = value.selection;
        state.freshness = value.freshness;
        canvas.splice(0, canvas.length, value.element);
      });

    const pendingA = apply('A', a);
    epoch.invalidate(); // ProjectSwitcher changes A → B before A resolves.
    const pendingB = apply('B', b);
    b.resolve({ element: 'B-node', heart: 'B-node', selection: 'B-node', freshness: 'B-fresh' });
    expect(await pendingB).toBe(true);
    a.resolve({ element: 'A-node', heart: 'A-node', selection: 'A-node', freshness: 'A-fresh' });
    expect(await pendingA).toBe(false);
    expect(state).toEqual({
      project: 'B', elements: ['B-node'], heart: 'B-node', selection: 'B-node', freshness: 'B-fresh',
    });
    expect(canvas).toEqual(['B-node']);
  });
});

describe('routeExportPng (plan 47 R9)', () => {
  it('routes the PNG request to the live view\'s canvas and never invokes the other exporter', () => {
    const landscape = vi.fn(() => 'data:image/png;base64,LANDSCAPE');
    const cy = vi.fn(() => 'data:image/png;base64,CY');
    expect(routeExportPng('3d', landscape, cy)).toBe('data:image/png;base64,LANDSCAPE');
    expect(landscape).toHaveBeenCalledTimes(1);
    expect(cy).not.toHaveBeenCalled();
    expect(routeExportPng('2d', landscape, cy)).toBe('data:image/png;base64,CY');
    expect(landscape).toHaveBeenCalledTimes(1);
    expect(cy).toHaveBeenCalledTimes(1);
  });

  it('returns null without throwing when the live view has no exporter', () => {
    const cy = vi.fn(() => 'data:image/png;base64,CY');
    expect(routeExportPng('3d', null, cy)).toBeNull();
    expect(cy).not.toHaveBeenCalled();
    expect(routeExportPng('2d', () => 'x', null)).toBeNull();
  });
});

describe('routeFit (plan 48b R3)', () => {
  it('invokes only the live view\'s fit', () => {
    const landscape = vi.fn();
    const cy = vi.fn();
    routeFit('3d', landscape, cy);
    expect(landscape).toHaveBeenCalledTimes(1);
    expect(cy).not.toHaveBeenCalled();
    routeFit('2d', landscape, cy);
    expect(cy).toHaveBeenCalledTimes(1);
    expect(landscape).toHaveBeenCalledTimes(1);
  });

  it('is a no-op without throwing when the live view has no fit', () => {
    const cy = vi.fn();
    expect(() => routeFit('3d', null, cy)).not.toThrow();
    expect(cy).not.toHaveBeenCalled();
  });
});
