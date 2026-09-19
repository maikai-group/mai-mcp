/** mai verify — repo wiring checks (pure-FS unit tests + DB-backed project
 * tests). Plan 15 Task 3: explicit persisted-harness expectations, the
 * project-level report-only codex-notify check, the shared skills group with
 * setup-only deferral, and malformed-metadata failure. DB access goes through
 * the shared disposable guard; HOME/CODEX_HOME are temp so the skills group
 * never reads the operator's real installs. */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Pool } from 'pg';
import { requireDisposableTestDbUrl } from './test-db-url.js';

const savedEnv: Record<string, string | undefined> = {};
for (const k of ['MAI_DB_URL', 'MAI_PROJECT_SLUG', 'HOME', 'CODEX_HOME']) savedEnv[k] = process.env[k];
const TEST_DB = requireDisposableTestDbUrl();
process.env.MAI_DB_URL = TEST_DB;
process.env.MAI_PROJECT_SLUG = process.env.MAI_PROJECT_SLUG ?? 'verify-test';
const HOME_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'mai-verify-home-'));
process.env.HOME = HOME_DIR;
process.env.CODEX_HOME = path.join(HOME_DIR, '.codex');

type VerifyModule = typeof import('../scripts/verify.js');
type InitModule = typeof import('../scripts/init.js');
type SkillsModule = typeof import('../scripts/skills.js');
let verifyMod: VerifyModule;
let initMod: InitModule;
let skillsMod: SkillsModule;
let MAI_ROOT = '';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'mai-verify-test-'));
let SERVER_ENTRY = '';

beforeAll(async () => {
  verifyMod = await import('../scripts/verify.js');
  initMod = await import('../scripts/init.js');
  skillsMod = await import('../scripts/skills.js');
  ({ MAI_ROOT } = await import('../paths.js'));
  SERVER_ENTRY = path.join(MAI_ROOT, 'build', 'index.js');
});

