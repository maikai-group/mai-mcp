/** Managed-block parsing: sentinel extent, legacy heuristics, replacement
 * boundaries, template version pinning. Pure — no DB, no temp dirs. */
import { describe, expect, it } from 'vitest';
import fs from 'node:fs/promises';
import path from 'node:path';
import {
  findManagedBlock,
  replaceManagedBlock,
  templateVersion,
  loadTemplate,
  planRulesBlockUpgrade,
  SENTINEL_RE,
} from '../scripts/managed-block.js';
import { MAI_ROOT } from '../paths.js';

const V2_BLOCK = ['## MEMORY BRAIN (mai-mcp)', '', 'body line', '', '<!-- /mai-brain-block v2 -->', ''].join('\n');
const LEGACY_BLOCK = ['## MEMORY BRAIN (mai-mcp)', '', 'old body', ''].join('\n');

describe('templateVersion', () => {
  it('reads the version from the sentinel', () => {
    expect(templateVersion(V2_BLOCK)).toBe(2);
  });
  it('throws when a template has no sentinel', () => {
    expect(() => templateVersion(LEGACY_BLOCK)).toThrow(/sentinel/);
  });
  it('both shipped templates carry a sentinel (build-time invariant)', async () => {
    for (const t of ['memory-brain-block.md', 'memory-brain-block-agents.md']) {
      const raw = await fs.readFile(path.join(MAI_ROOT, 'templates', t), 'utf8');
      expect(raw).toMatch(SENTINEL_RE);
      const loaded = await loadTemplate(t);
      expect(loaded.version).toBeGreaterThanOrEqual(2);
    }
  });
  it('both shipped templates carry the cache-warmth guidance at v5+', async () => {
    for (const t of ['memory-brain-block.md', 'memory-brain-block-agents.md']) {
      const raw = await fs.readFile(path.join(MAI_ROOT, 'templates', t), 'utf8');
      expect(raw).toMatch(/Long commands → background them/);
      expect(raw).toMatch(/prompt cache/);
      expect(templateVersion(raw)).toBeGreaterThanOrEqual(5);
    }
  });
});

describe('findManagedBlock', () => {
  it('returns null when there is no marker', () => {
    expect(findManagedBlock('# Plain file\n\nno block here\n')).toBeNull();
  });
  it('finds a sentineled block exactly heading→sentinel', () => {
    const content = `# Rules\n\nintro\n\n${V2_BLOCK}\n## After\n\nkeep me\n`;
    const b = findManagedBlock(content)!;
    expect(b.version).toBe(2);
    expect(b.text.startsWith('## MEMORY BRAIN')).toBe(true);
    expect(b.text.trimEnd().endsWith('<!-- /mai-brain-block v2 -->')).toBe(true);
    expect(b.text).not.toContain('## After');
  });
  it('legacy block ends at the next ## heading', () => {
    const content = `# Rules\n\n${LEGACY_BLOCK}\n## After\n\nkeep me\n`;
    const b = findManagedBlock(content)!;
    expect(b.version).toBeNull();
    expect(b.text).toContain('old body');
    expect(b.text).not.toContain('## After');
  });
  it('legacy block ends at EOF when it is the last section', () => {
    const content = `# Rules\n\n${LEGACY_BLOCK}`;
    const b = findManagedBlock(content)!;
    expect(b.version).toBeNull();
    expect(b.end).toBe(content.length);
  });
  it('user content appended INSIDE the legacy extent is part of the block (why diff+confirm exists)', () => {
    const content = `# Rules\n\n## MEMORY BRAIN (mai-mcp)\n\nold body\n\nuser scribble\n`;
    const b = findManagedBlock(content)!;
    expect(b.text).toContain('user scribble');
  });
  it('anchors on the heading line, not a prose mention above the block (review hardening)', () => {
    const content = `# Rules\n\nDo not touch the MEMORY BRAIN (mai-mcp) section below.\n\n${V2_BLOCK}`;
    const b = findManagedBlock(content)!;
    expect(b.text.startsWith('## MEMORY BRAIN')).toBe(true);
    expect(b.text).not.toContain('Do not touch');
    expect(b.version).toBe(2);
  });
  it('a prose mention with no heading is not a block', () => {
    expect(findManagedBlock('# Rules\n\nthe MEMORY BRAIN (mai-mcp) thing is elsewhere\n')).toBeNull();
  });
  it('finds a sentinel that ends the file without a trailing newline', () => {
    const content = `## MEMORY BRAIN (mai-mcp)\n\nbody\n\n<!-- /mai-brain-block v2 -->`;
    const b = findManagedBlock(content)!;
    expect(b.version).toBe(2);
    expect(b.end).toBe(content.length);
  });
});

describe('replaceManagedBlock', () => {
  it('replaces the block and preserves everything around it', () => {
    const content = `# Rules\n\nintro\n\n${LEGACY_BLOCK}\n## After\n\nkeep me\n`;
    const b = findManagedBlock(content)!;
    const out = replaceManagedBlock(content, b, V2_BLOCK);
    expect(out).toContain('intro');
    expect(out).toContain('## After');
    expect(out).toContain('keep me');
    expect(out).toContain('<!-- /mai-brain-block v2 -->');
    expect(out).not.toContain('old body');
    expect(findManagedBlock(out)!.version).toBe(2);
  });
  it('keeps a heading boundary valid when the legacy extent consumed the separator', () => {
    const content = `## MEMORY BRAIN (mai-mcp)\nold\n## After\n`;
    const b = findManagedBlock(content)!;
    const out = replaceManagedBlock(content, b, '## MEMORY BRAIN (mai-mcp)\nnew\n<!-- /mai-brain-block v2 -->');
    expect(out).toMatch(/<!-- \/mai-brain-block v2 -->\n+## After/);
  });
});

describe('workflow instructions installation', () => {
  it.each(['memory-brain-block.md', 'memory-brain-block-agents.md'])(
    '%s provides v7 routing and preserves user text on upgrade', async (template) => {
      const { block, version } = await loadTemplate(template);
      expect(version).toBe(7);
      expect(block).toContain('Choose a workflow by intent');
      expect(block).toContain('do not wait for its name');
      expect(block).toContain('suggestion\n  is advisory');
      const before = '# User instructions\n\n' + V2_BLOCK + '\n## GRADUATED RULES (mai-mcp)\nKeep this rule.\n';
      const change = await planRulesBlockUpgrade('/unused', 'AGENTS.md', template, before);
      expect(change).not.toBeNull();
      expect(change?.preimage).toBe(before);
      expect(change?.newContent).toBe('# User instructions\n\n' + block + '\n## GRADUATED RULES (mai-mcp)\nKeep this rule.\n');
      expect(findManagedBlock(block)?.text).toBe(block);
      expect(await planRulesBlockUpgrade('/unused', 'AGENTS.md', template, change?.newContent)).toBeNull();
    });
});
