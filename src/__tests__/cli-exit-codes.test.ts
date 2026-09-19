/** Exit-code contract for CLI entry points (plan 14b).
 *
 * WHY SUBPROCESSES: the defect is a NATIVE abort during process teardown —
 * onnxruntime-node aborts on process.exit() after any embedding. That cannot
 * be observed in-process; only a real child process reveals it. These tests
 * also catch the opposite regression the drain fix could introduce: a command
 * that never terminates because some handle still holds the loop.
 */
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { execFile } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { Pool } from 'pg';
import { vi } from 'vitest';
import { requireDisposableTestDbUrl } from './test-db-url.js';

const run = promisify(execFile);
// Shared disposable guard (Plan 15 rule 5): no mai_brain fallback, ever.
const DB = requireDisposableTestDbUrl();
const LAUNCH_ID_FOR_CLI = '11111111-1111-4111-8111-111111111111';
process.env.MAI_DB_URL = DB;
const admin = new Pool({ connectionString: DB });

vi.mock('../scripts/init.js', async (importOriginal) => {
  const original = await importOriginal<typeof import('../scripts/init.js')>();
  return { ...original, runInit: vi.fn(async () => ({
    slug: 'stub', root: '/stub', repos: [], harnesses: [], summary: [],
    verification: { slug: 'stub', ok: true, shared: [], repos: [] },
  })) };
});

vi.mock('../scripts/dashboard.js', () => ({
  dashboardRun: vi.fn(async () => 0),
  dashboardStart: vi.fn(async () => 'started'),
  dashboardStatus: vi.fn(async () => ({ ok: true, text: 'Health: OK' })),
  dashboardStop: vi.fn(async () => 'stopped'),
}));

vi.mock('../scripts/dashboard-persistence.js', () => ({
  runPersistence: vi.fn(async () => ({ ok: true, text: 'Supervisor loaded: yes' })),
}));

vi.mock('../exit.js', async (importOriginal) => {
  const original = await importOriginal<typeof import('../exit.js')>();
  return { ...original, finishAndExit: vi.fn(original.finishAndExit) };
});

/** Spawn a CLI verb and report exit code + whether the native abort appeared.
 * timeout is the HANG detector: without the drain fix's watchdog a stuck
 * handle would block forever, and a test that hangs teaches nothing. */
async function cli(
  args: string[],
  env: Record<string, string> = {}
): Promise<{ code: number; signal: string | null; aborted: boolean; out: string }> {
  try {
    const { stdout, stderr } = await run('node', ['build/cli.js', ...args], {
      env: { ...process.env, MAI_DB_URL: DB, ...env },
      timeout: 60_000,
      cwd: process.cwd(),
    });
    const out = stdout + stderr;
    return { code: 0, signal: null, aborted: /mutex lock failed/.test(out), out };
  } catch (err) {
    // A native abort arrives as signal 'SIGABRT' with code NULL — not 134
    // (pass-4 W2, measured: execFile reports code=null, signal='SIGABRT'; the
    // familiar 134 is the SHELL's 128+6 encoding and never reaches Node). The
    // signal is surfaced so a failure message names the real cause.
    const e = err as {
      code?: number; signal?: string; killed?: boolean; stdout?: string; stderr?: string;
    };
    const out = (e.stdout ?? '') + (e.stderr ?? '');
    // `e.killed` is true only when execFile ITSELF killed the child (the 60s
    // timeout) — measured: timeout kill = killed:true + signal:'SIGTERM', a
    // native self-abort = killed:false + signal:'SIGABRT' (pass-6 W1: the
    // earlier `e.killed && !e.signal` guard could never fire, because a
    // timeout kill always carries its signal).
    if (e.killed) throw new Error(`CLI HUNG (killed at timeout): mai ${args.join(' ')}`);
    return {
      code: typeof e.code === 'number' ? e.code : -1,
      signal: e.signal ?? null,
      aborted: /mutex lock failed/.test(out) || e.signal === 'SIGABRT',
      out,
    };
  }
}

/** An existing but completely unwired repo directory — no .mcp.json, no hooks,
 * no CLAUDE.md. Registering it is what makes `mai verify` FAIL rather than
 * THROW, and that distinction is load-bearing (execution 2026-08-10):
 * verifyProject throws for an unknown slug AND for a project with zero
 * registered repos, and both of those land in main()'s .catch, which calls
 * finishAndExit(1) unconditionally. With a bare fixture, NO test reached
 * cmdVerify's `if (!v.ok)` branch — so the B2 exit-code-PRESERVATION guard was
 * unfalsifiable: mutating main()'s tail to an unconditional finishAndExit(0)
 * left the whole suite green. Measured, then fixed here. */
