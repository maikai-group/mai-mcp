/** Plan 15 Task 3: multi-harness init — final unions, destination-owner map,
 * contained writes, legacy seeding, consent matrix, and preflight ordering.
 * DB-backed through the shared disposable guard; the brain root and HOME are
 * temp dirs so no test touches the operator's checkout, ~/.claude, or ~/.codex.
 * (vitest isolates module graphs per file, so the env below re-binds
 * BRAIN_ROOT for every import in THIS file only; afterAll restores.) */
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { PassThrough } from 'node:stream';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { ChildProcess, execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { Pool } from 'pg';
import { requireDisposableTestDbUrl } from './test-db-url.js';

const run = promisify(execFile);
const REPO_ROOT = fileURLToPath(new URL('../..', import.meta.url));
const savedEnv: Record<string, string | undefined> = {};
for (const k of ['MAI_BRAIN_ROOT', 'MAI_DB_URL', 'HOME', 'CODEX_HOME', 'MAI_LLM_SUMMARY', 'MAI_LLM_PROVIDER', 'MAI_CODEX_FIXTURE', 'PATH']) {
  savedEnv[k] = process.env[k];
}
const BRAIN = fs.mkdtempSync(path.join(os.tmpdir(), 'mai-init-brain-'));
const HOME_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'mai-init-home-'));
const TEST_DB = requireDisposableTestDbUrl();
process.env.MAI_BRAIN_ROOT = BRAIN;
process.env.MAI_DB_URL = TEST_DB;
process.env.HOME = HOME_DIR;
process.env.CODEX_HOME = path.join(HOME_DIR, '.codex');
process.env.MAI_LLM_SUMMARY = '0'; // set-don't-delete: keeps detectLLMProviderId() null

const ccBin = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures', 'cc-bin');
const codexBin = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures', 'codex-bin');
const realPath = savedEnv.PATH ?? '';
/** PATH without any subscription CLI: system dirs only (git lives there). */
const barePath = '/usr/bin:/bin:/usr/sbin:/sbin';

const admin = new Pool({ connectionString: TEST_DB });
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'mai-init-test-'));
let n = 0;

type InitModule = typeof import('../scripts/init.js');
let initMod: InitModule;

beforeAll(async () => {
  initMod = await import('../scripts/init.js');
});

it('keeps completion and next-step guidance portable', async () => {
  const { initNextSteps } = await import('../scripts/init.js');
  const lines = [...initNextSteps('portable-project', false), ...initNextSteps('portable-project', true)];
  expect(lines.join('\n')).not.toMatch(/(?:\bbash\s|\.sh\b)/u);
  expect(lines).toContain('  - start the dashboard: mai dashboard start');
});

afterAll(async () => {
  await admin.end();
  const { getPool } = await import('../db.js');
  await getPool().end();
  for (const [k, v] of Object.entries(savedEnv)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  fs.rmSync(tmp, { recursive: true, force: true });
});

afterEach(async () => {
  process.env.PATH = realPath;
  delete process.env.MAI_CODEX_FIXTURE;
  process.env.MAI_LLM_SUMMARY = '0';
  delete process.env.MAI_LLM_PROVIDER;
  const { resetClaudeBinaryProbe } = await import('../llm/claude-code.js');
  const { resetCodexBinaryProbe } = await import('../llm/codex-cli.js');
  resetClaudeBinaryProbe();
  resetCodexBinaryProbe();
});

async function setBinaries(kind: 'claude-only' | 'codex-only' | 'both' | 'none'): Promise<void> {
  if (kind === 'claude-only') {
    process.env.PATH = `${ccBin}:${barePath}`;
  } else if (kind === 'codex-only') {
    process.env.PATH = `${codexBin}:${barePath}`;
    process.env.MAI_CODEX_FIXTURE = 'ok';
  } else if (kind === 'both') {
    process.env.PATH = `${ccBin}:${codexBin}:${barePath}`;
    process.env.MAI_CODEX_FIXTURE = 'ok';
  } else {
    process.env.PATH = barePath;
  }
  const { resetClaudeBinaryProbe } = await import('../llm/claude-code.js');
  const { resetCodexBinaryProbe } = await import('../llm/codex-cli.js');
  resetClaudeBinaryProbe();
  resetCodexBinaryProbe();
}

function makeRepo(): string {
  return fs.mkdtempSync(path.join(tmp, 'repo-'));
}
function consentFile(): string {
  return path.join(tmp, `consent-env-${n++}`);
}
function slug(): string {
  return `p15-init-${n++}`;
}

interface BaseArgsOverrides {
  slug?: string;
  root?: string;
  repos?: string[];
  replaceRepos?: boolean;
  repoMaps?: Array<{ storedRoot: string; targetRoot: string }>;
  excludes?: string[];
  harnesses?: string[];
  rulesFile?: string;
  llm?: 'claude-code' | 'codex-cli' | 'none';
  embeddings?: 'local' | 'none';
  yes?: boolean;
  consentEnvFile?: string;
  preFileLlmAuthority?: { provider?: string; summary?: string };
  destinationMapBuilder?: import('../scripts/init.js').DestinationMapBuilder;
  sharedSkillsVerification?: 'required' | 'deferred';
  afterProjectionRead?: () => Promise<void>;
  draftTopics?: boolean;
}
function baseArgs(overrides: BaseArgsOverrides = {}): Parameters<InitModule['runInit']>[0] {
  const root = overrides.root ?? makeRepo();
  return {
    slug: overrides.slug ?? slug(),
    root,
    repos: overrides.repos ?? [root],
    replaceRepos: overrides.replaceRepos,
    repoMaps: overrides.repoMaps,
    excludes: overrides.excludes,
    draftTopics: overrides.draftTopics ?? false,
    printSummary: false,
    consentEnvFile: overrides.consentEnvFile ?? consentFile(),
    harnesses: overrides.harnesses,
    rulesFile: overrides.rulesFile,
    llm: overrides.llm,
    embeddings: overrides.embeddings,
    yes: overrides.yes,
    preFileLlmAuthority: overrides.preFileLlmAuthority ?? {},
    destinationMapBuilder: overrides.destinationMapBuilder,
    sharedSkillsVerification: overrides.sharedSkillsVerification,
    afterProjectionRead: overrides.afterProjectionRead,
  };
}

async function metadataOf(slugName: string): Promise<Record<string, unknown> | null> {
  const row = await admin.query<{ metadata: Record<string, unknown> | null }>(
    `SELECT metadata FROM projects WHERE slug = $1`,
    [slugName]
  );
  return row.rows.length > 0 ? row.rows[0].metadata : null;
}

function treeBytes(dir: string): Map<string, string> {
  const out = new Map<string, string>();
  const walk = (current: string, base: string): void => {
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      const full = path.join(current, entry.name);
      const rel = base === '' ? entry.name : `${base}/${entry.name}`;
      if (entry.isSymbolicLink()) out.set(rel, `link:${fs.readlinkSync(full)}`);
      else if (entry.isDirectory()) walk(full, rel);
      else out.set(rel, fs.readFileSync(full, 'utf8'));
    }
  };
  walk(dir, '');
  return out;
}

