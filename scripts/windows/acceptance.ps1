param(
  [Parameter(Mandatory=$true)][ValidateSet('Automated','Finalize')][string]$Phase,
  [Parameter(Mandatory=$true)][string]$CheckoutRoot,
  [Parameter(Mandatory=$true)][ValidatePattern('^[0-9a-f]{40}$')][string]$ReviewedSha,
  [Parameter(Mandatory=$true)][string]$PublicTree,
  [Parameter(Mandatory=$true)][string]$InstallerPackage,
  [string]$DraftReceipt,
  [string]$OutputReceipt
)

# Shadow PC acceptance runner (Plan 32b Task 8, spec §11). Two phases, fail
# closed. Every native command runs through the call operator with an argv
# array; nothing is interpolated into a command line, no shell is consulted,
# no environment is dumped, and the checkout is never fetched, reset or moved.
# The releasable receipt carries booleans, versions and hashes only; local
# paths live in the draft and are stripped before the receipt is written.

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest

$script:Stage = 'preflight'
$script:StageLog = New-Object System.Collections.Generic.List[object]
$script:AcceptanceRoot = $null
$script:InstalledCheckout = $null
$script:NodeExe = $null
$script:DashboardRetained = $false
$script:RestoreDatabase = $null
$DashboardTaskName = 'mai-mcp-dashboard'
$ReviewTaskName = 'mai-mcp-review-scratch-cleanup'
$BackupTaskName = 'mai-mcp-brain-backup'
$PublicRepoUrl = 'https://github.com/maikai-group/mai-mcp.git'

function Enter-Stage { param([string]$Name) $script:Stage = $Name; Write-Host "==> $Name" }

# Runs one native command with an argv array. Returns @{ Code; Output }.
function Invoke-Native {
  param(
    [Parameter(Mandatory=$true)][string]$File,
    [string[]]$Arguments = @(),
    [string]$WorkingDirectory,
    [hashtable]$Environment
  )
  $previous = @{}
  if ($Environment) {
    foreach ($key in $Environment.Keys) {
      $previous[$key] = [Environment]::GetEnvironmentVariable($key, 'Process')
      [Environment]::SetEnvironmentVariable($key, $Environment[$key], 'Process')
    }
  }
  $pushed = $false
  if ($WorkingDirectory) { Push-Location -LiteralPath $WorkingDirectory; $pushed = $true }
  # Windows PowerShell 5.1 turns every merged stderr line into a NativeCommandError
  # that a 'Stop' preference makes terminating; the exit code is the only verdict here.
  $previousEap = $ErrorActionPreference
  $ErrorActionPreference = 'Continue'
  try {
    $lines = & $File @Arguments 2>&1 | ForEach-Object { "$_" }
    $code = $LASTEXITCODE
  } finally {
    $ErrorActionPreference = $previousEap
    if ($pushed) { Pop-Location }
    foreach ($key in $previous.Keys) { [Environment]::SetEnvironmentVariable($key, $previous[$key], 'Process') }
  }
  return @{ Code = $code; Output = (@($lines) -join "`n") }
}

function Assert-Native {
  param([string]$File, [string[]]$Arguments = @(), [string]$WorkingDirectory, [hashtable]$Environment, [string]$Because)
  $result = Invoke-Native -File $File -Arguments $Arguments -WorkingDirectory $WorkingDirectory -Environment $Environment
  if ($result.Code -ne 0) { throw "$Because failed (exit $($result.Code)) in stage $($script:Stage)" }
  return $result.Output
}

function Get-Sha256Hex { param([string]$Path) return (Get-FileHash -LiteralPath $Path -Algorithm SHA256).Hash.ToLowerInvariant() }