let repoDir = '';

beforeAll(async () => {
  repoDir = await mkdtemp(join(tmpdir(), 'exitcode-repo-'));
  await admin.query(`DELETE FROM projects WHERE slug = 'exitcode-test'`);
  await admin.query(
    `INSERT INTO projects (slug, name, metadata)
     VALUES ('exitcode-test', 'Exit Code Test', jsonb_build_object('repos', jsonb_build_array($1::text)))`,
    [repoDir]
  );
});
afterAll(async () => {
  await admin.query(`DELETE FROM projects WHERE slug = 'exitcode-test'`);
  await admin.end();
  if (repoDir) await rm(repoDir, { recursive: true, force: true });
});

describe('CLI exit codes — non-mutating verbs', () => {
  // Read-only verbs only. Mutating verbs (init/upgrade/reingest/graph build/
  // embed --rebuild) are excluded ON PURPOSE: running them here would rewrite
  // real config and real vectors.
  //
  // EXACT expected code per case (pass-2 W2). A shared `[0, 1]` assertion
  // accepted BOTH codes for every verb, so `--help` or `projects` regressing
  // from 0 to 1 — precisely the exit-code-preservation bug this file exists to
  // catch — would have passed silently.
  const SAFE_VERBS: Array<{ args: string[]; code: number; why: string }> = [
    { args: ['--help'], code: 0, why: 'usage always succeeds' },
    { args: ['projects'], code: 0, why: 'a successful read' },
    // THE B2 GUARD. Its registered repo exists but is unwired, so verifyProject
    // returns ok:false instead of throwing — the only route to cmdVerify's
    // `process.exitCode = 1; return "";`, which main()'s single finishAndExit
    // must PRESERVE. Falsified by mutation: an unconditional finishAndExit(0)
    // in main()'s tail reports 0 here and this case goes red.
    { args: ['verify', 'exitcode-test'], code: 1, why: 'registered but unwired → !v.ok, exit code preserved' },
  ];

  for (const { args, code, why } of SAFE_VERBS) {
    it(`\`mai ${args.join(' ')}\` exits ${code} (${why}) with embeddings ON`, async () => {
      // MAI_EMBEDDINGS=1 with no keys selects the local tier, but none of
      // these verbs EMBED, so no pipeline loads and the default suite stays
      // model-free (plan 14 R8). What this proves is the drain regression:
      // the command still terminates, with the RIGHT code, and never hangs.
      const r = await cli(args, { MAI_EMBEDDINGS: '1', OPENAI_API_KEY: '', VOYAGE_API_KEY: '' });
      expect(r.aborted).toBe(false);
      expect(r.code).toBe(code);
      expect(r.out.length).toBeGreaterThan(0); // pass-1 W1: real output, not a silent throw
    }, 90_000);
  }

  it('an unknown command still exits 1, not 134', async () => {
    const r = await cli(['no-such-verb']);
    expect(r.code).toBe(1);
    expect(r.aborted).toBe(false);
  }, 60_000);

  it('a verify of an UNKNOWN project still exits 1 through the error drain', async () => {
    // NOT the B2 pin — that label now sits on the `verify exitcode-test` case
    // above. An unknown slug makes verifyProject THROW, so this exits through
    // main()'s .catch → finishAndExit(1) and never touches cmdVerify's exitCode
    // assignment. Kept because it is the ONLY coverage of the error-path drain.
    // Both routes to 1 are covered precisely because they are different code
    // paths — conflating them is what left B2 unguarded until execution
    // measured it.
    const r = await cli(['verify', 'no-such-project-slug']);
    expect(r.code).toBe(1);
    expect(r.aborted).toBe(false);
  }, 60_000);
});

