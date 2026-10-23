param(
  [string]$Output = (Join-Path (Split-Path -Parent $PSScriptRoot) 'release\Cobalt Studio'),
  [string]$Version,
  [switch]$SkipNative
)

$ErrorActionPreference = 'Stop'
$Root = Split-Path -Parent $PSScriptRoot
if (-not $Version) {
  $VersionFile = Join-Path $Root 'VERSION'
  if (-not (Test-Path -LiteralPath $VersionFile)) {
    throw "缺少版本文件：$VersionFile"
  }
  $Version = (Get-Content -LiteralPath $VersionFile -Raw).Trim()
}
if ($Version -notmatch '^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)$') {
  throw "版本号必须使用 major.minor.patch 格式，例如 1.0.1：$Version"
}
$VersionScript = Join-Path $PSScriptRoot 'sync-version.ps1'
$VersionScriptFailure = $null
if (Test-Path -LiteralPath $VersionScript) {
  try {
    $global:LASTEXITCODE = 0
    & $VersionScript -Version $Version -Check
  } catch {
    $VersionScriptFailure = $_
  }
  if ($VersionScriptFailure -or -not $? -or $LASTEXITCODE -ne 0) {
    throw "版本文件未同步到 $Version。`n$($VersionScriptFailure.Exception.Message)"
  }
}
$Build = Join-Path $Root '.build\portable'
$CobaltSource = Join-Path $Root 'cobalt-api'
$CobaltStage = Join-Path $Build 'cobalt-source'
$CobaltDeploy = Join-Path $Build 'cobalt-api'
$DesktopPublish = Join-Path $Build 'desktop'
$NodeSource = (Get-Command node -ErrorAction Stop).Source
$NodeRoot = Split-Path -Parent $NodeSource
$FfmpegFallbacks = @(
  (Join-Path $Root 'cobalt-api\api\node_modules\ffmpeg-static\ffmpeg.exe'),
  (Join-Path $Root 'cobalt-api\.build\cobalt-deploy-test\node_modules\.pnpm\ffmpeg-static@5.3.0\node_modules\ffmpeg-static\ffmpeg.exe'),
  (Join-Path $Root 'cobalt-api\.build\hoisted-deploy\node_modules\.pnpm\ffmpeg-static@5.3.0\node_modules\ffmpeg-static\ffmpeg.exe')
)
$FfmpegSource = $null

function Write-Utf8NoBom([string]$Path, [string]$Text) {
  $encoding = New-Object System.Text.UTF8Encoding($false)
  [System.IO.File]::WriteAllText($Path, $Text, $encoding)
}

