/** Plan 25 R9: the skills gates run in `npm test`. The precedent is
 * read-budget.test.ts, which shells out to scripts/check-read-budgets.mjs —
 * a gate nobody runs is a gate that does not exist. */
import { describe, expect, it } from 'vitest';
import { execFileSync, spawnSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { snapshotRelease } from './support/release-snapshot.js';

const runCommand = (
  command: string,
  args: string[],
  env: NodeJS.ProcessEnv = process.env,
): { status: number; out: string } => {
  try {
    return { status: 0, out: execFileSync(command, args, { encoding: 'utf8', env }) };
  } catch (err) {
    const record = err !== null && typeof err === 'object' ? err : {};
    const status = Reflect.get(record, 'status');
    const stdout = Reflect.get(record, 'stdout');
    const stderr = Reflect.get(record, 'stderr');
    return {
      status: typeof status === 'number' ? status : 1,
      out: `${typeof stdout === 'string' ? stdout : ''}${typeof stderr === 'string' ? stderr : ''}`,
    };
  }
};
const run = (args: string[]): { status: number; out: string } => runCommand('node', args);

/** The README's platform-support section: the table, the launch-gate line, the
 * vendor citations and both quickstarts, normalized for a byte comparison. */
function supportBlock(text: string): string {
  const normalized = text.replace(/\r\n/g, '\n');
  const start = normalized.indexOf('## Platform support');
  const end = normalized.indexOf('## Who it is for');
  if (start < 0 || end < start) throw new Error('README has no platform-support section');
  return normalized.slice(start, end).replace(/[ \t]+\n/g, '\n').trim();
}

/** Support truth: the table may never promote Windows 10, drop the Codex
 * qualifier, lose the WSL2 Linux-mode row, or claim to work everywhere. */
function assertSupportTruth(text: string): void {
  const block = supportBlock(text);
  if (/\|\s*Windows 10\s*\|[^|]*first-class/i.test(block)) throw new Error('Windows 10 overclaim');
  if (!block.includes('Codex in its vendor-supported native-Windows form')) throw new Error('Codex qualifier missing');
  if (!block.includes('| Windows 11 (WSL2) | First-class Linux mode |')) throw new Error('WSL2 Linux-mode row missing');
  // The overclaim literals are assembled from parts so this shipped test source
  // never itself trips the assembled-tree overclaim scan.
  if (new RegExp(['works', 'everywhere'].join(' '), 'i').test(text)) throw new Error(['works', 'everywhere overclaim'].join(' '));
}

/** A complete, all-true receipt shape (the schema's own sample); tests set reviewedSha. */
const RELEASABLE_RECEIPT = {
  schema: 1,
  platform: { os: 'Windows 11', osBuild: '26100', architecture: 'AMD64', nonAdmin: true },
  versions: { node: 'v24.19.0', npm: '11.17.0', git: '2.47.1', docker: '27.3.1', claude: '2.1.0', codex: '0.120.0' },
  release: { reviewedSha: '0'.repeat(40), runtimeVersion: '0.15.1', installerVersion: '1.0.0', runtimeTreeSha256: 'b'.repeat(64), installerPackageSha256: 'c'.repeat(64) },
  automated: Object.fromEntries(['installerExistingCheckout', 'setup', 'database', 'migrations', 'verifySmoke', 'mcpSurface', 'wiring', 'dashboard', 'scratchEndCleanup', 'scratchPrune', 'janitorSchedule', 'backupRestore', 'backupSchedule', 'rerunIdempotent'].map((k) => [k, true])),
  manual: Object.fromEntries(['claudeRestarted', 'claudePrime', 'claudeCapture', 'claudeProviderStatus', 'claudeHooksLive', 'codexRestarted', 'codexPrime', 'codexCapture', 'codexProviderStatus', 'codexNotifyLive'].map((k) => [k, true])),
  scheduledPersistence: { taskName: 'mai-mcp-dashboard', installed: true, restartedAfterKill: true, survivedSignOutSignIn: true, tokenAbsent: true, uninstalled: true },
  timestamps: { automatedCompletedAt: '2026-09-14T01:00:00Z', manualCompletedAt: '2026-09-14T02:00:00Z' },
};

describe('skills suite gates', () => {
  it('every shipped skill passes every package and workflow gate', () => {
    const r = run(['scripts/check-skills.mjs']);
    expect(r.out).toContain('skills gate: clean');
    expect(r.status).toBe(0);
  });

  it('the shared workflow blocks have not drifted from their sources', () => {
    const r = run(['scripts/sync-skill-blocks.mjs', '--check']);
    expect(r.out).toContain('skill-blocks: in sync');
    expect(r.status).toBe(0);
  });

  it('the shared-block parity gate rejects drift, duplicates, missing markers, and reversal', () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'mai-skill-parity-'));
    try {
      for (const rel of [
        'scripts/sync-skill-blocks.mjs',
        'skill-blocks/epistemics.md',
        'skill-blocks/cleanup.md',
        'skills/receiving-plan-review/SKILL.md',
        'skills/mai-receiving-code-review/SKILL.md',
      ]) {
        const target = path.join(tmp, rel);
        fs.mkdirSync(path.dirname(target), { recursive: true });
        fs.copyFileSync(rel, target);
      }
      const consumer = path.join(tmp, 'skills/receiving-plan-review/SKILL.md');
      const current = fs.readFileSync(consumer, 'utf8');
      expect(current).toContain('**Verify the premise before acting on it.**');
      // Negative control: the unmutated fixture must PASS. Without this, a copy
      // list that has fallen behind the real consumer list makes the tree fail
      // for its own reason, and every `status).toBe(1)` below passes vacuously.
      const clean = run([path.join(tmp, 'scripts/sync-skill-blocks.mjs'), '--check']);
      expect(clean.out).toContain('skill-blocks: in sync');
      expect(clean.status).toBe(0);
      const rejects = (text: string, message: string) => {
        fs.writeFileSync(consumer, text);
        const r = run([path.join(tmp, 'scripts/sync-skill-blocks.mjs'), '--check']);
        expect(r.out).toContain(message);
        expect(r.status).toBe(1);
      };
      rejects(current.replace(
        '**Verify the premise before acting on it.**',
        '**Verify the changed premise before acting on it.**',
      ), 'has drifted');

      const start = '<!-- mai:shared:epistemics start';
      const end = '<!-- mai:shared:epistemics end -->';
      const startIdx = current.indexOf(start);
      const endIdx = current.indexOf(end);
      expect(startIdx).toBeGreaterThanOrEqual(0);
      expect(endIdx).toBeGreaterThan(startIdx);
      const block = current.slice(startIdx, endIdx + end.length);
      const driftedSecond = block.replace('**Verify the premise before acting on it.**', '**Changed second copy.**');
      rejects(`${current}\n${driftedSecond}\n`, 'exactly one epistemics start and end marker');
      rejects(current.replace(start, '<!-- missing epistemics start'), 'exactly one epistemics start and end marker');
      rejects(current.replace(block, `${end}\n${start}`), 'markers out of order');
      fs.writeFileSync(consumer, current);

      // New entrypoints cannot evade cleanup by omitting both markers.
      const addedSkill = path.join(tmp, 'skills/new-workflow/SKILL.md');
      fs.mkdirSync(path.dirname(addedSkill), { recursive: true });
      fs.writeFileSync(addedSkill, '# New workflow\n');
      const missingCleanup = run([path.join(tmp, 'scripts/sync-skill-blocks.mjs'), '--check']);
      expect(missingCleanup.status).toBe(1);
      expect(missingCleanup.out).toContain('new-workflow/SKILL.md must have exactly one cleanup start and end marker');
      const cleanupStart = current.indexOf('<!-- mai:shared:cleanup start');
      const cleanupEndMarker = '<!-- mai:shared:cleanup end -->';
      const cleanupEnd = current.indexOf(cleanupEndMarker);
      expect(cleanupStart).toBeGreaterThanOrEqual(0);
      expect(cleanupEnd).toBeGreaterThan(cleanupStart);
      fs.appendFileSync(addedSkill, current.slice(cleanupStart, cleanupEnd + cleanupEndMarker.length));
      expect(run([path.join(tmp, 'scripts/sync-skill-blocks.mjs'), '--check']).status).toBe(0);
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  it('the gates discriminate — conforming fixtures pass, verbs are not tool names', () => {
    const r = run(['scripts/check-skills.mjs', '--self-test']);
    expect(r.out).toContain('skills gate self-test OK');
    expect(r.status).toBe(0);
  });

  it('every known mutation is rejected, at the dedicated status', () => {
    const r = run(['scripts/check-skills.mjs', '--mutation-test']);
    // 42, not merely non-zero: an unrelated crash must not read as protection.
    expect(r.status).toBe(42);
    // Each retained mutant must fail at its intended gate. The fixture set may
    // shrink when policy is retired; do not require a monotonically growing census.
    expect(r.out).toMatch(/all [1-9][0-9]* skill-gate mutations rejected/);
  });

  it('routes the importer broad -> repair -> clean delta sequence without clearance', () => {
    const route = path.resolve('skills/plan-review-cycle/scripts/review-route.mjs');
    const invoke = (overrides: Record<string, string> = {}) => {
      const state = {
        'architecture-epoch': 'E1', 'broad-reviewed-epoch': 'E1',
        'last-breadth': 'broad', 'last-verdict': 'approved',
        'repair-scope': 'none', risk: 'standard',
        'findings-dispositioned': 'true', 'blocked-streak': '0',
        ...overrides,
      };
      return run([route, ...Object.entries(state).flatMap(([k, v]) => ['--' + k, v])]);
    };
    const expectRoute = (state: Record<string, string>, breadth: string, strength?: string) => {
      const r = invoke(state);
      expect(r.status, r.out).toBe(0);
      expect(JSON.parse(r.out).nextBreadth).toBe(breadth);
      if (strength) expect(JSON.parse(r.out).strength).toBe(strength);
    };

    expectRoute({
      'broad-reviewed-epoch': 'none', 'last-breadth': 'none', 'last-verdict': 'none',
    }, 'broad');
    expectRoute({
      'last-verdict': 'blocked', 'blocked-streak': '1', 'repair-scope': 'bounded',
    }, 'delta');
    expectRoute({
      'last-verdict': 'blocked', 'blocked-streak': '1', 'repair-scope': 'bounded', risk: 'high-risk',
    }, 'delta', 'clearance');
    expectRoute({ 'last-breadth': 'delta' }, 'terminate');
    expectRoute({}, 'terminate'); // clean first broad also closes
    expectRoute({ 'repair-scope': 'editorial' }, 'editorial-check');
    expectRoute({
      'last-verdict': 'blocked', 'blocked-streak': '0', 'repair-scope': 'editorial',
    }, 'editorial-check'); // only editorial findings, dispositioned with evidence
    expectRoute({ 'repair-scope': 'bounded' }, 'delta'); // new change after approval
    expectRoute({
      'architecture-epoch': 'E2', 'repair-scope': 'architecture', risk: 'high-risk',
    }, 'broad', 'clearance');

    const missingCoverage = invoke({ 'broad-reviewed-epoch': 'none', 'last-breadth': 'delta' });
    expect(missingCoverage.status).toBe(2);
    const openFindings = invoke({ 'findings-dispositioned': 'false' });
    expect(openFindings.status).toBe(2);
    const mixed = invoke({ 'last-breadth': 'none' });
    expect(mixed.status).toBe(2);
    expect(mixed.out).toContain('both be none');
    const staleScope = invoke({ 'repair-scope': 'architecture' });
    expect(staleScope.status).toBe(2);
    const invalid = invoke({ 'final-clearance': 'automatic' });
    expect(invalid.status).toBe(2);
    const invalidBool = invoke({ 'clearance-covered': 'maybe' });
    expect(invalidBool.status).toBe(2);

    // Exhaustive review is explicit, and even it does not repeat after a bounded repair.
    expectRoute({ 'final-clearance': 'exhaustive' }, 'clearance');
    expectRoute({ 'final-clearance': 'exhaustive', 'last-breadth': 'clearance' }, 'terminate');
    expectRoute({
      'final-clearance': 'exhaustive', 'last-breadth': 'clearance',
      'last-verdict': 'blocked', 'blocked-streak': '1', 'repair-scope': 'bounded',
      'clearance-covered': 'true',
    }, 'delta');
    expectRoute({
      'final-clearance': 'exhaustive', 'last-breadth': 'delta', 'clearance-covered': 'true',
    }, 'terminate');
    expect(invoke({
      'architecture-epoch': 'E2', 'repair-scope': 'architecture', 'clearance-covered': 'true',
    }).status).toBe(2);

    expectRoute({
      'last-verdict': 'blocked', 'blocked-streak': '1', 'repair-scope': 'bounded',
      'scope-escape-epoch': 'E2', 'clearance-covered': 'true',
    }, 'broad');
    expect(invoke({
      'last-verdict': 'blocked', 'blocked-streak': '1', 'repair-scope': 'bounded',
      'scope-escape-epoch': 'E1',
    }).status).toBe(2);
    const stalled = {
      'last-verdict': 'blocked', 'blocked-streak': '2', 'repair-scope': 'bounded',
    };
    expect(invoke(stalled).status).toBe(2);
    expect(invoke(stalled).out).toContain('review-stalled');
    expectRoute({ ...stalled, 'operator-continue': 'true' }, 'delta');
  });

  it('the support table and quickstarts are byte-equal in the private and public-source READMEs and reject overclaims', () => {
    // Private-source only: the assembled package ships one README and no
    // release/public source, so its nested run has nothing to compare.
    if (!fs.existsSync(path.join('release', 'public', 'README.md'))) return;
    const privateReadme = fs.readFileSync('README.md', 'utf8');
    const publicReadme = fs.readFileSync(path.join('release', 'public', 'README.md'), 'utf8');
    expect(supportBlock(privateReadme)).toBe(supportBlock(publicReadme));
    expect(supportBlock(privateReadme).length).toBeGreaterThan(400);
    expect(supportBlock(privateReadme)).toContain('npx mai-mcp setup --yes -- --slug my-project --root $PWD.Path --harness all');
    expect(supportBlock(privateReadme)).toMatch(/Vendor claims re-read \d{4}-\d{2}-\d{2}/);
    for (const text of [privateReadme, publicReadme]) expect(() => assertSupportTruth(text)).not.toThrow();
    for (const doc of ['docs/configuration.md', 'docs/harnesses.md', 'installer/README.md']) {
      expect(fs.readFileSync(doc, 'utf8')).not.toMatch(new RegExp(['works', 'everywhere'].join(' '), 'i'));
    }

    // Mutants: promote Windows 10, or drop the Codex qualifier — both must fail.
    const promotedRow = [
      '| Windows 10 | ',
      'First-class |',
    ].join('');
    const upgraded = privateReadme.replace('| Windows 10 | Best effort |', promotedRow);
    expect(upgraded).not.toBe(privateReadme);
    expect(() => assertSupportTruth(upgraded)).toThrow('Windows 10 overclaim');
    const unqualified = privateReadme.replace('Codex in its vendor-supported native-Windows form', 'Codex');
    expect(unqualified).not.toBe(privateReadme);
    expect(() => assertSupportTruth(unqualified)).toThrow('Codex qualifier missing');

    // The assembled-tree leak gate rejects the Windows 10 promotion mechanically.
    const gate = path.resolve('scripts/release-leak-check.sh');
    if (!fs.existsSync(gate)) return;
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'mai-support-truth-'));
    try {
      const scripts = path.join(tmp, 'scripts');
      fs.mkdirSync(scripts);
      fs.copyFileSync(gate, path.join(scripts, 'release-leak-check.sh'));
      fs.writeFileSync(path.join(scripts, 'release-leak-content-allowlist.txt'), '');
      const tree = path.join(tmp, 'tree');
      fs.mkdirSync(path.join(tree, 'docs'), { recursive: true });
      fs.writeFileSync(path.join(tree, 'README.md'), privateReadme);
      const clean = runCommand('bash', [path.join(scripts, 'release-leak-check.sh'), tree]);
      expect(clean.status, clean.out).toBe(0);
      fs.writeFileSync(path.join(tree, 'README.md'), upgraded);
      const rejected = runCommand('bash', [path.join(scripts, 'release-leak-check.sh'), tree]);
      expect(rejected.status).not.toBe(0);
      expect(rejected.out).toContain('LEAK [support overclaim]');
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  it('the private release assembler reaches and verifies the installable tarball', () => {
    const assembler = path.resolve('scripts/release-public.sh');
    // The private assembler is intentionally absent from the public package.
    // Its extracted-tarball run still executes this suite; that nested copy
    // validates the packaged gates above and has no release surface to invoke.
    if (!fs.existsSync(assembler)) return;
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'mai-release-reachability-'));
    try {
      const { clone, assembler: cloneAssembler, head, env } = snapshotRelease(tmp);

      // A dirty shipped path (modified or untracked) refuses with a named reason.
      fs.appendFileSync(path.join(clone, 'scripts', 'backup-brain.sh'), '\n# dirty probe\n');
      fs.writeFileSync(path.join(clone, 'src', 'untracked-probe.ts'), 'export {};\n');
      const dirty = runCommand('bash', [cloneAssembler, '--development-without-windows-receipt', path.join(tmp, 'dirty-out')], env);
      expect(dirty.status).not.toBe(0);
      expect(dirty.out).toContain('refusing: the working tree is dirty on shipped paths');
      expect(dirty.out).toContain('scripts/backup-brain.sh');
      expect(dirty.out).toContain('src/untracked-probe.ts');
      expect(fs.existsSync(path.join(tmp, 'dirty-out'))).toBe(false);
      execFileSync('git', ['checkout', '--', 'scripts/backup-brain.sh'], { cwd: clone });
      fs.rmSync(path.join(clone, 'src', 'untracked-probe.ts'));

      const out = path.join(tmp, 'public');
      const publicReadme = path.join(clone, 'release', 'public', 'README.md');
      const originalReadme = fs.readFileSync(publicReadme, 'utf8');
      const previewMarker = 'Windows launch gate: preview — physical acceptance deferred';
      const pendingMarker = 'Windows launch gate: pending physical acceptance';
      const previewRow = '| Windows 11 (native PowerShell) | Preview | Windows CI; full interactive acceptance pending |';
      const certifiedRow = '| Windows 11 (native PowerShell) | First-class | Windows CI + dated Shadow PC receipt |';
      expect(originalReadme).toContain(previewMarker);
      expect(originalReadme).toContain(previewRow);
      const certifiedReadme = originalReadme.replace(previewMarker, pendingMarker).replace(previewRow, certifiedRow);
      const gitIdentity = {
        ...env,
        GIT_AUTHOR_NAME: 'release-gate', GIT_AUTHOR_EMAIL: 'gate@mai-mcp.invalid',
        GIT_COMMITTER_NAME: 'release-gate', GIT_COMMITTER_EMAIL: 'gate@mai-mcp.invalid',
      };
      // The normal release path succeeds with truthful preview claims and no
      // receipt, while still running all package, privacy and identity gates.
      const preview = spawnSync('bash', [cloneAssembler, path.join(tmp, 'preview-out')], { encoding: 'utf8', env, maxBuffer: 64 * 1024 * 1024 });
      expect(preview.status, `${preview.stdout}${preview.stderr}`).toBe(0);
      expect(preview.stdout).toContain('release gate: native Windows preview; physical acceptance deferred');
      expect(`${preview.stdout}${preview.stderr}`).not.toContain('NON-RELEASE ASSEMBLY');
      expect(fs.readFileSync(path.join(tmp, 'preview-out', 'README.md'), 'utf8')).toContain(previewRow);
      const invalidStates = [
        originalReadme.replace(previewMarker, ''),
        originalReadme.replace(previewMarker, 'Windows launch gate: unknown'),
        originalReadme.replace(previewMarker, `${previewMarker}\n${previewMarker}`),
        originalReadme.replace(previewRow, certifiedRow),
        originalReadme.replace(previewRow, ''),
        originalReadme.replace(previewRow, `${previewRow}\n${previewRow}`),
        originalReadme.replace(previewMarker, 'Windows launch gate: receipt linked'),
      ];
      for (const [index, invalid] of invalidStates.entries()) {
        expect(invalid).not.toBe(originalReadme);
        fs.writeFileSync(publicReadme, invalid);
        execFileSync('git', ['add', '--', 'release/public/README.md'], { cwd: clone, env: gitIdentity });
        execFileSync('git', ['commit', '--quiet', '-m', 'invalid support state fixture'], { cwd: clone, env: gitIdentity });
        const rejectedPath = path.join(tmp, `invalid-state-${index}`);
        const rejected = runCommand('bash', [cloneAssembler, rejectedPath], env);
        expect(rejected.status).not.toBe(0);
        expect(rejected.out).toContain('refusing: native Windows support state');
        expect(fs.existsSync(rejectedPath)).toBe(false);
        execFileSync('git', ['reset', '--hard', '--quiet', head], { cwd: clone, env: gitIdentity });
      }
      fs.writeFileSync(publicReadme, certifiedReadme);
      execFileSync('git', ['add', '--', 'release/public/README.md'], { cwd: clone, env: gitIdentity });
      execFileSync('git', ['commit', '--quiet', '-m', 'pending certification fixture'], { cwd: clone, env: gitIdentity });
      const pending = runCommand('bash', [cloneAssembler, path.join(tmp, 'pending-out')], env);
      expect(pending.status).not.toBe(0);
      expect(pending.out).toContain('Windows physical acceptance receipt is required');
      expect(fs.existsSync(path.join(tmp, 'pending-out'))).toBe(false);
      execFileSync('git', ['reset', '--hard', '--quiet', head], { cwd: clone, env: gitIdentity });
      // A first-class claim still fails with no receipt or a stale receipt.
      fs.writeFileSync(publicReadme, certifiedReadme.replace('Windows launch gate: pending physical acceptance', 'Windows launch gate: receipt linked'));
      execFileSync('git', ['add', '--', 'release/public/README.md'], { cwd: clone, env: gitIdentity });
      execFileSync('git', ['commit', '--quiet', '-m', 'marker removed without a receipt'], { cwd: clone, env: gitIdentity });
      const unproven = runCommand('bash', [cloneAssembler, path.join(tmp, 'unproven-out')], env);
      expect(unproven.status).not.toBe(0);
      expect(unproven.out).toContain('no releasable receipt under docs/release/windows/');
      const receiptDir = path.join(clone, 'docs', 'release', 'windows');
      const stale = { ...RELEASABLE_RECEIPT, release: { ...RELEASABLE_RECEIPT.release, reviewedSha: head } };
      fs.writeFileSync(path.join(receiptDir, 'windows-11-2026-09-13-stale.json'), `${JSON.stringify(stale, null, 2)}\n`);
      fs.appendFileSync(path.join(clone, 'scripts', 'backup-brain.sh'), '\n# source change after the reviewed sha\n');
      execFileSync('git', ['add', '--', 'docs/release/windows', 'scripts/backup-brain.sh'], { cwd: clone, env: gitIdentity });
      execFileSync('git', ['commit', '--quiet', '-m', 'stale receipt plus a source change'], { cwd: clone, env: gitIdentity });
      const staleRun = runCommand('bash', [cloneAssembler, path.join(tmp, 'stale-out')], env);
      expect(staleRun.status).not.toBe(0);
      expect(staleRun.out).toContain('source changed since its reviewedSha');
      execFileSync('git', ['reset', '--hard', '--quiet', 'HEAD~2'], { cwd: clone, env: gitIdentity });
      // Success path: the receipt commit sits ON TOP of the reviewed sha with
      // only the receipt and the README links (Task 10 Steps 7-8) — the
      // default assembler must accept exactly this shape.
      const frozen = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: clone, encoding: 'utf8' }).trim();
      const proving = { ...RELEASABLE_RECEIPT, release: { ...RELEASABLE_RECEIPT.release, reviewedSha: frozen } };
      fs.writeFileSync(path.join(receiptDir, `windows-11-2026-09-13-${frozen.slice(0, 8)}.json`), `${JSON.stringify(proving, null, 2)}\n`);
      fs.writeFileSync(publicReadme, certifiedReadme.replace('Windows launch gate: pending physical acceptance', `Windows launch gate: receipt windows-11-2026-09-13-${frozen.slice(0, 8)}.json`));
      execFileSync('git', ['add', '--', 'docs/release/windows', 'release/public/README.md'], { cwd: clone, env: gitIdentity });
      execFileSync('git', ['commit', '--quiet', '-m', 'receipt on top of the frozen sha'], { cwd: clone, env: gitIdentity });
      const proven = spawnSync('bash', [cloneAssembler, path.join(tmp, 'proven-out')], { encoding: 'utf8', env, maxBuffer: 64 * 1024 * 1024 });
      expect(proven.status, `${proven.stdout}${proven.stderr}`).toBe(0);
      expect(proven.stdout).toContain(`proves ${execFileSync('git', ['rev-parse', 'HEAD'], { cwd: clone, encoding: 'utf8' }).trim()}`);
      expect(`${proven.stdout}${proven.stderr}`).not.toContain('NON-RELEASE ASSEMBLY');
      execFileSync('git', ['reset', '--hard', '--quiet', 'HEAD~1'], { cwd: clone, env: gitIdentity });
      const hatch = spawnSync('bash', [cloneAssembler, '--development-without-windows-receipt', out], { encoding: 'utf8', env, maxBuffer: 64 * 1024 * 1024 });
      const r = { status: hatch.status ?? 1, out: `${hatch.stdout}${hatch.stderr}` };
      expect(r.status, r.out).toBe(0);
      expect(r.out).toContain(`assembled: ${out}`);
      expect(r.out).toContain('NON-RELEASE ASSEMBLY');
      expect(supportBlock(fs.readFileSync(path.join(out, 'README.md'), 'utf8'))).toBe(supportBlock(fs.readFileSync('README.md', 'utf8')));
      expect(fs.existsSync(path.join(out, '.git'))).toBe(true);
      expect(fs.readdirSync(path.join(out, '.claude', 'agents')).sort()).toEqual([
        'plan-reviewer-broad.md',
        'plan-reviewer-clearance-max.md',
        'plan-reviewer-clearance.md',
        'plan-reviewer-delta.md',
      ]);

      // release-manifest.json: exact fields, independently recomputed.
      const manifestText = fs.readFileSync(path.join(out, 'release-manifest.json'), 'utf8');
      const manifest: unknown = JSON.parse(manifestText);
      if (typeof manifest !== 'object' || manifest === null) throw new Error('manifest is not an object');
      expect(Object.keys(manifest)).toEqual(['schema', 'sourceSha', 'sourceVersion', 'toolDefinitions', 'treeSha256']);
      expect(Reflect.get(manifest, 'schema')).toBe(1);
      expect(Reflect.get(manifest, 'sourceSha')).toBe(head);
      const clonePackage: unknown = JSON.parse(fs.readFileSync(path.join(clone, 'package.json'), 'utf8'));
      expect(Reflect.get(manifest, 'sourceVersion')).toBe(Reflect.get(clonePackage ?? {}, 'version'));
      expect(manifestText).not.toMatch(/\/Users\/|\/home\/|[A-Za-z]:\\|"timestamp"|"env"|"user"/);
      const tools = Reflect.get(manifest, 'toolDefinitions');
      if (typeof tools !== 'object' || tools === null) throw new Error('toolDefinitions missing');
      expect(Object.keys(tools)).toEqual(['count', 'chars', 'reserve']);
      const receipt = /^VC5: count=(\d+) chars=(\d+) reserve=(\d+)$/m.exec(
        execFileSync('git', ['show', '-s', '--format=%b', '49fd391'], { cwd: clone, encoding: 'utf8' }),
      );
      if (!receipt) throw new Error('the 49fd391 VC5 receipt line is unreadable');
      expect(tools).toEqual({ count: Number(receipt[1]), chars: Number(receipt[2]), reserve: Number(receipt[3]) });
      const records: string[] = [];
      const walk = (dir: string): void => {
        for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
          const full = path.join(dir, entry.name);
          const rel = path.relative(out, full).split(path.sep).join('/');
          if (rel === '.git' || rel === 'release-manifest.json') continue;
          const stat = fs.lstatSync(full);
          expect(stat.isSymbolicLink()).toBe(false);
          if (stat.isDirectory()) walk(full);
          else if (stat.isFile()) {
            records.push(`${rel}\0${crypto.createHash('sha256').update(fs.readFileSync(full)).digest('hex')}\n`);
          }
        }
      };
      walk(out);
      records.sort();
      const treeHash = crypto.createHash('sha256');
      for (const record of records) treeHash.update(record);
      expect(Reflect.get(manifest, 'treeSha256')).toBe(treeHash.digest('hex'));

      const verified = runCommand('bash', [cloneAssembler, '--verify-manifest', out, head], env);
      expect(verified.status, verified.out).toBe(0);
      expect(verified.out).toContain(`sourceSha: ${head}`);
      expect(verified.out).toContain('verify-manifest: OK');
      const wrongSha = runCommand('bash', [cloneAssembler, '--verify-manifest', out, 'f'.repeat(40)], env);
      expect(wrongSha.status).not.toBe(0);
      expect(wrongSha.out).toContain('MISMATCH sourceSha');

      // Inventory: every package script target ships; the runtime set is exact
      // and reachable without the private assembler; npm pack carries it.
      const scripts = Reflect.get(JSON.parse(fs.readFileSync(path.join(out, 'package.json'), 'utf8')) ?? {}, 'scripts');
      const targets = Object.values(typeof scripts === 'object' && scripts !== null ? scripts : {})
        .flatMap((value) => String(value).split(/\s+/))
        .filter((token) => /^(scripts|src|frontend)\/[A-Za-z0-9_./-]+$/.test(token));
      expect(targets.length).toBeGreaterThan(10);
      for (const target of targets) expect(fs.existsSync(path.join(out, target)), target).toBe(true);
      const runtime = [
        'scripts/windows/install-dashboard.ps1',
        'scripts/windows/install-maintenance.ps1',
        'scripts/windows/acceptance.ps1',
        'scripts/windows/receipt-schema.json',
        'scripts/windows/validate-receipt.mjs',
        'docs/release/windows/README.md',
        '.gitattributes',
        'skills/plan-review-cycle/scripts/review-scratch.mjs',
        'skills/plan-review-cycle/scripts/review-scratch.sh',
        'skills/plan-review-cycle/scripts/install-janitor.sh',
        'skills/plan-review-cycle/scripts/com.mai.review-tmp-janitor.plist',
        'scripts/com.mai.brain-backup.plist',
        'scripts/backup-brain.sh',
        'src/scripts/hook-runner.ts',
        'src/scripts/db-init.ts',
        'src/scripts/dashboard.ts',
        'src/scripts/dashboard-persistence.ts',
        'src/scripts/backup.ts',
        '.github/workflows/platform.yml',
        'release-manifest.json',
      ];
      for (const file of runtime) expect(fs.existsSync(path.join(out, file)), file).toBe(true);
      expect(fs.existsSync(path.join(out, 'scripts', 'release-public.sh'))).toBe(false);
      expect(fs.existsSync(path.join(out, 'scripts', 'release-leak-check.sh'))).toBe(false);
      const packed: unknown = JSON.parse(execFileSync('npm', ['pack', '--dry-run', '--json'], { cwd: out, env, encoding: 'utf8' }));
      const first = Array.isArray(packed) ? packed[0] : null;
      const files = Reflect.get(first ?? {}, 'files');
      const packedPaths = Array.isArray(files) ? files.map((entry) => String(Reflect.get(entry ?? {}, 'path'))) : [];
      for (const file of runtime) expect(packedPaths, file).toContain(file);

      // One-byte tamper of a shipped file breaks the tree identity.
      fs.appendFileSync(path.join(out, 'README.md'), '\n');
      const tampered = runCommand('bash', [cloneAssembler, '--verify-manifest', out, head], env);
      expect(tampered.status).not.toBe(0);
      expect(tampered.out).toContain('MISMATCH treeSha256');
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  }, 360_000); // preview, certified and development assemblies plus their packed tarball proofs
});