// GATED: the only case that loads the real ONNX pipeline, kept out of the
// default suite because plan 14 R8 forbids the default suite reaching model
// inference.
//
// THE VERB IS `search`, NOT `embed --rebuild` (pass-2 B6). `mai search` routes
// through embedQuery -> embedLocal, so it loads the identical pipeline and
// reproduces the identical abort — while touching NO CURATED DATA. (It does
// insert one write_session_tokens bookkeeping row, which cascades with the
// fixture project below — pass-3 B4.) `embed --rebuild`
// cannot be made safe from the CLI at any scope: cli.ts:399-402 never passes
// runEmbedRebuild's lessonRuleLike seam, so its lessons loop
// (embed-rebuild.ts:103-111) rewrites the GLOBAL curated layer even with
// --project. A regression test must not be able to corrupt the thing it guards.
//
// MAI_PROJECT_SLUG, not --project (measured): search also mints the write-gate
// token, which resolves the PINNED slug, so --project alone dies with
// "Project not found for pinned slug ''" and tests the error path instead.
//
// PINNED TO THE FIXTURE, not mai-mcp-self (pass-3 B4). An earlier draft pinned
// the real project, which violated this plan's own R9 and would fail outright
// on a clean database that has no such row. The fixture works because
// decisions.ts:257 calls embedQuery BEFORE any row lookup — so a project with
// zero decisions still loads the full ONNX pipeline. Verified end-to-end
// 2026-08-09 against an empty `exitcode-test`: exit 134, one abort line,
// "## Decisions" still printed.
describe.skipIf(process.env.MAI_TEST_LOCAL_EMBED !== '1')(
  'CLI exit codes — a command that genuinely loads the ONNX pipeline',
  () => {
    it('`mai search` exits 0 with no native abort', async () => {
      // THE ABORT REGRESSION TEST. Measured pre-fix on 2026-08-09: this exact
      // command printed its full result set and THEN died on a native abort with
      // one "mutex lock failed" line. Via execFile that surfaces as
      // signal='SIGABRT' (code null -> -1 here), NOT as 134 — 134 is the shell's
      // 128+6 encoding, which is what a terminal shows but Node never reports.
      const r = await cli(['search', 'bounded waits'], {
        MAI_EMBEDDINGS: '1',
        OPENAI_API_KEY: '',
        VOYAGE_API_KEY: '',
        MAI_PROJECT_SLUG: 'exitcode-test', // the fixture this file creates (R9)
      });
      expect(r.aborted).toBe(false);        // pre-fix: true
      expect(r.signal).toBeNull();          // pre-fix: 'SIGABRT'
      expect(r.code).toBe(0);               // pre-fix: -1 (execFile code is null)
      expect(r.out).toContain('## Decisions'); // it SUCCEEDED, not merely exited
    }, 300_000);
  }
);

