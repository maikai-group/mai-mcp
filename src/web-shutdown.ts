// Web teardown ORDERING, isolated from the server it tears down.
//
// This is one composition, not a utility library: arm the backstop, stop
// accepting connections, release the pool ONLY once in-flight handlers are
// done, and evict idle keep-alives so that callback can actually fire. Each
// step exists for a different failure (see the comments), and the ORDER is the
// contract — which is precisely why it lives somewhere a test can observe it.
export interface ShutdownServer {
  close(cb?: (err?: Error) => void): unknown;
  closeIdleConnections(): void;
}

export interface ShutdownDeps {
  server: ShutdownServer;
  /** exit.ts's armExitWatchdog — injected so the test never arms a real timer. */
  arm: (code: number) => void;
  /** db.ts's closePool. */
  closePool: () => Promise<void>;
  log?: (message: string) => void;
}

export function makeShutdown(deps: ShutdownDeps): (signal: string) => void {
  let started = false;
  return (signal: string): void => {
    // Re-entrancy guard: SIGINT then SIGTERM (or a double Ctrl-C) would
    // otherwise arm TWO watchdogs and call close() twice. A second signal is
    // now a no-op; the already-armed watchdog still bounds the whole thing.
    if (started) return;
    started = true;
    deps.log?.(`\n[mai-brain-web] ${signal} received, shutting down.\n`);
    // 1. Arm FIRST (pass-2 B1): everything below can block indefinitely.
    deps.arm(0);
    // 2. Release the pool only once in-flight handlers are done (pass-2 B2).
    //    server.close() returns immediately, so closing the pool right after it
    //    would yank the DB from under an /api/search or /api/similar request the
    //    client is still waiting on. Worse, that handler's next getPool() mints
    //    a WHOLE NEW POOL after teardown (closePool nulls the singleton),
    //    holding the loop open until the watchdog force-exits.
    deps.server.close(() => { void deps.closePool(); });
    // 3. Idle keep-alive sockets never end on their own, so close() would never
    //    call back while a dashboard tab sits open (pass-1 W5) — the drain fix
    //    would be inert on the one surface most likely to have loaded the
    //    pipeline via /api/similar. closeIdleConnections (NOT closeAllConnections)
    //    is what preserves the in-flight requests step 2 exists to protect.
    deps.server.closeIdleConnections();
  };
}
