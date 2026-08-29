$packageName = 'stremio-desktop-v5'
$toolsDir    = Split-Path $MyInvocation.MyCommand.Definition

$packageArgs = @{
  packageName    = $packageName
  fileType       = 'exe'
  silentArgs     = '/S'
  validExitCodes = @(0)
}



if ([Environment]::Is64BitOperatingSystem) {
    $packageArgs['url']          = 'https://github.com/anshuman852/stremio-community-v5/releases/download/5.0.0-beta.28/Stremio.5.0.28-x64.exe'
    $packageArgs['checksum']     = 'd12cb1e645dc78a767c6b075d1165887ba07e2958e8d5762c1c23aecff6199c1'
    $packageArgs['checksumType'] = 'sha256'
} else {
    $packageArgs['url']          = 'https://github.com/anshuman852/stremio-community-v5/releases/download/5.0.0-beta.28/Stremio.5.0.28-x86.exe'
    $packageArgs['checksum']     = 'a9263de14d554380fdddb42db5dc50cdb19bdb29850389b17cd79ad764f4091c'
    $packageArgs['checksumType'] = 'sha256'
}

Install-ChocolateyPackage @packageArgs
