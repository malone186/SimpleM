# SimpleM 백엔드 → GCP Cloud Run 배포 (수정 후 재배포도 이 스크립트 재실행)
# 사전 준비 1회: gcloud auth login / gcloud config set project <ID> / DEPLOY.md 참고
$ErrorActionPreference = "Stop"
$root = Split-Path $PSScriptRoot -Parent
$region = "asia-northeast3"

if (-not (Test-Path "$root\backend\deploy\env.yaml")) {
    throw "backend/deploy/env.yaml이 없습니다 — env.example.yaml을 복사해 값을 채우세요."
}

# FCM 서비스 계정 키(푸시 발송용)는 env.yaml이 아니라 Secret Manager에서 주입한다 —
# 개인키를 평문 파일로 굴리지 않기 위해서다. 이 플래그가 빠지면 --env-vars-file이
# 환경변수를 통째로 갈아치우면서 푸시 설정이 사라진다.
# 최초 1회만 시크릿을 만들어 두면 이후 재배포는 그대로 굴러간다:
#   gcloud secrets create fcm-sa --data-file=backend\secrets\firebase-adminsdk-simplem-72f8d.json
# 플래그는 CI 배포(.github/workflows/deploy_backend.yml)와 반드시 같게 유지한다 —
# 여기서 1Gi로 배포하면 CI가 올린 2Gi 리비전을 절반 메모리로 조용히 갈아치워
# 이미지 생성(rembg/Pillow) 경로가 부하에서 OOM으로 죽는다.
gcloud run deploy brewnote-api `
    --source "$root\backend" `
    --region $region `
    --allow-unauthenticated `
    --memory 2Gi `
    --cpu 1 `
    --timeout 300 `
    --min-instances 1 `
    --cpu-boost `
    --env-vars-file "$root\backend\deploy\env.yaml" `
    --set-secrets "FCM_SERVICE_ACCOUNT_JSON=fcm-sa:latest"

$url = gcloud run services describe brewnote-api --region $region --format "value(status.url)"
Write-Host "`n백엔드 배포 완료: $url"
Write-Host "확인: curl $url/health"
