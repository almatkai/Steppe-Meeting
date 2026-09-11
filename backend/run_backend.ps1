# Steppe Meeting backend launcher for Windows.
#
# The bash version requires `uv`, which is one more thing to install. This uses
# the stdlib venv module, so any Python 3.10+ works, including the one that
# ships with Anaconda.

$ErrorActionPreference = "Stop"

$Dir = Split-Path -Parent $MyInvocation.MyCommand.Path
$VenvDir = Join-Path $Dir ".venv"
$Python = Join-Path $VenvDir "Scripts\python.exe"

function Find-Python {
    foreach ($candidate in @("python", "python3", "py")) {
        try {
            $version = & $candidate --version 2>&1
            if ($LASTEXITCODE -eq 0) { return $candidate }
        } catch {
            continue
        }
    }
    return $null
}

if (-not (Test-Path $Python)) {
    $systemPython = Find-Python
    if (-not $systemPython) {
        Write-Host "Python not found on PATH. Install Python 3.11 from python.org and tick 'Add to PATH'." -ForegroundColor Red
        exit 1
    }

    Write-Host "Creating virtual environment in $VenvDir..." -ForegroundColor Yellow
    & $systemPython -m venv $VenvDir
    if ($LASTEXITCODE -ne 0) {
        Write-Host "Could not create the virtual environment." -ForegroundColor Red
        exit 1
    }

    Write-Host "Installing dependencies (a few minutes the first time)..." -ForegroundColor Yellow
    & $Python -m pip install --upgrade pip
    & $Python -m pip install -r (Join-Path $Dir "requirements.txt")
    if ($LASTEXITCODE -ne 0) {
        Write-Host "Dependency install failed. See the errors above." -ForegroundColor Red
        exit 1
    }
}

Write-Host "Starting Steppe Meeting backend on http://127.0.0.1:8008" -ForegroundColor Green
Set-Location $Dir
& $Python (Join-Path $Dir "desktop_server.py")
