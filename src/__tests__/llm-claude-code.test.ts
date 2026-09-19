/** claude-code provider against the fake binary — no subscription, no network.
 * Plan 19 Task 5: exec modes ride a SIDECAR FILE next to a TEMP COPY of the
 * fixture (pass-4 B1) — the allowlist child env (decision 48797d3e) strips
 * MAI_CC_FIXTURE from provider spawns, so an env selector would silently fall
 * back to the ok default on every mode-switched case. */
import { beforeAll, afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { installFakeToolFromFile } from './support/fake-tool.js';

const fixturesSrc = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures', 'cc-bin');
const codexFixturesSrc = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures', 'codex-bin');
// The chain test needs an executable codex beside claude; the committed fixture
// is a script, so it is installed through the shared helper like claude is.
const codexFixturesBin = fs.mkdtempSync(path.join(os.tmpdir(), 'mai-fixture-cc-codex-'));
const realPath = process.env.PATH ?? '';
const fixturesBin = fs.mkdtempSync(path.join(os.tmpdir(), 'mai-fixture-cc-'));
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

/** Cast-free field access on unknown (global lesson 293a39bc). */
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

beforeAll(() => {
  // The shared installer, not a copy+chmod: Windows cannot execute a `#!/bin/sh`
  // file, so the fake becomes a shim + Git Bash body there (support/fake-tool.ts).
  installFakeToolFromFile(fixturesBin, 'claude', path.join(fixturesSrc, 'claude'));
  installFakeToolFromFile(codexFixturesBin, 'codex', path.join(codexFixturesSrc, 'codex'));
  process.env.PATH = `${fixturesBin}${path.delimiter}${realPath}`;
  process.env.MAI_CC_TIMEOUT_MS = '2000'; // hang-mode test bound
});
afterAll(() => {
  fs.rmSync(codexFixturesBin, { recursive: true, force: true });
  process.env.PATH = realPath;
  delete process.env.MAI_CC_TIMEOUT_MS;
  fs.rmSync(fixturesBin, { recursive: true, force: true });
});
beforeEach(async () => {
  vi.restoreAllMocks();
  const { resetClaudeBinaryProbe } = await import('../llm/claude-code.js');
  resetClaudeBinaryProbe();
  clearMode();
});

// (No extractJSON describe here — the shared parser's tests live in
// llm-provider.test.ts; claude-code.ts only IMPORTS it.)

describe('ClaudeCodeProvider (fake binary)', () => {
  const call = async () => {
    const { ClaudeCodeProvider } = await import('../llm/claude-code.js');
    return new ClaudeCodeProvider().completeJSON({
      prompt: 'p',
      schema: { type: 'object', properties: {} },
      schemaName: 't',
      maxTokens: 100,
    });
  };
  it('happy path parses result JSON', async () => {
    expect(await call()).toEqual({ ok: true, n: 3 });
  });
  it('is_error → null', async () => {
    setMode('error');
    expect(await call()).toBeNull();
  });
  it('fenced result recovers', async () => {
    setMode('fence');
    expect(await call()).toEqual({ ok: true });
  });
  it('garbage wrapper → null', async () => {
    setMode('garbage');
    expect(await call()).toBeNull();
  });
  it('non-zero exit → null', async () => {
    setMode('exit1');
    expect(await call()).toBeNull();
  });
  it('hang → timeout → null (bounded; stdio destroyed so nothing lingers)', async () => {
    setMode('hang');
    await mockTreeCleanup();
    expect(await call()).toBeNull();
  }, 10_000);
  it('timeout logs its reason ONCE — the trailing close after SIGKILL is silent (executor nit)', async () => {
    setMode('hang');
    const terminateTree = await mockTreeCleanup();
    const warns: string[] = [];
    const spy = vi.spyOn(console, 'warn').mockImplementation((...a: unknown[]) => {
      warns.push(a.join(' '));
    });
    try {
      expect(await call()).toBeNull();
      // The duplicate fired on 'close', AFTER the promise resolved — wait it out.
      await new Promise((r) => setTimeout(r, 300));
    } finally {
      spy.mockRestore();
    }
    expect(warns.filter((w) => w.includes('claude -p'))).toEqual(['[mai-llm] claude -p timed out']);
    expect(terminateTree).toHaveBeenCalledTimes(1);
  }, 10_000);
  it('EPIPE: child exits without reading a large stdin → null, process survives (review B1)', async () => {
    setMode('noread');
    const warns: string[] = [];
    const spy = vi.spyOn(console, 'warn').mockImplementation((...a: unknown[]) => {
      warns.push(a.join(' '));
    });
    const { ClaudeCodeProvider } = await import('../llm/claude-code.js');
    let result: unknown;
    try {
      result = await new ClaudeCodeProvider().completeJSON({
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
    expect(warns.filter((w) => w.includes('claude -p exited'))).toHaveLength(1);
  });
  // Gated on Windows: POSIX pid/signal semantics — the fixture's `$$` is Git Bash's MSYS pid (support/fake-tool.ts).
  it.skipIf(process.platform === 'win32')('stdin error with a still-ALIVE child → SIGKILL, null, diagnosis never duplicated (pass-5 B2)', async () => {
    setMode('stdinclose'); // fixture closes fd 0, writes its PID to the sidecar dir, then sleeps past the 2s bound
    const terminateTree = await mockTreeCleanup();
    const warns: string[] = [];
    const spy = vi.spyOn(console, 'warn').mockImplementation((...a: unknown[]) => {
      warns.push(a.join(' '));
    });
    const { ClaudeCodeProvider } = await import('../llm/claude-code.js');
    let result: unknown;
    try {
      result = await new ClaudeCodeProvider().completeJSON({
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
    // The rider fix must have SIGKILLed the child — without it the child would
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
    expect(warns.filter((w) => w.includes('claude -p exited'))).toHaveLength(1); // diagnosed, never duplicated
  });
  // Gated on Windows: POSIX pid/signal semantics — the fixture's `$$` is Git Bash's MSYS pid (support/fake-tool.ts).
  it.skipIf(process.platform === 'win32')('unknown birth identity refuses tree signals while still destroying streams', async () => {
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
  it('recycled birth makes authorization false and duplicate cleanup stays single-flight', async () => {
    setMode('hang');
    const platform = await import('../platform/processes.js');
    const base = platform.defaultProcessOps();
    let births = 0;
    const authorized: boolean[] = [];
    const terminateTree = vi.fn(async (pid: number, authorize?: () => Promise<boolean>) => {
      authorized.push(authorize ? await authorize() : true);
      // Test hygiene only: authorization must be false, but the fake sleeper
      // still needs reaping after the production route correctly refuses it.
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
  it('SPAWNS from the stable scratch cwd — the recursion guard itself (review B3)', async () => {
    setMode('cwd');
    const { ccScratchCwd } = await import('../llm/claude-code.js');
    expect(samePath(stringField(await call(), 'cwd'), ccScratchCwd())).toBe(true); // fixture echoes $PWD
  });
  it('AUTH SCRUB (allowlist SHAPE, decision 48797d3e): creds AND an unrelated canary absent by construction; HOME/PATH present', async () => {
    const saved: Record<string, string | undefined> = {};
    for (const k of ['ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN', 'OPENAI_API_KEY', 'MAI_TEST_CANARY_SECRET']) saved[k] = process.env[k];
    process.env.ANTHROPIC_API_KEY = 'sk-must-not-leak';
    process.env.ANTHROPIC_AUTH_TOKEN = 'oat-must-not-leak';
    process.env.OPENAI_API_KEY = 'sk-openai-must-not-leak';
    // The canary is the ALLOWLIST's proof: no scrub rule ever names it, yet it
    // must not reach the child — exclusion by construction, not enumeration.
    process.env.MAI_TEST_CANARY_SECRET = 'canary-must-not-leak';
    setMode('envcheck');
    const { ClaudeCodeProvider } = await import('../llm/claude-code.js');
    let result: unknown;
    try {
      result = await new ClaudeCodeProvider().completeJSON({
        prompt: 'p',
        schema: { type: 'object', properties: {} },
        schemaName: 't',
        maxTokens: 100,
      });
    } finally {
      // Restore, never delete: OPENAI_API_KEY is pinned '' at the vitest
      // runner boundary and dotenv would refill a DELETED key from the real
      // checkout .env (lessons 57ac4b5a / fe820fc9).
      for (const [k, v] of Object.entries(saved)) {
        if (v === undefined) delete process.env[k];
        else process.env[k] = v;
      }
    }
    expect(result).toEqual({
      key: 'absent',
      token: 'absent',
      openai: 'absent',
      canary: 'absent',
      home: 'present',
      path: 'present',
    });
  });
  it('--model passthrough: present when MAI_SUMMARY_MODEL set, absent otherwise (review W2)', async () => {
    setMode('args');
    const { ClaudeCodeProvider } = await import('../llm/claude-code.js');
    const argsOf = async (model?: string) =>
      stringField(
        await new ClaudeCodeProvider(model).completeJSON({
          prompt: 'p',
          schema: { type: 'object', properties: {} },
          schemaName: 't',
          maxTokens: 100,
        }),
        'argv'
      );
    expect(await argsOf('claude-sonnet-4-6')).toContain('--model claude-sonnet-4-6');
    expect(await argsOf(undefined)).not.toContain('--model');
  });
});

describe('detection', () => {
  // House-style env save/restore (mirrors llm-provider.test.ts). The binary
  // probe (`claude --version`) is spawnSync with the full inherited env and
  // needs no mode — the sidecar-less fixture takes its ok default.
  const saved: Record<string, string | undefined> = {};
  beforeAll(() => {
    for (const k of [
      'MAI_LLM_SUMMARY', 'MAI_LLM_PROVIDER', 'MAI_LLM_FALLBACK_PROVIDER',
      'MAI_SUMMARY_MODEL', 'MAI_CODEX_CLI_MODEL', 'MAI_CODEX_CLI_REASONING',
    ]) saved[k] = process.env[k];
  });
  afterAll(() => {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  });
  it('resolves claude-code only with flag+binary; absent binary → null', async () => {
    const { detectLLMProviderId } = await import('../llm/provider.js');
    const { resetClaudeBinaryProbe } = await import('../llm/claude-code.js');
    process.env.MAI_LLM_SUMMARY = '1';
    process.env.MAI_LLM_PROVIDER = 'claude-code';
    delete process.env.MAI_LLM_FALLBACK_PROVIDER;
    resetClaudeBinaryProbe();
    expect(detectLLMProviderId()).toBe('claude-code'); // fake binary on PATH
    try {
      process.env.PATH = '/nonexistent-mai-test';
      resetClaudeBinaryProbe();
      expect(detectLLMProviderId()).toBeNull();
    } finally {
      // try/finally — mirror of the codex suite's review-N3 guard.
      process.env.PATH = `${fixturesBin}${path.delimiter}${realPath}`;
    }
  });

  it('builds an ordered chain and resolves Codex when Claude is unavailable', async () => {
    const { detectLLMProviderId, getLLMProvider, llmProviderStatus } = await import('../llm/provider.js');
    const { resetClaudeBinaryProbe } = await import('../llm/claude-code.js');
    const { resetCodexBinaryProbe } = await import('../llm/codex-cli.js');
    process.env.MAI_LLM_SUMMARY = '1';
    process.env.MAI_LLM_PROVIDER = 'claude-code';
    process.env.MAI_LLM_FALLBACK_PROVIDER = 'codex-cli';
    process.env.MAI_SUMMARY_MODEL = 'claude-sonnet-4-6';
    process.env.MAI_CODEX_CLI_MODEL = 'gpt-5.6-terra';
    process.env.MAI_CODEX_CLI_REASONING = 'medium';

    try {
      process.env.PATH = `${fixturesBin}${path.delimiter}${codexFixturesBin}${path.delimiter}${realPath}`;
      resetClaudeBinaryProbe();
      resetCodexBinaryProbe();
      expect(detectLLMProviderId()).toBe('claude-code');
      expect(getLLMProvider()?.name).toBe('claude-code -> codex-cli');
      expect(llmProviderStatus()).toContain('fallback: codex-cli (subscription), model: gpt-5.6-terra, reasoning: medium');

      process.env.PATH = codexFixturesBin;
      resetClaudeBinaryProbe();
      resetCodexBinaryProbe();
      expect(detectLLMProviderId()).toBe('codex-cli');
      expect(getLLMProvider()?.name).toBe('codex-cli');
      expect(llmProviderStatus()).toContain("using fallback: codex-cli (subscription), model: gpt-5.6-terra, reasoning: medium");
    } finally {
      process.env.PATH = `${fixturesBin}${path.delimiter}${realPath}`;
    }
  });
});
