/** Consent flow — injected IO + temp .env; no TTY, no real checkout .env.
 * Plan 19: one maybeOfferSubscriptionProvider covers claude-code AND codex-cli;
 * the codex fixture defaults to LOGGED OUT here so every pre-existing cc-solo
 * case keeps its exact meaning on machines with a real codex install. */
import { beforeAll, afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { installFakeToolFromFile } from './support/fake-tool.js';

const ccSrc = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures', 'cc-bin');
const codexSrc = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures', 'codex-bin');
// The committed fixtures are `#!/bin/sh` scripts, which Windows cannot execute:
// each is INSTALLED into a temp bin dir by the shared helper (support/fake-tool.ts).
// TWO dirs, not one — the codex-solo describe below puts only `codexBin` on PATH
// to prove `claude` is findable nowhere, which one merged dir would silently break.
const ccBin = fs.mkdtempSync(path.join(os.tmpdir(), 'mai-consent-cc-bin-'));
const codexBin = fs.mkdtempSync(path.join(os.tmpdir(), 'mai-consent-codex-bin-'));
const realPath = process.env.PATH ?? '';
const fixturePath = `${ccBin}${path.delimiter}${codexBin}${path.delimiter}${realPath}`;
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'mai-consent-'));
let envFile: string;
let n = 0;
// Env save/restore (pass-4 W5): fileParallelism:false shares one process across
// suites — mutations here must not leak into later env-sensitive files.
const savedEnv: Record<string, string | undefined> = {};

