// Shared post-parse pipeline: persist the session row, then (env-gated) the
// LLM summary + candidate-decision extraction. Used by the Claude Code
// SessionEnd entry AND the Codex scan/transcript paths — one pipeline, no
// duplication (R5).
import type { ParsedSession } from '../ingest.js';
import { writeSession } from '../ingest.js';
import {
  llmSummaryEnabled,
  summarizeSession,
  applySummary,
  extractDecisions,
  persistExtractedDecisions,
} from '../summarize.js';

export async function persistParsedSession(
  parsed: ParsedSession,
  originalSessionId?: string,
  sourceLabel?: string
): Promise<string> {
  const sessionUuid = await writeSession(parsed, originalSessionId);
  console.error(
    `mai-ingest: session ${sessionUuid} written${sourceLabel ? ` from ${sourceLabel}` : ''}`
  );

  if (llmSummaryEnabled()) {
    const summary = await summarizeSession({ parsed });
    if (summary) {
      await applySummary(sessionUuid, summary);
      console.error('mai-ingest: summary applied');
    }
    const decisions = await extractDecisions({ parsed });
    // Always persist — even an empty extraction, so delete-and-replace clears a
    // prior over-extraction. Gating on length left stale candidates immortal.
    const written = await persistExtractedDecisions(sessionUuid, decisions);
    if (written > 0) {
      console.error(`mai-ingest: ${written} candidate decision(s) → review queue`);
    }
  }
  return sessionUuid;
}
