/** mai init installs the Memory-brain block into CLAUDE.md idempotently. */
import { afterAll, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { mergeClaudeMd } from '../scripts/init.js';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'mai-claude-md-test-'));

afterAll(() => {
  fs.rmSync(tmp, { recursive: true, force: true });
});

describe('mergeClaudeMd', () => {
  it('creates CLAUDE.md with the block when absent', async () => {
    const dir = fs.mkdtempSync(path.join(tmp, 'create-'));
    expect(await mergeClaudeMd(dir)).toBe('created');
    const content = fs.readFileSync(path.join(dir, 'CLAUDE.md'), 'utf8');
    expect(content).toContain('## MEMORY BRAIN (mai-mcp)');
    expect(content).toContain('mai_remember');
  });

  it('appends to an existing CLAUDE.md without touching prior content', async () => {
    const dir = fs.mkdtempSync(path.join(tmp, 'append-'));
    fs.writeFileSync(path.join(dir, 'CLAUDE.md'), '# my project\n\nrules here\n');
    expect(await mergeClaudeMd(dir)).toBe('updated');
    const content = fs.readFileSync(path.join(dir, 'CLAUDE.md'), 'utf8');
    expect(content.startsWith('# my project\n\nrules here\n')).toBe(true);
    expect(content).toContain('## MEMORY BRAIN (mai-mcp)');
  });

  it('is idempotent — second run is unchanged', async () => {
    const dir = fs.mkdtempSync(path.join(tmp, 'idem-'));
    await mergeClaudeMd(dir);
    const before = fs.readFileSync(path.join(dir, 'CLAUDE.md'), 'utf8');
    expect(await mergeClaudeMd(dir)).toBe('unchanged');
    expect(fs.readFileSync(path.join(dir, 'CLAUDE.md'), 'utf8')).toBe(before);
  });

  it('treats a hand-pasted block as already installed', async () => {
    const dir = fs.mkdtempSync(path.join(tmp, 'hand-'));
    fs.writeFileSync(path.join(dir, 'CLAUDE.md'), '# repo\n\n## MEMORY BRAIN (mai-mcp)\n\nhand-pasted copy\n');
    expect(await mergeClaudeMd(dir)).toBe('unchanged');
  });
});
