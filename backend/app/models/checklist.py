"""근무 체크리스트 — 매일 반복되는 오픈·마감·위생 루틴 (직원·사장 공유)

사장님 '할 일'(TodoItem)과 나눠 둔 이유:

  할 일은 일회성·기한이 있는 경영 업무다(부가세 신고, 원두 발주, 급여 계산). 한 번 하면
  끝나고, 대부분 알바가 할 수 없는 일이다. 반면 계산대에 서는 알바가 실제로 필요한 건
  매일 반복되는 근무 루틴이다(머신 예열, 마감 청소, 화장실 점검). 둘을 같은 표에 섞으면
  서로에게 노이즈만 는다 — 알바 화면에 '부가세 신고'가 뜨고, 정작 '마감 청소'는 없다.

구조는 둘로 나눈다:

  ChecklistItem  — 사장님이 한 번 등록해 두는 '항목 템플릿'(예: "마감 · 기계 청소").
  ChecklistCheck — 그 항목을 '어느 날' 체크했는지. (item_id, check_date)당 한 줄.

  체크 상태를 날짜로 관리하므로 매일 자동으로 초기화된다 — 오늘 날짜의 체크만 조회하면
  어제 체크는 딸려 오지 않는다. 크론으로 리셋할 필요가 없다.
"""

import logging

from sqlalchemy import (
    Boolean, Column, Date, DateTime, ForeignKey, Integer, String, UniqueConstraint,
    func, inspect, text,
)

from app.core.database import Base

logger = logging.getLogger(__name__)


class ChecklistItem(Base):
    """근무 루틴 항목(템플릿). 사장님이 등록·수정한다."""
    __tablename__ = "checklist_items"

    id = Column(Integer, primary_key=True, index=True)
    store_id = Column(String(100), nullable=False, index=True)   # 소속 매장(사장님 이메일)
    label = Column(String(120), nullable=False)                  # "마감 · 기계 청소"
    # 화면 정렬 순서. 오픈→마감 순으로 사장님이 배치한다.
    sort_order = Column(Integer, nullable=False, default=0)
    # 지우는 대신 끄면 지난 체크 기록이 보존된다 (통계·근태 확인용)
    active = Column(Boolean, nullable=False, default=True)
    # 담당 직원(staff_accounts.id). 없으면 공용 루틴 — 사장님이 특정 알바에게 지시할 때만 채운다.
    # FK를 걸지 않는 이유: 직원 계정을 지워도 항목은 남아야 하고(담당만 해제된 셈),
    # staff_accounts는 membership 도메인이라 테이블 생성 순서에 묶이고 싶지 않다.
    assigned_staff_id = Column(Integer, nullable=True)
    created_at = Column(DateTime(timezone=True), server_default=func.now(), nullable=False)


class ChecklistCheck(Base):
    """항목별 '그날' 체크 상태. (item_id, check_date)당 한 줄 = 그날 완료."""
    __tablename__ = "checklist_checks"
    # 같은 항목을 같은 날 두 번 체크해도 한 줄만 남게 막는다. 동시에 두 직원이 눌러도
    # 하나만 살아남는다 — 확인이 아니라 DB가 막아야 틈이 없다.
    __table_args__ = (UniqueConstraint("item_id", "check_date", name="uq_checklist_item_date"),)

    id = Column(Integer, primary_key=True, index=True)
    store_id = Column(String(100), nullable=False, index=True)
    item_id = Column(Integer, ForeignKey("checklist_items.id", ondelete="CASCADE"),
                     nullable=False, index=True)
    check_date = Column(Date, nullable=False, index=True)
    # 누가 체크했는지 — 사장님 화면에서 '오늘 마감을 누가 했나' 확인용 (직원 이름 또는 '사장님')
    done_by = Column(String(50), nullable=True)
    checked_at = Column(DateTime(timezone=True), server_default=func.now(), nullable=False)


def ensure_checklist_assignee_column(engine) -> None:
    """[자가치유 스키마] 기존 checklist_items에 assigned_staff_id(담당 직원)를 멱등 보강한다.

    담당 지정은 나중에 도입된 기능이라 그 전에 만들어진 DB에는 컬럼이 없다.
    create_all은 기존 테이블을 ALTER하지 않으므로 여기서 직접 보강한다.
    nullable이라 기존 항목은 전부 '공용 루틴'으로 남는다.
    """
    try:
        insp = inspect(engine)
        if not insp.has_table("checklist_items"):
            return  # 테이블 자체가 없으면 create_all이 스키마째로 생성한다
        existing = {c["name"] for c in insp.get_columns("checklist_items")}
    except Exception as e:
        logger.warning(f"[체크리스트 스키마] checklist_items 점검 실패 — 건너뜁니다: {e}")
        return
    if "assigned_staff_id" in existing:
        return
    try:
        with engine.begin() as conn:
            conn.execute(text("ALTER TABLE checklist_items ADD COLUMN assigned_staff_id INTEGER"))
        logger.info("[체크리스트 스키마] checklist_items.assigned_staff_id 컬럼 추가 완료")
    except Exception as e:
        logger.warning(f"[체크리스트 스키마] assigned_staff_id 보강 실패 — 담당 지정이 막힐 수 있습니다: {e}")
