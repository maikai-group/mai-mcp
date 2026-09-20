// Origin: forked from the Mai Group's predecessor memory server (private).
/**
 * mai-mcp ingest — parses a Claude Code session JSONL into one code_sessions row
 * (+ code_commits). Facts only: counters, duration, model, commits. No per-event
 * or agent-workflow storage — those tables do not exist in mai by design.
 * Library-only: src/scripts/ingest-session.ts is the entry point; the optional
 * Haiku summary + candidate-decision extraction also live there.
 */
import fs from "node:fs";
import path from "node:path";
import readline from "node:readline";
import { getPool, getProjectId } from "./db.js";

interface JsonlEntry {
  type?: string;
  role?: string;
  sessionId?: string;
  timestamp?: string;
  isCompactSummary?: boolean;
  compactMetadata?: Record<string, unknown>;
  message?: {
    content?: unknown;
    model?: string;
  };
  toolUseResult?: {
    stdout?: string;
    stderr?: string;
    interrupted?: boolean;
  };
}

interface ThinkingBlock {
  text: string;
  timestamp?: string;
}

interface FileEventRaw {
  action: "read" | "write" | "edit";
  filePath: string;
  content?: string;
  diffOld?: string;
  diffNew?: string;
  language?: string;
  timestamp?: string;
}

interface BashEventRaw {
  command: string;
  description?: string;
  stdout?: string;
  exitCode?: number;
  timestamp?: string;
}

interface CommitRaw {
  hash: string;
  message: string;
  filesChanged?: string[];
  linesAdded?: number;
  linesRemoved?: number;
}

interface TestRunRaw {
  testFiles?: number;
  testsTotal?: number;
  testsPassing?: number;
  testsFailing?: number;
  testsSkipped?: number;
}

// ----------------- extractors -----------------

export function extractCommits(text: string): CommitRaw[] {
  const commits: CommitRaw[] = [];
  const seen = new Set<string>();

  // "[branch abcd1234] feat(scope): message"
  const pattern = /\[\S+\s+([0-9a-f]{7,40})\]\s+(.+)/gi;
  let m;
  while ((m = pattern.exec(text)) !== null) {
    const hash = m[1];
    if (seen.has(hash)) continue;
    seen.add(hash);
    commits.push({ hash, message: m[2].split("\n")[0].trim() });
  }

  // git log -1 line-stat summaries: " 4 files changed, 120 insertions(+), 12 deletions(-)"
  // attach to the most recent commit if we can
  if (commits.length > 0) {
    const statMatch = text.match(
      /(\d+)\s+files?\s+changed(?:,\s+(\d+)\s+insertions?\(\+\))?(?:,\s+(\d+)\s+deletions?\(-\))?/i
    );
    if (statMatch) {
      const latest = commits[commits.length - 1];
      latest.linesAdded = Number(statMatch[2] ?? 0);
      latest.linesRemoved = Number(statMatch[3] ?? 0);
    }
  }

  // "create mode 100644 path/to/file" OR " path/to/file | 12 +"
  const fileCreateMatches = text.match(/^\s+create mode \d+\s+(\S+)/gim);
  const filePipeMatches = text.match(/^\s+(\S+)\s+\|\s+\d+\s+[+-]+/gim);
  const files = new Set<string>();
  for (const f of [...(fileCreateMatches ?? []), ...(filePipeMatches ?? [])]) {
    const parts = f.trim().split(/\s+/);
    if (parts[0] === "create" && parts[1] === "mode") {
      files.add(parts[3]);
    } else {
      files.add(parts[0]);
    }
  }
  if (files.size > 0 && commits.length > 0) {
    commits[commits.length - 1].filesChanged = Array.from(files);
  }

  return commits;
}

