import { loadProjectGraphRoots } from '../db.js';
import { dialectOf } from './extractors/db.js';
import { runGraphUpdate } from './update.js';
import { startGraphWatch, type GraphWatchController } from './watch.js';

interface Signals {
  on(signal: 'SIGINT' | 'SIGTERM', listener: () => void): void;
  off(signal: 'SIGINT' | 'SIGTERM', listener: () => void): void;
}

/** Register before async startup; the caller owns the CLI's single final drain. */
export async function runWatchSession(
  start: (signal: AbortSignal) => Promise<GraphWatchController>, signals: Signals = process,
): Promise<number> {
  const cancellation = new AbortController();
  const stop = (): void => cancellation.abort();
  signals.on('SIGINT', stop); signals.on('SIGTERM', stop);
  let watcher: GraphWatchController | undefined;
  try {
    watcher = await start(cancellation.signal);
    return await watcher.done;
  } finally {
    await watcher?.stop();
    signals.off('SIGINT', stop); signals.off('SIGTERM', stop);
  }
}

export async function runGraphWatch(args: { projectId: string; slug: string; dbUrl?: string }): Promise<string> {
  if (args.dbUrl) dialectOf(args.dbUrl);
  const code = await runWatchSession(async signal => {
    const roots = await loadProjectGraphRoots(args.projectId);
    if (!signal.aborted) process.stdout.write(`Starting graph watch for ${args.slug}. Press Ctrl+C to stop.\n`);
    const controller = await startGraphWatch({
      repos: roots.repos, excludes: roots.excludes, signal,
      update: async () => { process.stdout.write(await runGraphUpdate(args) + '\n'); },
      report: message => { process.stderr.write(message + '\n'); },
    });
    return controller;
  });
  if (code !== 0) throw new Error('Graph watch stopped: no source subscriptions remain.');
  return 'Graph watcher stopped.';
}