beforeAll(async () => {
  for (const k of ['MAI_LLM_SUMMARY', 'MAI_LLM_PROVIDER', 'MAI_EMBEDDINGS', 'OPENAI_API_KEY', 'VOYAGE_API_KEY']) savedEnv[k] = process.env[k];
  installFakeToolFromFile(ccBin, 'claude', path.join(ccSrc, 'claude'));
  installFakeToolFromFile(codexBin, 'codex', path.join(codexSrc, 'codex'));
  process.env.PATH = fixturePath;
  // DOTENV TIME BOMB DEFUSAL (pass-2 B1): importing the module chain loads
  // src/env.ts, whose dotenv config() re-fills DELETED vars from the real
  // checkout .env on first load. Force that load NOW, then scrub in beforeEach —
  // otherwise this suite fails on any machine whose .env has MAI_LLM_PROVIDER
  // (i.e. any machine where consent was ever accepted). Same class as
  // segment-ingest.test.ts's set-don't-delete guard.
  await import('../scripts/llm-consent.js');
});
afterAll(() => {
  process.env.PATH = realPath;
  delete process.env.MAI_CODEX_FIXTURE;
  for (const [k, v] of Object.entries(savedEnv)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  fs.rmSync(ccBin, { recursive: true, force: true });
  fs.rmSync(codexBin, { recursive: true, force: true });
});
beforeEach(async () => {
  envFile = path.join(tmp, `env-${n++}`);
  delete process.env.MAI_LLM_PROVIDER;
  process.env.MAI_LLM_SUMMARY = '0'; // set-don't-delete: keeps detectLLMProviderId() null (N2 check) regardless of real .env
  // Default: codex NOT detected (login probe exits 1) — pre-plan-19 cases keep
  // their solo meaning; pick-one cases opt in with MAI_CODEX_FIXTURE='ok'.
  process.env.MAI_CODEX_FIXTURE = 'loggedout';
  const { resetClaudeBinaryProbe } = await import('../llm/claude-code.js');
  const { resetCodexBinaryProbe } = await import('../llm/codex-cli.js');
  resetClaudeBinaryProbe();
  resetCodexBinaryProbe();
});

function io(answers: string[], tty = true) {
  const printed: string[] = [];
  const asked: string[] = [];
  return {
    io: {
      isTTY: tty,
      ask: async (q: string) => {
        asked.push(q);
        return answers.shift() ?? '';
      },
      print: (l: string) => {
        printed.push(l);
      },
    },
    printed,
    asked,
  };
}

describe('maybeOfferSubscriptionProvider — claude-code solo (codex logged out)', () => {
  it('yes → enables in .env', async () => {
    const { maybeOfferSubscriptionProvider } = await import('../scripts/llm-consent.js');
    const { io: fake } = io(['y']);
    const line = await maybeOfferSubscriptionProvider(fake, undefined, envFile);
    expect(line).toContain('enabled');
    const env = fs.readFileSync(envFile, 'utf8');
    expect(env).toContain('MAI_LLM_SUMMARY=1');
    expect(env).toContain('MAI_LLM_PROVIDER=claude-code');
  });
  it('solo path asks the per-provider question, not pick-one', async () => {
    const { maybeOfferSubscriptionProvider, CC_QUESTION } = await import('../scripts/llm-consent.js');
    const { io: fake, asked } = io(['n']);
    await maybeOfferSubscriptionProvider(fake, undefined, envFile);
    expect(asked).toEqual([CC_QUESTION]);
  });
  it('no → decline marker, never re-asks', async () => {
    const { maybeOfferSubscriptionProvider, CC_PROMPT_MARKER } = await import('../scripts/llm-consent.js');
    const first = await maybeOfferSubscriptionProvider(io(['n']).io, undefined, envFile);
    expect(first).toContain('declined');
    expect(fs.readFileSync(envFile, 'utf8')).toContain(`${CC_PROMPT_MARKER}=1`);
    const second = await maybeOfferSubscriptionProvider(io(['y']).io, undefined, envFile);
    expect(second).toBeNull(); // marker suppresses
  });
  it('non-TTY → hint, no write', async () => {
    const { maybeOfferSubscriptionProvider } = await import('../scripts/llm-consent.js');
    const { io: fake, printed } = io([], false);
    const line = await maybeOfferSubscriptionProvider(fake, undefined, envFile);
    expect(line).toContain('hint');
    expect(printed.length).toBe(1);
    expect(fs.existsSync(envFile)).toBe(false);
  });
  it('--llm claude-code → enables without prompting', async () => {
    const { maybeOfferSubscriptionProvider } = await import('../scripts/llm-consent.js');
    const line = await maybeOfferSubscriptionProvider(io([], false).io, 'claude-code', envFile);
    expect(line).toContain('enabled');
  });
  it('--llm none → markers for BOTH providers, no enable', async () => {
    const { maybeOfferSubscriptionProvider, CC_PROMPT_MARKER, CODEX_PROMPT_MARKER } = await import('../scripts/llm-consent.js');
    const line = await maybeOfferSubscriptionProvider(io(['y']).io, 'none', envFile);
    expect(line).toContain('skipped');
    const env = fs.readFileSync(envFile, 'utf8');
    expect(env).not.toContain('MAI_LLM_PROVIDER=');
    expect(env).toContain(`${CC_PROMPT_MARKER}=1`);
    expect(env).toContain(`${CODEX_PROMPT_MARKER}=1`);
  });
  it('already configured (env var) → null, untouched', async () => {
    process.env.MAI_LLM_PROVIDER = 'anthropic';
    const { maybeOfferSubscriptionProvider } = await import('../scripts/llm-consent.js');
    expect(await maybeOfferSubscriptionProvider(io(['y']).io, undefined, envFile)).toBeNull();
    expect(fs.existsSync(envFile)).toBe(false);
  });
  it('a RESOLVING provider counts as configured — never prompts a working API-key setup (review N2)', async () => {
    process.env.MAI_LLM_SUMMARY = '1';
    process.env.ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY ?? 'sk-test-fake';
    // no MAI_LLM_PROVIDER → default 'anthropic' resolves via the key
    const { maybeOfferSubscriptionProvider } = await import('../scripts/llm-consent.js');
    expect(await maybeOfferSubscriptionProvider(io(['y']).io, undefined, envFile)).toBeNull();
    expect(fs.existsSync(envFile)).toBe(false);
    process.env.MAI_LLM_SUMMARY = '0';
    if (process.env.ANTHROPIC_API_KEY === 'sk-test-fake') delete process.env.ANTHROPIC_API_KEY;
  });
  it('append never truncates existing content', async () => {
    fs.writeFileSync(envFile, 'EXISTING=1\n');
    const { appendEnvLines } = await import('../scripts/llm-consent.js');
    await appendEnvLines(['NEW=2'], envFile);
    expect(fs.readFileSync(envFile, 'utf8')).toBe('EXISTING=1\nNEW=2\n');
  });
});

describe('maybeOfferSubscriptionProvider — pick-one (both detected)', () => {
  beforeEach(() => {
    process.env.MAI_CODEX_FIXTURE = 'ok'; // codex now detected alongside cc
  });
  it('asks the ONE combined question', async () => {
    const { maybeOfferSubscriptionProvider, PICK_ONE_QUESTION } = await import('../scripts/llm-consent.js');
    const { io: fake, asked } = io(['n']);
    await maybeOfferSubscriptionProvider(fake, undefined, envFile);
    expect(asked).toEqual([PICK_ONE_QUESTION]);
  });
  it('answer 1 → claude-code enabled + BOTH markers recorded', async () => {
    const { maybeOfferSubscriptionProvider, CC_PROMPT_MARKER, CODEX_PROMPT_MARKER } = await import('../scripts/llm-consent.js');
    const line = await maybeOfferSubscriptionProvider(io(['1']).io, undefined, envFile);
    expect(line).toContain('claude-code');
    expect(line).toContain('enabled');
    const env = fs.readFileSync(envFile, 'utf8');
    expect(env).toContain('MAI_LLM_SUMMARY=1');
    expect(env).toContain('MAI_LLM_PROVIDER=claude-code');
    expect(env).toContain(`${CC_PROMPT_MARKER}=1`);
    expect(env).toContain(`${CODEX_PROMPT_MARKER}=1`);
  });
  it('answer 2 → codex-cli enabled + BOTH markers recorded', async () => {
    const { maybeOfferSubscriptionProvider, CC_PROMPT_MARKER, CODEX_PROMPT_MARKER } = await import('../scripts/llm-consent.js');
    const line = await maybeOfferSubscriptionProvider(io(['2']).io, undefined, envFile);
    expect(line).toContain('codex-cli');
    expect(line).toContain('enabled');
    const env = fs.readFileSync(envFile, 'utf8');
    expect(env).toContain('MAI_LLM_SUMMARY=1');
    expect(env).toContain('MAI_LLM_PROVIDER=codex-cli');
    expect(env).toContain(`${CC_PROMPT_MARKER}=1`);
    expect(env).toContain(`${CODEX_PROMPT_MARKER}=1`);
  });
  it('answer n → both markers, no provider, and NEITHER is ever re-asked', async () => {
    const { maybeOfferSubscriptionProvider, CC_PROMPT_MARKER, CODEX_PROMPT_MARKER } = await import('../scripts/llm-consent.js');
    const first = await maybeOfferSubscriptionProvider(io(['n']).io, undefined, envFile);
    expect(first).toContain('declined');
    const env = fs.readFileSync(envFile, 'utf8');
    expect(env).not.toContain('MAI_LLM_PROVIDER=');
    expect(env).toContain(`${CC_PROMPT_MARKER}=1`);
    expect(env).toContain(`${CODEX_PROMPT_MARKER}=1`);
    const second = await maybeOfferSubscriptionProvider(io(['y']).io, undefined, envFile);
    expect(second).toBeNull(); // both markers suppress — asked once, ever (spec §4)
  });
  it('cc declined EARLIER → codex is offered SOLO with the codex question', async () => {
    const { maybeOfferSubscriptionProvider, CC_PROMPT_MARKER, CODEX_QUESTION } = await import('../scripts/llm-consent.js');
    fs.writeFileSync(envFile, `${CC_PROMPT_MARKER}=1\n`);
    const { io: fake, asked } = io(['y']);
    const line = await maybeOfferSubscriptionProvider(fake, undefined, envFile);
    expect(asked).toEqual([CODEX_QUESTION]);
    expect(line).toContain('codex-cli');
    expect(fs.readFileSync(envFile, 'utf8')).toContain('MAI_LLM_PROVIDER=codex-cli');
  });
  it('non-TTY → BOTH hints printed, nothing written', async () => {
    const { maybeOfferSubscriptionProvider, CC_HINT, CODEX_HINT } = await import('../scripts/llm-consent.js');
    const { io: fake, printed } = io([], false);
    const line = await maybeOfferSubscriptionProvider(fake, undefined, envFile);
    expect(line).toContain('hint');
    expect(printed).toEqual([CC_HINT, CODEX_HINT]);
    expect(fs.existsSync(envFile)).toBe(false);
  });
});

describe('maybeOfferSubscriptionProvider — codex-cli solo (no claude on PATH)', () => {
  beforeEach(async () => {
    process.env.MAI_CODEX_FIXTURE = 'ok';
    process.env.PATH = codexBin; // no `claude` findable anywhere
    const { resetClaudeBinaryProbe } = await import('../llm/claude-code.js');
    const { resetCodexBinaryProbe } = await import('../llm/codex-cli.js');
    resetClaudeBinaryProbe();
    resetCodexBinaryProbe();
  });
  afterEach(() => {
    process.env.PATH = fixturePath;
  });
  it('y → codex-cli enabled via the codex question', async () => {
    const { maybeOfferSubscriptionProvider, CODEX_QUESTION } = await import('../scripts/llm-consent.js');
    const { io: fake, asked } = io(['y']);
    const line = await maybeOfferSubscriptionProvider(fake, undefined, envFile);
    expect(asked).toEqual([CODEX_QUESTION]);
    expect(line).toContain('enabled');
    const env = fs.readFileSync(envFile, 'utf8');
    expect(env).toContain('MAI_LLM_SUMMARY=1');
    expect(env).toContain('MAI_LLM_PROVIDER=codex-cli');
  });
  it('n → codex marker only, second offer suppressed', async () => {
    const { maybeOfferSubscriptionProvider, CODEX_PROMPT_MARKER, CC_PROMPT_MARKER } = await import('../scripts/llm-consent.js');
    const first = await maybeOfferSubscriptionProvider(io(['n']).io, undefined, envFile);
    expect(first).toContain('declined');
    const env = fs.readFileSync(envFile, 'utf8');
    expect(env).toContain(`${CODEX_PROMPT_MARKER}=1`);
    expect(env).not.toContain(`${CC_PROMPT_MARKER}=1`);
    expect(await maybeOfferSubscriptionProvider(io(['y']).io, undefined, envFile)).toBeNull();
  });
  it('non-TTY → codex hint printed, no write', async () => {
    const { maybeOfferSubscriptionProvider, CODEX_HINT } = await import('../scripts/llm-consent.js');
    const { io: fake, printed } = io([], false);
    const line = await maybeOfferSubscriptionProvider(fake, undefined, envFile);
    expect(line).toContain('hint');
    expect(printed).toEqual([CODEX_HINT]);
    expect(fs.existsSync(envFile)).toBe(false);
  });
  it('--llm codex-cli → enables without prompting', async () => {
    const { maybeOfferSubscriptionProvider } = await import('../scripts/llm-consent.js');
    const line = await maybeOfferSubscriptionProvider(io([], false).io, 'codex-cli', envFile);
    expect(line).toContain('enabled');
    expect(fs.readFileSync(envFile, 'utf8')).toContain('MAI_LLM_PROVIDER=codex-cli');
  });
  it('--llm codex-cli with codex unavailable → explicit NOT-enabled line, never silent (pass-2 W6 rule)', async () => {
    process.env.MAI_CODEX_FIXTURE = 'loggedout';
    const { resetCodexBinaryProbe } = await import('../llm/codex-cli.js');
    resetCodexBinaryProbe();
    const { maybeOfferSubscriptionProvider } = await import('../scripts/llm-consent.js');
    const line = await maybeOfferSubscriptionProvider(io([], false).io, 'codex-cli', envFile);
    expect(line).toContain('NOT enabled');
    expect(fs.existsSync(envFile)).toBe(false);
  });
});

describe('maybeOfferLocalEmbeddings', () => {
  beforeEach(async () => {
    // Safe to delete (not set-don't-delete): this file's beforeAll already
    // force-imported the module chain, so dotenv cannot refill these.
    delete process.env.MAI_EMBEDDINGS;
    delete process.env.OPENAI_API_KEY;
    delete process.env.VOYAGE_API_KEY;
    const { setLocalEmbedderForTests } = await import('../embeddings.js');
    setLocalEmbedderForTests(async () => new Array(384).fill(0.1)); // downloadNow succeeds instantly
  });
  afterAll(async () => {
    const { setLocalEmbedderForTests } = await import('../embeddings.js');
    setLocalEmbedderForTests(null); // fileParallelism:false — don't leak the fake into later suites
  });

  it('cloud key present → silent skip, .env untouched', async () => {
    process.env.OPENAI_API_KEY = 'sk-test';
    const { maybeOfferLocalEmbeddings } = await import('../scripts/llm-consent.js');
    const { io: fake } = io(['y']);
    const out = await maybeOfferLocalEmbeddings(fake, undefined, envFile);
    expect(out).toBeNull();
    expect(fs.existsSync(envFile)).toBe(false); // writes NOTHING
  });
  it('default yes: empty answer enables + downloads', async () => {
    const { maybeOfferLocalEmbeddings } = await import('../scripts/llm-consent.js');
    const { io: fake } = io(['']);
    const out = await maybeOfferLocalEmbeddings(fake, undefined, envFile);
    expect(out).toContain('local semantic search enabled');
    expect(fs.readFileSync(envFile, 'utf8')).toMatch(/^MAI_EMBEDDINGS=1$/m);
  });
  it('decline → marker only, no enable', async () => {
    const { maybeOfferLocalEmbeddings } = await import('../scripts/llm-consent.js');
    const { io: fake } = io(['n']);
    const out = await maybeOfferLocalEmbeddings(fake, undefined, envFile);
    expect(out).toContain('declined');
    const env = fs.readFileSync(envFile, 'utf8');
    expect(env).toMatch(/^MAI_EMB_PROMPTED=1$/m);
    expect(env).not.toMatch(/^MAI_EMBEDDINGS=/m);
  });
  it('non-TTY → hint printed, no prompt, no write', async () => {
    const { maybeOfferLocalEmbeddings } = await import('../scripts/llm-consent.js');
    const { io: fake, printed } = io([], false);
    const out = await maybeOfferLocalEmbeddings(fake, undefined, envFile);
    expect(out).toContain('hint printed');
    expect(printed.some((l) => l.includes('MAI_EMBEDDINGS=1'))).toBe(true);
    expect(fs.existsSync(envFile)).toBe(false);
  });
  it('--embeddings none → marker + skip message', async () => {
    const { maybeOfferLocalEmbeddings } = await import('../scripts/llm-consent.js');
    const { io: fake } = io([]);
    const out = await maybeOfferLocalEmbeddings(fake, 'none', envFile);
    expect(out).toContain('skipped');
    expect(fs.readFileSync(envFile, 'utf8')).toMatch(/^MAI_EMB_PROMPTED=1$/m);
  });
  it('EMPTY cloud key is not a cloud key — still prompts (pass-7 B4)', async () => {
    // `OPENAI_API_KEY=` is how people disable a key. detectProvider() uses
    // truthiness and picks LOCAL; the consent check used `!== undefined` and
    // saw a cloud tier, so the user landed on a tier they were never offered
    // and whose model was never downloaded.
    process.env.OPENAI_API_KEY = '';
    process.env.VOYAGE_API_KEY = '   ';
    const { maybeOfferLocalEmbeddings } = await import('../scripts/llm-consent.js');
    const { io: fake } = io(['']);
    const out = await maybeOfferLocalEmbeddings(fake, undefined, envFile);
    expect(out).toContain('local semantic search enabled');
    expect(fs.readFileSync(envFile, 'utf8')).toMatch(/^MAI_EMBEDDINGS=1$/m);
  });
  it('EMPTY cloud key + --embeddings local → enables, does not claim cloud wins (pass-7 B4)', async () => {
    process.env.OPENAI_API_KEY = '';
    const { maybeOfferLocalEmbeddings } = await import('../scripts/llm-consent.js');
    const out = await maybeOfferLocalEmbeddings(io([]).io, 'local', envFile);
    expect(out).not.toContain('cloud key present');
    expect(out).toContain('enabled');
  });
  it('--embeddings local with a cloud key → explanatory line, never silent (review W3)', async () => {
    process.env.VOYAGE_API_KEY = 'pa-test';
    const { maybeOfferLocalEmbeddings } = await import('../scripts/llm-consent.js');
    const { io: fake } = io([]);
    const out = await maybeOfferLocalEmbeddings(fake, 'local', envFile);
    expect(out).toContain('cloud key present');
    expect(fs.existsSync(envFile)).toBe(false);
  });
});

describe('plan 15: authority-aware explicit/automatic provider requests', () => {
  it('subscriptionAvailability reflects the fixture PATH', async () => {
    const { subscriptionAvailability } = await import('../scripts/llm-consent.js');
    const avail = subscriptionAvailability();
    expect(avail.claudeCode).toBe(true); // cc fixture on PATH
    expect(avail.codexCli).toBe(false); // logged out by default
  });

  it('already configured: zero bytes, distinct summary line', async () => {
    const { maybeOfferSubscriptionProvider } = await import('../scripts/llm-consent.js');
    fs.writeFileSync(envFile, 'MAI_LLM_SUMMARY=1\nMAI_LLM_PROVIDER=claude-code\n');
    const before = fs.readFileSync(envFile, 'utf8');
    const { io: fake } = io([]);
    const line = await maybeOfferSubscriptionProvider(fake, 'claude-code', envFile, { preFileLlmAuthority: {} });
    expect(line).toContain('already configured');
    expect(fs.readFileSync(envFile, 'utf8')).toBe(before);
  });

  it('the effective LAST assignment wins when the file has history', async () => {
    const { maybeOfferSubscriptionProvider } = await import('../scripts/llm-consent.js');
    fs.writeFileSync(
      envFile,
      'MAI_LLM_SUMMARY=1\nMAI_LLM_PROVIDER=codex-cli\nMAI_LLM_PROVIDER=claude-code\n'
    );
    const before = fs.readFileSync(envFile, 'utf8');
    const { io: fake } = io([]);
    const line = await maybeOfferSubscriptionProvider(fake, 'claude-code', envFile, { preFileLlmAuthority: {} });
    expect(line).toContain('already configured');
    expect(fs.readFileSync(envFile, 'utf8')).toBe(before);
  });

  it('automatic preserves a different file provider; explicit switches by appending ONLY the change', async () => {
    const { maybeOfferSubscriptionProvider } = await import('../scripts/llm-consent.js');
    fs.writeFileSync(envFile, 'MAI_LLM_SUMMARY=1\nMAI_LLM_PROVIDER=codex-cli\n');
    const before = fs.readFileSync(envFile, 'utf8');
    const { io: fake } = io([]);

    const preserved = await maybeOfferSubscriptionProvider(fake, 'claude-code', envFile, {
      automatic: true,
      preFileLlmAuthority: {},
    });
    expect(preserved).toContain('preserved configured provider');
    expect(fs.readFileSync(envFile, 'utf8')).toBe(before);

    const switched = await maybeOfferSubscriptionProvider(fake, 'claude-code', envFile, {
      preFileLlmAuthority: {},
    });
    expect(switched).toContain('enabled via --llm flag');
    expect(fs.readFileSync(envFile, 'utf8')).toBe(`${before}MAI_LLM_PROVIDER=claude-code\n`);
  });

  it('an inherited conflict throws the typed error naming the exact variables, before any write', async () => {
    const { maybeOfferSubscriptionProvider, LlmAuthorityConflictError } = await import('../scripts/llm-consent.js');
    fs.writeFileSync(envFile, 'MAI_LLM_SUMMARY=1\nMAI_LLM_PROVIDER=codex-cli\n');
    const before = fs.readFileSync(envFile, 'utf8');
    const { io: fake } = io([]);
    let caught: unknown = null;
    try {
      await maybeOfferSubscriptionProvider(fake, 'claude-code', envFile, {
        preFileLlmAuthority: { provider: 'codex-cli', summary: '0' },
      });
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(LlmAuthorityConflictError);
    if (caught instanceof LlmAuthorityConflictError) {
      expect(caught.variables.sort()).toEqual(['MAI_LLM_PROVIDER', 'MAI_LLM_SUMMARY']);
      expect(caught.message).toContain('was not changed');
    }
    expect(fs.readFileSync(envFile, 'utf8')).toBe(before);
  });

  it('an automatic run reports (never throws on) a conflicting inherited value, zero bytes', async () => {
    const { maybeOfferSubscriptionProvider } = await import('../scripts/llm-consent.js');
    const { io: fake } = io([]);
    const line = await maybeOfferSubscriptionProvider(fake, 'claude-code', envFile, {
      automatic: true,
      preFileLlmAuthority: { provider: 'codex-cli' },
    });
    expect(line).toContain('preserved inherited provider');
    expect(fs.existsSync(envFile)).toBe(false);
  });
});
