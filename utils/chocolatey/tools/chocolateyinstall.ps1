$packageName = 'stremio-desktop-v5'
$toolsDir    = Split-Path $MyInvocation.MyCommand.Definition

$packageArgs = @{
  packageName    = $packageName
  fileType       = 'exe'
  silentArgs     = '/S'
  validExitCodes = @(0)
}



if ([Environment]::Is64BitOperatingSystem) {
    $packageArgs['url']          = 'https://github.com/anshuman852/stremio-community-v5/releases/download/5.0.0-beta.33/Stremio.5.0.33-x64.exe'
    $packageArgs['checksum']     = '31fe2b61d06c499bdad2bfb881824177ee84387fcaa8bcf017caadbf42350363'
    $packageArgs['checksumType'] = 'sha256'
} else {
    $packageArgs['url']          = 'https://github.com/anshuman852/stremio-community-v5/releases/download/5.0.0-beta.33/Stremio.5.0.33-x86.exe'
    $packageArgs['checksum']     = '2353209fadac4291aacb834a3343003c2d96eb9b4c9f60a71df38ad0f98c5237'
    $packageArgs['checksumType'] = 'sha256'
}

Install-ChocolateyPackage @packageArgs
