import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const SCRIPT = path.resolve('scripts/windows/install-maintenance.ps1');
const SOURCE = readFileSync(SCRIPT, 'utf8');
const WINDOWS = process.platform === 'win32';

/** Eight arguments that each exercise one quoting rule. */
const ROUND_TRIP_CASES: ReadonlyArray<readonly [string, string]> = [
  ['plain path', 'C:\\src\\mai-mcp\\build\\entry.js'],
  ['path with a space', 'C:\\Users\\Some One\\mai-mcp\\entry.js'],
  ['embedded double quote', 'say "hello" there'],
  ['trailing backslash', 'C:\\Program Files\\mai-mcp\\'],
  ['backslashes before a quote', 'end\\\\"quoted'],
  ['ampersand, parentheses and percent', 'C:\\a & b (c) %PATH%\\x.js'],
  ['unicode', 'C:\\Ünïcødé\\日本語\\entry.js'],
  ['empty string', ''],
];

function paramBlock(): string {
  const start = SOURCE.indexOf('param(');
  const end = SOURCE.indexOf('\n)\n', start);
  return SOURCE.slice(start, end + 2);
}

function functionText(name: string): string {
  const start = SOURCE.indexOf(`function ${name} {`);
  expect(start).toBeGreaterThanOrEqual(0);
  let depth = 0;
  for (let i = SOURCE.indexOf('{', start); i < SOURCE.length; i += 1) {
    if (SOURCE[i] === '{') depth += 1;
    if (SOURCE[i] === '}') {
      depth -= 1;
      if (depth === 0) return SOURCE.slice(start, i + 1);
    }
  }
  throw new Error(`unterminated function ${name}`);
}

/** Round-trips every case through the real Windows command line: the quoted
 * arguments are handed to node.exe via ProcessStartInfo.Arguments and node
 * reports the argv it actually received. */
function roundTrip(values: readonly string[]): string[] {
  const script = [
    functionText('Quote-WindowsArgument'),
    '$values = ConvertFrom-Json -InputObject ([Console]::In.ReadToEnd())',
    '$quoted = @($values | ForEach-Object { Quote-WindowsArgument -Value $_ }) -join " "',
    '$psi = New-Object System.Diagnostics.ProcessStartInfo',
    `$psi.FileName = ${JSON.stringify(process.execPath)}`,
    '$psi.Arguments = "-e ""console.log(JSON.stringify(process.argv.slice(1)))"" -- " + $quoted',
    '$psi.UseShellExecute = $false',
    '$psi.RedirectStandardOutput = $true',
    '$proc = [System.Diagnostics.Process]::Start($psi)',
    '$out = $proc.StandardOutput.ReadToEnd()',
    '$proc.WaitForExit()',
    'if ($proc.ExitCode -ne 0) { throw "node exited $($proc.ExitCode)" }',
    'Write-Output $out',
  ].join('\n');
  const encoded = Buffer.from(script, 'utf16le').toString('base64');
  const out = execFileSync('powershell.exe', [
    '-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-EncodedCommand', encoded,
  ], { encoding: 'utf8', input: JSON.stringify(values) });
  const parsed: unknown = JSON.parse(out.trim());
  if (!Array.isArray(parsed)) throw new Error('node did not report an argv array');
  return parsed.map(String);
}

