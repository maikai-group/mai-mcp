/** Upgrade planning end-to-end on temp-dir repos + a throwaway project row
 * (board.test.ts pattern — requires docker compose + db:init). */
import { beforeAll, afterAll, describe, expect, it } from 'vitest';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Pool } from 'pg';
import { findManagedBlock, loadTemplate } from '../scripts/managed-block.js';

process.env.MAI_PROJECT_SLUG = process.env.MAI_PROJECT_SLUG ?? 'upgrade-test';
process.env.MAI_DB_URL =
  process.env.MAI_DB_URL ?? 'postgresql://postgres:postgres@127.0.0.1:54334/mai_brain';

const admin = new Pool({ connectionString: process.env.MAI_DB_URL });
let repoDir: string;
// HERMETIC CONSENT PROBE (R10, reviews pass-3 W1 + pass-5 W1): BOTH fake CLIs
// on PATH — the consent chain probes `claude --version` FIRST, then `codex
// login status`; pinning only one leaves the other spawning a real binary
// under npm test on machines that have it.
const ccBin = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures', 'cc-bin');
const codexBin = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures', 'codex-bin');
const realPath = process.env.PATH ?? '';
const savedCodexFixture = process.env.MAI_CODEX_FIXTURE;

const LEGACY_CLAUDE_MD = [
  '# demo project rules',
  '',
  'Keep these.',
  '',
  '## MEMORY BRAIN (mai-mcp)',
  '',
  'ancient block body, no sentinel',
  '',
].join('\n');

beforeAll(async () => {
  process.env.PATH = `${ccBin}:${codexBin}:${realPath}`;
  process.env.MAI_CODEX_FIXTURE = 'loggedout';
  const { resetClaudeBinaryProbe } = await import('../llm/claude-code.js');
  const { resetCodexBinaryProbe } = await import('../llm/codex-cli.js');
  resetClaudeBinaryProbe(); // an earlier suite's cached probes must not bypass the pins
  resetCodexBinaryProbe();
  repoDir = await fs.mkdtemp(path.join(os.tmpdir(), 'mai-upgrade-'));
  await fs.writeFile(path.join(repoDir, 'CLAUDE.md'), LEGACY_CLAUDE_MD, 'utf8');
  await fs.writeFile(
    path.join(repoDir, '.mcp.json'),
    JSON.stringify(
      {
        mcpServers: {
          'mai-mcp': {
            command: 'node',
            args: ['/stale/path/build/index.js'],
            env: { MAI_PROJECT_SLUG: 'upgrade-test', MAI_PROJECT_ROOT: repoDir, MAI_AGENT_ID: 'fable@claude-code' },
          },
          other: { command: 'x' },
        },
      },
      null,
      2
    ),
    'utf8'
  );
  await fs.mkdir(path.join(repoDir, '.claude'), { recursive: true });
  await fs.writeFile(
    path.join(repoDir, '.claude', 'settings.json'),
    JSON.stringify(
      {
        hooks: {
          SessionEnd: [
            { hooks: [{ type: 'command', command: 'OLD=1 bash /old/mai-mcp/hooks/session-end-ingest.sh' }] },
            { hooks: [{ type: 'command', command: 'bash /theirs/keep.sh' }] },
          ],
        },
      },
      null,
      2
    ),
    'utf8'
  );
  await admin.query(`DELETE FROM projects WHERE slug = 'upgrade-test'`);
  await admin.query(
    `INSERT INTO projects (slug, name, path, metadata) VALUES ('upgrade-test', 'Upgrade Test', $1, jsonb_build_object('repos', jsonb_build_array($1::text)))`,
    [repoDir]
  );
});

