// Consent-at-init for the subscription providers (plan 13: claude-code;
// plan 19: codex-cli, spec §4). Pure logic with injected IO so tests never
// need a TTY; the .env target is injectable so tests never touch the real
// checkout's .env. When BOTH subscription CLIs are detected the user gets ONE
// pick-one question (user-selected, 2026-08-11) — and both prompt
// markers are recorded whichever way it answers: asked once, ever.
import fs from 'node:fs/promises';
import path from 'node:path';
import readline from 'node:readline/promises';
import { MAI_ROOT } from '../paths.js';
import { PRE_FILE_LLM_AUTHORITY } from '../env.js';
import { claudeBinaryAvailable } from '../llm/claude-code.js';
import { codexBinaryAvailable } from '../llm/codex-cli.js';
import { routingSnapshot, credentialConfigured } from '../providers/runtime.js';
import { detectLLMProviderId } from '../llm/provider.js';
import type { PreFileLlmAuthority } from './init.js';

export const CC_PROMPT_MARKER = 'MAI_CC_PROMPTED';
export const CC_HINT =
  "✦ Claude Code detected — enable subscription summaries with MAI_LLM_PROVIDER=claude-code (see README: 'Have Claude Code?')";
export const CC_QUESTION = [
  'Use your Claude Code subscription for session summaries and decision extraction?',
  'No API key needed. Uses your subscription rate limits (subscription pricing',
  'applies only if Claude Code is logged in with a subscription account). [y/N] ',
].join('\n');

export const CODEX_PROMPT_MARKER = 'MAI_CODEX_PROMPTED';
export const CODEX_HINT =
  "✦ Codex CLI detected — enable subscription summaries with MAI_LLM_PROVIDER=codex-cli (see README: 'Have Codex?')";
export const CODEX_QUESTION = [
  'Use your ChatGPT (Codex) subscription for session summaries and decision extraction?',
  'No API key needed. Uses your subscription rate limits (requires the codex CLI',
  'to be logged in with a ChatGPT account). [y/N] ',
].join('\n');
export const PICK_ONE_QUESTION = [
  'Both Claude Code and Codex are installed. Use a subscription for session summaries',
  "and decision extraction? No API key needed; calls use that subscription's rate",
  'limits. [1] Claude Code  [2] Codex  [n] no ',
].join('\n');

export type LlmChoice = 'claude-code' | 'codex-cli' | 'none' | undefined;

/** Which subscription CLIs are actually on PATH (Plan 15 Task 3). */
export function subscriptionAvailability(): { claudeCode: boolean; codexCli: boolean } {
  return { claudeCode: claudeBinaryAvailable(), codexCli: codexBinaryAvailable() };
}

/** The ONE typed error for an inherited provider/summary value that defeats an
 * explicit request. Carries the exact conflicting variable names; no string
 * matching classifies it. `runInit` rethrows exactly this class — every other
 * consent failure keeps its deliberate best-effort SKIPPED behavior. */
export class LlmAuthorityConflictError extends Error {
  readonly variables: string[];
  constructor(variables: string[], message: string) {
    super(message);
    this.name = 'LlmAuthorityConflictError';
    this.variables = variables;
  }
}

export interface SubscriptionConsentOptions {
  /** True when --yes derived the provider (never overwrite, never throw). */
  automatic?: boolean;
  /** Pre-file-load process authority; defaults to the env.ts snapshot. */
  preFileLlmAuthority?: PreFileLlmAuthority;
}

/** Effective LAST assignment of a key in a dotenv-style file (dotenv keeps the
 * last one), without rewriting or normalizing the file. Trailing \r trimmed. */
function lastAssignment(env: string, key: string): string | undefined {
  let value: string | undefined;
  for (const match of env.matchAll(new RegExp(`^${key}=(.*)$`, 'gm'))) {
    value = match[1].replace(/\r$/, '');
  }
  return value;
}

export interface ConsentIO {
  isTTY: boolean;
  ask(question: string): Promise<string>;
  print(line: string): void;
}

/** Real IO — mirrors upgrade.ts's readline confirm pattern. */
export function stdConsentIO(): ConsentIO {
  return {
    isTTY: process.stdin.isTTY === true,
    async ask(question: string): Promise<string> {
      const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
      try {
        return await rl.question(question);
      } finally {
        rl.close();
      }
    },
    print(line: string): void {
      console.log(line);
    },
  };
}

export function defaultEnvPath(): string {
  return path.join(MAI_ROOT, '.env');
}

async function readEnvFile(file: string): Promise<string> {
  try {
    return await fs.readFile(file, 'utf8');
  } catch (err) {
    // ONLY a missing file maps to empty (review N5): any other read failure
    // (EACCES, EISDIR) must throw — an empty return here would make the
    // subsequent append TRUNCATE an existing .env it couldn't read.
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return '';
    throw err;
  }
}