export function extractTestResults(text: string): TestRunRaw | null {
  // vitest:   "Test Files  12 passed (12)"  +  "Tests       60 passed (60)"
  const vitestFiles = text.match(/Test Files\s+(\d+)\s+passed(?:\s+\|\s+(\d+)\s+failed)?(?:\s+\(\d+\))?/i);
  const vitestTests = text.match(/Tests\s+(\d+)\s+passed(?:\s+\|\s+(\d+)\s+failed)?(?:\s+\|\s+(\d+)\s+skipped)?(?:\s+\(\d+\))?/i);
  if (vitestFiles && vitestTests) {
    return {
      testFiles: Number(vitestFiles[1]),
      testsPassing: Number(vitestTests[1]),
      testsFailing: Number(vitestTests[2] ?? 0),
      testsSkipped: Number(vitestTests[3] ?? 0),
      testsTotal:
        Number(vitestTests[1]) + Number(vitestTests[2] ?? 0) + Number(vitestTests[3] ?? 0),
    };
  }

  // jest: "Tests: 10 failed, 50 passed, 60 total"
  const jest = text.match(/Tests:\s+(?:(\d+)\s+failed,\s+)?(?:(\d+)\s+skipped,\s+)?(\d+)\s+passed,\s+(\d+)\s+total/i);
  if (jest) {
    return {
      testsPassing: Number(jest[3]),
      testsFailing: Number(jest[1] ?? 0),
      testsSkipped: Number(jest[2] ?? 0),
      testsTotal: Number(jest[4]),
    };
  }

  // pytest:  "=== 12 passed, 2 failed in 3.12s ===" OR "=== 12 passed in 3.12s ==="
  const pytest = text.match(/=+\s+(\d+)\s+passed(?:,\s+(\d+)\s+failed)?(?:,\s+(\d+)\s+skipped)?.*?in\s+[\d.]+\s*s?=*/i);
  if (pytest) {
    return {
      testsPassing: Number(pytest[1]),
      testsFailing: Number(pytest[2] ?? 0),
      testsSkipped: Number(pytest[3] ?? 0),
      testsTotal:
        Number(pytest[1]) + Number(pytest[2] ?? 0) + Number(pytest[3] ?? 0),
    };
  }

  // go test:  "ok  \tpackage  0.123s"  -> count as passing runs; not precise enough, skip
  return null;
}

export function detectLanguage(filePath: string): string {
  const ext = path.extname(filePath).toLowerCase();
  const map: Record<string, string> = {
    ".ts": "typescript",
    ".tsx": "typescript",
    ".js": "javascript",
    ".jsx": "javascript",
    ".gd": "gdscript",
    ".py": "python",
    ".rs": "rust",
    ".go": "go",
    ".java": "java",
    ".kt": "kotlin",
    ".swift": "swift",
    ".c": "c",
    ".cpp": "cpp",
    ".h": "c-header",
    ".hpp": "cpp-header",
    ".md": "markdown",
    ".sql": "sql",
    ".sh": "bash",
    ".json": "json",
    ".yaml": "yaml",
    ".yml": "yaml",
    ".toml": "toml",
    ".tres": "godot-resource",
    ".tscn": "godot-scene",
    ".gdshader": "godot-shader",
  };
  return map[ext] ?? "other";
}

// ----------------- main parse loop -----------------

export interface ParsedSession {
  sessionId?: string;
  /** Working directory the session ran in (Codex rollouts carry it; used for project routing). */
  cwd?: string;
  /** Which harness produced the transcript ('codex' | undefined = claude-code legacy). */
  harness?: string;
  firstTs?: string;
  lastTs?: string;
  model?: string;
  messageCount: number;
  toolCalls: number;
  filesRead: number;
  filesWritten: number;
  filesEdited: number;
  // Parsed in-memory for the optional Haiku summary/extraction layer (Task 8).
  // Not persisted to dedicated tables — mai has none.
  thinkingBlocks: ThinkingBlock[];
  fileEvents: FileEventRaw[];
  bashEvents: BashEventRaw[];
  commits: CommitRaw[];
  testRuns: TestRunRaw[];
}

export interface JsonlReducer {
  state: ParsedSession;
  /** Feed one parsed JSONL entry; mirrors the historical parseJsonl loop body exactly. */
  feed(entry: unknown): void;
}

/** Count of non-empty thinking parts — must match what feed() pushes. */
export function countJsonlThinking(raw: unknown): number {
  const content = (raw as JsonlEntry).message?.content;
  if (!Array.isArray(content)) return 0;
  let n = 0;
  for (const part of content as Array<Record<string, unknown>>) {
    if (part.type === "thinking" && String(part.thinking ?? "").trim()) n++;
  }
  return n;
}

