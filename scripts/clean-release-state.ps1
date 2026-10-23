$ErrorActionPreference = 'Stop'
$root = [System.IO.Path]::GetFullPath((Join-Path (Split-Path -Parent $PSScriptRoot) 'release\Cobalt Studio'))
foreach ($name in @('.data', 'downloads')) {
  $target = [System.IO.Path]::GetFullPath((Join-Path $root $name))
  $prefix = $root.TrimEnd('\') + '\'
  if (-not $target.StartsWith($prefix, [System.StringComparison]::OrdinalIgnoreCase)) {
    throw "Refusing to clean outside release root: $target"
  }
  if (Test-Path -LiteralPath $target) {
    Remove-Item -LiteralPath $target -Recurse -Force
  }
}

# The release orchestrator owns runtime-state until Restore-ReleaseState succeeds.
# Cleaning smoke-test state must never delete the user's recovery backup.