afterAll(async () => {
  // Exact restore of the hermetic-probe pins (set-don't-delete discipline).
  process.env.PATH = realPath;
  if (savedCodexFixture === undefined) delete process.env.MAI_CODEX_FIXTURE;
  else process.env.MAI_CODEX_FIXTURE = savedCodexFixture;
  const { resetClaudeBinaryProbe } = await import('../llm/claude-code.js');
  const { resetCodexBinaryProbe } = await import('../llm/codex-cli.js');
  resetClaudeBinaryProbe(); // this suite's cached probes must not leak onward
  resetCodexBinaryProbe();
  await admin.query(`DELETE FROM projects WHERE slug = 'upgrade-test'`);
  await admin.end();
  await fs.rm(repoDir, { recursive: true, force: true });
  const { getPool } = await import('../db.js');
  await getPool().end();
});

describe('planRepoUpgrade', () => {
  it('plans a legacy CLAUDE.md migration + .mcp.json + hooks refresh, preserving user content and agent id', async () => {
    const { planRepoUpgrade } = await import('../scripts/upgrade.js');
    const changes = await planRepoUpgrade(repoDir, 'upgrade-test');
    const byFile = Object.fromEntries(changes.map((c) => [path.basename(c.file), c]));

    expect(byFile['CLAUDE.md'].legacy).toBe(true);
    expect(byFile['CLAUDE.md'].newContent).toContain('Keep these.');
    expect(byFile['CLAUDE.md'].newContent).toContain('<!-- /mai-brain-block v');
    expect(byFile['CLAUDE.md'].newContent).not.toContain('ancient block body');

    const mcp = JSON.parse(byFile['.mcp.json'].newContent);
    expect(mcp.mcpServers['mai-mcp'].env.MAI_AGENT_ID).toBe('fable@claude-code');
    expect(mcp.mcpServers['mai-mcp'].args[0]).not.toContain('/stale/path/');
    expect(mcp.mcpServers.other).toBeDefined();

    const settings = JSON.parse(byFile['settings.json'].newContent);
    const cmds = settings.hooks.SessionEnd.flatMap((e: { hooks: { command: string }[] }) => e.hooks.map((h) => h.command));
    expect(cmds.some((c: string) => c.includes('/old/'))).toBe(false);
    expect(cmds.some((c: string) => c.includes('keep.sh'))).toBe(true);
    expect(settings.hooks.SessionStart).toBeDefined();
    expect(settings.hooks.Stop).toBeDefined();
  });

  it('--agent-id overrides the preserved id', async () => {
    const { planRepoUpgrade } = await import('../scripts/upgrade.js');
    const changes = await planRepoUpgrade(repoDir, 'upgrade-test', { agentId: 'kai@claude-code' });
    const mcpChange = changes.find((c) => c.file.endsWith('.mcp.json'))!;
    expect(JSON.parse(mcpChange.newContent).mcpServers['mai-mcp'].env.MAI_AGENT_ID).toBe('kai@claude-code');
  });

  it('composes brain refresh + graduated install into one CLAUDE.md change', async () => {
    const { block } = await loadTemplate('memory-brain-block.md');
    const { planRepoUpgrade } = await import('../scripts/upgrade.js');
    const { renderGraduatedRulesBlock, GRADUATED_SENTINEL } = await import('../rules-render.js');
    const changes = await planRepoUpgrade(repoDir, 'upgrade-test', {
      graduatedRulesBlock: renderGraduatedRulesBlock([]),
    });
    const claude = changes.filter((c) => c.file === path.join(repoDir, 'CLAUDE.md'));
    expect(claude).toHaveLength(1);
    expect(findManagedBlock(claude[0].newContent)?.text).toBe(block);
    expect(claude[0].newContent).toContain(GRADUATED_SENTINEL);
    expect(claude[0].newContent).not.toContain('ancient block body');
  });
});

