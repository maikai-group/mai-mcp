/** codex-cli provider against the fake binary — no subscription, no network.
 * Mirrors llm-claude-code.test.ts's fixture pattern (plan 13). The live
 * subscription smoke lives in llm-codex-cli-live.test.ts (MAI_TEST_CODEX=1) —
 * separate file because THIS suite pins MAI_CC_TIMEOUT_MS=2000 at module load. */
import { beforeAll, afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { installFakeToolFromFile } from './support/fake-tool.js';

const fixturesSrc = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures', 'codex-bin');
const realPath = process.env.PATH ?? '';
// SIDECAR MODE CHANNEL (review pass-4 B1): the allowlist child env (decision
// 48797d3e) strips MAI_CODEX_FIXTURE from `codex exec` spawns, so EXEC modes
// ride a `mode` file next to a TEMP COPY of the fixture — the repo copy stays
// pristine (the mode file is per-suite mutable state), and PATH itself is
// allowlisted so the temp dir reaches the child. LOGIN/detection modes keep
// the env var: codexBinaryAvailable() is spawnSync with inherited process.env.
// NEVER add fixture vars to the production allowlist to dodge this.
const fixturesBin = fs.mkdtempSync(path.join(os.tmpdir(), 'mai-fixture-codex-'));
const setMode = (mode: string): void => {
  fs.writeFileSync(path.join(fixturesBin, 'mode'), mode);
};
const clearMode = (): void => {
  fs.rmSync(path.join(fixturesBin, 'mode'), { force: true });
};

async function mockTreeCleanup(): Promise<ReturnType<typeof vi.fn>> {
  const platform = await import('../platform/processes.js');
  const base = platform.defaultProcessOps();
  const terminateTree = vi.fn(async (pid: number, authorize?: () => Promise<boolean>) => {
    if (!authorize || await authorize()) process.kill(pid, 'SIGKILL');
  });
  vi.spyOn(platform, 'defaultProcessOps').mockReturnValue({
    ...base, processBirthId: async () => 'birth', terminateTree,
  });
  return terminateTree;
}

/** Cast-free field access on unknown (global lesson 293a39bc): Object.entries
 * + typeof narrowing — no `as` anywhere in this file. */
function stringField(v: unknown, key: string): string {
  if (typeof v === 'object' && v !== null) {
    for (const [k, val] of Object.entries(v)) {
      if (k === key && typeof val === 'string') return val;
    }
  }
  throw new Error(`missing string field '${key}' in ${JSON.stringify(v)}`);
}

/** Git Bash reports `$PWD` as an MSYS path (`/c/…`), never the Windows path the
 * product spawned with — compare the two cwds on one shape. Byte equality
 * everywhere else. */
function samePath(a: string, b: string): boolean {
  if (process.platform !== 'win32') return a === b;
  const native = (p: string): string => {
    const msys = /^\/([A-Za-z])\/(.*)$/u.exec(p);
    return (msys ? `${msys[1]}:\\${msys[2]}` : p).replace(/\//gu, '\\').toLowerCase();
  };
  return native(a) === native(b);
}

/** R4 leak detector: snapshot-diff of mai-codex-* dirs in the OS tmpdir. */
const listTmpDirs = (): string[] =>
  fs.readdirSync(os.tmpdir()).filter((d) => d.startsWith('mai-codex-')).sort();

const FILE_ENV_KEYS: readonly string[] = [
  'MAI_LLM_FALLBACK_PROVIDER', 'MAI_CODEX_CLI_MODEL', 'MAI_CODEX_CLI_REASONING',
];
const fileEnvSaved: Record<string, string | undefined> = {};

beforeAll(async () => {
  // The shared installer, not a copy+chmod: Windows cannot execute a `#!/bin/sh`
  // file, so the fake becomes a shim + Git Bash body there (support/fake-tool.ts).
  installFakeToolFromFile(fixturesBin, 'codex', path.join(fixturesSrc, 'codex'));
  process.env.PATH = `${fixturesBin}${path.delimiter}${realPath}`;
  process.env.MAI_CC_TIMEOUT_MS = '2000'; // the SHARED subscription-provider bound (spec §2) — hang-mode test
  // DOTENV TIME BOMB DEFUSAL (plan-13 pass-2 B1 class): src/env.ts's dotenv
  // config() re-fills DELETED vars from the real checkout .env at ITS load
  // time. The burst-guardrail cases import ../scripts/reingest.js (→ env.ts)
  // mid-suite; force that load NOW so the detection/status cases' deletes of
  // MAI_SUMMARY_MODEL / provider vars stick on machines with a populated .env.
  await import('../env.js');
  for (const k of FILE_ENV_KEYS) fileEnvSaved[k] = process.env[k];
});
afterAll(() => {
  process.env.PATH = realPath;
  delete process.env.MAI_CC_TIMEOUT_MS;
  delete process.env.MAI_CODEX_FIXTURE;
  for (const k of FILE_ENV_KEYS) {
    const value = fileEnvSaved[k];
    if (value === undefined) delete process.env[k];
    else process.env[k] = value;
  }
  fs.rmSync(fixturesBin, { recursive: true, force: true });
});
beforeEach(async () => {
  vi.restoreAllMocks();
  const { resetCodexBinaryProbe } = await import('../llm/codex-cli.js');
  resetCodexBinaryProbe();
  delete process.env.MAI_CODEX_FIXTURE; // login-channel reset
  delete process.env.MAI_LLM_FALLBACK_PROVIDER;
  delete process.env.MAI_CODEX_CLI_MODEL;
  delete process.env.MAI_CODEX_CLI_REASONING;
  clearMode(); // exec-channel reset
});

describe('CodexCliProvider (fake binary)', () => {
  const call = async (
    model?: string,
    prompt = 'p',
    reasoning?: 'low' | 'medium' | 'high' | 'xhigh' | 'max'
  ) => {
    const { CodexCliProvider } = await import('../llm/codex-cli.js');
    return new CodexCliProvider(model, reasoning).completeJSON({
      prompt,
      schema: { type: 'object', properties: {} },
      schemaName: 't',
      maxTokens: 100,
    });
  };

  it('happy path: result comes from the -o file; stdout progress noise is never parsed', async () => {
    expect(await call()).toEqual({ ok: true, n: 3 });
  });
  it('invocation shape: exec + read-only sandbox + skip-git-repo-check + ephemeral + schema/out temp files + `-` positional', async () => {
    setMode('args');
    const argv = stringField(await call(), 'argv');
    expect(argv).toContain('exec');
    expect(argv).toContain('-s read-only');
    expect(argv).toContain('--skip-git-repo-check');
    expect(argv).toContain('--ephemeral');
    expect(argv).toMatch(/--output-schema \S*mai-codex-\S*schema\.json/);
    expect(argv).toMatch(/-o \S*mai-codex-\S*out\.json/);
    expect(argv.endsWith(' -')).toBe(true); // the prompt rides STDIN via the `-` positional
  });
  it('-m passthrough: present when a model is set, absent otherwise (null-model semantics)', async () => {
    setMode('args');
    expect(stringField(await call('gpt-5.6-luna'), 'argv')).toContain('-m gpt-5.6-luna');
    expect(stringField(await call(undefined), 'argv')).not.toContain('-m ');
  });
  it('reasoning passthrough: uses a typed config override only when set', async () => {
    setMode('args');
    expect(stringField(await call('gpt-5.6-terra', 'p', 'medium'), 'argv'))
      .toContain('-c model_reasoning_effort=medium');
    expect(stringField(await call('gpt-5.6-terra'), 'argv')).not.toContain('model_reasoning_effort');
  });
  it('prompt reaches the child via STDIN, never argv', async () => {
    setMode('stdinecho');
    expect(await call(undefined, 'ping')).toEqual({ prompt: 'ping' });
  });
  it('schema round-trips byte-exact through the --output-schema temp file', async () => {
    setMode('schema');
    const { CodexCliProvider } = await import('../llm/codex-cli.js');
    const result = await new CodexCliProvider().completeJSON({
      prompt: 'p',
      schema: {
        type: 'object',
        properties: { ok: { type: 'boolean' }, word: { type: 'string' } },
        required: ['ok', 'word'],
        additionalProperties: false,
      },
      schemaName: 't',
      maxTokens: 100,
    });
    expect(result).toEqual({
      type: 'object',
      properties: { ok: { type: 'boolean' }, word: { type: 'string' } },
      required: ['ok', 'word'],
      additionalProperties: false,
    });
  });
  it('garbage in the -o file → null', async () => {
    setMode('garbage');
    expect(await call()).toBeNull();
  });
  it('exit 0 but no -o file written → null', async () => {
    setMode('noout');
    expect(await call()).toBeNull();
  });
  it('non-zero exit → null', async () => {
    setMode('exit1');
    expect(await call()).toBeNull();
  });
  it('happy path leaves no mai-codex-* temp dirs behind (R4)', async () => {
    const before = listTmpDirs();
    expect(await call()).toEqual({ ok: true, n: 3 });
    expect(listTmpDirs().filter((dir) => !before.includes(dir))).toEqual([]);
  });
  it('schema-write failure (cyclic schema) → null, no mai-codex-* temp dir leaked (R4 init path, review B1)', async () => {
    const before = listTmpDirs();
    // Cast-free fault injection: JSONSchema's properties are Record<string,
    // unknown>, so a cyclic value is admitted at compile time and makes
    // JSON.stringify throw AFTER mkdtempSync succeeds — the exact init-path
    // leak window B1 named. Cleanup must already exist by then.
    const cyclic: Record<string, unknown> = {};
    cyclic.self = cyclic;
    const { CodexCliProvider } = await import('../llm/codex-cli.js');
    const result = await new CodexCliProvider().completeJSON({
      prompt: 'p',
      schema: { type: 'object', properties: { loop: cyclic } },
      schemaName: 't',
      maxTokens: 100,
    });
    expect(result).toBeNull();
    expect(listTmpDirs().filter((dir) => !before.includes(dir))).toEqual([]);
  });
  it('hang → bounded timeout → null; temp files cleaned on the KILL path (R4)', async () => {
    setMode('hang');
    await mockTreeCleanup();
    const before = listTmpDirs();
    expect(await call()).toBeNull();
    await new Promise((r) => setTimeout(r, 300)); // close trails the kill
    expect(listTmpDirs().filter((dir) => !before.includes(dir))).toEqual([]);
  }, 10_000);
  it('timeout logs its reason ONCE — the trailing close after SIGKILL is silent', async () => {
    setMode('hang');
    const terminateTree = await mockTreeCleanup();
    const warns: string[] = [];
    const spy = vi.spyOn(console, 'warn').mockImplementation((...a: unknown[]) => {
      warns.push(a.join(' '));
    });
    try {
      expect(await call()).toBeNull();
      await new Promise((r) => setTimeout(r, 300));
    } finally {
      spy.mockRestore();
    }
    expect(warns.filter((w) => w.includes('codex exec'))).toEqual(['[mai-llm] codex exec timed out']);
    expect(terminateTree).toHaveBeenCalledTimes(1);
  }, 10_000);
  it('EPIPE: child exits without reading a large stdin → null, process survives, close prints the exit diagnosis', async () => {
    setMode('noread');
    const before = listTmpDirs(); // R4: the stdin-'error' exit path gets its own snapshot (review pass-4 W3)
    const warns: string[] = [];
    const spy = vi.spyOn(console, 'warn').mockImplementation((...a: unknown[]) => {
      warns.push(a.join(' '));
    });
    const { CodexCliProvider } = await import('../llm/codex-cli.js');
    let result: unknown;
    try {
      result = await new CodexCliProvider().completeJSON({
        prompt: 'x'.repeat(300_000), // > pipe buffer → chunked write → EPIPE mid-write
        schema: { type: 'object', properties: {} },
        schemaName: 't',
        maxTokens: 100,
      });
      await new Promise((r) => setTimeout(r, 300)); // close trails the EPIPE settle
    } finally {
      spy.mockRestore();
    }
    expect(result).toBeNull(); // an unhandled stream error would kill the worker instead
    expect(warns.filter((w) => w.includes('codex exec exited'))).toHaveLength(1);
    expect(listTmpDirs().filter((dir) => !before.includes(dir))).toEqual([]); // all four exit paths pinned (review pass-4 W3)
  });
  // Gated on Windows: POSIX pid/signal semantics — the fixture's `$$` is Git Bash's MSYS pid (support/fake-tool.ts).
  it.skipIf(process.platform === 'win32')('stdin error with a still-ALIVE child → SIGKILL, null, cleanup holds, diagnosis never duplicated (pass-5 B2)', async () => {
    setMode('stdinclose'); // fixture closes fd 0, writes its PID to the sidecar dir, then sleeps past the 2s bound
    const terminateTree = await mockTreeCleanup();
    const before = listTmpDirs();
    const warns: string[] = [];
    const spy = vi.spyOn(console, 'warn').mockImplementation((...a: unknown[]) => {
      warns.push(a.join(' '));
    });
    const { CodexCliProvider } = await import('../llm/codex-cli.js');
    let result: unknown;
    try {
      result = await new CodexCliProvider().completeJSON({
        prompt: 'x'.repeat(300_000), // chunked write onto the closed fd → EPIPE with the child STILL RUNNING
        schema: { type: 'object', properties: {} },
        schemaName: 't',
        maxTokens: 100,
      });
      await new Promise((r) => setTimeout(r, 300)); // close trails the kill
    } finally {
      spy.mockRestore();
    }
    expect(result).toBeNull();
    // The handler must have SIGKILLed the child — without the fix it would
    // still be inside its 5s sleep here (signal 0 = existence probe).
    const pid = Number(fs.readFileSync(path.join(fixturesBin, 'pid'), 'utf8').trim());
    let alive = true;
    try {
      process.kill(pid, 0);
    } catch {
      alive = false;
    }
    expect(alive).toBe(false);
    expect(terminateTree).toHaveBeenCalledTimes(1);
    expect(listTmpDirs().filter((dir) => !before.includes(dir))).toEqual([]); // cleanup held on this path too (R4)
    expect(warns.filter((w) => w.includes('codex exec exited'))).toHaveLength(1); // diagnosed, never duplicated
  });
  // Gated on Windows: POSIX pid/signal semantics — the fixture's `$$` is Git Bash's MSYS pid (support/fake-tool.ts).
  it.skipIf(process.platform === 'win32')('unknown birth identity refuses tree signals while streams and owned temp files are cleaned', async () => {
    setMode('stdinclose');
    const platform = await import('../platform/processes.js');
    const base = platform.defaultProcessOps();
    const terminateTree = vi.fn(async () => undefined);
    vi.spyOn(platform, 'defaultProcessOps').mockReturnValue({
      ...base, processBirthId: async () => null, terminateTree,
    });
    expect(await call()).toBeNull();
    expect(terminateTree).not.toHaveBeenCalled();
    const pid = Number(fs.readFileSync(path.join(fixturesBin, 'pid'), 'utf8').trim());
    try { process.kill(pid, 'SIGKILL'); } catch { /* fixture may have exited */ }
  }, 10_000);
  it('recycled birth makes authorization false and cleanup rejection remains single-flight', async () => {
    setMode('hang');
    const platform = await import('../platform/processes.js');
    const base = platform.defaultProcessOps();
    let births = 0;
    const authorized: boolean[] = [];
    const terminateTree = vi.fn(async (pid: number, authorize?: () => Promise<boolean>) => {
      authorized.push(authorize ? await authorize() : true);
      process.kill(pid, 'SIGKILL');
      throw new Error('fixture cleanup rejection');
    });
    vi.spyOn(platform, 'defaultProcessOps').mockReturnValue({
      ...base, processBirthId: async () => ++births === 1 ? 'old-birth' : 'new-birth', terminateTree,
    });
    expect(await call()).toBeNull();
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(authorized).toEqual([false]);
    expect(terminateTree).toHaveBeenCalledTimes(1);
  }, 10_000);
  it('SPAWNS from the stable scratch cwd — the recursion/trust guard itself', async () => {
    setMode('cwd');
    const { codexScratchCwd } = await import('../llm/codex-cli.js');
    expect(samePath(stringField(await call(), 'cwd'), codexScratchCwd())).toBe(true); // fixture echoes $PWD
  });
  it('AUTH SCRUB (allowlist SHAPE, R3 / decision 48797d3e): creds AND an unrelated canary absent by construction; HOME/PATH present', async () => {
    const saved: Record<string, string | undefined> = {};
    for (const k of ['OPENAI_API_KEY', 'ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN', 'MAI_TEST_CANARY_SECRET']) saved[k] = process.env[k];
    process.env.OPENAI_API_KEY = 'sk-openai-must-not-leak';
    process.env.ANTHROPIC_API_KEY = 'sk-ant-must-not-leak';
    process.env.ANTHROPIC_AUTH_TOKEN = 'oat-must-not-leak';
    // The canary is the ALLOWLIST's proof: no scrub rule ever names it, yet it
    // must not reach the child — exclusion by construction, not by enumeration.
    process.env.MAI_TEST_CANARY_SECRET = 'canary-must-not-leak';
    setMode('envcheck');
    let result: unknown;
    try {
      result = await call();
    } finally {
      // Restore, never delete: OPENAI_API_KEY is pinned '' at the vitest runner
      // boundary and a later file's dotenv load would refill a DELETED key from
      // the real checkout .env (lesson 57ac4b5a).
      for (const [k, v] of Object.entries(saved)) {
        if (v === undefined) delete process.env[k];
        else process.env[k] = v;
      }
    }
    expect(result).toEqual({
      openai: 'absent',
      anthropicKey: 'absent',
      anthropicToken: 'absent',
      canary: 'absent',
      home: 'present',
      path: 'present',
    });
  });
});

describe('subscriptionChildEnv (direct unit — the FULL contract, review pass-4 W1)', () => {
  // The envcheck SHAPE tests prove the headline fields end-to-end through a
  // real spawn; these pin every remaining contract field directly so a
  // refactor cannot silently drop one while the shape tests stay green.
  // Placed in THIS file (not a new one) so the cases ride the existing
  // check:casts ratchet entry. Cast-free throughout.
  const STATIC_VARS: readonly string[] = [
    'PATH', 'HOME', 'USER', 'TERM', 'LANG',
    'HTTP_PROXY', 'HTTPS_PROXY', 'NO_PROXY', 'ALL_PROXY',
    'http_proxy', 'https_proxy', 'no_proxy', 'all_proxy',
    'SSL_CERT_FILE', 'SSL_CERT_DIR', 'NODE_EXTRA_CA_CERTS',
  ];
  // A Map, not an object literal (pass-5 W1): `'constructor' in {}` is TRUE
  // via the prototype chain, so an object-keyed capture guard would silently
  // skip saving the very prototype-named vars this describe exists to test —
  // and leak them into every later suite of the shared process.
  const saved = new Map<string, string | undefined>();
  const setVar = (k: string, v: string | undefined): void => {
    if (!saved.has(k)) saved.set(k, process.env[k]);
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  };
  afterEach(() => {
    // Restore-exactly (set-don't-delete discipline, lesson 57ac4b5a).
    for (const [k, v] of saved) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
    saved.clear();
  });

  it('copies every static allowlist var that is set', async () => {
    const { subscriptionChildEnv } = await import('../llm/child-env.js');
    for (const k of STATIC_VARS) setVar(k, `val-${k}`);
    const env = subscriptionChildEnv();
    if (process.platform === 'win32') {
      // Windows env names are case-insensitive: HTTP_PROXY and http_proxy are
      // ONE variable, so each cased pair collapses to the casing written last.
      // Still exhaustive — every allowlist var must cross, carrying a value
      // this test assigned to that name.
      const crossed = new Map<string, string>();
      for (const [k, v] of Object.entries(env)) crossed.set(k.toLowerCase(), v);
      for (const k of STATIC_VARS) {
        expect(crossed.get(k.toLowerCase())).toMatch(new RegExp(`^val-${k}$`, 'iu'));
      }
      return;
    }
    for (const k of STATIC_VARS) expect(env[k]).toBe(`val-${k}`);
  });
  it('USER crosses when set — proven required for claude CLI stored-login resolution (decision 3be62c3b)', async () => {
    // Execution-time amendment: the Task 5 Step 4 live smoke failed CLOSED with
    // "Not logged in · Please run /login" until USER was allowlisted (isolated
    // 2/2 in both polarities against TMPDIR/LOGNAME/SHELL). First application
    // of the add-with-a-test rule that decision 48797d3e wrote into this file.
    const { subscriptionChildEnv } = await import('../llm/child-env.js');
    setVar('USER', 'fixture-user');
    expect(subscriptionChildEnv().USER).toBe('fixture-user');
    setVar('USER', undefined);
    expect(Object.keys(subscriptionChildEnv())).not.toContain('USER');
  });
  it('omits an unset allowlist var instead of inventing it', async () => {
    const { subscriptionChildEnv } = await import('../llm/child-env.js');
    setVar('SSL_CERT_FILE', undefined);
    expect(Object.keys(subscriptionChildEnv())).not.toContain('SSL_CERT_FILE');
  });
  it('copies LC_* variables dynamically (prefix rule, not enumeration)', async () => {
    const { subscriptionChildEnv } = await import('../llm/child-env.js');
    setVar('LC_ALL', 'en_CA.UTF-8');
    setVar('LC_MESSAGES', 'fr_CA.UTF-8');
    const env = subscriptionChildEnv();
    expect(env.LC_ALL).toBe('en_CA.UTF-8');
    expect(env.LC_MESSAGES).toBe('fr_CA.UTF-8');
  });
  it('extras are opt-in per provider: CODEX_HOME / CLAUDE_CONFIG_DIR cross only when requested', async () => {
    const { subscriptionChildEnv } = await import('../llm/child-env.js');
    setVar('CODEX_HOME', '/tmp/codex-home');
    setVar('CLAUDE_CONFIG_DIR', '/tmp/claude-config');
    expect(subscriptionChildEnv(['CODEX_HOME']).CODEX_HOME).toBe('/tmp/codex-home');
    expect(Object.keys(subscriptionChildEnv(['CODEX_HOME']))).not.toContain('CLAUDE_CONFIG_DIR');
    expect(subscriptionChildEnv(['CLAUDE_CONFIG_DIR']).CLAUDE_CONFIG_DIR).toBe('/tmp/claude-config');
    expect(Object.keys(subscriptionChildEnv())).not.toContain('CODEX_HOME');
  });
  it('an unrelated canary never crosses (exclusion by construction)', async () => {
    const { subscriptionChildEnv } = await import('../llm/child-env.js');
    setVar('MAI_TEST_CANARY_SECRET', 'canary-must-not-leak');
    expect(Object.keys(subscriptionChildEnv())).not.toContain('MAI_TEST_CANARY_SECRET');
  });
  it('prototype-like env names never cross (constructor / toString / hasOwnProperty)', async () => {
    const { subscriptionChildEnv } = await import('../llm/child-env.js');
    for (const k of ['constructor', 'toString', 'hasOwnProperty']) setVar(k, 'polluted');
    const keys = Object.keys(subscriptionChildEnv());
    for (const k of ['constructor', 'toString', 'hasOwnProperty']) {
      expect(keys).not.toContain(k);
    }
  });
});

describe('detection + status', () => {
  // These cases use the ENV mode channel (MAI_CODEX_FIXTURE): the login probe
  // is spawnSync with the full inherited process.env — the allowlist never
  // applies here. Exec-mode cases above use the sidecar file instead.
  // House-style env save/restore (mirrors llm-claude-code.test.ts).
  const saved: Record<string, string | undefined> = {};
  beforeAll(() => {
    for (const k of [
      'MAI_LLM_SUMMARY', 'MAI_LLM_PROVIDER', 'MAI_SUMMARY_MODEL', 'OPENAI_API_KEY',
    ]) saved[k] = process.env[k];
  });
  afterAll(() => {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  });
  it('resolves codex-cli only with flag + passing login probe; logged-out or missing binary → null', async () => {
    const { detectLLMProviderId } = await import('../llm/provider.js');
    const { resetCodexBinaryProbe } = await import('../llm/codex-cli.js');
    process.env.MAI_LLM_SUMMARY = '1';
    process.env.MAI_LLM_PROVIDER = 'codex-cli';
    delete process.env.MAI_LLM_FALLBACK_PROVIDER;
    delete process.env.MAI_SUMMARY_MODEL;
    resetCodexBinaryProbe();
    expect(detectLLMProviderId()).toBe('codex-cli'); // fake binary: login status exits 0
    process.env.MAI_CODEX_FIXTURE = 'loggedout';
    resetCodexBinaryProbe();
    expect(detectLLMProviderId()).toBeNull(); // logged out → probe exits 1 → null
    delete process.env.MAI_CODEX_FIXTURE;
    try {
      process.env.PATH = '/nonexistent-mai-test';
      resetCodexBinaryProbe();
      expect(detectLLMProviderId()).toBeNull(); // no binary at all
    } finally {
      // try/finally (review N3): a mid-case assertion failure must not strand
      // the broken PATH for every later case in this file.
      process.env.PATH = `${fixturesBin}${path.delimiter}${realPath}`;
    }
  });
  it("summaryModel: unset → '' (no -m flag); MAI_SUMMARY_MODEL overrides", async () => {
    const { summaryModel } = await import('../llm/provider.js');
    delete process.env.MAI_SUMMARY_MODEL;
    expect(summaryModel('codex-cli')).toBe('');
    process.env.MAI_SUMMARY_MODEL = 'gpt-5.6-luna';
    expect(summaryModel('codex-cli')).toBe('gpt-5.6-luna');
    delete process.env.MAI_SUMMARY_MODEL;
  });
  it('status lines: subscription wording when resolved; login-aware reason when not', async () => {
    const { llmProviderStatus } = await import('../llm/provider.js');
    const { resetCodexBinaryProbe } = await import('../llm/codex-cli.js');
    process.env.MAI_LLM_SUMMARY = '1';
    process.env.MAI_LLM_PROVIDER = 'codex-cli';
    delete process.env.MAI_LLM_FALLBACK_PROVIDER;
    delete process.env.MAI_CODEX_CLI_MODEL;
    delete process.env.MAI_CODEX_CLI_REASONING;
    delete process.env.MAI_SUMMARY_MODEL;
    resetCodexBinaryProbe();
    expect(llmProviderStatus()).toBe('enabled — provider: codex-cli (subscription), model: Codex default');
    process.env.MAI_CODEX_FIXTURE = 'loggedout';
    resetCodexBinaryProbe();
    expect(llmProviderStatus()).toBe(
      "enabled flag set but provider 'codex-cli' is not configured (codex binary not found on PATH or not logged in)."
    );
    delete process.env.MAI_CODEX_FIXTURE;
  });

  it('reports an API primary and ready subscription fallback in execution order', async () => {
    const { detectLLMProviderId, detectLLMProviderIds } = await import('../llm/provider.js');
    const { resetCodexBinaryProbe } = await import('../llm/codex-cli.js');
    process.env.MAI_LLM_SUMMARY = '1';
    process.env.MAI_LLM_PROVIDER = 'openai';
    process.env.OPENAI_API_KEY = 'test-only';
    process.env.MAI_LLM_FALLBACK_PROVIDER = 'codex-cli';
    resetCodexBinaryProbe();
    expect(detectLLMProviderId()).toBe('openai');
    expect(detectLLMProviderIds()).toEqual(['openai', 'codex-cli']);
  });
});

describe('subscriptionBurstWarning (spec §5 reingest guardrail)', () => {
  it('warns for codex-cli past the transcript threshold, naming the subscription', async () => {
    const { subscriptionBurstWarning } = await import('../scripts/reingest.js');
    const w = subscriptionBurstWarning(['codex-cli'], 11);
    expect(w).toContain('ChatGPT (Codex)');
    expect(w).toContain('11 transcript(s)');
    expect(w).toContain('--dry-run');
  });
  it('still warns for claude-code (plan-13 behavior preserved)', async () => {
    const { subscriptionBurstWarning } = await import('../scripts/reingest.js');
    expect(subscriptionBurstWarning(['claude-code'], 11)).toContain('Claude Code');
  });
  it('warns when an API primary can fall back to a subscription provider', async () => {
    const { subscriptionBurstWarning } = await import('../scripts/reingest.js');
    const warning = subscriptionBurstWarning(['openai', 'codex-cli'], 11);
    expect(warning).toContain('ChatGPT (Codex)');
  });
  it('never warns for API-key providers, below threshold, or unresolved', async () => {
    const { subscriptionBurstWarning } = await import('../scripts/reingest.js');
    expect(subscriptionBurstWarning(['anthropic'], 500)).toBeNull();
    expect(subscriptionBurstWarning(['codex-cli'], 10)).toBeNull();
    expect(subscriptionBurstWarning([], 500)).toBeNull();
  });
});
