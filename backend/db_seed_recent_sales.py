# -*- coding: utf-8 -*-
"""최근 판매 공백 채우기 시드 — 로컬 수동 실행 래퍼 (백엔드 B)

실제 로직은 app/services/ai/demo_seed_service.py에 있다. Cloud Run 이미지에는
app/만 복사되기 때문에 서버에서는 매시간 알림 크론(/chatbot/notifications/run)이
같은 로직을 자동 실행한다 — 데모 직전에 즉시 채우고 싶을 때만 이 파일을 쓴다.

실행:  cd backend && python db_seed_recent_sales.py
"""

from datetime import datetime

from app.services.ai.demo_seed_service import KST, run


def main():
    now = datetime.now(KST)
    print(f"기준 시각: {now.isoformat()}")
    result = run(now)
    print(f"완료 - 판매 {result['sales']}건, 지출 {result['expenses']}건, "
          f"근무 스케줄 {result['schedules']}건 생성")


if __name__ == "__main__":
    main()
