import fs from 'node:fs';
import { graphGitDirectories, inside, WatchChanges, type WatchCensus } from './watch-changes.js';
import { createWatchScheduler } from './watch-scheduler.js';
import { isExcluded } from './walk.js';

export interface WatchHandle { close(): void }
export type WatchFactory = (
  target: string, recursive: boolean, change: (filename: string | null) => void, failed: () => void,
) => WatchHandle;
export interface GraphWatchController { done: Promise<number>; stop(): Promise<void> }
export interface GraphWatchOptions {
  repos: readonly string[];
  excludes: readonly string[];
  update(): Promise<void>;
  report(message: string): void;
  signal?: AbortSignal;
  // Internal seams, not CLI flags.
  watch?: WatchFactory;
  gitDirectories?: (repo: string) => Promise<string[]>;
  census?: () => Promise<WatchCensus>;
  debounceMs?: number;
  intervalMs?: number;
  now?: () => number;
}

const nativeWatch: WatchFactory = (target, recursive, change, failed) => {
  const watcher = fs.watch(target, { recursive, encoding: 'utf8' }, (_event, filename) => change(filename));
  watcher.on('error', failed);
  watcher.on('close', failed);
  return watcher;
};

export async function startGraphWatch(options: GraphWatchOptions): Promise<GraphWatchController> {
  const changes = new WatchChanges(options.repos, options.excludes, options.census);
  const scheduler = createWatchScheduler({ ...options, check: () => changes.check() });
  const handles = new Map<number, { handle: WatchHandle; source: boolean }>();
  const watch = options.watch ?? nativeWatch;
  let stopped = false;
  let stopping: Promise<void> | undefined;
  let sequence = 0;
  let finish!: (code: number) => void;
  const done = new Promise<number>(resolve => { finish = resolve; });

  function stop(code = 0): Promise<void> {
    if (stopping) return stopping;
    stopped = true;
    options.signal?.removeEventListener('abort', abort);
    for (const { handle } of handles.values()) { try { handle.close(); } catch { /* already closed */ } }
    handles.clear();
    stopping = scheduler.stop().then(() => { finish(code); });
    return stopping;
  }
  function abort(): void { void stop(); }
  const controller = { done, stop: () => stop() };
  options.signal?.addEventListener('abort', abort, { once: true });
  if (options.signal?.aborted) { await stop(); return controller; }

  function install(target: string, source: boolean, changed: (filename: string | null) => boolean): void {
    if (stopped) return;
    const id = sequence++;
    const failed = (): void => {
      if (stopped) return;
      const entry = handles.get(id);
      if (!entry) return;
      handles.delete(id);
      try { entry.handle.close(); } catch { /* already closed */ }
      options.report('Graph watch subscription lost; restart the watcher to restore coverage.');
      if (source && ![...handles.values()].some(item => item.source)) void stop(1);
    };
    try {
      const handle = watch(target, source, filename => {
        if (!stopped && changed(filename)) scheduler.notify();
      }, failed);
      handles.set(id, { handle, source });
    } catch {
      options.report('Graph watch subscription unavailable; watching any remaining roots.');
    }
  }

  try {
    try { await changes.prime(); }
    catch { options.report('Graph watch source census unavailable; startup will retry.'); }
    if (stopped) return controller;
    const sourceRoots = options.repos.filter(root => !isExcluded(root, options.excludes)
      && !options.repos.some(other => other !== root && inside(root, other)));
    for (const root of sourceRoots) install(root, true, filename => changes.source(root, filename));
    if (![...handles.values()].some(item => item.source)) { await stop(1); return controller; }
    const gitRoots = new Map<string, Set<string>>();
    for (const repo of options.repos) {
      if (stopped) return controller;
      try {
        for (const directory of await (options.gitDirectories ?? graphGitDirectories)(repo)) {
          const roots = gitRoots.get(directory) ?? new Set<string>(); roots.add(repo); gitRoots.set(directory, roots);
        }
      } catch { options.report('Graph watch Git subscription unavailable; restart after repairing the repository.'); }
    }
    for (const [directory, roots] of gitRoots) install(directory, false, () => {
      for (const root of roots) changes.git(root);
      return true;
    });
    if (!stopped) scheduler.start(); // Every subscription precedes catch-up.
    return controller;
  } catch (error) { await stop(1); throw error; }
}
