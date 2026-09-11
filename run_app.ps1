# Steppe Meeting - Windows launcher (browser mode, no Rust toolchain needed).
#
# The native Tauri shell depends on screencapturekit, which is macOS only, so on
# Windows the app runs in the browser. Audio capture still works there: the
# recorder falls back to getDisplayMedia + getUserMedia when it is not running
# inside Tauri.
#
# Usage (PowerShell, from the project folder):
#   powershell -ExecutionPolicy Bypass -File .\run_app.ps1

$ErrorActionPreference = "Stop"

$Root = Split-Path -Parent $MyInvocation.MyCommand.Path
$BackendDir = Join-Path $Root "backend"

Write-Host "==================================================" -ForegroundColor Cyan
Write-Host "    Steppe Meeting - Local Desktop Application"      -ForegroundColor Cyan
Write-Host "==================================================" -ForegroundColor Cyan

function Test-Port {
    param([int]$Port)
    try {
        $client = New-Object System.Net.Sockets.TcpClient
        $client.Connect("127.0.0.1", $Port)
        $client.Close()
        return $true
    } catch {
        return $false
    }
}

# --- 1. Backend ------------------------------------------------------------
if (Test-Port 8008) {
    Write-Host "Backend already running on port 8008." -ForegroundColor Green
} else {
    Write-Host "Starting Python backend on port 8008..." -ForegroundColor Yellow
    Start-Process powershell -ArgumentList @(
        "-NoExit", "-ExecutionPolicy", "Bypass",
        "-File", (Join-Path $BackendDir "run_backend.ps1")
    )

    Write-Host "Waiting for the backend to come up..." -ForegroundColor Yellow
    $ready = $false
    foreach ($i in 1..60) {
        Start-Sleep -Seconds 1
        if (Test-Port 8008) { $ready = $true; break }
    }
    if (-not $ready) {
        Write-Host "Backend did not start within 60 seconds. Check the other window for errors." -ForegroundColor Red
        exit 1
    }
    Write-Host "Backend is up." -ForegroundColor Green
}

# --- 2. Frontend dependencies ---------------------------------------------
if (-not (Test-Path (Join-Path $Root "node_modules"))) {
    Write-Host "Installing frontend dependencies (one time, a few minutes)..." -ForegroundColor Yellow
    Push-Location $Root
    npm install
    Pop-Location
}

# --- 3. Dev server ---------------------------------------------------------
if (Test-Port 1420) {
    Write-Host "Frontend already running on port 1420." -ForegroundColor Green
} else {
    Write-Host "Starting Vite dev server on port 1420..." -ForegroundColor Yellow
    Push-Location $Root
    Start-Process powershell -ArgumentList @("-NoExit", "-Command", "npm run dev")
    Pop-Location
    Start-Sleep -Seconds 4
}

# --- 4. Open the app -------------------------------------------------------
# Chrome is preferred: getDisplayMedia with audio, which is how system audio is
# captured without the native recorder, works best there.
Write-Host ""
Write-Host "Opening http://localhost:1420" -ForegroundColor Green
Write-Host "Tip: to capture system audio, tick 'Share tab audio' in the picker." -ForegroundColor DarkGray
Start-Process "http://localhost:1420"

Write-Host ""
Write-Host "Both services run in their own windows. Close them to stop the app." -ForegroundColor DarkGray
