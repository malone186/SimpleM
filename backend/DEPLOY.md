# SimpleM 백엔드 배포 가이드

리눅스 VM 1대 + 도메인 1개면 된다. 스택은 docker compose 3개 컨테이너:
**api**(FastAPI) · **ocr**(llama.cpp, 파인튜닝 Qwen VLM CPU 서빙) · **caddy**(HTTPS 자동).

## 0. 준비물

- 리눅스 VM (Ubuntu 22.04+, **RAM 4GB 이상** 권장 — chromadb + 0.8B GGUF 상주)
- 도메인 (예: `api.simplem.kr`) — A 레코드를 VM 공인 IP로
- VM 방화벽/보안그룹에서 80, 443 인바운드 오픈
- DB는 Neon(클라우드)이라 서버에 설치할 것 없음

## 1. 서버에 올릴 파일

```
backend/            # 이 폴더 통째 (vlm_finetune 제외 — .dockerignore가 걸러줌)
backend/models/     # 새로 만들 폴더 — GGUF 2개 복사
  ├─ qwen35-08b-ocr-v2-q8.gguf     (vlm_finetune/output에서, 812MB)
  └─ mmproj-qwen35-08b.gguf        (207MB)
backend/data/chroma_db/             # 법령 RAG 인덱스 (로컬 것 통째 복사)
```

전송 예시 (Windows에서):
```bash
scp -r backend ubuntu@<서버IP>:~/simplem/
scp backend/vlm_finetune/output/qwen35-08b-ocr-v2-q8.gguf backend/vlm_finetune/output/mmproj-qwen35-08b.gguf ubuntu@<서버IP>:~/simplem/backend/models/
```

## 2. 서버에서

```bash
cd ~/simplem/backend
cp .env.production.example .env.production
nano .env.production        # 실제 키 값 채우기 (API_DOMAIN, DATABASE_URL, SECRET_KEY 등)
docker compose -f docker-compose.prod.yml up -d --build
```

확인:
```bash
curl https://<API_DOMAIN>/health          # {"status":"ok"}
curl https://<API_DOMAIN>/db-test         # database: success (Neon 콜드스타트면 1회 재시도)
docker compose -f docker-compose.prod.yml logs -f api
```

## 3. 프론트 연결 → 안드로이드 빌드

`frontend/.env`:
```
EXPO_PUBLIC_API_BASE_URL=https://<API_DOMAIN>
```
이후 EAS/gradle 빌드. (릴리스 빌드는 평문 http 차단이라 HTTPS 필수 — caddy가 해결)

## 알아둘 것

- **OCR 속도**: 로컬 GPU에선 장당 ~3.3초지만 VM CPU에선 **수십 초**가 걸릴 수 있다.
  vCPU 4개 이상 권장. 출시 후 느리다는 피드백이 오면 GPU 인스턴스 분리 또는
  경량 양자화(Q4) 전환을 검토.
- **2B 모델 전환**: 평가가 더 좋으면 `models/`에 2B GGUF 2개 올리고
  `docker-compose.prod.yml`의 ocr command 파일명만 교체 → `docker compose up -d ocr`.
- **Neon 콜드스타트**: 무료 티어는 유휴 후 첫 연결이 3초 타임아웃(core/database.py)에
  걸릴 수 있다. api 컨테이너가 restart: unless-stopped라 자동 재시도로 뜬다.
- **CORS**: main.py(공동 소유)가 현재 모든 오리진 허용. 앱(네이티브)은 CORS 무관하지만
  admin_web을 공개 도메인에 올리면 그 오리진만 허용하도록 좁히는 게 좋다 — 팀 공지 후 수정.
- **비밀키**: `.env.production`은 서버에만 둔다. 개발 `.env`의 SECRET_KEY 재사용 금지
  (기존 토큰 전부 무효화가 아니라, 유출 반경 분리 목적).
