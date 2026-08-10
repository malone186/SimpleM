"""기능 검증(QA) 에이전트 편성표 (백엔드 B)

챗봇 전문가 편성과 별개로, 저장소 전체를 기능 단위로 나눠 검증하는 QA 멀티에이전트
편성이다 — 메인 오케스트레이터가 기능별 서브 에이전트에게 코드 추적·테스트 실행·
프론트-백엔드 계약 대조를 맡기고 판정을 종합한다. 관리자 콘솔 'AI 에이전트' 탭이
챗봇 편성 아래에 이 편성표를 함께 그린다.

여기 담긴 판정은 마지막 검증 실행의 결과 스냅샷이다. 재검증을 돌리면 이 표를
갱신한다 (checked_at 포함).
"""

# 마지막 '전체' 검증 실행일 (KST). 개별 항목을 고쳤다고 올리지 않는다 — 이 날짜는
# 14개 기능을 한 번에 훑은 마지막 시점이라는 뜻이고, 그 뒤의 개별 수정은 note에 적는다.
LAST_RUN = "2026-08-08"

_MAIN = {
    "name": "qa_orchestrator",
    "title": "기능 검증 총괄",
    "description": (
        "기능별 검증 서브 에이전트를 편성·지휘한다. 각 서브 에이전트의 코드 추적, "
        "테스트 실행, 프론트-백엔드 계약 대조 결과를 받아 기능별 판정표로 종합하고, "
        "확인된 결함은 수정 대상으로 승격한다."
    ),
}

# 기능 하나당 서브 에이전트 1개. status: 정상 | 경미한 문제 | 심각한 문제
_SUBAGENTS = [
    {"name": "qa_auth", "title": "인증·회원 검증", "status": "정상",
     "note": "가입·로그인·아이디찾기·비밀번호 재설정(메일/휴대폰) — 관리자 이메일 가입 차단, 휴대폰 본인확인 회귀 테스트 통과."},
    {"name": "qa_staff_account", "title": "직원 계정 검증", "status": "정상",
     "note": "발급·재발급·중지 owner 보호, 화이트리스트 미들웨어로 사장님 계정 탈취 경로 차단 확인."},
    {"name": "qa_inventory", "title": "재고·발주 검증", "status": "정상",
     "note": "전 엔드포인트 매장 격리 일관, 재고 증감 FOR UPDATE 잠금, 판매 이력 메뉴 삭제 보호."},
    {"name": "qa_pos", "title": "POS 연동 검증", "status": "정상",
     "note": "토큰 암호화 저장·마스킹, 웹훅 서명 검증, 중복 주문 유니크 방어 확인."},
    {"name": "qa_membership", "title": "멤버십·선불 검증", "status": "정상",
     "note": "잔액 행 잠금·환불 현금가치 비율 계산, 손님 링크(/b·/s) 토큰 기반 읽기 전용 확인."},
    {"name": "qa_settlement", "title": "정산·손익 검증", "status": "정상",
     "note": "월정산 KST 경계 통일, 카드 입금일 영업일 계산, 손익분기 CVP 수식 확인."},
    {"name": "qa_operation", "title": "근무·급여 검증", "status": "정상",
     "note": "직원·스케줄 소유 검증(NULL 매장 방어), 스케줄 추천의 토큰 매장 강제 확인."},
    {"name": "qa_chatbot", "title": "챗봇 오케스트레이션 검증", "status": "정상",
     "note": "쿼터 선차감·실패 환불 정상. 광고 충전은 2026-08-10 수정 — 구글 SSV 콜백 서명 검증 + 충전 원장(거래 id 유니크)으로 중복 차단, CHAT_AD_SSV_REQUIRED=1이면 앱 보고 경로 차단."},
    {"name": "qa_ocr_document", "title": "OCR·문서 검증", "status": "정상",
     "note": "명세서 인식→확정→재고 반영 흐름, 초안 소유자 검증(_check_owner) 확인."},
    {"name": "qa_report_forecast", "title": "리포트·예측 검증", "status": "정상",
     "note": "예측 인증·격리 정상. assistant 만료 토큰 데모 폴백은 401 처리로 수정 완료."},
    {"name": "qa_notification", "title": "알림·푸시 검증", "status": "정상",
     "note": "토큰 등록·설정 본인 매장 한정, 크론 시크릿 검증, 매장별 실패 롤백(연쇄 차단) 확인."},
    {"name": "qa_store_map", "title": "지도·상권 검증", "status": "정상",
     "note": "주변 카페·행사 조회 매장 좌표 스코프, 외부 텍스트(후기·웹) 무해화 경계 적용 확인."},
    {"name": "qa_checklist_etc", "title": "체크리스트·문의·리워드 검증", "status": "정상",
     "note": "체크리스트·리워드 정상. 문의 등록의 비인증 폴백은 2026-08-10에 닫음 — 보낸 사람은 토큰만으로 정하고 본문 이메일은 받지 않는다(구버전 앱 OTA 확산 완료)."},
    {"name": "qa_admin", "title": "관리자 콘솔 검증", "status": "정상",
     "note": "DB 우선 로그인·빈 비밀번호 503 차단, 관리자 API 전체 get_current_admin 보호 확인."},
]


def snapshot() -> dict:
    """관리자 콘솔용 QA 편성표 — 챗봇 편성(get_agent_overview)에 얹어 내려간다."""
    counts = {"정상": 0, "경미한 문제": 0, "심각한 문제": 0}
    for s in _SUBAGENTS:
        counts[s["status"]] = counts.get(s["status"], 0) + 1
    return {
        "main": _MAIN,
        "subagents": _SUBAGENTS,
        "total": len(_SUBAGENTS),
        "counts": counts,
        "checked_at": LAST_RUN,
    }