// ---------------------------------------------------------------- unit layer

describe('mergeHooks', () => {
  it('renders the complete Claude projection from the shared wiring owner', async () => {
    const wiring = await import('../hook-wiring.js');
    const root = path.join(makeRepo(), "arbitrary checkout ' &");
    const entries = initMod.canonicalMaiHooks('safe-slug', root);
    expect(entries).toEqual(wiring.canonicalMaiHooks('safe-slug', root));
    expect(entries.map(row => row.event)).toEqual(['SessionStart', 'SessionEnd', 'Stop', 'PreToolUse']);
    for (const { entry } of entries) expect(wiring.readManagedHookCommand(entry.hooks[0].command)?.legacy).toBe(false);
  });

  it('detects hooks-only Node wiring without a checkout-name heuristic', async () => {
    const dir = makeRepo();
    const hooks: Record<string, unknown[]> = {};
    for (const { event, entry } of initMod.canonicalMaiHooks('safe-slug', '/tmp/arbitrary-checkout')) {
      (hooks[event] ??= []).push(entry);
    }
    fs.mkdirSync(path.join(dir, '.claude'));
    fs.writeFileSync(path.join(dir, '.claude', 'settings.json'), JSON.stringify({ hooks }));
    const { ClaudeCodeAdapter } = await import('../capture/claude-code.js');
    expect((await new ClaudeCodeAdapter().detect(dir)).installed).toBe(true);
    fs.writeFileSync(path.join(dir, '.claude', 'settings.json'), JSON.stringify({ note: 'mai-mcp' }));
    expect((await new ClaudeCodeAdapter().detect(dir)).installed).toBe(false);
  });

  it('adds the Stop nudge hook and is idempotent', async () => {
    const dir = makeRepo();
    const first = await initMod.mergeHooks(dir, 'init-test');
    expect(first).toBe('created');

    const settingsRaw: unknown = JSON.parse(fs.readFileSync(path.join(dir, '.claude', 'settings.json'), 'utf8'));
    const settings = settingsRaw as {
      hooks: {
        Stop?: Array<{ hooks: Array<{ command: string }> }>;
        SessionStart?: Array<{ hooks: Array<{ command: string }> }>;
      };
    };
    const { readManagedHookCommand } = await import('../hook-wiring.js');
    const stopCmds = (settings.hooks.Stop ?? []).flatMap((e) => e.hooks.map((h) => h.command));
    expect(stopCmds.some((c) => readManagedHookCommand(c)?.mode === 'session-stop')).toBe(true);
    const startCmds = (settings.hooks.SessionStart ?? []).flatMap((e) => e.hooks.map((h) => h.command));
    expect(startCmds.some((c) => {
      const command = readManagedHookCommand(c);
      return command?.mode === 'session-start' && command.project === 'init-test';
    })).toBe(true);

    const second = await initMod.mergeHooks(dir, 'init-test');
    expect(second).toBe('unchanged');
  });
});

