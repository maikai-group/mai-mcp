/** Graduated-rules render unit tests (plan 27): byte-stability, marker
 * discipline, planner semantics. No DB — graduatedRules() is covered by the
 * graduation integration suite. */
import { afterAll, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  renderGraduatedRulesBlock, installGraduatedRulesBlock, planGraduatedRulesUpgrade,
  planInstructionFileUpgrade, atomicReplace,
  GRADUATED_HEADING, GRADUATED_SENTINEL, type GraduatedRule,
  type AtomicReplaceOps,
} from '../rules-render.js';
import { findManagedBlock, loadTemplate, GRADUATED_BLOCK } from '../scripts/managed-block.js';

const RULES: GraduatedRule[] = [
  { lessonId: '11111111-aaaa-bbbb-cccc-000000000001', rule: 'Always A', relearnedCount: 5 },
  { lessonId: '22222222-aaaa-bbbb-cccc-000000000002', rule: 'Never\n  B twice', relearnedCount: 7 },
];
const BRAIN = '## MEMORY BRAIN (mai-mcp)\n\nbody\n\n<!-- /mai-brain-block v3 -->\n';

/** AMENDMENT A1 (plan 27, finding fce650a5, author-approved 2026-08-15). Each
 * call previously minted an untracked mkdtemp directory that nothing removed,
 * so focused/full/assembled-public repetitions accumulated OS scratch outside
 * the release root. One tracked suite root, removed in afterAll. */
const SUITE_ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'mai-rules-render-'));
let dirSeq = 0;
const tmp = () => {
  const dir = path.join(SUITE_ROOT, `case-${dirSeq++}`);
  fs.mkdirSync(dir, { recursive: true });
  return dir;
};
afterAll(() => {
  fs.rmSync(SUITE_ROOT, { recursive: true, force: true });
});

describe('renderGraduatedRulesBlock', () => {
  it('renders deterministically: same input → byte-identical output', () => {
    expect(renderGraduatedRulesBlock(RULES)).toBe(renderGraduatedRulesBlock(RULES));
  });
  it('empty set renders heading + sentinel + placeholder, no rule lines', () => {
    const out = renderGraduatedRulesBlock([]);
    expect(out).toContain(GRADUATED_HEADING);
    expect(out).toContain(GRADUATED_SENTINEL);
    expect(out).toContain('No graduated rules yet');
    // AMENDMENT A2 (plan 27, author-approved 2026-08-15). The plan specified
    // `not.toContain('- ')`, which cannot pass: the same function emits
    // `<!-- Machine-rendered …` and `<!-- /mai-graduated-rules v1 -->`, and
    // `<!-- ` literally contains hyphen-space. The INTENT is "renders no rule
    // list items", which is a line-anchored property — assert that instead of
    // a substring the renderer guarantees is present.
    expect(out).not.toMatch(/^- /m);
  });
  it('flattens multi-line rule text and carries provenance', () => {
    const out = renderGraduatedRulesBlock(RULES);
    expect(out).toContain('- Never B twice _(lesson 22222222, relearned ×7)_');
  });
  it('its own output parses as a graduated block (round-trip)', () => {
    const block = findManagedBlock(renderGraduatedRulesBlock(RULES), GRADUATED_BLOCK);
    expect(block).not.toBeNull();
    expect(block?.version).toBe(1);
  });
});

describe('atomicReplace durability', () => {
  it('flushes file data before rename and the directory entry after rename', async () => {
    const events: string[] = [];
    const ops: AtomicReplaceOps = {
      realpath: async () => { events.push('realpath'); return '/repo/CLAUDE.md'; },
      stat: async () => { events.push('stat'); return { mode: 0o100764 }; },
      openTemp: async (_file, mode) => {
        events.push(`open-temp:${mode.toString(8)}`);
        return {
          writeFile: async (content, options) => {
            events.push(`write:${content}:${options.encoding}`);
          },
          chmod: async (nextMode) => { events.push(`chmod:${nextMode.toString(8)}`); },
          sync: async () => { events.push('file-sync'); },
          close: async () => { events.push('file-close'); },
        };
      },
      rename: async () => { events.push('rename'); },
      openDirectory: async () => {
        events.push('open-directory');
        return {
          sync: async () => { events.push('directory-sync'); },
          close: async () => { events.push('directory-close'); },
        };
      },
      rm: async () => { events.push('cleanup-temp'); },
    };

    await atomicReplace('/repo/link.md', 'new body', ops);
    expect(events).toEqual([
      'realpath', 'stat', 'open-temp:764', 'write:new body:utf8', 'chmod:764',
      'file-sync', 'file-close', 'rename', 'open-directory', 'directory-sync',
      'directory-close', 'cleanup-temp',
    ]);
  });

  it('closes and removes the temp without renaming when file sync fails', async () => {
    const events: string[] = [];
    const ops: AtomicReplaceOps = {
      realpath: async () => '/repo/CLAUDE.md',
      stat: async () => ({ mode: 0o100600 }),
      openTemp: async () => ({
        writeFile: async () => { events.push('write'); },
        chmod: async () => { events.push('chmod'); },
        sync: async () => { events.push('file-sync'); throw new Error('sync failed'); },
        close: async () => { events.push('file-close'); },
      }),
      rename: async () => { events.push('rename'); },
      openDirectory: async () => ({
        sync: async () => { events.push('directory-sync'); },
        close: async () => { events.push('directory-close'); },
      }),
      rm: async () => { events.push('cleanup-temp'); },
    };

    await expect(atomicReplace('/repo/CLAUDE.md', 'body', ops)).rejects.toThrow('sync failed');
    expect(events).toEqual(['write', 'chmod', 'file-sync', 'file-close', 'cleanup-temp']);
  });
});

