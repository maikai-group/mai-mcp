/**
 * Plan 31 first-key coverage: link-aware config GENERATION and the mai link
 * lifecycle. The model fails closed, so a silently broken link write yields
 * fewer references, never more — which is exactly why generation needs its
 * own executable tests: a broken first key is otherwise invisible until an
 * operator notices a share never appearing. Covers both harness formats,
 * cancellation, legacy refusal, removal ordering under mid-fleet failure,
 * stale file/metadata preimage rejection, incomplete-wiring refusal,
 * explicit-empty scrubbing, and the DB-side verify link checks.
 */
import { beforeAll, afterAll, describe, expect, it } from 'vitest';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { Pool } from 'pg';
import { requireDisposableTestDbUrl } from './test-db-url.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const savedEnv = { MAI_DB_URL: process.env.MAI_DB_URL, CODEX_HOME: process.env.CODEX_HOME };
process.env.MAI_DB_URL = requireDisposableTestDbUrl();

const admin = new Pool({ connectionString: process.env.MAI_DB_URL });
let tmpRoot = '';
let repoA = '';
let repoB = '';
let legacyRepo = '';
let unwiredRepo = '';
let lateRepo = '';
let alternateLegacyRepo = '';

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}
const readOr = (p: string): Promise<string> => fs.readFile(p, 'utf8').catch(() => '');
const mcpOf = (repo: string): Promise<string> => readOr(path.join(repo, '.mcp.json'));
const tomlOf = (repo: string): Promise<string> => readOr(path.join(repo, '.codex', 'config.toml'));
const linkedMeta = async (): Promise<unknown> =>
  (await admin.query<{ metadata: { linked_projects?: unknown } | null }>(
    `SELECT metadata FROM projects WHERE slug = 'shr-link-b'`)).rows[0].metadata?.linked_projects;

async function expectProjectWriteBlocked(sql: string, params: readonly unknown[] = []): Promise<void> {
  const contender = await admin.connect();
  let lockTimedOut = false;
  try {
    await contender.query('BEGIN');
    await contender.query(`SET LOCAL lock_timeout = '150ms'`);
    try {
      await contender.query(sql, [...params]);
    } catch (err) {
      lockTimedOut = isRecord(err) && err.code === '55P03';
    }
    await contender.query('ROLLBACK');
  } finally {
    contender.release();
  }
  expect(lockTimedOut).toBe(true);
}

async function cleanup(): Promise<void> {
  await admin.query(`DELETE FROM projects WHERE slug LIKE 'shr-link-%'`);
}

beforeAll(async () => {
  await cleanup();
  tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'mai-link31-'));
  process.env.CODEX_HOME = path.join(tmpRoot, 'codex-home'); // keep mergeGlobalNotify away from ~/.codex
  await fs.mkdir(process.env.CODEX_HOME, { recursive: true });
  repoA = path.join(tmpRoot, 'repo-a');
  repoB = path.join(tmpRoot, 'repo-b');
  legacyRepo = path.join(tmpRoot, 'legacy-path-only');
  unwiredRepo = path.join(tmpRoot, 'registered-but-unwired');
  lateRepo = path.join(tmpRoot, 'late-registered');
  alternateLegacyRepo = path.join(tmpRoot, 'alternate-legacy-path');
  await fs.mkdir(path.join(repoA, '.codex'), { recursive: true });
  await fs.mkdir(repoB, { recursive: true });
  await fs.mkdir(legacyRepo, { recursive: true });
  await fs.mkdir(unwiredRepo, { recursive: true });
  await fs.mkdir(lateRepo, { recursive: true });
  await fs.mkdir(alternateLegacyRepo, { recursive: true });
  await admin.query(`INSERT INTO projects (slug, name) VALUES ('shr-link-a','LinkA')`);
  await admin.query(
    `INSERT INTO projects (slug, name, metadata) VALUES ('shr-link-b','LinkB', $1::jsonb)`,
    [JSON.stringify({ repos: [repoA, repoB], capture_harnesses: ['claude-code'] })]
  );
  await admin.query(
    `INSERT INTO projects (slug, name, path, metadata) VALUES ('shr-link-legacy','Legacy', $1, '{}'::jsonb)`,
    [legacyRepo]
  );
  await admin.query(`INSERT INTO projects (slug, name) VALUES ('shr-link-empty','Empty')`);
  await admin.query(
    `INSERT INTO projects (slug, name, metadata) VALUES ('shr-link-unwired','Unwired', $1::jsonb)`,
    [JSON.stringify({ repos: [unwiredRepo], capture_harnesses: ['claude-code'] })]
  );
  const { mergeMcpJson } = await import('../scripts/init.js');
  const { buildCodexInitialConfig } = await import('../capture/codex.js');
  await mergeMcpJson(repoA, 'shr-link-b');
  await mergeMcpJson(repoB, 'shr-link-b');
  await mergeMcpJson(legacyRepo, 'shr-link-legacy');
  await fs.writeFile(
    path.join(repoA, '.codex', 'config.toml'),
    buildCodexInitialConfig(repoA, 'shr-link-b', 'agent@codex')
  );
});

