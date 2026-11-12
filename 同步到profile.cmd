@echo off
rem Copy lib\client.js into the profile copy that the DSH App actually loads.
rem pnpm installs a real copy (not a symlink), so editing this folder alone has no effect.
rem Usage: double-click this file, or run it from PowerShell.
rem Profile location: %DSH_HOME% when set, else derived as two levels above this script.
rem This file carries no absolute local paths, so it is safe to publish.
setlocal EnableExtensions
for %%A in ("%~dp0..\..") do set "DSH_HOME_FALLBACK=%%~fA"
if not defined DSH_HOME set "DSH_HOME=%DSH_HOME_FALLBACK%"
set "SRC=%~dp0lib\client.js"
set "DST=%DSH_HOME%\profiles\desktop\node_modules\dsh-model-stats\lib\client.js"
if not exist "%SRC%" (echo [x] source not found: %SRC% & exit /b 1)
if not exist "%DST%" (echo [x] profile copy not found: %DST% & echo     run: dsh plugin --profile desktop add file:. & exit /b 1)
copy /Y "%DST%" "%DST%.bak-auto" >nul
copy /Y "%SRC%" "%DST%" >nul
powershell -NoProfile -Command "if ((Get-FileHash '%SRC%').Hash -eq (Get-FileHash '%DST%').Hash) { exit 0 } else { exit 1 }" >nul 2>nul
if errorlevel 1 (echo [x] hash mismatch after copy & exit /b 1)
echo [ok] synced, both sides hash-equal
echo   %DST%
endlocal