describe('dashboard CLI exit-code and argv boundary', () => {
  let savedExitCode: number | string | null | undefined;

  beforeAll(() => { savedExitCode = process.exitCode; });
  afterEach(async () => {
    const dashboard = await import('../scripts/dashboard.js');
    vi.mocked(dashboard.dashboardRun).mockReset().mockResolvedValue(0);
    vi.mocked(dashboard.dashboardStart).mockReset().mockResolvedValue('started');
    vi.mocked(dashboard.dashboardStatus).mockReset().mockResolvedValue({ ok: true, text: 'Health: OK' });
    vi.mocked(dashboard.dashboardStop).mockReset().mockResolvedValue('stopped');
    const persistence = await import('../scripts/dashboard-persistence.js');
    vi.mocked(persistence.runPersistence).mockReset().mockResolvedValue({ ok: true, text: 'Supervisor loaded: yes' });
    const exit = await import('../exit.js');
    const actual = await vi.importActual<typeof import('../exit.js')>('../exit.js');
    vi.mocked(exit.finishAndExit).mockReset().mockImplementation(actual.finishAndExit);
    actual.__disarmExitWatchdogForTests();
    process.exitCode = savedExitCode;
    vi.restoreAllMocks();
  });

  async function isolatedRun(args: string[]) {
    const exit = await import('../exit.js');
    const finish = vi.mocked(exit.finishAndExit);
    finish.mockReset().mockImplementation(async code => { process.exitCode = code; });
    const { runCli } = await import('../cli.js');
    await runCli(args);
    return finish;
  }

  it.each([0, 3, 7, 143])('preserves dashboard run status %s through finishAndExit', async code => {
    const dashboard = await import('../scripts/dashboard.js');
    vi.mocked(dashboard.dashboardRun).mockResolvedValueOnce(code);
    const finish = await isolatedRun(['dashboard', 'run']);
    expect(finish).toHaveBeenCalledWith(code);
  });

  it.each([
    { tail: [] }, { tail: ['bogus'] }, { tail: ['start', '--extra'] }, { tail: ['status', 'extra'] },
    { tail: ['stop', '--force'] }, { tail: ['run', '--unknown', 'x'] }, { tail: ['run', '--launch-id'] },
    { tail: ['run', '--launch-id', LAUNCH_ID_FOR_CLI, '--launch-id', LAUNCH_ID_FOR_CLI] },
    { tail: ['run', 'extra'] }, { tail: ['run', '--env-file', '/definitely/missing/dashboard.env'] },
  ])('returns usage 2 before controller access for argv $tail', async ({ tail }) => {
    const dashboard = await import('../scripts/dashboard.js');
    const finish = await isolatedRun(['dashboard', ...tail]);
    expect(finish).toHaveBeenCalledWith(2);
    expect(dashboard.dashboardRun).not.toHaveBeenCalled();
    expect(dashboard.dashboardStart).not.toHaveBeenCalled();
    expect(dashboard.dashboardStatus).not.toHaveBeenCalled();
    expect(dashboard.dashboardStop).not.toHaveBeenCalled();
  });

  it('maps status output and health to separate text and exit status', async () => {
    const dashboard = await import('../scripts/dashboard.js');
    vi.mocked(dashboard.dashboardStatus).mockResolvedValueOnce({ ok: false, text: 'Health: STALE BUILD' });
    const output = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    const finish = await isolatedRun(['dashboard', 'status']);
    expect(finish).toHaveBeenCalledWith(1);
    expect(output).toHaveBeenCalledWith('Health: STALE BUILD\n');
  });

  it('routes controller rejection to exit 1', async () => {
    const dashboard = await import('../scripts/dashboard.js');
    vi.mocked(dashboard.dashboardStart).mockRejectedValueOnce(new Error('controller failed'));
    const error = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    const finish = await isolatedRun(['dashboard', 'start']);
    expect(finish).toHaveBeenCalledWith(1);
    expect(error).toHaveBeenCalledWith('error: controller failed\n');
  });

  it.each([
    ['persist'],
    ['persist', 'bogus'],
    ['persist', 'status', 'extra'],
    ['persist', 'status', '--unknown', '/tmp'],
    ['persist', 'status', '--checkout-root'],
    ['persist', 'status', '--checkout-root', 'relative'],
  ])('returns usage 2 before persistence access for argv %j', async (...tail) => {
    const persistence = await import('../scripts/dashboard-persistence.js');
    const finish = await isolatedRun(['dashboard', ...tail]);
    expect(finish).toHaveBeenCalledWith(2);
    expect(persistence.runPersistence).not.toHaveBeenCalled();
  });

  it('requires an explicit checkout root for Windows persistence install', async () => {
    const persistence = await import('../scripts/dashboard-persistence.js');
    vi.spyOn(process, 'platform', 'get').mockReturnValue('win32');
    const finish = await isolatedRun(['dashboard', 'persist', 'install']);
    expect(finish).toHaveBeenCalledWith(2);
    expect(persistence.runPersistence).not.toHaveBeenCalled();
  });

  it('maps persistence health separately from its text', async () => {
    const persistence = await import('../scripts/dashboard-persistence.js');
    vi.mocked(persistence.runPersistence).mockResolvedValueOnce({ ok: false, text: 'Health: UNHEALTHY' });
    const output = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    const finish = await isolatedRun(['dashboard', 'persist', 'status']);
    expect(finish).toHaveBeenCalledWith(1);
    expect(output).toHaveBeenCalledWith('Health: UNHEALTHY\n');
  });
});

