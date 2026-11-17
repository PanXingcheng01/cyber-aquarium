@echo off
rem Build the one downloadable artifact: dist\CyberAquarium-portable.zip
rem Then attach it to a GitHub Release (repo only carries source; runtime/ and dist/ are gitignored).
rem ASCII only on purpose (cmd.exe doesn't read UTF-8); Chinese file names use wildcards.
rem
rem Layout of the zip:
rem   CyberAquarium\
rem     启动赛博鱼缸.vbs   (the same launcher as in the repo root, auto-detects this layout)
rem     使用说明.txt
rem     说明书.html
rem     runtime\          slimmed Electron runtime
rem     app\              the app (copied from cyber-aquarium\)
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
  echo Unpack it to D:\CyberAquarium\runtime , or set AQ_RUNTIME.
  pause
  exit /b 1
)

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
robocopy "%ROOT%\cyber-aquarium" "%PKG%\app" /E /PURGE /NFL /NDL /NJH /NJS /NP >nul

echo [4/5] launcher + docs ...
copy /y "%ROOT%\赛博鱼缸.exe" "%PKG%\" >nul
copy /y "%ROOT%\创建桌面快捷方式.vbs" "%PKG%\" >nul
copy /y "%ROOT%\使用说明.txt" "%PKG%\" >nul
copy /y "%ROOT%\*.html" "%PKG%\" >nul
if exist "%DIST%\CyberAquarium-portable.zip" del /f /q "%DIST%\CyberAquarium-portable.zip"

echo [5/5] zip ...
tar -a -c -f "%DIST%\CyberAquarium-portable.zip" -C "%DIST%" CyberAquarium
if errorlevel 1 (
  echo ZIP FAILED
  pause
  exit /b 1
)
rem 摊开的中间目录不留在磁盘上（只留 zip）
rmdir /s /q "%PKG%"

for %%F in ("%DIST%\CyberAquarium-portable.zip") do echo done: %%~zF bytes  ^-^>  %%~fF
rem 从资源管理器双击时停下来让人看结果；带参数调用（脚本/CI）就不停
if "%~1"=="" pause
