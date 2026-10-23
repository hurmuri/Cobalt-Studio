param(
  [switch]$Force,
  [switch]$SourceOnly
)

$ErrorActionPreference = 'Stop'
$Root = Split-Path -Parent $PSScriptRoot
$Repo = Join-Path $Root 'cobalt-api'
$Api = Join-Path $Repo 'api'
$Upstream = Get-Content -LiteralPath (Join-Path $Root 'UPSTREAM.json') -Raw | ConvertFrom-Json

function Require-Command([string]$Name) {
  if (-not (Get-Command $Name -ErrorAction SilentlyContinue)) {
    throw "缺少 $Name，请先安装并加入 PATH。"
  }
}

Require-Command git
if (-not $SourceOnly) {
  Require-Command node
  Require-Command pnpm
}

if ($Force -and (Test-Path -LiteralPath $Repo)) {
  throw '为避免误删源码，-Force 也不会自动删除 cobalt-api。请手动移走后再重试。'
}

if (-not (Test-Path -LiteralPath (Join-Path $Api 'package.json'))) {
  Write-Host "获取 cobalt $($Upstream.version) ($($Upstream.commit.Substring(0, 12)))…"
  git clone --filter=blob:none --no-checkout $Upstream.repository $Repo
  git -C $Repo fetch --depth 1 origin $Upstream.commit
  git -C $Repo checkout --detach FETCH_HEAD
} else {
  $head = (git -C $Repo rev-parse HEAD).Trim()
  if ($head -ne $Upstream.commit) {
    Write-Warning "cobalt-api 当前是 $head，项目锁定的是 $($Upstream.commit)。未自动切换，避免覆盖本地修改。"
  }
}

if ($SourceOnly) {
  Write-Host "cobalt 源码已准备：$($Upstream.commit)"
  return
}

Push-Location $Repo
try {
  if (-not (Test-Path -LiteralPath (Join-Path $Api 'node_modules'))) {
    Write-Host '安装 cobalt API 依赖（首次约 300MB）…'
    pnpm install --prod --no-frozen-lockfile
  }
} finally {
  Pop-Location
}

$ffmpeg = Join-Path $Api 'node_modules\ffmpeg-static\ffmpeg.exe'
if (-not (Test-Path -LiteralPath $ffmpeg)) {
  Write-Warning 'ffmpeg-static 未下载成功，但系统 ffmpeg 可作为备用。'
}

$envFile = Join-Path $Api '.env'
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

Write-Host 'cobalt 本机实例已准备完成。'
Write-Host '运行 .\start.cmd 启动完整下载器。'
