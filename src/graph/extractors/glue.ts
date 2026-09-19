// mai-graph glue extractor (spec §3.4) — the operational layer, no code parser:
// package.json scripts → package_script; .mcp.json → mcp_server;
// .claude/settings.json hooks, ~/Library/LaunchAgents plists (plutil) and
// crontab -l entries that reference project paths → scheduled_job. Edges:
// X —invokes→ command/file/script it runs; file —scheduled_by→ job (canonical
// query: "what runs automatically and what does it touch"). Pure parse
// functions exported for tests; system reads (launchd/cron) are composed in
// extract(). External commands via execFile arrays (T6). Local-only, no LLM.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { hashContent } from '../engine.js';
import { SourceEvidence } from '../source-evidence.js';
import { isExcluded } from '../walk.js';
import { owningRegisteredRepo, serviceIdentity, sourceQNameForPath } from '../contracts.js';
import { canonicalPhysicalPath, canonicalRegisteredRoots } from '../roots.js';
import type { ExtractedEdge, ExtractedNode, ExtractorOutput, GraphExtractor, NodeRef } from '../types.js';

const exec = promisify(execFile);

export interface GlueSink {
  nodes: ExtractedNode[];
  edges: ExtractedEdge[];
}

type QnameOf = (absPath: string) => string | null;

/** Tokenize a shell-ish command string: drop leading VAR=val assignments,
 * return [cmd, ...args]. Quotes are stripped naively (glue commands are simple). */
