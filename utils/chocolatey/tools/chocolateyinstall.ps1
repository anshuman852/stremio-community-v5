$packageName = 'stremio-desktop-v5'
$toolsDir    = Split-Path $MyInvocation.MyCommand.Definition

$packageArgs = @{
  packageName    = $packageName
  fileType       = 'exe'
  silentArgs     = '/S'
  validExitCodes = @(0)
}



if ([Environment]::Is64BitOperatingSystem) {
    $packageArgs['url']          = 'https://github.com/anshuman852/stremio-community-v5/releases/download/5.0.0-beta.35/Stremio.5.0.35-x64.exe'
    $packageArgs['checksum']     = 'c8933b77e40f87023490c96b2f903a49e5b6f93cfe48aa140279e38460da31ad'
    $packageArgs['checksumType'] = 'sha256'
} else {
    $packageArgs['url']          = 'https://github.com/anshuman852/stremio-community-v5/releases/download/5.0.0-beta.35/Stremio.5.0.35-x86.exe'
    $packageArgs['checksum']     = '1628414424eff69c2bd5bb8c045f3623f0d1a5b92672e2565d1b673bc030801f'
    $packageArgs['checksumType'] = 'sha256'
}

Install-ChocolateyPackage @packageArgs
