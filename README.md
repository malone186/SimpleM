# SimpleM
카페 사장님들을 위한 통합 플랫폼

5인 팀 프로젝트 — 백엔드 3명(A·B·C) + 프론트 2명(A·B)

## 구조

```
backend/app/
├── main.py              공동 소유 (라우터 추가는 알파벳순)
├── core/                백엔드 A (DB, 인증)
├── models/ schemas/ api/v1/   A/B/C 각자 1파일
├── services/
│   ├── inventory_*      백엔드 A (재고·발주)
│   ├── operation/       백엔드 C (운영·예측·크롤링·세무)
│   └── ai/              백엔드 B (챗봇·OCR·문서·리포트)
│       └── tool_registry.py   공동 소유 (import 한 줄만 알파벳순 추가)
└── ml/training/         백엔드 C

frontend/src/
├── app/dashboard, inventory, order        프론트 A
├── app/chatbot, operation/*               프론트 B
├── lib/api/client.ts                      공동 소유
└── types/api.d.ts                         CI 자동 생성 (직접 수정 금지)
```

## 새 기능 체크리스트

- [ ] `*_service.py`에 로직 작성
- [ ] 챗봇이 써야 하면 `*_tools.py`에 `@tool` 래퍼 추가
- [ ] 돈이 걸린 액션(발주/지급/신고)은 `propose_`/`draft_` 접두어로 초안만 반환
- [ ] `tool_registry.py`에 한 줄 import 추가 (알파벳순)

자세한 내용은 팀 개발 가이드 문서 참고.
