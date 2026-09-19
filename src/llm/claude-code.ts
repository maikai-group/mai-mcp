// claude-code provider — headless Claude Code (`claude -p`) on the user's
// subscription; no API key. Contract probed live 2026-08-08 (spec §2).
// Spec: docs/superpowers/specs/2026-08-08-claude-code-provider-design.md
import type { ChildProcess } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { extractJSON } from './json.js';
import { subscriptionChildEnv } from './child-env.js';
import type { JSONSchema, LLMProvider } from './provider.js';
import { findExecutable, spawnArgv, spawnArgvSync } from '../platform/commands.js';
import { defaultProcessOps } from '../platform/processes.js';

/** Bounded per-call timeout; env override exists for tests only. */
export const CC_TIMEOUT_MS = Number(process.env.MAI_CC_TIMEOUT_MS ?? 120_000);

/**
 * Stable, never-registered scratch cwd — LOAD-BEARING recursion guard (spec §4).
 * Headless calls write transcripts keyed by cwd; this path matches no registered
 * repo, so ingest discovery never routes provider transcripts into any brain,
 * and no project .mcp.json/hooks load into the headless session.
 */
export function ccScratchCwd(): string {
  const dir = path.join(os.homedir(), '.mai-mcp', 'cc-provider-cwd');
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

let binaryProbe: boolean | null = null;
/** Cached bounded probe: is a `claude` binary on PATH? Never throws. */
export function claudeBinaryAvailable(): boolean {
  if (binaryProbe !== null) return binaryProbe;
  try {
    const executable = findExecutable('claude', { env: process.env });
    if (!executable) return binaryProbe = false;
    const res = spawnArgvSync(executable, ['--version'], { timeout: 5_000, stdio: 'ignore' });
    binaryProbe = res.status === 0;
  } catch {
    binaryProbe = false;
  }
  return binaryProbe;
}
/** Test hook — the probe caches per process. */
export function resetClaudeBinaryProbe(): void {
  binaryProbe = null;
}

interface CcWrapper {
  is_error?: boolean;
  result?: unknown;
}

export class ClaudeCodeProvider implements LLMProvider {
  readonly name = 'claude-code';
  private readonly model: string | undefined;

  /** model undefined → no --model flag → the user's own Claude Code default. */
  constructor(model?: string) {
    this.model = model;
  }

  completeJSON(args: {
    prompt: string;
    schema: JSONSchema;
    schemaName: string;
    maxTokens: number; // no CLI control for output tokens — accepted (spec §3)
  }): Promise<unknown | null> {
    const argv = ['-p', '--output-format', 'json'];
    if (this.model) argv.push('--model', this.model);
    // Schema rides in the prompt — the CLI has no structured-output parameter;
    // callers already validate at their boundary (existing contract).
    const prompt = [
      args.prompt,
      '',
      `Respond with STRICT JSON only (no prose, no markdown fences) conforming to this JSON Schema named '${args.schemaName}':`,
      JSON.stringify(args.schema),
    ].join('\n');

    return new Promise((resolve) => {
      let settled = false;
      const done = (v: unknown | null): void => {
        if (!settled) {
          settled = true;
          resolve(v);
        }
      };
      let child: ChildProcess;
      const childEnv = subscriptionChildEnv(['CLAUDE_CONFIG_DIR']);
      const executable = findExecutable('claude', { env: childEnv });
      if (!executable) return done(null);
      try {
        // Prompt via STDIN, never argv — segment prompts reach ~225K chars (spec §3).
        // stderr is CAPTURED (bounded): the top real failures — not logged in,
        // rate window exhausted, bad --model — explain themselves only there
        // (pass-4 W2); ignoring it left users with a bare exit code.
        // AUTH CONTRACT — ALLOWLIST (decision 48797d3e, user-approved
        // 2026-08-11; supersedes the 2026-08-09 drop-list amendment):
        // subscription login IS the auth path. The child sees ONLY
        // subscriptionChildEnv()'s allowlist (+ CLAUDE_CONFIG_DIR) — every
        // credential and unrelated secret is absent by construction; a CLI
        // preferring env credentials over its login would silently API-bill
        // the very users this provider exists to spare. No opt-out knob
        // (rejected: re-arms the silent-billing footgun). Add a genuinely
        // required var WITH a test — never by widening to a drop-list.
        child = spawnArgv(executable, argv, {
          cwd: ccScratchCwd(),
          env: childEnv,
          stdio: ['pipe', 'pipe', 'pipe'],
          shell: false,
        });
      } catch {
        return done(null);
      }
      const processOps = defaultProcessOps();
      const pid = child.pid;
      const birth = pid === undefined ? Promise.resolve(null)
        : processOps.processBirthId(pid).catch(() => null);
      let timedOut = false;
      let stdinFailed = false;
      let exitReported = false;
      let ending: Promise<void> | null = null;
      const terminate = (): Promise<void> => {
        if (ending) return ending;
        ending = (async () => {
          try {
            const captured = await birth;
            if (pid !== undefined && child.exitCode === null && child.signalCode === null) {
              if (captured === null) throw new Error('process identity unavailable');
              await processOps.terminateTree(pid, async () => child.exitCode === null
                && child.signalCode === null && await processOps.processBirthId(pid) === captured);
            }
          } catch {
            console.warn('[mai-llm] claude -p cleanup could not be proved');
          } finally {
            child.stdout?.destroy();
            child.stderr?.destroy();
            child.stdin?.destroy();
            done(null);
          }
        })();
        void ending.catch(() => undefined);
        return ending;
      };
      const timer = setTimeout(() => {
        timedOut = true;
        console.warn('[mai-llm] claude -p timed out');
        void terminate();
      }, CC_TIMEOUT_MS);
      let out = '';
      let errTail = '';
      child.stdout?.setEncoding('utf8');
      child.stdout?.on('data', (chunk: string) => {
        out += chunk;
      });
      child.stderr?.setEncoding('utf8');
      child.stderr?.on('data', (chunk: string) => {
        errTail = (errTail + chunk).slice(-2048); // bounded tail — keep the end, that's where the reason lands
      });
      child.stderr?.on('error', () => { /* stream error must never throw uncaught (same class as stdin's) */ });
      child.on('error', () => {
        clearTimeout(timer);
        void terminate();
      });
      child.on('close', (code, signal) => {
        clearTimeout(timer);
        // Timeout already reported its own reason — the trailing close (SIGKILL
        // → non-zero code) must not log a second one. Gate on timedOut, NOT
        // settled: the stdin-EPIPE path settles silently and RELIES on this
        // handler to print the stderr diagnosis (not logged in, rate limit).
        if (timedOut) return;
        if (ending) {
          if (stdinFailed && !exitReported) {
            exitReported = true;
            console.warn(`[mai-llm] claude -p exited ${code ?? signal ?? 'unknown'}${errTail ? `: ${errTail.slice(-500).trim()}` : ''}`);
          }
          return;
        }
        if (code !== 0) {
          exitReported = true;
          console.warn(`[mai-llm] claude -p exited ${code}${errTail ? `: ${errTail.slice(-500).trim()}` : ''}`);
          return done(null);
        }
        let wrapper: CcWrapper;
        try {
          wrapper = JSON.parse(out) as CcWrapper;
        } catch {
          console.warn('[mai-llm] claude -p: unparseable output wrapper');
          return done(null);
        }
        if (wrapper.is_error === true || typeof wrapper.result !== 'string') {
          console.warn('[mai-llm] claude -p: is_error or missing result');
          return done(null);
        }
        const parsed = extractJSON(wrapper.result);
        if (parsed === null) console.warn('[mai-llm] claude -p: no parseable JSON in result');
        done(parsed);
      });
      // LOAD-BEARING (review B1 / lesson 892ec20e): the prompt is ~225K chars —
      // far past the pipe buffer, so the write is chunked. If claude exits
      // mid-write (not logged in, rate-limited, bad --model), stdin emits
      // 'error' (EPIPE); an unlistened stream 'error' is an UNCAUGHT EXCEPTION
      // that kills the ingest process. child.on('error') does NOT cover it.
      child.stdin?.on('error', () => {
        // Rider fix (plan-19 pass-5 B2, proved live on the codex mirror):
        // stdin can error while the child is STILL ALIVE (fd 0 closed,
        // process running) — clearing the timer alone would strand an
        // unbounded subscription-billed process behind a resolved-null
        // promise. Kill + destroy remaining stdio FIRST, mirroring the
        // timeout branch's shape; then settle. A dead child (the plain EPIPE
        // case) makes the kill a no-op and close still prints its one exit
        // diagnosis — this handler never logs, so it cannot duplicate.
        stdinFailed = true;
        clearTimeout(timer);
        void terminate();
      });
      child.stdin?.end(prompt);
    });
  }
}
