// Canonical Claude transcript identity. Every ingest path can observe the
// transcript path, while only the live SessionEnd hook receives session_id.
// Keeping storage identity path-derived prevents hook, sweep, and reingest
// from writing different code_sessions families against one path watermark.
import path from 'node:path';

export function claudeTranscriptId(transcriptPath: string): string {
  return path.basename(transcriptPath).replace(/\.jsonl$/, '');
}

export function claudePayloadIdMismatch(
  transcriptPath: string,
  payloadSessionId: string | undefined
): boolean {
  return payloadSessionId !== undefined && payloadSessionId !== claudeTranscriptId(transcriptPath);
}