describe('runDraftTopics portable process contract', () => {
  function fakeChild(pid = 4242): ChildProcess {
    const child = new ChildProcess();
    Object.defineProperties(child, {
      pid: { value: pid, configurable: true },
      exitCode: { value: null, writable: true, configurable: true },
      signalCode: { value: null, writable: true, configurable: true },
      stdin: { value: new PassThrough(), configurable: true },
      stdout: { value: new PassThrough(), configurable: true },
      stderr: { value: new PassThrough(), configurable: true },
    });
    return child;
  }

  function draftOps(
    child: ChildProcess,
    overrides: Partial<import('../scripts/init.js').DraftTopicsOps> = {},
  ): import('../scripts/init.js').DraftTopicsOps {
    const base: import('../scripts/init.js').DraftTopicsOps = {
      env: { PATH: 'fixture-path', DRAFT_CANARY: 'preserved' },
      find: vi.fn(() => 'C:\\Program Files\\Claude & Tools (x64)\\claude.cmd'),
      spawn: vi.fn(() => child),
      process: {
        processBirthId: vi.fn(async () => 'birth-1'),
        terminateTree: vi.fn(async () => undefined),
      },
      timeoutMs: 0,
      maxBufferBytes: 64 * 1024 * 1024,
    };
    return { ...base, ...overrides };
  }

  it('preserves exact executable, argv, cwd, inherited env and default policy', async () => {
    const child = fakeChild();
    const ops = draftOps(child);
    queueMicrotask(() => child.emit('close', 0, null));
    await initMod.runDraftTopics('opaque prompt & (text)', '/repo with spaces', ops);
    expect(ops.find).toHaveBeenCalledWith('claude', { env: ops.env });
    expect(ops.spawn).toHaveBeenCalledWith(
      'C:\\Program Files\\Claude & Tools (x64)\\claude.cmd',
      ['-p', 'opaque prompt & (text)', '--permission-mode', 'acceptEdits', '--add-dir', BRAIN],
      { cwd: '/repo with spaces', env: ops.env, stdio: ['pipe', 'pipe', 'pipe'], shell: false },
    );
    expect(initMod.defaultDraftTopicsOps()).toMatchObject({ timeoutMs: 0, maxBufferBytes: 64 * 1024 * 1024 });
  });

  it('rejects a missing executable without spawning', async () => {
    const child = fakeChild();
    const find: import('../scripts/init.js').DraftTopicsOps['find'] = vi.fn(() => null);
    const ops = draftOps(child, { find });
    await expect(initMod.runDraftTopics('p', '/repo', ops)).rejects.toThrow('claude executable unavailable');
    expect(ops.spawn).not.toHaveBeenCalled();
  });

  it('propagates a synchronous spawn failure without leaking inputs', async () => {
    const child = fakeChild();
    const spawn: import('../scripts/init.js').DraftTopicsOps['spawn'] = vi.fn(() => { throw new Error('fixture launch failed'); });
    const ops = draftOps(child, { spawn });
    await expect(initMod.runDraftTopics('secret prompt', '/repo', ops)).rejects.toThrow('fixture launch failed');
  });

  it('turns an asynchronous launch error into a bounded generic failure', async () => {
    const child = fakeChild();
    const ops = draftOps(child);
    queueMicrotask(() => child.emit('error', new Error('sensitive output')));
    await expect(initMod.runDraftTopics('p', '/repo', ops)).rejects.toThrow('draft process launch failed');
  });

  it('rejects a nonzero close and destroys all streams', async () => {
    const child = fakeChild();
    const ops = draftOps(child);
    queueMicrotask(() => child.emit('close', 7, null));
    await expect(initMod.runDraftTopics('p', '/repo', ops)).rejects.toThrow('draft process exited 7');
    expect([child.stdin?.destroyed, child.stdout?.destroyed, child.stderr?.destroyed]).toEqual([true, true, true]);
  });

  it('waits for birth proof before deadline cleanup and ignores a racing close', async () => {
    const child = fakeChild();
    let resolveBirth!: (value: string | null) => void;
    const birth = new Promise<string | null>((resolve) => { resolveBirth = resolve; });
    const terminateTree = vi.fn(async (_pid: number, authorize: () => Promise<boolean>) => {
      expect(await authorize()).toBe(true);
    });
    const ops = draftOps(child, {
      timeoutMs: 5,
      process: { processBirthId: vi.fn(() => birth), terminateTree },
    });
    const result = initMod.runDraftTopics('p', '/repo', ops);
    await new Promise((resolve) => setTimeout(resolve, 15));
    expect(terminateTree).not.toHaveBeenCalled();
    child.emit('close', 0, null);
    resolveBirth('birth-1');
    await expect(result).rejects.toThrow('draft process timed out');
    expect(terminateTree).toHaveBeenCalledTimes(1);
  });

  it('bounds and discards stdout', async () => {
    const child = fakeChild();
    const ops = draftOps(child, { maxBufferBytes: 2 });
    queueMicrotask(() => child.stdout?.emit('data', Buffer.from('abc')));
    await expect(initMod.runDraftTopics('p', '/repo', ops)).rejects.toThrow('draft stdout exceeded buffer limit');
  });

  it('bounds and discards stderr', async () => {
    const child = fakeChild();
    const ops = draftOps(child, { maxBufferBytes: 2 });
    queueMicrotask(() => child.stderr?.emit('data', Buffer.from('abc')));
    await expect(initMod.runDraftTopics('p', '/repo', ops)).rejects.toThrow('draft stderr exceeded buffer limit');
  });

  it('routes stdin error through tree cleanup', async () => {
    const child = fakeChild();
    const ops = draftOps(child);
    queueMicrotask(() => child.stdin?.emit('error', new Error('fixture')));
    await expect(initMod.runDraftTopics('p', '/repo', ops)).rejects.toThrow('draft stdin failed');
    expect(ops.process.terminateTree).toHaveBeenCalledTimes(1);
  });

  it('refuses signals when the root birth identity is unknown', async () => {
    const child = fakeChild();
    const terminateTree = vi.fn(async () => undefined);
    const ops = draftOps(child, {
      process: { processBirthId: vi.fn(async () => null), terminateTree },
    });
    queueMicrotask(() => child.emit('error', new Error('fixture')));
    await expect(initMod.runDraftTopics('p', '/repo', ops)).rejects.toThrow('cleanup could not be proved');
    expect(terminateTree).not.toHaveBeenCalled();
  });

  it('makes recycled-root authorization false', async () => {
    const child = fakeChild();
    const processBirthId = vi.fn()
      .mockResolvedValueOnce('birth-1')
      .mockResolvedValueOnce('birth-2');
    const terminateTree = vi.fn(async (_pid: number, authorize: () => Promise<boolean>) => {
      expect(await authorize()).toBe(false);
    });
    const ops = draftOps(child, { process: { processBirthId, terminateTree } });
    queueMicrotask(() => child.emit('error', new Error('fixture')));
    await expect(initMod.runDraftTopics('p', '/repo', ops)).rejects.toThrow('draft process launch failed');
    expect(terminateTree).toHaveBeenCalledTimes(1);
  });

  it('settles once after rejected cleanup and duplicate error/close events', async () => {
    const child = fakeChild();
    const terminateTree = vi.fn(async () => { throw new Error('fixture cleanup'); });
    const ops = draftOps(child, { process: { processBirthId: vi.fn(async () => 'birth-1'), terminateTree } });
    queueMicrotask(() => {
      child.emit('error', new Error('first'));
      child.emit('error', new Error('second'));
      child.emit('close', 0, null);
    });
    await expect(initMod.runDraftTopics('p', '/repo', ops)).rejects.toThrow('cleanup could not be proved');
    expect(terminateTree).toHaveBeenCalledTimes(1);
    expect([child.stdin?.destroyed, child.stdout?.destroyed, child.stderr?.destroyed]).toEqual([true, true, true]);
  });

  it('runs the editable drafting branch through the platform launcher and reports zero files', async () => {
    const commands = await import('../platform/commands.js');
    const child = fakeChild();
    const find = vi.spyOn(commands, 'findExecutable').mockReturnValue('/fixture/claude');
    const spawn = vi.spyOn(commands, 'spawnArgv').mockImplementation(() => {
      queueMicrotask(() => child.emit('close', 0, null));
      return child;
    });
    try {
      const result = await initMod.runInit(baseArgs({
        draftTopics: true, llm: 'none', embeddings: 'none', yes: true,
        sharedSkillsVerification: 'deferred',
      }));
      expect(result.summary.join('\n')).toContain('claude ran but wrote no files');
      expect(find).toHaveBeenCalledWith('claude', expect.any(Object));
      expect(spawn).toHaveBeenCalledWith('/fixture/claude', expect.arrayContaining(['--permission-mode', 'acceptEdits']),
        expect.objectContaining({ shell: false }));
    } finally {
      spawn.mockRestore();
      find.mockRestore();
    }
  }, 60_000);

  it('keeps a missing drafting executable nonfatal through real runInit', async () => {
    const commands = await import('../platform/commands.js');
    const find = vi.spyOn(commands, 'findExecutable').mockReturnValue(null);
    const spawn = vi.spyOn(commands, 'spawnArgv');
    try {
      const result = await initMod.runInit(baseArgs({
        draftTopics: true, llm: 'none', embeddings: 'none', yes: true,
        sharedSkillsVerification: 'deferred',
      }));
      expect(result.verification.ok).toBe(true);
      expect(result.summary.join('\n')).toContain('topic drafts: SKIPPED (claude executable unavailable)');
      expect(spawn).not.toHaveBeenCalled();
    } finally {
      spawn.mockRestore();
      find.mockRestore();
    }
  }, 60_000);
});

describe('upgradeHooksObject / mergeMcpJson preservation', () => {
  it('replaces stale mai hooks wholesale and keeps foreign hooks', async () => {
    const settings = {
      hooks: {
        SessionEnd: [
          { hooks: [{ type: 'command', command: 'OLD=1 bash /old/mai-mcp/hooks/session-end-ingest.sh' }] },
          { hooks: [{ type: 'command', command: 'bash /theirs/other-tool.sh' }] },
          { hooks: [
            { type: 'command', command: 'bash /theirs/mixed.sh' },
            { type: 'command', command: 'bash /old/mai-mcp/hooks/session-end-ingest.sh' },
          ] },
        ],
        PostToolUse: [{ hooks: [{ type: 'command', command: 'bash /theirs/lint.sh' }] }],
      },
    };
    const out = initMod.upgradeHooksObject(settings, 'demo') as typeof settings & {
      hooks: Record<string, Array<{ hooks: Array<{ command: string }> }>>;
    };
    const sessionEnd = out.hooks.SessionEnd;
    const { readManagedHookCommand } = await import('../hook-wiring.js');
    expect(sessionEnd.some((e) => e.hooks[0].command.includes('other-tool.sh'))).toBe(true);
    expect(sessionEnd.some((e) => e.hooks.some(h => h.command.includes('mixed.sh')))).toBe(true);
    expect(sessionEnd.some((e) => e.hooks[0].command.includes('/old/') && e.hooks.length === 1)).toBe(false);
    expect(sessionEnd.some((e) => {
      const command = readManagedHookCommand(e.hooks[0].command);
      return command?.mode === 'session-end' && command.project === 'demo' && !command.legacy;
    })).toBe(true);
    expect(out.hooks.PostToolUse).toHaveLength(1);
    expect(out.hooks.SessionStart).toHaveLength(1);
    expect(out.hooks.Stop).toHaveLength(1);
  });

  it('mergeMcpJson preserves a personalized MAI_AGENT_ID and honors an explicit override', async () => {
    const dir = makeRepo();
    fs.writeFileSync(
      path.join(dir, '.mcp.json'),
      JSON.stringify({ mcpServers: { 'mai-mcp': { command: 'node', args: ['/x'], env: { MAI_PROJECT_SLUG: 'demo', MAI_PROJECT_ROOT: dir, MAI_AGENT_ID: 'fable@claude-code' } } } }),
      'utf8'
    );
    await initMod.mergeMcpJson(dir, 'demo');
    let parsed = JSON.parse(fs.readFileSync(path.join(dir, '.mcp.json'), 'utf8'));
    expect(parsed.mcpServers['mai-mcp'].env.MAI_AGENT_ID).toBe('fable@claude-code');
    await initMod.mergeMcpJson(dir, 'demo', { agentId: 'sol@codex' });
    parsed = JSON.parse(fs.readFileSync(path.join(dir, '.mcp.json'), 'utf8'));
    expect(parsed.mcpServers['mai-mcp'].env.MAI_AGENT_ID).toBe('sol@codex');
  });
});

