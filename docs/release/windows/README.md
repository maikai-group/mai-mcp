# Native Windows certification — how to run and review it

Native Windows 11 ships as **preview** in v1.0; its certification is follow-up
work and does not block the macOS/Linux release. A first-class native Windows
claim still requires a dated receipt in this
directory proves it: `windows-11-<UTC date>-<sha8>.json`, written by
`scripts/windows/acceptance.ps1` on a clean, non-admin Windows 11 machine at
the frozen reviewed commit. Windows CI (`.github/workflows/platform.yml`) is
necessary, never sufficient. **Native Windows certification is blocked without a committed final
receipt**, and the operator must read `scripts/windows/acceptance.ps1` before
running it — it installs and removes scheduled tasks, creates a throwaway
consumer repository under `%TEMP%`, and drops a disposable restore database.

Use a Windows 11 host that supports Docker Desktop with local Linux containers.
Cloud access alone does not establish that prerequisite. The example drive paths
below must exist on the chosen host before the run; retain the exact reviewed
commit and verified artifact identities.

The run has two phases separated by a sign-out. Each PowerShell block below
is self-contained: it re-derives every value it uses, because the sign-out
between them destroys the first session's variables.

## Automated phase

One session. The frozen artifacts were copied to `D:\mai-windows-artifacts`
(operator item O1): the public tree at `public-tree\` and exactly one
installer `.tgz` beside it.

```powershell
Set-Location C:\src\mai-mcp
$checkoutRoot = (Get-Location).Path
$sha = (git rev-parse HEAD).Trim()
$env:MAI_WINDOWS_PUBLIC_TREE = 'D:\mai-windows-artifacts\public-tree'
$installerPackages = @(Get-ChildItem 'D:\mai-windows-artifacts\*.tgz')
if ($installerPackages.Count -ne 1) { throw "Expected exactly one installer package, found $($installerPackages.Count)" }
$env:MAI_WINDOWS_INSTALLER_TGZ = $installerPackages[0].FullName
npm ci
npm run build
npm run acceptance:windows -- -Phase Automated -CheckoutRoot $checkoutRoot -ReviewedSha $sha -PublicTree $env:MAI_WINDOWS_PUBLIC_TREE -InstallerPackage $env:MAI_WINDOWS_INSTALLER_TGZ
```

Every automated boolean must report `true`. The last line of output is the
absolute path of the local draft receipt (a GUID-named directory under
`%TEMP%`): **write it down outside this session** — the sign-out that follows
closes this console and the path cannot be re-derived. The
`mai-mcp-dashboard` scheduled task is deliberately left installed and running;
the review-cleanup and backup test schedules are gone; the disposable restore
database is absent. Do not edit the draft receipt.

## Sign-out / sign-in (operator item O3)

Sign out of Windows and back in as the same non-admin user. Then confirm the
retained dashboard task survived the cycle:
`powershell.exe -NoLogo -NoProfile -ExecutionPolicy Bypass -File scripts\windows\install-dashboard.ps1 -Action Status -CheckoutRoot C:\src\mai-mcp`
must report the task running as the current user at `Limited` run level with
the exact reviewed build and `Health: OK`, and the dashboard URL it prints must
load. If it is not running, record the failure and stop.

That sign-out ends the session above, so the Finalize block re-derives every value:

## Finalize phase (operator item O4)

```powershell
Set-Location C:\src\mai-mcp
$checkoutRoot = (Get-Location).Path
$sha = (git rev-parse HEAD).Trim()
$env:MAI_WINDOWS_PUBLIC_TREE = 'D:\mai-windows-artifacts\public-tree'
$installerPackages = @(Get-ChildItem 'D:\mai-windows-artifacts\*.tgz')
if ($installerPackages.Count -ne 1) { throw "Expected exactly one installer package, found $($installerPackages.Count)" }
$env:MAI_WINDOWS_INSTALLER_TGZ = $installerPackages[0].FullName
$draftReceipt = Read-Host 'Paste the draft receipt path printed by the Automated phase'
# O4: restart/test Claude and Codex when Finalize prompts.
npm run acceptance:windows -- -Phase Finalize -CheckoutRoot $checkoutRoot -ReviewedSha $sha -PublicTree $env:MAI_WINDOWS_PUBLIC_TREE -InstallerPackage $env:MAI_WINDOWS_INSTALLER_TGZ -DraftReceipt $draftReceipt
```

Finalize re-validates the reviewed SHA, the public-tree and installer hashes
and every automated value, checks the retained dashboard task once more and
uninstalls it, then walks the nine manual checks in order — restart Claude
Code and Codex in the acceptance repository, prime, capture, provider status,
live hooks and notify. After each check type `PASS <first 8 characters of the
reviewed SHA>` exactly as prompted; anything else stops the run. Only then is
the redacted receipt written under `docs/release/windows/`. Copy that one
file into the implementation checkout; nothing else from the Shadow PC is
committed.

## Reviewing a receipt

A receipt carries booleans, versions and hashes only. Reject any receipt that
has a `false` boolean, a `reviewedSha` that is not the frozen commit, a key
outside `scripts/windows/receipt-schema.json`, or any absolute path, user
name or token — the release leak gate enforces the same rules on the
assembled public tree.
