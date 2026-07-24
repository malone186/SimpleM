# SimpleM 백엔드 → GCP Cloud Run 배포 (수정 후 재배포도 이 스크립트 재실행)
# 사전 준비 1회: gcloud auth login / gcloud config set project <ID> / DEPLOY.md 참고
$ErrorActionPreference = "Stop"
$root = Split-Path $PSScriptRoot -Parent
$region = "asia-northeast3"

if (-not (Test-Path "$root\backend\deploy\env.yaml")) {
    throw "backend/deploy/env.yaml이 없습니다 — env.example.yaml을 복사해 값을 채우세요."
}

gcloud run deploy brewnote-api `
    --source "$root\backend" `
    --region $region `
    --allow-unauthenticated `
    --memory 1Gi `
    --cpu 1 `
    --timeout 300 `
    --env-vars-file "$root\backend\deploy\env.yaml"

$url = gcloud run services describe brewnote-api --region $region --format "value(status.url)"
Write-Host "`n백엔드 배포 완료: $url"
Write-Host "확인: curl $url/health"
