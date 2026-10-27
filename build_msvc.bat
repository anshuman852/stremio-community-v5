@echo off

rem --- Select MSVC architecture from arguments (default x64; --x86 case-insensitive) ---
set "MSVC_ARCH=x64"
for %%A in (%*) do (
    if /I "%%~A"=="--x86" set "MSVC_ARCH=x86"
)
echo [build_msvc] MSVC architecture: %MSVC_ARCH%

rem --- Locate Visual Studio via vswhere (any edition: BuildTools/Community/
rem --- Professional/Enterprise; falls back to the classic BuildTools path) ---
set "VSWHERE=%ProgramFiles(x86)%\Microsoft Visual Studio\Installer\vswhere.exe"
set "VS_PATH="
if exist "%VSWHERE%" (
    for /f "usebackq delims=" %%i in (`"%VSWHERE%" -latest -products * -requires Microsoft.VisualStudio.Component.VC.Tools.x86.x64 -property installationPath`) do set "VS_PATH=%%i"
)
if "%VS_PATH%"=="" set "VS_PATH=C:\Program Files (x86)\Microsoft Visual Studio\2022\BuildTools"
echo [build_msvc] Visual Studio: %VS_PATH%

call "%VS_PATH%\VC\Auxiliary\Build\vcvarsall.bat" %MSVC_ARCH% >nul
set CC=cl
set CXX=cl
set "PATH=%PATH:C:\TDM-GCC-64\bin;=%"
set "PATH=%PATH:C:\Program Files\Git\mingw64\bin;=%"
set "PATH=%VS_PATH%\Common7\IDE\CommonExtensions\Microsoft\CMake\CMake\bin;%PATH%"
set "PATH=%VS_PATH%\Common7\IDE\CommonExtensions\Microsoft\CMake\Ninja;%PATH%"

rem --- Optional sccache compiler launcher (never fails the build when unavailable) ---
where sccache >nul 2>nul
if not errorlevel 1 (
    set "STREMIO_COMPILER_LAUNCHER=sccache"
    set "SCCACHE_DIR=%LOCALAPPDATA%\Mozilla\sccache"
    set "SCCACHE_CACHE_SIZE=20G"
) else (
    set "STREMIO_COMPILER_LAUNCHER="
    echo [build_msvc] sccache not found on PATH - continuing without compiler launcher.
)

node build/deploy_windows.js %*
