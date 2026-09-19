import { describe, it, expect } from 'vitest';
import { createGraphStore, initialGraphState } from './store';
import { DEFAULT_OBJECTIVE, DEFAULT_Z_MODE } from './model';

const landing = [
  { data: { id: 'a', label: 'a', kind: 'function', degree: 9 } },
  { data: { id: 'b', label: 'b', kind: 'file', degree: 3 } },
  { data: { id: 'a__calls__b', source: 'a', target: 'b', relation: 'calls' } },
];

describe('store transitions', () => {
  it('starts from a known initial state', () => {
    const s = initialGraphState();
    expect(s.status).toBe('loading');
    expect(s.view).toBe('2d');
    expect(s.objective).toBe(DEFAULT_OBJECTIVE);
    expect(s.zMode).toBe(DEFAULT_Z_MODE);
    expect(s.heartId).toBeNull();
  });

  it('resetToLanding seeds the project heart at the top-degree node', () => {
    const store = createGraphStore();
    store.resetToLanding(landing);
    const s = store.getSnapshot();
    expect(s.status).toBe('ready');
    expect(s.heartId).toBe('a');
    expect(s.projectHeartId).toBe('a');
  });

  it('resetToLanding on an empty overview reports empty, not ready', () => {
    const store = createGraphStore();
    store.resetToLanding([]);
    expect(store.getSnapshot().status).toBe('empty');
  });

  it('resetToLanding after promotion restores the landing set and interaction defaults', () => {
    const store = createGraphStore();
    store.resetToLanding(landing);
    store.setHeart('b');
    expect(store.getSnapshot().heartId).toBe('b');
    expect(store.getSnapshot().selectedId).toBe('b');
    store.toggleKind('file');
    store.mergeElements([{ data: { id: 'expanded', kind: 'file', degree: 1 } }]);
    store.resetToLanding(landing);
    expect(store.getSnapshot()).toMatchObject({
      elements: landing,
      heartId: 'a',
      selectedId: null,
      hiddenKinds: [],
      status: 'ready',
    });
  });

  it('setHeart ignores an unknown id', () => {
    const store = createGraphStore();
    store.resetToLanding(landing);
    store.setHeart('ghost');
    expect(store.getSnapshot().heartId).toBe('a');
  });

  it('mergeElements dedupes by id and preserves heart, selection and filters', () => {
    const store = createGraphStore();
    store.resetToLanding(landing);
    store.setHeart('b');
    store.toggleKind('file');
    store.toggleKind('class');
    store.mergeElements([
      { data: { id: 'b', label: 'b-dupe', kind: 'file' } },
      { data: { id: 'c', label: 'c', kind: 'class' } },
    ]);
    const s = store.getSnapshot();
    expect(s.elements.filter((e) => e.data?.id === 'b')).toHaveLength(1);
    expect(s.elements.some((e) => e.data?.id === 'c')).toBe(true);
    expect(s.heartId).toBe('b');
    expect(s.hiddenKinds).toEqual(['file', 'class']);
  });

  it('switching view or theme preserves selection and neighbourhood (cross-view parity)', () => {
    const store = createGraphStore();
    store.resetToLanding(landing);
    store.select('b');
    const before = store.getSnapshot().elements.length;
    store.setView('3d');
    store.setTheme('signal');
    store.setZMode('confidence');
    const s = store.getSnapshot();
    expect(s.selectedId).toBe('b');
    expect(s.elements.length).toBe(before);
    expect(s.view).toBe('3d');
  });

  it('toggleKind toggles and showAllKinds clears', () => {
    const store = createGraphStore();
    store.toggleKind('file');
    store.toggleKind('table');
    expect(store.getSnapshot().hiddenKinds).toEqual(['file', 'table']);
    store.toggleKind('file');
    expect(store.getSnapshot().hiddenKinds).toEqual(['table']);
    store.showAllKinds();
    expect(store.getSnapshot().hiddenKinds).toEqual([]);
  });

  it('notifies subscribers and stops after unsubscribe', () => {
    const store = createGraphStore();
    let calls = 0;
    const off = store.subscribe(() => { calls += 1; });
    store.select('n1');
    store.setStatus('ready');
    expect(calls).toBe(2);
    off();
    store.select('n2');
    expect(calls).toBe(2);
  });

  it('returns a new snapshot object on change and a stable one otherwise', () => {
    const store = createGraphStore();
    const a = store.getSnapshot();
    expect(store.getSnapshot()).toBe(a);
    store.select('n1');
    expect(store.getSnapshot()).not.toBe(a);
  });
});