afterAll(async () => {
  for (const [k, v] of Object.entries(savedEnv)) {
    if (v === undefined) delete process.env[k]; else process.env[k] = v;
  }
  await fs.chmod(repoB, 0o755).catch(() => {});
  await fs.rm(tmpRoot, { recursive: true, force: true });
  await cleanup();
  await admin.end();
  const { getPool } = await import('../db.js');
  await getPool().end();
});

describe('builders (plan 31 R10 — empty case byte-identical)', () => {
  it('buildMcpServerEntry renders sorted links; empty === legacy byte-for-byte', async () => {
    const { buildMcpServerEntry } = await import('../scripts/init.js');
    const linked = buildMcpServerEntry('/r', 's', 'a@c', ['b-proj', 'a-proj']);
    const env: unknown = linked.env;
    expect(isRecord(env) ? env.MAI_LINKED_PROJECTS : undefined).toBe('a-proj,b-proj');
    expect(JSON.stringify(buildMcpServerEntry('/r', 's', 'a@c', []))).toBe(
      JSON.stringify(buildMcpServerEntry('/r', 's', 'a@c'))
    );
    expect(JSON.stringify(buildMcpServerEntry('/r', 's', 'a@c'))).not.toContain('MAI_LINKED_PROJECTS');
  });

  it('buildCodexBlock emits the TOML line after MAI_PROJECT_ROOT; empty === legacy byte-for-byte', async () => {
    const { buildCodexBlock } = await import('../capture/codex.js');
    const { MAI_ROOT } = await import('../paths.js');
    const withLinks = buildCodexBlock('/r', 's', 'a@x', MAI_ROOT, ['b-proj', 'a-proj']);
    expect(withLinks.indexOf('MAI_LINKED_PROJECTS = "a-proj,b-proj"'))
      .toBeGreaterThan(withLinks.indexOf('MAI_PROJECT_ROOT'));
    expect(buildCodexBlock('/r', 's', 'a@x', MAI_ROOT, [])).toBe(buildCodexBlock('/r', 's', 'a@x'));
    expect(buildCodexBlock('/r', 's', 'a@x')).not.toContain('MAI_LINKED_PROJECTS');
  });

  it('mergeMcpJson preserves from file when opts omit, honours explicit list, scrubs on explicit []', async () => {
    const { mergeMcpJson } = await import('../scripts/init.js');
    const dir = await fs.mkdtemp(path.join(tmpRoot, 'merge-'));
    await mergeMcpJson(dir, 'demo', { linkedProjects: ['src-a'] });
    expect(await mcpOf(dir)).toContain('"MAI_LINKED_PROJECTS": "src-a"');
    await mergeMcpJson(dir, 'demo'); // no opts → preserve-from-file
    expect(await mcpOf(dir)).toContain('"MAI_LINKED_PROJECTS": "src-a"');
    await mergeMcpJson(dir, 'demo', { linkedProjects: [] }); // explicit none → scrubbed
    expect(await mcpOf(dir)).not.toContain('MAI_LINKED_PROJECTS');
  });
});