function Reset-Directory([string]$Path) {
  $resolvedRoot = [System.IO.Path]::GetFullPath($Root).TrimEnd('\') + '\'
  $resolved = [System.IO.Path]::GetFullPath($Path)
  if (-not $resolved.StartsWith($resolvedRoot, [System.StringComparison]::OrdinalIgnoreCase)) {
    throw "拒绝清理工作区外的路径：$resolved"
  }
  if (Test-Path -LiteralPath $resolved) {
    $links = @(Get-ChildItem -LiteralPath $resolved -Recurse -Force -FollowSymlink:$false -ErrorAction SilentlyContinue |
      Where-Object { $_.LinkType } |
      Sort-Object { $_.FullName.Length } -Descending)
    foreach ($link in $links) {
      if ($link.LinkType) {
        Remove-Item -LiteralPath $link.FullName -Force -ErrorAction Stop
      }
    }
    Remove-Item -LiteralPath $resolved -Recurse -Force
  }
  New-Item -ItemType Directory -Force -Path $resolved | Out-Null
}

function Copy-Tree([string]$Source, [string]$Destination, [switch]$ExcludeNodeModules) {
  $sourcePath = [System.IO.Path]::GetFullPath($Source)
  $destinationPath = [System.IO.Path]::GetFullPath($Destination)
  $sourcePrefix = $sourcePath.TrimEnd('\') + '\'
  $entries = @(Get-ChildItem -LiteralPath $sourcePath -Recurse -Force -FollowSymlink:$false |
    Where-Object {
      return -not $ExcludeNodeModules -or $_.FullName -notmatch '\\node_modules(\\|$)'
    })
  New-Item -ItemType Directory -Force -Path $destinationPath | Out-Null
  $entries | ForEach-Object {
    $relative = $_.FullName.Substring($sourcePrefix.Length)
    $target = Join-Path $destinationPath $relative
    if ($_.LinkType -and $_.PSIsContainer) {
      New-Item -ItemType Junction -Path $target -Target (Resolve-ReparseTarget $_) -Force | Out-Null
    } elseif ($_.PSIsContainer) {
      New-Item -ItemType Directory -Force -Path $target | Out-Null
    } else {
      New-Item -ItemType Directory -Force -Path (Split-Path -Parent $target) | Out-Null
      Copy-Item -LiteralPath $_.FullName -Destination $target -Force
    }
  }
}

function Remove-ReparsePoints([string]$Base) {
  $basePath = [System.IO.Path]::GetFullPath($Base)
  # links are copied as junctions by Copy-Tree
}

function Assert-NoExternalLinks([string]$Base) {
  $basePath = [System.IO.Path]::GetFullPath($Base).TrimEnd('\')
  $links = @(Get-ChildItem -LiteralPath $basePath -Recurse -Force -FollowSymlink:$false -ErrorAction Stop |
    Where-Object { $_.LinkType })
  foreach ($link in $links) {
    $target = Resolve-ReparseTarget $link
    if (-not $target -or
        (-not $target.StartsWith($basePath + '\', [System.StringComparison]::OrdinalIgnoreCase) -and
          -not $target.Equals($basePath, [System.StringComparison]::OrdinalIgnoreCase))) {
      throw "便携目录包含外部链接：$($link.FullName) -> $target"
    }
  }
}

function Remove-MatchingFiles([string]$Base, [string[]]$Patterns) {
  $basePath = [System.IO.Path]::GetFullPath($Base).TrimEnd('\')
  foreach ($pattern in $Patterns) {
    $files = @(Get-ChildItem -LiteralPath $basePath -Recurse -File -Force -Filter $pattern -ErrorAction SilentlyContinue |
      Where-Object { $_.FullName -notmatch '\\cobalt-api\\' })
    foreach ($file in $files) {
      Remove-Item -LiteralPath $file.FullName -Force
    }
  }
}

function Find-FreePort {
  $listener = [System.Net.Sockets.TcpListener]::new([System.Net.IPAddress]::Loopback, 0)
  $listener.Start()
  try {
    return ([System.Net.IPEndPoint]$listener.LocalEndpoint).Port
  } finally {
    $listener.Stop()
  }
}

function Resolve-ReparseTarget([string]$Link) {
  $target = @((Get-Item -LiteralPath $Link -Force).Target)[0]
  if ($target -and -not [System.IO.Path]::IsPathRooted($target)) {
    $target = Join-Path (Split-Path -Parent $Link) $target
  }
  if ($target) { return [System.IO.Path]::GetFullPath($target) }
  return $null
}

function Flatten-DependencyLinks([string]$ModulesPath) {
  if (-not (Test-Path -LiteralPath $ModulesPath)) { return }
  $modulesRoot = [System.IO.Path]::GetFullPath($ModulesPath)
  $apiModulesRoot = [System.IO.Path]::GetFullPath((Join-Path $CobaltDeploy 'api\node_modules'))
  $deployRoot = [System.IO.Path]::GetFullPath($CobaltDeploy).TrimEnd('\')
  $passes = 0
  do {
    $links = @(Get-ChildItem -LiteralPath $modulesRoot -Recurse -Force -ErrorAction SilentlyContinue |
      Where-Object { $_.LinkType -and -not $_.FullName.StartsWith($apiModulesRoot, [System.StringComparison]::OrdinalIgnoreCase) } |
      Sort-Object { $_.FullName.Length } -Descending)
    $advanced = $false
    foreach ($link in $links) {
      $target = Resolve-ReparseTarget $link
      if (-not $target -or -not (Test-Path -LiteralPath $target)) {
        throw "依赖链接目标不存在：$($link.FullName)"
      }
      if (-not $target.StartsWith($modulesRoot, [System.StringComparison]::OrdinalIgnoreCase)) {
        if ($target -eq $deployRoot -or
            $target.StartsWith($deployRoot + '\', [System.StringComparison]::OrdinalIgnoreCase)) {
          Remove-Item -LiteralPath $link.FullName -Force
          continue
        }
        throw "依赖链接指向暂存目录外：$($link.FullName) -> $target"
      }
      Remove-Item -LiteralPath $link.FullName -Force
      New-Item -ItemType Junction -Path $link.FullName -Target $target | Out-Null
      $advanced = $true
    }
    $passes += 1
    if ($passes -gt 12) { throw "依赖链接层级过深：$modulesRoot" }
  } while ($links.Count -gt 0 -and $advanced)
  if ($links.Count -gt 0) {
    throw "依赖链接无法展开：$modulesRoot"
  }

  $store = Join-Path $modulesRoot '.pnpm'
  if (Test-Path -LiteralPath $store) {
    Remove-Item -LiteralPath $store -Recurse -Force
  }
  $bin = Join-Path $modulesRoot '.bin'
  if (Test-Path -LiteralPath $bin) {
    Remove-Item -LiteralPath $bin -Recurse -Force
  }

}

foreach ($candidate in $FfmpegFallbacks) {
  if (Test-Path -LiteralPath $candidate) {
    $FfmpegSource = $candidate
    break
  }
}
if (-not (Test-Path -LiteralPath $FfmpegSource)) {
  throw "缺少 ffmpeg-static ffmpeg.exe；已检查：`n$($FfmpegFallbacks -join "`n")"
}
if (-not (Test-Path -LiteralPath (Join-Path $CobaltSource 'api\src\cobalt.js'))) {
  throw "缺少 cobalt 源码：$CobaltSource"
}
$commit = (& git -C $CobaltSource rev-parse HEAD).Trim()
if ($LASTEXITCODE -ne 0 -or $commit -notmatch '^[0-9a-f]{40}$') {
  throw '无法读取 cobalt 源码提交号。'
}

New-Item -ItemType Directory -Force -Path $Build | Out-Null
Reset-Directory $CobaltStage
Get-ChildItem -LiteralPath $CobaltSource -Force | Where-Object {
  $_.Name -notin @('node_modules', '.git', '.build')
} | ForEach-Object {
  $destination = Join-Path $CobaltStage $_.Name
  if ($_.PSIsContainer) {
    Copy-Tree $_.FullName $destination -ExcludeNodeModules
  } else {
    Copy-Item -LiteralPath $_.FullName -Destination $destination -Force
  }
}

$ApiStage = Join-Path $CobaltStage 'api'
$ApiPackageFile = Join-Path $ApiStage 'package.json'
$ApiPackageText = Get-Content -LiteralPath $ApiPackageFile -Raw
$ApiPackageText = $ApiPackageText.Replace('workspace:^', 'file:../packages/version-info')
Write-Utf8NoBom $ApiPackageFile $ApiPackageText
Push-Location $ApiStage
try {
  & npm install --omit=dev --ignore-scripts --package-lock=false --no-audit --no-fund
  if ($LASTEXITCODE -ne 0) {
    throw 'cobalt 生产依赖安装失败。'
  }
} finally {
  Pop-Location
}

$VersionInfo = Join-Path $ApiStage 'node_modules\@imput\version-info'
if (-not (Test-Path -LiteralPath (Join-Path $VersionInfo 'package.json'))) {
  throw "cobalt 缺少 @imput/version-info：$VersionInfo"
}
Remove-Item -LiteralPath $VersionInfo -Recurse -Force
Copy-Tree (Join-Path $CobaltSource 'packages\version-info') $VersionInfo

Reset-Directory $CobaltDeploy
Copy-Tree $CobaltStage $CobaltDeploy
& node (Join-Path $PSScriptRoot 'patch-cobalt.mjs') $CobaltDeploy
if ($LASTEXITCODE -ne 0) { throw 'cobalt compatibility patch failed.' }

$CobaltEntry = Join-Path $CobaltDeploy 'api\src\cobalt.js'
if (-not (Test-Path -LiteralPath $CobaltEntry)) {
  throw "cobalt 生产依赖产物不完整：$CobaltEntry"
}
$FfmpegPackage = Join-Path $CobaltDeploy 'api\node_modules\ffmpeg-static'
if (-not (Test-Path -LiteralPath (Join-Path $FfmpegPackage 'index.js'))) {
  throw "cobalt 缺少 ffmpeg-static：$FfmpegPackage"
}
$FfmpegDeploy = Join-Path $FfmpegPackage 'ffmpeg.exe'
if (Test-Path -LiteralPath $FfmpegDeploy) {
  Remove-Item -LiteralPath $FfmpegDeploy -Force
}
$FfmpegSourceDirectory = Split-Path -Parent $FfmpegSource
$FfmpegLicense = Join-Path $FfmpegSourceDirectory 'ffmpeg.exe.LICENSE'
$FfmpegReadme = Join-Path $FfmpegSourceDirectory 'ffmpeg.exe.README'
foreach ($file in @($FfmpegLicense, $FfmpegReadme)) {
  if (Test-Path -LiteralPath $file) {
    Copy-Item -LiteralPath $file -Destination (Join-Path $FfmpegPackage (Split-Path -Leaf $file)) -Force
  }
}
$CobaltEntryFile = Join-Path $CobaltDeploy 'api\src\cobalt.js'
$CobaltEntryText = Get-Content -LiteralPath $CobaltEntryFile -Raw
$CobaltEntryText = $CobaltEntryText.Replace('import "dotenv/config";', 'import "dotenv/config.js";')
Write-Utf8NoBom $CobaltEntryFile $CobaltEntryText

$CobaltGit = Join-Path $CobaltDeploy '.git'
New-Item -ItemType Directory -Force -Path (Join-Path $CobaltGit 'logs') | Out-Null
Set-Content -LiteralPath (Join-Path $CobaltGit 'HEAD') -Encoding ascii -NoNewline -Value 'ref: refs/heads/main'
Set-Content -LiteralPath (Join-Path $CobaltGit 'config') -Encoding ascii -Value @'
[remote "origin"]
    url = https://github.com/imputnet/cobalt.git
'@
Set-Content -LiteralPath (Join-Path $CobaltGit 'logs\HEAD') -Encoding ascii -Value @(
  "0000000000000000000000000000000000000000 $commit Cobalt Studio <local> 0 +0000`tclone: from https://github.com/imputnet/cobalt.git"
) -NoNewline

$SmokePort = Find-FreePort
$SmokeLog = Join-Path $Build 'cobalt-smoke.log'
$SmokeError = Join-Path $Build 'cobalt-smoke-error.log'
$SmokeProcess = $null
Remove-Item -LiteralPath $SmokeLog,$SmokeError -Force -ErrorAction SilentlyContinue
try {
  $env:API_PORT = $SmokePort.ToString()
  $env:API_LISTEN_ADDRESS = '127.0.0.1'
  $env:API_URL = "http://127.0.0.1:$SmokePort/"
  $env:CORS_WILDCARD = '1'
  $env:FFMPEG_BIN = $FfmpegSource
  $env:FFMPEG_PATH = $FfmpegSource
  $SmokeProcess = Start-Process -FilePath $NodeSource `
    -ArgumentList '.\src\cobalt.js' `
    -WorkingDirectory (Join-Path $CobaltDeploy 'api') `
    -RedirectStandardOutput $SmokeLog -RedirectStandardError $SmokeError `
    -PassThru -WindowStyle Hidden
  $deadline = (Get-Date).AddSeconds(30)
  $ready = $false
  while ((Get-Date) -lt $deadline) {
    Start-Sleep -Milliseconds 250
    if ($SmokeProcess.HasExited) { break }
    try {
      $response = Invoke-WebRequest -UseBasicParsing -Uri "http://127.0.0.1:$SmokePort/" -TimeoutSec 1
      if ($response.StatusCode -eq 200 -and $response.Content -match '"cobalt"') {
        $ready = $true
        break
      }
    } catch {}
  }
  if (-not $ready) {
    $detail = if (Test-Path -LiteralPath $SmokeError) { (Get-Content -LiteralPath $SmokeError -Tail 20) -join "`n" } else { '' }
    throw "打包前 cobalt 启动验收失败。`n$detail"
  }
} finally {
  if ($SmokeProcess -and -not $SmokeProcess.HasExited) {
    Stop-Process -Id $SmokeProcess.Id -Force -ErrorAction SilentlyContinue
    Wait-Process -Id $SmokeProcess.Id -Timeout 5 -ErrorAction SilentlyContinue
  }
  Remove-Item Env:API_PORT,Env:API_LISTEN_ADDRESS,Env:API_URL,Env:CORS_WILDCARD,Env:FFMPEG_BIN,Env:FFMPEG_PATH -ErrorAction SilentlyContinue
}

if ($SkipNative) {
  dotnet build (Join-Path $Root 'windows\CobaltStudio.Desktop.csproj') -c Release --nologo
} else {
  Reset-Directory $DesktopPublish
  dotnet publish (Join-Path $Root 'windows\CobaltStudio.Desktop.csproj') `
    -c Release `
    -o $DesktopPublish --nologo
}
if ($LASTEXITCODE -ne 0) { throw 'Windows 客户端构建失败。' }

Reset-Directory $Output
if ($SkipNative) {
  Copy-Tree (Join-Path $Root 'windows\bin\Release\net10.0-windows') $Output
} else {
  Copy-Tree $DesktopPublish $Output
}

Remove-MatchingFiles $Output @('msedgewebview2.exe')

$runtime = Join-Path $Output 'runtime'
New-Item -ItemType Directory -Force -Path $runtime | Out-Null
Copy-Item -LiteralPath $NodeSource -Destination (Join-Path $runtime 'node.exe') -Force
Copy-Item -LiteralPath $FfmpegSource -Destination (Join-Path $runtime 'ffmpeg.exe') -Force

$files = @(
  'VERSION',
  'server.mjs',
  'lib.mjs',
  'package.json',
  'package-lock.json',
  'README.md',
  '.env.example'
)
foreach ($file in $files) {
  $source = Join-Path $Root $file
  if (Test-Path -LiteralPath $source) {
    Copy-Item -LiteralPath $source -Destination (Join-Path $Output $file) -Force
  }
}
Copy-Item -LiteralPath (Join-Path $Root 'docs\PORTABLE-README.md') -Destination (Join-Path $Output 'README.md') -Force
# Node 24 otherwise ignores inherited HTTP(S)_PROXY settings for fetch().
$PackageFile = Join-Path $Output 'package.json'
$PackageText = Get-Content -LiteralPath $PackageFile -Raw
$PackageText = $PackageText.Replace('"start": "node server.mjs"', '"start": "node --use-env-proxy server.mjs"')
Write-Utf8NoBom $PackageFile $PackageText

foreach ($directory in @('lib', 'public')) {
  Copy-Tree (Join-Path $Root $directory) (Join-Path $Output $directory)
}

$rootNodeModules = Join-Path $Root 'node_modules'
Copy-Tree $rootNodeModules (Join-Path $Output 'node_modules')
$packagedNodeModules = Join-Path $Output 'node_modules'
Get-ChildItem -LiteralPath $packagedNodeModules -Force | Where-Object {
  $_.Name -eq '.package-lock.json'
} | Remove-Item -Force

$CobaltOutput = Join-Path $Output 'cobalt-api'
Copy-Tree $CobaltDeploy $CobaltOutput
Copy-Item -LiteralPath (Join-Path $CobaltSource 'LICENSE') -Destination (Join-Path $Output 'COBALT-LICENSE.txt') -Force
foreach ($licenseName in @('LICENSE', 'NOTICE', 'THIRD-PARTY-NOTICES.md')) {
  Copy-Item -LiteralPath (Join-Path $Root $licenseName) -Destination (Join-Path $Output $licenseName) -Force
}
Copy-Item -LiteralPath (Join-Path $CobaltSource 'api\LICENSE') -Destination (Join-Path $Output 'COBALT-API-LICENSE.txt') -Force
Copy-Item -LiteralPath (Join-Path $CobaltSource 'README.md') -Destination (Join-Path $Output 'COBALT-README.md') -Force
Copy-Item -LiteralPath (Join-Path $CobaltSource 'api\README.md') -Destination (Join-Path $Output 'COBALT-API-README.md') -Force
Copy-Item -LiteralPath $FfmpegLicense -Destination (Join-Path $Output 'FFMPEG-LICENSE.txt') -Force
$NodeLicense = @(
  (Join-Path $NodeRoot 'LICENSE'),
  (Join-Path (Split-Path -Parent $NodeRoot) 'LICENSE')
) | Where-Object { Test-Path -LiteralPath $_ } | Select-Object -First 1
if (-not $NodeLicense) {
  $NodeLicense = (Get-ChildItem -Path (Split-Path -Parent $NodeRoot) -Filter 'LICENSE*' -File -ErrorAction SilentlyContinue | Select-Object -First 1).FullName
}
if ($NodeLicense) {
  Copy-Item -LiteralPath $NodeLicense -Destination (Join-Path $Output 'NODE-LICENSE.txt') -Force
} else {
  Set-Content -LiteralPath (Join-Path $Output 'NODE-LICENSE.txt') -Encoding utf8 -Value @'
Node.js is distributed under the MIT license and includes third-party
components under their respective licenses. See:
https://github.com/nodejs/node/blob/main/LICENSE
'@
}

$notice = @'
Cobalt Studio third-party notices

Cobalt Studio itself is AGPL-3.0-only.
Source: https://github.com/hurmuri/Cobalt-Studio
See LICENSE, NOTICE, and THIRD-PARTY-NOTICES.md.

cobalt API
  Copyright imput and contributors
  License: AGPL-3.0
  Source: https://github.com/imputnet/cobalt
  This portable package includes the cobalt API source and its
  production dependencies. The complete corresponding source is available
  from the URL above and is included under cobalt-api/.
  Local Instagram fallback fixes are applied by scripts/patch-cobalt.mjs
  in the Cobalt Studio source project; the patched source is included here.

Node.js
  License: MIT and third-party licenses
  Source: https://github.com/nodejs/node

FFmpeg
  This build is distributed by the ffmpeg-static package.
  License details are in FFMPEG-LICENSE.txt.

Cobalt Studio uses no account system. The local UI and mobile page are
available to devices that can reach this PC on the same network.
'@
Set-Content -LiteralPath (Join-Path $Output 'THIRD-PARTY-NOTICES.txt') -Value $notice -Encoding utf8

$readme = @'
Cobalt Studio - Windows portable

1. Keep this folder in a writable location.
2. Double-click "Cobalt Studio.exe".
3. Enter a media URL and choose the output options.
4. Use the QR code in the desktop app to open the mobile page on the same LAN.

The app starts its own local cobalt instance and web server. Ports are selected
automatically, so an existing service on 8787 or 9000 will not be disturbed.
Downloads default to D:\downloads\cobalt and can be changed in Settings.
If HTTP_PROXY or HTTPS_PROXY is configured, media downloads use that proxy
automatically so CDN access follows the system network configuration.

Runtime data, logs and WebView2 profile data are written to .data/.
Do not upload this folder to a public site. Anyone who can reach the PC on the
same network can submit downloads because there is intentionally no login.
'@
Set-Content -LiteralPath (Join-Path $Output 'START-HERE.txt') -Value $readme -Encoding utf8

$executable = Join-Path $Output 'Cobalt Studio.exe'
if (-not (Test-Path -LiteralPath $executable)) { throw "缺少客户端程序：$executable" }
$required = @(
  'VERSION',
  'server.mjs',
  'public\index.html',
  'node_modules\qrcode\package.json',
  'runtime\node.exe',
  'runtime\ffmpeg.exe',
  'cobalt-api\api\src\cobalt.js',
  'cobalt-api\api\node_modules\express\package.json',
  'cobalt-api\api\node_modules\ffmpeg-static\index.js',
  'cobalt-api\api\node_modules\ffmpeg-static\ffmpeg.exe.LICENSE'
)
foreach ($relative in $required) {
  if (-not (Test-Path -LiteralPath (Join-Path $Output $relative))) {
    throw "便携包缺少文件：$relative"
  }
}
Assert-NoExternalLinks $Output

$measure = Get-ChildItem -LiteralPath $Output -Recurse -File | Measure-Object Length -Sum
Write-Host ("Portable package: {0}" -f $Output)
Write-Host ("Files: {0}, size: {1:N1} MB" -f $measure.Count, ($measure.Sum / 1MB))
Write-Host "Cleaning test state (if any)"
$state = Join-Path $Output '.data'
$downloadState = Join-Path $Output 'downloads'
foreach ($path in @($state, $downloadState)) {
  if (Test-Path -LiteralPath $path) {
    $resolved = [System.IO.Path]::GetFullPath($path)
    $outputRoot = [System.IO.Path]::GetFullPath($Output).TrimEnd('\') + '\'
    if (-not $resolved.StartsWith($outputRoot, [System.StringComparison]::OrdinalIgnoreCase)) {
      throw "拒绝清理输出目录外路径：$resolved"
    }
    Remove-Item -LiteralPath $resolved -Recurse -Force
  }
}