describe('runUpgrade', () => {
  it('rejects partial copied wiring instead of reporting it current or writing', async () => {
    const { runUpgrade } = await import('../scripts/upgrade.js');
    const partialRepo = await fs.mkdtemp(path.join(os.tmpdir(), 'mai-upgrade-partial-'));
    const mcpFile = path.join(partialRepo, '.mcp.json');
    const partialMcp = JSON.stringify(
      {
        mcpServers: {
          'mai-mcp': {
            command: 'node',
            args: ['/stale/path/build/index.js'],
            env: { MAI_PROJECT_SLUG: 'upgrade-test', MAI_PROJECT_ROOT: partialRepo },
          },
        },
      },
      null,
      2
    );
    await fs.writeFile(mcpFile, partialMcp, 'utf8');
    await admin.query(
      `UPDATE projects
          SET path = $2,
              metadata = jsonb_build_object(
                'repos', jsonb_build_array($2::text),
                'capture_harnesses', jsonb_build_array('claude-code')
              )
        WHERE slug = $1`,
      ['upgrade-test', partialRepo]
    );
    let beforeApplyCalled = false;
    try {
      await expect(runUpgrade({
        slugs: ['upgrade-test'],
        dryRun: true,
        yes: false,
        llm: 'none',
        embeddings: 'none',
        consentEnvFile: path.join(partialRepo, 'consent-env'),
      })).rejects.toThrow(/incomplete wiring:[\s\S]*hooks[\s\S]*CLAUDE\.md[\s\S]*mai init upgrade-test/);

      await expect(runUpgrade({
        slugs: ['upgrade-test'],
        dryRun: false,
        yes: true,
        llm: 'none',
        embeddings: 'none',
        consentEnvFile: path.join(partialRepo, 'consent-env'),
        beforeApply: async () => {
          beforeApplyCalled = true;
        },
      })).rejects.toThrow(/Upgrade stopped before writing/);
      expect(beforeApplyCalled).toBe(false);
      expect(await fs.readFile(mcpFile, 'utf8')).toBe(partialMcp);
      await expect(fs.access(path.join(partialRepo, 'consent-env'))).rejects.toMatchObject({ code: 'ENOENT' });
    } finally {
      await admin.query(
        `UPDATE projects SET path = $2, metadata = jsonb_build_object('repos', jsonb_build_array($2::text))
          WHERE slug = $1`,
        ['upgrade-test', repoDir]
      );
      await fs.rm(partialRepo, { recursive: true, force: true });
    }
  });

  it('rejects when a planned edit leaves another invariant in the same file broken', async () => {
    const { runUpgrade } = await import('../scripts/upgrade.js');
    const { getCaptureAdapter } = await import('../capture/adapter.js');
    const duplicateRepo = await fs.mkdtemp(path.join(os.tmpdir(), 'mai-upgrade-duplicate-'));
    await getCaptureAdapter('claude-code').install(duplicateRepo, 'upgrade-test');
    const claudeFile = path.join(duplicateRepo, 'CLAUDE.md');
    const oneBlock = await fs.readFile(claudeFile, 'utf8');
    const duplicate = `${oneBlock.trimEnd()}\n\n${oneBlock}`;
    await fs.writeFile(claudeFile, duplicate, 'utf8');
    await admin.query(
      `UPDATE projects
          SET path = $2,
              metadata = jsonb_build_object(
                'repos', jsonb_build_array($2::text),
                'capture_harnesses', jsonb_build_array('claude-code')
              )
        WHERE slug = $1`,
      ['upgrade-test', duplicateRepo]
    );
    let beforeApplyCalled = false;
    try {
      await expect(runUpgrade({
        slugs: ['upgrade-test'],
        dryRun: false,
        yes: true,
        consentEnvFile: path.join(duplicateRepo, 'consent-env'),
        beforeApply: async () => {
          beforeApplyCalled = true;
        },
      })).rejects.toThrow(/incomplete wiring:[\s\S]*brain-block marker appears 2×/);
      expect(beforeApplyCalled).toBe(false);
      expect(await fs.readFile(claudeFile, 'utf8')).toBe(duplicate);
    } finally {
      await admin.query(
        `UPDATE projects SET path = $2, metadata = jsonb_build_object('repos', jsonb_build_array($2::text))
          WHERE slug = $1`,
        ['upgrade-test', repoDir]
      );
      await fs.rm(duplicateRepo, { recursive: true, force: true });
    }
  });

  it('--dry-run reports diffs without writing', async () => {
    const { runUpgrade } = await import('../scripts/upgrade.js');
    const before = await fs.readFile(path.join(repoDir, 'CLAUDE.md'), 'utf8');
    const out = await runUpgrade({
      slugs: ['upgrade-test'],
      dryRun: true,
      yes: false,
      consentEnvFile: path.join(repoDir, 'consent-env'),
    });
    expect(out).toContain('LEGACY MIGRATION');
    expect(out).toContain('pending change(s)');
    expect(await fs.readFile(path.join(repoDir, 'CLAUDE.md'), 'utf8')).toBe(before);
  });

  it('--yes applies, and a second run is fully current', async () => {
    const { runUpgrade } = await import('../scripts/upgrade.js');
    const out = await runUpgrade({
      slugs: ['upgrade-test'],
      dryRun: false,
      yes: true,
      consentEnvFile: path.join(repoDir, 'consent-env'),
    });
    expect(out).toContain('Applied');
    const md = await fs.readFile(path.join(repoDir, 'CLAUDE.md'), 'utf8');
    expect(md).toContain('<!-- /mai-brain-block v');
    expect(md).toContain('Keep these.');
    const again = await runUpgrade({
      slugs: ['upgrade-test'],
      dryRun: false,
      yes: true,
      consentEnvFile: path.join(repoDir, 'consent-env'),
    });
    expect(again).toContain('Everything is current');
  });

  it('--yes refreshes a registered marker even when adapter planning has zero pending changes', async () => {
    const { runUpgrade } = await import('../scripts/upgrade.js');
    const { renderGraduatedRulesBlock } = await import('../rules-render.js');
    const { GRADUATION_REINFORCEMENTS } = await import('../curation.js');
    const quietRepo = await fs.mkdtemp(path.join(os.tmpdir(), 'mai-upgrade-zero-'));
    await fs.writeFile(
      path.join(quietRepo, 'CLAUDE.md'),
      `# Quiet repo\n\n${renderGraduatedRulesBlock([])}`,
      'utf8'
    );
    const lesson = await admin.query<{ id: string }>(
      `INSERT INTO lessons (project_id, rule, relearned_count)
       SELECT id, 'upgrade zero-pending refresh', $1 FROM projects WHERE slug = 'upgrade-test'
       RETURNING id`,
      [GRADUATION_REINFORCEMENTS]
    );
    await admin.query(
      `UPDATE projects SET path = $2, metadata = jsonb_build_object('repos', jsonb_build_array($2::text))
        WHERE slug = $1`,
      ['upgrade-test', quietRepo]
    );
    try {
      const out = await runUpgrade({
        slugs: ['upgrade-test'], dryRun: false, yes: true,
        consentEnvFile: path.join(quietRepo, 'consent-env'),
        beforeApply: async () => {
          const project = await admin.query<{ id: string }>(
            `SELECT id FROM projects WHERE slug = 'upgrade-test'`
          );
          await admin.query(
            `INSERT INTO curation_candidates
               (project_id,target_kind,target_id,basis,status,resolved_at)
             VALUES ($1,'lesson',$2,'graduate','applied',NOW())`,
            [project.rows[0].id, lesson.rows[0].id]
          );
        },
      });
      expect(out).toContain('Everything is current — graduated rules refreshed in 1 file(s).');
      expect(await fs.readFile(path.join(quietRepo, 'CLAUDE.md'), 'utf8')).toContain(
        'upgrade zero-pending refresh'
      );
    } finally {
      await admin.query(
        `UPDATE projects SET path = $2, metadata = jsonb_build_object('repos', jsonb_build_array($2::text))
          WHERE slug = $1`,
        ['upgrade-test', repoDir]
      );
      await fs.rm(quietRepo, { recursive: true, force: true });
    }
  });

  it('--yes rejects when a zero-pending registered marker cannot be read', async () => {
    const { runUpgrade } = await import('../scripts/upgrade.js');
    const { renderGraduatedRulesBlock } = await import('../rules-render.js');
    const badRepo = await fs.mkdtemp(path.join(os.tmpdir(), 'mai-upgrade-unreadable-'));
    const file = path.join(badRepo, 'CLAUDE.md');
    await fs.writeFile(file, `# Unreadable repo\n\n${renderGraduatedRulesBlock([])}`, 'utf8');
    await fs.chmod(file, 0o000);
    await admin.query(
      `UPDATE projects SET path = $2, metadata = jsonb_build_object('repos', jsonb_build_array($2::text))
        WHERE slug = $1`,
      ['upgrade-test', badRepo]
    );
    try {
      // AMENDMENT A11 (plan 27, finding 4cfde7e9). The plan specified a bare
      // `rejects.toThrow()`, which any unrelated throw satisfies — including
      // `Project not found`, reachable earlier in the same function. This test
      // is the guard against blocker 62fb1f3b's class (a masked read failure
      // letting the refresh claim success), so it must pin THAT failure: the
      // rejection has to be the EACCES on this repo's marker, not any error.
      // Under amendment A12 the refresh loop aggregates per-project failures,
      // so the cause is asserted through the AggregateError — which pins A12's
      // shape at the same time.
      await expect(runUpgrade({
        slugs: ['upgrade-test'], dryRun: false, yes: true,
        consentEnvFile: path.join(badRepo, 'consent-env'),
      })).rejects.toMatchObject({
        name: 'AggregateError',
        errors: [{ code: 'EACCES', path: file }],
      });
    } finally {
      await fs.chmod(file, 0o600);
      await admin.query(
        `UPDATE projects SET path = $2, metadata = jsonb_build_object('repos', jsonb_build_array($2::text))
          WHERE slug = $1`,
        ['upgrade-test', repoDir]
      );
      await fs.rm(badRepo, { recursive: true, force: true });
    }
  });

  it('--yes finishes with a locked current-DB projection, not its pre-confirmation snapshot', async () => {
    const { runUpgrade } = await import('../scripts/upgrade.js');
    const { writeGraduatedRulesBlocks } = await import('../rules-render.js');
    const { GRADUATION_REINFORCEMENTS } = await import('../curation.js');
    const project = await admin.query<{ id: string }>(
      `SELECT id FROM projects WHERE slug = 'upgrade-test'`
    );
    const projectId = project.rows[0].id;
    const lessons = await admin.query<{ id: string }>(
      `INSERT INTO lessons (project_id, rule, relearned_count)
       VALUES ($1,'upgrade snapshot A',$2),($1,'upgrade current B',$2) RETURNING id`,
      [projectId, GRADUATION_REINFORCEMENTS]
    );
    await admin.query(
      `INSERT INTO curation_candidates
         (project_id,target_kind,target_id,basis,status,resolved_at)
       VALUES ($1,'lesson',$2,'graduate','applied',NOW())`,
      [projectId, lessons.rows[0].id]
    );
    await writeGraduatedRulesBlocks(projectId);
    const file = path.join(repoDir, 'CLAUDE.md');
    const { version } = await loadTemplate('memory-brain-block.md');
    const current = await fs.readFile(file, 'utf8');
    expect(findManagedBlock(current)?.version).toBe(version);
    expect(version).toBeGreaterThan(4);
    const stale = current.replace(
      `<!-- /mai-brain-block v${version} -->`, '<!-- /mai-brain-block v4 -->'
    );
    expect(stale).not.toBe(current);
    expect(findManagedBlock(stale)?.version).toBe(4);
    await fs.writeFile(file, stale); // force a confirmed change while the graduated snapshot is A-only

    const out = await runUpgrade({
      slugs: ['upgrade-test'], dryRun: false, yes: true,
      consentEnvFile: path.join(repoDir, 'consent-env'),
      beforeApply: async () => {
        await admin.query(
          `INSERT INTO curation_candidates
             (project_id,target_kind,target_id,basis,status,resolved_at)
           VALUES ($1,'lesson',$2,'graduate','applied',NOW())`,
          [projectId, lessons.rows[1].id]
        );
      },
    });
    const final = await fs.readFile(file, 'utf8');
    expect(final).toContain('upgrade snapshot A');
    expect(final).toContain('upgrade current B');
    // AMENDMENT A8 (finding 3428b7eb): the applied path must account for the
    // instruction files the projection writer touched, not just the planned
    // config changes. Without the repair this run reports "Applied N" only,
    // while having rewritten this very CLAUDE.md.
    expect(out).toMatch(/Applied \d+ change\(s\); graduated rules refreshed in \d+ file\(s\): /);
    expect(out).toContain('CLAUDE.md updated');
  });
});

