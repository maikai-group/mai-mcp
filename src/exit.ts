// Clean process teardown for CLI and script entry points.
//
// WHY THIS EXISTS (verified 2026-08-09, macOS arm64 / Node 20.20 /
// onnxruntime-node 1.21.0): onnxruntime-node, loaded by the local embedding
// tier, aborts the process during process.exit() teardown —
//   libc++abi: terminating due to uncaught exception of type
//   std::__1::system_error: mutex lock failed: Invalid argument
// — turning a SUCCESSFUL command into exit 134. `mai embed --rebuild`
// embedded all 1267 rows correctly and then aborted; `mai init` does the same.
//
// Falsified fixes (do not retry these): pipeline.dispose(); dispose plus a
// settle tick; intraOpNumThreads/interOpNumThreads = 1. All still abort.
// The ONLY clean mechanism is letting the event loop drain naturally, which
// requires releasing the pg pool first.
import { closePool } from './db.js';

/**
 * Force-exit backstop for the case where some handle still holds the loop
 * open after the pool is released. Deliberately NEVER worse than the old
 * unconditional process.exit(): if it fires with ONNX loaded the process
 * still aborts — which is exactly today's behaviour on every run — but it
 * fires only on the rare lingering-handle path instead of always.
 */
export const EXIT_DRAIN_WATCHDOG_MS = 2_000;

let _watchdog: NodeJS.Timeout | null = null;

/**
 * Record the exit code and arm the force-exit backstop. SYNCHRONOUS AND
 * AWAITS NOTHING, which is the whole point.
 *
 * ORDERING IS LOAD-BEARING (pass-2 B1). Arming this AFTER `await closePool()`
 * would leave the one case it exists for completely unguarded: pg resolves
 * pool.end() only once every checked-out client is released, and db.ts:19
 * permits a 300s query_timeout, so a stuck query would hang here for minutes
 * with no watchdog in existence. Today cli.ts:540 is a bare process.exit(0)
 * that closes nothing and returns instantly — so arm-after-await would make
 * every CLI verb STRICTLY WORSE than the code this plan replaces, trading a
 * wrong exit code for a hang. Arm first, then do the slow part.
 *
 * unref'd: this timer does not itself keep the loop alive, but it still fires
 * if something else does.
 */
export function armExitWatchdog(code: number): void {
  process.exitCode = code;
  _watchdog = setTimeout(() => process.exit(code), EXIT_DRAIN_WATCHDOG_MS);
  _watchdog.unref();
}

/**
 * Test-only: disarm and clear the recorded code. Production NEVER calls this —
 * the watchdog firing is the whole point. It exists because an armed watchdog
 * inside the vitest worker would call process.exit() two seconds later and kill
 * the test run: `unref` stops a timer from HOLDING the loop open, it does not
 * stop it firing while something else does, and a test runner always has
 * handles. Mirrors db.ts's __resetProjectIdCacheForTests convention.
 */
export function __disarmExitWatchdogForTests(): void {
  if (_watchdog) clearTimeout(_watchdog);
  _watchdog = null;
  process.exitCode = undefined;
}

/**
 * Arm the backstop, release the pool, and let the loop drain.
 *
 * Callers must simply RETURN after awaiting this — do not call process.exit()
 * afterwards, or the abort this function exists to prevent comes straight
 * back. Node exits with process.exitCode once no handles remain.
 *
 * `closer` is a TEST SEAM (the embed-rebuild.ts lessonRuleLike precedent):
 * proving "a never-resolving pool close still exits" needs a close that never
 * resolves, and wedging a real Postgres to get one is not a test.
 * Production callers never pass it.
 */
export async function finishAndExit(
  code: number,
  closer: () => Promise<void> = closePool
): Promise<void> {
  armExitWatchdog(code);
  await closer();
}
