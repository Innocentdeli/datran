<#
.SYNOPSIS
    Unified Datran System Launcher (PowerShell)
    Starts the Bare-Metal Rust Core Reactor daemon and Next.js Web Portal.
#>

$ErrorActionPreference = "Stop"

$RootDir = Split-Path -Parent $PSScriptRoot
$CoreDir = Join-Path $RootDir "core-reactor"
$AppDir = Join-Path $RootDir "diocom-app"

Write-Host "╔══════════════════════════════════════════════════════════════════╗" -ForegroundColor Cyan
Write-Host "║              ⚡ DATRAN HIGH-THROUGHPUT SYSTEM                    ║" -ForegroundColor Cyan
Write-Host "║       Starting Native Rust Core Reactor + Next.js Portal        ║" -ForegroundColor Cyan
Write-Host "╚══════════════════════════════════════════════════════════════════╝" -ForegroundColor Cyan

# 1. Environment & Compiler setup
$userProfile = $env:USERPROFILE
$winlibsBin = "$userProfile\AppData\Local\Microsoft\WinGet\Packages\BrechtSanders.WinLibs.POSIX.UCRT_Microsoft.Winget.Source_8wekyb3d8bbwe\mingw64\bin"
$cargoBin = "$userProfile\.cargo\bin"

if (Test-Path $winlibsBin) {
    $env:PATH = "$winlibsBin;$cargoBin;$env:PATH"
} elseif (Test-Path $cargoBin) {
    $env:PATH = "$cargoBin;$env:PATH"
}

if (-not $env:REACTOR_PORT) { $env:REACTOR_PORT = "3005" }
if (-not $env:PORT) { $env:PORT = "3001" }
$ReactorUrl = "http://127.0.0.1:$($env:REACTOR_PORT)"

# 2. Check if already online
$isOnline = $false
try {
    $health = Invoke-RestMethod -Uri "$ReactorUrl/health" -TimeoutSec 1 -ErrorAction SilentlyContinue
    if ($health.status -eq "online") {
        $isOnline = $true
        Write-Host "[RUST CORE] Active daemon detected on $ReactorUrl (not managed by this script)" -ForegroundColor Green
        # New uploads go to the reactor object store unless STORAGE_BACKEND was chosen explicitly;
        # an existing daemon is only used for storage when we have its token.
        if (-not $env:STORAGE_BACKEND -and $env:REACTOR_TOKEN) {
            $env:STORAGE_BACKEND = "reactor"
            Write-Host "[RUST CORE] STORAGE_BACKEND=reactor (existing daemon)" -ForegroundColor Green
        }
    }
} catch {}

if (-not $isOnline) {
    # Shared secret between the app and the reactor we launch.
    if (-not $env:REACTOR_TOKEN) {
        $bytes = New-Object byte[] 24
        [System.Security.Cryptography.RandomNumberGenerator]::Create().GetBytes($bytes)
        $env:REACTOR_TOKEN = [Convert]::ToBase64String($bytes).TrimEnd('=').Replace('+', '-').Replace('/', '_')
    }

    Write-Host "[RUST CORE] Launching Rust Core Reactor daemon..." -ForegroundColor Blue
    $releaseExe = Join-Path $CoreDir "target\release\core-reactor.exe"
    $debugExe = Join-Path $CoreDir "target\debug\core-reactor.exe"

    if (Test-Path $releaseExe) {
        $rustJob = Start-Process -FilePath $releaseExe -WorkingDirectory $CoreDir -PassThru -NoNewWindow
    } elseif (Test-Path $debugExe) {
        $rustJob = Start-Process -FilePath $debugExe -WorkingDirectory $CoreDir -PassThru -NoNewWindow
    } else {
        $rustJob = Start-Process -FilePath "cargo" -ArgumentList "run","--release" -WorkingDirectory $CoreDir -PassThru -NoNewWindow
    }

    # Wait for health check
    $attempts = 0
    $healthy = $false
    while ($attempts -lt 20) {
        Start-Sleep -Milliseconds 500
        try {
            $h = Invoke-RestMethod -Uri "$ReactorUrl/health" -TimeoutSec 1 -ErrorAction SilentlyContinue
            if ($h.status -eq "online") {
                Write-Host "[RUST CORE] Engine online at $ReactorUrl" -ForegroundColor Green
                $healthy = $true
                if (-not $env:STORAGE_BACKEND) {
                    $env:STORAGE_BACKEND = "reactor"
                    Write-Host "[RUST CORE] STORAGE_BACKEND=reactor (launched daemon)" -ForegroundColor Green
                }
                break
            }
        } catch {}
        $attempts++
    }
    if (-not $healthy) {
        Write-Host "[RUST CORE] Health check timed out; the app will use the TypeScript fallback." -ForegroundColor Yellow
    }
}

# 3. Launch Next.js Web Portal
Write-Host "[NEXT.JS] Launching Web Portal at http://localhost:$($env:PORT)..." -ForegroundColor Magenta
Push-Location $AppDir
try {
    npm run dev -- -p $env:PORT
} finally {
    Pop-Location
    if ($rustJob -and -not $rustJob.HasExited) {
        Stop-Process -Id $rustJob.Id -Force -ErrorAction SilentlyContinue
    }
}