describe('Windows maintenance installer — scheduler contract', () => {
  it('declares exactly the Job, Action and CheckoutRoot parameters', () => {
    const block = paramBlock();
    expect(block).toContain("[ValidateSet('ReviewCleanup','Backup')][string]$Job");
    expect(block).toContain("[ValidateSet('Install','Status','Uninstall')][string]$Action");
    expect(block).toContain("[string]$CheckoutRoot = (Resolve-Path (Join-Path $PSScriptRoot '..\\..')).Path");
    expect(block.match(/\[Parameter\(Mandatory=\$true\)\]/g)).toHaveLength(2);
    expect(block.match(/\$[A-Za-z]+\b/g)?.filter((v) => v !== '$true' && v !== '$PSScriptRoot')).toEqual(['$Job', '$Action', '$CheckoutRoot']);
  });

  it('names exactly the two maintenance tasks', () => {
    expect(SOURCE).toContain("ReviewCleanup = 'mai-mcp-review-scratch-cleanup'");
    expect(SOURCE).toContain("Backup        = 'mai-mcp-brain-backup'");
    expect(SOURCE.match(/'mai-mcp-[a-z-]+'/g)).toEqual(["'mai-mcp-review-scratch-cleanup'", "'mai-mcp-brain-backup'"]);
  });

  it('runs the review cleanup as absolute node plus the canonical helper at logon and 05:10', () => {
    expect(SOURCE).toContain("(Get-Command node.exe -ErrorAction Stop).Source");
    expect(SOURCE).toContain("IsPathRooted($node)");
    expect(SOURCE).toContain("'skills\\plan-review-cycle\\scripts\\review-scratch.mjs'");
    expect(SOURCE).toContain("Arguments  = @($helper, 'prune', '--days', '7')");
    expect(SOURCE).toContain("Triggers   = @('AtLogOn', 'Daily 05:10')");
    expect(SOURCE).toContain('New-ScheduledTaskTrigger -AtLogOn -User $User');
    expect(SOURCE).toContain('New-ScheduledTaskTrigger -Daily -At $spec.Substring(6)');
  });

  it('registers a limited interactive principal for the current user with no password or elevation', () => {
    expect(SOURCE).toContain('[Security.Principal.WindowsIdentity]::GetCurrent().Name');
    expect(SOURCE).toContain('New-ScheduledTaskPrincipal -UserId $user -LogonType Interactive -RunLevel Limited');
    expect(SOURCE).toContain("Register-ScheduledTask -TaskName $Definition.TaskName -TaskPath '\\' -Action $action -Trigger $triggers -Principal $principal");
    expect(SOURCE).not.toMatch(/-Password/);
    expect(SOURCE).not.toMatch(/RunLevel Highest/);
    expect(SOURCE).not.toMatch(/-Verb RunAs/);
    expect(SOURCE).not.toMatch(/#Requires -RunAsAdministrator/);
  });

  it('schedules the backup as absolute node plus entry.js backup daily at 04:30 under the same limited principal', () => {
    expect(SOURCE).toContain("$entry = Join-Path $Root 'build\\entry.js'");
    expect(SOURCE).toContain("Arguments  = @($entry, 'backup', '--log-file', $logFile)");
    expect(SOURCE).toContain("Triggers   = @('Daily 04:30')");
    expect(SOURCE).toContain('logFile: $($Definition.LogFile)');
    expect(SOURCE).toContain('Get-Content -LiteralPath $Definition.LogFile -Tail 1');
    expect(SOURCE).not.toMatch(/backup-brain\.sh|--commit|--push/);
    expect(SOURCE.match(/New-ScheduledTaskPrincipal/g)).toHaveLength(1);
  });

  it('uninstalls only the exact task name and reports status fields without an environment dump', () => {
    expect(SOURCE).toContain("Unregister-ScheduledTask -TaskName $Definition.TaskName -TaskPath '\\' -Confirm:$false");
    expect(SOURCE.match(/Unregister-ScheduledTask/g)).toHaveLength(1);
    // Every lookup is pinned to the root folder: a same-named task elsewhere in
    // the tree is neither reported nor removed (code finding cc2c0f70).
    expect(SOURCE.match(/Get-ScheduledTask -TaskName \$Definition\.TaskName -TaskPath '\\'/g)).toHaveLength(2);
    expect(SOURCE).toContain("Get-ScheduledTaskInfo -TaskName $Definition.TaskName -TaskPath '\\'");
    expect(SOURCE.match(/Get-ScheduledTask(?:Info)? -TaskName \$Definition\.TaskName(?! -TaskPath)/g)).toBeNull();
    expect(SOURCE).not.toMatch(/Get-ScheduledTask -TaskName \$Definition\.TaskName -ErrorAction/);
    expect(SOURCE).toContain('Write-Output "taskPath: $($task.TaskPath)"');
    expect(SOURCE).not.toMatch(/Get-ScheduledTask\s+[^\n]*\*/);
    expect(SOURCE).not.toMatch(/Unregister-ScheduledTask[^\n]*\*/);
    for (const field of ['task:', 'taskPath:', 'executable:', 'arguments:', 'nextRun:', 'lastResult:']) {
      expect(SOURCE).toContain(`"${field}`);
    }
    expect(SOURCE).not.toMatch(/Get-ChildItem Env:/);
  });

  it('never routes through a shell or interpolates a command line', () => {
    expect(SOURCE).not.toMatch(/Invoke-Expression/);
    expect(SOURCE).not.toMatch(/cmd(\.exe)? \/c/i);
    expect(SOURCE).not.toMatch(/Start-Process/);
    expect(SOURCE.match(/function Quote-WindowsArgument/g)).toHaveLength(1);
    expect(SOURCE).toContain('ForEach-Object { Quote-WindowsArgument -Value $_ }) -join \' \'');
    expect(SOURCE).toContain('New-ScheduledTaskAction -Execute $Definition.Executable -Argument $argumentString');
  });
});

describe('Windows maintenance installer — argument quoting round-trips', () => {
  for (const [label, value] of ROUND_TRIP_CASES) {
    it(`round-trips ${label}`, () => {
      if (!WINDOWS) return; // executed on windows-latest; POSIX has no PowerShell 5.1
      expect(roundTrip(['marker', value, 'tail'])).toEqual(['marker', value, 'tail']);
    });
  }
});