/** Append-only .env write: never truncates, creates 0600 when absent. */
export async function appendEnvLines(lines: string[], file: string): Promise<void> {
  const existing = await readEnvFile(file);
  const sep = existing === '' || existing.endsWith('\n') ? '' : '\n';
  await fs.writeFile(file, existing + sep + lines.join('\n') + '\n', { mode: 0o600 });
}

/**
 * Offer a subscription provider once (claude-code and/or codex-cli). Returns a
 * summary line for init output, or null when nothing applied (already
 * configured / declined before / nothing detected).
 * - Both detected + neither prompted → ONE pick-one question; BOTH markers
 *   recorded on every answer (spec §4: asked once, never re-asked per provider).
 * - One detected → that provider's y/N flow (the pre-plan-19 behavior).
 * - Non-TTY → hint line(s) only, nothing written, so a later interactive run
 *   still gets to ask (mirror of the plan-13 behavior — amended spec §4).
 */
export async function maybeOfferSubscriptionProvider(
  io: ConsentIO,
  explicit: LlmChoice,
  envFile: string = defaultEnvPath(),
  options: SubscriptionConsentOptions = {}
): Promise<string | null> {
  const env = await readEnvFile(envFile);
  // "Configured" = an explicit provider choice anywhere, OR a provider that
  // already RESOLVES (review N2: a working MAI_LLM_SUMMARY=1 + ANTHROPIC_API_KEY
  // setup must not be prompted into silently migrating to a subscription).
  const configured =
    process.env.MAI_LLM_PROVIDER !== undefined ||
    /^MAI_LLM_PROVIDER=/m.test(env) ||
    detectLLMProviderId() !== null;
  const ccPrompted = new RegExp(`^${CC_PROMPT_MARKER}=`, 'm').test(env);
  const codexPrompted = new RegExp(`^${CODEX_PROMPT_MARKER}=`, 'm').test(env);

  if (explicit === 'none') {
    if (!configured) {
      const markers: string[] = [];
      if (!ccPrompted) markers.push(`${CC_PROMPT_MARKER}=1`);
      if (!codexPrompted) markers.push(`${CODEX_PROMPT_MARKER}=1`);
      if (markers.length > 0) await appendEnvLines(markers, envFile);
    }
    return 'llm: skipped (--llm none)';
  }
  if (explicit === 'claude-code' || explicit === 'codex-cli') {
    // Explicit request never fails silently (pass-2 W6, both providers).
    if (explicit === 'claude-code' && !claudeBinaryAvailable()) {
      return 'llm: NOT enabled — --llm claude-code given but no `claude` binary found on PATH';
    }
    if (explicit === 'codex-cli' && !codexBinaryAvailable()) {
      return 'llm: NOT enabled — --llm codex-cli given but no `codex` binary found on PATH (or not logged in)';
    }
    const authority = options.preFileLlmAuthority ?? PRE_FILE_LLM_AUTHORITY;
    const fileProvider = lastAssignment(env, 'MAI_LLM_PROVIDER');
    const fileSummary = lastAssignment(env, 'MAI_LLM_SUMMARY');
    if (options.automatic === true) {
      // Automatic setup never changes an operator's existing choice, and it
      // never reports a switch that inherited process values defeat.
      if (authority.provider !== undefined && authority.provider !== explicit) {
        return `llm: preserved inherited provider (MAI_LLM_PROVIDER=${authority.provider} from the process environment)`;
      }
      if (authority.summary !== undefined && authority.summary !== '1') {
        return `llm: preserved inherited configuration (MAI_LLM_SUMMARY=${authority.summary} from the process environment)`;
      }
      if (fileProvider !== undefined && fileProvider !== explicit) {
        return `llm: preserved configured provider (MAI_LLM_PROVIDER=${fileProvider})`;
      }
      const resolved = detectLLMProviderId();
      if (resolved !== null && resolved !== explicit) {
        return `llm: preserved configured provider (${resolved})`;
      }
    }
    // Append ONLY the file values that must change — an identical rerun is
    // byte-for-byte unchanged.
    const needed: string[] = [];
    if (fileSummary !== '1') needed.push('MAI_LLM_SUMMARY=1');
    if (fileProvider !== explicit) needed.push(`MAI_LLM_PROVIDER=${explicit}`);
    if (needed.length === 0) {
      return `llm: already configured (${explicit})`;
    }
    // Inherited authority gate BEFORE any append: a differing inherited
    // provider, or an inherited summary other than '1', would silently defeat
    // the file change this run is about to report. Matching inherited values
    // are compatible and may be persisted for future processes.
    const conflicts: string[] = [];
    if (authority.provider !== undefined && authority.provider !== explicit) {
      conflicts.push(`MAI_LLM_PROVIDER=${authority.provider}`);
    }
    if (authority.summary !== undefined && authority.summary !== '1') {
      conflicts.push(`MAI_LLM_SUMMARY=${authority.summary}`);
    }
    if (conflicts.length > 0) {
      throw new LlmAuthorityConflictError(
        conflicts.map((c) => c.split('=')[0]),
        `inherited process environment defeats --llm ${explicit} (${conflicts.join(', ')}); ` +
          `the consent file was not changed — unset or change these variables in the parent environment, then retry`
      );
    }
    await appendEnvLines(needed, envFile);
    return options.automatic === true
      ? `llm: ${explicit} (subscription) enabled automatically`
      : `llm: ${explicit} (subscription) enabled via --llm flag`;
  }
  if (configured) return null;
  const cc = !ccPrompted && claudeBinaryAvailable();
  const codex = !codexPrompted && codexBinaryAvailable();
  if (!cc && !codex) return null;

  if (cc && codex) {
    if (!io.isTTY) {
      io.print(CC_HINT);
      io.print(CODEX_HINT);
      return 'llm: hint printed (non-interactive — use --llm claude-code or --llm codex-cli to enable)';
    }
    const answer = (await io.ask(PICK_ONE_QUESTION)).trim().toLowerCase();
    // Anything but 1/2 declines — the mirror of the solo flow's default-no.
    const bothMarkers = [`${CC_PROMPT_MARKER}=1`, `${CODEX_PROMPT_MARKER}=1`];
    if (answer === '1') {
      await appendEnvLines(['MAI_LLM_SUMMARY=1', 'MAI_LLM_PROVIDER=claude-code', ...bothMarkers], envFile);
      return 'llm: claude-code (subscription) enabled — summaries need no API key';
    }
    if (answer === '2') {
      await appendEnvLines(['MAI_LLM_SUMMARY=1', 'MAI_LLM_PROVIDER=codex-cli', ...bothMarkers], envFile);
      return 'llm: codex-cli (subscription) enabled — summaries need no API key';
    }
    await appendEnvLines(bothMarkers, envFile);
    return 'llm: declined (re-enable any time: MAI_LLM_PROVIDER=claude-code or codex-cli in .env)';
  }

  // Solo path — exactly one provider is offerable.
  const p = cc
    ? { id: 'claude-code', hint: CC_HINT, question: CC_QUESTION, marker: CC_PROMPT_MARKER, flag: '--llm claude-code' }
    : { id: 'codex-cli', hint: CODEX_HINT, question: CODEX_QUESTION, marker: CODEX_PROMPT_MARKER, flag: '--llm codex-cli' };
  if (!io.isTTY) {
    io.print(p.hint);
    return `llm: hint printed (non-interactive — use ${p.flag} to enable)`;
  }
  const answer = (await io.ask(p.question)).trim().toLowerCase();
  if (answer === 'y' || answer === 'yes') {
    await appendEnvLines(['MAI_LLM_SUMMARY=1', `MAI_LLM_PROVIDER=${p.id}`], envFile);
    return `llm: ${p.id} (subscription) enabled — summaries need no API key`;
  }
  await appendEnvLines([`${p.marker}=1`], envFile);
  return `llm: declined (re-enable any time: MAI_LLM_PROVIDER=${p.id} in .env)`;
}

