[CmdletBinding()]
param([string]$OutputDirectory, [string]$NodeArchive, [switch]$LibraryOnly)
$ErrorActionPreference = 'Stop'
# Resolve built-ins from this PowerShell, even when a different host populated PSModulePath.
Import-Module ([IO.Path]::Combine($PSHOME, 'Modules', 'Microsoft.PowerShell.Management', 'Microsoft.PowerShell.Management.psd1'))
Import-Module ([IO.Path]::Combine($PSHOME, 'Modules', 'Microsoft.PowerShell.Utility', 'Microsoft.PowerShell.Utility.psd1'))
$script:NodeVersion = '22.23.3'
$script:NodeArchiveHash = '2b0ff57b049cda1bbcea2240eec20467018713c1efe1f7360c2681859b90ed71'

function Assert-RegularPath([string]$Path) {
    $item = Get-Item -LiteralPath $Path -Force
    if (($item.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) { throw 'reparse_path' }
    return $item
}
function Copy-ReviewedFile([string]$Source, [string]$Destination) {
    $item = Assert-RegularPath $Source
    if ($item.PSIsContainer) { throw 'expected_file' }
    [IO.Directory]::CreateDirectory([IO.Path]::GetDirectoryName($Destination)) | Out-Null
    Copy-Item -LiteralPath $Source -Destination $Destination
}
function Copy-ReviewedTree([string]$Source, [string]$Destination) {
    $item = Assert-RegularPath $Source
    if (!$item.PSIsContainer) { throw 'expected_directory' }
    [IO.Directory]::CreateDirectory($Destination) | Out-Null
    foreach ($child in Get-ChildItem -LiteralPath $Source -Force) {
        if ($child.PSIsContainer) { Copy-ReviewedTree $child.FullName (Join-Path $Destination $child.Name) }
        else { Copy-ReviewedFile $child.FullName (Join-Path $Destination $child.Name) }
    }
}
function Copy-AppPayload([string]$ProjectRoot, [string]$Destination) {
    $files = @('package.json','package-lock.json','tsconfig.json','README.md','README.zh-CN.md','PRIVACY.md','LICENSE','THIRD_PARTY_NOTICES.md')
    foreach ($module in @('capture','cli','mcp','publish','schema','store','transport')) {
        $files += "src/$module.ts", "dist/src/$module.js"
    }
    foreach ($file in $files) { Copy-ReviewedFile (Join-Path $ProjectRoot $file) (Join-Path $Destination $file) }
    Copy-ReviewedTree (Join-Path $ProjectRoot 'licenses') (Join-Path $Destination 'licenses')
}
function Assert-NodeArchive([string]$Archive) {
    $null = Assert-RegularPath $Archive
    if ((Get-FileHash -LiteralPath $Archive -Algorithm SHA256).Hash.ToLowerInvariant() -ne $script:NodeArchiveHash) { throw 'node_archive_hash_mismatch' }
}
function Write-InstallerManifest([string]$BundleRoot, [string]$Version) {
    $base = [IO.Path]::GetFullPath($BundleRoot).TrimEnd('\','/') + [IO.Path]::DirectorySeparatorChar
    $files = @()
    $pending = [Collections.Generic.Stack[string]]::new()
    $pending.Push($base)
    while ($pending.Count) {
        $directory = $pending.Pop()
        $null = Assert-RegularPath $directory
        foreach ($item in Get-ChildItem -LiteralPath $directory -Force) {
            $null = Assert-RegularPath $item.FullName
            if ($item.PSIsContainer) { $pending.Push($item.FullName); continue }
            $relative = $item.FullName.Substring($base.Length).Replace('\','/')
            if ($relative -eq 'manifest.json') { continue }
            $files += @{path=$relative;sha256=(Get-FileHash -LiteralPath $item.FullName -Algorithm SHA256).Hash.ToLowerInvariant()}
        }
    }
    $json = @{version=$Version;files=@($files | Sort-Object { $_.path })} | ConvertTo-Json -Depth 5
    [IO.File]::WriteAllText((Join-Path $base 'manifest.json'), $json + "`n", [Text.UTF8Encoding]::new($false))
}
if ($LibraryOnly) { return }

$project = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
$package = Get-Content -LiteralPath (Join-Path $project 'package.json') -Raw | ConvertFrom-Json
if ($package.version -notmatch '^\d+\.\d+\.\d+$') { throw 'invalid_package_version' }
if (!$OutputDirectory) { $OutputDirectory = Join-Path $project 'work/windows-release' }
$output = [IO.Path]::GetFullPath($OutputDirectory)
[IO.Directory]::CreateDirectory($output) | Out-Null
$null = Assert-RegularPath $output
$zip = Join-Path $output "I-m-Genius-$($package.version)-windows-x64.zip"
if (Test-Path -LiteralPath $zip) { throw 'release_already_exists' }
$stage = Join-Path $output ('.bundle-' + [guid]::NewGuid().ToString('N'))
$bundle = Join-Path $stage "I-m-Genius-$($package.version)-windows-x64"
$app = Join-Path $bundle 'payload/app'
[IO.Directory]::CreateDirectory($app) | Out-Null
if (!$NodeArchive) {
    $NodeArchive = Join-Path $stage "node-v$script:NodeVersion-win-x64.zip"
    # The version and digest are pinned; downloaded bytes are verified before extraction.
    [Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12
    Invoke-WebRequest -UseBasicParsing -Uri "https://nodejs.org/dist/v$script:NodeVersion/node-v$script:NodeVersion-win-x64.zip" -OutFile $NodeArchive
}
Assert-NodeArchive $NodeArchive
Expand-Archive -LiteralPath $NodeArchive -DestinationPath (Join-Path $stage 'node')
$node = Join-Path $stage "node/node-v$script:NodeVersion-win-x64"
Copy-ReviewedFile (Join-Path $node 'node.exe') (Join-Path $bundle 'payload/node.exe')
Copy-ReviewedFile (Join-Path $node 'LICENSE') (Join-Path $bundle 'payload/node-LICENSE')
Copy-AppPayload $project $app
Copy-ReviewedFile (Join-Path $project 'Install.cmd') (Join-Path $bundle 'Install.cmd')
Copy-ReviewedFile (Join-Path $project 'installer/Install.ps1') (Join-Path $bundle 'installer/Install.ps1')
Push-Location $app
try {
    & npm.cmd ci --omit=dev --ignore-scripts --no-audit --no-fund
    if ($LASTEXITCODE -ne 0) { throw 'production_dependencies_failed' }
} finally { Pop-Location }

# Compile the existing small launcher on the maintainer's machine, not the user's.
$source = Get-Content -LiteralPath (Join-Path $project 'src/transport.ts') -Raw -Encoding UTF8
$launcher = [regex]::Match($source, '(?s)const STARTUP_LAUNCHER = String.raw`(.*?)`;')
if (!$launcher.Success) { throw 'launcher_source_not_found' }
$launcherSource = Join-Path $app 'startup-launcher.cs'
[IO.File]::WriteAllText($launcherSource, $launcher.Groups[1].Value.Replace("`r`n", "`n").Replace("`r", "`n"), [Text.UTF8Encoding]::new($false))
$framework = Join-Path $env:SystemRoot 'Microsoft.NET/Framework64/v4.0.30319'
& (Join-Path $framework 'csc.exe') /noconfig /nologo /target:winexe /nostdlib "/reference:$framework/mscorlib.dll" "/reference:$framework/System.dll" "/out:$app/startup-launcher.exe" $launcherSource
if ($LASTEXITCODE -ne 0) { throw 'launcher_build_failed' }
Write-InstallerManifest $bundle $package.version
Compress-Archive -Path $bundle -DestinationPath $zip -CompressionLevel Optimal
Write-Output $zip
