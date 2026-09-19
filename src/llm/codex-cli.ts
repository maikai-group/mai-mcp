// codex-cli provider — headless Codex (`codex exec`) on the user's ChatGPT
// subscription; no API key. Contract probed live 2026-08-11 on codex-cli
// 0.147.0 (spec §2). Deliberate mirror of ./claude-code.ts (plan 13) with two
// capability deltas: native --output-schema structured output, and the result
// in a -o file (stdout is progress noise, never parsed).
// Spec: docs/superpowers/specs/2026-08-11-codex-cli-provider-design.md
import type { ChildProcess } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { CC_TIMEOUT_MS } from './claude-code.js';
import { subscriptionChildEnv } from './child-env.js';
import type { CodexReasoningEffort, JSONSchema, LLMProvider } from './provider.js';
import { findExecutable, spawnArgv, spawnArgvSync } from '../platform/commands.js';
import { defaultProcessOps } from '../platform/processes.js';

/**
 * Stable, never-registered scratch cwd — trust/recursion guard (spec §2).
 * --ephemeral already suppresses rollout transcripts (verified live), but the
 * scratch cwd additionally guarantees headless calls never load a repo's
 * AGENTS.md / .codex config trust into the child session.
 */
export function codexScratchCwd(): string {
  const dir = path.join(os.homedir(), '.mai-mcp', 'codex-provider-cwd');
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

let binaryProbe: boolean | null = null;
/** Cached bounded probe: `codex login status` exits 0 only when a codex binary
 * is on PATH AND logged in (verified 2026-08-11: prints "Logged in using
 * ChatGPT" / exit 0; logged out exits non-zero; missing binary → spawn error).
 * One probe covers both spec §3 conditions. Never throws. */
export function codexBinaryAvailable(): boolean {
  if (binaryProbe !== null) return binaryProbe;
  try {
    const executable = findExecutable('codex', { env: process.env });
    if (!executable) return binaryProbe = false;
    const res = spawnArgvSync(executable, ['login', 'status'], { timeout: 5_000, stdio: 'ignore' });
    binaryProbe = res.status === 0;
  } catch {
    binaryProbe = false;
  }
  return binaryProbe;
}
/** Test hook — the probe caches per process. */
export function resetCodexBinaryProbe(): void {
  binaryProbe = null;
}

export class CodexCliProvider implements LLMProvider {
  readonly name = 'codex-cli';
  private readonly model: string | undefined;
  private readonly reasoning: CodexReasoningEffort | undefined;

  /** model undefined → no -m flag → the user's own Codex default. */
  constructor(model?: string, reasoning?: CodexReasoningEffort) {
    this.model = model;
    this.reasoning = reasoning;
  }

  completeJSON(args: {
    prompt: string;
    schema: JSONSchema;
    schemaName: string;
    maxTokens: number; // no CLI control for output tokens — accepted (mirror of claude-code)
  }): Promise<unknown | null> {
    return new Promise((resolve) => {
      let settled = false;
      const done = (v: unknown | null): void => {
        if (!settled) {
          settled = true;
          resolve(v);
        }
      };
      // Per-call temp pair: schema in, result out. --output-schema is NATIVE
      // structured output — no schema-in-prompt, no fence-stripping (spec §2).
      // mkdtemp is deliberately SPLIT from the schema write (review B1): the
      // cleanup function exists the instant the directory does, so no failure
      // after creation can leak it.
      let tmpDir: string;
      try {
        tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mai-codex-'));
      } catch {
        return done(null); // nothing created — nothing to clean
      }
      let cleaned = false;
      // Cleanup runs on EVERY exit path — including the timeout-kill path,
      // where the close event may never surface past destroyed pipes (R4).
      const cleanup = (): void => {
        if (cleaned) return;
        cleaned = true;
        try {
          fs.rmSync(tmpDir, { recursive: true, force: true });
        } catch {
          /* best-effort — force:true already swallows ENOENT */
        }
      };
      const schemaFile = path.join(tmpDir, 'schema.json');
      const outFile = path.join(tmpDir, 'out.json');
      try {
        fs.writeFileSync(schemaFile, JSON.stringify(args.schema));
      } catch {
        // Serialization/write failure (e.g. a cyclic value reaching JSONSchema
        // through its unknown-typed members): clean the fresh dir, degrade.
        cleanup();
        return done(null);
      }
      // -s read-only: the summarizer must never execute workspace-mutating
      // commands. --ephemeral: one-shot runs stay out of Codex session history
      // (verified: zero rollout files written). Prompt via the `-` positional
      // reading STDIN, never argv — segment prompts reach ~225K chars, past
      // ARG_MAX (lesson 892ec20e).
      const argv = [
        'exec',
        '-s', 'read-only',
        '--skip-git-repo-check',
        '--ephemeral',
        '--output-schema', schemaFile,
        '-o', outFile,
      ];
      if (this.model) argv.push('-m', this.model);
      if (this.reasoning) argv.push('-c', `model_reasoning_effort=${this.reasoning}`);
      argv.push('-');
      let child: ChildProcess;
      const childEnv = subscriptionChildEnv(['CODEX_HOME']);
      const executable = findExecutable('codex', { env: childEnv });
      if (!executable) {
        cleanup();
        return done(null);
      }
      try {
        // AUTH SCRUB — ALLOWLIST (spec §2; decision 48797d3e, user-approved
        // 2026-08-11): the child sees ONLY subscriptionChildEnv()'s allowlist
        // (+ CODEX_HOME) — PATH/HOME (binary + ~/.codex auth), TERM, locale,
        // proxies, enterprise certs. Every credential and unrelated secret is
        // absent by construction; the AUTH SCRUB test pins the SHAPE (creds +
        // canary absent, HOME/PATH present).
        child = spawnArgv(executable, argv, {
          cwd: codexScratchCwd(),
          env: childEnv,
          stdio: ['pipe', 'pipe', 'pipe'],
          shell: false,
        });
      } catch {
        cleanup();
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
            console.warn('[mai-llm] codex exec cleanup could not be proved');
          } finally {
            child.stdout?.destroy();
            child.stderr?.destroy();
            child.stdin?.destroy();
            cleanup();
            done(null);
          }
        })();
        void ending.catch(() => undefined);
        return ending;
      };
      const timer = setTimeout(() => {
        timedOut = true;
        console.warn('[mai-llm] codex exec timed out');
        void terminate();
      }, CC_TIMEOUT_MS);
      // stdout carries PROGRESS NOISE ("tokens used…"), never the result — the
      // result is the -o file. Drain it so the pipe can't fill and stall the child.
      child.stdout?.resume();
      let errTail = '';
      child.stderr?.setEncoding('utf8');
      child.stderr?.on('data', (chunk: string) => {
        errTail = (errTail + chunk).slice(-2048); // bounded tail — the reason lands at the end
      });
      child.stderr?.on('error', () => { /* stream error must never throw uncaught */ });
      child.on('error', () => {
        clearTimeout(timer);
        void terminate();
      });
      child.on('close', (code, signal) => {
        clearTimeout(timer);
        // Timeout already reported its own reason and cleaned up — the trailing
        // close (SIGKILL → non-zero code) must not log a second one. Gate on
        // timedOut, NOT settled: the stdin-EPIPE path settles silently and
        // RELIES on this handler to print the stderr diagnosis (not logged in,
        // rate limit) — exact mirror of claude-code.ts.
        if (timedOut) return;
        if (ending) {
          if (stdinFailed && !exitReported) {
            exitReported = true;
            console.warn(`[mai-llm] codex exec exited ${code ?? signal ?? 'unknown'}${errTail ? `: ${errTail.slice(-500).trim()}` : ''}`);
          }
          return;
        }
        if (code !== 0) {
          exitReported = true;
          cleanup();
          console.warn(`[mai-llm] codex exec exited ${code}${errTail ? `: ${errTail.slice(-500).trim()}` : ''}`);
          return done(null);
        }
        let text: string;
        try {
          text = fs.readFileSync(outFile, 'utf8');
        } catch {
          cleanup();
          console.warn('[mai-llm] codex exec: output file missing/unreadable');
          return done(null);
        }
        cleanup();
        let parsed: unknown;
        try {
          parsed = JSON.parse(text);
        } catch {
          console.warn('[mai-llm] codex exec: unparseable output file');
          return done(null);
        }
        done(parsed);
      });
      // LOAD-BEARING (lesson 892ec20e): prompts far exceed the pipe buffer, so
      // the write is chunked. If codex exits mid-write (not logged in, rate
      // limited), stdin emits 'error' (EPIPE); an unlistened stream 'error' is
      // an UNCAUGHT EXCEPTION that kills the ingest process. child.on('error')
      // does NOT cover it.
      child.stdin?.on('error', () => {
        // pass-5 B2 (proved live): stdin can error while the child is STILL
        // ALIVE (fd 0 closed, process running) — clearing the timer alone
        // would strand an unbounded subscription-billed process behind a
        // resolved-null promise. Kill + destroy remaining stdio FIRST,
        // mirroring the timeout branch's shape; then settle. A dead child
        // (the plain EPIPE case) makes the kill a no-op and close still
        // prints its one exit diagnosis — this handler never logs, so the
        // diagnosis cannot duplicate.
        stdinFailed = true;
        clearTimeout(timer);
        void terminate();
      });
      child.stdin?.end(args.prompt);
    });
  }
}
