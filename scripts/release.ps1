[CmdletBinding()]
param(
  [string]$Version,
  [ValidateSet('major', 'minor', 'patch')]
  [string]$Bump,
  [string]$Notes,
  [switch]$SkipTests,
  [switch]$SkipReleaseSmoke,
  [switch]$AllowOverwrite,
  [switch]$DryRun
)

$ErrorActionPreference = 'Stop'
$Root = Split-Path -Parent $PSScriptRoot
$ReleaseDir = Join-Path $Root 'release\Cobalt Studio'
$ArtifactsDir = Join-Path $Root 'release\artifacts'
$VersionFile = Join-Path $Root 'VERSION'
$SyncScript = Join-Path $PSScriptRoot 'sync-version.ps1'
$BuildScript = Join-Path $PSScriptRoot 'build-portable.ps1'
$CleanScript = Join-Path $PSScriptRoot 'clean-release-state.ps1'
$ExePath = Join-Path $ReleaseDir 'Cobalt Studio.exe'
$StateBackupDir = Join-Path $Root '.build\runtime-state'
$script:StateBackupExpected = $false
$script:ExpectedTaskIds = @()

function Read-VersionFile {
  if (-not (Test-Path -LiteralPath $VersionFile)) {
    throw "缺少版本文件：$VersionFile"
  }
  return (Get-Content -LiteralPath $VersionFile -Raw).Trim()
}

function Assert-Version([string]$Value) {
  if ($Value -notmatch '^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)$') {
    throw "版本号必须使用 major.minor.patch 格式，例如 1.0.1：$Value"
  }
}

function Get-NextVersion([string]$Current, [string]$Kind) {
  Assert-Version $Current
  $parts = @($Current.Split('.') | ForEach-Object { [int]$_ })
  switch ($Kind) {
    'major' {
      $parts[0] += 1
      $parts[1] = 0
      $parts[2] = 0
    }
    'minor' {
      $parts[1] += 1
      $parts[2] = 0
    }
    'patch' {
      $parts[2] += 1
    }
  }
  return '{0}.{1}.{2}' -f $parts[0], $parts[1], $parts[2]
}

function Get-Sha256([string]$Path) {
  return (Get-FileHash -LiteralPath $Path -Algorithm SHA256).Hash.ToLowerInvariant()
}

function Assert-FileHash([string]$Path, [string]$Expected) {
  $actual = Get-Sha256 $Path
  if ($actual -ne $Expected.ToLowerInvariant()) {
    throw "文件校验失败：$Path`nexpected=$Expected`nactual=$actual"
  }
}

function Test-ReleaseManifest([string]$Path, [string]$ExpectedVersion, [string]$ArchiveHash, [string]$ExeHash) {
  if (-not (Test-Path -LiteralPath $Path)) { return $false }
  if (-not (Test-Path -LiteralPath $checksumsPath)) { return $false }
  if (-not (Test-Path -LiteralPath $standalonePath)) { return $false }
  try {
    $manifest = Get-Content -LiteralPath $Path -Raw | ConvertFrom-Json
    $checksums = Get-Content -LiteralPath $checksumsPath -Raw
    return (
      $manifest.version -eq $ExpectedVersion -and
      $manifest.platform -eq 'win-x64' -and
      $manifest.tests.fullSuite -eq 'passed' -and
      $manifest.tests.releaseSmoke -eq 'passed' -and
      $manifest.tests.standaloneSmoke -eq 'passed' -and
      $manifest.package.standaloneSha256 -eq (Get-Sha256 $standalonePath) -and
      $checksums.Contains((Get-Sha256 $standalonePath)) -and
      $manifest.package.archiveSha256 -eq $ArchiveHash -and
      $manifest.package.executableSha256 -eq $ExeHash -and
      $checksums.Contains($ArchiveHash) -and
      $checksums.Contains($ExeHash) -and
      $checksums.Contains((Get-Sha256 $Path))
    )
  } catch {
    return $false
  }
}