describe('renderDiff', () => {
  it('trims common context and shows -/+ hunks', async () => {
    const { renderDiff } = await import('../scripts/upgrade.js');
    const d = renderDiff('a\nb\nc\n', 'a\nB\nc\n');
    expect(d).toContain('- b');
    expect(d).toContain('+ B');
    expect(d).toContain('unchanged line(s)');
  });

  it('keeps untouched text between separated changes out of the +/- columns', async () => {
    const { renderDiff } = await import('../scripts/upgrade.js');
    const before = [
      'managed header v1',
      'USER-OWNED PROSE — preserve exactly',
      'another untouched line',
      'managed footer v1',
      '',
    ].join('\n');
    const after = before
      .replace('managed header v1', 'managed header v2')
      .replace('managed footer v1', 'managed footer v2');

    const d = renderDiff(before, after);
    expect(d).toContain('- managed header v1');
    expect(d).toContain('+ managed header v2');
    expect(d).toContain('- managed footer v1');
    expect(d).toContain('+ managed footer v2');
    expect(d).not.toContain('- USER-OWNED PROSE');
    expect(d).not.toContain('+ USER-OWNED PROSE');
    expect(d).toContain('… 2 unchanged line(s)');
  });

  it('reports identical text without manufacturing a hunk', async () => {
    const { renderDiff } = await import('../scripts/upgrade.js');
    expect(renderDiff('same\n', 'same\n')).toBe('(no textual change)');
  });

  it('aligns repeated lines while isolating the real deletion and addition', async () => {
    const { renderDiff } = await import('../scripts/upgrade.js');
    const before = ['start', 'repeat', 'remove me', 'repeat', 'end', ''].join('\n');
    const after = ['start', 'repeat', 'add me', 'repeat', 'end', ''].join('\n');
    const d = renderDiff(before, after);
    expect(d).toContain('- remove me');
    expect(d).toContain('+ add me');
    expect(d).not.toContain('- repeat');
    expect(d).not.toContain('+ repeat');
  });

  it('renders the real composed brain+graduated change without relabeling the user section', async () => {
    const fixtureRepo = await fs.mkdtemp(path.join(os.tmpdir(), 'mai-composed-diff-'));
    try {
      const original = [
        '# Demo rules',
        '',
        '## MEMORY BRAIN (mai-mcp)',
        '',
        'stale brain block',
        '',
        '## Other section',
        '',
        'USER-OWNED TAIL — preserve exactly',
        'another user line',
        '',
      ].join('\n');
      await fs.writeFile(path.join(fixtureRepo, 'CLAUDE.md'), original, 'utf8');
      const { planInstructionFileUpgrade, renderGraduatedRulesBlock } = await import('../rules-render.js');
      const { renderDiff } = await import('../scripts/upgrade.js');
      const changes = await planInstructionFileUpgrade(
        fixtureRepo,
        'CLAUDE.md',
        'memory-brain-block.md',
        renderGraduatedRulesBlock([])
      );
      expect(changes).toHaveLength(1);
      const d = renderDiff(changes[0].before, changes[0].after);
      expect(d).not.toContain('- ## Other section');
      expect(d).not.toContain('+ ## Other section');
      expect(d).not.toContain('- USER-OWNED TAIL');
      expect(d).not.toContain('+ USER-OWNED TAIL');
      expect(changes[0].newContent).toContain('USER-OWNED TAIL — preserve exactly');
    } finally {
      await fs.rm(fixtureRepo, { recursive: true, force: true });
    }
  });
});