export const EMB_PROMPT_MARKER = 'MAI_EMB_PROMPTED';
export const EMB_HINT =
  '✦ Semantic search available with zero keys — enable with MAI_EMBEDDINGS=1 (local model, ~35MB one-time download)';
export const EMB_QUESTION = [
  'Enable local semantic search? Downloads a ~35MB model once (stored in',
  '~/.mai-mcp/models); runs fully offline — nothing leaves your machine. [Y/n] ',
].join('\n');

export type EmbeddingsChoice = 'local' | 'none' | undefined;

/** Offer local embeddings once. Cloud keys win silently (spec §1/§5): the
 * prompt exists ONLY for the keyless case, so a Voyage/OpenAI user never
 * downloads anything unnecessarily. */
export async function maybeOfferLocalEmbeddings(
  io: ConsentIO,
  explicit: EmbeddingsChoice,
  envFile: string = defaultEnvPath()
): Promise<string | null> {
  const env = await readEnvFile(envFile);
  const configured =
    process.env.MAI_EMBEDDINGS !== undefined || /^MAI_EMBEDDINGS=/m.test(env) || routingSnapshot().brain !== null;
  // Mirror detectProvider()'s TRUTHINESS test, not `!== undefined` (pass-7 B4).
  // `OPENAI_API_KEY=` in a .env — how people usually disable a key — is defined
  // but falsy: detectProvider() skips it and picks local, while the old check
  // saw a "cloud key", suppressed the prompt, and never downloaded. The user
  // ends up on a tier they were never offered, and `--embeddings local` told
  // them a cloud tier had won. Same normalisation both sides.
  const { hasCloudKey } = await import('../embeddings.js');
  const savedBrain=routingSnapshot().brain;
  const environmentSelects=process.env.OPENAI_API_KEY!==undefined||process.env.VOYAGE_API_KEY!==undefined;
  const cloudKey=environmentSelects
    ? hasCloudKey(process.env.OPENAI_API_KEY)||hasCloudKey(process.env.VOYAGE_API_KEY)
    : Boolean(savedBrain?.enabled&&(savedBrain.provider==='openai'||savedBrain.provider==='voyage')&&credentialConfigured(savedBrain.provider));
  const prompted = new RegExp(`^${EMB_PROMPT_MARKER}=`, 'm').test(env);

  if (explicit === 'none') {
    if (!configured && !prompted) await appendEnvLines([`${EMB_PROMPT_MARKER}=1`], envFile);
    return 'embeddings: skipped (--embeddings none)';
  }
  if (explicit === 'local') {
    if (!environmentSelects && savedBrain && savedBrain.provider !== 'local') {
      return 'embeddings: saved cloud routing is selected — change brain embeddings in Providers & Connections before selecting local';
    }
    if (process.env.MAI_EMBEDDINGS === undefined && !/^MAI_EMBEDDINGS=/m.test(env) && savedBrain?.enabled === false) {
      return 'embeddings: disabled in Providers & Connections — enable brain embeddings there before downloading the local model';
    }
    // Explicit request NEVER fails silently (review W3 — the plan-13 pass-2 W6
    // precedent). Ordered BEFORE the configured/cloudKey silent return, which
    // previously swallowed a scripted --embeddings local without a word.
    if (cloudKey) {
      return 'embeddings: cloud key present — the cloud tier already wins; local model not downloaded (--embeddings local has no effect)';
    }
    // Configured-but-disabled (pass-4 W8): downloading ~35MB and reporting
    // "enabled" while MAI_EMBEDDINGS=0 keeps everything off would lie twice.
    // .trim() the capture (pass-6 N4): on a CRLF .env the `(.*)` grabs a
    // trailing \r, so configuredValue is "1\r", fails !== '1', and the user is
    // told they explicitly disabled embeddings they in fact enabled.
    const configuredValue =
      process.env.MAI_EMBEDDINGS ?? env.match(/^MAI_EMBEDDINGS=(.*)$/m)?.[1]?.trim() ?? null;
    if (configuredValue !== null && configuredValue !== '1') {
      return `embeddings: explicitly disabled (MAI_EMBEDDINGS=${configuredValue}) — set MAI_EMBEDDINGS=1 in .env to enable, then re-run`;
    }
    if (!configured) await appendEnvLines(['MAI_EMBEDDINGS=1'], envFile);
    return await downloadNow(io);
  }
  if (configured || cloudKey) return null; // cloud tier or user-managed — never download
  if (prompted) return null;
  if (!io.isTTY) {
    io.print(EMB_HINT);
    return 'embeddings: hint printed (non-interactive — use --embeddings local to enable)';
  }
  const answer = (await io.ask(EMB_QUESTION)).trim().toLowerCase();
  if (answer === '' || answer === 'y' || answer === 'yes') { // default YES (free + private)
    await appendEnvLines(['MAI_EMBEDDINGS=1'], envFile);
    return await downloadNow(io);
  }
  await appendEnvLines([`${EMB_PROMPT_MARKER}=1`], envFile);
  return 'embeddings: declined (re-enable any time: MAI_EMBEDDINGS=1 in .env)';
}

/** Progress goes through the INJECTED io, never console.log (pass-5 W3): the
 * whole point of plan 13's ConsentIO seam is that consent output is testable
 * and that scripted paths (`--embeddings local` in CI) control their own
 * stdout. A bare console.log here would also print into every `npm test` run. */
async function downloadNow(io: ConsentIO): Promise<string> {
  io.print('embeddings: downloading local model (~35MB, one-time)…');
  // The .env line we just appended does not reach THIS process (dotenv already
  // ran at import time), so without this the failure branch's embeddingsStatus()
  // below would read "disabled" for a tier we just enabled. (Pass-6 N1 corrected
  // an earlier claim here: init's post-verify calls verifyProject(), which never
  // reports embeddings — that line lives only in cmdVerify, which runInit does
  // not call. The failure-branch reason is the real and sufficient one.)
  process.env.MAI_EMBEDDINGS = '1';
  const { downloadLocalModel, LOCAL_EMBED_MODEL, embeddingsStatus } = await import('../embeddings.js');
  const ok = await downloadLocalModel();
  return ok
    ? `embeddings: local semantic search enabled (${LOCAL_EMBED_MODEL})`
    : `embeddings: enabled — ${embeddingsStatus()}`;
}
