#!/usr/bin/env node
// SessionEnd hook entry. Reads the Claude Code hook payload from stdin
// ({session_id, transcript_path, cwd, ...}) or takes --file <jsonl> for
// manual/backfill runs. NEVER exits non-zero on ingest failure — a broken
// brain write must not break the user's session teardown.
import '../env.js';
import fs from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import { requirePinnedSlug } from '../env.js';
import { ClaudeCodeAdapter } from '../capture/claude-code.js';
import {
  claudePayloadIdMismatch,
  claudeTranscriptId,
} from '../capture/claude-transcript-id.js';
import { ingestTranscriptSegmented } from '../capture/segment-ingest.js';
import { finishAndExit } from '../exit.js';

async function readStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) chunks.push(Buffer.from(chunk));
  return Buffer.concat(chunks).toString('utf8');
}

function optionalStringProperty(value: unknown, key: string): string | undefined {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return undefined;
  for (const [name, field] of Object.entries(value)) {
    if (name === key) return typeof field === 'string' && field.length > 0 ? field : undefined;
  }
  return undefined;
}

export async function runIngestSession(opts: {
  argv?: string[];
  readInput?: () => Promise<string>;
} = {}): Promise<void> {
  requirePinnedSlug();
  const argv = opts.argv ?? process.argv;
  const readInput = opts.readInput ?? readStdin;

  // Per-run model override (e.g. Haiku for a cost-minimizing bulk backfill).
  const modelFlag = argv.indexOf('--summary-model');
  if (modelFlag !== -1 && argv[modelFlag + 1]) {
    process.env.MAI_SUMMARY_MODEL = argv[modelFlag + 1];
  }

  let transcriptPath: string | undefined;
  let sessionId: string | undefined;
  let cwd: string | undefined;

  const fileFlag = argv.indexOf('--file');
  if (fileFlag !== -1) {
    transcriptPath = argv[fileFlag + 1];
  } else {
    const payload: unknown = JSON.parse(await readInput());
    transcriptPath = optionalStringProperty(payload, 'transcript_path');
    sessionId = optionalStringProperty(payload, 'session_id');
    cwd = optionalStringProperty(payload, 'cwd');
  }
  if (!transcriptPath) throw new Error('No transcript path (stdin payload or --file).');
  await fs.access(transcriptPath);

  // The path is the one identity available to every Claude ingest path and is
  // already the watermark key. Payload session_id is validation evidence only:
  // preferring it here would let the hook and unattended sweep create disjoint
  // code_sessions families for the same file (finding eb7f763f).
  const transcriptId = claudeTranscriptId(transcriptPath);
  if (claudePayloadIdMismatch(transcriptPath, sessionId)) {
    console.warn(
      `mai-ingest: hook session_id '${sessionId}' differs from transcript filename ` +
      `'${transcriptId}'; using the filename as the canonical transcript identity.`
    );
  }
  await ingestTranscriptSegmented(new ClaudeCodeAdapter(), {
    path: transcriptPath,
    transcriptId,
    harness: 'claude-code',
    cwd: cwd ?? null,
  });
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  try {
    await runIngestSession();
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(`mai-ingest: FAILED (session continues unaffected): ${message}`);
  } finally {
    // hook-safe: always zero. finishAndExit closes the pool, so the previous
    // explicit getPool().end() is redundant — and the process.exit(0) that
    // followed it aborted whenever extraction had embedded a decision.
    await finishAndExit(0);
  }
}
