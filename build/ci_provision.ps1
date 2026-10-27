# Builds the gitignored, machine-local pieces the deploy script requires:
#   1) utils/windows/server.js            (Stremio server bundle)
#   2) deps/libmpv/x86_64/libmpv-2.dll    (extracted from the submodule .rar)
#   3) utils/windows/WebviewRuntime/<arch>/EdgeWebView   (portable WebView2 runtime)
#   4) deps/discord-rpc/{win64,win32}-static  (built from source)
#
# Results are cached by the workflow; on a cache hit each section is skipped.
# When the x86 WebView runtime cannot be provisioned, WEBVIEW_X86_OK=0 is
# written so later steps skip the x86 portable archive instead of failing.
$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot

function Write-GhEnv([string]$line) {
    Add-Content -Path $env:GITHUB_ENV -Value $line
}

function Try-Download([string]$url, [string]$outFile) {
    try {
        Invoke-WebRequest -Uri $url -OutFile $outFile -ErrorAction Stop
        return $true
    } catch {
        Write-Host "download failed: $url -> $($_.Exception.Message)"
        if (Test-Path $outFile) { Remove-Item $outFile -Force -ErrorAction SilentlyContinue }
        return $false
    }
}

$script:X64_MACHINE = 0x8664
$script:X86_MACHINE = 0x014C

# Reads the PE header machine field of an exe: 0x8664 = x64, 0x014C = x86.
function Get-PeMachine([string]$exePath) {
    if (-not (Test-Path $exePath)) { return -1 }
    $head = [IO.File]::ReadAllBytes($exePath)
    if ($head.Length -lt 0x40) { return -1 }
    $peOff = [BitConverter]::ToInt32($head, 0x3C)
    if ($peOff -lt 0x20 -or ($peOff + 2) -gt $head.Length) { return -1 }
    return [BitConverter]::ToUInt16($head, $peOff + 4)
}

function Test-WebViewDir([string]$dir, [int]$machine) {
    $exe = Join-Path $dir 'msedgewebview2.exe'
    if (-not (Test-Path $exe)) { return $false }
    return (Get-PeMachine $exe) -eq $machine
}

# Copies the newest system Evergreen WebView2 runtime directory matching arch.
function Harvest-SystemWebView([string]$targetDir, [int]$machine) {
    New-Item -ItemType Directory -Force -Path $targetDir | Out-Null
    $appRoot = 'C:\Program Files (x86)\Microsoft\EdgeWebView\Application'
    $matching = Get-ChildItem $appRoot -Directory -ErrorAction SilentlyContinue |
             Where-Object { $_.Name -match '^\d+(\.\d+){1,3}$' -and (Test-WebViewDir $_.FullName $machine) }
    if ($matching) {
        $newest = $matching | ForEach-Object { @{ dir = $_; ver = [version]$_.Name } } |
                  Sort-Object -Property ver | Select-Object -Last 1
        Copy-Item -Path "$($newest.dir.FullName)\*" -Destination $targetDir -Recurse -Force
        Write-Host "harvested $($newest.dir.Name) (PE machine=$machine) from system Evergreen installation"
        return $true
    }
    return $false
}

# ---------------- 1) server.js ----------------
$serverJs = Join-Path $root 'utils/windows/server.js'
if (-not (Test-Path $serverJs) -or (Get-Item $serverJs -ErrorAction SilentlyContinue).Length -lt 100000) {
    Write-Host "Provisioning server.js ($env:SERVER_VERSION)..."
    Remove-Item $serverJs -Force -ErrorAction SilentlyContinue
    # manifest versions may be pinned with or without the leading "v"; try both
    $svVariants = @([string]$env:SERVER_VERSION)
    if ($svVariants[0] -match '^v') {
        $svVariants += $svVariants[0].TrimStart('v')
    } else {
        $svVariants += ("v" + $svVariants[0])
    }
    $urls = @()
    foreach ($sv in ($svVariants | Select-Object -Unique)) {
        $urls += "https://dl.strem.io/server/$sv/desktop/server.js"
        $urls += "https://s3-eu-west-1.amazonaws.com/stremio-artifacts/four/$sv/server.js"
    }
    $downloaded = $false
    foreach ($url in $urls) {
        if (Try-Download $url $serverJs) { $downloaded = $true; break }
    }
    if (-not $downloaded) { throw "server.js could not be downloaded" }
    $len = (Get-Item $serverJs).Length
    if ($len -lt 100000) { throw "server.js downloaded but looks invalid ($len bytes)" }
    Write-Host "server.js ready ($len bytes)"
} else {
    Write-Host "server.js already provisioned"
}

# ---------------- 2) libmpv dlls ----------------
$x64dll = Join-Path $root 'deps/libmpv/x86_64/libmpv-2.dll'
if (-not (Test-Path $x64dll)) {
    Write-Host "Extracting libmpv-2.dll (x64) from the submodule archive..."
    $rar = Join-Path $root 'deps/libmpv/x86_64/libmpv-2.dll.rar'
    if (-not (Test-Path $rar)) { throw "deps/libmpv/x86_64/libmpv-2.dll.rar missing - is the submodule checked out?" }
    & 'C:\Program Files\7-Zip\7z.exe' x $rar "-o$(Join-Path $root 'deps/libmpv/x86_64')" -y | Out-Null
    if ($LASTEXITCODE -ne 0 -or -not (Test-Path $x64dll)) { throw "failed to extract $rar" }
}
if (-not (Test-Path (Join-Path $root 'deps/libmpv/i686/libmpv-2.dll'))) {
    throw "deps/libmpv/i686/libmpv-2.dll missing - is the submodule checked out?"
}
Write-Host "libmpv dlls ready"