describe('runLink lifecycle (both harness formats)', () => {
  it('add: metadata + BOTH formats gain the link (yes-mode, no prompt)', async () => {
    const { runLink } = await import('../scripts/link.js');
    const out = await runLink({ targetSlug: 'shr-link-b', withSlug: 'shr-link-a', yes: true });
    expect(out).toContain("declared links for 'shr-link-b': shr-link-a");
    expect(await linkedMeta()).toEqual(['shr-link-a']);
    expect(await mcpOf(repoA)).toContain('"MAI_LINKED_PROJECTS": "shr-link-a"');
    expect(await mcpOf(repoB)).toContain('"MAI_LINKED_PROJECTS": "shr-link-a"');
    expect(await tomlOf(repoA)).toContain('MAI_LINKED_PROJECTS = "shr-link-a"');
  });

  it('cancellation changes NOTHING (confirm seam returns false)', async () => {
    const { runLink } = await import('../scripts/link.js');
    const out = await runLink({
      targetSlug: 'shr-link-b', removeSlug: 'shr-link-a', confirm: async () => false,
    });
    expect(out).toBe('cancelled — nothing was changed.');
    expect(await linkedMeta()).toEqual(['shr-link-a']);
    expect(await mcpOf(repoA)).toContain('MAI_LINKED_PROJECTS');
  });

  it('legacy block anywhere ABORTS the whole operation before any write', async () => {
    const { runLink } = await import('../scripts/link.js');
    const legacyToml = path.join(repoB, '.codex', 'config.toml');
    await fs.mkdir(path.dirname(legacyToml), { recursive: true });
    await fs.writeFile(legacyToml, '[mcp_servers.mai-mcp]\ncommand = "node"\n\n[mcp_servers.mai-mcp.env]\nMAI_PROJECT_SLUG = "shr-link-b"\n');
    try {
      await expect(runLink({ targetSlug: 'shr-link-b', removeSlug: 'shr-link-a', yes: true }))
        .rejects.toThrow(/ABORTED — legacy managed block[\s\S]*Nothing was changed/);
      expect(await linkedMeta()).toEqual(['shr-link-a']);
      expect(await mcpOf(repoA)).toContain('MAI_LINKED_PROJECTS');
    } finally {
      await fs.rm(legacyToml);
    }
  });

  it('the built CLI exits 1 on a legacy refusal and preserves metadata/files', async () => {
    const legacyToml = path.join(legacyRepo, '.codex', 'config.toml');
    await fs.mkdir(path.dirname(legacyToml), { recursive: true });
    await fs.writeFile(legacyToml, '[mcp_servers.mai-mcp]\ncommand = "node"\n\n[mcp_servers.mai-mcp.env]\nMAI_PROJECT_SLUG = "shr-link-legacy"\n');
    try {
      const result = spawnSync(process.execPath, [
        path.join(ROOT, 'build', 'entry.js'), 'link', 'shr-link-legacy',
        '--with', 'shr-link-a', '--yes',
      ], {
        encoding: 'utf8',
        env: { ...process.env, MAI_DB_URL: process.env.MAI_DB_URL, CODEX_HOME: process.env.CODEX_HOME },
      });
      expect(result.status).toBe(1);
      expect(result.stderr).toMatch(/ABORTED — legacy managed block[\s\S]*Nothing was changed/);
      const metadata = (await admin.query<{ metadata: { linked_projects?: unknown } | null }>(
        `SELECT metadata FROM projects WHERE slug='shr-link-legacy'`
      )).rows[0].metadata;
      expect(metadata?.linked_projects).toBeUndefined();
      expect(await mcpOf(legacyRepo)).not.toContain('MAI_LINKED_PROJECTS');
    } finally {
      await fs.rm(legacyToml);
    }
  });

  it('removal with a mid-fleet write failure leaves metadata DECLARED (fail-closed accurate)', async () => {
    const { runLink } = await import('../scripts/link.js');
    await fs.chmod(repoB, 0o555); // second repo unwritable
    try {
      await expect(runLink({ targetSlug: 'shr-link-b', removeSlug: 'shr-link-a', yes: true }))
        .rejects.toThrow(/env removal FAILED[\s\S]*declared links UNCHANGED/);
      expect(await linkedMeta()).toEqual(['shr-link-a']); // still declared — a repo still grants it
    } finally {
      await fs.chmod(repoB, 0o755);
    }
  });

  it('removal completes once every repo is writable: env scrubbed FIRST, then metadata', async () => {
    const { runLink } = await import('../scripts/link.js');
    const out = await runLink({ targetSlug: 'shr-link-b', removeSlug: 'shr-link-a', yes: true });
    expect(out).toContain("declared links for 'shr-link-b': (none)");
    expect(await linkedMeta()).toEqual([]);
    expect(await mcpOf(repoA)).not.toContain('MAI_LINKED_PROJECTS');
    expect(await mcpOf(repoB)).not.toContain('MAI_LINKED_PROJECTS');
    expect(await tomlOf(repoA)).not.toContain('MAI_LINKED_PROJECTS');
  });

  it('addition failure is nonzero while the committed declaration remains fail-closed and repairable', async () => {
    const { runLink } = await import('../scripts/link.js');
    await fs.chmod(repoB, 0o555);
    try {
      await expect(runLink({ targetSlug: 'shr-link-b', withSlug: 'shr-link-a', yes: true }))
        .rejects.toThrow(/env addition FAILED[\s\S]*access stays fail-closed/);
      expect(await linkedMeta()).toEqual(['shr-link-a']);
      expect(await mcpOf(repoA)).toContain('MAI_LINKED_PROJECTS');
      expect(await mcpOf(repoB)).not.toContain('MAI_LINKED_PROJECTS');
    } finally {
      await fs.chmod(repoB, 0o755);
      // Same-link re-run repairs the incomplete env projection; then return
      // the shared fixture to the empty state expected by later tests.
      await runLink({ targetSlug: 'shr-link-b', withSlug: 'shr-link-a', yes: true });
      await runLink({ targetSlug: 'shr-link-b', removeSlug: 'shr-link-a', yes: true });
    }
  });

  it('rejects a config edit after planning and preserves the newer whole file', async () => {
    const { runLink } = await import('../scripts/link.js');
    const mcpPath = path.join(repoA, '.mcp.json');
    await expect(runLink({
      targetSlug: 'shr-link-b', withSlug: 'shr-link-a', yes: true,
      beforeApply: async () => {
        const parsed: unknown = JSON.parse(await fs.readFile(mcpPath, 'utf8'));
        if (!isRecord(parsed) || !isRecord(parsed.mcpServers)) throw new Error('bad test fixture');
        parsed.mcpServers['user-added'] = { command: 'user-tool' };
        await fs.writeFile(mcpPath, JSON.stringify(parsed, null, 2) + '\n');
      },
    })).rejects.toThrow(/changed after review/);
    expect(await mcpOf(repoA)).toContain('user-added');
    expect(await linkedMeta()).toEqual([]);
  });

  it('guards a required harness file even when that file planned no change', async () => {
    const { mergeMcpJson } = await import('../scripts/init.js');
    const { runLink } = await import('../scripts/link.js');
    const mcpPath = path.join(repoA, '.mcp.json');
    const original = await fs.readFile(mcpPath, 'utf8');
    await mergeMcpJson(repoA, 'shr-link-b', { linkedProjects: ['shr-link-a'] });
    try {
      await expect(runLink({
        targetSlug: 'shr-link-b', withSlug: 'shr-link-a', yes: true,
        beforeApply: async () => {
          const parsed: unknown = JSON.parse(await fs.readFile(mcpPath, 'utf8'));
          if (!isRecord(parsed) || !isRecord(parsed.mcpServers)) throw new Error('bad test fixture');
          parsed.mcpServers['late-user-entry'] = { command: 'late-tool' };
          await fs.writeFile(mcpPath, JSON.stringify(parsed, null, 2) + '\n');
        },
      })).rejects.toThrow(/changed after review/);
      expect(await mcpOf(repoA)).toContain('late-user-entry');
      expect(await mcpOf(repoB)).not.toContain('MAI_LINKED_PROJECTS');
      expect(await linkedMeta()).toEqual([]);
    } finally {
      await fs.writeFile(mcpPath, original);
    }
  });

  it('compare-and-swap rejects concurrent linked_projects mutation before any env write', async () => {
    const { runLink } = await import('../scripts/link.js');
    await expect(runLink({
      targetSlug: 'shr-link-b', withSlug: 'shr-link-a', yes: true,
      beforeApply: async () => {
        await admin.query(
          `UPDATE projects SET metadata=jsonb_set(metadata, '{linked_projects}', '["shr-link-empty"]'::jsonb)
            WHERE slug='shr-link-b'`
        );
      },
    })).rejects.toThrow(/Declared links or repo\/harness registry changed after review/);
    expect(await linkedMeta()).toEqual(['shr-link-empty']);
    expect(await mcpOf(repoA)).not.toContain('MAI_LINKED_PROJECTS');
    await admin.query(
      `UPDATE projects SET metadata=jsonb_set(metadata, '{linked_projects}', '[]'::jsonb)
        WHERE slug='shr-link-b'`
    );
  });

  it('CAS rejects a repo registered after planning and never reports the old fleet complete', async () => {
    const { runLink } = await import('../scripts/link.js');
    await expect(runLink({
      targetSlug: 'shr-link-b', withSlug: 'shr-link-a', yes: true,
      beforeApply: async () => {
        await admin.query(
          `UPDATE projects SET metadata=jsonb_set(metadata, '{repos}', $1::jsonb) WHERE slug='shr-link-b'`,
          [JSON.stringify([repoA, repoB, lateRepo])]
        );
      },
    })).rejects.toThrow(/repo\/harness registry changed after review/);
    expect(await linkedMeta()).toEqual([]);
    expect(await mcpOf(repoA)).not.toContain('MAI_LINKED_PROJECTS');
    await admin.query(
      `UPDATE projects SET metadata=jsonb_set(metadata, '{repos}', $1::jsonb) WHERE slug='shr-link-b'`,
      [JSON.stringify([repoA, repoB])]
    );
  });

  it('holds the project-row lock from addition CAS through env end-state validation', async () => {
    const { runLink } = await import('../scripts/link.js');
    const out = await runLink({
      targetSlug: 'shr-link-b', withSlug: 'shr-link-a', yes: true,
      afterMetadataUpdate: async () => {
        // Both the link authority and the repo registry are serialized across
        // the exact former CAS-to-first-file race window.
        await expectProjectWriteBlocked(
          `UPDATE projects SET metadata=jsonb_set(metadata, '{linked_projects}', '["shr-link-empty"]'::jsonb)
            WHERE slug='shr-link-b'`
        );
        await expectProjectWriteBlocked(
          `UPDATE projects SET metadata=jsonb_set(metadata, '{repos}', $1::jsonb) WHERE slug='shr-link-b'`,
          [JSON.stringify([repoA, repoB, lateRepo])]
        );
      },
    });
    expect(out).toContain("declared links for 'shr-link-b': shr-link-a");
    expect(await linkedMeta()).toEqual(['shr-link-a']);
    expect(await mcpOf(repoA)).toContain('MAI_LINKED_PROJECTS');
    expect(await mcpOf(repoB)).toContain('MAI_LINKED_PROJECTS');
    await runLink({ targetSlug: 'shr-link-b', removeSlug: 'shr-link-a', yes: true });
  });

  it('CAS rejects a capture-harness union changed after planning', async () => {
    const { runLink } = await import('../scripts/link.js');
    await expect(runLink({
      targetSlug: 'shr-link-b', withSlug: 'shr-link-a', yes: true,
      beforeApply: async () => {
        await admin.query(
          `UPDATE projects SET metadata=jsonb_set(metadata, '{capture_harnesses}', '["claude-code","codex"]'::jsonb)
            WHERE slug='shr-link-b'`
        );
      },
    })).rejects.toThrow(/repo\/harness registry changed after review/);
    expect(await linkedMeta()).toEqual([]);
    await admin.query(
      `UPDATE projects SET metadata=jsonb_set(metadata, '{capture_harnesses}', '["claude-code"]'::jsonb)
        WHERE slug='shr-link-b'`
    );
  });

  it('CAS rejects a generic rules file changed after planning without touching the reviewed files', async () => {
    const { runLink } = await import('../scripts/link.js');
    const beforeA = await mcpOf(repoA);
    const beforeB = await mcpOf(repoB);
    const beforeLinks = await linkedMeta();
    await expect(runLink({
      targetSlug: 'shr-link-b', withSlug: 'shr-link-a', yes: true,
      beforeApply: async () => {
        await admin.query(
          `UPDATE projects SET metadata=jsonb_set(metadata, '{generic_rules_file}', '"AGENTS.md"'::jsonb)
            WHERE slug='shr-link-b'`
        );
      },
    })).rejects.toThrow(/repo\/harness registry changed after review/);
    expect(await linkedMeta()).toEqual(beforeLinks);
    expect(await mcpOf(repoA)).toBe(beforeA);
    expect(await mcpOf(repoB)).toBe(beforeB);
    await admin.query(
      `UPDATE projects SET metadata=metadata - 'generic_rules_file' WHERE slug='shr-link-b'`
    );
  });

  it('CAS rejects a legacy path fallback changed after planning', async () => {
    const { runLink } = await import('../scripts/link.js');
    await expect(runLink({
      targetSlug: 'shr-link-legacy', withSlug: 'shr-link-a', yes: true,
      beforeApply: async () => {
        await admin.query(`UPDATE projects SET path=$1 WHERE slug='shr-link-legacy'`, [alternateLegacyRepo]);
      },
    })).rejects.toThrow(/repo\/harness registry changed after review/);
    expect(await mcpOf(legacyRepo)).not.toContain('MAI_LINKED_PROJECTS');
    await admin.query(`UPDATE projects SET path=$1 WHERE slug='shr-link-legacy'`, [legacyRepo]);
  });

  it('explicit-empty applyEnvChanges scrubs a stale env value (the re-init path, both formats)', async () => {
    const { mergeMcpJson } = await import('../scripts/init.js');
    const { applyEnvChanges } = await import('../scripts/link.js');
    await mergeMcpJson(repoA, 'shr-link-b', { linkedProjects: ['stale-src'] }); // simulate staleness
    expect(await mcpOf(repoA)).toContain('stale-src');
    const refresh = await applyEnvChanges(repoA, 'shr-link-b', []);
    expect(refresh.refusedLegacy).toBe(false);
    expect(await mcpOf(repoA)).not.toContain('MAI_LINKED_PROJECTS');
    expect(await tomlOf(repoA)).not.toContain('MAI_LINKED_PROJECTS');
  });

  it('legacy projects.path is a real repo target for status, add, and remove', async () => {
    const { runLink } = await import('../scripts/link.js');
    const status = await runLink({ targetSlug: 'shr-link-legacy' });
    expect(status).toContain(legacyRepo);
    const added = await runLink({ targetSlug: 'shr-link-legacy', withSlug: 'shr-link-a', yes: true });
    expect(added).toContain("declared links for 'shr-link-legacy': shr-link-a");
    expect(await mcpOf(legacyRepo)).toContain('"MAI_LINKED_PROJECTS": "shr-link-a"');
    const removed = await runLink({ targetSlug: 'shr-link-legacy', removeSlug: 'shr-link-a', yes: true });
    expect(removed).toContain("declared links for 'shr-link-legacy': (none)");
    expect(await mcpOf(legacyRepo)).not.toContain('MAI_LINKED_PROJECTS');
  });

  it('a project with no registered repo cannot report a successful mutation', async () => {
    const { runLink } = await import('../scripts/link.js');
    await expect(runLink({ targetSlug: 'shr-link-empty', withSlug: 'shr-link-a', yes: true }))
      .rejects.toThrow(/no registered repos/);
    const metadata = (await admin.query<{ metadata: { linked_projects?: unknown } | null }>(
      `SELECT metadata FROM projects WHERE slug='shr-link-empty'`
    )).rows[0].metadata;
    expect(metadata?.linked_projects).toBeUndefined();
  });

  it('a registered but unwired repo aborts before metadata and cannot report current', async () => {
    const { runLink } = await import('../scripts/link.js');
    await expect(runLink({ targetSlug: 'shr-link-unwired', withSlug: 'shr-link-a', yes: true }))
      .rejects.toThrow(/not ready for link env updates.*re-run mai init/);
    const metadata = (await admin.query<{ metadata: { linked_projects?: unknown } | null }>(
      `SELECT metadata FROM projects WHERE slug='shr-link-unwired'`
    )).rows[0].metadata;
    expect(metadata?.linked_projects).toBeUndefined();
  });
});

