import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';

process.env.MAI_PROJECT_SLUG = 'topics-test';
let tmpRoot = '';

beforeAll(async () => {
  tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'mai-topics-'));
  process.env.MAI_BRAIN_ROOT = tmpRoot;
  const dir = path.join(tmpRoot, 'docs', 'context', 'topics-test');
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(
    path.join(dir, 'overview.md'),
    `---\ntitle: Overview\nwhen: Always\nkeywords: overview, start\nalways: true\n---\n# Test overview\n\n## TL;DR\nShort version.\n\n## Detail\nLong version.\n`
  );
  await fs.writeFile(
    path.join(dir, 'payments.md'),
    `---\ntitle: Payments flow\nwhen: Billing work\nkeywords: stripe, billing, payment\n---\n# Payments\nBody here.\n`
  );
  await fs.writeFile(path.join(dir, '_draft-thing.md'), `# Draft\nNot served.\n`);
});

afterAll(async () => {
  await fs.rm(tmpRoot, { recursive: true, force: true });
});

describe('topics catalog', () => {
  it('discovers topics from frontmatter and skips _files', async () => {
    const { listTopics } = await import('../topics.js');
    const topics = await listTopics();
    expect(topics.map((t) => t.topic).sort()).toEqual(['overview', 'payments']);
    expect(topics.find((t) => t.topic === 'overview')?.always).toBe(true);
  });

  it('primeTopics: always-topics + keyword matches, capped', async () => {
    const { primeTopics } = await import('../topics.js');
    const picked = await primeTopics('fix the stripe billing webhook');
    expect(picked.map((t) => t.topic)).toContain('overview');
    expect(picked.map((t) => t.topic)).toContain('payments');
  });

  it('summary mode returns TL;DR not full body', async () => {
    const { primeTopics, getPrimedContext } = await import('../topics.js');
    const out = await getPrimedContext(await primeTopics('orient me'), 'summary');
    expect(out).toContain('Short version.');
    expect(out).not.toContain('Long version.');
  });

  it('getContext on unknown topic lists available ones', async () => {
    const { getContext } = await import('../topics.js');
    await expect(getContext('nope')).rejects.toThrow(/overview/);
  });
});
