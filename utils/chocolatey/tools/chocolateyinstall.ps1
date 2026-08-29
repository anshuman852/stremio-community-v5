$packageName = 'stremio-desktop-v5'
$toolsDir    = Split-Path $MyInvocation.MyCommand.Definition

$packageArgs = @{
  packageName    = $packageName
  fileType       = 'exe'
  silentArgs     = '/S'
  validExitCodes = @(0)
}



if ([Environment]::Is64BitOperatingSystem) {
    $packageArgs['url']          = 'https://github.com/anshuman852/stremio-community-v5/releases/download/5.0.0-beta.27/Stremio.5.0.27-x64.exe'
    $packageArgs['checksum']     = '556f4947d1de16a3e9bdceff7c99eb774bf4b67e46b35612168c6fb4702403a5'
    $packageArgs['checksumType'] = 'sha256'
} else {
    $packageArgs['url']          = 'https://github.com/anshuman852/stremio-community-v5/releases/download/5.0.0-beta.27/Stremio.5.0.27-x86.exe'
    $packageArgs['checksum']     = 'b83d48bcc2b321577ed1b4495d9c1abdae815237c11536d241df2a58e509bbea'
    $packageArgs['checksumType'] = 'sha256'
}

Install-ChocolateyPackage @packageArgs
