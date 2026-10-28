# Builds the gitignored, machine-local pieces the deploy script requires:
#   1) utils/windows/server.js            (Stremio server bundle)
#   2) deps/libmpv/x86_64/libmpv-2.dll    (extracted from the submodule .rar)
#   3) utils/windows/WebviewRuntime/<arch>/EdgeWebView   (portable WebView2 runtime)
#   4) deps/discord-rpc/{win64,win32}-static  (built from source)
#
# Results are cached by the workflow; on a cache hit each section is skipped.
# -Arch limits provisioning to one architecture (the CI build matrix runs one
# leg per arch); 'none' provisions only server.js (the release job, which
# needs its checksum but builds nothing). When the x86 WebView runtime cannot
# be provisioned, WEBVIEW_X86_OK=0 is written so later steps skip the x86
# portable archive instead of failing.
param(
    [ValidateSet('x64', 'x86', 'all', 'none')]
    [string]$Arch = 'all',
    # Installer-only legs don't need the portable WebView2 runtimes.
    [switch]$SkipWebView
)
$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
$wantX64 = $Arch -in @('x64', 'all')
$wantX86 = $Arch -in @('x86', 'all')

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
if ($wantX64 -and -not (Test-Path $x64dll)) {
    Write-Host "Extracting libmpv-2.dll (x64) from the submodule archive..."
    $rar = Join-Path $root 'deps/libmpv/x86_64/libmpv-2.dll.rar'
    if (-not (Test-Path $rar)) { throw "deps/libmpv/x86_64/libmpv-2.dll.rar missing - is the submodule checked out?" }
    & 'C:\Program Files\7-Zip\7z.exe' x $rar "-o$(Join-Path $root 'deps/libmpv/x86_64')" -y | Out-Null
    if ($LASTEXITCODE -ne 0 -or -not (Test-Path $x64dll)) { throw "failed to extract $rar" }
}
if ($wantX86 -and -not (Test-Path (Join-Path $root 'deps/libmpv/i686/libmpv-2.dll'))) {
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

# Fetches the x86 runtime without executing any installer. The Edge content
# delivery API (the same one the updater uses) hands out the offline
# MicrosoftEdge_X86_<ver>.exe package, which is a 7z holding MSEDGE.7z, which in
# turn holds Chrome-bin\<ver>\msedgewebview2.exe and the rest of the runtime.
# (The old api.edge.microsoft.com endpoint does not exist - it never resolved.)
function Provision-WebViewX86FromApi([string]$targetDir) {
    try {
        $sevenZip = 'C:\Program Files\7-Zip\7z.exe'
        if (-not (Test-Path $sevenZip)) { Write-Warning '7-Zip not found; cannot unpack the x86 runtime'; return $false }
        $name = 'msedgewebview-stable-win-x86'
        $api  = 'https://msedge.api.cdp.microsoft.com/api'
        $body = '{"targetingAttributes":{"Channel":"stable","AppAp":""}}'
        $ProgressPreference = 'SilentlyContinue'

        # Transient network failures happen on runners; retry the metadata calls.
        $info = $null
        foreach ($attempt in 1..3) {
            try {
                $ver = (Invoke-RestMethod -Method Post -Uri "$api/v2/contents/Browser/namespaces/Default/names/$name/versions/latest?action=select" `
                        -ContentType 'application/json' -Body $body -TimeoutSec 120).ContentId.Version
                Write-Host "Latest x86 WebView2 runtime: $ver"
                $files = Invoke-RestMethod -Method Post -Uri "$api/v1.1/contents/Browser/namespaces/Default/names/$name/versions/$ver/files?action=GenerateDownloadInfo" `
                         -ContentType 'application/json' -Body $body -TimeoutSec 120
                $info = @($files) | Where-Object { $_.FileId -match '\.exe$' } | Select-Object -First 1
                if ($info) { break }
            } catch {
                Write-Host "metadata query attempt $attempt failed: $($_.Exception.Message)"
                Start-Sleep -Seconds (5 * $attempt)
            }
        }
        if (-not $info) { Write-Warning 'could not resolve an x86 WebView2 runtime package from the Edge content API'; return $false }

        $pkg = Join-Path $env:RUNNER_TEMP 'webview-x86-pkg.exe'
        Write-Host "Downloading $($info.FileId) ($([math]::Round($info.SizeInBytes / 1MB)) MB)..."
        if (-not (Try-Download $info.Url $pkg)) { return $false }
        if ($info.Hashes.Sha256) {
            $expected = [BitConverter]::ToString([Convert]::FromBase64String($info.Hashes.Sha256)).Replace('-', '')
            $actual = (Get-FileHash $pkg -Algorithm SHA256).Hash
            if ($actual -ne $expected) { Write-Warning "x86 runtime package SHA256 mismatch ($actual != $expected)"; return $false }
        }

        $stage1 = Join-Path $env:RUNNER_TEMP 'webview-x86-stage1'
        $stage2 = Join-Path $env:RUNNER_TEMP 'webview-x86-stage2'
        Remove-Item $stage1, $stage2 -Recurse -Force -ErrorAction SilentlyContinue
        & $sevenZip x $pkg "-o$stage1" -y | Out-Null
        if ($LASTEXITCODE -ne 0) { Write-Warning '7z could not unpack the x86 runtime package'; return $false }
        $inner = Get-ChildItem $stage1 -Recurse -Filter '*.7z' | Select-Object -First 1
        if (-not $inner) { Write-Warning 'x86 runtime package did not contain an inner .7z'; return $false }
        & $sevenZip x $inner.FullName "-o$stage2" -y | Out-Null
        if ($LASTEXITCODE -ne 0) { Write-Warning '7z could not unpack the inner x86 runtime archive'; return $false }

        $exe = Get-ChildItem $stage2 -Recurse -Filter 'msedgewebview2.exe' | Select-Object -First 1
        if (-not $exe) { Write-Warning 'unpacked x86 runtime does not contain msedgewebview2.exe'; return $false }
        if ((Get-PeMachine $exe.FullName) -ne $script:X86_MACHINE) {
            Write-Warning ("unpacked runtime has the wrong architecture (PE machine=0x{0:X})" -f (Get-PeMachine $exe.FullName))
            return $false
        }
        New-Item -ItemType Directory -Force -Path $targetDir | Out-Null
        Copy-Item "$((Split-Path -Parent $exe.FullName))\*" -Destination $targetDir -Recurse -Force
        Remove-Item $pkg, $stage1, $stage2 -Recurse -Force -ErrorAction SilentlyContinue
        return (Test-WebViewDir $targetDir $script:X86_MACHINE)
    } catch {
        Write-Warning "x86 runtime provisioning via the Edge content API failed: $($_.Exception.Message)"
        return $false
    }
}

if ($wantX64 -and -not $SkipWebView) {
    $x64Webview = Join-Path $root 'utils/windows/WebviewRuntime/x64/EdgeWebView'
    if (Provision-WebView $x64Webview 'https://go.microsoft.com/fwlink/?linkid=2124701' 'x64' $script:X64_MACHINE) {
        Write-Host "WebView2 portable runtime (x64) ready"
    } else {
        throw "Failed to provision the x64 WebView2 runtime (needed for the portable archive)"
    }
}

if ($wantX86 -and -not $SkipWebView) {
    $x86Webview = Join-Path $root 'utils/windows/WebviewRuntime/x86/EdgeWebView'
    if ((Test-WebViewDir $x86Webview $script:X86_MACHINE) -or (Harvest-SystemWebView $x86Webview $script:X86_MACHINE)) {
        Write-Host "WebView2 portable runtime (x86) ready"
    } elseif (Provision-WebViewX86FromApi $x86Webview) {
        Write-Host "WebView2 portable runtime (x86) ready"
    } else {
        Write-Warning "X86 WebView2 runtime could not be provisioned; the x86 portable archive will be skipped."
        Write-GhEnv "WEBVIEW_X86_OK=0"
    }
}

# ---------------- 4) discord-rpc (static libs) ----------------
$rpcBase = Join-Path $root 'deps/discord-rpc'
$rpcSpecs = @()
if ($wantX64) { $rpcSpecs += @{ Dir = 'win64-static'; Arch = 'x64' } }
if ($wantX86) { $rpcSpecs += @{ Dir = 'win32-static'; Arch = 'Win32' } }
$rpcSpecs = @($rpcSpecs | Where-Object { -not (Test-Path "$rpcBase/$($_.Dir)/lib/discord-rpc.lib") })
if ($rpcSpecs.Count -gt 0) {
    Write-Host "Building discord-rpc ($(($rpcSpecs | ForEach-Object { $_.Dir }) -join ', ')) from source..."
    $src = Join-Path $env:RUNNER_TEMP 'discord-rpc-src'
    # --recursive is required: the C sources include rapidjson headers that
    # live in the thirdparty/rapidjson submodule. Retried because runners
    # occasionally hit transient DNS/connection failures.
    $cloned = $false
    foreach ($attempt in 1..3) {
        if (Test-Path $src) { Remove-Item $src -Recurse -Force }
        git clone --depth 1 --branch v3.4.0 --recursive https://github.com/discord/discord-rpc.git $src
        if ($LASTEXITCODE -eq 0) { $cloned = $true; break }
        Write-Host "git clone attempt $attempt failed; retrying..."
        Start-Sleep -Seconds (5 * $attempt)
    }
    if (-not $cloned) { throw 'failed to clone discord/discord-rpc' }
    foreach ($spec in $rpcSpecs) {
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
    if (-not (Test-Path "$rpcBase/$($rpcSpecs[0].Dir)/include/discord_rpc.h")) {
        Write-Warning "discord_rpc.h was not found under $src/include; headers in $(Join-Path $src 'include'): $(Get-ChildItem (Join-Path $src 'include') -Name -ErrorAction SilentlyContinue)"
    }
} else {
    Write-Host "discord-rpc libs already provisioned"
}

Write-Host "Provisioning complete."
