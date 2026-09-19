// Generic capture adapter — the universal workhorse (spec §4 B.3). Tier 1:
// install the brain block into a configurable rules file (AGENTS.md default —
// the emerging cross-tool standard; .cursorrules etc. via --rules-file).
// Tier 2: parseTranscript sniffs the format (Codex rollout vs Claude Code
// JSONL) so `mai ingest --transcript` works without a harness flag. MCP
// registration is manual for unknown tools — every tool's config differs.
import fsp from 'node:fs/promises';
import path from 'node:path';
import type { ParsedSession } from '../ingest.js';
import { parseJsonl } from '../ingest.js';
import { mergeRulesFile, RULES_MARKER } from '../scripts/init.js';
import { planRulesBlockUpgrade } from '../scripts/managed-block.js';
import { installGraduatedRulesBlock, planInstructionFileUpgrade } from '../rules-render.js';
import type { AdapterStatus, CaptureAdapter, InstallResult, PlannedChange, UpgradeOpts } from './adapter.js';
import type { TranscriptEntry } from './segment.js';
import { readRolloutMeta, parseCodexRollout, CodexAdapter } from './codex.js';
import { ClaudeCodeAdapter } from './claude-code.js';

export class GenericAdapter implements CaptureAdapter {
  readonly harness = 'generic';

  constructor(private readonly rulesFile: string = 'AGENTS.md') {}

  async install(repoPath: string, slug: string): Promise<InstallResult> {
    void slug; // rules-file block is slug-neutral; MCP registration is manual.
    const rules = await mergeRulesFile(repoPath, this.rulesFile, 'memory-brain-block-agents.md');
    const graduated = this.rulesFile === 'AGENTS.md'
      ? await installGraduatedRulesBlock(repoPath, 'AGENTS.md')
      : null;
    return {
      harness: this.harness,
      lines: [
        `${this.rulesFile} ${rules}`,
        ...(graduated === null ? [] : [`AGENTS.md graduated-rules ${graduated}`]),
        `mcp registration manual (add mai-mcp to your tool's MCP config — see README)`,
      ],
    };
  }

  async detect(repoPath: string): Promise<AdapterStatus> {
    let present = false;
    let installed = false;
    try {
      const raw = await fsp.readFile(path.join(repoPath, this.rulesFile), 'utf8');
      present = true;
      installed = raw.includes(RULES_MARKER);
    } catch {
      // no rules file
    }
    return { harness: this.harness, present, installed, detail: `rules file: ${this.rulesFile}` };
  }

  async planUpgrade(repoPath: string, _slug: string, opts: UpgradeOpts = {}): Promise<PlannedChange[]> {
    // Deliberately the EXACT default, not endsWith and not a generalized custom
    // path: only the standard target can be refreshed by the server-side
    // projection, because project metadata does not preserve custom filenames.
    if (this.rulesFile === 'AGENTS.md' && opts.graduatedRulesBlock !== undefined) {
      return planInstructionFileUpgrade(
        repoPath, 'AGENTS.md', 'memory-brain-block-agents.md', opts.graduatedRulesBlock
      );
    }
    const change = await planRulesBlockUpgrade(repoPath, this.rulesFile, 'memory-brain-block-agents.md');
    return change ? [change] : [];
  }

  /** Sniff the transcript format: Codex rollout (line 1 = session_meta) or Claude Code JSONL. */
  async parseTranscript(transcriptPath: string): Promise<ParsedSession> {
    const meta = await readRolloutMeta(transcriptPath);
    if (meta) return parseCodexRollout(transcriptPath);
    return parseJsonl(transcriptPath);
  }

  /** Codex rollout lines carry a `payload` envelope; Claude Code JSONL never does. */
  private concreteFor(entries: TranscriptEntry[]): CaptureAdapter {
    const first = entries[0]?.raw as { payload?: unknown } | undefined;
    return first && first.payload !== undefined ? new CodexAdapter() : new ClaudeCodeAdapter();
  }

  async *readEntries(transcriptPath: string, fromOffset = 0): AsyncIterable<TranscriptEntry> {
    const meta = await readRolloutMeta(transcriptPath);
    const inner: CaptureAdapter = meta ? new CodexAdapter() : new ClaudeCodeAdapter();
    yield* inner.readEntries(transcriptPath, fromOffset);
  }

  parseEntries(entries: TranscriptEntry[]): ParsedSession {
    return this.concreteFor(entries).parseEntries(entries);
  }
}