describe('exit watchdog ordering (pass-2 B1)', () => {
  // EVERY case here MUST disarm. finishAndExit arms a real 2s process.exit()
  // timer, and `unref` only stops a timer HOLDING the loop open — it still
  // fires while something else does, and a test runner always has handles.
  // Without this the watchdog kills the vitest worker mid-run, two seconds
  // after the first case, and the failure looks like anything but its cause.
  afterEach(async () => {
    (await import('../exit.js')).__disarmExitWatchdogForTests();
  });

  it('arms the backstop BEFORE awaiting the pool close, so a wedged close still exits', async () => {
    // A pool close that never resolves is exactly what a checked-out client or
    // a query running under db.ts:19's 300s query_timeout produces. Arming the
    // watchdog after the await leaves this case with NO watchdog at all — the
    // process hangs, which is strictly worse than the bare process.exit(0) at
    // cli.ts:540 that this plan replaces.
    const { finishAndExit } = await import('../exit.js');
    // `null` is in the union (pass-3 B1): @types/node declares process.exitCode
    // as number | string | null | undefined, so omitting null is TS2322 under
    // strict — verified with tsc, not assumed.
    let codeWhenCloserRan: number | string | null | undefined = 'CLOSER-NEVER-RAN';
    await finishAndExit(0, async () => { codeWhenCloserRan = process.exitCode; });
    // The exit code was already recorded by the time the slow part started —
    // which is only true if the watchdog was armed first.
    expect(codeWhenCloserRan).toBe(0); // pre-fix (arm-after-await): undefined
  });

  it('a never-resolving close does not prevent the watchdog being armed', async () => {
    const { finishAndExit } = await import('../exit.js');
    const never = () => new Promise<void>(() => {}); // by design
    void finishAndExit(3, never);                    // never settles — do not await
    await new Promise((r) => setImmediate(r));
    expect(process.exitCode).toBe(3); // pre-fix: undefined, and the process hangs
  });
});

describe('web-server shutdown ordering (pass-4 B1)', () => {
  // MEASURED 2026-08-09: pool.end() does NOT kill an in-flight query — a
  // SELECT pg_sleep(1.5) issued beforehand returned its row normally. So the
  // BROKEN ordering (`server.close(); void closePool();`) still yields HTTP 200,
  // still exits 0, and still logs no abort. Every outcome-level assertion
  // passes under the bug. Only the ORDER distinguishes them, so the order is
  // what this test asserts — no sockets, no database, no race.

  it('does NOT close the pool until server.close() calls back', async () => {
    const { makeShutdown } = await import('../web-shutdown.js');
    const order: string[] = [];
    let closeCb: (() => void) | undefined;
    const shutdown = makeShutdown({
      server: {
        close: (cb) => { order.push('close'); closeCb = cb as () => void; return undefined; },
        closeIdleConnections: () => { order.push('idle'); },
      },
      arm: () => { order.push('arm'); },
      closePool: async () => { order.push('pool'); },
    });

    shutdown('SIGTERM');
    // The whole contract, in one assertion: armed first, pool NOT yet released.
    expect(order).toEqual(['arm', 'close', 'idle']); // broken: ['arm','close','pool','idle']

    closeCb?.();                     // in-flight handlers finished
    await Promise.resolve();
    expect(order).toEqual(['arm', 'close', 'idle', 'pool']);
  });

  it('is idempotent — a second signal arms no second watchdog', async () => {
    const { makeShutdown } = await import('../web-shutdown.js');
    let arms = 0;
    let closes = 0;
    const shutdown = makeShutdown({
      server: { close: () => { closes++; return undefined; }, closeIdleConnections: () => {} },
      arm: () => { arms++; },
      closePool: async () => {},
    });
    shutdown('SIGINT');
    shutdown('SIGTERM'); // realistic: Ctrl-C then a supervisor's TERM
    expect(arms).toBe(1);
    expect(closes).toBe(1);
  });
});