export function isJsonlCompaction(raw: unknown): boolean {
  const e = raw as JsonlEntry;
  return e.isCompactSummary === true || e.compactMetadata != null;
}

export function createJsonlReducer(): JsonlReducer {
  const state: ParsedSession = {
    messageCount: 0,
    toolCalls: 0,
    filesRead: 0,
    filesWritten: 0,
    filesEdited: 0,
    thinkingBlocks: [],
    fileEvents: [],
    bashEvents: [],
    commits: [],
    testRuns: [],
  };

  // Pending tool_use → resolved when tool_result arrives
  const pendingTools = new Map<
    string,
    { name: string; input: Record<string, unknown>; timestamp?: string }
  >();

  function feed(raw: unknown): void {
    const entry = raw as JsonlEntry;
    if (entry.sessionId && !state.sessionId) state.sessionId = entry.sessionId;
    if (entry.timestamp) {
      if (!state.firstTs) state.firstTs = entry.timestamp;
      state.lastTs = entry.timestamp;
    }
    if (entry.message?.model && !state.model) state.model = entry.message.model;
    if (entry.type === "user" || entry.type === "assistant") state.messageCount++;

    const content = entry.message?.content;
    if (!Array.isArray(content)) return; // was `continue` in the loop — same skip semantics

    for (const part of content as Array<Record<string, unknown>>) {
      if (part.type === "thinking") {
        const text = String(part.thinking ?? "").trim();
        if (text) {
          state.thinkingBlocks.push({ text, timestamp: entry.timestamp });
        }
      } else if (part.type === "tool_use") {
        state.toolCalls++;
        const toolName = String(part.name ?? "");
        const input = (part.input ?? {}) as Record<string, unknown>;
        const toolId = String(part.id ?? "");

        if (toolName === "Read") state.filesRead++;
        else if (toolName === "Write") {
          state.filesWritten++;
          const filePath = String(input.file_path ?? "");
          const fileContent = String(input.content ?? "");
          if (filePath) {
            state.fileEvents.push({
              action: "write",
              filePath,
              content: fileContent,
              language: detectLanguage(filePath),
              timestamp: entry.timestamp,
            });
          }
        } else if (toolName === "Edit" || toolName === "MultiEdit") {
          state.filesEdited++;
          const filePath = String(input.file_path ?? "");
          if (toolName === "Edit") {
            state.fileEvents.push({
              action: "edit",
              filePath,
              diffOld: String(input.old_string ?? ""),
              diffNew: String(input.new_string ?? ""),
              language: detectLanguage(filePath),
              timestamp: entry.timestamp,
            });
          } else {
            const edits = (input.edits ?? []) as Array<Record<string, unknown>>;
            for (const e of edits) {
              state.fileEvents.push({
                action: "edit",
                filePath,
                diffOld: String(e.old_string ?? ""),
                diffNew: String(e.new_string ?? ""),
                language: detectLanguage(filePath),
                timestamp: entry.timestamp,
              });
            }
          }
        } else if (toolName === "Bash") {
          const command = String(input.command ?? "");
          const description = String(input.description ?? "");
          if (toolId) {
            pendingTools.set(toolId, {
              name: "Bash",
              input: { command, description },
              timestamp: entry.timestamp,
            });
          }
        }
      } else if (part.type === "tool_result") {
        const toolId = String(part.tool_use_id ?? "");
        const resultContent = part.content;
        let stdout = "";
        if (typeof resultContent === "string") stdout = resultContent;
        else if (Array.isArray(resultContent)) {
          for (const rc of resultContent as Array<Record<string, unknown>>) {
            if (rc.type === "text" && typeof rc.text === "string") stdout += rc.text;
          }
        }

        if (stdout) {
          state.commits.push(...extractCommits(stdout));
          const testRun = extractTestResults(stdout);
          if (testRun) state.testRuns.push(testRun);
        }

        const pending = pendingTools.get(toolId);
        if (pending && pending.name === "Bash") {
          state.bashEvents.push({
            command: String(pending.input.command ?? ""),
            description: String(pending.input.description ?? ""),
            stdout: stdout.slice(0, 500),
            exitCode: part.is_error ? 1 : 0,
            timestamp: pending.timestamp,
          });
          pendingTools.delete(toolId);
        }
      }
    }

    if (entry.toolUseResult?.stdout) {
      state.commits.push(...extractCommits(entry.toolUseResult.stdout));
      const testRun = extractTestResults(entry.toolUseResult.stdout);
      if (testRun) state.testRuns.push(testRun);
    }
  }

  return { state, feed };
}

