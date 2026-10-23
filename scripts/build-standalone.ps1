[CmdletBinding()]
param([Parameter(Mandatory)][string]$Archive, [Parameter(Mandatory)][string]$Output, [Parameter(Mandatory)][string]$Version)
$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
$archivePath = (Resolve-Path -LiteralPath $Archive).Path
$hashFile = "$archivePath.sha256"
try {
  [IO.File]::WriteAllText($hashFile, (Get-FileHash -LiteralPath $archivePath -Algorithm SHA256).Hash.ToLowerInvariant())
  $publish = Join-Path $root '.build\standalone-publish'
  & dotnet publish (Join-Path $root 'launcher\CobaltStudio.Launcher.csproj') -c Release -o $publish --nologo "-p:PayloadArchive=$archivePath" "-p:Version=$Version" "-p:FileVersion=$Version.0"
  if ($LASTEXITCODE -ne 0) { throw 'Standalone EXE build failed.' }
  Copy-Item -LiteralPath (Join-Path $publish 'Cobalt Studio Standalone.exe') -Destination $Output -Force
} finally {
  Remove-Item -LiteralPath $hashFile -Force -ErrorAction SilentlyContinue
}
