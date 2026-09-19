// Codex capture adapter. Codex stores sessions as append-only "rollout" JSONL
// under ~/.codex/sessions/YYYY/MM/DD/rollout-<ts>-<uuid>.jsonl, NOT per project;
// line 1 is a session_meta record whose payload.cwd identifies the repo
// (decision 56a56090). Rollouts reach 1.1 GB (lesson f1e59814), so parsing is
// strictly streaming: line reader + per-line length guard + bounded arrays.
// Install follows a proven repo-scoped pattern: a repo-scoped .codex/config.toml
// (Codex merges it over the global config for trusted projects → per-project
// slug pinning, exactly like .mcp.json) + an AGENTS.md brain block + the global
// notify hook (decision ea7c429d).
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import readline from 'node:readline';
import type { ParsedSession } from '../ingest.js';
import { extractCommits, extractTestResults, detectLanguage } from '../ingest.js';
import { mergeRulesFile } from '../scripts/init.js';
import { updateRepoManagedFile } from '../repo-managed-write.js';
import { planRulesBlockUpgrade } from '../scripts/managed-block.js';
import { installGraduatedRulesBlock, planInstructionFileUpgrade } from '../rules-render.js';
import { MAI_ROOT } from '../paths.js';
import { readLinesWithOffsets } from './lines.js';
import { tomlString } from '../command-encoding.js';
import { buildCodexNotifyLine, readCodexNotify } from '../hook-wiring.js';
import type { TranscriptEntry } from './segment.js';
import type { AdapterStatus, CaptureAdapter, InstallResult, PlannedChange, UpgradeOpts } from './adapter.js';

/** Codex home (tests override via CODEX_HOME). */
export function codexHome(): string {
  return process.env.CODEX_HOME ?? path.join(os.homedir(), '.codex');
}

export { buildCodexNotifyLine } from '../hook-wiring.js';
export const MCP_MARKER = '[mcp_servers.mai-mcp]';
export const CODEX_BLOCK_VERSION = 2;
export const CODEX_SAFE_READ_TOOLS = ['mai_git_context', 'mai_search'] as const;
const CODEX_BLOCK_END_RE = /^# \/mai-mcp-block v(\d+)$/m;
const CODEX_BLOCK_HEADER = '# mai-mcp brain — project-scoped MCP registration for Codex.';
const CODEX_USER_POLICY_HEADER = [
  '# ---- Local settings, deliberately OUTSIDE the managed block above ----',
  '# `mai upgrade` preserves this user-owned section. Remove or change an',
  '# approval_mode entry at any time to use your preferred Codex policy.',
].join('\n');
// Line-anchored marker (same hardening class as managed-block's heading
// anchor, 8a T1 review): a prose/comment mention of the table name must not
// anchor the block extent.
const MCP_MARKER_LINE_RE = /^\[mcp_servers\.mai-mcp\]\r?$/m;

// Streaming-safety caps (rollouts reach 1.1 GB; single lines reach ~180 KB
// normally but image payloads can be far larger).
const DEFAULT_MAX_LINE_LENGTH = 10_000_000;
const MAX_THINKING_BLOCKS = 300;
const THINKING_SLICE = 4_000;
const MAX_BASH_EVENTS = 800;
const MAX_FILE_EVENTS = 1_500;
const FILE_CONTENT_SLICE = 50_000;
const MAX_COMMITS = 500;
const MAX_TEST_RUNS = 200;
const MAX_PENDING_EXEC = 1_000;

interface RolloutPayload {
  type?: string;
  id?: string;
  cwd?: string;
  model?: string;
  name?: string;
  call_id?: string;
  arguments?: string;
  output?: unknown;
  summary?: unknown;
  success?: boolean;
  changes?: Record<string, { type?: string; content?: string; unified_diff?: string }>;
}

interface RolloutLine {
  timestamp?: string;
  type?: string;
  payload?: RolloutPayload;
}

/** First-line routing info — read WITHOUT parsing the (possibly huge) file. */
export interface RolloutMeta {
  sessionId: string;
  cwd: string;
}

/**
 * Read only the first line of a rollout and return its session id + cwd, or
 * null if the file does not start with a session_meta record. Caps the read at
 * 1 MB — a first line longer than that is not a rollout we understand.
 */
