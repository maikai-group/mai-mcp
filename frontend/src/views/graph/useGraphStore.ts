// The only React binding for the store (D2). useSyncExternalStore is React 19's
// sanctioned subscribe/notify bridge; keeping it here leaves store.ts
// React-free and therefore testable as plain functions.
import { useSyncExternalStore } from 'react';
import { graphStore, type GraphViewState } from './store';

export function useGraphState(): GraphViewState {
  return useSyncExternalStore(graphStore.subscribe, graphStore.getSnapshot, graphStore.getSnapshot);
}