describe('validateRulesFileName', () => {
  it.each(['AGENTS.md', '.cursorrules', 'GEMINI.md', 'tool.rules'])('accepts %s', (name) => {
    expect(initMod.validateRulesFileName(name)).toBe(name);
  });

  it.each([
    '', ' padded.md ', '.', '..', '../escaped.md', 'nested/rules.md', 'nested\\rules.md',
    '/abs/rules.md', 'C:\\rules.md', 'nul\0.md',
    '.mcp.json', '.claude', '.codex', '.agents', 'CLAUDE.md', 'claude.MD',
    '.MCP.json', '.Claude', '.CODEX', '.Agents',
    'agents.md', 'AGENTS.MD',
    'package.json', 'config.toml', 'script.ts',
  ])('rejects %j', (name) => {
    expect(() => initMod.validateRulesFileName(name)).toThrow(/invalid rules-file name/);
  });
});

describe('buildDestinationWriterMap', () => {
  const claim = (repoRoot: string, relativePath: string, writerId: string, collisionOnly?: boolean) =>
    ({ repoRoot, relativePath, writerId, collisionOnly });

  it('rejects equal-path incompatible writers in both orders and case-folded aliases', () => {
    const repo = makeRepo();
    const a = claim(repo, 'CLAUDE.md', 'claude-rules');
    const b = claim(repo, 'CLAUDE.md', 'generic-rules');
    expect(() => initMod.buildDestinationWriterMap([a, b])).toThrow(/incompatible writers/);
    expect(() => initMod.buildDestinationWriterMap([b, a])).toThrow(/incompatible writers/);
    const folded = claim(repo, 'claude.MD', 'generic-rules');
    expect(() => initMod.buildDestinationWriterMap([a, folded])).toThrow(/incompatible writers/);
  });

  it('rejects file/ancestor prefix collisions in both orders', () => {
    const repo = makeRepo();
    const file = claim(repo, '.agents', 'generic-rules');
    const tree = claim(repo, '.agents/skills', 'skills-tree', true);
    expect(() => initMod.buildDestinationWriterMap([file, tree])).toThrow(/prefix collision/);
    expect(() => initMod.buildDestinationWriterMap([tree, file])).toThrow(/prefix collision/);
  });

  it('accepts the compatible same-writer AGENTS alias and cross-repo same paths', () => {
    const repoA = makeRepo();
    const repoB = makeRepo();
    const map = initMod.buildDestinationWriterMap([
      claim(repoA, 'AGENTS.md', 'agents-rules'),
      claim(repoA, 'AGENTS.md', 'agents-rules'),
      claim(repoB, 'AGENTS.md', 'agents-rules'),
      claim(repoA, '.agents/skills', 'skills-tree', true),
    ]);
    expect(map.size).toBe(3);
  });
});

// ------------------------------------------------------- full-run init layer