describe('web-server shutdown (pass-2 B2)', () => {
  it('serves a request and exits 0 on SIGTERM', async () => {
    // WIRING coverage, deliberately SEQUENTIAL — request completed and body
    // consumed BEFORE the signal, so nothing is ever in flight. Overlapping the
    // two proves nothing (measured: pool.end() does not kill an in-flight
    // query, so the BROKEN ordering passes every outcome assertion here) while
    // being the sole source of a connect-time race. In-flight protection is
    // proven by the Step 2b ORDERING test alone.
    //
    // What this case DOES catch, and nothing else does: web-server.ts failing
    // to register the signal handlers or to compose makeShutdown correctly —
    // a mistake Step 2b's unit tests pass straight through, surfacing here as
    // a child that never exits. Timeline with no overlap anywhere: response
    // consumed -> keep-alive socket idle -> SIGTERM -> arm(0) -> server.close(cb)
    // -> closeIdleConnections() evicts the idle socket -> callback -> closePool()
    // -> drain -> exit 0.
    const { spawn } = await import('node:child_process');
    const net = await import('node:net');

    // Dynamic port (pass-3 W4): a hardcoded 6699 fails as EADDRINUSE against
    // anything already bound, and that failure looks nothing like its cause.
    const port = await new Promise<number>((resolve) => {
      const probe = net.createServer();
      probe.listen(0, '127.0.0.1', () => {
        const p = (probe.address() as import('node:net').AddressInfo).port;
        probe.close(() => resolve(p));
      });
    });

    const srv = spawn('node', ['build/web-server.js'], {
      env: {
        ...process.env,
        MAI_DB_URL: DB,
        MAI_BRAIN_WEB_PORT: String(port),
        MAI_BRAIN_WEB_BIND: '127.0.0.1', // keeps requireToken false — no auth needed
        MAI_PROJECT_SLUG: 'exitcode-test', // explicit (pass-3 B5): never inherit the runner's pin
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    try {
      let out = '';
      srv.stdout.on('data', (d) => { out += String(d); });
      srv.stderr.on('data', (d) => { out += String(d); });

      // Register the exit promise BEFORE anything can kill the child (pass-3
      // B5). Attaching srv.on('exit') after awaiting the response loses an
      // already-emitted event, and the test then hangs to its timeout.
      const exited = new Promise<number>((resolve) => srv.on('exit', (c) => resolve(c ?? -1)));

      // Wait for the listening line rather than sleeping a guessed interval.
      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error(`server never listened: ${out}`)), 20_000);
        const check = setInterval(() => {
          if (out.includes('listening on')) { clearInterval(check); clearTimeout(timer); resolve(); }
        }, 100);
      });

      // Query the FIXTURE this file creates, not a real project (pass-3 B5 —
      // `mai-mcp-self` need not exist on a clean database).
      const res = await fetch(`http://127.0.0.1:${port}/api/search?q=bounded&project=exitcode-test`);
      expect(res.status).toBe(200);
      await res.text();               // consume the body fully — socket idle, nothing in flight
      srv.kill('SIGTERM');
      expect(await exited).toBe(0);   // arm(0) → close → closeIdleConnections → drain
      expect(out).not.toContain('mutex lock failed');
    } finally {
      srv.kill('SIGKILL'); // never leak a child, however this case ends
    }
  }, 60_000);
});

describe('plan 15: injected argv authority and the entry.js dispatcher contract', () => {
  it('main derives every repeated flag from the injected argv, never process.argv', async () => {
    const { main } = await import('../cli.js');
    const init = await import('../scripts/init.js');
    const runInitMock = vi.mocked(init.runInit);
    runInitMock.mockClear();

    const originalLength = process.argv.length;
    process.argv.push(
      '--repo', '/decoy-repo', '--repo-map', 'decoy-old', '/decoy-new',
      '--exclude', '/decoy-exclude', '--harness', 'decoy',
    );
    try {
      await main([
        'init', 'argv-inject', '--root', '/injected-root',
        '--replace-repos',
        '--repo', '/injected-a', '--repo', '/injected-b',
        '--repo-map', 'legacy-a', '/injected-a',
        '--repo-map', '/missing-b', '/injected-b',
        '--exclude', 'ex-a', '--exclude', 'ex-b',
        '--harness', 'claude-code', '--harness', 'codex',
      ]);
    } finally {
      process.argv.length = originalLength;
    }
    expect(runInitMock).toHaveBeenCalledTimes(1);
    const args = runInitMock.mock.calls[0][0];
    expect(args.repos).toEqual(['/injected-a', '/injected-b']);
    expect(args.replaceRepos).toBe(true);
    expect(args.repoMaps).toEqual([
      { storedRoot: 'legacy-a', targetRoot: '/injected-a' },
      { storedRoot: '/missing-b', targetRoot: '/injected-b' },
    ]);
    expect(args.excludes).toEqual(['ex-a', 'ex-b']);
    expect(args.harnesses).toEqual(['claude-code', 'codex']);
    expect(JSON.stringify(args)).not.toContain('decoy');
  });

  it('rejects an incomplete or flag-bearing injected --repo-map pair before init', async () => {
    const { main } = await import('../cli.js');
    const init = await import('../scripts/init.js');
    const runInitMock = vi.mocked(init.runInit);
    runInitMock.mockClear();
    await expect(main([
      'init', 'argv-map-bad', '--root', '/root', '--replace-repos', '--repo', '/repo',
      '--repo-map', 'legacy-only', '--yes',
    ])).rejects.toThrow('--repo-map requires adjacent');
    expect(runInitMock).not.toHaveBeenCalled();
  });

  it('entry.js: a DB-backed success and an unknown-project failure carry exact statuses', async () => {
    const okRun = await run('node', ['build/entry.js', 'projects'], {
      env: { ...process.env, MAI_DB_URL: DB },
      timeout: 60_000,
      cwd: process.cwd(),
    });
    expect((okRun.stdout + okRun.stderr).length).toBeGreaterThan(0);

    try {
      await run('node', ['build/entry.js', 'verify', 'no-such-project-slug'], {
        env: { ...process.env, MAI_DB_URL: DB },
        timeout: 60_000,
        cwd: process.cwd(),
      });
      throw new Error('expected exit 1');
    } catch (err) {
      const e = err as { code?: number; killed?: boolean; stdout?: string; stderr?: string };
      if (e.killed) throw new Error('entry.js verify HUNG (killed at timeout)');
      expect(e.code).toBe(1);
      // The normalized error line proves the runCli drain path ran — a bare
      // main() mutant surfaces an unhandled rejection stack instead.
      expect(e.stderr ?? '').toContain('error: Project not found');
      expect(e.stderr ?? '').not.toContain('UnhandledPromiseRejection');
    }
  }, 120_000);
});

