# SimpleM 무료 배포 — Hugging Face Spaces (카드 등록 불필요)

Oracle VM 대신 쓰는 완전 무료 경로. HF 무료 티어 = **2 vCPU / 16GB RAM** Docker 컨테이너.
API(FastAPI)와 OCR(llama.cpp)을 Space 2개로 나눠 올린다. DB는 기존 Neon 그대로.

**전제**: huggingface.co 계정 (무료, 카드 불필요)

**미리 알아둘 것**
- 무료 Space는 **공개(public)여야 외부에서 API 호출 가능** → 백엔드 소스코드가 공개된다.
  (.env는 올리지 않으므로 키는 안전 — 키는 전부 Space Secrets로 주입)
- 48시간 동안 요청이 없으면 잠들었다가 첫 요청에 1~2분 걸려 깨어난다.
- uploads/(OCR 원본 이미지)는 재시작 시 사라진다. 문서 데이터 자체는 Neon에 있어 무관.
- OCR은 CPU 서빙이라 장당 수십 초.

---

## 1단계. GGUF 모델 업로드 (웹에서 5분)

1. huggingface.co → New → **Model** → 이름 `simplem-ocr-gguf`, **Public**
2. Files 탭 → Upload files → 아래 2개 드래그 (backend/vlm_finetune/output/):
   - `qwen35-08b-ocr-v2-q8.gguf` (812MB)
   - `mmproj-qwen35-08b.gguf` (207MB)

## 2단계. OCR Space 만들기

1. New → **Space** → 이름 `simplem-ocr`, SDK **Docker (Blank)**, Public, CPU basic(무료)
2. Space의 Files 탭에서:
   - `Dockerfile` 생성 → `deploy/hf/ocr.Dockerfile` 내용 붙여넣기, `<HF아이디>` 2곳을 본인 아이디로 교체
   - `README.md`의 YAML 머리에 `app_port: 7860` 한 줄 추가:
     ```yaml
     ---
     title: simplem-ocr
     sdk: docker
     app_port: 7860
     ---
     ```
3. Settings → **Variables and secrets** → Secret 추가: `LLAMA_API_KEY` = 아무 긴 랜덤 문자열
   (API Space와 공유할 OCR 보호 키 — python -c "import secrets; print(secrets.token_urlsafe(24))")
4. 빌드 완료 후 주소 확인: `https://<HF아이디>-simplem-ocr.hf.space/health` → `{"status":"ok"}`

## 3단계. API Space 만들기

1. New → **Space** → 이름 `simplem-api`, SDK **Docker (Blank)**, Public, CPU basic(무료)
2. 로컬에서 git으로 백엔드 코드 푸시 (파일이 많아 웹 업로드보다 git 권장):
   ```bash
   git clone https://huggingface.co/spaces/<HF아이디>/simplem-api
   cd simplem-api
   # backend에서 복사: app/ alembic/ alembic.ini requirements.txt data/chroma_db/
   # deploy/hf/api.Dockerfile → Dockerfile 로 복사
   # README.md YAML에 sdk: docker, app_port: 7860
   git add -A && git commit -m "deploy" && git push
   ```
   (푸시 암호는 HF Settings → Access Tokens에서 write 토큰 발급해 사용.
   ⚠ .env, vlm_finetune/, uploads/ 는 절대 올리지 말 것)
3. Settings → Variables and secrets에 등록 (backend/.env 값 그대로):
   - **Secrets**: `DATABASE_URL`, `SECRET_KEY`, `GEMINI_API_KEY`, `NAVER_CLIENT_ID`,
     `NAVER_CLIENT_SECRET`, `NCP_MAPS_CLIENT_ID`, `NCP_MAPS_CLIENT_SECRET`,
     `TAVILY_API_KEY`, `LLAMACPP_API_KEY`(=2단계의 LLAMA_API_KEY와 동일 값)
   - **Variables**(공개돼도 되는 것): `GEMINI_MODEL`, `FIREBASE_PROJECT_ID`,
     `OCR_BACKEND=llamacpp_vlm`, `LLAMACPP_AUTOSTART=0`,
     `LLAMACPP_BASE_URL=https://<HF아이디>-simplem-ocr.hf.space`
4. 확인: `https://<HF아이디>-simplem-api.hf.space/health` → `{"status":"ok"}`,
   `/db-test` → success (Neon 콜드스타트면 1회 재시도)

## 4단계. 프론트 연결

`frontend/.env`와 `eas.json`(preview·production env 블록)의
`EXPO_PUBLIC_API_BASE_URL`을 `https://<HF아이디>-simplem-api.hf.space`로 교체 후:
- 웹: `npx expo export --platform web` → Vercel 재배포
- 앱: `npx eas build --platform android --profile preview` (재빌드 필요 — URL이 번들에 박히므로)

admin_web의 API 주소도 동일하게 교체.

---

완료되면: PC를 꺼도 24시간 서비스, 총비용 0원, 카드 등록 없음.
