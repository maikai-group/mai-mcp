param(
  [Parameter(Mandatory=$true)]
  [ValidateSet('ReviewCleanup','Backup')][string]$Job,
  [Parameter(Mandatory=$true)]
  [ValidateSet('Install','Status','Uninstall')][string]$Action,
  [string]$CheckoutRoot = (Resolve-Path (Join-Path $PSScriptRoot '..\..')).Path
)

# Per-user Windows Task Scheduler registration for mai-mcp maintenance jobs.
# Never elevates, never stores a password, never touches a task it did not name.

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest

$TaskNames = @{
  ReviewCleanup = 'mai-mcp-review-scratch-cleanup'
  Backup        = 'mai-mcp-brain-backup'
}

# One quoting function for every scheduled action. Produces the Microsoft C
# runtime command-line form: an argument that contains whitespace or a quote
# is wrapped in double quotes, backslashes before a quote are doubled and the
# quote is escaped, and trailing backslashes inside the quotes are doubled.
function Quote-WindowsArgument {
  param([Parameter(Mandatory=$true)][AllowEmptyString()][string]$Value)
  if ($Value.Length -gt 0 -and $Value -notmatch '[\s"]') { return $Value }
  $builder = New-Object System.Text.StringBuilder
  [void]$builder.Append('"')
  $backslashes = 0
  foreach ($ch in $Value.ToCharArray()) {
    if ($ch -eq [char]'\') { $backslashes++; continue }
    if ($ch -eq [char]'"') {
      [void]$builder.Append([char]'\', ($backslashes * 2) + 1)
      [void]$builder.Append('"')
      $backslashes = 0
      continue
    }
    if ($backslashes -gt 0) { [void]$builder.Append([char]'\', $backslashes); $backslashes = 0 }
    [void]$builder.Append($ch)
  }
  if ($backslashes -gt 0) { [void]$builder.Append([char]'\', $backslashes * 2) }
  [void]$builder.Append('"')
  return $builder.ToString()
}

function Resolve-CheckoutRoot {
  param([string]$Root)
  if (-not [System.IO.Path]::IsPathRooted($Root) -or -not (Test-Path -LiteralPath $Root -PathType Container)) {
    throw '-CheckoutRoot must be an absolute existing directory'
  }
  return [System.IO.Path]::GetFullPath($Root)
}

function Resolve-NodeExecutable {
  $node = (Get-Command node.exe -ErrorAction Stop).Source
  if (-not [System.IO.Path]::IsPathRooted($node)) { throw "node.exe resolved to a non-absolute path: $node" }
  return $node
}

function Get-JobDefinition {
  param([string]$JobName, [string]$Root, [string]$NodeExe)
  switch ($JobName) {
    'ReviewCleanup' {
      $helper = Join-Path $Root 'skills\plan-review-cycle\scripts\review-scratch.mjs'
      return @{
        TaskName   = $TaskNames.ReviewCleanup
        Executable = $NodeExe
        Arguments  = @($helper, 'prune', '--days', '7')
        Requires   = @($helper)
        Triggers   = @('AtLogOn', 'Daily 05:10')
      }
    }
    'Backup' {
      $entry = Join-Path $Root 'build\entry.js'
      $logFile = Join-Path (Join-Path (Join-Path $env:LOCALAPPDATA 'mai-mcp') 'logs') 'backup.log'
      return @{
        TaskName   = $TaskNames.Backup
        Executable = $NodeExe
        Arguments  = @($entry, 'backup', '--log-file', $logFile)
        Requires   = @($entry)
        LogFile    = $logFile
        Triggers   = @('Daily 04:30')
      }
    }
  }
  throw "unknown job: $JobName"
}

function New-JobTriggers {
  param([string[]]$Specs, [string]$User)
  $triggers = @()
  foreach ($spec in $Specs) {
    if ($spec -eq 'AtLogOn') {
      $triggers += New-ScheduledTaskTrigger -AtLogOn -User $User
    } elseif ($spec -like 'Daily *') {
      $triggers += New-ScheduledTaskTrigger -Daily -At $spec.Substring(6)
    } else {
      throw "unknown trigger spec: $spec"
    }
  }
  return $triggers
}

function Install-Job {
  param($Definition, [string]$Root)
  foreach ($required in $Definition.Requires) {
    if (-not (Test-Path -LiteralPath $required -PathType Leaf)) {
      throw "cannot install $($Definition.TaskName): missing $required (build the checkout first)"
    }
  }
  $user = [Security.Principal.WindowsIdentity]::GetCurrent().Name
  $argumentString = ($Definition.Arguments | ForEach-Object { Quote-WindowsArgument -Value $_ }) -join ' '
  $action = New-ScheduledTaskAction -Execute $Definition.Executable -Argument $argumentString -WorkingDirectory $Root
  $principal = New-ScheduledTaskPrincipal -UserId $user -LogonType Interactive -RunLevel Limited
  $settings = New-ScheduledTaskSettingsSet -StartWhenAvailable -MultipleInstances IgnoreNew -ExecutionTimeLimit (New-TimeSpan -Hours 2)
  $triggers = New-JobTriggers -Specs $Definition.Triggers -User $user
  [void](Register-ScheduledTask -TaskName $Definition.TaskName -TaskPath '\' -Action $action -Trigger $triggers -Principal $principal -Settings $settings -Force)
  Write-Output "installed: $($Definition.TaskName)"
  Write-Output "executable: $($Definition.Executable)"
  Write-Output "arguments: $argumentString"
}

function Show-JobStatus {
  param($Definition)
  $task = Get-ScheduledTask -TaskName $Definition.TaskName -TaskPath '\' -ErrorAction SilentlyContinue
  if ($null -eq $task) { throw "not installed: $($Definition.TaskName)" }
  $info = Get-ScheduledTaskInfo -TaskName $Definition.TaskName -TaskPath '\'
  $primary = @($task.Actions)[0]
  Write-Output "task: $($task.TaskName)"
  Write-Output "taskPath: $($task.TaskPath)"
  Write-Output "state: $($task.State)"
  Write-Output "user: $($task.Principal.UserId)"
  Write-Output "runLevel: $($task.Principal.RunLevel)"
  Write-Output "executable: $($primary.Execute)"
  Write-Output "arguments: $($primary.Arguments)"
  Write-Output "nextRun: $($info.NextRunTime)"
  Write-Output "lastResult: $($info.LastTaskResult)"
  if ($Definition.ContainsKey('LogFile')) {
    Write-Output "logFile: $($Definition.LogFile)"
    if (Test-Path -LiteralPath $Definition.LogFile -PathType Leaf) {
      $last = Get-Content -LiteralPath $Definition.LogFile -Tail 1
      Write-Output "lastLog: $last"
    } else {
      Write-Output 'lastLog: (no runs recorded)'
    }
  }
}

function Uninstall-Job {
  param($Definition)
  # Pinned to the root folder: without -TaskPath the name matches across the
  # whole task tree and a same-named foreign task could be reported or removed.
  $task = Get-ScheduledTask -TaskName $Definition.TaskName -TaskPath '\' -ErrorAction SilentlyContinue
  if ($null -eq $task) {
    Write-Output "no such task: $($Definition.TaskName)"
    return
  }
  Unregister-ScheduledTask -TaskName $Definition.TaskName -TaskPath '\' -Confirm:$false
  Write-Output "uninstalled: $($Definition.TaskName)"
}

$root = Resolve-CheckoutRoot -Root $CheckoutRoot
$definition = Get-JobDefinition -JobName $Job -Root $root -NodeExe (Resolve-NodeExecutable)
switch ($Action) {
  'Install'   { Install-Job -Definition $definition -Root $root }
  'Status'    { Show-JobStatus -Definition $definition }
  'Uninstall' { Uninstall-Job -Definition $definition }
}
