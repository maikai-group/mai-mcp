import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';

const SCRIPT = path.resolve('scripts/windows/acceptance.ps1');
const SCHEMA_PATH = path.resolve('scripts/windows/receipt-schema.json');
const README = path.resolve('docs/release/windows/README.md');
const SOURCE = readFileSync(SCRIPT, 'utf8');
const SCHEMA: unknown = JSON.parse(readFileSync(SCHEMA_PATH, 'utf8'));
const README_TEXT = readFileSync(README, 'utf8');
const WINDOWS = process.platform === 'win32';
const SHA = 'a'.repeat(40);

type Json = string | number | boolean | null | Json[] | { [key: string]: Json };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

const VALIDATOR = path.resolve('scripts/windows/validate-receipt.mjs');
const scratch = mkdtempSync(path.join(os.tmpdir(), 'mai-receipt-validate-'));
afterAll(() => rmSync(scratch, { recursive: true, force: true }));

/** Runs the ONE shipped validator (scripts/windows/validate-receipt.mjs), the
 * same file the release leak gate executes; returns its violation lines. */
function validate(schema: unknown, receipt: unknown, expectedSha?: string): string[] {
  const schemaFile = path.join(scratch, `schema-${Math.random().toString(16).slice(2)}.json`);
  const receiptFile = path.join(scratch, `receipt-${Math.random().toString(16).slice(2)}.json`);
  writeFileSync(schemaFile, JSON.stringify(schema));
  writeFileSync(receiptFile, JSON.stringify(receipt));
  const args = [VALIDATOR, schemaFile, receiptFile, ...(expectedSha ? [expectedSha] : [])];
  const result = spawnSync(process.execPath, args, { encoding: 'utf8' });
  if (result.status === 0) return [];
  return result.stderr.split('\n').filter(Boolean);
}

function releasable(receipt: unknown, head: string): string[] {
  return validate(SCHEMA, receipt, head);
}

function sampleReceipt(): { [key: string]: Json } {
  const bools = (keys: string[]): { [key: string]: Json } => Object.fromEntries(keys.map((key) => [key, true]));
  return {
    schema: 1,
    platform: { os: 'Windows 11', osBuild: '26100', architecture: 'AMD64', nonAdmin: true },
    versions: { node: 'v24.19.0', npm: '11.17.0', git: '2.47.1', docker: '27.3.1', claude: '2.1.0', codex: '0.120.0' },
    release: { reviewedSha: SHA, runtimeVersion: '0.15.1', installerVersion: '1.0.0', runtimeTreeSha256: 'b'.repeat(64), installerPackageSha256: 'c'.repeat(64) },
    automated: bools(['installerExistingCheckout', 'setup', 'database', 'migrations', 'verifySmoke', 'mcpSurface', 'wiring', 'dashboard', 'scratchEndCleanup', 'scratchPrune', 'janitorSchedule', 'backupRestore', 'backupSchedule', 'rerunIdempotent']),
    manual: bools(['claudeRestarted', 'claudePrime', 'claudeCapture', 'claudeProviderStatus', 'claudeHooksLive', 'codexRestarted', 'codexPrime', 'codexCapture', 'codexProviderStatus', 'codexNotifyLive']),
    scheduledPersistence: { taskName: 'mai-mcp-dashboard', installed: true, restartedAfterKill: true, survivedSignOutSignIn: true, tokenAbsent: true, uninstalled: true },
    timestamps: { automatedCompletedAt: '2026-09-14T01:00:00Z', manualCompletedAt: '2026-09-14T02:00:00Z' },
  };
}

function paramBlock(): string {
  const start = SOURCE.indexOf('param(');
  const end = SOURCE.indexOf('\n)\n', start);
  return SOURCE.slice(start, end + 2);
}

function section(startMarker: string, endMarker: string): string {
  const start = SOURCE.indexOf(startMarker);
  expect(start, startMarker).toBeGreaterThanOrEqual(0);
  const end = SOURCE.indexOf(endMarker, start + startMarker.length);
  expect(end, endMarker).toBeGreaterThan(start);
  return SOURCE.slice(start, end);
}

