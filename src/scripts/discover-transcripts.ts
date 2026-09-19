// Shared transcript discovery — ONE discovery per harness (plan 27 §2.3:
// reused, not rewritten), consumed by `mai reingest` (unbounded, cutoff 0) and
// the SessionEnd orphan sweep (bounded). Enumeration is scoped to the pinned
// project's registered roots by the caller-supplied repo list (iron rule 2).
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { codexHome, readRolloutMeta } from '../capture/codex.js';
import { collectRollouts, cwdMatchesRepo } from './ingest-codex.js';
import { readLinesWithOffsets } from '../capture/lines.js';
import { claudeTranscriptId } from '../capture/claude-transcript-id.js';
import type { TranscriptRef } from '../capture/segment-ingest.js';

/** Cast-free JSON property read for the zero-baseline check:casts ratchet. */
function nonEmptyStringProperty(value: unknown, key: string): string | null {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return null;
  for (const [name, field] of Object.entries(value)) {
    if (name === key) return typeof field === 'string' && field.length > 0 ? field : null;
  }
  return null;
}

/** Claude transcripts don't put cwd on line 1 — sniff the first entry that
 * carries one (verified live: dir names are lossily munged, cwd is the only
 * reliable router). Bounded to 200 lines. */
export async function sniffClaudeCwd(file: string): Promise<string | null> {
  let n = 0;
  for await (const { text } of readLinesWithOffsets(file)) {
    if (++n > 200) break;
    if (!text.trim()) continue;
    try {
      const parsed: unknown = JSON.parse(text);
      const cwd = nonEmptyStringProperty(parsed, 'cwd');
      if (cwd) return cwd;
    } catch {
      continue;
    }
  }
  return null;
}

/** ~/.claude/projects scan. `cutoffMs > 0` filters on file mtime BEFORE the
 * cwd sniff, so a bounded sweep stats cheaply instead of reading every file.
 * `projectsRoot` is a test seam only. */
export async function discoverClaude(
  repos: string[],
  cutoffMs = 0,
  projectsRoot = path.join(os.homedir(), '.claude', 'projects')
): Promise<TranscriptRef[]> {
  const out: TranscriptRef[] = [];
  let dirs: string[] = [];
  try {
    dirs = (await fsp.readdir(projectsRoot, { withFileTypes: true }))
      .filter((d) => d.isDirectory())
      .map((d) => path.join(projectsRoot, d.name));
  } catch {
    return out;
  }
  for (const dir of dirs) {
    let files: string[] = [];
    try {
      files = (await fsp.readdir(dir)).filter((f) => f.endsWith('.jsonl'));
    } catch {
      continue;
    }
    for (const f of files) {
      const file = path.join(dir, f);
      if (cutoffMs > 0) {
        try {
          if ((await fsp.stat(file)).mtimeMs < cutoffMs) continue;
        } catch {
          continue; // raced deletion
        }
      }
      const cwd = await sniffClaudeCwd(file);
      if (!cwd || !cwdMatchesRepo(cwd, repos)) continue;
      out.push({
        path: file,
        transcriptId: claudeTranscriptId(file),
        harness: 'claude-code',
        cwd,
      });
    }
  }
  return out;
}

/** Codex rollout scan (line-1 session_meta.cwd routing, decision 56a56090). */
export async function discoverCodex(
  repos: string[],
  cutoffMs = 0,
  sessionsRoot = path.join(codexHome(), 'sessions')
): Promise<TranscriptRef[]> {
  const rollouts = await collectRollouts(sessionsRoot, cutoffMs);
  const out: TranscriptRef[] = [];
  for (const { file } of rollouts) {
    const meta = await readRolloutMeta(file);
    if (!meta || !cwdMatchesRepo(meta.cwd, repos)) continue;
    out.push({ path: file, transcriptId: meta.sessionId, harness: 'codex', cwd: meta.cwd });
  }
  return out;
}

export interface DiscoveryRoots {
  /** Test-only root overrides; production omits both. */
  claudeProjects?: string;
  codexSessions?: string;
}

/** The one production union used by the default sweep path. */
export async function discoverProjectTranscripts(
  repos: string[],
  cutoffMs: number,
  roots: DiscoveryRoots = {}
): Promise<TranscriptRef[]> {
  return [
    ...(await discoverCodex(repos, cutoffMs, roots.codexSessions)),
    ...(await discoverClaude(repos, cutoffMs, roots.claudeProjects)),
  ];
}
