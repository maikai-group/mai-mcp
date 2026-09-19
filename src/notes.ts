// Origin: forked from the Mai Group's predecessor memory server (private).
import fs from "node:fs/promises";
import path from "node:path";
import { trackingDir } from "./paths.js";
import { verifyCatC, enforceCharLimits, recordWriteSuccess, type NoteTriggerEvidence } from "./write-gate.js";

export type NoteType = "decision" | "progress" | "todo" | "question";

const VALID_TYPES: NoteType[] = ["decision", "progress", "todo", "question"];

// Each note type maps to a dedicated aggregate file (grows across all sessions).
const TYPE_FILES: Record<NoteType, string> = {
  decision: "decisions.md",
  progress: "progress.md",
  todo: "todos.md",
  question: "questions.md",
};

const TYPE_HEADERS: Record<NoteType, string> = {
  decision:
    "# Decisions\n\nDurable decisions that change direction. Auto-appended by mai-mcp; cross-reference to the daily session log for context.\n\n",
  progress:
    "# Progress notes\n\nMeaningful milestones and completion markers. Auto-appended by mai-mcp.\n\n",
  todo: "# Open TODOs\n\nDeferred or discovered work items. Check/clear by hand periodically.\n\n",
  question:
    "# Open questions\n\nUnresolved questions that need the user's input or further research.\n\n",
};

// LOCAL-time stamps (not UTC). The session-log slug is the handoff key, and a
// UTC date rolls over mid-evening in western timezones — splitting one continuous
// session across two log files and confusing the next prime. getFullYear/getMonth/
// getDate/getHours are local-tz accessors, so the slug matches the wall clock.
// Exported for the regression test in notes.test.ts.
export function todayStamp(): string {
  const d = new Date();
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

export function timeStamp(): string {
  const d = new Date();
  const h = String(d.getHours()).padStart(2, "0");
  const min = String(d.getMinutes()).padStart(2, "0");
  const s = String(d.getSeconds()).padStart(2, "0");
  return `${h}:${min}:${s}`;
}

async function ensureFile(filePath: string, header: string): Promise<void> {
  const exists = await fs
    .stat(filePath)
    .then(() => true)
    .catch(() => false);
  if (!exists) {
    await fs.writeFile(filePath, header, "utf8");
  }
}

export async function appendNote(
  type: string,
  content: string,
  evidence: NoteTriggerEvidence | undefined,
  toolName = 'mai_note'
): Promise<string[]> {
  if (!VALID_TYPES.includes(type as NoteType)) {
    throw new Error(
      `Invalid note type "${type}". Must be one of: ${VALID_TYPES.join(", ")}`
    );
  }
  if (!content || !content.trim()) {
    throw new Error("Note content is required and cannot be empty.");
  }
  const noteType = type as NoteType;

  // Cat C gate: structured trigger evidence + char limit on content.
  await enforceCharLimits({
    fields: { content },
    toolName,
  });

  await verifyCatC({
    evidence,
    toolName,
    payloadFingerprint: content,
  });

  const dir = trackingDir();
  await fs.mkdir(dir, { recursive: true });

  const typePath = path.join(dir, TYPE_FILES[noteType]);
  const dayPath = path.join(dir, `session-log-${todayStamp()}.md`);

  await ensureFile(typePath, TYPE_HEADERS[noteType]);
  await ensureFile(
    dayPath,
    `# Session log — ${todayStamp()}\n\nAuto-captured decisions, progress, TODOs, questions, and file changes.\n\n`
  );

  const trimmed = content.trim();
  const ts = timeStamp();
  const today = todayStamp();

  // Aggregate type file: dated + timestamped for audit trail.
  const typeLine = `- **${today} ${ts}** — ${trimmed}\n`;
  await fs.appendFile(typePath, typeLine, "utf8");

  // Daily session log: type-tagged for narrative scan.
  const dayLine = `- **[${ts}] ${noteType}** — ${trimmed}\n`;
  await fs.appendFile(dayPath, dayLine, "utf8");

  await recordWriteSuccess();
  return [typePath, dayPath];
}

/**
 * mai_progress — milestone journal. Thin wrapper: type='progress' with the
 * same Cat C evidence contract, tool-named separately so violations and
 * hook nudges can target it.
 */
export async function appendProgress(
  milestone: string,
  evidence: NoteTriggerEvidence | undefined
): Promise<string[]> {
  return appendNote('progress', milestone, evidence, 'mai_progress');
}
