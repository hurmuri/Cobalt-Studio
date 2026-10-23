@echo off
setlocal
cd /d "%~dp0"
where pwsh.exe >nul 2>nul
if errorlevel 1 (
  echo PowerShell 7 is required. Run scripts\release.ps1 from PowerShell 7.
  exit /b 1
)
if "%~1"=="" (
  pwsh.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0scripts\release.ps1" -Bump patch
) else (
  pwsh.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0scripts\release.ps1" %*
)
exit /b %errorlevel%
