# 로컬 검증용 서버(실데이터 안 건드림 — STORAGE_ROOT를 임시 폴더로)
$root = Join-Path $env:TEMP "twoems_devcheck"
if (-not (Test-Path $root)) { New-Item -ItemType Directory -Force $root | Out-Null }
$env:STORAGE_ROOT = $root
$env:AUTH_USERS = '[{"username":"dev","password":"dev12345","display_name":"Dev"}]'
$env:SESSION_SECRET = "dev-secret-for-local-check-only"
$env:SESSION_TTL_SECONDS = "36000"
$env:DEBUG = "true"
$env:GEMINI_API_KEY = ""
Set-Location "C:\Users\jaemi\Documents\Project\twoems-server"
python -m uvicorn backend.main:app --host 127.0.0.1 --port 8010
