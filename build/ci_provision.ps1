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

# Runs an installer with a hard timeout so a wedged setup can't hang the job.
function Run-Installer([string]$exe, [string[]]$installerArgs, [int]$timeoutSec = 300) {
    $p = Start-Process -FilePath $exe -ArgumentList $installerArgs -PassThru -ErrorAction SilentlyContinue
    if (-not $p) { return }
    if (-not $p.WaitForExit($timeoutSec * 1000)) {
        Write-Host "installer still running after ${timeoutSec}s; killing it: $exe"
        Stop-Process -Id $p.Id -Force -ErrorAction SilentlyContinue
    }
}

function Try-Download([string]$url, [string]$outFile) {
    try {
        $ProgressPreference = 'SilentlyContinue'  # the progress bar makes big downloads crawl on PS 5.1
        Invoke-WebRequest -Uri $url -OutFile $outFile -TimeoutSec 600 -ErrorAction Stop
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
# The Evergreen standalone installers cannot be automated headlessly on this
# image (with /silent they still pop dialogs and wedge until killed), so:
#   x64: harvest the runtime already present on the runner, fall back to the
#        fwlink standalone installer as the last resort.
#   x86: harvest the runner, then pull the runtime package straight from the
#        Edge Update API and extract it via a `msiexec /a` administrative
#        image - no installer is ever executed, so nothing can hang.
function Provision-WebView([string]$targetDir, [string]$fwlink, [string]$label, [int]$machine) {
    if (Test-WebViewDir $targetDir $machine) { Write-Host "$label already provisioned"; return $true }
    if (Harvest-SystemWebView $targetDir $machine) { return $true }
    if (-not $fwlink) { return $false }
    Write-Host "Installing standalone Evergreen runtime ($label)..."
    $dl = Join-Path $env:RUNNER_TEMP "webview-$label.exe"
    if (-not (Try-Download $fwlink $dl)) { return $false }
    $tmpDir = Join-Path $env:RUNNER_TEMP "webview-$label"
    Remove-Item $tmpDir -Recurse -Force -ErrorAction SilentlyContinue
    Run-Installer $dl @("/silent","/dir=$tmpDir")
    if (Test-WebViewDir $tmpDir $machine) {
        Copy-Item "$tmpDir\*" -Destination $targetDir -Recurse -Force
        Write-Host "$label provisioned (custom directory install)"
        return $true
    }
    # Fallback: system-wide silent install, then arch-validated harvest
    Run-Installer $dl @("/silent")
    if (Harvest-SystemWebView $targetDir $machine) { return $true }
    return $false
}

# Fetches the x86 runtime without executing any installer: query the Edge
# Update API for the latest Evergreen release, download the .cab, expand it
# and (when it wraps an MSI) extract the payload as an administrative image.
function Provision-WebViewX86FromApi([string]$targetDir) {
    try {
        $endpoints = @(
            'https://api.edge.microsoft.com/webview2runtime/rest/evergreen-releases/latest?os=win64&arch=x86'
            'https://api.edge.microsoft.com/webview2runtime/rest/evergreen-releases/latest'
        )
        $cabUrl = $null
        foreach ($ep in $endpoints) {
            try {
                Write-Host "Querying $ep"
                $json = (Invoke-WebRequest -Uri $ep -TimeoutSec 120 -ErrorAction Stop).Content
                $links = [regex]::Matches([string]$json, 'https://[^\s"\\<>]+?\.cab') |
                         ForEach-Object { $_.Value } | Select-Object -Unique
                if ($links) {
                    # The x86 package name carries the arch tag; prefer it.
                    $cabUrl = ($links | Where-Object { $_ -match '(?i)x86' } | Select-Object -First 1)
                    if (-not $cabUrl) { $cabUrl = $links | Select-Object -First 1 }
                }
            } catch {
                Write-Host "metadata query failed: $($_.Exception.Message)"
            }
            if ($cabUrl) { break }
        }
        if (-not $cabUrl) { Write-Warning 'no .cab runtime link found in the Edge Update API metadata'; return $false }
        Write-Host "Downloading x86 runtime cabinet: $cabUrl"
        $cab = Join-Path $env:RUNNER_TEMP 'webview-x86.cab'
        if (-not (Try-Download $cabUrl $cab)) { return $false }
        $cabDir = Join-Path $env:RUNNER_TEMP 'webview-x86-cab'
        Remove-Item $cabDir -Recurse -Force -ErrorAction SilentlyContinue
        New-Item -ItemType Directory -Force -Path $cabDir | Out-Null
        & expand.exe -F:* $cab $cabDir | Out-Null
        if ($LASTEXITCODE -ne 0) { Write-Warning 'expand.exe could not extract the runtime cabinet'; return $false }
        $exe = Get-ChildItem $cabDir -Recurse -Filter 'msedgewebview2.exe' -ErrorAction SilentlyContinue | Select-Object -First 1
        if (-not $exe) {
            $msi = Get-ChildItem $cabDir -Recurse -Filter '*.msi' -ErrorAction SilentlyContinue | Select-Object -First 1
            if (-not $msi) { Write-Warning 'runtime cabinet contained neither loose files nor an MSI'; return $false }
            Write-Host "Extracting $($msi.Name) as an administrative image..."
            $imgDir = Join-Path $env:RUNNER_TEMP 'webview-x86-image'
            Remove-Item $imgDir -Recurse -Force -ErrorAction SilentlyContinue
            New-Item -ItemType Directory -Force -Path $imgDir | Out-Null
            $p = Start-Process msiexec.exe -ArgumentList "/a", "`"$($msi.FullName)`"", "/qn", "TARGETDIR=$imgDir" -Wait -PassThru
            if ($p.ExitCode -notin @(0, 3010)) { Write-Warning "msiexec /a extraction failed (exit $($p.ExitCode))"; return $false }
            $exe = Get-ChildItem $imgDir -Recurse -Filter 'msedgewebview2.exe' -ErrorAction SilentlyContinue | Select-Object -First 1
            if (-not $exe) { Write-Warning 'administrative image did not contain msedgewebview2.exe'; return $false }
        }
        if ((Get-PeMachine $exe.FullName) -ne $script:X86_MACHINE) {
            Write-Warning ("extracted runtime has the wrong architecture (PE machine=0x{0:X})" -f (Get-PeMachine $exe.FullName))
            return $false
        }
        Copy-Item "$((Split-Path -Parent $exe.FullName))\*" -Destination $targetDir -Recurse -Force
        return (Test-WebViewDir $targetDir $script:X86_MACHINE)
    } catch {
        Write-Warning "x86 runtime provisioning via the Edge Update API failed: $($_.Exception.Message)"
        return $false
    }
}

$x64Webview = Join-Path $root 'utils/windows/WebviewRuntime/x64/EdgeWebView'
if (Provision-WebView $x64Webview 'https://go.microsoft.com/fwlink/?linkid=2124701' 'x64' $script:X64_MACHINE) {
    Write-Host "WebView2 portable runtime (x64) ready"
} else {
    throw "Failed to provision the x64 WebView2 runtime (needed for the portable archive)"
}

$x86Webview = Join-Path $root 'utils/windows/WebviewRuntime/x86/EdgeWebView'
if ((Test-WebViewDir $x86Webview $script:X86_MACHINE) -or (Harvest-SystemWebView $x86Webview $script:X86_MACHINE)) {
    Write-Host "WebView2 portable runtime (x86) ready"
} elseif (Provision-WebViewX86FromApi $x86Webview) {
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
    # --recursive is required: the C sources include rapidjson headers that
    # live in the thirdparty/rapidjson submodule.
    git clone --depth 1 --branch v3.4.0 --recursive https://github.com/discord/discord-rpc.git $src
    if ($LASTEXITCODE -ne 0) { throw 'failed to clone discord/discord-rpc' }
    foreach ($spec in @(
        @{ Dir = 'win64-static'; Arch = 'x64' },
        @{ Dir = 'win32-static'; Arch = 'Win32' }
    )) {
        $cfg = Join-Path $env:RUNNER_TEMP ("rpc-build-" + $spec.Arch)
        # No explicit -G: let CMake pick whatever Visual Studio the current
        # runner image ships (generator numbering changes between images);
        # -A still selects the architecture. CMAKE_POLICY_VERSION_MINIMUM
        # keeps CMake 4+ from hard-refusing this pre-3.5 project.
        cmake -S $src -B $cfg -A $spec.Arch `
              "-DCMAKE_POLICY_VERSION_MINIMUM=3.5" `
              "-DCLANG_FORMAT_CMD=CLANG_FORMAT_CMD-NOTFOUND" `
              "-DCMAKE_POLICY_DEFAULT_CMP0091=NEW" `
              -DCMAKE_MSVC_RUNTIME_LIBRARY=MultiThreaded -DDISCORD_BUILD_EXAMPLES=OFF
        if ($LASTEXITCODE -ne 0) { throw "discord-rpc configure failed ($($spec.Arch))" }
        cmake --build $cfg --config Release --target discord-rpc
        if ($LASTEXITCODE -ne 0) { throw "discord-rpc build failed ($($spec.Arch))" }
        New-Item -ItemType Directory -Force -Path "$rpcBase/$($spec.Dir)/lib" | Out-Null
        # The lib lands in <build>/src/Release; older layouts used <build>/Release.
        $rpcLib = Get-ChildItem $cfg -Recurse -Filter discord-rpc.lib | Select-Object -First 1
        if (-not $rpcLib) { throw "discord-rpc.lib not found under $cfg ($($spec.Arch))" }
        Copy-Item $rpcLib.FullName "$rpcBase/$($spec.Dir)/lib/discord-rpc.lib" -Force
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
