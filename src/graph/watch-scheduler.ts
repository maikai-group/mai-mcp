export interface WatchSchedulerOptions {
  check(): Promise<boolean>;
  update(): Promise<void>;
  report(message: string): void;
  debounceMs?: number;
  intervalMs?: number;
  now?: () => number;
}

/** Timing overrides are internal test seams; the CLI exposes no tuning flags. */
export function createWatchScheduler(options: WatchSchedulerOptions) {
  const debounce = options.debounceMs ?? 2_000;
  const interval = options.intervalMs ?? 60_000;
  const now = options.now ?? (() => performance.now());
  let enabled = false;
  let stopped = false;
  let pending = false;
  let needsUpdate = false;
  let startup = false;
  let lastHint = -Infinity;
  let lastQualified = -Infinity;
  let checkDue = Infinity;
  let nextStart = -Infinity;
  let retryAt = -Infinity;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let running: Promise<void> | undefined;
  const updateDue = (): number => Math.max(nextStart, retryAt, startup ? -Infinity : lastQualified + debounce);

  async function pass(): Promise<void> {
    const hadHints = pending;
    const observedAt = lastHint;
    pending = false;
    checkDue = Infinity;
    try {
      // Also validate a previously qualified update at its eventual start.
      const changed = await options.check();
      if (stopped) return;
      if (changed) {
        needsUpdate = true;
        if (hadHints) lastQualified = Math.max(lastQualified, observedAt);
      }
      if (needsUpdate && now() >= updateDue()) {
        startup = false;
        needsUpdate = false;
        nextStart = now() + interval;
        await options.update();
      }
    } catch {
      if (!stopped) {
        needsUpdate = true;
        retryAt = now() + interval;
        options.report('Graph watch pass failed; retrying after the minimum interval.');
      }
    }
  }

  function arm(): void {
    if (timer !== undefined) clearTimeout(timer);
    timer = undefined;
    if (!enabled || stopped || running || (!pending && !needsUpdate)) return;
    const due = Math.max(now(), retryAt, Math.min(pending ? checkDue : Infinity, needsUpdate ? updateDue() : Infinity));
    timer = setTimeout(() => {
      timer = undefined;
      running = pass().finally(() => { running = undefined; arm(); });
    }, Math.max(0, due - now()));
  }

  return {
    start(): void { if (!enabled && !stopped) { enabled = true; startup = true; needsUpdate = true; arm(); } },
    notify(): void {
      if (stopped) return;
      // Checking hints has a fixed deadline. Only a qualified batch can move
      // the update deadline, so unrelated log/index noise cannot starve work.
      if (!pending) checkDue = now() + debounce;
      pending = true;
      lastHint = now();
      arm();
    },
    async stop(): Promise<void> {
      stopped = true;
      if (timer !== undefined) clearTimeout(timer);
      timer = undefined;
      await running;
    },
  };
}