export async function readRolloutMeta(rolloutPath: string): Promise<RolloutMeta | null> {
  let head = '';
  const stream = fs.createReadStream(rolloutPath, { encoding: 'utf8', start: 0, end: 1_048_576 });
  try {
    for await (const chunk of stream) {
      head += chunk as string;
      const nl = head.indexOf('\n');
      if (nl !== -1) {
        head = head.slice(0, nl);
        break;
      }
    }
  } catch {
    return null;
  } finally {
    stream.destroy();
  }
  try {
    const line = JSON.parse(head) as RolloutLine;
    if (line.type !== 'session_meta') return null;
    const id = line.payload?.id;
    const cwd = line.payload?.cwd;
    if (typeof id !== 'string' || typeof cwd !== 'string' || !id || !cwd) return null;
    return { sessionId: id, cwd };
  } catch {
    return null;
  }
}

/** Payload types that count as a tool invocation. */
const TOOL_CALL_TYPES = new Set([
  'function_call',
  'custom_tool_call',
  'web_search_call',
  'image_generation_call',
  'tool_search_call',
]);

function outputToText(output: unknown): string {
  return typeof output === 'string' ? output : JSON.stringify(output ?? '');
}

function extractExitCode(text: string): number {
  const m = text.match(/exited with code (\d+)/i);
  return m ? Number(m[1]) : 0;
}

/** Pull the shell command out of a function_call's JSON `arguments` string. */
function commandFromArguments(rawArguments: string | undefined): string {
  if (!rawArguments) return '';
  try {
    const parsed = JSON.parse(rawArguments) as { cmd?: unknown; command?: unknown };
    const cmd = parsed.cmd ?? parsed.command;
    if (typeof cmd === 'string') return cmd;
    if (Array.isArray(cmd)) return cmd.map(String).join(' ');
    return '';
  } catch {
    return '';
  }
}

export interface ParseCodexOptions {
  /** Line-length guard (default 10,000,000 chars). Tests shrink it. */
  maxLineLength?: number;
}

export interface RolloutReducer {
  state: ParsedSession;
  feed(entry: RolloutLine): void;
}

/** Non-empty reasoning summary text, used by feed() AND the V2 count. */
function reasoningText(p: RolloutPayload | undefined): string {
  if (!p || p.type !== 'reasoning') return '';
  const summary = Array.isArray(p.summary) ? p.summary : [];
  return summary
    .map((s) => {
      const item = s as { text?: unknown };
      return typeof item.text === 'string' ? item.text : '';
    })
    .join('\n')
    .trim();
}