function Get-Bytes([string]$Path) {
  return (Get-Item -LiteralPath $Path).Length
}

function Write-Utf8NoBom([string]$Path, [string]$Text) {
  $encoding = New-Object System.Text.UTF8Encoding($false)
  [System.IO.File]::WriteAllText($Path, $Text, $encoding)
}

function Write-ReleaseDelivery([string]$ReleasedVersion, [string]$Archive, [string]$Manifest) {
  $latest = [ordered]@{
    version = $ReleasedVersion
    archive = [System.IO.Path]::GetFullPath($Archive)
    manifest = [System.IO.Path]::GetFullPath($Manifest)
    executable = [System.IO.Path]::GetFullPath($standalonePath)
    checksums = [System.IO.Path]::GetFullPath($checksumsPath)
  }
  Write-Utf8NoBom (Join-Path $ArtifactsDir 'latest.json') ($latest | ConvertTo-Json)
  $archiveLink = $latest.archive.Replace('\', '/')
  $manifestLink = $latest.manifest.Replace('\', '/')
  $standaloneLink = $latest.executable.Replace('\', '/')
  $delivery = @(
    "# Cobalt Studio $ReleasedVersion",
    '',
    "新包地址：``$($latest.archive)``",
    '',
    "[下载 Cobalt Studio $ReleasedVersion](<$archiveLink>)",
    '',
    "单文件 EXE：``$($latest.executable)``",
    '',
    "[下载单文件 EXE](<$standaloneLink>)",
    '',
    "[发布清单](<$manifestLink>)",
    '',
    "校验文件：``$($latest.checksums)``"
  ) -join "`n"
  Write-Utf8NoBom (Join-Path $ArtifactsDir 'LATEST.md') ($delivery + "`n")
  Write-Host "Archive:  $($latest.archive)"
  Write-Host "[下载 Cobalt Studio $ReleasedVersion](<$archiveLink>)"
  Write-Host "Standalone: $($latest.executable)"
  Write-Host "[下载单文件 EXE](<$standaloneLink>)"
}

function Assert-SafeChildPath([string]$Base, [string]$Target) {
  $basePath = [System.IO.Path]::GetFullPath($Base).TrimEnd('\')
  $targetPath = [System.IO.Path]::GetFullPath($Target)
  $childPrefix = $basePath + '\'
  if (-not $targetPath.Equals($basePath, [System.StringComparison]::OrdinalIgnoreCase) -and
      -not $targetPath.StartsWith($childPrefix, [System.StringComparison]::OrdinalIgnoreCase)) {
    throw "拒绝操作发布目录外的路径：$targetPath"
  }
  return $targetPath
}

function Backup-ReleaseState {
  $resolved = Assert-SafeChildPath $Root $StateBackupDir
  if (Test-Path -LiteralPath $resolved) {
    $statePresent = (Test-Path -LiteralPath (Join-Path $ReleaseDir '.data')) -or
                    (Test-Path -LiteralPath (Join-Path $ReleaseDir 'downloads'))
    if ($statePresent) {
      throw "检测到未完成的发布备份，同时发布目录已有运行状态。请先检查：$resolved"
    }
    Write-Host "Recovering runtime state left by an interrupted release: $resolved"
    Restore-ReleaseState
  }
  $hadState = (Test-Path -LiteralPath (Join-Path $ReleaseDir '.data')) -or
              (Test-Path -LiteralPath (Join-Path $ReleaseDir 'downloads'))
  if (-not $hadState) {
    Write-Host 'No existing release state to back up.'
    return
  }
  New-Item -ItemType Directory -Force -Path $resolved | Out-Null
  $manifest = [ordered]@{ data = $false; downloads = $false }
  foreach ($name in @('.data', 'downloads')) {
    $source = Assert-SafeChildPath $ReleaseDir (Join-Path $ReleaseDir $name)
    if (-not (Test-Path -LiteralPath $source)) { continue }
    $destination = Assert-SafeChildPath $resolved (Join-Path $resolved $name)
    if ($name -eq '.data') {
      New-Item -ItemType Directory -Force -Path $destination | Out-Null
      Get-ChildItem -LiteralPath $source -Force | ForEach-Object {
        Copy-Item -LiteralPath $_.FullName -Destination $destination -Recurse -Force
      }
    } else {
      New-Item -ItemType Directory -Force -Path (Split-Path -Parent $destination) | Out-Null
      Copy-Item -LiteralPath $source -Destination $destination -Recurse -Force
    }
    $key = if ($name -eq '.data') { 'data' } else { 'downloads' }
    $manifest[$key] = $true
  }
  $manifest.files = @(
    Get-ChildItem -LiteralPath $resolved -Recurse -File | Where-Object {
      $_.FullName -notmatch '\\.data\\webview2\\' -and $_.FullName -notmatch '\\.data\\logs\\'
    } | ForEach-Object {
      [ordered]@{ path = [System.IO.Path]::GetRelativePath($resolved, $_.FullName); sha256 = Get-Sha256 $_.FullName }
    }
  )
  Write-Utf8NoBom (Join-Path $resolved 'state.json') ($manifest | ConvertTo-Json -Depth 6)
  $tasksFile = Join-Path $resolved '.data\tasks.json'
  if (Test-Path -LiteralPath $tasksFile) {
    $script:ExpectedTaskIds = @((Get-Content -LiteralPath $tasksFile -Raw | ConvertFrom-Json).tasks | ForEach-Object id)
  }
  $script:StateBackupExpected = $true
  Write-Host "Release state backed up: $resolved"
}

function Restore-ReleaseState {
  $resolved = Assert-SafeChildPath $Root $StateBackupDir
  $manifestPath = Join-Path $resolved 'state.json'
  if (-not (Test-Path -LiteralPath $manifestPath)) {
    if ($script:StateBackupExpected) { throw "用户状态备份丢失，停止发布：$manifestPath" }
    return
  }
  $statePresent = (Test-Path -LiteralPath (Join-Path $ReleaseDir '.data')) -or
                  (Test-Path -LiteralPath (Join-Path $ReleaseDir 'downloads'))
  if ($statePresent) {
    throw '发布目录已有运行状态，拒绝覆盖恢复。'
  }
  $manifest = Get-Content -LiteralPath $manifestPath -Raw | ConvertFrom-Json
  foreach ($name in @('.data', 'downloads')) {
    $present = ($name -eq '.data' -and [bool]$manifest.data) -or
               ($name -eq 'downloads' -and [bool]$manifest.downloads)
    if (-not $present) { continue }
    $source = Assert-SafeChildPath $resolved (Join-Path $resolved $name)
    $destination = Assert-SafeChildPath $ReleaseDir (Join-Path $ReleaseDir $name)
    if (Test-Path -LiteralPath $destination) {
      Remove-Item -LiteralPath $destination -Recurse -Force
    }
    if ($name -eq '.data') {
      New-Item -ItemType Directory -Force -Path $destination | Out-Null
      Get-ChildItem -LiteralPath $source -Force | ForEach-Object {
        Copy-Item -LiteralPath $_.FullName -Destination $destination -Recurse -Force
      }
    } else {
      New-Item -ItemType Directory -Force -Path (Split-Path -Parent $destination) | Out-Null
      Copy-Item -LiteralPath $source -Destination $destination -Recurse -Force
    }
  }
  foreach ($entry in $manifest.files) {
    $restoredFile = Assert-SafeChildPath $ReleaseDir (Join-Path $ReleaseDir $entry.path)
    Assert-FileHash $restoredFile $entry.sha256
  }
  Write-Host "Release state restored and hashes verified: $ReleaseDir"
  Remove-Item -LiteralPath $resolved -Recurse -Force
  $script:StateBackupExpected = $false
}

function Assert-ArchiveExcludesRuntimeState([string]$Path) {
  Add-Type -AssemblyName System.IO.Compression.FileSystem
  $archive = [System.IO.Compression.ZipFile]::OpenRead($Path)
  try {
    $runtimeEntries = @($archive.Entries | Where-Object {
      $_.FullName -match '^(\.data|downloads)([\\/]|$)'
    })
  } finally {
    $archive.Dispose()
  }
  if ($runtimeEntries.Count -gt 0) {
    throw "发布压缩包包含本地运行状态：$($runtimeEntries[0].FullName)"
  }
}

function Stop-ReleaseApp {
  if (-not (Test-Path -LiteralPath $ExePath)) {
    Write-Host 'No existing release app to close.'
    return
  }
  $target = [System.IO.Path]::GetFullPath($ExePath)
  $processes = @(Get-CimInstance Win32_Process -ErrorAction SilentlyContinue |
    Where-Object {
      $_.ExecutablePath -and
      [string]::Equals([System.IO.Path]::GetFullPath($_.ExecutablePath), $target, [System.StringComparison]::OrdinalIgnoreCase)
    })
  if ($processes.Count -eq 0) {
    Write-Host 'No existing release app to close.'
    return
  }
  Write-Host "Closing release app: $ExePath"
  foreach ($process in $processes) {
    try {
      $client = Get-Process -Id $process.ProcessId -ErrorAction Stop
      [void]$client.CloseMainWindow()
    } catch {}
  }
  Start-Sleep -Milliseconds 800
  $remaining = @($processes | ForEach-Object {
    Get-Process -Id $_.ProcessId -ErrorAction SilentlyContinue
  } | Where-Object { $_ })
  foreach ($process in $remaining) {
    Stop-Process -Id $process.Id -Force -ErrorAction Stop
  }
  foreach ($process in $remaining) {
    Wait-Process -Id $process.Id -Timeout 8 -ErrorAction SilentlyContinue
  }
}

function Stop-ReleaseNodeChildren {
  if (-not (Test-Path -LiteralPath $ReleaseDir)) { return }
  $root = [System.IO.Path]::GetFullPath($ReleaseDir).TrimEnd('\') + '\'
  $children = @(Get-CimInstance Win32_Process -ErrorAction SilentlyContinue | Where-Object {
    $_.ExecutablePath -and
    [System.IO.Path]::GetFullPath($_.ExecutablePath).StartsWith($root, [System.StringComparison]::OrdinalIgnoreCase) -and
    $_.Name -in @('node.exe', 'ffmpeg.exe')
  })
  foreach ($process in $children) {
    try { Stop-Process -Id $process.ProcessId -Force -ErrorAction Stop } catch {}
  }
  foreach ($process in $children) {
    Wait-Process -Id $process.ProcessId -Timeout 5 -ErrorAction SilentlyContinue
  }
}

if ($Version -and $Bump) {
  throw '不能同时指定 -Version 和 -Bump。'
}
if (-not $Version -and -not $Bump) {
  throw '必须指定 -Version（例如 1.0.1）或 -Bump（major/minor/patch）。'
}

$currentVersion = Read-VersionFile
Assert-Version $currentVersion
$releaseVersion = if ($Version) { $Version.Trim() } else { Get-NextVersion $currentVersion $Bump }
Assert-Version $releaseVersion

$archiveName = "Cobalt-Studio-v$releaseVersion-win-x64.zip"
$versionDir = Join-Path $ArtifactsDir $releaseVersion
$archivePath = Join-Path $versionDir $archiveName
$standaloneName = "Cobalt-Studio-v$releaseVersion-win-x64.exe"
$standalonePath = Join-Path $versionDir $standaloneName
$manifestPath = Join-Path $versionDir "Cobalt-Studio-v$releaseVersion.json"
$checksumsPath = Join-Path $versionDir 'SHA256SUMS.txt'
$isSameVersionRepack = Test-Path -LiteralPath $archivePath
$existingArchiveHash = if ($isSameVersionRepack) { Get-Sha256 $archivePath } else { '' }
$existingExeHash = if (Test-Path -LiteralPath $ExePath) { Get-Sha256 $ExePath } else { '' }
$testState = [ordered]@{
  fullSuite = if ($SkipTests) { 'skipped' } else { 'passed' }
  releaseSmoke = if ($SkipReleaseSmoke) { 'skipped' } else { 'passed' }
  standaloneSmoke = if ($SkipReleaseSmoke) { 'skipped' } else { 'passed' }
}

if ($DryRun) {
  Write-Host "Version: $currentVersion -> $releaseVersion"
  Write-Host "Portable folder: $ReleaseDir"
  Write-Host "Artifacts: $ArtifactsDir"
  Write-Host "Archive: $archivePath"
  Write-Host "Standalone: $standalonePath"
  Write-Host 'Dry run complete; no files were changed.'
  exit 0
}

if (-not $isSameVersionRepack -and $currentVersion -eq $releaseVersion -and -not $AllowOverwrite) {
  throw "VERSION 已经是 $releaseVersion。请使用 -Bump patch/minor/major，或显式指定 -AllowOverwrite 重新打包同版本。"
}
if (-not $AllowOverwrite -and $isSameVersionRepack) {
  if (Test-ReleaseManifest $manifestPath $releaseVersion $existingArchiveHash $existingExeHash) {
    Write-Host "Release $releaseVersion is already packed and verified."
    Write-Host "Manifest: $manifestPath"
    Write-Host "SHA256:  $checksumsPath"
    Write-ReleaseDelivery $releaseVersion $archivePath $manifestPath
    exit 0
  }
  throw "发布产物已存在：$archivePath。请提升版本号，或显式使用 -AllowOverwrite。"
}

Write-Host "Syncing version $releaseVersion..."
$global:LASTEXITCODE = 0
& $SyncScript -Version $releaseVersion
if (-not $? -or $LASTEXITCODE -ne 0) {
  throw "同步版本失败，停止发布。exit=$LASTEXITCODE"
}
$global:LASTEXITCODE = 0
& $SyncScript -Version $releaseVersion -Check
if (-not $? -or $LASTEXITCODE -ne 0) {
  throw "版本校验失败，停止发布。exit=$LASTEXITCODE"
}

if (-not $SkipTests) {
  Write-Host 'Running full test suite...'
  $global:LASTEXITCODE = 0
  & npm test
  if (-not $? -or $LASTEXITCODE -ne 0) {
    throw "测试失败，停止发布。exit=$LASTEXITCODE"
  }
} else {
  Write-Host 'Skipping npm test (-SkipTests).'
}

Stop-ReleaseApp
Stop-ReleaseNodeChildren
Backup-ReleaseState

$packagingComplete = $false
try {
  Write-Host 'Building portable release...'
  $global:LASTEXITCODE = 0
  & $BuildScript -Version $releaseVersion
  if (-not $? -or $LASTEXITCODE -ne 0) {
    throw "便携包构建失败，停止发布。exit=$LASTEXITCODE"
  }
  if (-not (Test-Path -LiteralPath $ExePath)) {
    throw "构建完成但没有找到客户端：$ExePath"
  }

  if (-not $SkipReleaseSmoke) {
    Write-Host 'Running release UI smoke test...'
    $previousReleaseTest = $env:COBALT_UI_TEST_RELEASE
    $smokeReady = $false
    try {
      $env:COBALT_UI_TEST_RELEASE = '1'
      foreach ($attempt in 1..2) {
        $global:LASTEXITCODE = 0
        & node test/ui-smoke.mjs
        if ($? -and $LASTEXITCODE -eq 0) {
          $smokeReady = $true
          break
        }
        Stop-ReleaseApp
        Stop-ReleaseNodeChildren
        if ($attempt -lt 2) {
          Write-Host "Release smoke attempt $attempt failed; retrying once after a clean restart."
          Start-Sleep -Milliseconds 800
        }
      }
      if (-not $smokeReady) {
        throw "release smoke test 失败，停止发布。exit=$LASTEXITCODE"
      }
    } finally {
      if ($null -eq $previousReleaseTest) {
        Remove-Item Env:COBALT_UI_TEST_RELEASE -ErrorAction SilentlyContinue
      } else {
        $env:COBALT_UI_TEST_RELEASE = $previousReleaseTest
      }
    }
  } else {
    Write-Host 'Skipping release UI smoke test (-SkipReleaseSmoke).'
  }

  Stop-ReleaseApp
  Stop-ReleaseNodeChildren
  & $CleanScript

  New-Item -ItemType Directory -Force -Path $versionDir | Out-Null
  if (Test-Path -LiteralPath $archivePath) {
    Remove-Item -LiteralPath $archivePath -Force
  }
  if (Test-Path -LiteralPath $manifestPath) {
    Remove-Item -LiteralPath $manifestPath -Force
  }

  Write-Host "Packing $archiveName..."
  Compress-Archive -Path (Join-Path $ReleaseDir '*') -DestinationPath $archivePath -CompressionLevel Optimal -Force
  Assert-ArchiveExcludesRuntimeState $archivePath

  & (Join-Path $PSScriptRoot 'build-standalone.ps1') -Archive $archivePath -Output $standalonePath -Version $releaseVersion
  if (-not $? -or $LASTEXITCODE -ne 0) { throw '单文件 EXE 构建失败。' }
  if (-not $SkipReleaseSmoke) {
    $previousReleaseTest = $env:COBALT_UI_TEST_RELEASE
    $previousExecutable = $env:COBALT_UI_TEST_EXECUTABLE
    try {
      $env:COBALT_UI_TEST_RELEASE = '1'
      $env:COBALT_UI_TEST_EXECUTABLE = $standalonePath
      & node test/ui-smoke.mjs
      if (-not $? -or $LASTEXITCODE -ne 0) { throw '单文件 EXE 空目录启动和下载验收失败。' }
    } finally {
      $env:COBALT_UI_TEST_RELEASE = $previousReleaseTest
      $env:COBALT_UI_TEST_EXECUTABLE = $previousExecutable
    }
  }

  $measure = Get-ChildItem -LiteralPath $ReleaseDir -Recurse -File | Measure-Object Length -Sum
  $exeHash = Get-Sha256 $ExePath
  $archiveHash = Get-Sha256 $archivePath
  $cobaltVersion = (ConvertFrom-Json (Get-Content -LiteralPath (Join-Path $Root 'cobalt-api\api\package.json') -Raw)).version
  $cobaltCommit = (& git -C (Join-Path $Root 'cobalt-api') rev-parse HEAD).Trim()
  if ($LASTEXITCODE -ne 0 -or $cobaltCommit -notmatch '^[0-9a-f]{40}$') {
    throw '无法读取 cobalt 源码提交号。'
  }
  $nodeVersion = (& node --version).Trim()
  if ($LASTEXITCODE -ne 0) {
    throw '无法读取 Node.js 版本。'
  }

  $manifest = [ordered]@{
    schemaVersion = 2
    product = 'Cobalt Studio'
    version = $releaseVersion
    platform = 'win-x64'
    builtAt = (Get-Date).ToUniversalTime().ToString('o')
    source = [ordered]@{
      cobaltVersion = $cobaltVersion
      cobaltCommit = $cobaltCommit
      nodeVersion = $nodeVersion
    }
    tests = [ordered]@{
      fullSuite = $testState.fullSuite
      releaseSmoke = $testState.releaseSmoke
      standaloneSmoke = $testState.standaloneSmoke
    }
    package = [ordered]@{
      directory = 'Cobalt Studio'
      files = $measure.Count
      bytes = [int64]$measure.Sum
      executable = 'Cobalt Studio.exe'
      executableSha256 = $exeHash
      archive = $archiveName
      archiveBytes = Get-Bytes $archivePath
      archiveSha256 = $archiveHash
      standalone = $standaloneName
      standaloneBytes = Get-Bytes $standalonePath
      standaloneSha256 = Get-Sha256 $standalonePath
    }
    notes = if ($Notes) { $Notes } else { '' }
  }
  Write-Utf8NoBom $manifestPath ($manifest | ConvertTo-Json -Depth 10)

  $checksumLines = @(
    "$archiveHash  $archiveName"
    "$exeHash  Cobalt Studio/Cobalt Studio.exe"
    "$(Get-Sha256 $standalonePath)  $standaloneName"
    "$(Get-Sha256 $manifestPath)  $(Split-Path -Leaf $manifestPath)"
  )
  $checksumLines | Set-Content -LiteralPath $checksumsPath -Encoding ascii
  Assert-FileHash $archivePath $archiveHash
  Assert-FileHash $ExePath $exeHash
  Assert-FileHash $standalonePath $manifest.package.standaloneSha256
  $manifestCheck = Get-Content -LiteralPath $manifestPath -Raw | ConvertFrom-Json
  if ($manifestCheck.version -ne $releaseVersion -or
      $manifestCheck.package.archiveSha256 -ne $archiveHash -or
      $manifestCheck.package.executableSha256 -ne $exeHash) {
    throw '发布清单回读校验失败。'
  }
  $packagingComplete = $true
} catch {
  $releaseError = $_
  try {
    Restore-ReleaseState
  } catch {
    Write-Warning "运行状态恢复失败：$($_.Exception.Message) 备份位置：$StateBackupDir"
  }
  throw $releaseError
}

if (-not $packagingComplete) {
  throw '发布打包未完成。'
}
Restore-ReleaseState
$restarted = Start-Process -FilePath $ExePath -WorkingDirectory $ReleaseDir -WindowStyle Hidden -PassThru
$startupVerified = $false
$deadline = (Get-Date).AddSeconds(40)
while ((Get-Date) -lt $deadline) {
  try {
    $server = Get-CimInstance Win32_Process | Where-Object {
      $_.ParentProcessId -eq $restarted.Id -and $_.Name -eq 'node.exe' -and $_.CommandLine -like '*server.mjs*'
    } | Select-Object -First 1
    if ($server) {
      $listener = Get-NetTCPConnection -State Listen -OwningProcess $server.ProcessId -ErrorAction SilentlyContinue | Select-Object -First 1
      if ($listener) {
        $bootstrap = Invoke-RestMethod -Uri "http://127.0.0.1:$($listener.LocalPort)/api/bootstrap" -TimeoutSec 3
        $missing = @($script:ExpectedTaskIds | Where-Object { $_ -notin @($bootstrap.tasks.id) })
        if ($bootstrap.app.version -eq $releaseVersion -and $bootstrap.cobalt.online -and $missing.Count -eq 0) {
          $startupVerified = $true
          Write-Host "Running version and preserved task IDs verified: $releaseVersion, $($bootstrap.tasks.Count) tasks"
          break
        }
      }
    }
  } catch { }
  Start-Sleep -Milliseconds 300
}
if (-not $startupVerified) { throw '重启后版本、上游服务或原任务检查未通过；不更新最新交付链接。' }

Write-Host ''
Write-Host "Release:  $releaseVersion"
Write-Host "Folder:   $ReleaseDir"
Write-Host "Archive:  $archivePath"
Write-Host "Manifest: $manifestPath"
Write-Host "SHA256:  $checksumsPath"
Write-Host ("Archive size: {0:N1} MB" -f ((Get-Bytes $archivePath) / 1MB))
Write-ReleaseDelivery $releaseVersion $archivePath $manifestPath
