/** glue extractor: fixture-repo files via extract(); launchd/cron via the pure
 * parsers (no system-state dependence in tests). */
import { beforeAll, describe, expect, it } from 'vitest';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { serviceIdentity, serviceSourceQName } from '../graph/contracts.js';
import {
  glueExtractor,
  parseCrontab,
  parseLaunchdJob,
  parsePackageScripts,
  parseMcpServers,
  parseHookSettings,
  type GlueSink,
} from '../graph/extractors/glue.js';
import type { ExtractorOutput } from '../graph/types.js';

const FIXTURE = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures', 'ops-repo');
const IDENTITY = serviceIdentity(FIXTURE);
const source = (legacy: string): string => serviceSourceQName(IDENTITY.id, legacy);

let out: ExtractorOutput;

beforeAll(async () => {
  out = await glueExtractor.extract({ projectId: 'unused', repoPaths: [FIXTURE] });
});

const node = (kind: string, qn: string) => out.nodes.find((n) => n.kind === kind && n.qualifiedName === qn);
const edge = (rel: string, fromQn: string, toQn: string) =>
  out.edges.find((e) => e.relation === rel && e.from.qualifiedName === fromQn && e.to.qualifiedName === toQn);

describe('glue extractor (fixture repo)', () => {
  it('resolves nested launch-language targets through their longest-prefix service owner', async () => {
    const parent = fs.mkdtempSync(path.join(os.tmpdir(), 'glue-owned-'));
    const child = path.join(parent, 'child');
    const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'glue-outside-'));
    try {
      fs.mkdirSync(child, { recursive: true });
      fs.writeFileSync(path.join(child, 'main.py'), 'print("ok")\n');
      fs.writeFileSync(path.join(outside, 'outside.py'), 'print("outside")\n');
      fs.symlinkSync(path.join(child, 'main.py'), path.join(parent, 'linked.py'));
      fs.symlinkSync(path.join(outside, 'outside.py'), path.join(parent, 'outside.py'));
      fs.writeFileSync(path.join(parent, 'package.json'), JSON.stringify({ name: 'parent', scripts: {
        child: 'python3 child/main.py', linked: 'python3 linked.py', outside: 'python3 outside.py',
      } }));
      fs.writeFileSync(path.join(child, 'package.json'), JSON.stringify({ name: 'child' }));
      const forward = await glueExtractor.extract({ projectId: 'x', repoPaths: [parent, child] });
      const reverse = await glueExtractor.extract({ projectId: 'x', repoPaths: [child, parent] });
      const childTarget = serviceSourceQName(serviceIdentity(child).id, 'child/main.py');
      const relation = `${path.basename(parent)}/package.json#child->${childTarget}`;
      const signature = (value: ExtractorOutput): string[] => value.edges.map((entry) => `${entry.from.qualifiedName}->${entry.to.qualifiedName}`).sort();
      expect(signature(forward)).toEqual(signature(reverse));
      expect(signature(forward)).toContain(relation);
      expect(signature(forward)).toContain(`${path.basename(parent)}/package.json#linked->${childTarget}`);
      expect(JSON.stringify(forward.edges)).not.toContain(`${path.basename(parent)}/child/main.py`);
      expect(JSON.stringify(forward.edges)).not.toContain('outside.py');
    } finally {
      fs.rmSync(parent, { recursive: true, force: true });
      fs.rmSync(outside, { recursive: true, force: true });
    }
  });
  it('package.json scripts → package_script nodes invoking commands + project files', () => {
    const backup = node('package_script', 'ops-repo/package.json#backup');
    expect(backup).toBeDefined();
    expect(backup?.signature).toBe('bash scripts/backup.sh');
    expect(edge('invokes', 'ops-repo/package.json#backup', 'cmd:bash')).toBeDefined();
    expect(edge('invokes', 'ops-repo/package.json#backup', 'ops-repo/scripts/backup.sh')).toBeDefined();
    expect(edge('invokes', 'ops-repo/package.json#start', source('ops-repo/server.js'))).toBeDefined();
  });

  it('.mcp.json → mcp_server nodes', () => {
    expect(node('mcp_server', 'mcp:fixture-mcp')).toBeDefined();
    expect(edge('invokes', 'mcp:fixture-mcp', 'cmd:node')).toBeDefined();
    expect(edge('invokes', 'mcp:fixture-mcp', source('ops-repo/server.js'))).toBeDefined();
  });

  it('.claude hooks → scheduled_job with invokes + scheduled_by back-edge', () => {
    const qn = 'hook:ops-repo:SessionEnd#0';
    expect(node('scheduled_job', qn)).toBeDefined();
    expect(edge('invokes', qn, 'ops-repo/scripts/backup.sh')).toBeDefined();
    expect(edge('scheduled_by', 'ops-repo/scripts/backup.sh', qn)).toBeDefined();
  });
});

