param(
  [Parameter(Mandatory)]
  [ValidateSet('Install','Status','Restart','Stop','Logs','Uninstall')]
  [string]$Action,

  [string]$CheckoutRoot
)

$ErrorActionPreference = 'Stop'
$ScriptCheckoutRoot = [System.IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..\..'))

if ($Action -eq 'Install' -and [string]::IsNullOrWhiteSpace($CheckoutRoot)) {
  throw '-CheckoutRoot is required for Install'
}

if (-not [string]::IsNullOrWhiteSpace($CheckoutRoot)) {
  if (-not [System.IO.Path]::IsPathFullyQualified($CheckoutRoot) -or
      -not (Test-Path -LiteralPath $CheckoutRoot -PathType Container)) {
    throw '-CheckoutRoot must be an absolute existing directory'
  }
  $CheckoutRoot = [System.IO.Path]::GetFullPath($CheckoutRoot)
}

$Node = (Get-Command node.exe -ErrorAction Stop).Source
$InvocationRoot = if ([string]::IsNullOrWhiteSpace($CheckoutRoot)) { $ScriptCheckoutRoot } else { $CheckoutRoot }
$Entry = Join-Path $InvocationRoot 'build\entry.js'
$Arguments = @($Entry, 'dashboard', 'persist', $Action.ToLowerInvariant())
if (-not [string]::IsNullOrWhiteSpace($CheckoutRoot)) {
  $Arguments += @('--checkout-root', $CheckoutRoot)
}

& $Node @Arguments
exit $LASTEXITCODE