afterAll(async () => {
  const { getPool } = await import('../db.js');
  await getPool().end();
  for (const [k, v] of Object.entries(savedEnv)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  fs.rmSync(tmp, { recursive: true, force: true });
});

/** Write a fully valid Claude-wired repo into a fresh tmpdir. */
function wiredRepo(slug: string): string {
  const dir = fs.mkdtempSync(path.join(tmp, 'repo-'));
  fs.writeFileSync(
    path.join(dir, '.mcp.json'),
    JSON.stringify({
      mcpServers: {
        'mai-mcp': {
          command: 'node',
          args: [SERVER_ENTRY],
          env: { MAI_PROJECT_SLUG: slug, MAI_PROJECT_ROOT: dir },
        },
      },
    })
  );
  fs.mkdirSync(path.join(dir, '.claude'), { recursive: true });
  const hooks: Record<string, unknown[]> = {};
  for (const { event, entry } of initMod.canonicalMaiHooks(slug)) {
    (hooks[event] ??= []).push(entry);
  }
  fs.writeFileSync(path.join(dir, '.claude', 'settings.json'), JSON.stringify({ hooks }));
  fs.writeFileSync(path.join(dir, 'CLAUDE.md'), '# repo\n\n## MEMORY BRAIN (mai-mcp)\n\nblock body\n');
  return dir;
}

/** SkillsIO with a temp home so verification never sees real installs. */
function tempSkillsIO(): import('../scripts/skills.js').SkillsIO {
  const home = fs.mkdtempSync(path.join(tmp, 'skills-home-'));
  const real = skillsMod.defaultSkillsIO();
  return {
    ...real,
    homedir: () => home,
    env: {},
    cwd: () => home,
  };
}

describe('verifyRepo (legacy expectation — compatibility)', () => {
  it('passes a fully wired repo', async () => {
    const dir = wiredRepo('verify-test');
    const r = await verifyMod.verifyRepo(dir, 'verify-test');
    expect(r.ok).toBe(true);
    expect(r.checks.map((c) => c.name).sort()).toEqual(['.mcp.json', 'CLAUDE.md', 'hooks']);
  });

  it('fails on slug mismatch in .mcp.json', async () => {
    const dir = wiredRepo('wrong-slug');
    const r = await verifyMod.verifyRepo(dir, 'verify-test');
    const mcp = r.checks.find((c) => c.name === '.mcp.json');
    expect(r.ok).toBe(false);
    expect(mcp?.ok).toBe(false);
    expect(mcp?.detail).toContain("MAI_PROJECT_SLUG 'wrong-slug'");
  });

  it('fails when a current SessionStart hook lacks --project', async () => {
    const dir = wiredRepo('verify-test');
    const { canonicalHookCommand } = await import('../hook-wiring.js');
    const hooks: Record<string, unknown[]> = {};
    for (const { event, entry } of initMod.canonicalMaiHooks('verify-test')) {
      (hooks[event] ??= []).push(event === 'SessionStart'
        ? { ...entry, hooks: [{ type: 'command', command: canonicalHookCommand('session-start') }] }
        : entry);
    }
    fs.writeFileSync(path.join(dir, '.claude', 'settings.json'), JSON.stringify({ hooks }));
    const result = await verifyMod.verifyRepo(dir, 'verify-test');
    expect(result.checks.find(c => c.name === 'hooks')?.detail).toContain('SessionStart hook lacks --project verify-test');
  });

  it('reports a legacy SessionStart hook as upgradeable', async () => {
    const dir = wiredRepo('verify-test');
    const { shellQuote } = await import('../command-encoding.js');
    const hooks: Record<string, unknown[]> = {};
    for (const { event, entry } of initMod.canonicalMaiHooks('verify-test')) {
      (hooks[event] ??= []).push(event === 'SessionStart'
        ? { ...entry, hooks: [{ type: 'command', command: `MAI_PROJECT_SLUG=verify-test bash ${shellQuote(path.join(MAI_ROOT, 'hooks', 'session-start-prime.sh'))}` }] }
        : entry);
    }
    fs.writeFileSync(path.join(dir, '.claude', 'settings.json'), JSON.stringify({ hooks }));
    const result = await verifyMod.verifyRepo(dir, 'verify-test');
    expect(result.checks.find(c => c.name === 'hooks')?.detail).toContain('SessionStart hook is a legacy Bash command — run mai upgrade');
  });

  it('fails on a missing CLAUDE.md marker and on a duplicate marker', async () => {
    const noMarker = wiredRepo('verify-test');
    fs.writeFileSync(path.join(noMarker, 'CLAUDE.md'), '# no block here\n');
    const r1 = await verifyMod.verifyRepo(noMarker, 'verify-test');
    expect(r1.checks.find((c) => c.name === 'CLAUDE.md')?.ok).toBe(false);

    const dupMarker = wiredRepo('verify-test');
    fs.appendFileSync(path.join(dupMarker, 'CLAUDE.md'), '\n## MEMORY BRAIN (mai-mcp)\n\npasted twice\n');
    const r2 = await verifyMod.verifyRepo(dupMarker, 'verify-test');
    const check = r2.checks.find((c) => c.name === 'CLAUDE.md');
    expect(check?.ok).toBe(false);
    expect(check?.detail).toContain('2×');
  });

  it('reports (never fails) legacy and stale brain-block versions', async () => {
    const dir = wiredRepo('verify-test');
    const r = await verifyMod.verifyRepo(dir, 'verify-test');
    const check = r.checks.find((c) => c.name === 'CLAUDE.md');
    expect(check?.ok).toBe(true);
    expect(check?.detail).toContain('run mai upgrade');
    expect(r.ok).toBe(true);

    const current = wiredRepo('verify-test');
    const tpl = fs.readFileSync(path.join(MAI_ROOT, 'templates', 'memory-brain-block.md'), 'utf8');
    fs.writeFileSync(path.join(current, 'CLAUDE.md'), `# repo\n\n${tpl}`);
    const r2 = await verifyMod.verifyRepo(current, 'verify-test');
    const check2 = r2.checks.find((c) => c.name === 'CLAUDE.md');
    expect(check2?.ok).toBe(true);
    expect(check2?.detail).toBeUndefined();
  });

  it('checks codex wiring only when present, failing on slug mismatch', async () => {
    const dir = wiredRepo('verify-test');
    const r0 = await verifyMod.verifyRepo(dir, 'verify-test');
    expect(r0.checks.some((c) => c.name === '.codex/config.toml')).toBe(false);

    const { buildCodexBlock, buildCodexInitialConfig } = await import('../capture/codex.js');
    fs.mkdirSync(path.join(dir, '.codex'), { recursive: true });
    fs.writeFileSync(path.join(dir, '.codex', 'config.toml'), buildCodexBlock(dir, 'wrong-slug', 'sol@codex'));
    const r1 = await verifyMod.verifyRepo(dir, 'verify-test');
    const codex = r1.checks.find((c) => c.name === '.codex/config.toml');
    expect(codex?.ok).toBe(false);
    expect(codex?.detail).toContain('MAI_PROJECT_SLUG');

    fs.writeFileSync(path.join(dir, '.codex', 'config.toml'), buildCodexInitialConfig(dir, 'verify-test', 'sol@codex'));
    const r2 = await verifyMod.verifyRepo(dir, 'verify-test');
    const codex2 = r2.checks.find((c) => c.name === '.codex/config.toml');
    expect(codex2?.ok).toBe(true);
    expect(codex2?.detail).toContain('mai_git_context=approve, mai_search=approve');

    fs.writeFileSync(path.join(dir, '.codex', 'config.toml'), buildCodexBlock(dir, 'verify-test', 'sol@codex'));
    const defaults = await verifyMod.verifyRepo(dir, 'verify-test');
    expect(defaults.checks.find((c) => c.name === '.codex/config.toml')?.detail)
      .toContain('Codex defaults (project overrides absent)');

    const inBlock = buildCodexBlock(dir, 'verify-test', 'sol@codex').replace(
      '# /mai-mcp-block v2',
      '[mcp_servers.mai-mcp.tools.mai_search]\napproval_mode = "approve"\n# /mai-mcp-block v2'
    );
    fs.writeFileSync(path.join(dir, '.codex', 'config.toml'), inBlock);
    const legacyPlacement = await verifyMod.verifyRepo(dir, 'verify-test');
    expect(legacyPlacement.checks.find((c) => c.name === '.codex/config.toml')?.detail)
      .toContain('approval overrides inside managed block');
  });

  it('fails when the server entry path does not exist', async () => {
    const dir = wiredRepo('verify-test');
    const file = path.join(dir, '.mcp.json');
    const mcp = JSON.parse(fs.readFileSync(file, 'utf8')) as {
      mcpServers: { 'mai-mcp': { args: string[] } };
    };
    mcp.mcpServers['mai-mcp'].args[0] = '/nonexistent/build/index.js';
    fs.writeFileSync(file, JSON.stringify(mcp));
    const r = await verifyMod.verifyRepo(dir, 'verify-test');
    expect(r.checks.find((c) => c.name === '.mcp.json')?.detail).toContain('server entry missing on disk');
  });
});

describe('verifyRepo (explicit expectations)', () => {
  it.each([
    '/tmp/repo', 'C:\\repo-one', '\\\\server\\share\\repo', '/tmp/space & repo',
    `/tmp/apostrophe'and"quote`, '/tmp/日本語-repo',
  ])('round-trips canonical managed Codex values for %s', async (expectedRoot) => {
    const dir = fs.mkdtempSync(path.join(tmp, 'codex-values-'));
    const { buildCodexBlock } = await import('../capture/codex.js');
    fs.mkdirSync(path.join(dir, '.codex'));
    fs.writeFileSync(
      path.join(dir, '.codex', 'config.toml'),
      buildCodexBlock(expectedRoot, 'value-slug', 'agent@test', undefined, ['zeta', 'alpha']),
    );
    const result = await verifyMod.verifyRepo(
      dir, 'value-slug', { harnesses: ['codex'], genericRulesFile: null }, expectedRoot, ['zeta', 'alpha'],
    );
    expect(result.checks.find(check => check.name === '.codex/config.toml')?.ok).toBe(true);
  });

  async function verifyCodexMutation(mutator: (block: string, expectedRoot: string) => string): Promise<boolean | undefined> {
    const dir = fs.mkdtempSync(path.join(tmp, 'codex-negative-'));
    const expectedRoot = '/expected/root';
    const { buildCodexBlock } = await import('../capture/codex.js');
    fs.mkdirSync(path.join(dir, '.codex'));
    const block = buildCodexBlock(expectedRoot, 'value-slug', 'agent@test', undefined, ['alpha']);
    fs.writeFileSync(path.join(dir, '.codex', 'config.toml'), mutator(block, expectedRoot));
    const result = await verifyMod.verifyRepo(
      dir, 'value-slug', { harnesses: ['codex'], genericRulesFile: null }, expectedRoot, ['alpha'],
    );
    return result.checks.find(check => check.name === '.codex/config.toml')?.ok;
  }

  it('rejects a wrong managed root even when a matching comment exists', async () => {
    expect(await verifyCodexMutation((block, root) =>
      `# MAI_PROJECT_ROOT = ${JSON.stringify(root)}\n${block.replace(
        `MAI_PROJECT_ROOT = ${JSON.stringify(root)}`, 'MAI_PROJECT_ROOT = "/wrong"',
      )}`)).toBe(false);
  });
  it('rejects a root present only outside the managed block', async () => {
    expect(await verifyCodexMutation((block, root) =>
      `MAI_PROJECT_ROOT = ${JSON.stringify(root)}\n${block.replace(/^MAI_PROJECT_ROOT.*$/m, '')}`)).toBe(false);
  });
  it('rejects a root present only in a foreign table', async () => {
    expect(await verifyCodexMutation((block, root) =>
      `${block.replace(/^MAI_PROJECT_ROOT.*$/m, '')}\n[foreign]\nMAI_PROJECT_ROOT = ${JSON.stringify(root)}\n`)).toBe(false);
  });
  it('rejects duplicate managed root assignments', async () => {
    expect(await verifyCodexMutation((block, root) => block.replace(
      `MAI_PROJECT_ROOT = ${JSON.stringify(root)}`,
      `MAI_PROJECT_ROOT = ${JSON.stringify(root)}\nMAI_PROJECT_ROOT = ${JSON.stringify(root)}`,
    ))).toBe(false);
  });
  it('rejects duplicate managed env tables', async () => {
    expect(await verifyCodexMutation((block) => block.replace(
      '[mcp_servers.mai-mcp.env]',
      '[mcp_servers.mai-mcp.env]\n[mcp_servers.mai-mcp.env]',
    ))).toBe(false);
  });
  it('rejects wrong linked projects', async () => {
    expect(await verifyCodexMutation((block) => block.replace(
      'MAI_LINKED_PROJECTS = "alpha"', 'MAI_LINKED_PROJECTS = "beta"',
    ))).toBe(false);
  });
  it('claude-only expectation skips codex checks even when codex wiring is present', async () => {
    const dir = wiredRepo('verify-test');
    const { buildCodexInitialConfig } = await import('../capture/codex.js');
    fs.mkdirSync(path.join(dir, '.codex'), { recursive: true });
    fs.writeFileSync(path.join(dir, '.codex', 'config.toml'), buildCodexInitialConfig(dir, 'verify-test', 'x'));
    const r = await verifyMod.verifyRepo(dir, 'verify-test', { harnesses: ['claude-code'], genericRulesFile: null });
    expect(r.ok).toBe(true);
    expect(r.checks.some((c) => c.name === '.codex/config.toml')).toBe(false);
  });

  it('codex expectation fails outright on missing wiring — no marker needed to fail', async () => {
    const dir = wiredRepo('verify-test');
    const expectation = { harnesses: ['claude-code', 'codex'], genericRulesFile: null };
    const r = await verifyMod.verifyRepo(dir, 'verify-test', expectation);
    expect(r.ok).toBe(false);
    expect(r.checks.find((c) => c.name === '.codex/config.toml')?.detail).toContain('missing expected codex wiring');
    expect(r.checks.find((c) => c.name === 'AGENTS.md')?.ok).toBe(false);

    const { buildCodexInitialConfig } = await import('../capture/codex.js');
    fs.mkdirSync(path.join(dir, '.codex'), { recursive: true });
    fs.writeFileSync(path.join(dir, '.codex', 'config.toml'), buildCodexInitialConfig(dir, 'verify-test', 'x'));
    fs.writeFileSync(path.join(dir, 'AGENTS.md'), '# a\n\n## MEMORY BRAIN (mai-mcp)\n\nbody\n');
    const r2 = await verifyMod.verifyRepo(dir, 'verify-test', expectation);
    expect(r2.ok).toBe(true);
  });

  it('generic expectation validates the stored basename and requires the exact file', async () => {
    const dir = wiredRepo('verify-test');
    const withCursor = { harnesses: ['claude-code', 'generic'], genericRulesFile: '.cursorrules' };
    const missing = await verifyMod.verifyRepo(dir, 'verify-test', withCursor);
    expect(missing.ok).toBe(false);
    expect(missing.checks.find((c) => c.name === '.cursorrules')?.detail).toBe('missing');

    fs.writeFileSync(path.join(dir, '.cursorrules'), '## MEMORY BRAIN (mai-mcp)\n\nbody\n');
    const present = await verifyMod.verifyRepo(dir, 'verify-test', withCursor);
    expect(present.ok).toBe(true);

    // Unsafe legacy/manual stored value fails with the repair instruction.
    const unsafe = await verifyMod.verifyRepo(dir, 'verify-test', {
      harnesses: ['claude-code', 'generic'],
      genericRulesFile: '../escape.md',
    });
    expect(unsafe.ok).toBe(false);
    expect(unsafe.checks.find((c) => c.name === 'generic rules file')?.detail).toContain('re-run mai init');
  });
});

describe('verifyProject (DB-backed)', () => {
  const admin = new Pool({ connectionString: TEST_DB });
  let repoDir = '';

  beforeAll(async () => {
    repoDir = wiredRepo('verify-test');
    await admin.query(`DELETE FROM projects WHERE slug LIKE 'verify-%'`);
    await admin.query(
      `INSERT INTO projects (slug, name, path, metadata) VALUES ('verify-test', 'Verify Test', $1, jsonb_build_object('repos', $2::jsonb))`,
      [repoDir, JSON.stringify([repoDir])]
    );
  });

  afterAll(async () => {
    await admin.query(`DELETE FROM projects WHERE slug LIKE 'verify-%'`);
    await admin.end();
  });

  it('verifies the registered repo list from the DB and formats a report', async () => {
    const v = await verifyMod.verifyProject('verify-test', { skillsIO: tempSkillsIO() });
    expect(v.ok).toBe(true);
    expect(v.repos).toHaveLength(1);
    expect(v.repos[0].repo).toBe(repoDir);
    const report = verifyMod.formatVerification(v);
    expect(report).toContain("mai verify — 'verify-test': PASS");
    expect(report).toContain('✅');
  });

  it('throws on an unknown slug', async () => {
    await expect(verifyMod.verifyProject('no-such-project')).rejects.toThrow('Project not found');
  });

  it('malformed capture_harnesses fails verification with a repair instruction, never passing', async () => {
    const dir = wiredRepo('verify-malformed');
    await admin.query(
      `INSERT INTO projects (slug, name, path, metadata) VALUES ('verify-malformed', 'x', $1, jsonb_build_object('repos', $2::jsonb, 'capture_harnesses', '"nope"'::jsonb))`,
      [dir, JSON.stringify([dir])]
    );
    const v = await verifyMod.verifyProject('verify-malformed', { skillsIO: tempSkillsIO() });
    expect(v.ok).toBe(false);
    expect(v.shared.find((c) => c.name === 'metadata')?.detail).toContain('re-run mai init');
  });

  it('explicit expectations: deleting an expected adapter file fails the project', async () => {
    const dir = wiredRepo('verify-expect');
    const { buildCodexInitialConfig } = await import('../capture/codex.js');
    fs.mkdirSync(path.join(dir, '.codex'), { recursive: true });
    fs.writeFileSync(path.join(dir, '.codex', 'config.toml'), buildCodexInitialConfig(dir, 'verify-expect', 'x'));
    fs.writeFileSync(path.join(dir, 'AGENTS.md'), '## MEMORY BRAIN (mai-mcp)\n\nbody\n');
    await admin.query(
      `INSERT INTO projects (slug, name, path, metadata) VALUES ('verify-expect', 'x', $1,
         jsonb_build_object('repos', $2::jsonb, 'capture_harnesses', '["claude-code","codex"]'::jsonb))`,
      [dir, JSON.stringify([dir])]
    );
    const pass = await verifyMod.verifyProject('verify-expect', { skillsIO: tempSkillsIO() });
    expect(pass.ok).toBe(true);

    fs.rmSync(path.join(dir, '.codex', 'config.toml'));
    const fail = await verifyMod.verifyProject('verify-expect', { skillsIO: tempSkillsIO() });
    expect(fail.ok).toBe(false);
  });

  it('codex-notify is one project-level PASS in each documented state and never per-repo', async () => {
    const dir = wiredRepo('verify-notify');
    const { buildCodexInitialConfig } = await import('../capture/codex.js');
    fs.mkdirSync(path.join(dir, '.codex'), { recursive: true });
    fs.writeFileSync(path.join(dir, '.codex', 'config.toml'), buildCodexInitialConfig(dir, 'verify-notify', 'x'));
    fs.writeFileSync(path.join(dir, 'AGENTS.md'), '## MEMORY BRAIN (mai-mcp)\n\nbody\n');
    await admin.query(
      `INSERT INTO projects (slug, name, path, metadata) VALUES ('verify-notify', 'x', $1,
         jsonb_build_object('repos', $2::jsonb, 'capture_harnesses', '["claude-code","codex"]'::jsonb))`,
      [dir, JSON.stringify([dir])]
    );

    // State 1: absent $CODEX_HOME (temp home has no .codex).
    const absent = await verifyMod.verifyProject('verify-notify', { skillsIO: tempSkillsIO() });
    const absentChecks = absent.shared.filter((c) => c.name === 'codex-notify');
    expect(absentChecks).toHaveLength(1);
    expect(absentChecks[0].ok).toBe(true);
    expect(absentChecks[0].detail).toBe(
      'CODEX_HOME not found — create it and rerun mai init to add optional end-of-turn ingest'
    );
    expect(absent.ok).toBe(true);
    expect(absent.repos[0].checks.some((c) => c.name === 'codex-notify')).toBe(false);
    expect(absent.shared.filter(c => c.name.startsWith('hooks/')).map(c => c.name).sort()).toEqual([
      'hooks/codex-notify-chain.sh', 'hooks/codex-notify-ingest.sh',
      'hooks/pre-edit-claim-warn.sh', 'hooks/session-end-ingest.sh',
      'hooks/session-start-prime.sh', 'hooks/session-stop-nudge.sh',
    ]);

    // State 2: foreign notify preserved.
    fs.mkdirSync(process.env.CODEX_HOME ?? '', { recursive: true });
    fs.writeFileSync(path.join(process.env.CODEX_HOME ?? '', 'config.toml'), 'notify = ["bash", "/theirs/notify.sh"]\n');
    const foreign = await verifyMod.verifyProject('verify-notify', { skillsIO: tempSkillsIO() });
    const foreignCheck = foreign.shared.find((c) => c.name === 'codex-notify');
    expect(foreignCheck?.ok).toBe(true);
    expect(foreignCheck?.detail).toBe(
      'foreign Codex notify preserved — chain hooks/codex-notify-chain.sh manually if end-of-turn ingest is desired'
    );
    expect(foreign.ok).toBe(true);

    // State 3: MAI-owned wiring is current.
    const { buildCodexNotifyLine } = await import('../hook-wiring.js');
    fs.writeFileSync(path.join(process.env.CODEX_HOME ?? '', 'config.toml'), buildCodexNotifyLine() + '\n');
    const owned = await verifyMod.verifyProject('verify-notify', { skillsIO: tempSkillsIO() });
    const ownedCheck = owned.shared.find((c) => c.name === 'codex-notify');
    expect(ownedCheck?.ok).toBe(true);
    expect(ownedCheck?.detail).toBeUndefined();

    fs.writeFileSync(
      path.join(process.env.CODEX_HOME ?? '', 'config.toml'),
      '# codex-notify-ingest.sh is only a comment\nnotify = ["foreign"]\n',
    );
    const commentOnly = await verifyMod.verifyProject('verify-notify', { skillsIO: tempSkillsIO() });
    expect(commentOnly.shared.find(c => c.name === 'codex-notify')?.detail).toContain('foreign Codex notify preserved');

    fs.writeFileSync(
      path.join(process.env.CODEX_HOME ?? '', 'config.toml'),
      `notify = ["bash", "${MAI_ROOT}/hooks/codex-notify-chain.sh"]\n`,
    );
    const legacy = await verifyMod.verifyProject('verify-notify', { skillsIO: tempSkillsIO() });
    expect(legacy.shared.find(c => c.name === 'codex-notify')?.detail).toContain('legacy Codex notify');

    fs.rmSync(process.env.CODEX_HOME ?? '', { recursive: true, force: true });
  });

  it('skills group: missing passes with install hint; partial and drifted fail; deferred omits only skills', async () => {
    const io = tempSkillsIO();
    // Entirely missing → PASS with the install hint.
    const missing = await verifyMod.verifyProject('verify-test', { skillsIO: io });
    const claudeGroup = missing.shared.find((c) => c.name === 'claude skills');
    expect(claudeGroup?.ok).toBe(true);
    expect(claudeGroup?.detail).toContain('mai skills install');

    // Install, then drift one skill → FAIL.
    skillsMod.runSkills({ action: 'install', target: 'claude' }, io);
    const installed = await verifyMod.verifyProject('verify-test', { skillsIO: io });
    expect(installed.shared.find((c) => c.name === 'claude skills')?.ok).toBe(true);

    const home = io.homedir();
    fs.writeFileSync(path.join(home, '.claude', 'skills', 'plan-review', 'SKILL.md'), 'tampered\n');
    const drifted = await verifyMod.verifyProject('verify-test', { skillsIO: io });
    const driftedGroup = drifted.shared.find((c) => c.name === 'claude skills');
    expect(driftedGroup?.ok).toBe(false);
    expect(drifted.ok).toBe(false);

    // Partial: remove one installed skill entirely.
    fs.rmSync(path.join(home, '.claude', 'skills', 'plan-review'), { recursive: true, force: true });
    const partial = await verifyMod.verifyProject('verify-test', { skillsIO: io });
    const partialGroup = partial.shared.find((c) => c.name === 'claude skills');
    expect(partialGroup?.ok).toBe(false);
    expect(partialGroup?.detail).toContain('partially installed');

    // Deferred omits ONLY the skills groups — the drifted state stops failing,
    // while repo checks still run.
    const deferred = await verifyMod.verifyProject('verify-test', { sharedSkills: 'deferred', skillsIO: io });
    expect(deferred.shared.some((c) => c.name === 'claude skills')).toBe(false);
    // Deferral must not broaden: repo wiring and shared hook checks still ran.
    expect(deferred.repos[0].checks.length).toBeGreaterThan(0);
    expect(deferred.shared.some((c) => c.name.startsWith('hooks/'))).toBe(true);
    expect(deferred.ok).toBe(true);
  });

  it('stale skills pass with the upgrade hint', async () => {
    const io = tempSkillsIO();
    skillsMod.runSkills({ action: 'install', target: 'claude' }, io);
    const home = io.homedir();
    const dir = path.join(home, '.claude', 'skills', 'plan-review');
    fs.writeFileSync(path.join(dir, 'SKILL.md'), 'older shipped revision\n');
    const rehashed = skillsMod.hashTree(dir);
    const sidecarPath = path.join(dir, '.mai-skill.json');
    const raw: unknown = JSON.parse(fs.readFileSync(sidecarPath, 'utf8'));
    if (typeof raw !== 'object' || raw === null) throw new Error('sidecar unreadable');
    fs.writeFileSync(sidecarPath, `${JSON.stringify({ ...raw, sha: rehashed }, null, 2)}\n`);

    const v = await verifyMod.verifyProject('verify-test', { skillsIO: io });
    const group = v.shared.find((c) => c.name === 'claude skills');
    expect(group?.ok).toBe(true);
    expect(group?.detail).toContain('mai skills upgrade');
  });
});

describe('build identity shared check (Plan 15 Task 6)', () => {
  const VALID = { version: '0.9.0', sha: 'abc1234', dirty: false, builtAt: '2026-08-17T00:00:00.000Z' };

  it('missing/malformed FAILS with the rebuild command; behind-source is PASS with the exact hint', async () => {
    const missing = verifyMod.buildIdentityCheck(null, { fingerprint: 'unknown', stale: false });
    expect(missing.ok).toBe(false);
    expect(missing.detail).toBe('build identity missing or malformed — run npm run build');

    const behind = verifyMod.buildIdentityCheck(VALID, {
      fingerprint: '0.9.0 abc1234 @ 2026-08-17T00:00:00.000Z',
      stale: true,
      detail: 'build is behind source — run npm run build',
    });
    expect(behind.ok).toBe(true);
    expect(behind.detail).toContain('build is behind source — run npm run build');
    expect(behind.detail).toContain('abc1234');

    const current = verifyMod.buildIdentityCheck(VALID, { fingerprint: '0.9.0 abc1234 @ x', stale: false });
    expect(current.ok).toBe(true);
    expect(current.detail).toContain('abc1234');

    const unknown = verifyMod.buildIdentityCheck({ ...VALID, sha: 'unknown' }, { fingerprint: '0.9.0 unknown @ x', stale: false });
    expect(unknown.ok).toBe(true);
  });

  it('the build check always runs — even under the skills deferral', async () => {
    const admin = new Pool({ connectionString: TEST_DB });
    const dir = wiredRepo('verify-build');
    try {
      await admin.query(`DELETE FROM projects WHERE slug = 'verify-build'`);
      await admin.query(
        `INSERT INTO projects (slug, name, path, metadata) VALUES ('verify-build', 'x', $1, jsonb_build_object('repos', $2::jsonb))`,
        [dir, JSON.stringify([dir])]
      );
      const deferred = await verifyMod.verifyProject('verify-build', { sharedSkills: 'deferred', skillsIO: tempSkillsIO() });
      const build = deferred.shared.find((c) => c.name === 'build');
      expect(build).toBeDefined();
      expect(build?.ok).toBe(true); // tests run right after npm run build → current
      const required = await verifyMod.verifyProject('verify-build', { skillsIO: tempSkillsIO() });
      expect(required.shared.some((c) => c.name === 'build')).toBe(true);
    } finally {
      await admin.query(`DELETE FROM projects WHERE slug = 'verify-build'`);
      await admin.end();
    }
  });
});

describe('smoke verification (optional result contract)', () => {
  it('populates the optional smoke result and the formatted smoke line; detail stays optional', async () => {
    const admin = new Pool({ connectionString: TEST_DB });
    const dir = wiredRepo('verify-smoke');
    try {
      await admin.query(`DELETE FROM projects WHERE slug = 'verify-smoke'`);
      await admin.query(
        `INSERT INTO projects (slug, name, path, metadata) VALUES ('verify-smoke', 'x', $1, jsonb_build_object('repos', $2::jsonb))`,
        [dir, JSON.stringify([dir])]
      );
      const v = await verifyMod.verifyProject('verify-smoke', { smoke: true, skillsIO: tempSkillsIO() });
      expect(v.smoke).toBeDefined();
      expect(v.smoke?.ok).toBe(true);
      const report = verifyMod.formatVerification(v);
      expect(report).toContain('smoke (stdio initialize)');
      // A shared result without detail remains valid (type + runtime).
      const bare: import('../scripts/verify.js').CheckResult = { name: 'x', ok: true };
      expect(bare.detail).toBeUndefined();
    } finally {
      await admin.query(`DELETE FROM projects WHERE slug = 'verify-smoke'`);
      await admin.end();
    }
  }, 60_000);
});
