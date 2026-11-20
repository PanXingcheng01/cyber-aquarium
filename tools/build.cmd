@echo off
rem 让 cmd 按 UTF-8 解析本脚本里的中文文件名/目录名
chcp 65001 >nul
rem Build the one downloadable artifact: dist\CyberAquarium-v<version>-portable.zip
rem Then attach it to a GitHub Release (repo only carries source; runtime/ and dist/ are gitignored).
rem ASCII only on purpose (cmd.exe doesn't read UTF-8); Chinese names are used literally below.
rem
rem Zip layout:
rem   CyberAquarium\
rem     启动赛博鱼缸.exe      launcher compiled here from tools\launcher.cs (icon + version embedded)
rem     快速上手.txt / 用户手册.html
rem     runtime\          slimmed Electron runtime
rem     app\              the app (source: app\)
rem
rem Slimming (tested, keeps everything working):
rem   - locales: only zh-CN / en-US / zh-TW           (-47 MB)
rem   - dxcompiler.dll (WebGPU/DXC shaders, unused)    (-25 MB)
rem   - electron_wer.dll (crash reporter plugin)       (-0.4 MB)
rem DO NOT delete: ffmpeg.dll, resources\default_app.asar, d3dcompiler_47.dll,
rem                 vk_swiftshader.dll / vulkan-1.dll (GPU-less fallback)
setlocal
cd /d "%~dp0.."
set "ROOT=%CD%"
set "DIST=%ROOT%\dist"
set "PKG=%DIST%\CyberAquarium"
set "RUNTIME=%AQ_RUNTIME%"
if "%RUNTIME%"=="" set "RUNTIME=%ROOT%\runtime"

if not exist "%RUNTIME%\electron.exe" (
  echo Electron runtime not found: %RUNTIME%\electron.exe
  echo Unpack Electron to the repo\runtime , or set AQ_RUNTIME.
  pause
  exit /b 1
)

rem ---- version comes from the app's package.json ----
set "VER="
for /f "tokens=2 delims=:" %%v in ('findstr /c:"\"version\"" "%ROOT%\app\package.json"') do set "VER=%%v"
set "VER=%VER: =%"
set "VER=%VER:"=%"
set "VER=%VER:,=%"
if "%VER%"=="" set "VER=0.0.0"
set "OUT=%DIST%\CyberAquarium-v%VER%-portable.zip"
del /f /q "%OUT%" 2>nul

if exist "%PKG%" rmdir /s /q "%PKG%"
mkdir "%PKG%\app" 2>nul
mkdir "%PKG%\runtime" 2>nul

echo [1/5] runtime ...
robocopy "%RUNTIME%" "%PKG%\runtime" /E /NFL /NDL /NJH /NJS /NP >nul

echo [2/5] slim runtime ...
for %%L in ("%PKG%\runtime\locales\*.pak") do (
  if /I not "%%~nxL"=="zh-CN.pak" if /I not "%%~nxL"=="en-US.pak" if /I not "%%~nxL"=="zh-TW.pak" del /f /q "%%~fL"
)
del /f /q "%PKG%\runtime\dxcompiler.dll" 2>nul
del /f /q "%PKG%\runtime\electron_wer.dll" 2>nul

echo [3/5] app ...
robocopy "%ROOT%\app" "%PKG%\app" /E /PURGE /NFL /NDL /NJH /NJS /NP >nul

echo [3b/5] plugins ...
mkdir "%PKG%\plugins" 2>nul
robocopy "%ROOT%\plugins" "%PKG%\plugins" /E /NFL /NDL /NJH /NJS /NP >nul

echo [4/5] launcher + docs ...
rem 重新编译启动器，把版本号写进文件属性（右键 - 属性 - 详细信息能看到）
set "CSC=%WINDIR%\Microsoft.NET\Framework64\v4.0.30319\csc.exe"
if not exist "%CSC%" set "CSC=%WINDIR%\Microsoft.NET\Framework\v4.0.30319\csc.exe"
if not exist "%CSC%" goto nocsc

set "VCS=%ROOT%\tools\_version.cs"
del /f /q "%VCS%" 2>nul
echo using System.Reflection;>>"%VCS%"
echo [assembly: AssemblyVersion("%VER%.0")]>>"%VCS%"
echo [assembly: AssemblyFileVersion("%VER%")]>>"%VCS%"
echo [assembly: AssemblyInformationalVersion("%VER%")]>>"%VCS%"
echo [assembly: AssemblyCopyright("Copyright (c) 2026 PanXingcheng01")]>>"%VCS%"

"%CSC%" /nologo /target:winexe /platform:anycpu /optimize+ "/out:%ROOT%\启动赛博鱼缸.exe" "/win32icon:%ROOT%\assets\aquarium.ico" /reference:System.dll /reference:System.Windows.Forms.dll /reference:System.Drawing.dll "%ROOT%\tools\launcher.cs" "%VCS%" >nul
if errorlevel 1 echo   WARNING: launcher compile failed, keeping the existing exe
del /f /q "%VCS%" 2>nul
goto launcherdone
:nocsc
echo   WARNING: csc not found, keeping the existing exe
:launcherdone

copy /y "%ROOT%\启动赛博鱼缸.exe" "%PKG%\" >nul
copy /y "%ROOT%\快速上手.txt" "%PKG%\" >nul
copy /y "%ROOT%\*.html" "%PKG%\" >nul

echo [5/5] zip ...
rem UTF-8 文件名：tar 会写 GBK 且不设 UTF-8 标志，改用 Compress-Archive（ZIP bit 11）
powershell -NoProfile -Command "Compress-Archive -Path '%PKG%' -DestinationPath '%OUT%' -CompressionLevel Optimal -Force"
if errorlevel 1 (
  echo ZIP FAILED
  pause
  exit /b 1
)
rem 摊开的中间目录不留在磁盘上（只留 zip）
rmdir /s /q "%PKG%"

rem 本地存档：dist 只留当前版本。
rem 同 x.y 的 z 更新删除旧 portable/setup；换 x.y 时两者一起进 history\vX.Y.Z\。
powershell -NoProfile -ExecutionPolicy Bypass -File "%ROOT%\tools\archive-dist.ps1" -Version "%VER%"
if errorlevel 1 (
  echo ARCHIVE FAILED
  pause
  exit /b 1
)

for %%F in ("%OUT%") do echo done: %%~zF bytes  ^-^>  %%~fF
rem 从资源管理器双击时停下来看结果；带参数调用（脚本/CI）就不停
if "%~1"=="" pause