describe('installGraduatedRulesBlock', () => {
  it('absent file → absent; existing file → installed once, then unchanged', async () => {
    const dir = tmp();
    expect(await installGraduatedRulesBlock(dir, 'CLAUDE.md')).toBe('absent');
    fs.writeFileSync(path.join(dir, 'CLAUDE.md'), BRAIN);
    expect(await installGraduatedRulesBlock(dir, 'CLAUDE.md')).toBe('installed');
    const once = fs.readFileSync(path.join(dir, 'CLAUDE.md'), 'utf8');
    expect(await installGraduatedRulesBlock(dir, 'CLAUDE.md')).toBe('unchanged');
    expect(fs.readFileSync(path.join(dir, 'CLAUDE.md'), 'utf8')).toBe(once);
  });
});

describe('planGraduatedRulesUpgrade', () => {
  const rendered = renderGraduatedRulesBlock(RULES);
  it('file without a brain block → null (not mai-wired)', async () => {
    const dir = tmp();
    fs.writeFileSync(path.join(dir, 'CLAUDE.md'), '# hello\n');
    expect(await planGraduatedRulesUpgrade(dir, 'CLAUDE.md', rendered)).toBeNull();
  });
  it('brain block, no graduated block → plans an install', async () => {
    const dir = tmp();
    fs.writeFileSync(path.join(dir, 'CLAUDE.md'), BRAIN);
    const change = await planGraduatedRulesUpgrade(dir, 'CLAUDE.md', rendered);
    expect(change?.label).toContain('install');
    expect(change?.newContent).toContain(GRADUATED_SENTINEL);
    expect(change?.newContent.startsWith(BRAIN)).toBe(true);
  });
  it('stale graduated block → plans a refresh; current one → null', async () => {
    const dir = tmp();
    fs.writeFileSync(path.join(dir, 'CLAUDE.md'), BRAIN + '\n' + renderGraduatedRulesBlock([]));
    const change = await planGraduatedRulesUpgrade(dir, 'CLAUDE.md', rendered);
    expect(change?.label).toContain('refresh');
    if (!change) throw new Error('expected graduated refresh');
    fs.writeFileSync(path.join(dir, 'CLAUDE.md'), change.newContent);
    expect(await planGraduatedRulesUpgrade(dir, 'CLAUDE.md', rendered)).toBeNull();
  });

  it('contentOverride plans against the prior in-memory change, not stale disk', async () => {
    const dir = tmp();
    fs.writeFileSync(path.join(dir, 'CLAUDE.md'), BRAIN);
    const prior = BRAIN.replace('body', 'already refreshed in memory');
    const change = await planGraduatedRulesUpgrade(dir, 'CLAUDE.md', rendered, prior);
    expect(change?.newContent.startsWith(prior)).toBe(true);
    expect(change?.newContent).toContain(GRADUATED_SENTINEL);
  });

  it('composes stale brain + absent graduated blocks into one final file change', async () => {
    const { block } = await loadTemplate('memory-brain-block.md');
    const dir = tmp();
    fs.writeFileSync(path.join(dir, 'CLAUDE.md'), BRAIN.replace('v3', 'v4'));
    const changes = await planInstructionFileUpgrade(
      dir, 'CLAUDE.md', 'memory-brain-block.md', rendered
    );
    expect(changes).toHaveLength(1);
    expect(findManagedBlock(changes[0].newContent)?.text).toBe(block);
    expect(changes[0].newContent).toContain(GRADUATED_SENTINEL);
  });
});

describe('BlockSpec discipline', () => {
  it('graduated spec has NO legacy extent: heading without sentinel → null', () => {
    expect(findManagedBlock('## GRADUATED RULES (mai-mcp)\n\nstuff\n', GRADUATED_BLOCK)).toBeNull();
  });
  it('brain-block default behavior is unchanged (legacy heading still found)', () => {
    const legacy = findManagedBlock('## MEMORY BRAIN (mai-mcp)\n\nold body\n');
    expect(legacy).not.toBeNull();
    expect(legacy?.version).toBeNull();
  });
});
