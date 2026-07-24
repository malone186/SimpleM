# SimpleM 배포 가이드 — GCP Cloud Run

백엔드(FastAPI)와 프론트엔드(Expo 웹 빌드)를 각각 Cloud Run 서비스로 배포한다.
OCR·챗봇·리포트가 전부 Gemini API 호출이라 GPU/모델 파일이 필요 없다 — 이미지가
가볍고 콜드스타트도 짧다. DB는 Neon(클라우드)이라 서버에 설치할 것 없음.

## 0. 준비물 (1회)

- gcloud CLI 설치 + 로그인: `gcloud auth login`
- 프로젝트/리전 설정 및 API 활성화:

```bash
gcloud config set project <PROJECT_ID>
gcloud config set run/region asia-northeast3   # 서울
gcloud services enable run.googleapis.com cloudbuild.googleapis.com artifactregistry.googleapis.com
```

## 1. 백엔드 배포

`deploy/deploy_backend.ps1` 실행 (또는 아래 명령 직접):

```bash
gcloud run deploy brewnote-api --source backend --region asia-northeast3 --allow-unauthenticated --memory 1Gi --set-env-vars-file backend/deploy/env.yaml
```

- 환경변수는 `backend/deploy/env.yaml`에 채운다 (`env.example.yaml` 참고, **커밋 금지** — .gitignore에 등록됨).
  필수: `DATABASE_URL`(Neon, sslmode=require), `SECRET_KEY`, `GEMINI_API_KEY`.
- 소스 배포(`--source`)라 Dockerfile 기반으로 Cloud Build가 알아서 빌드한다.
- 확인: `curl https://<백엔드 URL>/health` → `{"status":"ok"}`

## 2. 프론트엔드 배포

Expo 웹 빌드를 정적 서빙하는 컨테이너다. API 주소가 **빌드 시점에** 박히므로
백엔드 URL을 빌드 인자로 넘긴다. `deploy/deploy_frontend.ps1` 이 자동으로 처리한다:

```bash
gcloud run deploy brewnote-web --source frontend --region asia-northeast3 --allow-unauthenticated
```

(frontend/Dockerfile이 `EXPO_PUBLIC_API_BASE_URL` build-arg를 받는다 —
스크립트가 백엔드 서비스 URL을 조회해 자동 주입)

## 3. 재배포 (수정 후)

같은 명령을 다시 실행하면 새 리비전으로 교체된다:

```bash
powershell -File deploy/deploy_backend.ps1
powershell -File deploy/deploy_frontend.ps1
```

자동 배포(git push → 배포)를 원하면 Cloud Build 트리거를 GitHub 저장소에
연결한다 (콘솔 → Cloud Build → 트리거, 최초 1회 GitHub 앱 연동 필요).

## 알아둘 것

- **OCR**: Gemini API(`gemini-2.5-flash` 기본, `OCR_GEMINI_MODEL`로 교체 가능).
  무료 쿼터는 모델별·팀 공유 키 합산이므로 데모 전 쿼터 잔량 확인.
  파인튜닝 Qwen(0.8B/2B) 경로는 제거됨 — 평가 지표는 `backend/vlm_finetune/metrics/` 보관.
- **파일 저장**: Cloud Run 디스크는 휘발성. OCR 초안은 DB(ocr_documents)에 있어
  안전하고, 원본 이미지(uploads/)만 인스턴스 교체 시 사라진다.
- **Neon 콜드스타트**: 유휴 후 첫 연결이 몇 초 걸릴 수 있다 (`DB_CONNECT_TIMEOUT` 참고).
- **모바일 앱**: 네이티브 앱(EAS 빌드)은 `frontend/.env`의
  `EXPO_PUBLIC_API_BASE_URL`을 백엔드 Cloud Run URL로 바꾸고 다시 빌드.
- **비밀키**: `deploy/env.yaml`은 로컬에만 둔다. 개발 `.env`의 SECRET_KEY 재사용 금지.