describe('runInit multi-harness', () => {
  it('passes its real final Codex verification in a punctuated physical path', async () => {
    const repo = fs.mkdtempSync(path.join(tmp, "repo spaces & quote'-"));
    const result = await initMod.runInit(baseArgs({
      root: repo, repos: [repo], harnesses: ['codex'], llm: 'none', embeddings: 'none', yes: true,
      sharedSkillsVerification: 'deferred',
    }));
    expect(result.verification.ok).toBe(true);
    expect(result.verification.repos[0].checks.find((check) => check.name === '.codex/config.toml')?.ok).toBe(true);
  }, 60_000);

  it('throws when the real final verifier observes a managed Codex root corrupted after projection', async () => {
    const repo = makeRepo();
    const theSlug = slug();
    const verify = await import('../scripts/verify.js');
    const realVerify = verify.verifyProject;
    const spy = vi.spyOn(verify, 'verifyProject').mockImplementation(async (...args) => {
      const config = path.join(repo, '.codex', 'config.toml');
      const raw = fs.readFileSync(config, 'utf8');
      fs.writeFileSync(config, raw.replace(/^MAI_PROJECT_ROOT\s*=.*$/m, 'MAI_PROJECT_ROOT = "/wrong/root"'));
      return realVerify(...args);
    });
    try {
      await expect(initMod.runInit(baseArgs({
        slug: theSlug, root: repo, repos: [repo], harnesses: ['codex'], llm: 'none', embeddings: 'none', yes: true,
        sharedSkillsVerification: 'deferred',
      }))).rejects.toThrow(/post-init verification FAILED/);
      const report = await realVerify(theSlug, { sharedSkills: 'deferred' });
      expect(report.repos[0].checks.find((check) => check.name === '.codex/config.toml')?.ok).toBe(false);
    } finally {
      spy.mockRestore();
    }
  }, 60_000);

  it('dual install wires claude + codex in one run and persists the union', async () => {
    const a = baseArgs({ harnesses: ['claude-code', 'codex'] });
    const result = await initMod.runInit(a);
    expect(result.harnesses).toEqual(['claude-code', 'codex']);
    for (const file of ['.mcp.json', path.join('.claude', 'settings.json'), 'CLAUDE.md', path.join('.codex', 'config.toml'), 'AGENTS.md']) {
      expect(fs.existsSync(path.join(a.root, file))).toBe(true);
    }
    const meta = await metadataOf(a.slug);
    expect(meta?.capture_harnesses).toEqual(['claude-code', 'codex']);
    expect(result.verification.ok).toBe(true);
  });

  it('deduplicates repeated harnesses and defaults to claude-code', async () => {
    expect(initMod.normalizeHarnesses(['claude-code', 'claude-code'])).toEqual(['claude-code']);
    expect(initMod.normalizeHarnesses(undefined)).toEqual(['claude-code']);
    expect(initMod.normalizeHarnesses([])).toEqual(['claude-code']);
  });

  it('fails fast on an unknown second harness with zero writes', async () => {
    const a = baseArgs({ harnesses: ['claude-code', 'wat'] });
    await expect(initMod.runInit(a)).rejects.toThrow(/Unknown harness 'wat'/);
    expect(fs.readdirSync(a.root)).toEqual([]);
    expect(await metadataOf(a.slug)).toBeNull();
  });

  it('generic-only with .cursorrules validates, installs, and persists the basename', async () => {
    const a = baseArgs({ harnesses: ['generic'], rulesFile: '.cursorrules' });
    const result = await initMod.runInit(a);
    const rules = fs.readFileSync(path.join(a.root, '.cursorrules'), 'utf8');
    expect(rules).toContain('MEMORY BRAIN (mai-mcp)');
    const meta = await metadataOf(a.slug);
    expect(meta?.capture_harnesses).toEqual(['generic']);
    expect(meta?.generic_rules_file).toBe('.cursorrules');
    expect(result.verification.ok).toBe(true);
  });

  it('rejects --rules-file outside a generic-only harness list', async () => {
    const a = baseArgs({ harnesses: ['claude-code', 'generic'], rulesFile: '.cursorrules' });
    await expect(initMod.runInit(a)).rejects.toThrow(/exactly \['generic'\]/);
    expect(fs.readdirSync(a.root)).toEqual([]);
  });

  it.each(['.mcp.json', 'CLAUDE.md', 'claude.MD', '.claude', '.codex', '.agents', 'package.json', 'config.toml', 'script.ts'])(
    'full run rejects generic rules-file %j at the validator with zero writes',
    async (name) => {
      const a = baseArgs({ harnesses: ['generic'], rulesFile: name });
      await expect(initMod.runInit(a)).rejects.toThrow(/invalid rules-file name/);
      expect(fs.readdirSync(a.root)).toEqual([]);
      expect(await metadataOf(a.slug)).toBeNull();
    }
  );

  it('is byte-idempotent on a second identical run (files and consent env)', async () => {
    const a = baseArgs({ harnesses: ['claude-code', 'codex'] });
    await initMod.runInit(a);
    fs.writeFileSync(`${a.consentEnvFile}.probe`, 'x'); // ensure temp area writable
    const filesBefore = treeBytes(a.root);
    const consentBefore = fs.existsSync(a.consentEnvFile ?? '') ? fs.readFileSync(a.consentEnvFile ?? '', 'utf8') : null;
    await initMod.runInit(a);
    expect(treeBytes(a.root)).toEqual(filesBefore);
    const consentAfter = fs.existsSync(a.consentEnvFile ?? '') ? fs.readFileSync(a.consentEnvFile ?? '', 'utf8') : null;
    expect(consentAfter).toEqual(consentBefore);
  });

  it('two-run expansion covers the full cross-product before writing and verifies fresh', async () => {
    const repoA = makeRepo();
    const repoB = makeRepo();
    const theSlug = slug();
    await initMod.runInit(baseArgs({ slug: theSlug, root: repoA, harnesses: ['claude-code'] }));

    const recorded: Array<ReadonlyArray<import('../scripts/init.js').DestinationClaim>> = [];
    const preWriteSnapshotB = treeBytes(repoB);
    const recordingBuilder: import('../scripts/init.js').DestinationMapBuilder = (claims) => {
      recorded.push([...claims]);
      // Nothing may have been written before the builder ran.
      expect(treeBytes(repoB)).toEqual(preWriteSnapshotB);
      return initMod.buildDestinationWriterMap(claims);
    };
    await initMod.runInit(
      baseArgs({ slug: theSlug, root: repoB, harnesses: ['codex'], destinationMapBuilder: recordingBuilder })
    );

    expect(recorded).toHaveLength(1);
    const cells = new Set(recorded[0].filter((c) => c.collisionOnly !== true).map((c) => `${c.repoRoot}:${c.writerId}`));
    const physicalRepos = [repoA, repoB].map((repo) => fs.realpathSync.native(repo));
    for (const repo of physicalRepos) {
      expect(cells.has(`${repo}:claude-mcp-json`)).toBe(true);
      expect(cells.has(`${repo}:codex-config-toml`)).toBe(true);
    }
    // Both repos carry BOTH harness wirings afterwards.
    for (const repo of [repoA, repoB]) {
      expect(fs.existsSync(path.join(repo, '.mcp.json'))).toBe(true);
      expect(fs.existsSync(path.join(repo, '.codex', 'config.toml'))).toBe(true);
      expect(fs.existsSync(path.join(repo, 'AGENTS.md'))).toBe(true);
    }
    const meta = await metadataOf(theSlug);
    expect(meta?.repos).toEqual(physicalRepos.sort());
    expect(meta?.capture_harnesses).toEqual(['claude-code', 'codex']);

    const { verifyProject } = await import('../scripts/verify.js');
    const sameProcess = await verifyProject(theSlug);
    expect(sameProcess.ok).toBe(true);
    // Fresh process through the real built CLI (guarded module execution).
    const fresh = await run(process.execPath, [path.join(REPO_ROOT, 'build', 'cli.js'), 'verify', theSlug], {
      env: {
        PATH: realPath,
        MAI_DB_URL: TEST_DB,
        HOME: HOME_DIR,
        CODEX_HOME: process.env.CODEX_HOME ?? '',
        MAI_BRAIN_ROOT: BRAIN,
      },
      timeout: 60_000,
    });
    expect(fresh.stdout + fresh.stderr).toContain('PASS');
  }, 60_000);

  it('generic expansion installs the persisted basename in both repos, then replaces it deliberately', async () => {
    const repoA = makeRepo();
    const repoB = makeRepo();
    const theSlug = slug();
    await initMod.runInit(baseArgs({ slug: theSlug, root: repoA, harnesses: ['claude-code'] }));
    await initMod.runInit(baseArgs({ slug: theSlug, root: repoB, harnesses: ['generic'], rulesFile: '.cursorrules' }));
    for (const repo of [repoA, repoB]) {
      expect(fs.readFileSync(path.join(repo, '.cursorrules'), 'utf8')).toContain('MEMORY BRAIN');
    }
    expect((await metadataOf(theSlug))?.generic_rules_file).toBe('.cursorrules');

    await initMod.runInit(baseArgs({ slug: theSlug, root: repoA, harnesses: ['generic'], rulesFile: 'tool.rules' }));
    expect((await metadataOf(theSlug))?.generic_rules_file).toBe('tool.rules');
    for (const repo of [repoA, repoB]) {
      expect(fs.readFileSync(path.join(repo, 'tool.rules'), 'utf8')).toContain('MEMORY BRAIN');
    }
    const { verifyProject } = await import('../scripts/verify.js');
    expect((await verifyProject(theSlug)).ok).toBe(true);
  }, 60_000);

  it('preflight order: a later symlinked destination rejects before any earlier parent is created', async () => {
    const a = baseArgs({ harnesses: ['claude-code', 'codex'] });
    const victim = fs.mkdtempSync(path.join(tmp, 'victim-'));
    fs.writeFileSync(path.join(victim, 'sentinel'), 'untouched\n');
    fs.symlinkSync(victim, path.join(a.root, '.codex'));
    const rootBefore = treeBytes(a.root);
    const victimBefore = treeBytes(victim);

    await expect(initMod.runInit(a)).rejects.toThrow(/symlink/);
    expect(fs.existsSync(path.join(a.root, '.claude'))).toBe(false);
    expect(treeBytes(a.root)).toEqual(rootBefore);
    expect(treeBytes(victim)).toEqual(victimBefore);
    expect(await metadataOf(a.slug)).toBeNull();
  });

  it.each(['.mcp.json', 'CLAUDE.md', path.join('.claude', 'settings.json'), path.join('.codex', 'config.toml'), 'AGENTS.md'])(
    'fixed target %s as an outside symlink rejects with byte-identical repos and no metadata',
    async (target) => {
      const a = baseArgs({ harnesses: ['claude-code', 'codex'] });
      const victim = fs.mkdtempSync(path.join(tmp, 'victim-'));
      const victimFile = path.join(victim, 'victim-target');
      fs.writeFileSync(victimFile, 'victim untouched\n');
      fs.mkdirSync(path.dirname(path.join(a.root, target)), { recursive: true });
      fs.symlinkSync(victimFile, path.join(a.root, target));
      const rootBefore = treeBytes(a.root);
      const victimBefore = treeBytes(victim);

      await expect(initMod.runInit(a)).rejects.toThrow(/symlink/);
      expect(treeBytes(a.root)).toEqual(rootBefore);
      expect(treeBytes(victim)).toEqual(victimBefore);
      expect(await metadataOf(a.slug)).toBeNull();
    }
  );

  it('a forced destination-map rejection propagates exactly, leaving everything byte-identical', async () => {
    const a = baseArgs({ harnesses: ['generic'], rulesFile: '.cursorrules' });
    let sawClaims = 0;
    const forced: import('../scripts/init.js').DestinationMapBuilder = (claims) => {
      sawClaims = claims.length;
      throw new Error('forced destination-map rejection');
    };
    const before = treeBytes(a.root);
    await expect(initMod.runInit(baseArgs({ ...a, destinationMapBuilder: forced, slug: a.slug, root: a.root }))).rejects.toThrow(
      'forced destination-map rejection'
    );
    expect(sawClaims).toBeGreaterThan(0);
    expect(treeBytes(a.root)).toEqual(before);
    expect(await metadataOf(a.slug)).toBeNull();
  });

  it('codex↔generic AGENTS.md sharing is byte-idempotent in either adapter order', async () => {
    const { getCaptureAdapter } = await import('../capture/adapter.js');
    const codex = getCaptureAdapter('codex');
    const generic = getCaptureAdapter('generic', { rulesFile: 'AGENTS.md' });

    const repoA = makeRepo();
    await codex.install(repoA, 'order-a');
    await generic.install(repoA, 'order-a');
    const repoB = makeRepo();
    await generic.install(repoB, 'order-b');
    await codex.install(repoB, 'order-b');

    const agentsA = fs.readFileSync(path.join(repoA, 'AGENTS.md'), 'utf8');
    const agentsB = fs.readFileSync(path.join(repoB, 'AGENTS.md'), 'utf8');
    expect(agentsA).toBe(agentsB);
    expect(agentsA.split('MEMORY BRAIN (mai-mcp)').length - 1).toBe(1);
    expect(agentsA.split('GRADUATED RULES (mai-mcp)').length - 1).toBe(1);
  });
});