export function createRolloutReducer(): RolloutReducer {
  const state: ParsedSession = {
    harness: 'codex',
    messageCount: 0,
    toolCalls: 0,
    filesRead: 0, // Codex reads via shell — no distinct read tool; accepted gap.
    filesWritten: 0,
    filesEdited: 0,
    thinkingBlocks: [],
    fileEvents: [],
    bashEvents: [],
    commits: [],
    testRuns: [],
  };

  // function_call call_id → pending shell command awaiting its output record.
  const pendingExec = new Map<string, { command: string; timestamp?: string }>();

  function feed(entry: RolloutLine): void {
    if (entry.timestamp) {
      if (!state.firstTs) state.firstTs = entry.timestamp;
      state.lastTs = entry.timestamp;
    }

    const p = entry.payload;
    if (!p) return;

    if (entry.type === 'session_meta' && p.type === 'session_meta') {
      if (!state.sessionId && typeof p.id === 'string') state.sessionId = p.id;
      if (!state.cwd && typeof p.cwd === 'string') state.cwd = p.cwd;
      return;
    }
    if (entry.type === 'turn_context') {
      if (!state.model && typeof p.model === 'string') state.model = p.model;
      return;
    }
    if (entry.type === 'event_msg') {
      if (p.type === 'user_message' || p.type === 'agent_message') state.messageCount++;
      // patch_apply_end is handled below regardless of the envelope type.
    }

    if (p.type && TOOL_CALL_TYPES.has(p.type)) {
      state.toolCalls++;
      if (
        p.type === 'function_call' &&
        (p.name === 'exec_command' || p.name === 'shell') &&
        typeof p.call_id === 'string'
      ) {
        const command = commandFromArguments(p.arguments);
        if (command) {
          // Evict the oldest unmatched exec so a rollout full of dropped
          // outputs (oversized/aborted turns) can't grow the map unbounded.
          if (pendingExec.size >= MAX_PENDING_EXEC) {
            const oldest = pendingExec.keys().next().value;
            if (oldest !== undefined) pendingExec.delete(oldest);
          }
          pendingExec.set(p.call_id, { command, timestamp: entry.timestamp });
        }
      }
      return;
    }

    if (p.type === 'function_call_output' || p.type === 'custom_tool_call_output') {
      const text = outputToText(p.output);
      if (text) {
        // extractCommits dedupes per-call only — cap both arrays so repeated
        // `git log`-style output across a 1 GB rollout can't accumulate.
        if (state.commits.length < MAX_COMMITS) {
          state.commits.push(...extractCommits(text).slice(0, MAX_COMMITS - state.commits.length));
        }
        if (state.testRuns.length < MAX_TEST_RUNS) {
          const testRun = extractTestResults(text);
          if (testRun) state.testRuns.push(testRun);
        }
      }
      const callId = typeof p.call_id === 'string' ? p.call_id : undefined;
      const pending = callId ? pendingExec.get(callId) : undefined;
      if (pending && callId) {
        pendingExec.delete(callId);
        if (state.bashEvents.length < MAX_BASH_EVENTS) {
          state.bashEvents.push({
            command: pending.command,
            stdout: text.slice(0, 500),
            exitCode: extractExitCode(text),
            timestamp: pending.timestamp,
          });
        }
      }
      return;
    }

    if (p.type === 'reasoning') {
      const text = reasoningText(p);
      if (text && state.thinkingBlocks.length < MAX_THINKING_BLOCKS) {
        state.thinkingBlocks.push({ text: text.slice(0, THINKING_SLICE), timestamp: entry.timestamp });
      }
      return;
    }

    if (p.type === 'patch_apply_end' && p.success !== false && p.changes) {
      for (const [filePath, change] of Object.entries(p.changes)) {
        if (state.fileEvents.length >= MAX_FILE_EVENTS) break;
        if (change.type === 'add') {
          state.filesWritten++;
          state.fileEvents.push({
            action: 'write',
            filePath,
            content: (change.content ?? '').slice(0, FILE_CONTENT_SLICE),
            language: detectLanguage(filePath),
            timestamp: entry.timestamp,
          });
        } else {
          state.filesEdited++;
          state.fileEvents.push({
            action: 'edit',
            filePath,
            diffNew: (change.unified_diff ?? change.content ?? '').slice(0, FILE_CONTENT_SLICE),
            language: detectLanguage(filePath),
            timestamp: entry.timestamp,
          });
        }
      }
      return;
    }
  }

  return { state, feed };
}

/** Streaming Codex rollout → neutral ParsedSession. */
export async function parseCodexRollout(
  rolloutPath: string,
  options: ParseCodexOptions = {}
): Promise<ParsedSession> {
  const maxLine = options.maxLineLength ?? DEFAULT_MAX_LINE_LENGTH;
  const r = createRolloutReducer();
  const stream = fs.createReadStream(rolloutPath, { encoding: 'utf8' });
  const rl = readline.createInterface({ input: stream, crlfDelay: Infinity });
  let skippedLines = 0;

  for await (const line of rl) {
    if (!line.trim()) continue;
    // Note: readline materializes the full line before this check — the guard
    // bounds what we PARSE, not the transient string. A single line beyond
    // V8's max string length would throw in the iterator; runCodexScan catches
    // that per-file and keeps scanning.
    if (line.length > maxLine) {
      skippedLines++;
      continue;
    }
    let entry: RolloutLine;
    try {
      entry = JSON.parse(line) as RolloutLine;
    } catch {
      continue;
    }
    r.feed(entry);
  }

  if (skippedLines > 0) {
    console.error(`mai-codex-parse: ${skippedLines} oversized line(s) skipped in ${rolloutPath}`);
  }
  return r.state;
}

/** The full repo-scoped config.toml block, versioned. agentId preserved on
 * refresh so a personalized sol@codex survives upgrades. */