export function commandTokens(command: string): string[] {
  const tokens = command.trim().split(/\s+/).map((t) => t.replace(/^['"]|['"]$/g, ''));
  while (tokens.length > 0 && /^[A-Za-z_][A-Za-z0-9_]*=/.test(tokens[0])) tokens.shift();
  return tokens.filter(Boolean);
}

/** Emit invokes edges from `fromRef` for a command string: the executable →
 * command node (shared kind); any token resolving to a project file → file/script
 * ref (+ optional scheduled_by back-edge for jobs). */
export function emitInvocation(
  fromRef: NodeRef,
  command: string,
  baseDir: string,
  qnameOf: QnameOf,
  sink: GlueSink,
  scheduledBy: boolean
): void {
  const tokens = commandTokens(command);
  if (tokens.length === 0) return;
  const cmdBase = path.basename(tokens[0]);
  if (!tokens[0].includes('/') || !resolveProjectFile(tokens[0], baseDir, qnameOf)) {
    const cmdQn = `cmd:${cmdBase}`;
    sink.nodes.push({ kind: 'command', name: cmdBase, qualifiedName: cmdQn });
    sink.edges.push({ from: fromRef, to: { kind: 'command', qualifiedName: cmdQn }, relation: 'invokes' });
  }
  for (const token of tokens) {
    const ref = resolveProjectFile(token, baseDir, qnameOf);
    if (!ref) continue;
    sink.edges.push({ from: fromRef, to: ref, relation: 'invokes' });
    if (scheduledBy) sink.edges.push({ from: ref, to: fromRef, relation: 'scheduled_by' });
  }
}

export function resolveProjectFile(token: string, baseDir: string, qnameOf: QnameOf): NodeRef | null {
  if (!/^[\w@./~-]+$/.test(token) || token === '.' || token === '..') return null;
  const abs = path.isAbsolute(token) ? path.resolve(token) : path.resolve(baseDir, token);
  try {
    if (!fs.statSync(abs).isFile()) return null;
  } catch {
    return null;
  }
  const qn = qnameOf(abs);
  if (!qn) return null;
  const ext = path.extname(abs);
  return { kind: ext === '.sh' || ext === '.bash' ? 'script' : 'file', qualifiedName: qn };
}

export function parsePackageScripts(jsonText: string, repoBase: string, repoPath: string, qnameOf: QnameOf, sink: GlueSink): void {
  let pkg: { scripts?: Record<string, string> };
  try {
    pkg = JSON.parse(jsonText) as typeof pkg;
  } catch {
    return;
  }
  for (const [name, command] of Object.entries(pkg.scripts ?? {})) {
    if (typeof command !== 'string') continue;
    const qn = `${repoBase}/package.json#${name}`;
    const ref: NodeRef = { kind: 'package_script', qualifiedName: qn };
    sink.nodes.push({
      kind: 'package_script',
      name,
      qualifiedName: qn,
      filePath: path.join(repoPath, 'package.json'),
      contentHash: hashContent(jsonText),
      signature: command.slice(0, 300),
    });
    emitInvocation(ref, command, repoPath, qnameOf, sink, false);
  }
}

export function parseMcpServers(jsonText: string, repoPath: string, qnameOf: QnameOf, sink: GlueSink): void {
  let cfg: { mcpServers?: Record<string, { command?: string; args?: string[] }> };
  try {
    cfg = JSON.parse(jsonText) as typeof cfg;
  } catch {
    return;
  }
  for (const [name, server] of Object.entries(cfg.mcpServers ?? {})) {
    const qn = `mcp:${name}`;
    const ref: NodeRef = { kind: 'mcp_server', qualifiedName: qn };
    const commandLine = [server.command ?? '', ...(server.args ?? [])].join(' ').trim();
    sink.nodes.push({
      kind: 'mcp_server',
      name,
      qualifiedName: qn,
      filePath: path.join(repoPath, '.mcp.json'),
      contentHash: hashContent(jsonText),
      signature: commandLine.slice(0, 300),
    });
    if (commandLine) emitInvocation(ref, commandLine, repoPath, qnameOf, sink, false);
  }
}

interface HookEntry {
  hooks?: Array<{ command?: string }>;
}

export function parseHookSettings(jsonText: string, repoBase: string, repoPath: string, qnameOf: QnameOf, sink: GlueSink): void {
  let cfg: { hooks?: Record<string, HookEntry[]> };
  try {
    cfg = JSON.parse(jsonText) as typeof cfg;
  } catch {
    return;
  }
  for (const [event, entries] of Object.entries(cfg.hooks ?? {})) {
    if (!Array.isArray(entries)) continue;
    entries.forEach((entry, i) => {
      for (const h of entry.hooks ?? []) {
        if (typeof h.command !== 'string' || !h.command.trim()) continue;
        const qn = `hook:${repoBase}:${event}#${i}`;
        const ref: NodeRef = { kind: 'scheduled_job', qualifiedName: qn };
        sink.nodes.push({
          kind: 'scheduled_job',
          name: `${event} hook (${repoBase})`,
          qualifiedName: qn,
          filePath: path.join(repoPath, '.claude', 'settings.json'),
          contentHash: hashContent(jsonText),
          signature: h.command.slice(0, 300),
          metadata: { trigger: event, source: 'claude-hook' },
        });
        emitInvocation(ref, h.command, repoPath, qnameOf, sink, true);
      }
    });
  }
}

export function parseLaunchdJob(
  plistJson: { Label?: string; ProgramArguments?: string[]; Program?: string; StartCalendarInterval?: unknown; StartInterval?: unknown },
  qnameOf: QnameOf,
  sink: GlueSink
): void {
  const label = plistJson.Label ?? 'unknown';
  const argv = plistJson.ProgramArguments ?? (plistJson.Program ? [plistJson.Program] : []);
  if (argv.length === 0) return;
  const qn = `launchd:${label}`;
  const ref: NodeRef = { kind: 'scheduled_job', qualifiedName: qn };
  sink.nodes.push({
    kind: 'scheduled_job',
    name: label,
    qualifiedName: qn,
    signature: argv.join(' ').slice(0, 300),
    metadata: {
      source: 'launchd',
      schedule: plistJson.StartCalendarInterval ?? plistJson.StartInterval ?? null,
    },
  });
  emitInvocation(ref, argv.join(' '), '/', qnameOf, sink, true);
}

export function parseCrontab(crontabText: string, repoPathsResolved: string[], qnameOf: QnameOf, sink: GlueSink): void {
  for (const rawLine of crontabText.split('\n')) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;
    const fields = line.split(/\s+/);
    if (fields.length < 6) continue;
    const commandPart = fields.slice(5).join(' ');
    if (!repoPathsResolved.some((repo) => commandPart.includes(repo))) continue;
    const qn = `cron:${commandPart.slice(0, 80)}`;
    const ref: NodeRef = { kind: 'scheduled_job', qualifiedName: qn };
    sink.nodes.push({
      kind: 'scheduled_job',
      name: `cron: ${path.basename(commandTokens(commandPart)[0] ?? 'job')}`,
      qualifiedName: qn,
      signature: commandPart.slice(0, 300),
      metadata: { source: 'cron', schedule: fields.slice(0, 5).join(' ') },
    });
    emitInvocation(ref, commandPart, '/', qnameOf, sink, true);
  }
}

async function readLaunchdJobs(repoPathsResolved: string[], qnameOf: QnameOf, sink: GlueSink): Promise<void> {
  const dir = path.join(os.homedir(), 'Library', 'LaunchAgents');
  let entries: string[];
  try {
    entries = fs.readdirSync(dir).filter((f) => f.endsWith('.plist'));
  } catch {
    return;
  }
  for (const f of entries) {
    const full = path.join(dir, f);
    let raw: string;
    try {
      raw = fs.readFileSync(full, 'utf8');
    } catch {
      continue;
    }
    if (!repoPathsResolved.some((repo) => raw.includes(repo))) continue;
    try {
      const { stdout } = await exec('plutil', ['-convert', 'json', '-o', '-', full]);
      parseLaunchdJob(JSON.parse(stdout) as Parameters<typeof parseLaunchdJob>[0], qnameOf, sink);
    } catch {
      continue; // unreadable/binary-odd plist — skip, never fail the build
    }
  }
}

export const glueExtractor: GraphExtractor = {
  name: 'glue',
  vocabulary: {
    kinds: ['package_script', 'scheduled_job', 'mcp_server', 'command'],
    relations: ['invokes', 'scheduled_by'],
  },
  async extract({ repoPaths, excludes = [] }): Promise<ExtractorOutput> {
    const sink: GlueSink = { nodes: [], edges: [] };
    const resolvedRepos = canonicalRegisteredRoots(repoPaths, { baseDir: process.cwd(), rejectRelative: true });
    const source = new SourceEvidence(resolvedRepos, excludes);
    const identities = new Map(resolvedRepos.map((repo) => [repo, serviceIdentity(repo)]));
    const qnameOf: QnameOf = (absPath) => {
      const physical = canonicalPhysicalPath(absPath, process.cwd());
      const owner = owningRegisteredRepo(physical, resolvedRepos);
      if (owner === null) return null;
      const identity = identities.get(owner);
      if (identity === undefined) return null;
      const legacy = `${path.basename(owner)}/${path.relative(owner, physical).split(path.sep).join('/')}`;
      return sourceQNameForPath(identity.id, legacy, path.extname(physical));
    };

    for (const repo of resolvedRepos) {
      const census = await source.census(repo);
      if (census.state !== 'ready' && census.reason !== 'non-git') {
        throw new Error('Graph glue source census failed; registered Git source is unavailable.');
      }
      if (census.conflicts.size > 0) throw new Error('Graph glue source has unresolved Git index entries.');
      const repoBase = path.basename(repo);
      for (const [file, parse] of [
        ['package.json', (t: string) => parsePackageScripts(t, repoBase, repo, qnameOf, sink)],
        ['.mcp.json', (t: string) => parseMcpServers(t, repo, qnameOf, sink)],
        [path.join('.claude', 'settings.json'), (t: string) => parseHookSettings(t, repoBase, repo, qnameOf, sink)],
      ] as const) {
        const lexical = path.join(repo, file);
        const physical = canonicalPhysicalPath(lexical, process.cwd());
        if (lexical !== physical || owningRegisteredRepo(physical, resolvedRepos) !== repo
          || isExcluded(lexical, excludes) || isExcluded(physical, excludes)
          || (census.state === 'ready' && !census.files.has(physical))) continue;
        try {
          parse(fs.readFileSync(physical, 'utf8'));
        } catch {
          /* file absent — fine */
        }
      }
    }

    await readLaunchdJobs(resolvedRepos, qnameOf, sink);
    try {
      const { stdout } = await exec('crontab', ['-l']);
      parseCrontab(stdout, resolvedRepos, qnameOf, sink);
    } catch {
      /* no crontab — fine */
    }

    return sink;
  },
};