// ------------------------------------------------------ physical-root repair

describe('authoritative physical-root repair', () => {
  async function seedBrokenProject(input: {
    slugName: string;
    productRoot: string;
    repos: string[];
    excludes?: string[];
    evidence?: string[];
  }): Promise<string> {
    const row = await admin.query<{ id: string }>(
      `INSERT INTO projects (slug, name, path, metadata)
       VALUES ($1, $1, $2,
         jsonb_build_object(
           'repos', $3::jsonb,
           'graph_excludes', $4::jsonb,
           'capture_harnesses', '["generic"]'::jsonb,
           'generic_rules_file', '"AGENTS.md"'::jsonb,
           'kept_key', '"survives"'::jsonb
         )) RETURNING id`,
      [input.slugName, input.productRoot, JSON.stringify(input.repos), JSON.stringify(input.excludes ?? [])],
    );
    for (const [index, repoPath] of (input.evidence ?? []).entries()) {
      await admin.query(
        `INSERT INTO code_commits
           (project_id, commit_hash, message, timestamp, committed_at, repo_path)
         VALUES ($1, $2, 'repair fixture', now(), now(), $3)`,
        [row.rows[0].id, `${'e'.repeat(36)}${String(n++).padStart(4, '0')}`, repoPath],
      );
    }
    return row.rows[0].id;
  }

  async function repairState(projectId: string): Promise<{
    path: string | null;
    metadata: Record<string, unknown> | null;
    evidence: string[];
  }> {
    const project = await admin.query<{ path: string | null; metadata: Record<string, unknown> | null }>(
      `SELECT path, metadata FROM projects WHERE id = $1`, [projectId],
    );
    const evidence = await admin.query<{ repo_path: string }>(
      `SELECT repo_path FROM code_commits WHERE project_id = $1 ORDER BY repo_path`, [projectId],
    );
    return { ...project.rows[0], evidence: evidence.rows.map((row) => row.repo_path) };
  }

  it('fails closed on ordinary re-init when stored metadata or evidence is relative', async () => {
    const product = makeRepo();
    const replacement = makeRepo();
    const slugName = slug();
    const projectId = await seedBrokenProject({
      slugName, productRoot: product, repos: ['legacy-relative'], evidence: ['legacy-relative'],
    });
    const before = await repairState(projectId);
    const replacementBefore = treeBytes(replacement);
    await expect(initMod.runInit(baseArgs({
      slug: slugName, root: product, repos: [replacement], harnesses: ['generic'],
    }))).rejects.toThrow(/--replace-repos --repo <absolute-repo> --repo-map 'legacy-relative'/);
    expect(await repairState(projectId)).toEqual(before);
    expect(treeBytes(replacement)).toEqual(replacementBefore);
  });

  it('repairs relative and missing metadata/evidence spellings atomically, preserving unrelated metadata', async () => {
    const product = makeRepo();
    const replacement = makeRepo();
    const missing = path.join(tmp, `missing-${n++}`);
    const relativeRepo = `legacy-repo-${n++}`;
    const relativeExclude = `legacy-exclude-${n++}`;
    const slugName = slug();
    const projectId = await seedBrokenProject({
      slugName,
      productRoot: product,
      repos: [relativeRepo, missing],
      excludes: [relativeExclude],
      evidence: [relativeRepo, missing],
    });
    await initMod.runInit(baseArgs({
      slug: slugName,
      root: product,
      repos: [replacement, path.join(replacement, '.')],
      replaceRepos: true,
      repoMaps: [
        { storedRoot: relativeRepo, targetRoot: replacement },
        { storedRoot: missing, targetRoot: replacement },
        { storedRoot: relativeExclude, targetRoot: replacement },
      ],
      harnesses: ['generic'],
    }));
    const physicalProduct = fs.realpathSync.native(product);
    const physicalRepo = fs.realpathSync.native(replacement);
    const state = await repairState(projectId);
    expect(state.path).toBe(physicalProduct);
    expect(state.metadata?.repos).toEqual([physicalRepo]);
    expect(state.metadata?.graph_excludes).toEqual([physicalRepo]);
    expect(state.metadata?.kept_key).toBe('survives');
    expect(state.evidence).toEqual([physicalRepo, physicalRepo]);
    expect(JSON.stringify(state)).not.toContain(relativeRepo);
    expect(JSON.stringify(state)).not.toContain(missing);
  }, 60_000);

  it('rejects incomplete, duplicate, and unknown repair maps before mutation', async () => {
    const product = makeRepo();
    const replacement = makeRepo();
    const slugName = slug();
    const projectId = await seedBrokenProject({
      slugName, productRoot: product, repos: ['legacy-one'], evidence: ['legacy-one'],
    });
    const before = await repairState(projectId);
    const common: BaseArgsOverrides = {
      slug: slugName, root: product, repos: [replacement], replaceRepos: true,
      harnesses: ['generic'],
    };
    await expect(initMod.runInit(baseArgs(common))).rejects.toThrow(/Cannot canonicalize stored path 'legacy-one'/);
    await expect(initMod.runInit(baseArgs({
      ...common,
      repoMaps: [
        { storedRoot: 'legacy-one', targetRoot: replacement },
        { storedRoot: 'legacy-one', targetRoot: replacement },
      ],
    }))).rejects.toThrow('Duplicate --repo-map source');
    await expect(initMod.runInit(baseArgs({
      ...common,
      repoMaps: [
        { storedRoot: 'legacy-one', targetRoot: replacement },
        { storedRoot: 'not-stored', targetRoot: replacement },
      ],
    }))).rejects.toThrow('--repo-map source is not a stored path');
    expect(await repairState(projectId)).toEqual(before);
    expect(treeBytes(replacement)).toEqual(new Map());
  });

  it('leaves DB rows and projection files byte-identical when wiring preflight rejects', async () => {
    const product = makeRepo();
    const oldRepo = makeRepo();
    const replacement = makeRepo();
    const slugName = slug();
    const projectId = await seedBrokenProject({ slugName, productRoot: product, repos: [oldRepo] });
    const before = await repairState(projectId);
    const filesBefore = treeBytes(replacement);
    const forced: import('../scripts/init.js').DestinationMapBuilder = () => {
      throw new Error('repair preflight sentinel');
    };
    await expect(initMod.runInit(baseArgs({
      slug: slugName,
      root: product,
      repos: [replacement],
      replaceRepos: true,
      harnesses: ['generic'],
      destinationMapBuilder: forced,
    }))).rejects.toThrow('repair preflight sentinel');
    expect(await repairState(projectId)).toEqual(before);
    expect(treeBytes(replacement)).toEqual(filesBefore);
  });
});