export async function parseJsonl(jsonlPath: string): Promise<ParsedSession> {
  const r = createJsonlReducer();
  const stream = fs.createReadStream(jsonlPath, { encoding: "utf8" });
  const rl = readline.createInterface({ input: stream, crlfDelay: Infinity });
  for await (const line of rl) {
    if (!line.trim()) continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      continue;
    }
    r.feed(parsed);
  }
  return r.state;
}

// ----------------- write to DB (session row only) -----------------

/**
 * Write one code_sessions row for the pinned project. Returns the session UUID.
 * Idempotent: ON CONFLICT (original_session_id) updates the row. Commits are NOT
 * persisted here — git log is the ground truth (sync-commits.ts); the session's
 * commit/line counters stay 0. The optional Haiku summary + candidate-decision
 * extraction run separately in the ingest CLI.
 */
export class SessionProjectMismatchError extends Error {
  constructor() { super('Session belongs to another project'); }
}

export async function writeSession(parsed: ParsedSession, originalSessionId?: string): Promise<string> {
  const sid = originalSessionId ?? parsed.sessionId;
  if (!sid) throw new Error("No session id (neither the override param nor a JSONL sessionId).");

  const db = getPool();
  const projectId = await getProjectId();

  const duration =
    parsed.firstTs && parsed.lastTs
      ? Math.max(
          1,
          Math.round(
            (new Date(parsed.lastTs).getTime() - new Date(parsed.firstTs).getTime()) / 60000
          )
        )
      : null;

  // Commits + line counts are NOT taken from the transcript: git log is ground
  // truth (sync-commits.ts), which the SessionEnd hook runs right after ingest.
  // (Transcript scraping missed `git commit -q` and matched example text — the
  // Plan 2 dogfood finding.) These session counters stay 0; code_commits is
  // owned by the sync.
  const sessionRes = await db.query<{ id: string }>(
    `INSERT INTO code_sessions
       (project_id, original_session_id, started_at, ended_at, duration_minutes, model,
        message_count, tool_calls, files_read, files_written, files_edited,
        commits, lines_added, lines_removed)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,0,0,0)
     ON CONFLICT (original_session_id) DO UPDATE SET
       ended_at = EXCLUDED.ended_at,
       duration_minutes = EXCLUDED.duration_minutes,
       model = COALESCE(EXCLUDED.model, code_sessions.model),
       message_count = EXCLUDED.message_count,
       tool_calls = EXCLUDED.tool_calls,
       files_read = EXCLUDED.files_read,
       files_written = EXCLUDED.files_written,
       files_edited = EXCLUDED.files_edited
     WHERE code_sessions.project_id = EXCLUDED.project_id
     RETURNING id`,
    [
      projectId,
      sid,
      parsed.firstTs ?? null,
      parsed.lastTs ?? null,
      duration,
      parsed.model ?? null,
      parsed.messageCount,
      parsed.toolCalls,
      parsed.filesRead,
      parsed.filesWritten,
      parsed.filesEdited,
    ]
  );
  if (sessionRes.rows.length === 0) throw new SessionProjectMismatchError();
  const sessionId = sessionRes.rows[0].id;

  // --- Project stats (total_commits reflects sync-commits, not this ingest)
  await db.query(
    `UPDATE projects SET
       total_sessions = (SELECT COUNT(*) FROM code_sessions WHERE project_id = $1
                          AND (metadata->>'superseded_by_segmentation') IS DISTINCT FROM 'true'),
       total_commits = (
         SELECT COUNT(*) FROM code_commits c
         WHERE c.project_id = $1 AND NOT EXISTS (
           SELECT 1 FROM git_history_rewrites r
           WHERE r.commit_id = c.id AND r.new_hash IS NULL
         )
       ),
       last_active_at = NOW()
     WHERE id = $1`,
    [projectId]
  );

  return sessionId;
}