# Same record shape as scripts/release-public.sh: sorted `path NUL sha LF`,
# every regular file except release-manifest.json and .git; symlinks refused.
function Get-TreeSha256 {
  param([string]$Root)
  $rootFull = [System.IO.Path]::GetFullPath($Root)
  $records = New-Object System.Collections.Generic.List[string]
  foreach ($file in Get-ChildItem -LiteralPath $rootFull -Recurse -Force -File) {
    if ($file.Attributes -band [System.IO.FileAttributes]::ReparsePoint) { throw "symlink in public tree: $($file.FullName)" }
    $rel = $file.FullName.Substring($rootFull.Length).TrimStart('\', '/').Replace('\', '/')
    if ($rel -eq 'release-manifest.json' -or $rel -like '.git/*') { continue }
    $records.Add($rel + [char]0 + (Get-Sha256Hex -Path $file.FullName) + "`n")
  }
  foreach ($dir in Get-ChildItem -LiteralPath $rootFull -Recurse -Force -Directory) {
    if ($dir.Attributes -band [System.IO.FileAttributes]::ReparsePoint) { throw "reparse point in public tree: $($dir.FullName)" }
  }
  $sorted = $records.ToArray()
  [System.Array]::Sort($sorted, [System.StringComparer]::Ordinal)
  $sha = [System.Security.Cryptography.SHA256]::Create()
  $bytes = [System.Text.Encoding]::UTF8.GetBytes(($sorted -join ''))
  return ([System.BitConverter]::ToString($sha.ComputeHash($bytes)) -replace '-', '').ToLowerInvariant()
}

function Get-UtcStamp { return (Get-Date).ToUniversalTime().ToString('yyyy-MM-ddTHH:mm:ssZ') }

function Read-JsonFile { param([string]$Path) return (Get-Content -LiteralPath $Path -Raw | ConvertFrom-Json) }

function Write-JsonAtomic {
  param([string]$Path, $Value)
  $json = $Value | ConvertTo-Json -Depth 8
  $temp = "$Path.$([guid]::NewGuid().ToString('N')).tmp"
  [System.IO.File]::WriteAllText($temp, $json + "`n", (New-Object System.Text.UTF8Encoding($false)))
  Move-Item -LiteralPath $temp -Destination $Path -Force
}

# ---- preflight (shared by both phases) ----
function Test-Preflight {
  Enter-Stage 'preflight'
  $root = [System.IO.Path]::GetFullPath($CheckoutRoot)
  if (-not (Test-Path -LiteralPath $root -PathType Container)) { throw "checkout root is not a directory" }
  $head = (Assert-Native -File 'git' -Arguments @('-C', $root, 'rev-parse', 'HEAD') -Because 'git rev-parse').Trim()
  if ($head -ne $ReviewedSha) { throw "checkout HEAD $head is not the reviewed SHA $ReviewedSha" }
  $status = (Invoke-Native -File 'git' -Arguments @('-C', $root, 'status', '--porcelain', '--untracked-files=all')).Output
  $allowed = @()
  if ($Phase -eq 'Finalize') { $allowed = @('docs/release/windows/') }
  foreach ($line in ($status -split "`n")) {
    if (-not $line.Trim()) { continue }
    $rel = $line.Substring(3).Trim()
    $tolerated = $false
    foreach ($prefix in $allowed) { if ($rel.StartsWith($prefix) -and $rel -like '*windows-11-*.json') { $tolerated = $true } }
    if (-not $tolerated) { throw "checkout is not clean: $line" }
  }
  $identity = [Security.Principal.WindowsIdentity]::GetCurrent()
  $principal = New-Object Security.Principal.WindowsPrincipal($identity)
  if ($principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) { throw 'acceptance must run as a non-admin user' }
  $os = Get-CimInstance Win32_OperatingSystem
  if ($os.Caption -notlike '*Windows 11*') { throw "not Windows 11: $($os.Caption)" }
  $script:NodeExe = (Get-Command node.exe -ErrorAction Stop).Source
  $nodeVersion = (Assert-Native -File $script:NodeExe -Arguments @('--version') -Because 'node --version').Trim()
  if ($nodeVersion -notmatch '^v24\.') { throw "Node major must be 24, found $nodeVersion" }
  $npmVersion = (Assert-Native -File (Get-Command npm.cmd -ErrorAction Stop).Source -Arguments @('--version') -Because 'npm --version').Trim()
  $gitVersion = ((Assert-Native -File 'git' -Arguments @('--version') -Because 'git --version').Trim() -replace '^git version ', '')
  $dockerVersion = (Assert-Native -File (Get-Command docker.exe -ErrorAction Stop).Source -Arguments @('version', '--format', '{{.Server.Version}}') -Because 'docker server').Trim()
  $claudeExe = (Get-Command claude -ErrorAction Stop).Source
  $codexExe = (Get-Command codex -ErrorAction Stop).Source
  $claudeVersion = ((Invoke-Native -File $claudeExe -Arguments @('--version')).Output.Trim() -replace '[^0-9.].*$', '')
  $codexVersion = ((Invoke-Native -File $codexExe -Arguments @('--version')).Output.Trim() -replace '^[^0-9]*', '' -replace '[^0-9.].*$', '')

  $publicTree = [System.IO.Path]::GetFullPath($PublicTree)
  $manifestPath = Join-Path $publicTree 'release-manifest.json'
  if (-not (Test-Path -LiteralPath $manifestPath -PathType Leaf)) { throw 'public tree has no release-manifest.json' }
  $manifest = Read-JsonFile -Path $manifestPath
  if ($manifest.sourceSha -ne $ReviewedSha) { throw "public tree sourceSha $($manifest.sourceSha) is not the reviewed SHA" }
  $treeSha = Get-TreeSha256 -Root $publicTree
  if ($treeSha -ne $manifest.treeSha256) { throw 'public tree hash does not match its manifest' }
  foreach ($field in @('count', 'chars', 'reserve')) {
    if (-not ($manifest.toolDefinitions.PSObject.Properties.Name -contains $field)) { throw "manifest toolDefinitions lacks $field" }
  }
  $installerPath = [System.IO.Path]::GetFullPath($InstallerPackage)
  if (-not (Test-Path -LiteralPath $installerPath -PathType Leaf)) { throw 'installer package is missing' }
  $installerSha = Get-Sha256Hex -Path $installerPath

  return @{
    Root = $root; PublicTree = $publicTree; Manifest = $manifest; TreeSha = $treeSha
    InstallerPath = $installerPath; InstallerSha = $installerSha
    Versions = @{ node = $nodeVersion; npm = $npmVersion; git = $gitVersion; docker = $dockerVersion; claude = $claudeVersion; codex = $codexVersion }
    Platform = @{ os = 'Windows 11'; osBuild = [string]$os.BuildNumber; architecture = $env:PROCESSOR_ARCHITECTURE; nonAdmin = $true }
  }
}

# ---- cleanup that always runs ----
# Always runs (finally). Every step is guarded against the state that may not
# exist yet and isolated in its own try/catch, so one failed step can neither
# mask the in-flight exception nor skip the steps after it.
function Invoke-Cleanup {
  param([bool]$Succeeded)
  try {
    if ($script:InstalledCheckout) {
      $maintenance = Join-Path $script:InstalledCheckout 'scripts\windows\install-maintenance.ps1'
      if (Test-Path -LiteralPath $maintenance -PathType Leaf) {
        foreach ($job in @('ReviewCleanup', 'Backup')) {
          [void](Invoke-Native -File 'powershell.exe' -Arguments @('-NoLogo', '-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', $maintenance, '-Job', $job, '-Action', 'Uninstall', '-CheckoutRoot', $script:InstalledCheckout))
        }
      }
    }
  } catch { Write-Host "cleanup step failed (maintenance schedules): $($_.Exception.Message)" }
  try {
    if (-not $Succeeded -and $script:InstalledCheckout) {
      $dashboard = Join-Path $script:InstalledCheckout 'scripts\windows\install-dashboard.ps1'
      if (Test-Path -LiteralPath $dashboard -PathType Leaf) {
        [void](Invoke-Native -File 'powershell.exe' -Arguments @('-NoLogo', '-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', $dashboard, '-Action', 'Uninstall', '-CheckoutRoot', $script:InstalledCheckout))
      }
    }
  } catch { Write-Host "cleanup step failed (dashboard schedule): $($_.Exception.Message)" }
  try {
    if ($script:RestoreDatabase) {
      [void](Invoke-Native -File 'docker' -Arguments @('exec', 'mai-brain-pg', 'psql', '--username', 'postgres', '--dbname', 'postgres', '-c', "DROP DATABASE IF EXISTS `"$($script:RestoreDatabase)`""))
    }
  } catch { Write-Host "cleanup step failed (restore database): $($_.Exception.Message)" }
  if (-not $Succeeded -and $script:AcceptanceRoot) {
    Write-Host "acceptance root retained for inspection: $($script:AcceptanceRoot)"
  }
}

function Write-FailureRecord {
  param([string]$Message)
  $record = @{ phase = $Phase; failedStage = $script:Stage; stages = @($script:StageLog); message = $Message }
  $file = Join-Path $env:TEMP "mai-windows-acceptance-$((Get-Date).ToUniversalTime().ToString('yyyyMMddTHHmmssZ')).failed.json"
  Write-JsonAtomic -Path $file -Value $record
  Write-Host "failure record (never a receipt): $file"
}

function Add-StageResult { param([string]$Name, [int]$Code) $script:StageLog.Add(@{ stage = $Name; exitCode = $Code }) }

# ---- dashboard helpers ----
function Get-DashboardStatusText {
  param([string]$Checkout)
  $installer = Join-Path $Checkout 'scripts\windows\install-dashboard.ps1'
  return Invoke-Native -File 'powershell.exe' -Arguments @('-NoLogo', '-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', $installer, '-Action', 'Status', '-CheckoutRoot', $Checkout)
}

function Assert-DashboardRunning {
  param([string]$Checkout, [string]$Because)
  $status = Get-DashboardStatusText -Checkout $Checkout
  $user = [Security.Principal.WindowsIdentity]::GetCurrent().Name
  $text = $status.Output
  if ($status.Code -ne 0) { throw "${Because}: dashboard status exit $($status.Code)" }
  if ($text -notmatch 'Supervisor running: yes') { throw "${Because}: supervisor not running" }
  if ($text -notmatch [regex]::Escape("Run as: $user")) { throw "${Because}: task does not run as the current user" }
  if ($text -notmatch 'Run level: Limited') { throw "${Because}: task is not at Limited run level" }
  if ($text -notmatch 'Health: OK') { throw "${Because}: Health is not OK" }
  $buildInfo = Read-JsonFile -Path (Join-Path $Checkout 'build\build-info.json')
  if ($text -notmatch [regex]::Escape("Current build: ")) { throw "${Because}: no build line" }
  if ($text -notmatch [regex]::Escape([string]$buildInfo.sha)) { throw "${Because}: status does not report the exact current build" }
}

function Wait-DashboardRestart {
  param([string]$Checkout, [int]$TimeoutSeconds = 180)
  $deadline = (Get-Date).AddSeconds($TimeoutSeconds)
  do {
    Start-Sleep -Seconds 5
    $status = Get-DashboardStatusText -Checkout $Checkout
    if ($status.Code -eq 0 -and $status.Output -match 'Health: OK' -and $status.Output -match 'Supervisor running: yes') { return $true }
  } while ((Get-Date) -lt $deadline)
  return $false
}

# ---- MCP surface probe: initialize + tools/list over stdio ----
# The request lines are piped into the server through the call operator; the
# server exits when stdin closes, so the whole exchange is one native call.
function Get-McpToolNames {
  param([string]$Checkout, [string]$Slug, [string]$ProjectRoot)
  $requests = Join-Path $script:AcceptanceRoot 'mcp-requests.jsonl'
  $lines = @(
    (@{ jsonrpc = '2.0'; id = 1; method = 'initialize'; params = @{ protocolVersion = '2025-06-18'; capabilities = @{}; clientInfo = @{ name = 'mai-windows-acceptance'; version = '0' } } } | ConvertTo-Json -Compress -Depth 6),
    (@{ jsonrpc = '2.0'; method = 'notifications/initialized' } | ConvertTo-Json -Compress),
    (@{ jsonrpc = '2.0'; id = 2; method = 'tools/list'; params = @{} } | ConvertTo-Json -Compress)
  )
  [System.IO.File]::WriteAllText($requests, ($lines -join "`n") + "`n", (New-Object System.Text.UTF8Encoding($false)))
  $previous = @{ MAI_PROJECT_SLUG = $env:MAI_PROJECT_SLUG; MAI_PROJECT_ROOT = $env:MAI_PROJECT_ROOT }
  $env:MAI_PROJECT_SLUG = $Slug
  $env:MAI_PROJECT_ROOT = $ProjectRoot
  Push-Location -LiteralPath $Checkout
  try {
    $serverArgs = @((Join-Path $Checkout 'build\index.js'))
    $output = @(Get-Content -LiteralPath $requests | & $script:NodeExe @serverArgs 2>$null | ForEach-Object { "$_" })
  } finally {
    Pop-Location
    [Environment]::SetEnvironmentVariable('MAI_PROJECT_SLUG', $previous.MAI_PROJECT_SLUG, 'Process')
    [Environment]::SetEnvironmentVariable('MAI_PROJECT_ROOT', $previous.MAI_PROJECT_ROOT, 'Process')
  }
  foreach ($line in $output) {
    if (-not $line.Trim().StartsWith('{')) { continue }
    $message = $line | ConvertFrom-Json
    if ($message.PSObject.Properties.Name -contains 'id' -and $message.id -eq 2) {
      return @($message.result.tools | ForEach-Object { [string]$_.name })
    }
  }
  throw 'no tools/list response from the installed MCP server'
}

# ---- managed wiring assertions ----
function Test-ManagedWiring {
  param([string]$Consumer, [string]$Checkout, [string]$Slug)
  $runner = (Join-Path $Checkout 'build\scripts\hook-runner.js')
  $mcp = Read-JsonFile -Path (Join-Path $Consumer '.mcp.json')
  $entry = $mcp.mcpServers.'mai-mcp'
  if ($null -eq $entry) { throw '.mcp.json has no mai-mcp server' }
  if ($entry.command -notmatch 'node') { throw '.mcp.json mai-mcp command is not the Node runner' }
  if (@($mcp.mcpServers.PSObject.Properties | Where-Object { $_.Name -eq 'mai-mcp' }).Count -ne 1) { throw '.mcp.json must carry exactly one mai-mcp entry' }
  $settings = Read-JsonFile -Path (Join-Path $Consumer '.claude\settings.json')
  $hookCommands = @()
  foreach ($event in $settings.hooks.PSObject.Properties) {
    foreach ($group in $event.Value) { foreach ($hook in $group.hooks) { $hookCommands += [string]$hook.command } }
  }
  $managed = @($hookCommands | Where-Object { $_ -match 'hook-runner\.js' })
  if ($managed.Count -lt 4) { throw "expected the four managed Claude hooks, found $($managed.Count)" }
  foreach ($command in $managed) {
    if ($command -notmatch '^node ') { throw "hook is not a Node runner: $command" }
    if ($command -match 'bash|MAI_PROJECT_SLUG=') { throw "hook carries a legacy shape: $command" }
    if ($command -notmatch [regex]::Escape($runner.Replace('\', '/')) -and $command -notmatch [regex]::Escape($runner)) { throw "hook does not name the installed runner: $command" }
  }
  $toml = Get-Content -LiteralPath (Join-Path $Consumer '.codex\config.toml') -Raw
  if (([regex]::Matches($toml, '(?m)^\[mcp_servers\.mai-mcp\]')).Count -ne 1) { throw 'config.toml must carry exactly one [mcp_servers.mai-mcp] section' }
  $notify = [regex]::Matches($toml, '(?m)^notify\s*=')
  if ($notify.Count -ne 1) { throw 'config.toml must carry exactly one notify setting' }
  if ($toml -notmatch 'hook-runner\.js') { throw 'config.toml notify is not the Node runner' }
  foreach ($rules in @('CLAUDE.md', 'AGENTS.md')) {
    $text = Get-Content -LiteralPath (Join-Path $Consumer $rules) -Raw
    if (([regex]::Matches($text, '(?m)^#{1,6} .*MEMORY BRAIN \(mai-mcp\)')).Count -ne 1) { throw "$rules must carry exactly one managed brain block heading" }
    if (([regex]::Matches($text, '(?m)^<!-- /mai-brain-block v\d+ -->')).Count -ne 1) { throw "$rules must carry exactly one managed block sentinel" }
    if ($text -notmatch [regex]::Escape($Slug)) { throw "$rules does not name the acceptance slug" }
  }
}

function Get-ManagedFileDigest {
  param([string]$Consumer)
  $digest = @{}
  foreach ($rel in @('.mcp.json', '.claude\settings.json', '.codex\config.toml', 'CLAUDE.md', 'AGENTS.md')) {
    $text = (Get-Content -LiteralPath (Join-Path $Consumer $rel) -Raw) -replace "`r`n", "`n"
    $digest[$rel] = $text
  }
  return $digest
}

# ---- scratch helpers ----
function Invoke-Scratch {
  param([string]$Checkout, [string[]]$Arguments, [hashtable]$Environment)
  $helper = Join-Path $Checkout 'skills\plan-review-cycle\scripts\review-scratch.mjs'
  return Invoke-Native -File $script:NodeExe -Arguments (@($helper) + $Arguments) -Environment $Environment
}

function Set-ScratchOld {
  param([string]$Root, [int]$Days = 10)
  $when = (Get-Date).AddDays(-$Days)
  $marker = Join-Path $Root '.mai-review-scratch-v1'
  $text = Get-Content -LiteralPath $marker -Raw
  $stamp = $when.ToUniversalTime().ToString('yyyy-MM-ddTHH:mm:ssZ')
  $text = [regex]::Replace($text, '(?m)^created_at=.*$', "created_at=$stamp")
  [System.IO.File]::WriteAllText($marker, $text, (New-Object System.Text.UTF8Encoding($false)))
  foreach ($item in Get-ChildItem -LiteralPath $Root -Recurse -Force) { $item.LastWriteTime = $when }
  (Get-Item -LiteralPath $Root -Force).LastWriteTime = $when
}

# ---- Automated phase ----
function Invoke-AutomatedPhase {
  param($Pre)
  $automated = [ordered]@{}
  $runId = ([guid]::NewGuid().ToString('N')).Substring(0, 8)
  $slug = "mai-windows-acceptance-$runId"
  $script:AcceptanceRoot = Join-Path $env:TEMP "mai Windows acceptance & $([guid]::NewGuid())"
  New-Item -ItemType Directory -Path $script:AcceptanceRoot | Out-Null
  $installedCheckout = Join-Path $script:AcceptanceRoot 'installed checkout'
  $installerRoot = Join-Path $script:AcceptanceRoot 'installer package'
  $consumerRepo = Join-Path $script:AcceptanceRoot 'consumer repo & one'
  $script:InstalledCheckout = $installedCheckout

  Enter-Stage 'installerExistingCheckout'
  Copy-Item -LiteralPath $Pre.PublicTree -Destination $installedCheckout -Recurse
  $gitDir = Join-Path $installedCheckout '.git'
  if (Test-Path -LiteralPath $gitDir) { Remove-Item -LiteralPath $gitDir -Recurse -Force }
  [void](Assert-Native -File 'git' -Arguments @('-C', $installedCheckout, 'init', '-q', '-b', 'main') -Because 'git init')
  [void](Assert-Native -File 'git' -Arguments @('-C', $installedCheckout, 'add', '-A') -Because 'git add')
  [void](Assert-Native -File 'git' -Arguments @('-C', $installedCheckout, '-c', 'user.name=mai-windows-acceptance', '-c', 'user.email=acceptance.invalid', 'commit', '-q', '-m', 'runtime') -Because 'git commit')
  [void](Assert-Native -File 'git' -Arguments @('-C', $installedCheckout, 'remote', 'add', 'origin', $PublicRepoUrl) -Because 'git remote add')
  New-Item -ItemType Directory -Path $installerRoot | Out-Null
  $npm = (Get-Command npm.cmd -ErrorAction Stop).Source
  [void](Assert-Native -File $npm -Arguments @('install', '--ignore-scripts', '--no-save', '--prefix', $installerRoot, $Pre.InstallerPath) -Because 'npm install of the installer package')
  $installerBin = Join-Path $installerRoot 'node_modules\mai-mcp\bin\mai-mcp.mjs'
  if (-not (Test-Path -LiteralPath $installerBin -PathType Leaf)) { throw 'installed package exposes no bin/mai-mcp.mjs' }
  New-Item -ItemType Directory -Path $consumerRepo | Out-Null
  [void](Assert-Native -File 'git' -Arguments @('-C', $consumerRepo, 'init', '-q', '-b', 'main') -Because 'consumer git init')
  $setupArgs = @($installerBin, 'setup', '--dir', $installedCheckout, '--yes', '--', '--slug', $slug, '--root', $consumerRepo, '--harness', 'all', '--llm', 'none', '--embeddings', 'none')
  $setup = Invoke-Native -File $script:NodeExe -Arguments $setupArgs -WorkingDirectory $consumerRepo
  Add-StageResult -Name 'setup' -Code $setup.Code
  if ($setup.Code -ne 0) { throw "installer setup failed (exit $($setup.Code))" }
  $automated.installerExistingCheckout = $true
  Enter-Stage 'setup'
  $automated.setup = ($setup.Output -match 'mai-mcp home:')
  if (-not $automated.setup) { throw 'installer did not report the checkout home' }
  Enter-Stage 'database'
  $automated.database = ($setup.Output -match 'Postgres is accepting connections' -or $setup.Output -match 'reusing the running mai-brain-pg container')
  if (-not $automated.database) { throw 'setup did not prove the database' }
  Enter-Stage 'migrations'
  $automated.migrations = ($setup.Output -match 'migration\(s\) via')
  if (-not $automated.migrations) { throw 'setup did not apply migrations' }
  $entry = Join-Path $installedCheckout 'build\entry.js'
  if (-not (Test-Path -LiteralPath $entry -PathType Leaf)) { throw 'installed checkout has no build/entry.js' }
  $liveTools = (Assert-Native -File $script:NodeExe -Arguments @('-e', "Promise.all([import('./build/tool-defs.js'),import('./build/coordination/index.js')]).then(([t,c])=>{const all=[...t.TOOLS,...c.coordination.toolDefs];console.log(JSON.stringify({count:all.length,chars:JSON.stringify(all).length,reserve:31000-JSON.stringify(all).length}));});") -WorkingDirectory $installedCheckout -Environment @{ MAI_PROJECT_SLUG = 'budget-test' } -Because 'tool-definition derivation').Trim() | ConvertFrom-Json
  foreach ($field in @('count', 'chars', 'reserve')) {
    if ([int]$liveTools.$field -ne [int]$Pre.Manifest.toolDefinitions.$field) { throw "installed tool surface $field differs from the manifest" }
  }

  Enter-Stage 'verifySmoke'
  $verify = Invoke-Native -File $script:NodeExe -Arguments @($entry, 'verify', $slug, '--smoke') -WorkingDirectory $installedCheckout
  Add-StageResult -Name 'verifySmoke' -Code $verify.Code
  if ($verify.Code -ne 0 -or $verify.Output -notmatch 'PASS' -or $verify.Output -match 'FAIL') { throw 'verify --smoke did not pass' }
  $automated.verifySmoke = $true

  Enter-Stage 'mcpSurface'
  $names = Get-McpToolNames -Checkout $installedCheckout -Slug $slug -ProjectRoot $consumerRepo
  if ($names.Count -ne [int]$Pre.Manifest.toolDefinitions.count) { throw "served $($names.Count) tools; manifest says $($Pre.Manifest.toolDefinitions.count)" }
  if (@($names | Select-Object -Unique).Count -ne $names.Count) { throw 'served tool names are not unique' }
  $automated.mcpSurface = $true

  Enter-Stage 'wiring'
  Test-ManagedWiring -Consumer $consumerRepo -Checkout $installedCheckout -Slug $slug
  $automated.wiring = $true

  Enter-Stage 'dashboard'
  $dashboardInstaller = Join-Path $installedCheckout 'scripts\windows\install-dashboard.ps1'
  $psArgs = @('-NoLogo', '-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', $dashboardInstaller)
  [void](Assert-Native -File 'powershell.exe' -Arguments ($psArgs + @('-Action', 'Install', '-CheckoutRoot', $installedCheckout)) -Because 'dashboard persist install')
  if (-not (Wait-DashboardRestart -Checkout $installedCheckout -TimeoutSeconds 120)) { throw 'dashboard did not become healthy after install' }
  Assert-DashboardRunning -Checkout $installedCheckout -Because 'after install'
  $statusText = (Get-DashboardStatusText -Checkout $installedCheckout).Output
  $urlLine = ($statusText -split "`n" | Where-Object { $_ -like 'Dashboard URL: *' } | Select-Object -First 1)
  if (-not $urlLine) { throw 'dashboard status printed no URL' }
  $url = $urlLine.Substring('Dashboard URL: '.Length).Trim()
  $envFile = Join-Path $installedCheckout '.env'
  $token = ''
  $tokenKey = 'MAI_BRAIN_WEB_TOKEN'
  if (Test-Path -LiteralPath $envFile -PathType Leaf) {
    $tokenLine = Get-Content -LiteralPath $envFile | Where-Object { $_.StartsWith("$tokenKey=") } | Select-Object -First 1
    if ($tokenLine) { $token = $tokenLine.Substring($tokenKey.Length + 1) }
  }
  $headers = @{}
  if ($token) { $headers['x-mai-brain-token'] = $token }
  $projects = Invoke-WebRequest -UseBasicParsing -Uri ($url.TrimEnd('/') + '/api/projects') -Headers $headers -TimeoutSec 30
  if ($projects.StatusCode -ne 200) { throw "authenticated /api/projects returned $($projects.StatusCode)" }
  $automated.dashboard = $true
  Enter-Stage 'scheduledPersistence'
  $serverProcesses = @(Get-CimInstance Win32_Process | Where-Object { $_.Name -like 'node*' -and $_.CommandLine -like '*web-server.js*' })
  if ($serverProcesses.Count -lt 1) { throw 'no supervised dashboard server process found' }
  foreach ($server in $serverProcesses) { Stop-Process -Id $server.ProcessId -Force }
  if (-not (Wait-DashboardRestart -Checkout $installedCheckout -TimeoutSeconds 180)) { throw 'scheduled task did not restart the killed dashboard' }
  Assert-DashboardRunning -Checkout $installedCheckout -Because 'after kill'
  $script:DashboardRetained = $true

  Enter-Stage 'scratchEndCleanup'
  $scratch = (Invoke-Scratch -Checkout $installedCheckout -Arguments @('create'))
  if ($scratch.Code -ne 0) { throw 'scratch create failed' }
  $scratchRoot = $scratch.Output.Trim()
  if (-not (Test-Path -LiteralPath (Join-Path $scratchRoot '.mai-review-scratch-v1'))) { throw 'scratch root has no marker' }
  $cleanup = Invoke-Scratch -Checkout $installedCheckout -Arguments @('cleanup', $scratchRoot)
  if ($cleanup.Code -ne 0 -or (Test-Path -LiteralPath $scratchRoot)) { throw 'scratch cleanup did not remove the root' }
  $automated.scratchEndCleanup = $true

  Enter-Stage 'scratchPrune'
  $abandoned = (Invoke-Scratch -Checkout $installedCheckout -Arguments @('create')).Output.Trim()
  $held = Join-Path $abandoned 'held-open.txt'
  [System.IO.File]::WriteAllText($held, 'held')
  # Backdate only after the last file exists: creating a file bumps the
  # directory mtime, and the helper measures age from the newest entry.
  Set-ScratchOld -Root $abandoned
  $handle = [System.IO.File]::Open($held, 'Open', 'Read', [System.IO.FileShare]::None)
  try {
    $retained = Invoke-Scratch -Checkout $installedCheckout -Arguments @('prune', '--days', '7', '--root', $env:TEMP)
    if ($retained.Code -ne 0) { throw 'prune with an open file failed' }
    if (-not (Test-Path -LiteralPath $abandoned)) { throw 'an open-file root was pruned' }
    if ($retained.Output -notmatch 'retaining ') { throw 'the open-file probe did not report a retention reason (a freshness retention would pass vacuously)' }
  } finally {
    $handle.Dispose()
  }
  $pruned = Invoke-Scratch -Checkout $installedCheckout -Arguments @('prune', '--days', '7', '--root', $env:TEMP)
  if ($pruned.Code -ne 0 -or (Test-Path -LiteralPath $abandoned)) { throw 'the released abandoned root was not pruned' }
  $automated.scratchPrune = $true

  Enter-Stage 'janitorSchedule'
  $maintenance = Join-Path $installedCheckout 'scripts\windows\install-maintenance.ps1'
  $mArgs = @('-NoLogo', '-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', $maintenance)
  [void](Assert-Native -File 'powershell.exe' -Arguments ($mArgs + @('-Job', 'ReviewCleanup', '-Action', 'Install', '-CheckoutRoot', $installedCheckout)) -Because 'ReviewCleanup install')
  $janitorStatus = Assert-Native -File 'powershell.exe' -Arguments ($mArgs + @('-Job', 'ReviewCleanup', '-Action', 'Status', '-CheckoutRoot', $installedCheckout)) -Because 'ReviewCleanup status'
  if ($janitorStatus -notmatch "task: $ReviewTaskName" -or $janitorStatus -notmatch 'runLevel: Limited' -or $janitorStatus -notmatch 'taskPath: \\') { throw 'ReviewCleanup status is not the limited exact-name root-folder task' }
  [void](Assert-Native -File 'powershell.exe' -Arguments ($mArgs + @('-Job', 'ReviewCleanup', '-Action', 'Uninstall', '-CheckoutRoot', $installedCheckout)) -Because 'ReviewCleanup uninstall')
  if ((Invoke-Native -File 'schtasks.exe' -Arguments @('/query', '/tn', $ReviewTaskName)).Code -eq 0) { throw 'ReviewCleanup task survived uninstall' }
  $automated.janitorSchedule = $true

  Enter-Stage 'backupRestore'
  $backup = Invoke-Native -File $script:NodeExe -Arguments @($entry, 'backup') -WorkingDirectory $installedCheckout
  Add-StageResult -Name 'backup' -Code $backup.Code
  if ($backup.Code -ne 0) { throw 'backup failed' }
  $dumps = @(Get-ChildItem -LiteralPath (Join-Path $installedCheckout 'db\backups') -Filter '*.sql' | Where-Object { -not $_.Name.StartsWith('.') } | Sort-Object LastWriteTime -Descending)
  if ($dumps.Count -lt 1) { throw 'no durable dump after backup' }
  $script:RestoreDatabase = "mai_windows_restore_$runId"
  [void](Assert-Native -File 'docker' -Arguments @('exec', 'mai-brain-pg', 'psql', '--username', 'postgres', '--dbname', 'postgres', '-c', "CREATE DATABASE `"$($script:RestoreDatabase)`"") -Because 'create restore database')
  $containerDump = "/tmp/mai-windows-restore-$runId.sql"
  [void](Assert-Native -File 'docker' -Arguments @('cp', $dumps[0].FullName, "mai-brain-pg:$containerDump") -Because 'copy dump into the container')
  [void](Assert-Native -File 'docker' -Arguments @('exec', 'mai-brain-pg', 'psql', '--username', 'postgres', '--dbname', $script:RestoreDatabase, '--quiet', '--file', $containerDump) -Because 'restore dump')
  [void](Invoke-Native -File 'docker' -Arguments @('exec', 'mai-brain-pg', 'rm', '-f', $containerDump))
  $count = (Assert-Native -File 'docker' -Arguments @('exec', 'mai-brain-pg', 'psql', '--username', 'postgres', '--dbname', $script:RestoreDatabase, '--tuples-only', '--no-align', '-c', 'SELECT count(*) FROM projects') -Because 'restore query').Trim()
  if ([int]$count -lt 1) { throw 'restored database has no projects' }
  [void](Assert-Native -File 'docker' -Arguments @('exec', 'mai-brain-pg', 'psql', '--username', 'postgres', '--dbname', 'postgres', '-c', "DROP DATABASE `"$($script:RestoreDatabase)`"") -Because 'drop restore database')
  $script:RestoreDatabase = $null
  $automated.backupRestore = $true

  Enter-Stage 'backupSchedule'
  [void](Assert-Native -File 'powershell.exe' -Arguments ($mArgs + @('-Job', 'Backup', '-Action', 'Install', '-CheckoutRoot', $installedCheckout)) -Because 'Backup install')
  $backupStatus = Assert-Native -File 'powershell.exe' -Arguments ($mArgs + @('-Job', 'Backup', '-Action', 'Status', '-CheckoutRoot', $installedCheckout)) -Because 'Backup status'
  if ($backupStatus -notmatch "task: $BackupTaskName" -or $backupStatus -notmatch 'runLevel: Limited' -or $backupStatus -notmatch 'taskPath: \\' -or $backupStatus -notmatch '--log-file') { throw 'Backup status is not the limited exact-name root-folder logged task' }
  [void](Assert-Native -File 'powershell.exe' -Arguments ($mArgs + @('-Job', 'Backup', '-Action', 'Uninstall', '-CheckoutRoot', $installedCheckout)) -Because 'Backup uninstall')
  if ((Invoke-Native -File 'schtasks.exe' -Arguments @('/query', '/tn', $BackupTaskName)).Code -eq 0) { throw 'Backup task survived uninstall' }
  $automated.backupSchedule = $true

  Enter-Stage 'rerunIdempotent'
  $before = Get-ManagedFileDigest -Consumer $consumerRepo
  $rerun = Invoke-Native -File $script:NodeExe -Arguments @($entry, 'setup', '--slug', $slug, '--root', $consumerRepo, '--harness', 'all', '--llm', 'none', '--embeddings', 'none', '--yes') -WorkingDirectory $consumerRepo
  Add-StageResult -Name 'rerun' -Code $rerun.Code
  if ($rerun.Code -ne 0) { throw 'setup rerun failed' }
  $after = Get-ManagedFileDigest -Consumer $consumerRepo
  foreach ($key in $before.Keys) { if ($before[$key] -ne $after[$key]) { throw "managed file changed on rerun: $key" } }
  Test-ManagedWiring -Consumer $consumerRepo -Checkout $installedCheckout -Slug $slug
  $automated.rerunIdempotent = $true

  Enter-Stage 'draft'
  $draft = [ordered]@{
    schema = 1
    platform = $Pre.Platform
    versions = $Pre.Versions
    release = [ordered]@{
      reviewedSha = $ReviewedSha
      runtimeVersion = [string]$Pre.Manifest.sourceVersion
      installerVersion = [string](Read-JsonFile -Path (Join-Path $installerRoot 'node_modules\mai-mcp\package.json')).version
      runtimeTreeSha256 = $Pre.TreeSha
      installerPackageSha256 = $Pre.InstallerSha
    }
    automated = $automated
    manual = [ordered]@{
      claudeRestarted = $false; claudePrime = $false; claudeCapture = $false; claudeProviderStatus = $false; claudeHooksLive = $false
      codexRestarted = $false; codexPrime = $false; codexCapture = $false; codexProviderStatus = $false; codexNotifyLive = $false
    }
    scheduledPersistence = [ordered]@{
      taskName = $DashboardTaskName; installed = $true; restartedAfterKill = $true
      survivedSignOutSignIn = $false; tokenAbsent = $false; uninstalled = $false
    }
    timestamps = [ordered]@{ automatedCompletedAt = (Get-UtcStamp); manualCompletedAt = '1970-01-01T00:00:00Z' }
    local = [ordered]@{ acceptanceRoot = $script:AcceptanceRoot; installedCheckout = $installedCheckout; consumerRepo = $consumerRepo; slug = $slug }
  }
  foreach ($key in @('installerExistingCheckout', 'setup', 'database', 'migrations', 'verifySmoke', 'mcpSurface', 'wiring', 'dashboard', 'scratchEndCleanup', 'scratchPrune', 'janitorSchedule', 'backupRestore', 'backupSchedule', 'rerunIdempotent')) {
    if ($automated[$key] -ne $true) { throw "automated boolean $key is not true" }
  }
  $draftPath = Join-Path $script:AcceptanceRoot 'draft-receipt.json'
  Write-JsonAtomic -Path $draftPath -Value $draft
  Write-Host 'Automated phase complete. The mai-mcp-dashboard task is retained for O3. Record the draft path below before signing out.'
  Write-Output $draftPath
}

# ---- Finalize phase ----
function Invoke-FinalizePhase {
  param($Pre)
  if (-not $DraftReceipt) { throw '-DraftReceipt is required for Finalize' }
  $draft = Read-JsonFile -Path $DraftReceipt
  if ($draft.release.reviewedSha -ne $ReviewedSha) { throw 'draft reviewedSha is not the reviewed SHA' }
  if ($draft.release.runtimeTreeSha256 -ne $Pre.TreeSha) { throw 'public tree hash changed since the Automated phase' }
  if ($draft.release.installerPackageSha256 -ne $Pre.InstallerSha) { throw 'installer package hash changed since the Automated phase' }
  foreach ($prop in $draft.automated.PSObject.Properties) { if ($prop.Value -ne $true) { throw "draft automated.$($prop.Name) is not true" } }
  $installedCheckout = [string]$draft.local.installedCheckout
  $consumerRepo = [string]$draft.local.consumerRepo
  $slug = [string]$draft.local.slug
  $script:InstalledCheckout = $installedCheckout
  $script:AcceptanceRoot = [string]$draft.local.acceptanceRoot
  $entry = Join-Path $installedCheckout 'build\entry.js'
  $sha8 = $ReviewedSha.Substring(0, 8)

  Enter-Stage 'scheduledPersistence-finalize'
  Assert-DashboardRunning -Checkout $installedCheckout -Because 'after sign-in'
  $xml = Assert-Native -File 'schtasks.exe' -Arguments @('/query', '/tn', $DashboardTaskName, '/xml') -Because 'schtasks xml'
  if ($xml -match 'MAI_BRAIN_WEB_TOKEN') { throw 'the dashboard token appears in the scheduled-task definition' }
  $logs = Invoke-Native -File $script:NodeExe -Arguments @($entry, 'dashboard', 'persist', 'logs') -WorkingDirectory $installedCheckout
  if ($logs.Output -match 'MAI_BRAIN_WEB_TOKEN') { throw 'the dashboard token appears in the dashboard logs' }
  $dashboardInstaller = Join-Path $installedCheckout 'scripts\windows\install-dashboard.ps1'
  [void](Assert-Native -File 'powershell.exe' -Arguments @('-NoLogo', '-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', $dashboardInstaller, '-Action', 'Uninstall', '-CheckoutRoot', $installedCheckout) -Because 'dashboard uninstall')
  if ((Invoke-Native -File 'schtasks.exe' -Arguments @('/query', '/tn', $DashboardTaskName)).Code -eq 0) { throw 'mai-mcp-dashboard survived uninstall' }
  Write-Host "dashboard task uninstalled: no such task $DashboardTaskName"

  Enter-Stage 'manual'
  $verifyReport = Assert-Native -File $script:NodeExe -Arguments @($entry, 'verify', $slug, '--smoke') -WorkingDirectory $installedCheckout -Because 'verify --smoke (installed entry)'
  Write-Host $verifyReport
  $steps = @(
    @{ key = 'claudeRestarted'; text = "Restart Claude Code in the acceptance repository: $consumerRepo" },
    @{ key = 'claudePrime'; text = "In Claude Code call mai_prime('Windows acceptance Claude prime') and observe the slug $slug" },
    @{ key = 'claudeCapture'; text = 'Make one harmless Claude session note and verify it appears in that project timeline' },
    @{ key = 'codexRestarted'; text = 'Restart Codex in the same repository' },
    @{ key = 'codexPrime'; text = "From Codex call the same prime and observe the slug $slug" },
    @{ key = 'codexCapture'; text = 'Make one harmless Codex turn and verify it appears in the timeline' },
    @{ key = 'signOutConfirmed'; text = 'Confirm the O3 sign-out/sign-in cycle was performed before this phase and the dashboard Status printed above showed the task running as the current user at Limited with the exact reviewed build' },
    @{ key = 'claudeProviderStatus'; text = 'From the restarted Claude Code confirm provider status matches --llm none and the verify --smoke report above lists every Claude hook path as present and executable (no dead hook)' },
    @{ key = 'codexProviderStatus'; text = 'From the restarted Codex confirm the same for its provider status and that the notify command in .codex/config.toml resolves and runs (no dead notify)' }
  )
  $manual = [ordered]@{}
  foreach ($step in $steps) {
    Write-Host ''
    Write-Host "MANUAL CHECK: $($step.text)"
    $answer = Read-Host "Type PASS $sha8 to confirm"
    if ($answer -ne "PASS $sha8") { throw "manual check '$($step.key)' was not confirmed with the reviewed token" }
    $manual[$step.key] = $true
  }
  $manual.claudeHooksLive = $manual.claudeProviderStatus
  $manual.codexNotifyLive = $manual.codexProviderStatus
  $survivedConfirmed = [bool]$manual.signOutConfirmed

  Enter-Stage 'receipt'
  $receipt = [ordered]@{
    schema = 1
    platform = $draft.platform
    versions = $draft.versions
    release = $draft.release
    automated = $draft.automated
    manual = [ordered]@{
      claudeRestarted = $manual.claudeRestarted; claudePrime = $manual.claudePrime; claudeCapture = $manual.claudeCapture
      claudeProviderStatus = $manual.claudeProviderStatus; claudeHooksLive = $manual.claudeHooksLive
      codexRestarted = $manual.codexRestarted; codexPrime = $manual.codexPrime; codexCapture = $manual.codexCapture
      codexProviderStatus = $manual.codexProviderStatus; codexNotifyLive = $manual.codexNotifyLive
    }
    scheduledPersistence = [ordered]@{
      taskName = $DashboardTaskName; installed = $true; restartedAfterKill = $true
      survivedSignOutSignIn = $survivedConfirmed; tokenAbsent = $true; uninstalled = $true
    }
    timestamps = [ordered]@{ automatedCompletedAt = [string]$draft.timestamps.automatedCompletedAt; manualCompletedAt = (Get-UtcStamp) }
  }
  $schemaPath = Join-Path $Pre.Root 'scripts\windows\receipt-schema.json'
  $schema = Read-JsonFile -Path $schemaPath
  Test-ReceiptAgainstSchema -Schema $schema -Value $receipt -At 'receipt'
  $name = "windows-11-$((Get-Date).ToUniversalTime().ToString('yyyy-MM-dd'))-$sha8.json"
  $target = if ($OutputReceipt) { $OutputReceipt } else { Join-Path (Join-Path $Pre.Root 'docs\release\windows') $name }
  Write-JsonAtomic -Path $target -Value $receipt
  Write-Host "receipt written: $target"
}

function Test-ReceiptAgainstSchema {
  param($Schema, $Value, [string]$At)
  if ($Schema.type -eq 'object') {
    $names = @()
    if ($Value -is [System.Collections.IDictionary]) { $names = @($Value.Keys) } else { $names = @($Value.PSObject.Properties.Name) }
    $permitted = @($Schema.properties.PSObject.Properties.Name)
    foreach ($n in $names) { if ($permitted -notcontains $n) { throw "$At.$n is not a permitted receipt key" } }
    foreach ($req in $Schema.required) { if ($names -notcontains $req) { throw "$At.$req is required" } }
    foreach ($n in $names) {
      $child = if ($Value -is [System.Collections.IDictionary]) { $Value[$n] } else { $Value.$n }
      Test-ReceiptAgainstSchema -Schema $Schema.properties.$n -Value $child -At "$At.$n"
    }
    return
  }
  if ($Schema.PSObject.Properties.Name -contains 'const') {
    if ("$Value" -ne "$($Schema.const)") { throw "$At must be $($Schema.const)" }
    return
  }
  if ($Schema.type -eq 'boolean') {
    if ($Value -isnot [bool]) { throw "$At must be a boolean" }
    return
  }
  if ($Schema.type -eq 'string') {
    if ($Value -isnot [string]) { throw "$At must be a string" }
    if ($Schema.PSObject.Properties.Name -contains 'pattern' -and $Value -notmatch $Schema.pattern) { throw "$At does not match its pattern" }
    return
  }
  throw "${At}: unsupported receipt schema node (type '$($Schema.type)'); the writer refuses rather than guessing"
}

$succeeded = $false
try {
  $pre = Test-Preflight
  if ($Phase -eq 'Automated') { Invoke-AutomatedPhase -Pre $pre } else { Invoke-FinalizePhase -Pre $pre }
  $succeeded = $true
} catch {
  Write-FailureRecord -Message ("$($_.Exception.Message)")
  throw
} finally {
  Invoke-Cleanup -Succeeded $succeeded
}