// ----------------------------------------------------------- legacy seeding

describe('legacy expectation seeding', () => {
  async function insertLegacyRow(slugName: string, repo: string): Promise<void> {
    await admin.query(
      `INSERT INTO projects (slug, name, path, metadata) VALUES ($1, $1, $2, jsonb_build_object('repos', $3::jsonb, 'kept_key', '"survives"'::jsonb))`,
      [slugName, repo, JSON.stringify([repo])]
    );
  }

  it('first re-init of a legacy repo with managed codex wiring persists claude AND codex', async () => {
    const repo = makeRepo();
    const theSlug = slug();
    const { buildCodexInitialConfig } = await import('../capture/codex.js');
    fs.mkdirSync(path.join(repo, '.codex'), { recursive: true });
    fs.writeFileSync(path.join(repo, '.codex', 'config.toml'), buildCodexInitialConfig(repo, theSlug, 'sol@codex'));
    await insertLegacyRow(theSlug, repo);

    await initMod.runInit(baseArgs({ slug: theSlug, root: repo, harnesses: ['claude-code'] }));
    const meta = await metadataOf(theSlug);
    expect(meta?.capture_harnesses).toEqual(['claude-code', 'codex']);
    expect(meta?.kept_key).toBe('survives'); // unrelated metadata preserved
  });

  it('legacy AGENTS.md brain marker without codex config seeds generic/AGENTS.md; deleting it then fails verify', async () => {
    const repo = makeRepo();
    const theSlug = slug();
    fs.writeFileSync(path.join(repo, 'AGENTS.md'), '# repo\n\n## MEMORY BRAIN (mai-mcp)\n\nlegacy pasted block\n');
    await insertLegacyRow(theSlug, repo);

    await initMod.runInit(baseArgs({ slug: theSlug, root: repo, harnesses: ['claude-code'] }));
    const meta = await metadataOf(theSlug);
    expect(meta?.capture_harnesses).toEqual(['claude-code', 'generic']);
    expect(meta?.generic_rules_file).toBe('AGENTS.md');

    fs.rmSync(path.join(repo, 'AGENTS.md'));
    const { verifyProject } = await import('../scripts/verify.js');
    const v = await verifyProject(theSlug);
    expect(v.ok).toBe(false);
    expect(v.repos[0].checks.find((c) => c.name === 'AGENTS.md')?.ok).toBe(false);
  });

  it('malformed stored capture_harnesses fails init before any write', async () => {
    const repo = makeRepo();
    const theSlug = slug();
    await admin.query(
      `INSERT INTO projects (slug, name, path, metadata) VALUES ($1, $1, $2, jsonb_build_object('repos', $3::jsonb, 'capture_harnesses', '"nope"'::jsonb))`,
      [theSlug, repo, JSON.stringify([repo])]
    );
    await expect(initMod.runInit(baseArgs({ slug: theSlug, root: repo }))).rejects.toThrow(/capture_harnesses is malformed/);
    expect(fs.readdirSync(repo)).toEqual([]);
  });
});

// ------------------------------------------------------------ consent matrix

