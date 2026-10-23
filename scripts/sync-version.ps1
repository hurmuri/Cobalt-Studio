param(
  [Parameter(Mandatory = $true, Position = 0)]
  [string]$Version,
  [switch]$Check
)

$ErrorActionPreference = 'Stop'
$Root = Split-Path -Parent $PSScriptRoot
$Version = $Version.Trim()

if ($Version -notmatch '^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)$') {
  throw "版本号必须使用 major.minor.patch 格式，例如 1.0.1：$Version"
}

$parts = $Version.Split('.')
$assemblyVersion = '{0}.{1}.{2}.0' -f $parts[0], $parts[1], $parts[2]

function Read-Text([string]$Path) {
  return Get-Content -LiteralPath $Path -Raw
}

function Write-Text([string]$Path, [string]$Text) {
  $encoding = New-Object System.Text.UTF8Encoding($false)
  [System.IO.File]::WriteAllText($Path, $Text, $encoding)
}

function Get-JsonVersion([string]$Path) {
  if ($Path.EndsWith('package-lock.json', [System.StringComparison]::OrdinalIgnoreCase)) {
    $text = Read-Text $Path
    $match = [regex]::Match($text, '^\s*\{\s*"name"\s*:\s*"[^"]+"\s*,\s*"version"\s*:\s*"([^"]+)"')
    if (-not $match.Success) {
      throw "package-lock.json 无法读取版本：$Path"
    }
    return $match.Groups[1].Value
  }
  return (ConvertFrom-Json (Read-Text $Path)).version
}

function Set-PackageVersion([string]$Path) {
  $json = ConvertFrom-Json (Read-Text $Path)
  $json.version = $Version
  return (($json | ConvertTo-Json -Depth 100) + "`n")
}

function Set-LockVersion([string]$Path) {
  $text = Read-Text $Path
  $rootVersionPattern = '("packages"\s*:\s*\{\s*"":\s*\{[^{}]*?"version"\s*:\s*")[^"]+(")'
  if ($text -notmatch $rootVersionPattern) {
    throw "package-lock.json 无法定位根包版本：$Path"
  }
  $text = [regex]::Replace($text, $rootVersionPattern, {
    param($match)
    return $match.Groups[1].Value + $Version + $match.Groups[2].Value
  }, 1)
  $topVersionPattern = '^(\s*\{\s*"name"\s*:\s*"[^"]+"\s*,\s*"version"\s*:\s*")[^"]+(")'
  if ($text -notmatch $topVersionPattern) {
    throw "package-lock.json 无法定位顶层版本：$Path"
  }
  return [regex]::Replace($text, $topVersionPattern, {
    param($match)
    return $match.Groups[1].Value + $Version + $match.Groups[2].Value
  }, 1)
}

function Set-ProjectVersion([string]$Path) {
  $text = Read-Text $Path
  $values = [ordered]@{
    Version = $Version
    AssemblyVersion = $assemblyVersion
    FileVersion = $assemblyVersion
    InformationalVersion = $Version
  }
  foreach ($entry in $values.GetEnumerator()) {
    $tag = [string]$entry.Key
    $value = [string]$entry.Value
    $pattern = "(?m)^([ \t]*<$tag>)[^<]*(</$tag>[ \t]*\r?$)"
    $matches = [regex]::Matches($text, $pattern)
    if ($matches.Count -gt 1) {
      throw "csproj 包含重复的 $tag 节点：$Path"
    }
    if ($matches.Count -eq 1) {
      $text = [regex]::Replace(
        $text,
        $pattern,
        [System.Text.RegularExpressions.MatchEvaluator] {
          param($match)
          return $match.Groups[1].Value + $value + $match.Groups[2].Value
        },
        1
      )
      continue
    }
    $anchor = '(?m)^([ \t]*<RootNamespace>[^<]*</RootNamespace>[ \t]*\r?$)'
    if ($text -notmatch $anchor) {
      throw "csproj 缺少 RootNamespace，无法写入版本：$Path"
    }
    $text = [regex]::Replace(
      $text,
      $anchor,
      [System.Text.RegularExpressions.MatchEvaluator] {
        param($match)
        return $match.Groups[1].Value + "`r`n    <$tag>$value</$tag>"
      },
      1
    )
  }
  return $text
}

function Set-ManifestVersion([string]$Path) {
  $text = Read-Text $Path
  $brokenPattern = '(?m)^\s*\$[0-9.]+"\s+name="CobaltStudio\.Desktop"\s*/>'
  if ($text -match $brokenPattern) {
    $text = $text -replace $brokenPattern, ('  <assemblyIdentity version="' + $assemblyVersion + '" name="CobaltStudio.Desktop"/>')
  }
  $pattern = '(<assemblyIdentity\s+version=")[^"]+(")'
  if ($text -notmatch $pattern) {
    throw "app.manifest 缺少 assemblyIdentity 版本：$Path"
  }
  $identityPattern = '(?m)^(\s*<assemblyIdentity\s+version=")[^"]+(")'
  $newText = [regex]::Replace(
    $text,
    $identityPattern,
    [System.Text.RegularExpressions.MatchEvaluator] {
      param($match)
      return $match.Groups[1].Value + $assemblyVersion + $match.Groups[2].Value
    },
    1
  )
  return $newText
}

$versionFile = Join-Path $Root 'VERSION'
$packageFile = Join-Path $Root 'package.json'
$lockFile = Join-Path $Root 'package-lock.json'
$projectFile = Join-Path $Root 'windows\CobaltStudio.Desktop.csproj'
$manifestFile = Join-Path $Root 'windows\app.manifest'

$currentVersion = if (Test-Path -LiteralPath $versionFile) { (Read-Text $versionFile).Trim() } else { '' }
$expected = [ordered]@{
  $versionFile = $Version
  $packageFile = $Version
  $lockFile = $Version
  $projectFile = $Version
  $manifestFile = $assemblyVersion
}

if ($Check) {
  $actual = [ordered]@{
    $versionFile = $currentVersion
    $packageFile = Get-JsonVersion $packageFile
    $lockFile = Get-JsonVersion $lockFile
    $projectFile = if ((Read-Text $projectFile) -match '<Version>([^<]+)</Version>') { $Matches[1] } else { '' }
    $manifestFile = if ((Read-Text $manifestFile) -match '<assemblyIdentity\s+version="([^"]+)"') { $Matches[1] } else { '' }
  }
  $differences = @()
  foreach ($key in $expected.Keys) {
    if ($actual[$key] -ne $expected[$key]) {
      $differences += "$key expected=$($expected[$key]) actual=$($actual[$key])"
    }
  }
  if ($differences.Count -gt 0) {
    throw ("版本文件不同步：`n" + ($differences -join "`n"))
  }
  Write-Host "Version $Version is synchronized."
  exit 0
}

$packageText = Set-PackageVersion $packageFile
$lockText = Set-LockVersion $lockFile
$projectText = Set-ProjectVersion $projectFile
$manifestText = Set-ManifestVersion $manifestFile

Write-Text $versionFile $Version
Write-Text $packageFile $packageText
Write-Text $lockFile $lockText
Write-Text $projectFile $projectText
Write-Text $manifestFile $manifestText

Write-Host "Version synchronized: $Version (assembly $assemblyVersion)"
