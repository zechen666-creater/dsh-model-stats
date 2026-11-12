@echo off
rem 改完 lib\client.js 后必须跑本脚本：App 加载的是 profile 里的副本，不是本目录。
rem 用法：双击，或在 PowerShell 里 .\同步到profile.cmd
setlocal
set SRC=D:\dsh\plugins\dsh-model-stats\lib\client.js
set DST=D:\dsh\profiles\desktop\node_modules\dsh-model-stats\lib\client.js
if not exist "%SRC%" (echo [x] 源文件不存在 & exit /b 1)
if not exist "%DST%" (echo [x] profile 副本不存在，先 dsh plugin --profile desktop add file:D:/dsh/plugins/dsh-model-stats & exit /b 1)
copy /Y "%DST%" "%DST%.bak-自动备份" >nul
copy /Y "%SRC%" "%DST%" >nul
for /f %%i in ('powershell -NoProfile -Command "(Get-FileHash '%SRC%').Hash"') do set H1=%%i
for /f %%i in ('powershell -NoProfile -Command "(Get-FileHash '%DST%').Hash"') do set H2=%%i
if "%H1%"=="%H2%" (echo [ok] 已同步，两侧哈希一致 & echo   %DST%) else (echo [x] 同步后哈希不一致，检查权限)
endlocal
