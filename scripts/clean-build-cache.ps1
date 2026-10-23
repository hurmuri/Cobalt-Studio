[CmdletBinding(SupportsShouldProcess)]
param([switch]$Apply)
$ErrorActionPreference = 'Stop'
$root = [IO.Path]::GetFullPath((Split-Path -Parent $PSScriptRoot))
$build = Join-Path $root '.build'
# Only obsolete experiments, never active staging, recovery snapshots or user data.
$obsolete = @('cobalt-deploy-test','deploy-hoisted2','deploy-noscripts','desktop-publish','desktop-sta',
  'flat-deploy-test','flat-test','flat-test-src','hoisted-deploy','portable-test','publish-single','shell-smoke','symbolic-test')
$report = @()
foreach ($name in $obsolete) {
  $target = [IO.Path]::GetFullPath((Join-Path $build $name))
  if (-not $target.StartsWith($build + '\', [StringComparison]::OrdinalIgnoreCase)) { throw "Unsafe path: $target" }
  if (-not (Test-Path -LiteralPath $target)) { continue }
  $items = @(Get-ChildItem -LiteralPath $target -Recurse -Force -FollowSymlink:$false -ErrorAction Stop)
  if (@($items | Where-Object { $_.Name -in @('tasks.json','.data','downloads') -or $_.Extension -in @('.mp4','.mkv','.mp3','.mov') }).Count) {
    throw "Possible user state in $target; preserve for manual review."
  }
  $bytes = ($items | Where-Object { -not $_.PSIsContainer } | Measure-Object Length -Sum).Sum
  $report += [ordered]@{ path = $target; bytes = [long]$bytes; removed = [bool]$Apply }
  if ($Apply -and $PSCmdlet.ShouldProcess($target, 'Remove obsolete build experiment')) {
    if ((Get-Item -LiteralPath $target -Force).LinkType) {
      Remove-Item -LiteralPath $target -Force
    } else {
      foreach ($link in @($items | Where-Object LinkType | Sort-Object { $_.FullName.Length } -Descending)) {
        Remove-Item -LiteralPath $link.FullName -Force
      }
      Remove-Item -LiteralPath $target -Recurse -Force
    }
  }
}
if ($Apply) {
  $verification = Join-Path $build 'verification'
  New-Item -ItemType Directory -Force -Path $verification | Out-Null
  $report | ConvertTo-Json -Depth 4 | Set-Content -LiteralPath (Join-Path $verification 'cleanup.json') -Encoding utf8
}
$report | ConvertTo-Json -Depth 4
