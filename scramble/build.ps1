# Build MangaScramble (WPF) on Windows.
#
# Requires: .NET 8 SDK with the WindowsDesktop workload (the SDK installer from
# https://dotnet.microsoft.com/download/dotnet/8.0 includes it by default on
# Windows). Cannot run on Linux/macOS — Microsoft.NET.Sdk.WindowsDesktop only
# ships on Windows.
#
# Usage (from anywhere, or cd into scramble/ first):
#   .\build.ps1                  # Debug build, output in bin\Debug\net8.0-windows\
#   .\build.ps1 -Configuration Release
#   .\build.ps1 -Publish         # Release, self-contained single .exe (no .NET install needed to run)
#   .\build.ps1 -Publish -Clean  # wipe bin/obj first, then publish
#
# The published .exe (with -Publish) lands in:
#   scramble\MangaScramble\bin\Release\net8.0-windows\win-x64\publish\MangaScramble.exe

param(
    [ValidateSet('Debug', 'Release')]
    [string]$Configuration = 'Debug',

    # Produce a single self-contained .exe (bundles the .NET runtime) instead
    # of a plain build. Always uses Release regardless of -Configuration.
    [switch]$Publish,

    # Remove bin/ and obj/ before building, to rule out stale-artifact issues.
    [switch]$Clean
)

$ErrorActionPreference = 'Stop'

$scriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$projectDir = Join-Path $scriptDir 'MangaScramble'
$csproj = Join-Path $projectDir 'MangaScramble.csproj'

if (-not (Test-Path $csproj)) {
    throw "Project file not found: $csproj"
}

if (-not (Get-Command dotnet -ErrorAction SilentlyContinue)) {
    throw "dotnet CLI not found on PATH. Install the .NET 8 SDK from https://dotnet.microsoft.com/download/dotnet/8.0"
}

if ($Clean) {
    Write-Host "Cleaning bin/ and obj/ ..." -ForegroundColor Yellow
    Remove-Item (Join-Path $projectDir 'bin') -Recurse -Force -ErrorAction SilentlyContinue
    Remove-Item (Join-Path $projectDir 'obj') -Recurse -Force -ErrorAction SilentlyContinue
}

Write-Host "Restoring packages ..." -ForegroundColor Cyan
dotnet restore $csproj
if ($LASTEXITCODE -ne 0) { throw "dotnet restore failed" }

if ($Publish) {
    Write-Host "Publishing self-contained win-x64 Release build ..." -ForegroundColor Cyan
    dotnet publish $csproj `
        -c Release `
        -r win-x64 `
        --self-contained true `
        -p:PublishSingleFile=true `
        -p:IncludeNativeLibrariesForSelfExtract=true

    if ($LASTEXITCODE -ne 0) { throw "dotnet publish failed" }

    $publishDir = Join-Path $projectDir 'bin\Release\net8.0-windows\win-x64\publish'
    $exePath = Join-Path $publishDir 'MangaScramble.exe'
    Write-Host ""
    Write-Host "Publish succeeded." -ForegroundColor Green
    Write-Host "Executable: $exePath"
}
else {
    Write-Host "Building ($Configuration) ..." -ForegroundColor Cyan
    dotnet build $csproj -c $Configuration
    if ($LASTEXITCODE -ne 0) { throw "dotnet build failed" }

    $outDir = Join-Path $projectDir "bin\$Configuration\net8.0-windows"
    $exePath = Join-Path $outDir 'MangaScramble.exe'
    Write-Host ""
    Write-Host "Build succeeded." -ForegroundColor Green
    Write-Host "Executable: $exePath"
}