export function buildCodexBlock(
  repoPath: string,
  slug: string,
  agentId: string,
  maiRoot: string = MAI_ROOT,
  linkedProjects: readonly string[] = []
): string {
  return [
    CODEX_BLOCK_HEADER,
    '# Codex merges this over ~/.codex/config.toml for TRUSTED projects. Pins the',
    "# brain to this project's slug, exactly like the per-repo .mcp.json does for",
    '# Claude Code — so the brain never leaks across projects.',
    MCP_MARKER,
    'command = "node"',
    `args = [${tomlString(path.join(maiRoot, 'build', 'index.js'))}]`,
    '',
    '[mcp_servers.mai-mcp.env]',
    `MAI_PROJECT_SLUG = ${tomlString(slug)}`,
    `MAI_PROJECT_ROOT = ${tomlString(repoPath)}`,
    ...(linkedProjects.length > 0
      ? [`MAI_LINKED_PROJECTS = ${tomlString([...linkedProjects].sort().join(','))}`]
      : []),
    '# Board-post author identity — personalize (e.g. sol@codex).',
    `MAI_AGENT_ID = ${tomlString(agentId)}`,
    `# /mai-mcp-block v${CODEX_BLOCK_VERSION}`,
    '',
  ].join('\n');
}

/** Safe-read defaults are intentionally outside the managed block. They are
 * user policy, not mai wiring: upgrades preserve edits and removals verbatim. */
export function buildCodexUserPolicyBlock(
  tools: readonly string[] = CODEX_SAFE_READ_TOOLS
): string {
  const tables = tools.map((tool) => [
    `[mcp_servers.mai-mcp.tools.${tool}]`,
    'approval_mode = "approve"',
  ].join('\n'));
  return [CODEX_USER_POLICY_HEADER, ...tables, ''].join('\n\n');
}

/** Complete first-install config: managed registration plus user-owned policy. */
export function buildCodexInitialConfig(
  repoPath: string,
  slug: string,
  agentId: string,
  tools: readonly string[] = CODEX_SAFE_READ_TOOLS
): string {
  const managed = buildCodexBlock(repoPath, slug, agentId);
  return tools.length === 0 ? managed : `${managed}\n${buildCodexUserPolicyBlock(tools)}`;
}

export interface CodexToolPolicySection {
  tool: string;
  mode: string | null;
  start: number;
  end: number;
  text: string;
}

/** Locate per-tool policy tables without interpreting unrelated TOML. */
export function findCodexToolPolicySections(content: string): CodexToolPolicySection[] {
  const headerRe = /^\[mcp_servers\.mai-mcp\.tools\.([A-Za-z0-9_-]+)\]\r?$/gm;
  const headers = [...content.matchAll(headerRe)];
  return headers.map((header, index) => {
    const start = header.index;
    const nextHeader = headers[index + 1]?.index ?? content.length;
    const between = content.slice(start, nextHeader);
    const boundary = between.slice(header[0].length).search(/^\[|^# \/mai-mcp-block v\d+\r?$/m);
    const end = boundary === -1
      ? nextHeader
      : start + header[0].length + boundary;
    const text = content.slice(start, end).trimEnd();
    const mode = /^approval_mode\s*=\s*"([^"]+)"\s*$/m.exec(text)?.[1] ?? null;
    return { tool: header[1], mode, start, end, text };
  });
}

export interface CodexBlock {
  start: number;
  end: number;
  version: number | null;
  text: string;
}

/** Locate the mai block in a repo config.toml. Versioned blocks end at the
 * end-marker; legacy blocks end at the next non-mai [table] header or EOF
 * (TOML tables end where the next table begins — precise enough). */