describe('--yes consent matrix (fixture binaries, injected env file)', () => {
  it('exactly one CLI (claude) → enabled automatically; second run is byte-identical', async () => {
    await setBinaries('claude-only');
    const envFile = consentFile();
    const a = baseArgs({ yes: true, consentEnvFile: envFile });
    const result = await initMod.runInit(a);
    expect(result.summary.join('\n')).toContain('llm: claude-code (subscription) enabled automatically');
    const bytes = fs.readFileSync(envFile, 'utf8');
    expect(bytes).toContain('MAI_LLM_SUMMARY=1');
    expect(bytes).toContain('MAI_LLM_PROVIDER=claude-code');

    await setBinaries('claude-only');
    await initMod.runInit(baseArgs({ slug: a.slug, root: a.root, yes: true, consentEnvFile: envFile }));
    expect(fs.readFileSync(envFile, 'utf8')).toBe(bytes);
  }, 60_000);

  it('exactly one CLI (codex) → codex-cli enabled automatically', async () => {
    await setBinaries('codex-only');
    const envFile = consentFile();
    const result = await initMod.runInit(baseArgs({ yes: true, consentEnvFile: envFile }));
    expect(result.summary.join('\n')).toContain('llm: codex-cli (subscription) enabled automatically');
  }, 60_000);

  it('no CLI detected → no prompt, nothing written', async () => {
    await setBinaries('none');
    const envFile = consentFile();
    const result = await initMod.runInit(baseArgs({ yes: true, consentEnvFile: envFile }));
    expect(result.summary.join('\n')).not.toContain('enabled');
    expect(fs.existsSync(envFile)).toBe(false);
  }, 60_000);

  it('both CLIs → hints only, provider undefined, never mapped to none, zero bytes', async () => {
    await setBinaries('both');
    const envFile = consentFile();
    const result = await initMod.runInit(baseArgs({ yes: true, consentEnvFile: envFile }));
    const text = result.summary.join('\n');
    expect(text).toContain('llm: hint printed');
    expect(text).not.toContain('skipped (--llm none)');
    expect(fs.existsSync(envFile)).toBe(false);
  }, 60_000);

  it('automatic run preserves a different file-configured provider byte-for-byte', async () => {
    await setBinaries('claude-only');
    const envFile = consentFile();
    fs.writeFileSync(envFile, 'MAI_LLM_SUMMARY=1\nMAI_LLM_PROVIDER=codex-cli\n');
    const before = fs.readFileSync(envFile, 'utf8');
    const result = await initMod.runInit(baseArgs({ yes: true, consentEnvFile: envFile }));
    expect(result.summary.join('\n')).toContain('preserved configured provider');
    expect(fs.readFileSync(envFile, 'utf8')).toBe(before);
  }, 60_000);

  it('explicit --llm switches a different FILE-configured provider once, then reruns byte-identical', async () => {
    await setBinaries('both');
    const envFile = consentFile();
    fs.writeFileSync(envFile, 'MAI_LLM_SUMMARY=1\nMAI_LLM_PROVIDER=codex-cli\n');
    const a = baseArgs({ llm: 'claude-code', consentEnvFile: envFile });
    const result = await initMod.runInit(a);
    expect(result.summary.join('\n')).toContain('claude-code (subscription) enabled via --llm flag');
    const bytes = fs.readFileSync(envFile, 'utf8');
    expect(bytes.trim().split('\n').pop()).toBe('MAI_LLM_PROVIDER=claude-code');

    await setBinaries('both');
    await initMod.runInit(baseArgs({ slug: a.slug, root: a.root, llm: 'claude-code', consentEnvFile: envFile }));
    expect(fs.readFileSync(envFile, 'utf8')).toBe(bytes);
  }, 60_000);

  it('an inherited conflicting provider makes an explicit switch throw the typed conflict with zero writes', async () => {
    await setBinaries('both');
    const envFile = consentFile();
    fs.writeFileSync(envFile, 'MAI_LLM_SUMMARY=1\nMAI_LLM_PROVIDER=codex-cli\n');
    const before = fs.readFileSync(envFile, 'utf8');
    const { LlmAuthorityConflictError } = await import('../scripts/llm-consent.js');
    const a = baseArgs({
      llm: 'claude-code',
      consentEnvFile: envFile,
      preFileLlmAuthority: { provider: 'codex-cli' },
    });
    await expect(initMod.runInit(a)).rejects.toThrow(LlmAuthorityConflictError);
    await expect(
      initMod.runInit(baseArgs({ ...a, slug: a.slug, root: a.root }))
    ).rejects.toThrow(/MAI_LLM_PROVIDER/);
    expect(fs.readFileSync(envFile, 'utf8')).toBe(before);
  }, 60_000);

  it('an inherited MAI_LLM_SUMMARY=0 defeats an explicit switch the same way; matching values pass', async () => {
    await setBinaries('both');
    const envFile = consentFile();
    fs.writeFileSync(envFile, 'MAI_LLM_SUMMARY=1\nMAI_LLM_PROVIDER=codex-cli\n');
    const before = fs.readFileSync(envFile, 'utf8');
    const { LlmAuthorityConflictError } = await import('../scripts/llm-consent.js');
    await expect(
      initMod.runInit(
        baseArgs({ llm: 'claude-code', consentEnvFile: envFile, preFileLlmAuthority: { summary: '0' } })
      )
    ).rejects.toThrow(LlmAuthorityConflictError);
    expect(fs.readFileSync(envFile, 'utf8')).toBe(before);

    // Matching inherited values are compatible and idempotent.
    await setBinaries('both');
    const result = await initMod.runInit(
      baseArgs({ llm: 'claude-code', consentEnvFile: envFile, preFileLlmAuthority: { provider: 'claude-code', summary: '1' } })
    );
    expect(result.summary.join('\n')).toContain('enabled via --llm flag');
  }, 60_000);
});

describe('link-aware env regeneration (plan 31)', () => {
  it('an absent linked_projects key is AUTHORITATIVE EMPTY: real runInit scrubs a stale runtime grant from both harnesses', async () => {
    const initMod: InitModule = await import('../scripts/init.js');
    const repo = makeRepo();
    const projectSlug = slug();
    const args = baseArgs({
      slug: projectSlug, root: repo, repos: [repo],
      harnesses: ['claude-code', 'codex'],
      llm: 'none', embeddings: 'none', yes: true,
      sharedSkillsVerification: 'deferred',
    });

    // First init wires both harnesses for real.
    const first = await initMod.runInit(args);
    expect(first.verification.ok).toBe(true);

    // The project declares NO links (key absent, not []), but both managed
    // harness files carry a stale runtime grant — the exact drift a re-init
    // must heal. applyEnvChanges is the real producer, not a hand-written file.
    await admin.query(
      `UPDATE projects SET metadata = metadata - 'linked_projects' WHERE slug = $1`,
      [projectSlug]
    );
    const { applyEnvChanges } = await import('../scripts/link.js');
    const staled = await applyEnvChanges(repo, projectSlug, ['stale-src']);
    expect(staled.refusedLegacy).toBe(false);
    const mcpPath = path.join(repo, '.mcp.json');
    const tomlPath = path.join(repo, '.codex', 'config.toml');
    expect(fs.readFileSync(mcpPath, 'utf8')).toContain('"MAI_LINKED_PROJECTS": "stale-src"');
    expect(fs.readFileSync(tomlPath, 'utf8')).toContain('MAI_LINKED_PROJECTS = "stale-src"');

    // Re-init through the REAL runInit. An absent key is authoritative empty,
    // so the stale grant must be scrubbed and post-verify must still pass.
    const healed = await initMod.runInit(args);
    expect(healed.verification.ok).toBe(true);
    expect(fs.readFileSync(mcpPath, 'utf8')).not.toContain('MAI_LINKED_PROJECTS');
    expect(fs.readFileSync(tomlPath, 'utf8')).not.toContain('MAI_LINKED_PROJECTS');

    // …and re-init never WIDENS the declaration on its own.
    const meta = await metadataOf(projectSlug);
    expect(meta?.linked_projects).toBeUndefined();
  }, 120_000);
});
