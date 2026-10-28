$packageName = 'stremio-desktop-v5'
$toolsDir    = Split-Path $MyInvocation.MyCommand.Definition

$packageArgs = @{
  packageName    = $packageName
  fileType       = 'exe'
  silentArgs     = '/S'
  validExitCodes = @(0)
}



if ([Environment]::Is64BitOperatingSystem) {
    $packageArgs['url']          = 'https://github.com/anshuman852/stremio-community-v5/releases/download/5.0.0-beta.34/Stremio.5.0.34-x64.exe'
    $packageArgs['checksum']     = '68797b7b7e88f6e69d076aee70df1c77519cf16753909591f22af1af28ccd54b'
    $packageArgs['checksumType'] = 'sha256'
} else {
    $packageArgs['url']          = 'https://github.com/anshuman852/stremio-community-v5/releases/download/5.0.0-beta.34/Stremio.5.0.34-x86.exe'
    $packageArgs['checksum']     = 'b273b2d65e2cbc53f9deae150592ba967363231cd080c9dff1962984a109ecb3'
    $packageArgs['checksumType'] = 'sha256'
}

Install-ChocolateyPackage @packageArgs
