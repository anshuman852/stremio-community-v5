$packageName = 'stremio-desktop-v5'
$toolsDir    = Split-Path $MyInvocation.MyCommand.Definition

$packageArgs = @{
  packageName    = $packageName
  fileType       = 'exe'
  silentArgs     = '/S'
  validExitCodes = @(0)
}



if ([Environment]::Is64BitOperatingSystem) {
    $packageArgs['url']          = 'https://github.com/anshuman852/stremio-community-v5/releases/download/5.0.0-beta.36/Stremio.5.0.36-x64.exe'
    $packageArgs['checksum']     = 'd7b322fcf8747da887626e7e803dd8b3b9f2d0cf19e2458ac8d9d492613bb8bf'
    $packageArgs['checksumType'] = 'sha256'
} else {
    $packageArgs['url']          = 'https://github.com/anshuman852/stremio-community-v5/releases/download/5.0.0-beta.36/Stremio.5.0.36-x86.exe'
    $packageArgs['checksum']     = '9f5e1581b7d1fb2acac25070469ec28348fb6686ef5239639604fa92e27f2552'
    $packageArgs['checksumType'] = 'sha256'
}

Install-ChocolateyPackage @packageArgs