describe('verify link checks', () => {
  it('verifyRepo flags declared-vs-written drift and passes when parity holds', async () => {
    const { verifyRepo } = await import('../scripts/verify.js');
    const drifted = await verifyRepo(repoA, 'shr-link-b', undefined, repoA, ['shr-link-a']);
    const mcpCheck = drifted.checks.find((c) => c.name === '.mcp.json');
    expect(mcpCheck?.ok).toBe(false);
    expect(mcpCheck?.detail).toContain('MAI_LINKED_PROJECTS');
    const clean = await verifyRepo(repoA, 'shr-link-b', undefined, repoA, []);
    expect(clean.checks.find((c) => c.name === '.mcp.json')?.ok).toBe(true);
  });

  it('linkSharedChecks FAILS a declared slug that resolves to no project (rename goes dark, loudly)', async () => {
    const { linkSharedChecks } = await import('../scripts/verify.js');
    const okChecks = await linkSharedChecks('shr-link-b', { linked_projects: ['shr-link-a'] });
    expect(okChecks.find((c) => c.name === 'link:shr-link-a')?.ok).toBe(true);
    await admin.query(`UPDATE projects SET slug = 'shr-link-a2' WHERE slug = 'shr-link-a'`);
    try {
      const renamed = await linkSharedChecks('shr-link-b', { linked_projects: ['shr-link-a'] });
      const row = renamed.find((c) => c.name === 'link:shr-link-a');
      expect(row?.ok).toBe(false);
      expect(row?.detail).toContain('matches no project');
    } finally {
      await admin.query(`UPDATE projects SET slug = 'shr-link-a' WHERE slug = 'shr-link-a2'`);
    }
  });
});