describe('projection-lock serialization across real producers (plan 31)', () => {
  /** Poll until N sessions are genuinely BLOCKED on this plan's advisory
   * namespace. classid 31031 is PROJECTION_LOCK_NAMESPACE, so this cannot be
   * satisfied by an unrelated advisory lock — and it is a real lock-wait
   * observation, never a timer. */
  async function waitForUngrantedProjectionLocks(n: number): Promise<void> {
    for (let attempt = 0; attempt < 400; attempt += 1) {
      const r = await admin.query<{ n: string }>(
        `SELECT count(*) AS n FROM pg_locks
          WHERE locktype = 'advisory' AND classid = 31031 AND NOT granted`
      );
      if (Number(r.rows[0].n) >= n) return;
      await new Promise<void>((resolve) => { setTimeout(resolve, 25); });
    }
    throw new Error(`never observed ${n} ungranted projection-lock wait(s)`);
  }

  const made: string[] = [];
  async function wiredProject(tag: string): Promise<{ slug: string; source: string; repo: string; initArgs: Parameters<typeof import('../scripts/init.js').runInit>[0] }> {
    const repo = await fs.mkdtemp(path.join(os.tmpdir(), `mai-lock-${tag}-`));
    const projectSlug = `plan31-lock-${tag}`;
    const source = `plan31-lock-src-${tag}`;
    made.push(projectSlug, source);
    await admin.query(`DELETE FROM projects WHERE slug = ANY($1::text[])`, [[projectSlug, source]]);
    await admin.query(`INSERT INTO projects (slug, name) VALUES ($1, $1)`, [source]);
    const initArgs = {
      slug: projectSlug, root: repo, repos: [repo], draftTopics: false, printSummary: false,
      harnesses: ['claude-code', 'codex'], llm: 'none' as const, embeddings: 'none' as const,
      yes: true, consentEnvFile: path.join(repo, 'consent-env'),
      sharedSkillsVerification: 'deferred' as const,
    };
    const { runInit } = await import('../scripts/init.js');
    const first = await runInit(initArgs);
    expect(first.verification.ok).toBe(true);
    return { slug: projectSlug, source, repo, initArgs };
  }

  const savedCodexHome = process.env.CODEX_HOME;
  let codexHome = '';
  beforeAll(async () => {
    // Keep mergeGlobalNotify away from the real ~/.codex.
    codexHome = await fs.mkdtemp(path.join(os.tmpdir(), 'mai-lock-codexhome-'));
    process.env.CODEX_HOME = codexHome;
  });
  afterAll(async () => {
    if (savedCodexHome === undefined) delete process.env.CODEX_HOME;
    else process.env.CODEX_HOME = savedCodexHome;
    await fs.rm(codexHome, { recursive: true, force: true });
    await admin.query(`DELETE FROM projects WHERE slug = ANY($1::text[])`, [made]);
  });

  it('a paused mai link blocks real runUpgrade AND real runInit on the projection lock', async () => {
    const { slug: projectSlug, source, repo, initArgs } = await wiredProject('a');
    const order: string[] = [];
    let release = (): void => {};
    let reached = (): void => {};
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const atLock = new Promise<void>((resolve) => { reached = resolve; });

    const { runLink } = await import('../scripts/link.js');
    const { runInit } = await import('../scripts/init.js');
    const { runUpgrade } = await import('../scripts/upgrade.js');
    const linkP = runLink({
      targetSlug: projectSlug, withSlug: source, yes: true,
      afterMetadataUpdate: async () => { order.push('link'); reached(); await gate; },
    });
    await atLock;

    const upgradeP = runUpgrade({
      slugs: [projectSlug], dryRun: false, yes: true,
      consentEnvFile: path.join(repo, 'consent-env'),
      afterProjectionRead: async () => { order.push('upgrade'); },
    });
    const initP = runInit({
      ...initArgs,
      afterProjectionRead: async () => { order.push('init'); },
    });

    // Both later producers are genuinely blocked, not merely slow.
    await waitForUngrantedProjectionLocks(2);
    expect(order).toEqual(['link']); // neither has reached its authority read

    release();
    await Promise.all([linkP, upgradeP, initP]);

    expect(order[0]).toBe('link');
    expect(order.slice(1).sort()).toEqual(['init', 'upgrade']);

    const meta = await admin.query<{ metadata: { linked_projects?: unknown } | null }>(
      `SELECT metadata FROM projects WHERE slug = $1`, [projectSlug]
    );
    expect(meta.rows[0].metadata?.linked_projects).toEqual([source]);
    expect(await fs.readFile(path.join(repo, '.mcp.json'), 'utf8'))
      .toContain(`"MAI_LINKED_PROJECTS": "${source}"`);
    expect(await fs.readFile(path.join(repo, '.codex', 'config.toml'), 'utf8'))
      .toContain(`MAI_LINKED_PROJECTS = "${source}"`);
    const { verifyProject } = await import('../scripts/verify.js');
    expect((await verifyProject(projectSlug, { sharedSkills: 'deferred' })).ok).toBe(true);
    await fs.rm(repo, { recursive: true, force: true });
  }, 180_000);

  it('a paused runUpgrade blocks mai link; the link mutation lands last and persists', async () => {
    const { slug: projectSlug, source, repo } = await wiredProject('b');
    const order: string[] = [];
    let release = (): void => {};
    let reached = (): void => {};
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const atLock = new Promise<void>((resolve) => { reached = resolve; });

    const { runUpgrade } = await import('../scripts/upgrade.js');
    const upgradeP = runUpgrade({
      slugs: [projectSlug], dryRun: false, yes: true,
      consentEnvFile: path.join(repo, 'consent-env'),
      afterProjectionRead: async () => { order.push('upgrade'); reached(); await gate; },
    });
    await atLock;

    const { runLink } = await import('../scripts/link.js');
    const linkP = runLink({
      targetSlug: projectSlug, withSlug: source, yes: true,
      afterMetadataUpdate: async () => { order.push('link'); },
    });

    await waitForUngrantedProjectionLocks(1);
    expect(order).toEqual(['upgrade']); // link has not read authority yet

    release();
    await Promise.all([upgradeP, linkP]);

    // The link ran strictly last, so its projection is the one that survives.
    expect(order).toEqual(['upgrade', 'link']);
    const meta = await admin.query<{ metadata: { linked_projects?: unknown } | null }>(
      `SELECT metadata FROM projects WHERE slug = $1`, [projectSlug]
    );
    expect(meta.rows[0].metadata?.linked_projects).toEqual([source]);
    expect(await fs.readFile(path.join(repo, '.mcp.json'), 'utf8'))
      .toContain(`"MAI_LINKED_PROJECTS": "${source}"`);
    expect(await fs.readFile(path.join(repo, '.codex', 'config.toml'), 'utf8'))
      .toContain(`MAI_LINKED_PROJECTS = "${source}"`);
    const { verifyProject } = await import('../scripts/verify.js');
    expect((await verifyProject(projectSlug, { sharedSkills: 'deferred' })).ok).toBe(true);
    await fs.rm(repo, { recursive: true, force: true });
  }, 180_000);
});
