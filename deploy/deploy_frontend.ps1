# SimpleM 프론트엔드(Expo 웹) → GCP Cloud Run 배포
# 백엔드(simplem-api)가 먼저 배포되어 있어야 한다 — URL을 조회해 빌드에 박는다.
$ErrorActionPreference = "Stop"
$root = Split-Path $PSScriptRoot -Parent
$region = "asia-northeast3"

$apiUrl = gcloud run services describe simplem-api --region $region --format "value(status.url)"
if (-not $apiUrl) { throw "simplem-api 서비스를 찾을 수 없습니다 — deploy_backend.ps1을 먼저 실행하세요." }

# EXPO_PUBLIC_* 값은 빌드 시점에 번들에 박히므로 .env.production을 먼저 갱신한다
$envFile = "$root\frontend\.env.production"
(Get-Content $envFile) -replace '^EXPO_PUBLIC_API_BASE_URL=.*', "EXPO_PUBLIC_API_BASE_URL=$apiUrl" |
    Set-Content $envFile -Encoding utf8
Write-Host "API 주소 주입: $apiUrl"

gcloud run deploy simplem-web `
    --source "$root\frontend" `
    --region $region `
    --allow-unauthenticated `
    --memory 512Mi

$webUrl = gcloud run services describe simplem-web --region $region --format "value(status.url)"
Write-Host "`n프론트엔드 배포 완료: $webUrl"
Write-Host "주의: Firebase 콘솔 → Authentication → 승인된 도메인에 $($webUrl -replace 'https://','') 추가해야 소셜 로그인이 된다."