# ---------------- 3) WebView2 runtime (portable archives) ----------------
function Provision-WebView([string]$targetDir, [string]$fwlink, [string]$label, [int]$machine) {
    if (Test-WebViewDir $targetDir $machine) { Write-Host "$label already provisioned"; return $true }
    if (Harvest-SystemWebView $targetDir $machine) { return $true }
    if (-not $fwlink) { return $false }
    Write-Host "Installing standalone Evergreen runtime ($label)..."
    $dl = Join-Path $env:RUNNER_TEMP "webview-$label.exe"
    if (-not (Try-Download $fwlink $dl)) { return $false }
    $tmpDir = Join-Path $env:RUNNER_TEMP "webview-$label"
    Remove-Item $tmpDir -Recurse -Force -ErrorAction SilentlyContinue
    Start-Process -FilePath $dl -ArgumentList "/silent","/dir=$tmpDir" -Wait -ErrorAction SilentlyContinue
    if (Test-WebViewDir $tmpDir $machine) {
        Copy-Item "$tmpDir\*" -Destination $targetDir -Recurse -Force
        Write-Host "$label provisioned (custom directory install)"
        return $true
    }
    # Fallback: system-wide silent install, then arch-validated harvest
    Start-Process -FilePath $dl -ArgumentList "/silent" -Wait -ErrorAction SilentlyContinue
    if (Harvest-SystemWebView $targetDir $machine) { return $true }
    return $false
}

$x64Webview = Join-Path $root 'utils/windows/WebviewRuntime/x64/EdgeWebView'
if (Provision-WebView $x64Webview 'https://go.microsoft.com/fwlink/?linkid=2124701' 'x64' $script:X64_MACHINE) {
    Write-Host "WebView2 portable runtime (x64) ready"
} else {
    throw "Failed to provision the x64 WebView2 runtime (needed for the portable archive)"
}

$x86Webview = Join-Path $root 'utils/windows/WebviewRuntime/x86/EdgeWebView'
if (Provision-WebView $x86Webview 'https://go.microsoft.com/fwlink/?linkid=2099617' 'x86' $script:X86_MACHINE) {
    Write-Host "WebView2 portable runtime (x86) ready"
} else {
    Write-Warning "X86 WebView2 runtime could not be provisioned; the x86 portable archive will be skipped."
    Write-GhEnv "WEBVIEW_X86_OK=0"
}

# ---------------- 4) discord-rpc (static libs) ----------------
$rpcBase = Join-Path $root 'deps/discord-rpc'
if (-not (Test-Path "$rpcBase/win64-static/lib/discord-rpc.lib")) {
    Write-Host "Building discord-rpc (win64-static, win32-static) from source..."
    $src = Join-Path $env:RUNNER_TEMP 'discord-rpc-src'
    if (Test-Path $src) { Remove-Item $src -Recurse -Force }
    git clone --depth 1 --branch v3.4.0 https://github.com/discord/discord-rpc.git $src
    if ($LASTEXITCODE -ne 0) { throw 'failed to clone discord/discord-rpc' }
    foreach ($spec in @(
        @{ Dir = 'win64-static'; Arch = 'x64' },
        @{ Dir = 'win32-static'; Arch = 'Win32' }
    )) {
        $cfg = Join-Path $env:RUNNER_TEMP ("rpc-build-" + $spec.Arch)
        cmake -S $src -B $cfg -G "Visual Studio 17 2022" -A $spec.Arch `
              -DCMAKE_MSVC_RUNTIME_LIBRARY=MultiThreaded -DDISCORD_BUILD_EXAMPLES=OFF
        if ($LASTEXITCODE -ne 0) { throw "discord-rpc configure failed ($($spec.Arch))" }
        cmake --build $cfg --config Release --target discord-rpc
        if ($LASTEXITCODE -ne 0) { throw "discord-rpc build failed ($($spec.Arch))" }
        New-Item -ItemType Directory -Force -Path "$rpcBase/$($spec.Dir)/lib" | Out-Null
        Copy-Item "$cfg/Release/discord-rpc.lib" "$rpcBase/$($spec.Dir)/lib/discord-rpc.lib" -Force
        New-Item -ItemType Directory -Force -Path "$rpcBase/$($spec.Dir)/include" | Out-Null
        Copy-Item "$src/include/*" "$rpcBase/$($spec.Dir)/include/" -Force -Recurse
    }
    if (-not (Test-Path "$rpcBase/win64-static/include/discord_rpc.h")) {
        Write-Warning "discord_rpc.h was not found under $src/include; headers in $(Join-Path $src 'include'): $(Get-ChildItem (Join-Path $src 'include') -Name -ErrorAction SilentlyContinue)"
    }
} else {
    Write-Host "discord-rpc libs already provisioned"
}

Write-Host "Provisioning complete."
