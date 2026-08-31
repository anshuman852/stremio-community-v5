$packageName = 'stremio-desktop-v5'
$toolsDir    = Split-Path $MyInvocation.MyCommand.Definition

$packageArgs = @{
  packageName    = $packageName
  fileType       = 'exe'
  silentArgs     = '/S'
  validExitCodes = @(0)
}



if ([Environment]::Is64BitOperatingSystem) {
    $packageArgs['url']          = 'https://github.com/anshuman852/stremio-community-v5/releases/download/5.0.0-beta.29/Stremio.5.0.29-x64.exe'
    $packageArgs['checksum']     = '80d134b27dfee6f4540d107e865dfff8140781e5030c1f5daef33ede24788b3b'
    $packageArgs['checksumType'] = 'sha256'
} else {
    $packageArgs['url']          = 'https://github.com/anshuman852/stremio-community-v5/releases/download/5.0.0-beta.29/Stremio.5.0.29-x86.exe'
    $packageArgs['checksum']     = '912ced20341e767451ac356d239ebbc762021633222f02cf92d53e63ea7b37aa'
    $packageArgs['checksumType'] = 'sha256'
}

Install-ChocolateyPackage @packageArgs
