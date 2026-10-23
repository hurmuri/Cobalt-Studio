param(
  [switch]$NoBrowser,
  [switch]$CobaltOnly,
  [switch]$NoCobalt
)

$ErrorActionPreference = 'Stop'
$Root = Split-Path -Parent $PSScriptRoot
Set-Location -LiteralPath $Root

function Test-Port([int]$Port) {
  $client = [System.Net.Sockets.TcpClient]::new()
  try {
    $result = $client.BeginConnect('127.0.0.1', $Port, $null, $null)
    if (-not $result.AsyncWaitHandle.WaitOne(400)) { return $false }
    $client.EndConnect($result)
    return $true
  } catch {
    return $false
  } finally {
    $client.Dispose()
  }
}

function Ensure-Ffmpeg {
  $bundled = Join-Path $Root 'cobalt-api\api\node_modules\ffmpeg-static\ffmpeg.exe'
  if (Test-Path -LiteralPath $bundled) { return $bundled }
  $system = Get-Command ffmpeg -ErrorAction SilentlyContinue
  if ($system) { return $system.Source }
  throw '找不到 ffmpeg。请运行 setup-cobalt.cmd，或安装系统 ffmpeg。'
}

$cobaltDir = Join-Path $Root 'cobalt-api\api'
$cobaltEntry = Join-Path $cobaltDir 'src\cobalt.js'
$cobaltRunning = Test-Port 9000

if (-not $cobaltRunning -and -not $NoCobalt) {
  if (-not (Test-Path -LiteralPath $cobaltEntry)) {
    throw "cobalt API 源码不存在：$cobaltEntry。请先运行 setup-cobalt.cmd。"
  }
  if (-not (Test-Path -LiteralPath (Join-Path $cobaltDir 'node_modules'))) {
    throw "cobalt API 依赖不存在。请先运行 setup-cobalt.cmd。"
  }

  $envFile = Join-Path $cobaltDir '.env'
  if (-not (Test-Path -LiteralPath $envFile)) {
    @(
      'API_URL=http://127.0.0.1:9000/'
      'API_PORT=9000'
      'API_LISTEN_ADDRESS=127.0.0.1'
      'CORS_WILDCARD=1'
      'RATELIMIT_WINDOW=60'
      'RATELIMIT_MAX=200'
      'TUNNEL_RATELIMIT_WINDOW=60'
      'TUNNEL_RATELIMIT_MAX=80'
      'DURATION_LIMIT=10800'
    ) | Set-Content -LiteralPath $envFile -Encoding utf8
  }

  $bundledFfmpeg = Ensure-Ffmpeg
  if (Test-Path -LiteralPath $bundledFfmpeg) {
    $env:PATH = "$cobaltDir\node_modules\ffmpeg-static;$env:PATH"
  }
  $env:FFMPEG_PATH = $bundledFfmpeg
  $nodeExe = (Get-Command node).Source
  $apiOutLog = Join-Path $Root '.data\cobalt-api.log'
  $apiErrLog = Join-Path $Root '.data\cobalt-api.err.log'
  New-Item -ItemType Directory -Force -Path (Join-Path $Root '.data') | Out-Null
  $nodeArgs = "`"$cobaltEntry`""
  $apiProcess = Start-Process -FilePath $nodeExe -ArgumentList $nodeArgs -WorkingDirectory $cobaltDir -WindowStyle Hidden -RedirectStandardOutput $apiOutLog -RedirectStandardError $apiErrLog -PassThru

  $waitUntil = (Get-Date).AddSeconds(20)
  while ((Get-Date) -lt $waitUntil -and -not (Test-Port 9000)) {
    Start-Sleep -Milliseconds 250
  }
  if (-not (Test-Port 9000)) {
    try { Stop-Process -Id $apiProcess.Id -Force -ErrorAction SilentlyContinue } catch {}
    throw "cobalt API 启动失败，请检查 $apiErrLog。"
  }
}

if ($CobaltOnly) {
  Write-Host 'cobalt API 已启动：http://127.0.0.1:9000/'
  exit 0
}

if (-not (Test-Path -LiteralPath (Join-Path $Root 'node_modules\qrcode'))) {
  npm install --omit=dev
}

$port = if ($env:PORT) { [int]$env:PORT } else { 8787 }
$url = "http://127.0.0.1:$port"
if (-not $NoBrowser) {
  $launcherArgs = @(
    '-NoProfile',
    '-WindowStyle', 'Hidden',
    '-Command',
    "for (`$i=0; `$i -lt 50; `$i++) { try { `$r=Invoke-WebRequest -Uri '$url/api/health' -UseBasicParsing -TimeoutSec 1; if (`$r.StatusCode -eq 200) { Start-Process '$url'; break } } catch {}; Start-Sleep -Milliseconds 200 }"
  )
  $launcher = Start-Process -FilePath 'powershell.exe' -ArgumentList $launcherArgs -WindowStyle Hidden -PassThru
}

$env:COBALT_API_URL = 'http://127.0.0.1:9000/'
node .\server.mjs
if ($launcher) {
  try { Stop-Process -Id $launcher.Id -Force -ErrorAction SilentlyContinue } catch {}
}
