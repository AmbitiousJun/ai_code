$ErrorActionPreference = 'Stop'
$root = Split-Path $PSScriptRoot
Set-Location -LiteralPath $root
$node = if ($env:GAMETRAIL_NODE) { $env:GAMETRAIL_NODE } else { (Get-Command node.exe).Source }
& $node -e "if(process.platform!=='win32'||process.arch!=='x64'||+process.versions.node.split('.')[0]<24) process.exit(1)"
if ($LASTEXITCODE) { throw 'Windows x64 Node 24+ is required.' }
$env:PLAYWRIGHT_BROWSERS_PATH = '0'
& $node scripts/install-browsers.js --verify
if ($LASTEXITCODE) { throw 'Run npm run browsers first.' }
$build = Join-Path $root ('.runtime\build-' + [Guid]::NewGuid().ToString('N'))
$stage = Join-Path $build 'payload'
New-Item -ItemType Directory -Path $stage -Force | Out-Null
try {
    Copy-Item -LiteralPath $node -Destination (Join-Path $stage 'node.exe')
    $audioDir = New-Item -ItemType Directory -Path (Join-Path $stage 'native/windows-webkit') -Force
    Copy-Item -LiteralPath 'native/windows-webkit/audio-mute.exe' -Destination $audioDir.FullName
    foreach ($item in 'src','ui','package.json','package-lock.json','node_modules') {
        Copy-Item -LiteralPath $item -Destination $stage -Recurse -Force
    }
    Add-Type -AssemblyName System.IO.Compression.FileSystem
    $zip = Join-Path $build 'runtime.zip'
    [IO.Compression.ZipFile]::CreateFromDirectory($stage,$zip)
    $version = [version]((Get-Content -LiteralPath package.json -Raw | ConvertFrom-Json).version)
    $exe = Join-Path $build "GameTrail-$version.exe"
    $metadata = Join-Path $build 'Version.cs'
    @"
using System.Reflection;
[assembly: AssemblyProduct("GameTrail")]
[assembly: AssemblyTitle("GameTrail")]
[assembly: AssemblyVersion("$version.0")]
[assembly: AssemblyFileVersion("$version.0")]
[assembly: AssemblyInformationalVersion("$version")]
"@ | Set-Content -LiteralPath $metadata -Encoding UTF8
    $compiler = Join-Path $env:WINDIR 'Microsoft.NET\Framework64\v4.0.30319\csc.exe'
    & $compiler /nologo /target:winexe /platform:x64 /utf8output /codepage:65001 /win32icon:native/GameTrail.ico /r:System.IO.Compression.dll /r:System.IO.Compression.FileSystem.dll "/resource:$zip,runtime.zip" "/out:$exe" $metadata (Join-Path $root 'native\launcher-windows.cs')
    if ($LASTEXITCODE) { throw 'Launcher compilation failed.' }
    New-Item -ItemType Directory -Path dist -Force | Out-Null
    Copy-Item -LiteralPath $exe -Destination dist -Force
} finally {
    $resolved = (Resolve-Path -LiteralPath $build).Path
    if ((Split-Path $resolved) -eq (Join-Path $root '.runtime')) { Remove-Item -LiteralPath $resolved -Recurse -Force }
}
