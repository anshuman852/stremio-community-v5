$packageName = 'stremio-desktop-v5'
$toolsDir    = Split-Path $MyInvocation.MyCommand.Definition

$packageArgs = @{
  packageName    = $packageName
  fileType       = 'exe'
  silentArgs     = '/S'
  validExitCodes = @(0)
}



if ([Environment]::Is64BitOperatingSystem) {
    $packageArgs['url']          = 'https://github.com/anshuman852/stremio-community-v5/releases/download/5.0.0-beta.26/Stremio.5.0.26-x64.exe'
    $packageArgs['checksum']     = '780030003f0b9ecf403c5f1b3307d8dc0ceed0c02622d985d3535873e646dbb7'
    $packageArgs['checksumType'] = 'sha256'
} else {
    $packageArgs['url']          = 'https://github.com/anshuman852/stremio-community-v5/releases/download/5.0.0-beta.26/Stremio.5.0.26-x86.exe'
    $packageArgs['checksum']     = 'c2e15006cfcf0d4da384b9c8ad27c234bebcecaea34501b9016759ea9f5bb960'
    $packageArgs['checksumType'] = 'sha256'
}

Install-ChocolateyPackage @packageArgs