export function findCodexBlock(content: string): CodexBlock | null {
  const marker = content.match(MCP_MARKER_LINE_RE);
  if (!marker || marker.index === undefined) return null;
  const markerIdx = marker.index;
  const headerIdx = content.lastIndexOf('# mai-mcp brain', markerIdx);
  const anchor = headerIdx !== -1 ? headerIdx : markerIdx;
  const start = content.lastIndexOf('\n', anchor) + 1;
  const after = content.slice(markerIdx);
  const endM = after.match(CODEX_BLOCK_END_RE);
  if (endM && endM.index !== undefined) {
    let end = markerIdx + endM.index + endM[0].length;
    if (content[end] === '\n') end++;
    return { start, end, version: Number(endM[1]), text: content.slice(start, end) };
  }
  const envIdx = content.indexOf('[mcp_servers.mai-mcp.env]', markerIdx);
  const scanFrom = envIdx !== -1 ? envIdx + 1 : markerIdx + MCP_MARKER.length;
  const nextTable = content.slice(scanFrom).search(/^\[(?!mcp_servers\.mai-mcp)/m);
  const end = nextTable === -1 ? content.length : scanFrom + nextTable;
  return { start, end, version: null, text: content.slice(start, end) };
}

export class CodexAdapter implements CaptureAdapter {
  readonly harness = 'codex';

  async install(repoPath: string, slug: string): Promise<InstallResult> {
    const cfg = await this.mergeRepoConfigToml(repoPath, slug);
    const agents = await mergeRulesFile(repoPath, 'AGENTS.md', 'memory-brain-block-agents.md');
    const notify = await this.mergeGlobalNotify();
    const graduated = await installGraduatedRulesBlock(repoPath, 'AGENTS.md');
    return {
      harness: this.harness,
      lines: [
        `.codex/config.toml ${cfg}`,
        `AGENTS.md ${agents}`,
        `notify ${notify}`,
        `AGENTS.md graduated-rules ${graduated}`,
      ],
    };
  }

  /**
   * Repo-scoped MCP registration (a repo-scoped pattern): Codex merges a trusted
   * project's .codex/config.toml over the global one → per-project slug pinning.
   * Append-or-skip only — existing user content is never rewritten.
   */
  private async mergeRepoConfigToml(
    repoPath: string,
    slug: string
  ): Promise<'created' | 'updated' | 'unchanged'> {
    // Repo-scoped onboarding write → the 05ec915d contained boundary (Plan 15
    // Task 3). Global notify below stays on its own operator-owned path.
    return updateRepoManagedFile(repoPath, path.join('.codex', 'config.toml'), (existing) => {
      if (existing === null) return buildCodexInitialConfig(repoPath, slug, 'agent@codex');
      if (existing.includes(MCP_MARKER)) return null;
      const existingTools = new Set(findCodexToolPolicySections(existing).map((policy) => policy.tool));
      const missingDefaults = CODEX_SAFE_READ_TOOLS.filter((tool) => !existingTools.has(tool));
      const block = buildCodexInitialConfig(repoPath, slug, 'agent@codex', missingDefaults);
      const sep = existing.endsWith('\n') ? '\n' : '\n\n';
      return existing + sep + block;
    });
  }

  /**
   * Wire the global notify hook (decision ea7c429d). Never clobbers a foreign
   * notify setting; CODEX_HOME override makes this testable.
   */
  private async mergeGlobalNotify(): Promise<string> {
    const home = codexHome();
    if (!fs.existsSync(home)) return 'skipped (no ~/.codex)';
    const file = path.join(home, 'config.toml');
    let raw = '';
    try {
      raw = await fsp.readFile(file, 'utf8');
    } catch {
      raw = '';
    }
    const setting = readCodexNotify(raw);
    if (setting.kind === 'foreign') return 'skipped (existing notify)';
    if (setting.kind === 'managed') {
      const replacement = buildCodexNotifyLine(MAI_ROOT, setting.mode === 'codex-notify-chain');
      const next = raw.slice(0, setting.start) + replacement + raw.slice(setting.end);
      if (next === raw) return 'unchanged';
      await fsp.writeFile(file, next, 'utf8');
      return 'updated';
    }
    // Root-level TOML keys must precede any [table] header — appending at EOF
    // would attach `notify` to whatever table the config happens to end with
    // (typical Codex configs end in [projects.*]/[tui.*]) and Codex would never
    // see it. Prepend instead: root keys before the first table are always valid.
    const block = `# mai-mcp: ingest the session into the brain when a turn ends.\n${buildCodexNotifyLine(MAI_ROOT)}\n\n`;
    await fsp.writeFile(file, block + raw, 'utf8');
    return raw === '' ? 'created' : 'updated';
  }

  async detect(repoPath: string): Promise<AdapterStatus> {
    const present = fs.existsSync(codexHome());
    let installed = false;
    try {
      const raw = await fsp.readFile(path.join(repoPath, '.codex', 'config.toml'), 'utf8');
      installed = raw.includes(MCP_MARKER);
    } catch {
      // no repo .codex/config.toml
    }
    return {
      harness: this.harness,
      present,
      installed,
      detail: installed ? 'repo .codex/config.toml registers mai-mcp' : undefined,
    };
  }

  async planUpgrade(repoPath: string, slug: string, opts: UpgradeOpts = {}): Promise<PlannedChange[]> {
    const changes: PlannedChange[] = [];

    const file = path.join(repoPath, '.codex', 'config.toml');
    try {
      const content = await fsp.readFile(file, 'utf8');
      const block = findCodexBlock(content);
      if (block) {
        const prevAgent = block.text.match(/MAI_AGENT_ID\s*=\s*"([^"]*)"/)?.[1];
        const agentId = opts.agentId ?? prevAgent ?? 'agent@codex';
        const prevLinked = block.text.match(/MAI_LINKED_PROJECTS\s*=\s*"([^"]*)"/)?.[1];
        const linked = opts.linkedProjects
          ?? (prevLinked !== undefined
            ? prevLinked.split(',').map((s) => s.trim()).filter(Boolean) : []);
        const next = buildCodexBlock(repoPath, slug, agentId, MAI_ROOT, linked);
        if (block.text !== next) {
          const tail = content.slice(block.end);
          const managedPolicies = findCodexToolPolicySections(block.text);
          const outsideTools = new Set(findCodexToolPolicySections(tail).map((policy) => policy.tool));
          const migratedPolicies = managedPolicies.filter((policy) => !outsideTools.has(policy.tool));
          const migrated = migratedPolicies.length > 0
            ? `${CODEX_USER_POLICY_HEADER}\n\n${migratedPolicies.map((policy) => policy.text).join('\n\n')}\n`
            : '';
          const sep = tail.startsWith('[') || tail.startsWith('#') ? '\n' : '';
          const newContent = content.slice(0, block.start)
            + next
            + (migrated ? `\n${migrated}` : '')
            + sep
            + tail;
          changes.push({
            file,
            label: `.codex/config.toml mai block ${block.version === null ? 'legacy' : `v${block.version}`} → v${CODEX_BLOCK_VERSION}`,
            legacy: block.version === null,
            before: migrated ? content : block.text,
            after: migrated ? newContent : next,
            newContent,
            preimage: content,
          });
        }
      }
    } catch {
      // no repo config.toml — nothing installed to upgrade.
    }

    if (opts.graduatedRulesBlock !== undefined) {
      changes.push(...await planInstructionFileUpgrade(
        repoPath, 'AGENTS.md', 'memory-brain-block-agents.md', opts.graduatedRulesBlock
      ));
    } else {
      const agents = await planRulesBlockUpgrade(repoPath, 'AGENTS.md', 'memory-brain-block-agents.md');
      if (agents) changes.push(agents);
    }

    return changes;
  }

  async parseTranscript(transcriptPath: string): Promise<ParsedSession> {
    return parseCodexRollout(transcriptPath);
  }

  async *readEntries(transcriptPath: string, fromOffset = 0): AsyncIterable<TranscriptEntry> {
    const maxLine = DEFAULT_MAX_LINE_LENGTH;
    let skippedLines = 0;
    for await (const { offset, text } of readLinesWithOffsets(transcriptPath, fromOffset)) {
      if (!text.trim()) continue;
      if (text.length > maxLine) {
        skippedLines++;
        continue;
      }
      let entry: RolloutLine;
      try {
        entry = JSON.parse(text) as RolloutLine;
      } catch {
        continue;
      }
      yield {
        offset,
        ts: entry.timestamp ?? null,
        isCompactionBoundary: entry.type === 'compacted' || entry.payload?.type === 'compacted',
        thinkingBlocks: reasoningText(entry.payload) ? 1 : 0,
        raw: entry,
      };
    }
    if (skippedLines > 0) {
      console.error(`mai-codex-parse: ${skippedLines} oversized line(s) skipped in ${transcriptPath}`);
    }
  }

  parseEntries(entries: TranscriptEntry[]): ParsedSession {
    const r = createRolloutReducer();
    for (const e of entries) r.feed(e.raw as RolloutLine);
    return r.state;
  }
}