describe('plan 15 task 6: skills verb and the dispatcher boundary', () => {
  it('`mai skills status` reports with exit 0 against a temp home; bad args exit 1', async () => {
    const home = await mkdtemp(join(tmpdir(), 'exitcode-skills-home-'));
    const ok = await cli(['skills', 'status'], { HOME: home, CODEX_HOME: join(home, '.codex') });
    expect(ok.code).toBe(0);
    expect(ok.out).toContain('claude skills:');
    expect(ok.out).toContain('skills: OK');

    const bad = await cli(['skills', 'bogus-action'], { HOME: home });
    expect(bad.code).toBe(1);
    expect(bad.out).toContain('usage: mai skills');

    const badScope = await cli(['skills', 'status', '--codex-scope', 'galaxy'], { HOME: home });
    expect(badScope.code).toBe(1);
    expect(badScope.out).toContain('--codex-scope must be');
  }, 120_000);

  it('`setup` is NOT a cli.js command — the dispatcher owns it before cli/env load', async () => {
    const r = await cli(['setup', '--yes']);
    expect(r.code).toBe(1);
    expect(r.out).toContain("unknown command 'setup'");
  }, 60_000);

  it('the real built CLI installs repo-scope skills from a consumer cwd with the MAI_ROOT checker', async () => {
    const home = await mkdtemp(join(tmpdir(), 'exitcode-closure-home-'));
    const consumer = await mkdtemp(join(tmpdir(), 'exitcode-closure-consumer-'));
    await run('git', ['init', '-q'], { cwd: consumer });
    // Decoy checker in the consumer: the real MAI_ROOT checker must run instead.
    const marker = join(consumer, 'decoy-ran.marker');
    const { mkdir, writeFile } = await import('node:fs/promises');
    await mkdir(join(consumer, 'scripts'), { recursive: true });
    await writeFile(
      join(consumer, 'scripts', 'check-skills.mjs'),
      `import { writeFileSync } from 'node:fs';\nwriteFileSync(${JSON.stringify(marker)}, 'decoy');\nprocess.exit(0);\n`
    );
    const entryAbs = join(process.cwd(), 'build', 'entry.js');
    const r = await run('node', [entryAbs, 'skills', 'install', '--target', 'codex', '--codex-scope', 'repo'], {
      env: { ...process.env, MAI_DB_URL: DB, HOME: home, CODEX_HOME: join(home, '.codex') },
      cwd: consumer,
      timeout: 120_000,
    }).then(
      (r2) => ({ code: 0, out: r2.stdout + r2.stderr }),
      (e: { code?: number; stdout?: string; stderr?: string }) => ({
        code: typeof e.code === 'number' ? e.code : -1,
        out: (e.stdout ?? '') + (e.stderr ?? ''),
      })
    );
    expect(r.code).toBe(0);
    const { existsSync } = await import('node:fs');
    expect(existsSync(marker)).toBe(false); // decoy never ran
    expect(existsSync(join(consumer, '.agents', 'skills', 'plan-review', 'SKILL.md'))).toBe(true);
  }, 180_000);
});