/** Every `$name` / `$env:NAME` a PowerShell block dereferences must be assigned
 * earlier in that same block — the operator's sign-out between the README's
 * two blocks destroys every value (pass-3 findings 53053c35 / b003a345). */
function unassignedInBlock(block: string): string[] {
  const assigned = new Set<string>();
  const missing: string[] = [];
  for (const raw of block.split('\n')) {
    const line = raw.replace(/#.*$/, '');
    for (const match of line.matchAll(/\$(env:[A-Za-z_][A-Za-z0-9_]*|[A-Za-z_][A-Za-z0-9_]*)/g)) {
      const name = match[1];
      const assignment = new RegExp(`\\$${name.replace(':', '\\:')}\\s*=`);
      if (assignment.test(line) && line.indexOf(match[0]) === line.search(assignment)) { assigned.add(name); continue; }
      if (!assigned.has(name)) missing.push(name);
    }
  }
  return missing;
}

describe('Shadow PC acceptance runner — static contract', () => {
  it('declares exactly the seven parameters with the phase, SHA and path contracts', () => {
    const block = paramBlock();
    expect(block).toContain("[Parameter(Mandatory=$true)][ValidateSet('Automated','Finalize')][string]$Phase");
    expect(block).toContain('[Parameter(Mandatory=$true)][string]$CheckoutRoot');
    expect(block).toContain("[Parameter(Mandatory=$true)][ValidatePattern('^[0-9a-f]{40}$')][string]$ReviewedSha");
    expect(block).toContain('[Parameter(Mandatory=$true)][string]$PublicTree');
    expect(block).toContain('[Parameter(Mandatory=$true)][string]$InstallerPackage');
    expect(block).toContain('[string]$DraftReceipt');
    expect(block).toContain('[string]$OutputReceipt');
    expect(block.match(/\[Parameter\(Mandatory=\$true\)\]/g)).toHaveLength(5);
  });

  it('refuses an administrator before any work', () => {
    const preflight = section('function Test-Preflight', 'function Invoke-Cleanup');
    expect(preflight).toContain("IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)");
    expect(preflight).toContain("throw 'acceptance must run as a non-admin user'");
    expect(preflight.indexOf('IsInRole')).toBeLessThan(preflight.indexOf('Get-TreeSha256'));
  });

  it('refuses a checkout whose HEAD is not the reviewed SHA', () => {
    const preflight = section('function Test-Preflight', 'function Invoke-Cleanup');
    expect(preflight).toContain("'rev-parse', 'HEAD'");
    expect(preflight).toContain('if ($head -ne $ReviewedSha) { throw');
    expect(SOURCE).not.toMatch(/git[^\n]*\b(fetch|pull|reset)\b/);
  });

  it('refuses a dirty tracked or untracked tree, tolerating only the Finalize receipt', () => {
    const preflight = section('function Test-Preflight', 'function Invoke-Cleanup');
    expect(preflight).toContain("'status', '--porcelain', '--untracked-files=all'");
    expect(preflight).toContain("if ($Phase -eq 'Finalize') { $allowed = @('docs/release/windows/') }");
    expect(preflight).toContain("$rel -like '*windows-11-*.json'");
    expect(preflight).toContain('throw "checkout is not clean: $line"');
  });

  it('refuses Node 20 and any major other than 24', () => {
    const preflight = section('function Test-Preflight', 'function Invoke-Cleanup');
    expect(preflight).toContain("if ($nodeVersion -notmatch '^v24\\.') { throw");
    expect(/^v24\./.test('v20.11.0')).toBe(false);
    expect(/^v24\./.test('v24.19.0')).toBe(true);
  });

  it('requires a Docker server, Git, Claude and Codex executables', () => {
    const preflight = section('function Test-Preflight', 'function Invoke-Cleanup');
    expect(preflight).toContain("(Get-Command docker.exe -ErrorAction Stop).Source");
    expect(preflight).toContain("'version', '--format', '{{.Server.Version}}'");
    expect(preflight).toContain("(Get-Command claude -ErrorAction Stop).Source");
    expect(preflight).toContain("(Get-Command codex -ErrorAction Stop).Source");
    expect(preflight).toContain("Assert-Native -File 'git' -Arguments @('--version')");
  });

  it('pins the public tree and installer identity before touching anything', () => {
    const preflight = section('function Test-Preflight', 'function Invoke-Cleanup');
    expect(preflight).toContain("if ($manifest.sourceSha -ne $ReviewedSha) { throw");
    expect(preflight).toContain("if ($treeSha -ne $manifest.treeSha256) { throw 'public tree hash does not match its manifest' }");
    expect(preflight).toContain('$installerSha = Get-Sha256Hex -Path $installerPath');
    const hasher = section('function Get-TreeSha256', 'function Get-UtcStamp');
    expect(hasher).toContain("if ($rel -eq 'release-manifest.json' -or $rel -like '.git/*') { continue }");
    expect(hasher).toContain('[System.StringComparer]::Ordinal');
    expect(hasher).toContain('[char]0');
  });

  it('builds every native command from an argv array through the call operator, with metacharacter paths', () => {
    const invoke = section('function Invoke-Native', 'function Assert-Native');
    expect(invoke).toContain('& $File @Arguments');
    // Windows PowerShell 5.1 makes merged stderr a terminating error under
    // 'Stop'; the capture runs under 'Continue' and the exit code decides.
    expect(invoke).toContain("$ErrorActionPreference = 'Continue'");
    expect(invoke.indexOf("$ErrorActionPreference = 'Continue'")).toBeLessThan(invoke.indexOf('& $File @Arguments'));
    expect(invoke).toContain('$ErrorActionPreference = $previousEap');
    expect(SOURCE).toContain("[Environment]::SetEnvironmentVariable('MAI_PROJECT_SLUG', $previous.MAI_PROJECT_SLUG, 'Process')");
    expect(SOURCE).toContain('"mai Windows acceptance & $([guid]::NewGuid())"');
    expect(SOURCE).toContain("'consumer repo & one'");
    expect(SOURCE).toContain("'installed checkout'");
    expect(SOURCE).toContain("'installer package'");
    expect(SOURCE).not.toMatch(/Start-Process/);
    expect(SOURCE).not.toMatch(/System\.Diagnostics\.Process/);
    expect(SOURCE).not.toMatch(/ArgumentList/);
  });

  it('backdates the abandoned scratch root only after its last file exists and demands a retention reason', () => {
    const stage = section("Enter-Stage 'scratchPrune'", "Enter-Stage 'janitorSchedule'");
    const write = stage.indexOf("[System.IO.File]::WriteAllText($held, 'held')");
    const backdate = stage.indexOf('Set-ScratchOld -Root $abandoned');
    expect(write).toBeGreaterThanOrEqual(0);
    expect(backdate).toBeGreaterThan(write);
    expect(stage).not.toContain('LastWriteTime = (Get-Date).AddDays(-10)');
    expect(stage).toContain("if ($retained.Output -notmatch 'retaining ') { throw");
    const janitor = section("Enter-Stage 'janitorSchedule'", "Enter-Stage 'backupRestore'");
    expect(janitor).toContain("$janitorStatus -notmatch 'taskPath: \\\\'");
    const backup = section("Enter-Stage 'backupSchedule'", "Enter-Stage 'rerunIdempotent'");
    expect(backup).toContain("$backupStatus -notmatch 'taskPath: \\\\'");
  });

  it('recomputes the tool manifest independently and asserts the served count against it', () => {
    expect(SOURCE).toContain("import('./build/tool-defs.js'),import('./build/coordination/index.js')");
    expect(SOURCE).toContain('if ([int]$liveTools.$field -ne [int]$Pre.Manifest.toolDefinitions.$field) { throw');
    expect(SOURCE).toContain("if ($names.Count -ne [int]$Pre.Manifest.toolDefinitions.count) { throw");
    expect(SOURCE).toContain("if (@($names | Select-Object -Unique).Count -ne $names.Count) { throw 'served tool names are not unique' }");
    expect(SOURCE).not.toMatch(/\b4[37]\b(?![0-9])/);
  });

  it('writes a draft with every manual boolean false and the dashboard task recorded as retained', () => {
    const draft = section("Enter-Stage 'draft'", 'Write-Host \'Automated phase complete');
    expect(draft).toContain('claudeRestarted = $false; claudePrime = $false; claudeCapture = $false; claudeProviderStatus = $false; claudeHooksLive = $false');
    expect(draft).toContain('codexRestarted = $false; codexPrime = $false; codexCapture = $false; codexProviderStatus = $false; codexNotifyLive = $false');
    expect(draft).toContain('taskName = $DashboardTaskName; installed = $true; restartedAfterKill = $true');
    expect(draft).toContain('survivedSignOutSignIn = $false; tokenAbsent = $false; uninstalled = $false');
    expect(draft).toContain('if ($automated[$key] -ne $true) { throw "automated boolean $key is not true" }');
    expect(SOURCE).toContain('Write-Output $draftPath');
    expect(SOURCE.trimEnd().endsWith('Write-Output $draftPath') || SOURCE.indexOf('Write-Output $draftPath') > SOURCE.indexOf("Enter-Stage 'draft'")).toBe(true);
  });

  it('accepts only the exact PASS <sha8> confirmation token for each of the nine checks', () => {
    const manual = section("Enter-Stage 'manual'", "Enter-Stage 'receipt'");
    expect(manual).toContain('Read-Host "Type PASS $sha8 to confirm"');
    expect(SOURCE).toContain('$sha8 = $ReviewedSha.Substring(0, 8)');
    expect(manual).toContain('if ($answer -ne "PASS $sha8") { throw');
    expect(manual.match(/@\{ key = '/g)).toHaveLength(9);
    for (const key of ['claudeRestarted', 'claudePrime', 'claudeCapture', 'codexRestarted', 'codexPrime', 'codexCapture', 'signOutConfirmed', 'claudeProviderStatus', 'codexProviderStatus']) {
      expect(manual).toContain(`key = '${key}'`);
    }
  });

  it('rejects a public tree whose manifest SHA is not the reviewed commit', () => {
    expect(SOURCE).toContain('throw "public tree sourceSha $($manifest.sourceSha) is not the reviewed SHA"');
    const finalize = section('function Invoke-FinalizePhase', 'function Test-ReceiptAgainstSchema');
    expect(finalize).toContain("if ($draft.release.reviewedSha -ne $ReviewedSha) { throw 'draft reviewedSha is not the reviewed SHA' }");
    expect(finalize).toContain("if ($draft.release.runtimeTreeSha256 -ne $Pre.TreeSha) { throw");
    expect(finalize).toContain("if ($draft.release.installerPackageSha256 -ne $Pre.InstallerSha) { throw");
  });

  it('the receipt schema rejects an extra key at every level and accepts a complete receipt', () => {
    expect(validate(SCHEMA, sampleReceipt())).toEqual([]);
    const extraTop = { ...sampleReceipt(), acceptanceRoot: 'C:\\x' };
    expect(validate(SCHEMA, extraTop)).toEqual(['receipt.acceptanceRoot: key not permitted']);
    const nested = sampleReceipt();
    const platform = nested.platform;
    if (!isRecord(platform)) throw new Error('platform');
    platform.username = 'someone';
    expect(validate(SCHEMA, nested)).toEqual(['receipt.platform.username: key not permitted']);
    expect(SOURCE).toContain('throw "$At.$n is not a permitted receipt key"');
    expect(SOURCE).toContain('Test-ReceiptAgainstSchema -Schema $schema -Value $receipt -At \'receipt\'');
    // A schema node nobody implemented is a refusal in every validator, never a pass.
    const integerSchema = { type: 'object', additionalProperties: false, required: ['n'], properties: { n: { type: 'integer' } } };
    expect(validate(integerSchema, { n: 1 })).toEqual(['receipt.n: unsupported schema node']);
    const walk = section('function Test-ReceiptAgainstSchema', '$succeeded = $false');
    expect(walk).toContain('throw "${At}: unsupported receipt schema node');
    expect(walk.trimEnd().endsWith('}')).toBe(true);
    // The leak gate is a maintainer-only artifact the public package omits on
    // purpose. The maintainer checkout is recognised by its private assembler,
    // so a missing leak gate there is a failure, never a silent skip.
    if (existsSync(path.resolve('scripts/release-public.sh'))) {
      const leakGatePath = path.resolve('scripts/release-leak-check.sh');
      expect(existsSync(leakGatePath), 'maintainer checkout must ship the leak gate').toBe(true);
      expect(readFileSync(leakGatePath, 'utf8')).toContain('node "$TREE/scripts/windows/validate-receipt.mjs" "$RECEIPT_SCHEMA" "$receipt"');
    }
  });

  it('redacts the receipt and orders cleanup: failure records leave the repo, the draft path never ships', () => {
    const finalize = section('function Invoke-FinalizePhase', 'function Test-ReceiptAgainstSchema');
    const receiptLiteral = finalize.slice(finalize.indexOf('$receipt = [ordered]@{'), finalize.indexOf('$schemaPath ='));
    expect(receiptLiteral).not.toMatch(/local|acceptanceRoot|installedCheckout|consumerRepo|\$env:/);
    expect(SOURCE).toContain('$file = Join-Path $env:TEMP "mai-windows-acceptance-');
    expect(SOURCE).toContain('.failed.json"');
    const failure = section('function Write-FailureRecord', 'function Add-StageResult');
    expect(failure).not.toMatch(/Message = \$_|Exception\.StackTrace|\$env:USERPROFILE/);
    expect(failure).toContain('failedStage = $script:Stage; stages = @($script:StageLog)');
    const tail = SOURCE.slice(SOURCE.lastIndexOf('$succeeded = $false'));
    expect(tail).toContain('} catch {\n  Write-FailureRecord');
    expect(tail).toContain('} finally {\n  Invoke-Cleanup -Succeeded $succeeded');
  });

  it('a receipt with a false provider-status or hook/notify boolean is not releasable', () => {
    for (const key of ['claudeProviderStatus', 'claudeHooksLive', 'codexProviderStatus', 'codexNotifyLive']) {
      const receipt = sampleReceipt();
      const manual = receipt.manual;
      if (!isRecord(manual)) throw new Error('manual');
      manual[key] = false;
      expect(releasable(receipt, SHA)).toEqual([`receipt.manual.${key}: false boolean`]);
    }
    expect(releasable(sampleReceipt(), SHA)).toEqual([]);
    expect(releasable(sampleReceipt(), 'f'.repeat(40))).toEqual(['receipt.release.reviewedSha: not the reviewed commit']);
  });

  it('a scheduledPersistence object missing survivedSignOutSignIn is rejected', () => {
    const receipt = sampleReceipt();
    const persistence = receipt.scheduledPersistence;
    if (!isRecord(persistence)) throw new Error('scheduledPersistence');
    delete persistence.survivedSignOutSignIn;
    expect(validate(SCHEMA, receipt)).toEqual(['receipt.scheduledPersistence.survivedSignOutSignIn: required key missing']);
    expect(SOURCE).toContain('survivedSignOutSignIn = $survivedConfirmed; tokenAbsent = $true; uninstalled = $true');
  });

  it('the finally block keeps the dashboard task on success and removes it on failure', () => {
    const cleanup = section('function Invoke-Cleanup', 'function Write-FailureRecord');
    expect(cleanup).toContain("foreach ($job in @('ReviewCleanup', 'Backup')) {");
    expect(cleanup).toContain("if (-not $Succeeded -and $script:InstalledCheckout) {\n      $dashboard = Join-Path $script:InstalledCheckout 'scripts\\windows\\install-dashboard.ps1'");
    // Every Join-Path on the checkout sits inside a null guard, each step is
    // its own try/catch, and every $script: variable the always-run cleanup
    // reads is initialised at the top of the file (code finding d92cf248).
    expect(cleanup).toContain("if ($script:InstalledCheckout) {\n      $maintenance = Join-Path");
    expect(cleanup.match(/\n  try \{/g)).toHaveLength(3);
    expect(cleanup.match(/\} catch \{ Write-Host "cleanup step failed/g)).toHaveLength(3);
    const initBlock = SOURCE.slice(SOURCE.indexOf('$script:Stage = '), SOURCE.indexOf('$DashboardTaskName ='));
    const initialised = new Set([...initBlock.matchAll(/^\$script:([A-Za-z]+) =/gm)].map((m) => m[1]));
    const readInCleanup = new Set([...cleanup.matchAll(/\$script:([A-Za-z]+)/g)].map((m) => m[1]));
    for (const name of readInCleanup) expect(initialised, `$script:${name} read in Invoke-Cleanup`).toContain(name);
    expect(cleanup).toContain("'-Action', 'Uninstall', '-CheckoutRoot', $script:InstalledCheckout))");
    expect(cleanup).toContain('DROP DATABASE IF EXISTS');
    const automated = section('function Invoke-AutomatedPhase', 'function Invoke-FinalizePhase');
    expect(automated).toContain('$script:DashboardRetained = $true');
    expect(automated).not.toMatch(/install-dashboard\.ps1[^\n]*Uninstall/);
    const finalize = section('function Invoke-FinalizePhase', 'function Test-ReceiptAgainstSchema');
    expect(finalize).toContain("'-Action', 'Uninstall', '-CheckoutRoot', $installedCheckout) -Because 'dashboard uninstall'");
    expect(finalize).toContain("if ((Invoke-Native -File 'schtasks.exe' -Arguments @('/query', '/tn', $DashboardTaskName)).Code -eq 0) { throw");
  });

  it('never invokes a bare mai command, a shell, an environment dump, or a history-moving git verb', () => {
    const code = SOURCE.split('\n').map((line) => line.replace(/#.*$/, ''));
    for (const line of code) {
      expect(line, line).not.toMatch(/(^|[;{(|&]\s*)mai\s/);
      expect(line, line).not.toMatch(/Invoke-Expression|\biex\b/i);
      expect(line, line).not.toMatch(/\bcmd(\.exe)?\s+\/c/i);
      expect(line, line).not.toMatch(/Get-ChildItem\s+Env:|Get-Item\s+Env:|\[Environment\]::GetEnvironmentVariables/i);
      expect(line, line).not.toMatch(/git[^\n]*\b(pull|checkout|reset)\b/);
      expect(line, line).not.toMatch(/C:\\Users\\|\/Users\/|\$env:USERPROFILE/);
    }
    if (!WINDOWS) return;
    const probe = [
      '$e = $null',
      `[void][System.Management.Automation.Language.Parser]::ParseFile(${JSON.stringify(SCRIPT)}, [ref]$null, [ref]$e)`,
      // Print every error with its line so a CI log names the construct, not just a count.
      'if ($e) { foreach ($x in $e) { Write-Output ("parse error {0}:{1} {2}" -f $x.Extent.StartLineNumber, $x.Extent.StartColumnNumber, $x.Message) }; Write-Error "$($e.Count) parse error(s)"; exit 1 }',
      "Write-Output 'parsed'",
    ].join('\n');
    expect(execFileSync('powershell.exe', ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', probe], { encoding: 'utf8' })).toContain('parsed');
  });

  it('both operator README blocks assign every value they dereference', () => {
    const blocks = [...README_TEXT.matchAll(/```powershell\n([\s\S]*?)```/g)].map((match) => match[1]);
    expect(blocks).toHaveLength(2);
    for (const block of blocks) {
      expect(unassignedInBlock(block), block).toEqual([]);
      expect(block).toContain('Set-Location C:\\src\\mai-mcp');
      expect(block).toContain('$sha = (git rev-parse HEAD).Trim()');
    }
    expect(blocks[0]).toContain('-Phase Automated');
    expect(blocks[1]).toContain('-Phase Finalize');
    expect(blocks[1]).toContain("$draftReceipt = Read-Host 'Paste the draft receipt path printed by the Automated phase'");
    expect(README_TEXT).toContain('Native Windows certification is blocked without a committed final');
    expect(README_TEXT).toContain('Native Windows 11 ships as **preview** in v1.0');
    expect(README_TEXT).toContain('does not block the macOS/Linux release');
  });
});