describe('glue pure parsers (launchd/cron)', () => {
  // The fictional /Users/x/repo qnameOf is fine for crontab (it only asserts the
  // job NODE). parseLaunchdJob asserts the invokes→FILE edge, which only emits
  // for a file that actually exists on disk (resolveProjectFile stats it — the
  // extractor never invents edges to nonexistent files). So the launchd test
  // points at a real fixture file; on the real machine launchd argv are real
  // absolute paths, which is exactly what this proves.
  const qnameOf = (abs: string): string | null =>
    abs.startsWith('/Users/x/repo/') ? `repo/${abs.slice('/Users/x/repo/'.length)}` : null;

  it('parseLaunchdJob: plist JSON → scheduled_job + invokes/scheduled_by', () => {
    const sink: GlueSink = { nodes: [], edges: [] };
    const realScript = path.join(FIXTURE, 'scripts', 'backup.sh'); // exists on disk
    const fixtureQname = (abs: string): string | null =>
      abs === FIXTURE || abs.startsWith(FIXTURE + path.sep)
        ? `ops-repo/${path.relative(FIXTURE, abs).split(path.sep).join('/')}`
        : null;
    parseLaunchdJob(
      {
        Label: 'com.mai.brain-backup',
        ProgramArguments: ['bash', realScript],
        StartCalendarInterval: { Hour: 3 },
      },
      fixtureQname,
      sink
    );
    expect(sink.nodes.find((n) => n.qualifiedName === 'launchd:com.mai.brain-backup')).toBeDefined();
    expect(
      sink.edges.find(
        (e) => e.relation === 'invokes' && e.to.qualifiedName === 'ops-repo/scripts/backup.sh'
      )
    ).toBeDefined();
    expect(
      sink.edges.find(
        (e) => e.relation === 'scheduled_by' && e.from.qualifiedName === 'ops-repo/scripts/backup.sh'
      )
    ).toBeDefined();
  });

  it('parseCrontab: repo-referencing lines only; comments skipped', () => {
    const sink: GlueSink = { nodes: [], edges: [] };
    parseCrontab(
      [
        '# a comment',
        '0 3 * * * bash /Users/x/repo/scripts/nightly.sh',
        '0 4 * * * bash /Users/elsewhere/other.sh',
      ].join('\n'),
      ['/Users/x/repo'],
      qnameOf,
      sink
    );
    const jobs = sink.nodes.filter((n) => n.kind === 'scheduled_job');
    expect(jobs).toHaveLength(1);
    expect(jobs[0].metadata).toMatchObject({ source: 'cron', schedule: '0 3 * * *' });
  });
});

describe('glue defining text evidence', () => {
  const digest = (text: string): string => createHash('sha256').update(text).digest('hex');

  it('hashes the supplied package, MCP and hook text without reading their paths', () => {
    const root = '/fictional-evidence-repo';
    const packageText = '{ "scripts": { "hello": "echo hello" } }\n';
    const mcpText = '{ "mcpServers": { "server": { "command": "node" } } }\n';
    const hookText = '{ "hooks": { "SessionEnd": [{ "hooks": [{ "command": "echo done" }] }] } }\n';
    const sink: GlueSink = { nodes: [], edges: [] };
    parsePackageScripts(packageText, 'evidence', root, () => null, sink);
    parseMcpServers(mcpText, root, () => null, sink);
    parseHookSettings(hookText, 'evidence', root, () => null, sink);
    const expected = new Map([
      [path.join(root, 'package.json'), digest(packageText)],
      [path.join(root, '.mcp.json'), digest(mcpText)],
      [path.join(root, '.claude', 'settings.json'), digest(hookText)],
    ]);
    const backed = sink.nodes.filter(entry => entry.filePath !== undefined);
    expect(backed).toHaveLength(3);
    for (const entry of backed) {
      if (entry.filePath === undefined) throw new Error('missing fixture path');
      expect(entry.contentHash).toBe(expected.get(entry.filePath));
    }
    const commands = sink.nodes.filter(entry => entry.kind === 'command');
    expect(commands.length).toBeGreaterThan(0);
    expect(commands.every(entry => entry.contentHash === undefined)).toBe(true);
  });

  it('retains exact whitespace evidence and leaves launchd/cron jobs fileless', () => {
    const sink: GlueSink = { nodes: [], edges: [] };
    const first = '{"scripts":{"x":"echo x"}}';
    const second = first + '\n';
    parsePackageScripts(first, 'first', '/fictional-evidence-repo', () => null, sink);
    parsePackageScripts(second, 'second', '/fictional-evidence-repo', () => null, sink);
    expect(sink.nodes.find(entry => entry.qualifiedName === 'first/package.json#x')?.contentHash).toBe(digest(first));
    expect(sink.nodes.find(entry => entry.qualifiedName === 'second/package.json#x')?.contentHash).toBe(digest(second));
    expect(digest(first)).not.toBe(digest(second));
    parseLaunchdJob({ Label: 'evidence', ProgramArguments: ['echo', 'hello'] }, () => null, sink);
    parseCrontab('0 3 * * * echo /fictional-evidence-repo/task', ['/fictional-evidence-repo'], () => null, sink);
    const jobs = sink.nodes.filter(entry => entry.kind === 'scheduled_job');
    expect(jobs).toHaveLength(2);
    expect(jobs.every(entry => entry.filePath === undefined && entry.contentHash === undefined)).toBe(true);
  });

  it('persists the exact fixture text hash on every file-backed glue output', () => {
    const backed = out.nodes.filter(entry => entry.filePath !== undefined);
    expect(backed.length).toBeGreaterThanOrEqual(4);
    for (const entry of backed) {
      if (entry.filePath === undefined) throw new Error('missing fixture path');
      expect(entry.contentHash).toBe(digest(fs.readFileSync(entry.filePath, 'utf8')));
    }
  });
});
