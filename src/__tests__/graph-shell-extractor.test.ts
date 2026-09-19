/** shell extractor over the committed ops-repo fixture — pure, no DB. */
import { beforeAll, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { serviceIdentity, serviceSourceQName } from '../graph/contracts.js';
import { shellExtractor } from '../graph/extractors/shell.js';
import type { ExtractorOutput } from '../graph/types.js';

const FIXTURE = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures', 'ops-repo');
const IDENTITY = serviceIdentity(FIXTURE);
const source = (legacy: string): string => serviceSourceQName(IDENTITY.id, legacy);

let out: ExtractorOutput;

beforeAll(async () => {
  out = await shellExtractor.extract({ projectId: 'unused', repoPaths: [FIXTURE] });
});

const node = (kind: string, qn: string) => out.nodes.find((n) => n.kind === kind && n.qualifiedName === qn);
const edge = (rel: string, fromQn: string, toQn: string) =>
  out.edges.find((e) => e.relation === rel && e.from.qualifiedName === fromQn && e.to.qualifiedName === toQn);

const SCRIPT = 'ops-repo/scripts/backup.sh';

describe('shell extractor', () => {
  it('partitions nested scripts and resolves launch-language refs through the child service', async () => {
    const parent = fs.mkdtempSync(path.join(os.tmpdir(), 'shell-owned-'));
    const child = path.join(parent, 'child');
    const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'shell-outside-'));
    try {
      fs.mkdirSync(child, { recursive: true });
      fs.writeFileSync(path.join(outside, 'outside.ts'), 'export {};\n');
      fs.writeFileSync(path.join(parent, 'parent.sh'), '#!/bin/bash\nnode parent.ts\nnode linked.ts\nnode outside.ts\n');
      fs.writeFileSync(path.join(parent, 'parent.ts'), 'export {};\n');
      fs.writeFileSync(path.join(child, 'child.sh'), '#!/bin/bash\nnode child.ts\n');
      fs.writeFileSync(path.join(child, 'child.ts'), 'export {};\n');
      fs.symlinkSync(path.join(child, 'child.ts'), path.join(parent, 'linked.ts'));
      fs.symlinkSync(path.join(outside, 'outside.ts'), path.join(parent, 'outside.ts'));
      const forward = await shellExtractor.extract({ projectId: 'x', repoPaths: [parent, child] });
      const reverse = await shellExtractor.extract({ projectId: 'x', repoPaths: [child, parent] });
      const signature = (value: ExtractorOutput): string[] => value.edges.map((entry) => `${entry.relation}:${entry.from.qualifiedName}->${entry.to.qualifiedName}`).sort();
      expect(signature(forward)).toEqual(signature(reverse));
      expect(forward.nodes.filter((entry) => entry.kind === 'script' && entry.filePath === fs.realpathSync.native(path.join(child, 'child.sh')))).toHaveLength(1);
      const childTarget = serviceSourceQName(serviceIdentity(child).id, 'child/child.ts');
      expect(forward.edges.some((entry) => entry.relation === 'invokes' && entry.from.qualifiedName === 'child/child.sh' && entry.to.qualifiedName === childTarget)).toBe(true);
      expect(forward.edges.some((entry) => entry.relation === 'invokes' && entry.from.qualifiedName === `${path.basename(parent)}/parent.sh` && entry.to.qualifiedName === childTarget)).toBe(true);
      expect(JSON.stringify(forward.edges)).not.toContain(`${path.basename(parent)}/child/child.ts`);
      expect(JSON.stringify(forward.edges)).not.toContain('outside.ts');
    } finally {
      fs.rmSync(parent, { recursive: true, force: true });
      fs.rmSync(outside, { recursive: true, force: true });
    }
  });
  it('emits script nodes with shebang lang + content hash', () => {
    const s = node('script', SCRIPT);
    expect(s).toBeDefined();
    expect(s?.lang).toBe('bash');
    expect(s?.contentHash).toMatch(/^[0-9a-f]{64}$/);
  });

  it('emits invokes edges to command nodes', () => {
    expect(node('command', 'cmd:pg_dump')).toBeDefined();
    expect(edge('invokes', SCRIPT, 'cmd:pg_dump')).toBeDefined();
    expect(edge('invokes', SCRIPT, 'cmd:node')).toBeDefined();
    expect(edge('invokes', SCRIPT, 'cmd:python3')).toBeDefined();
  });

  it('resolves file arguments to project-file invokes edges', () => {
    expect(edge('invokes', SCRIPT, source('ops-repo/server.js'))).toBeDefined();
    expect(edge('invokes', SCRIPT, source('ops-repo/tools/job.py'))).toBeDefined();
  });

  it('emits reads_env edges to env_var nodes', () => {
    expect(node('env_var', 'env:MAI_DB_URL')).toBeDefined();
    expect(edge('reads_env', SCRIPT, 'env:MAI_DB_URL')).toBeDefined();
    expect(edge('reads_env', SCRIPT, 'env:EXTRA_FLAGS')).toBeDefined();
  });
});
