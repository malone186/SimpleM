# SimpleM — 카페 통합 플랫폼

5인 팀 프로젝트: 백엔드 3명(A·B·C) + 프론트 2명(A·B). 상세 내용은 팀 개발 가이드 문서 참고.

## 내 역할: 백엔드 B — AI 오케스트레이션 · 챗봇

이 저장소에서 작업하는 사용자는 **백엔드 B** 담당이다. 주간 리포트, OCR, 챗봇 두뇌, 문서 자동화, 전체 도구 등록을 맡는다.

**내가 만들고 소유하는 파일** (기능 구현은 여기에):
- `backend/app/models/ai.py`, `backend/app/schemas/ai.py`
- `backend/app/api/v1/chatbot.py`
- `backend/app/services/ai/tool_registry.py` ← A·C의 도구를 모으는 곳
- `backend/app/services/ai/agents/main_agent.py` ← 챗봇 두뇌
- `backend/app/services/ai/rag_pipeline.py`
- `backend/app/services/ai/ocr_service.py` + `ocr_tools.py`
- `backend/app/services/ai/document_service.py` + `document_tools.py`
- `backend/app/services/ai/report_tools.py`

**다른 팀원 소유 파일은 수정하지 않는다**:
- 백엔드 A: `core/`, `models/inventory.py`, `schemas/inventory.py`, `api/v1/inventory.py`, `services/inventory_*`, `alembic/versions/*`
- 백엔드 C: `models/operation.py`, `schemas/operation.py`, `api/v1/operation.py`, `services/operation/*`, `ml/training/*`
- 프론트 A: `app/dashboard/`, `app/inventory/`, `app/order/`, `components/dashboard/`, `lib/api/inventory.ts`
- 프론트 B: `app/chatbot/`, `app/operation/`, `components/chatbot/`, `components/operation/`, `lib/api/chatbot.ts`, `lib/api/operation.ts`

## 팀 공통 원칙

- 로직 파일(`*_service.py`)과 챗봇 등록 파일(`*_tools.py`)을 분리한다 — 누가 무엇을 만들든 서로의 파일을 열 필요가 없게.
- 공동 소유 파일 수정 규칙:
  - `main.py`, `api/v1/router.py`: 라우터 추가는 알파벳순으로 삽입
  - `models/__init__.py`: 모델 등록도 알파벳순
  - `tool_registry.py`: 각자 도구 리스트 import 한 줄만 추가 (알파벳순)
  - `layout.tsx`, `lib/api/client.ts`: 초기 세팅 후 거의 고정, 수정 시 팀 공지
  - `types/api.d.ts`: 직접 수정 금지 (CI가 자동 생성)

## 새 기능 체크리스트

- [ ] `*_service.py`에 로직 작성
- [ ] 챗봇이 써야 하면 `*_tools.py`에 `@tool` 래퍼 추가
- [ ] 돈이 걸린 액션(발주/지급/신고)이면 `propose_`/`draft_` 접두어로 초안만 반환
- [ ] `tool_registry.py`에 한 줄 import 추가 (알파벳순)

나한테 자꾸 yes 이런거 허락받지 말고 알아서 다 해봐.