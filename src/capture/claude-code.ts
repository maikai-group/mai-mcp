// Claude Code capture adapter. Wraps the existing, still-exported wiring
// functions (mergeMcpJson/mergeHooks/mergeClaudeMd) and the JSONL transcript
// parser (parseJsonl) — behaviour-preserving; no capture logic is rewritten.
// Also covers Cowork (the Claude desktop app), which writes the same
// ~/.claude/projects/**/*.jsonl transcripts via the embedded Claude Code engine.
import fs from 'node:fs/promises';
import path from 'node:path';
import type { ParsedSession } from '../ingest.js';
import { parseJsonl, createJsonlReducer, countJsonlThinking, isJsonlCompaction } from '../ingest.js';
import { readLinesWithOffsets } from './lines.js';
import type { TranscriptEntry } from './segment.js';
import { mergeMcpJson, mergeHooks, mergeClaudeMd, buildMcpServerEntry, upgradeHooksObject } from '../scripts/init.js';
import { planRulesBlockUpgrade } from '../scripts/managed-block.js';
import { installGraduatedRulesBlock, planInstructionFileUpgrade } from '../rules-render.js';
import type { AdapterStatus, CaptureAdapter, InstallResult, PlannedChange, UpgradeOpts } from './adapter.js';
import { isMaiHookCommand } from '../hook-wiring.js';

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function containsManagedHook(value: unknown): boolean {
  if (!isRecord(value) || !isRecord(value.hooks)) return false;
  for (const entries of Object.values(value.hooks)) {
    if (!Array.isArray(entries)) continue;
    for (const entry of entries) {
      if (!isRecord(entry) || !Array.isArray(entry.hooks)) continue;
      for (const hook of entry.hooks) {
        if (isRecord(hook) && typeof hook.command === 'string' && isMaiHookCommand(hook.command)) return true;
      }
    }
  }
  return false;
}

export class ClaudeCodeAdapter implements CaptureAdapter {
  readonly harness = 'claude-code';

  async install(repoPath: string, slug: string): Promise<InstallResult> {
    const mcp = await mergeMcpJson(repoPath, slug);
    const hooks = await mergeHooks(repoPath, slug);
    const claudeMd = await mergeClaudeMd(repoPath);
    const graduated = await installGraduatedRulesBlock(repoPath, 'CLAUDE.md');
    return {
      harness: this.harness,
      lines: [
        `.mcp.json ${mcp}`,
        `hooks ${hooks}`,
        `CLAUDE.md ${claudeMd}`,
        `CLAUDE.md graduated-rules ${graduated}`,
      ],
    };
  }

  async detect(repoPath: string): Promise<AdapterStatus> {
    const settingsPath = path.join(repoPath, '.claude', 'settings.json');
    const mcpPath = path.join(repoPath, '.mcp.json');
    let present = false;
    let installed = false;
    try {
      const raw = await fs.readFile(settingsPath, 'utf8');
      present = true;
      let parsed: unknown;
      try { parsed = JSON.parse(raw); } catch { parsed = null; }
      installed = containsManagedHook(parsed);
    } catch {
      // no .claude/settings.json
    }
    if (!installed) {
      try {
        const mcpRaw = await fs.readFile(mcpPath, 'utf8');
        present = true;
        if (mcpRaw.includes('mai-mcp')) installed = true;
      } catch {
        // no .mcp.json
      }
    }
    return { harness: this.harness, present, installed };
  }

  async planUpgrade(repoPath: string, slug: string, opts: UpgradeOpts = {}): Promise<PlannedChange[]> {
    const changes: PlannedChange[] = [];

    if (opts.graduatedRulesBlock !== undefined) {
      changes.push(...await planInstructionFileUpgrade(
        repoPath, 'CLAUDE.md', 'memory-brain-block.md', opts.graduatedRulesBlock
      ));
    } else {
      const rules = await planRulesBlockUpgrade(repoPath, 'CLAUDE.md', 'memory-brain-block.md');
      if (rules) changes.push(rules);
    }

    // .mcp.json — recompute the mai-mcp entry, preserving personalization.
    const mcpPath = path.join(repoPath, '.mcp.json');
    try {
      const raw = await fs.readFile(mcpPath, 'utf8');
      const parsed = JSON.parse(raw) as Record<string, unknown>;
      const servers = (parsed.mcpServers ?? {}) as Record<string, { env?: Record<string, string> }>;
      if (servers['mai-mcp']) {
        const agentId = opts.agentId ?? servers['mai-mcp'].env?.MAI_AGENT_ID ?? 'agent@claude-code';
        const prevLinkedRaw = servers['mai-mcp'].env?.MAI_LINKED_PROJECTS;
        const linked = opts.linkedProjects
          ?? (typeof prevLinkedRaw === 'string'
            ? prevLinkedRaw.split(',').map((s) => s.trim()).filter(Boolean) : []);
        const nextServers = { ...servers, 'mai-mcp': buildMcpServerEntry(repoPath, slug, agentId, linked) };
        const next = { ...parsed, mcpServers: nextServers };
        if (JSON.stringify(next) !== JSON.stringify(parsed)) {
          changes.push({
            file: mcpPath,
            label: '.mcp.json mai-mcp entry refresh',
            legacy: false,
            before: JSON.stringify(servers['mai-mcp'], null, 2),
            after: JSON.stringify(nextServers['mai-mcp'], null, 2),
            newContent: JSON.stringify(next, null, 2) + '\n',
            preimage: raw,
          });
        }
      }
    } catch {
      // absent or unparseable — verify reports it; upgrade doesn't guess.
    }

    // .claude/settings.json — canonical mai hooks, foreign hooks preserved.
    const settingsPath = path.join(repoPath, '.claude', 'settings.json');
    try {
      const raw = await fs.readFile(settingsPath, 'utf8');
      const settings = JSON.parse(raw) as Record<string, unknown>;
      const upgraded = upgradeHooksObject(settings, slug);
      if (JSON.stringify(upgraded) !== JSON.stringify(settings)) {
        changes.push({
          file: settingsPath,
          label: '.claude/settings.json mai hooks refresh',
          legacy: false,
          before: JSON.stringify(settings.hooks ?? {}, null, 2),
          after: JSON.stringify((upgraded as { hooks: unknown }).hooks, null, 2),
          newContent: JSON.stringify(upgraded, null, 2) + '\n',
          preimage: raw,
        });
      }
    } catch {
      // absent or unparseable — same policy as .mcp.json.
    }

    return changes;
  }

  async parseTranscript(transcriptPath: string): Promise<ParsedSession> {
    return parseJsonl(transcriptPath);
  }

  async *readEntries(transcriptPath: string, fromOffset = 0): AsyncIterable<TranscriptEntry> {
    for await (const { offset, text } of readLinesWithOffsets(transcriptPath, fromOffset)) {
      if (!text.trim()) continue;
      let raw: unknown;
      try {
        raw = JSON.parse(text);
      } catch {
        continue;
      }
      const ts = (raw as { timestamp?: string }).timestamp ?? null;
      yield {
        offset,
        ts,
        isCompactionBoundary: isJsonlCompaction(raw),
        thinkingBlocks: countJsonlThinking(raw),
        raw,
      };
    }
  }

  parseEntries(entries: TranscriptEntry[]): ParsedSession {
    const r = createJsonlReducer();
    for (const e of entries) r.feed(e.raw);
    return r.state;
  }
}
