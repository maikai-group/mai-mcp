/**
 * Codex adapter: streaming rollout parser, first-line meta reader, install
 * idempotency (repo config.toml + AGENTS.md + global notify via CODEX_HOME
 * override), detect. DB-free throughout.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { findManagedBlock, loadTemplate } from '../scripts/managed-block.js';

const FIXTURE = fileURLToPath(new URL('./fixtures/sample-rollout.jsonl', import.meta.url));

describe('parseCodexRollout', () => {
  it('maps a rollout onto the neutral ParsedSession', async () => {
    const { parseCodexRollout } = await import('../capture/codex.js');
    const parsed = await parseCodexRollout(FIXTURE);

    expect(parsed.harness).toBe('codex');
    expect(parsed.sessionId).toBe('11111111-2222-3333-4444-555555555555');
    expect(parsed.cwd).toBe('/tmp/mai-fixture-repo');
    expect(parsed.model).toBe('gpt-5.6-sol');
    expect(parsed.firstTs).toBe('2026-07-09T10:00:00.000Z');
    expect(parsed.lastTs).toBe('2026-07-09T10:00:13.000Z');

    // event_msg user+agent only — the developer response_item must NOT count.
    expect(parsed.messageCount).toBe(2);
    // 2 function_call + 1 custom_tool_call
    expect(parsed.toolCalls).toBe(3);
    // reasoning with a non-empty summary only
    expect(parsed.thinkingBlocks).toHaveLength(1);
    expect(parsed.thinkingBlocks[0].text).toContain('additive');
    // both exec_commands resolved to bash events with exit codes
    expect(parsed.bashEvents).toHaveLength(2);
    expect(parsed.bashEvents[0].command).toBe('npm test');
    expect(parsed.bashEvents[0].exitCode).toBe(0);
    // output mining: commit + vitest results
    expect(parsed.commits.some((c) => c.hash === 'abc1234')).toBe(true);
    expect(parsed.testRuns[0].testsPassing).toBe(10);
    // patch_apply_end → one write + one edit
    expect(parsed.filesWritten).toBe(1);
    expect(parsed.filesEdited).toBe(1);
    expect(parsed.fileEvents).toHaveLength(2);
    expect(parsed.fileEvents[0].action).toBe('write');
    expect(parsed.fileEvents[0].language).toBe('typescript');
    expect(parsed.fileEvents[1].action).toBe('edit');
    expect(parsed.fileEvents[1].language).toBe('python');
  });

  it('skips oversized lines but keeps parsing', async () => {
    const { parseCodexRollout } = await import('../capture/codex.js');
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'mai-rollout-'));
    const file = path.join(tmp, 'rollout-guard.jsonl');
    const fixture = fs.readFileSync(FIXTURE, 'utf8').trimEnd().split('\n');
    // splice an oversized junk line between meta and the rest
    const huge = JSON.stringify({ type: 'event_msg', payload: { type: 'user_message', message: 'x'.repeat(500) } });
    fs.writeFileSync(file, [fixture[0], huge, ...fixture.slice(1)].join('\n') + '\n', 'utf8');

    const parsed = await parseCodexRollout(file, { maxLineLength: 300 });
    // the huge user_message was skipped → still 2, not 3
    expect(parsed.messageCount).toBe(2);
    expect(parsed.sessionId).toBe('11111111-2222-3333-4444-555555555555');
    fs.rmSync(tmp, { recursive: true, force: true });
  });
});

describe('readRolloutMeta', () => {
  it('reads only the routing info from line 1', async () => {
    const { readRolloutMeta } = await import('../capture/codex.js');
    const meta = await readRolloutMeta(FIXTURE);
    expect(meta).toEqual({
      sessionId: '11111111-2222-3333-4444-555555555555',
      cwd: '/tmp/mai-fixture-repo',
    });
  });

  it('returns null for a non-rollout file', async () => {
    const { readRolloutMeta } = await import('../capture/codex.js');
    const claudeFixture = fileURLToPath(new URL('./fixtures/sample-session.jsonl', import.meta.url));
    expect(await readRolloutMeta(claudeFixture)).toBeNull();
  });
});

describe('CodexAdapter install/detect', () => {
  it('TOML-escapes dynamic paths and identities', async () => {
    const { buildCodexBlock, buildCodexNotifyLine } = await import('../capture/codex.js');
    const unusual = 'C:\\Users\\A "quoted"\\mai mcp';
    const block = buildCodexBlock('C:\\repo "one"', 'slug', 'agent"id', unusual);
    expect(block).toContain(`args = [${JSON.stringify(path.join(unusual, 'build', 'index.js'))}]`);
    expect(block).toContain(`MAI_PROJECT_ROOT = ${JSON.stringify('C:\\repo "one"')}`);
    expect(block).toContain(`MAI_AGENT_ID = ${JSON.stringify('agent"id')}`);
    expect(buildCodexNotifyLine(unusual)).toBe(
      `notify = ["node", ${JSON.stringify(path.join(unusual, 'build', 'scripts', 'hook-runner.js'))}, "codex-notify"]`,
    );
  });

  let repo: string;
  let fakeCodexHome: string;
  const prevCodexHome = process.env.CODEX_HOME;

  beforeEach(() => {
    repo = fs.mkdtempSync(path.join(os.tmpdir(), 'mai-codex-repo-'));
    fakeCodexHome = fs.mkdtempSync(path.join(os.tmpdir(), 'mai-codex-home-'));
    process.env.CODEX_HOME = fakeCodexHome;
  });
  afterEach(() => {
    if (prevCodexHome === undefined) delete process.env.CODEX_HOME;
    else process.env.CODEX_HOME = prevCodexHome;
    fs.rmSync(repo, { recursive: true, force: true });
    fs.rmSync(fakeCodexHome, { recursive: true, force: true });
  });

  it('wires repo config.toml + AGENTS.md + global notify, idempotently', async () => {
    const { getCaptureAdapter } = await import('../capture/adapter.js');
    const { GRADUATED_SENTINEL } = await import('../rules-render.js');
    const a = getCaptureAdapter('codex');

    const first = await a.install(repo, 'codex-test');
    expect(first.lines).toEqual([
      '.codex/config.toml created',
      'AGENTS.md created',
      'notify created',
      'AGENTS.md graduated-rules installed',
    ]);
    const cfg = fs.readFileSync(path.join(repo, '.codex', 'config.toml'), 'utf8');
    expect(cfg).toContain('[mcp_servers.mai-mcp]');
    expect(cfg).toContain('MAI_PROJECT_SLUG = "codex-test"');
    const sentinel = cfg.indexOf('# /mai-mcp-block v2');
    expect(cfg.indexOf('[mcp_servers.mai-mcp.tools.mai_git_context]')).toBeGreaterThan(sentinel);
    expect(cfg.indexOf('[mcp_servers.mai-mcp.tools.mai_search]')).toBeGreaterThan(sentinel);
    expect(cfg.match(/approval_mode = "approve"/g)).toHaveLength(2);
    const agentsMd = fs.readFileSync(path.join(repo, 'AGENTS.md'), 'utf8');
    expect(agentsMd).toContain('MEMORY BRAIN (mai-mcp)');
    expect(agentsMd).toContain(GRADUATED_SENTINEL);
    const { buildCodexNotifyLine } = await import('../hook-wiring.js');
    expect(fs.readFileSync(path.join(fakeCodexHome, 'config.toml'), 'utf8')).toContain(buildCodexNotifyLine());

    const second = await a.install(repo, 'codex-test');
    expect(second.lines).toEqual([
      '.codex/config.toml unchanged',
      'AGENTS.md unchanged',
      'notify unchanged',
      'AGENTS.md graduated-rules unchanged',
    ]);
  });

  it('migrates only an owned legacy global notify and preserves chain selection', async () => {
    const { getCaptureAdapter } = await import('../capture/adapter.js');
    const { buildCodexNotifyLine } = await import('../hook-wiring.js');
    const file = path.join(fakeCodexHome, 'config.toml');
    const a = getCaptureAdapter('codex');
    const tail = '\n[tui]\nnotifications = true\n';
    fs.writeFileSync(file, '# keep\nnotify = ["bash", "/old/hooks/codex-notify-chain.sh"]' + tail);
    await a.install(repo, 'codex-test');
    const expected = '# keep\n' + buildCodexNotifyLine(undefined, true) + tail;
    expect(fs.readFileSync(file, 'utf8')).toBe(expected);
    await a.install(repo, 'codex-test');
    expect(fs.readFileSync(file, 'utf8')).toBe(expected);
    const foreign = 'notify = ["foreign", "codex-notify-ingest.sh"]' + tail;
    fs.writeFileSync(file, foreign);
    await a.install(repo, 'codex-test');
    expect(fs.readFileSync(file, 'utf8')).toBe(foreign);
  });

  it('respects user removal of a safe-read override on a repeated install', async () => {
    const { getCaptureAdapter } = await import('../capture/adapter.js');
    const a = getCaptureAdapter('codex');
    await a.install(repo, 'codex-test');
    const file = path.join(repo, '.codex', 'config.toml');
    const configured = fs.readFileSync(file, 'utf8');
    const withoutSearch = configured.replace(
      /\n\[mcp_servers\.mai-mcp\.tools\.mai_search\]\napproval_mode = "approve"\n?/,
      '\n'
    );
    fs.writeFileSync(file, withoutSearch, 'utf8');

    const result = await a.install(repo, 'codex-test');
    expect(result.lines).toContain('.codex/config.toml unchanged');
    expect(fs.readFileSync(file, 'utf8')).not.toContain('tools.mai_search');
  });

  it('does not duplicate a user-authored policy table when appending mai wiring', async () => {
    const file = path.join(repo, '.codex', 'config.toml');
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(
      file,
      '[mcp_servers.mai-mcp.tools.mai_search]\napproval_mode = "prompt"\n',
      'utf8'
    );
    const { getCaptureAdapter } = await import('../capture/adapter.js');
    await getCaptureAdapter('codex').install(repo, 'codex-test');
    const configured = fs.readFileSync(file, 'utf8');
    expect(configured.match(/\[mcp_servers\.mai-mcp\.tools\.mai_search\]/g)).toHaveLength(1);
    expect(configured).toContain('approval_mode = "prompt"');
    expect(configured).toContain('[mcp_servers.mai-mcp.tools.mai_git_context]');
  });

  it('moves legacy in-block tool policy outside the sentinel without duplicating it', async () => {
    const { getCaptureAdapter } = await import('../capture/adapter.js');
    const { buildCodexBlock } = await import('../capture/codex.js');
    const file = path.join(repo, '.codex', 'config.toml');
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const policy = [
      '[mcp_servers.mai-mcp.tools.mai_git_context]',
      'approval_mode = "approve"',
      '',
      '[mcp_servers.mai-mcp.tools.mai_search]',
      'approval_mode = "approve"',
      '',
    ].join('\n');
    const legacyPlacement = buildCodexBlock(repo, 'codex-test', 'sol@codex')
      .replace('# /mai-mcp-block v2', `${policy}# /mai-mcp-block v2`);
    fs.writeFileSync(file, legacyPlacement, 'utf8');

    const changes = await getCaptureAdapter('codex').planUpgrade(repo, 'codex-test');
    expect(changes).toHaveLength(1);
    const next = changes[0].newContent;
    expect(next.match(/\[mcp_servers\.mai-mcp\.tools\.mai_git_context\]/g)).toHaveLength(1);
    expect(next.match(/\[mcp_servers\.mai-mcp\.tools\.mai_search\]/g)).toHaveLength(1);
    expect(next.indexOf('[mcp_servers.mai-mcp.tools.mai_git_context]'))
      .toBeGreaterThan(next.indexOf('# /mai-mcp-block v2'));
    expect(next.indexOf('[mcp_servers.mai-mcp.tools.mai_search]'))
      .toBeGreaterThan(next.indexOf('# /mai-mcp-block v2'));
    expect(changes[0].before).toContain('tools.mai_search');
    expect(changes[0].after).toContain('tools.mai_search');
  });

  it('places notify at TOML root when the config ends in a table (regression: EOF-append lands inside the table)', async () => {
    fs.writeFileSync(
      path.join(fakeCodexHome, 'config.toml'),
      'model = "gpt-5.6"\n\n[mcp_servers.other]\ncommand = "x"\n',
      'utf8'
    );
    const { getCaptureAdapter } = await import('../capture/adapter.js');
    const res = await getCaptureAdapter('codex').install(repo, 'codex-test');
    expect(res.lines).toContain('notify updated');
    const cfg = fs.readFileSync(path.join(fakeCodexHome, 'config.toml'), 'utf8');
    // notify must appear BEFORE the first [table] header to be a root key
    expect(cfg.indexOf('notify =')).toBeGreaterThanOrEqual(0);
    expect(cfg.indexOf('notify =')).toBeLessThan(cfg.indexOf('[mcp_servers.other]'));
    // existing content preserved
    expect(cfg).toContain('model = "gpt-5.6"');
    expect(cfg).toContain('command = "x"');
  });

  it('never clobbers a foreign notify setting', async () => {
    fs.writeFileSync(path.join(fakeCodexHome, 'config.toml'), 'notify = ["say", "done"]\n', 'utf8');
    const { getCaptureAdapter } = await import('../capture/adapter.js');
    const res = await getCaptureAdapter('codex').install(repo, 'codex-test');
    expect(res.lines).toContain('notify skipped (existing notify)');
    expect(fs.readFileSync(path.join(fakeCodexHome, 'config.toml'), 'utf8')).toContain('"say"');
  });

  it('detect: installed after install, not installed on a bare repo', async () => {
    const { getCaptureAdapter } = await import('../capture/adapter.js');
    const a = getCaptureAdapter('codex');
    expect((await a.detect(repo)).installed).toBe(false);
    await a.install(repo, 'codex-test');
    const status = await a.detect(repo);
    expect(status.installed).toBe(true);
    expect(status.present).toBe(true);
  });
});

describe('GenericAdapter', () => {
  it('installs the brain block into AGENTS.md by default, custom file when configured', async () => {
    const { getCaptureAdapter } = await import('../capture/adapter.js');
    const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'mai-generic-repo-'));

    const res = await getCaptureAdapter('generic').install(repo, 'generic-test');
    expect(res.lines[0]).toBe('AGENTS.md created');
    expect(fs.readFileSync(path.join(repo, 'AGENTS.md'), 'utf8')).toContain('MEMORY BRAIN (mai-mcp)');

    const custom = await getCaptureAdapter('generic', { rulesFile: '.cursorrules' }).install(repo, 'generic-test');
    expect(custom.lines[0]).toBe('.cursorrules created');

    const detect = await getCaptureAdapter('generic').detect(repo);
    expect(detect.installed).toBe(true);
    fs.rmSync(repo, { recursive: true, force: true });
  });

  it('gives default Generic AGENTS.md a fillable graduated block but leaves custom files brain-only', async () => {
    const { getCaptureAdapter } = await import('../capture/adapter.js');
    const { renderGraduatedRulesBlock, GRADUATED_SENTINEL } = await import('../rules-render.js');
    const { block } = await loadTemplate('memory-brain-block-agents.md');
    const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'mai-generic-grad-'));
    const generic = getCaptureAdapter('generic');

    await generic.install(repo, 'generic-grad');
    const installed = fs.readFileSync(path.join(repo, 'AGENTS.md'), 'utf8');
    expect(findManagedBlock(installed)?.text).toBe(block);
    expect(installed).toContain(GRADUATED_SENTINEL);

    const rendered = renderGraduatedRulesBlock([
      { lessonId: '11111111-1111-1111-1111-111111111111', rule: 'Use the standard target.', relearnedCount: 5 },
    ]);
    const changes = await generic.planUpgrade(repo, 'generic-grad', { graduatedRulesBlock: rendered });
    expect(changes).toHaveLength(1);
    expect(changes[0].file).toBe(path.join(repo, 'AGENTS.md'));
    expect(findManagedBlock(changes[0].newContent)?.text).toBe(block);
    expect(changes[0].newContent).toContain('Use the standard target.');

    const custom = getCaptureAdapter('generic', { rulesFile: '.cursorrules' });
    await custom.install(repo, 'generic-grad');
    expect(fs.readFileSync(path.join(repo, '.cursorrules'), 'utf8')).not.toContain(GRADUATED_SENTINEL);
    expect(await custom.planUpgrade(repo, 'generic-grad', { graduatedRulesBlock: rendered })).toEqual([]);
    fs.rmSync(repo, { recursive: true, force: true });
  });

  it('sniffs the transcript format', async () => {
    const { getCaptureAdapter } = await import('../capture/adapter.js');
    const a = getCaptureAdapter('generic');

    const codexParsed = await a.parseTranscript(FIXTURE);
    expect(codexParsed.harness).toBe('codex');

    const claudeFixture = fileURLToPath(new URL('./fixtures/sample-session.jsonl', import.meta.url));
    const claudeParsed = await a.parseTranscript(claudeFixture);
    expect(claudeParsed.harness).toBeUndefined();
    expect(claudeParsed.messageCount).toBeGreaterThan(0);
  });
});

describe('cwdMatchesRepo', () => {
  it('matches the root, subdirs, and rejects prefix-sibling traps', async () => {
    const { cwdMatchesRepo } = await import('../scripts/ingest-codex.js');
    const repos = ['/Users/x/Developer/app', '/Users/x/Developer/app-backend'];
    expect(cwdMatchesRepo('/Users/x/Developer/app', repos)).toBe(true);
    expect(cwdMatchesRepo('/Users/x/Developer/app/src/deep', repos)).toBe(true);
    expect(cwdMatchesRepo('/Users/x/Developer/app-backend', repos)).toBe(true);
    // 'app-frontend' must NOT match the 'app' repo (path-segment boundary)
    expect(cwdMatchesRepo('/Users/x/Developer/app-frontend', repos)).toBe(false);
    expect(cwdMatchesRepo('/Users/x/Elsewhere', repos)).toBe(false);
  });
});

describe('scanRoots', () => {
  it('umbrella product root joins metadata.repos as a match candidate', async () => {
    const { scanRoots } = await import('../scripts/ingest-codex.js');
    // umbrella class: sub-repos registered, agents launch from the umbrella
    // root — which is inside NO sub-repo, so before this fix it never matched.
    const roots = scanRoots('/Users/x/Developer/umbrella', {
      repos: ['/Users/x/Developer/umbrella/umbrella-app', '/Users/x/Developer/umbrella/umbrella-backend'],
    });
    expect(roots).toContain('/Users/x/Developer/umbrella');
    expect(roots).toContain('/Users/x/Developer/umbrella/umbrella-app');
    expect(roots).toContain('/Users/x/Developer/umbrella/umbrella-backend');
  });
  it('single-repo fallback preserved: no metadata.repos → path alone', async () => {
    const { scanRoots } = await import('../scripts/ingest-codex.js');
    expect(scanRoots('/Users/x/Developer/solo', null)).toEqual(['/Users/x/Developer/solo']);
    expect(scanRoots('/Users/x/Developer/solo', {})).toEqual(['/Users/x/Developer/solo']);
  });
  it('no path and no repos → empty (scan reports nothing to do)', async () => {
    const { scanRoots } = await import('../scripts/ingest-codex.js');
    expect(scanRoots(null, null)).toEqual([]);
  });
  it('path already in repos is not duplicated', async () => {
    const { scanRoots } = await import('../scripts/ingest-codex.js');
    expect(scanRoots('/a/b', { repos: ['/a/b'] })).toEqual(['/a/b']);
  });
});
