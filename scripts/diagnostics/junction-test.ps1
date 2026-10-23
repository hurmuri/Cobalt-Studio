$projectRoot = Split-Path -Parent (Split-Path -Parent $PSScriptRoot)
Set-Location -LiteralPath $projectRoot
$destination = Join-Path $projectRoot '.build\portable\cobalt-api\api\node_modules\dotenv'
$source = Join-Path $projectRoot '.build\portable\cobalt-api\node_modules\dotenv'
if (Test-Path -LiteralPath $destination) {
  Remove-Item -LiteralPath $destination -Force
}
New-Item -ItemType Junction -Path $destination -Target $source | Out-Null
node -e "import('./.build/portable/cobalt-api/api/node_modules/dotenv/config.js').then(()=>console.log('junction import ok')).catch(e=>{console.error(e.message);process.exit(1)})"
