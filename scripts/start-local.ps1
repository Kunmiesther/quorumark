param(
  [switch]$HostedPersistence
)

$ErrorActionPreference = "Stop"
$root = Split-Path -Parent $PSScriptRoot
$backendDir = Join-Path $root "backend"
$python = Join-Path $backendDir ".venv\Scripts\python.exe"
$logDir = Join-Path ([System.IO.Path]::GetTempPath()) "quorumark-local"
New-Item -ItemType Directory -Force -Path $logDir | Out-Null

if (-not (Test-Path $python)) {
  throw "The backend virtual environment is missing. Run: python -m venv backend\.venv and install backend\requirements.txt."
}

$backendListener = Get-NetTCPConnection -LocalPort 8000 -State Listen -ErrorAction SilentlyContinue
if (-not $backendListener) {
  $backendArgs = "-m uvicorn app.main:app --host 127.0.0.1 --port 8000"
  if ($HostedPersistence) { $env:QUORUMARK_PYTHON_ENVIRONMENT = "hosted" }
  Start-Process -FilePath $python -ArgumentList $backendArgs -WorkingDirectory $backendDir -RedirectStandardOutput (Join-Path $logDir "backend.out.log") -RedirectStandardError (Join-Path $logDir "backend.err.log") | Out-Null
}

$frontendListener = Get-NetTCPConnection -LocalPort 5173 -State Listen -ErrorAction SilentlyContinue
if (-not $frontendListener) {
  Start-Process -FilePath "npm.cmd" -ArgumentList "run dev -- --host 127.0.0.1" -WorkingDirectory $root -RedirectStandardOutput (Join-Path $logDir "frontend.out.log") -RedirectStandardError (Join-Path $logDir "frontend.err.log") | Out-Null
}

for ($attempt = 0; $attempt -lt 30; $attempt++) {
  try {
    $health = Invoke-RestMethod "http://127.0.0.1:8000/health" -TimeoutSec 2
    if ($health.status -eq "ok") { break }
  } catch { }
  Start-Sleep -Milliseconds 500
  if ($attempt -eq 29) { throw "FastAPI did not become ready. Check the sanitized log at $logDir\backend.err.log." }
}

for ($attempt = 0; $attempt -lt 30; $attempt++) {
  try {
    Invoke-WebRequest "http://127.0.0.1:5173/" -UseBasicParsing -TimeoutSec 2 | Out-Null
    break
  } catch { }
  Start-Sleep -Milliseconds 500
  if ($attempt -eq 29) { throw "Vite did not become ready. Check the sanitized log at $logDir\frontend.err.log." }
}

Write-Output "Quorumark is ready: http://127.0.0.1:5173 (FastAPI http://127.0.0.1:8000)"
Write-Output "Logs are available in the temporary Quorumark log directory; secrets are not printed."
