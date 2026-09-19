// Managed rules-file blocks — the versioned heading→sentinel region mai owns
// inside a consumer repo's CLAUDE.md/AGENTS.md/--rules-file. The TEMPLATE file
// is the single source of truth for the current version (its own sentinel).
// Legacy blocks (installed before versioning) have no sentinel; their extent
// is heuristic (heading → next '## ' heading or EOF) — which is why legacy
// migration always shows a diff and asks (decision b0fc1969).
import fs from 'node:fs/promises';
import path from 'node:path';
import { MAI_ROOT } from '../paths.js';
import type { PlannedChange } from '../capture/adapter.js';

export const RULES_MARKER = 'MEMORY BRAIN (mai-mcp)';
export const SENTINEL_RE = /^<!-- \/mai-brain-block v(\d+) -->\r?$/m;
// The block anchors on a HEADING line containing the marker — a bare indexOf
// would anchor on a prose *mention* ("don't touch the MEMORY BRAIN (mai-mcp)
// section below") and swallow everything between the mention and the sentinel
// (review finding, 8a T1). Prose mentions without a heading → no block.
const HEADING_RE = /^#{1,6} .*MEMORY BRAIN \(mai-mcp\).*\r?$/m;

/** A managed region's identity. Brain blocks predate sentinels, so their spec
 * allows the heuristic legacy extent; graduated blocks never shipped without a
 * sentinel — a heading with no sentinel is treated as no block at all. */
export interface BlockSpec {
  headingRe: RegExp;
  sentinelRe: RegExp;
  legacyExtent: boolean;
}
export const BRAIN_BLOCK: BlockSpec = {
  headingRe: HEADING_RE,
  sentinelRe: SENTINEL_RE,
  legacyExtent: true,
};
export const GRADUATED_BLOCK: BlockSpec = {
  headingRe: /^#{1,6} .*GRADUATED RULES \(mai-mcp\).*\r?$/m,
  sentinelRe: /^<!-- \/mai-graduated-rules v(\d+) -->\r?$/m,
  legacyExtent: false,
};

export interface ManagedBlock {
  start: number;          // char offset of the heading line start
  end: number;            // char offset one past the block's final newline
  version: number | null; // null = legacy (no sentinel)
  text: string;
}

/** Current version of a template — throws if the template lacks a sentinel
 * (a build-time invariant; the tests pin it). */
export function templateVersion(template: string): number {
  const m = template.match(SENTINEL_RE);
  if (!m) throw new Error('template has no version sentinel (<!-- /mai-brain-block vN -->)');
  return Number(m[1]);
}

export async function loadTemplate(templateName: string): Promise<{ block: string; version: number }> {
  const raw = await fs.readFile(path.join(MAI_ROOT, 'templates', templateName), 'utf8');
  const block = raw.endsWith('\n') ? raw : raw + '\n';
  return { block, version: templateVersion(raw) };
}

/** Locate a managed block in a rules file, or null when there is no
 * heading-line marker (a prose mention alone is not a block). Defaults to the
 * brain block — every pre-plan-27 caller keeps its exact behavior. */
export function findManagedBlock(content: string, spec: BlockSpec = BRAIN_BLOCK): ManagedBlock | null {
  const heading = content.match(spec.headingRe);
  if (!heading || heading.index === undefined) return null;
  const start = heading.index;
  const after = content.slice(start);
  const sentinel = after.match(spec.sentinelRe);
  if (sentinel && sentinel.index !== undefined) {
    let end = start + sentinel.index + sentinel[0].length;
    if (content[end] === '\n') end++;
    return { start, end, version: Number(sentinel[1]), text: content.slice(start, end) };
  }
  if (!spec.legacyExtent) return null;
  // Legacy extent: heading → the newline before the next '## ' heading, or EOF.
  const next = after.search(/\n## /);
  const end = next === -1 ? content.length : start + next + 1;
  return { start, end, version: null, text: content.slice(start, end) };
}

/** Replace the block region; guarantees a valid boundary when the legacy
 * heuristic consumed the separator before a following heading. */
export function replaceManagedBlock(content: string, block: ManagedBlock, replacement: string): string {
  const rep = replacement.endsWith('\n') ? replacement : replacement + '\n';
  const tail = content.slice(block.end);
  const sep = tail.startsWith('#') ? '\n' : '';
  return content.slice(0, block.start) + rep + sep + tail;
}

/** Shared adapter helper: plan the rules-file block refresh for one repo file.
 * Returns null when the file is absent, has no mai block (init's job, not
 * upgrade's), or is already byte-identical to the current template. */
export async function planRulesBlockUpgrade(
  repoPath: string,
  fileName: string,
  templateName: string,
  contentOverride?: string
): Promise<PlannedChange | null> {
  const file = path.join(repoPath, fileName);
  let content = contentOverride;
  if (content === undefined) {
    try { content = await fs.readFile(file, 'utf8'); }
    catch { return null; }
  }
  const block = findManagedBlock(content);
  if (!block) return null;
  const { block: tpl, version } = await loadTemplate(templateName);
  if (block.text === tpl) return null;
  return {
    file,
    label: `${fileName} brain block ${block.version === null ? 'legacy' : `v${block.version}`} → v${version}`,
    legacy: block.version === null,
    before: block.text,
    after: tpl,
    newContent: replaceManagedBlock(content, block, tpl),
    preimage: content,
  };
}
