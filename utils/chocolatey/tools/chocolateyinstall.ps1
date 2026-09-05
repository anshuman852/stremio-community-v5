$packageName = 'stremio-desktop-v5'
$toolsDir    = Split-Path $MyInvocation.MyCommand.Definition

$packageArgs = @{
  packageName    = $packageName
  fileType       = 'exe'
  silentArgs     = '/S'
  validExitCodes = @(0)
}



if ([Environment]::Is64BitOperatingSystem) {
    $packageArgs['url']          = 'https://github.com/anshuman852/stremio-community-v5/releases/download/5.0.0-beta.30/Stremio.5.0.30-x64.exe'
    $packageArgs['checksum']     = '6b632d3d8871d69bffddbfc5d2bd05df2a6764c028650b0862cbb67cbe4c5dd9'
    $packageArgs['checksumType'] = 'sha256'
} else {
    $packageArgs['url']          = 'https://github.com/anshuman852/stremio-community-v5/releases/download/5.0.0-beta.30/Stremio.5.0.30-x86.exe'
    $packageArgs['checksum']     = 'd7228894faa40e8418577b18f06578b6170037de1d7040bd09b4055fe2e534bf'
    $packageArgs['checksumType'] = 'sha256'
}

Install-ChocolateyPackage @packageArgs
