@echo off

rem --- Select MSVC architecture from arguments (default x64; --x86 case-insensitive) ---
set "MSVC_ARCH=x64"
for %%A in (%*) do (
    if /I "%%~A"=="--x86" set "MSVC_ARCH=x86"
)
echo [build_msvc] MSVC architecture: %MSVC_ARCH%
call "C:\Program Files (x86)\Microsoft Visual Studio\2022\BuildTools\VC\Auxiliary\Build\vcvarsall.bat" %MSVC_ARCH% >nul
set CC=cl
set CXX=cl
set "PATH=%PATH:C:\TDM-GCC-64\bin;=%"
set "PATH=%PATH:C:\Program Files\Git\mingw64\bin;=%"
set "PATH=C:\Program Files (x86)\Microsoft Visual Studio\2022\BuildTools\Common7\IDE\CommonExtensions\Microsoft\CMake\CMake\bin;%PATH%"
set "PATH=C:\Program Files (x86)\Microsoft Visual Studio\2022\BuildTools\Common7\IDE\CommonExtensions\Microsoft\CMake\Ninja;%PATH%"

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
