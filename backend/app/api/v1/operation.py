"""운영 API (백엔드 C 최초 작성 → 백엔드 B 인수)"""
import os
import secrets as _secrets
from pathlib import Path
from typing import List, Optional
from fastapi import APIRouter, Header, Query, Depends, HTTPException, status
from sqlalchemy.orm import Session
from app.core.database import get_db
from app.core.auth import get_current_user, get_current_user_optional
from app.models.user import User
from app.models.operation import Employee, EmployeeUnavailability, Schedule, EstimatedPayroll
from app.schemas.operation import (
    CommonResponse, ScheduleCreate, ScheduleUpdate, ScheduleResponse,
    PayrollResponse, PayrollListItem, SettlementResponse,
    TaxEstimateRequest, TaxEstimateResponse, ForecastRequest, ForecastResponse,
    RAGDocumentResponse, ReportSourceResponse, PayrollCalculateRequest, PayrollCalculateResponse,
    SettlementCalculateRequest, SettlementCalculateResponse,
    ScheduleRecommendationRequest, ScheduleRecommendationResponse,
    ExpenseCreate, ExpenseResponse,
    EmployeeUnavailabilityCreate, EmployeeUnavailabilityResponse,
    EmployeeCreate, EmployeeUpdate, EmployeeResponse
)
from app.schemas.bean_rag import BeanRAGChatRequest, BeanSearchRequest, BeanRAGChatResponse, BeanSearchResponse, ReindexResponse
from app.services import cost_basis
from app.services.operation.operation_service import OperationService, EmployeeUnavailabilityService
from app.services.operation.curation_service import CurationFilterRequest, CuratedBeanResponse, curate_beans_by_preference
from app.services.operation.tax_service import TaxService
from app.services.operation.forecasting_service import ForecastingService
from app.models.user import User

router = APIRouter(prefix="/operation", tags=["Operation"])

# 수집·색인·시드 같은 유지보수 파이프라인의 공유 비밀 — 알림 크론과 같은 값을 쓴다.
# 예전엔 이 엔드포인트들이 인증 없이 열려 있어 curl 반복만으로 스크래핑·LLM·임베딩
# 파이프라인을 마음대로 돌릴 수 있었다 (비용·CPU DoS, 2026-08-06 감사).
_MAINTENANCE_SECRET = os.getenv("NOTIFICATION_CRON_SECRET", "")


def _require_maintenance_secret(x_cron_secret: str = Header(default="")) -> None:
    """유지보수 엔드포인트 관문 — 시크릿 미설정이면 존재 자체를 숨긴다(404)."""
    if not _MAINTENANCE_SECRET:
        raise HTTPException(status_code=404, detail="Not Found")
    if not _secrets.compare_digest(x_cron_secret, _MAINTENANCE_SECRET):
        raise HTTPException(status_code=403, detail="invalid maintenance secret")


@router.post("/beans/curate", response_model=CommonResponse)
def curate_beans_api(payload: CurationFilterRequest, limit: int = Query(20, ge=1, le=100), db: Session = Depends(get_db)):
    """
    [한글 주석]
    나만의 원두 취향 큐레이터 조건(산미, 바디감, 단맛, 쓴맛, 로스팅, 원산지, 가공방식, 카페인)을 수신하여 
    공용 DB에서 맞춤 추천 원두 리스트를 매칭률 높은 순으로 실시간 계산하여 반환합니다.
    """
    try:
        curated_beans = curate_beans_by_preference(db=db, req=payload, limit=limit)
        return CommonResponse(
            success=True,
            data=[b.model_dump() for b in curated_beans],
            message=f"공용 DB 기반 취향 맞춤 원두 {len(curated_beans)}건 추출 성공"
        )
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"큐레이터 추천 서버 오류: {str(e)}")


# ----------------------------------------------------
# [한글 주석] 전체 알바생(근무자) 관리 REST API (CRUD)
# ----------------------------------------------------

@router.get("/employees", response_model=CommonResponse)
def list_employees_api(
    db: Session = Depends(get_db),
    current_user: Optional[User] = Depends(get_current_user_optional),
):
    """알바생(근무자) 목록을 조회합니다. (로그인 매장 직원만)

    비로그인은 빈 목록 — 예전엔 토큰 없이 부르면 전 매장 직원의 이름·시급이 통째로
    나갔다 (2026-08-06 감사). 구버전 앱이 깨지지 않게 401 대신 빈 200을 준다.
    """
    try:
        if current_user is None:
            return CommonResponse(success=True, data=[], message="로그인 후 이용할 수 있습니다.")
        employees = OperationService.get_employees(db, store_id=current_user.email)
        data = [EmployeeResponse.model_validate(emp) for emp in employees]
        return CommonResponse(success=True, data=data, message="알바생 목록 조회가 완료되었습니다.")
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))


@router.post("/employees", response_model=CommonResponse)
def create_employee_api(
    payload: EmployeeCreate,
    db: Session = Depends(get_db),
    current_user: Optional[User] = Depends(get_current_user_optional),
):
    """신규 알바생을 로그인 매장 소속으로 등록합니다.

    비로그인 등록은 거부한다 — store_id가 NULL인 직원은 어느 매장 목록에도 안 보이는
    유령이 되면서, 예전 소유권 검사(NULL이면 통과)와 결합해 아무나 수정·삭제할 수 있었다.
    """
    if current_user is None:
        raise HTTPException(status_code=401, detail="로그인이 필요합니다.")
    try:
        emp = OperationService.create_employee(
            db=db,
            name=payload.name,
            hourly_rate=payload.hourly_rate,
            role=payload.role,
            store_id=current_user.email,
        )
        return CommonResponse(
            success=True,
            data=EmployeeResponse.model_validate(emp),
            message="알바생 등록이 완료되었습니다."
        )
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e))
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"서버 오류: {str(e)}")

@router.patch("/employees/{employee_id}", response_model=CommonResponse)
def update_employee_api(
    employee_id: int,
    payload: EmployeeUpdate,
    db: Session = Depends(get_db),
    current_user: Optional[User] = Depends(get_current_user_optional),
):
    """알바생 정보(이름, 시급, 직책)를 수정합니다. (로그인 매장 직원만)"""
    try:
        _assert_employee_owned(db, employee_id, current_user)
        emp = OperationService.update_employee(
            db=db,
            employee_id=employee_id,
            name=payload.name,
            hourly_rate=payload.hourly_rate,
            role=payload.role
        )
        if not emp:
            raise HTTPException(status_code=404, detail="수정할 알바생 정보를 찾을 수 없습니다.")
        return CommonResponse(
            success=True,
            data=EmployeeResponse.model_validate(emp),
            message="알바생 정보 수정이 완료되었습니다."
        )
    except HTTPException:
        raise
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e))
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"서버 오류: {str(e)}")

@router.delete("/employees/{employee_id}", response_model=CommonResponse)
def delete_employee_api(
    employee_id: int,
    db: Session = Depends(get_db),
    current_user: Optional[User] = Depends(get_current_user_optional),
):
    """알바생 퇴사/삭제 처리를 진행합니다. (로그인 매장 직원만)"""
    try:
        _assert_employee_owned(db, employee_id, current_user)
        success = OperationService.delete_employee(db, employee_id)
        if not success:
            raise HTTPException(status_code=404, detail="삭제할 알바생 정보를 찾을 수 없습니다.")
        return CommonResponse(success=True, data=None, message="알바생이 성공적으로 퇴사/삭제 처리되었습니다.")
    except HTTPException:
        raise
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))


@router.post("/schedules", response_model=CommonResponse)
def create_schedule_api(
    payload: ScheduleCreate,
    db: Session = Depends(get_db),
    current_user: Optional[User] = Depends(get_current_user_optional),
):
    """새로운 근무 계획 스케줄을 등록합니다. (로그인 매장 직원에게만)"""
    if payload.start_time >= payload.end_time:
        raise HTTPException(status_code=400, detail="근무 시작 시간은 종료 시간보다 빨라야 합니다.")
    try:
        _assert_employee_owned(db, payload.employee_id, current_user)
        schedule = OperationService.create_schedule(
            db=db,
            employee_id=payload.employee_id,
            start_time=payload.start_time,
            end_time=payload.end_time
        )
        return CommonResponse(
            success=True,
            data=ScheduleResponse.model_validate(schedule),
            message="스케줄 등록이 완료되었습니다."
        )
    except HTTPException:
        raise
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e))
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"서버 오류: {str(e)}")

@router.get("/schedules", response_model=CommonResponse)
def get_all_schedules_api(
    db: Session = Depends(get_db),
    current_user: Optional[User] = Depends(get_current_user_optional),
):
    """로그인 매장의 근무 스케줄을 조회합니다.

    [매장 스코핑] 예전엔 매장 구분 없이 전체 스케줄을 돌려줬다. 공유 DB라 다른 매장의
    근무가 내 달력에 섞여 들어왔고, 그 직원은 내 직원 목록에 없으니 화면에서
    '(삭제된 직원)'으로 표시됐다 — 실측 115건 중 내 것은 25건뿐이었다.
    """
    try:
        # 비로그인은 빈 목록 — 예전엔 전 매장 근무가 통째로 나갔다 (2026-08-06 감사)
        if current_user is None:
            return CommonResponse(success=True, data=[], message="로그인 후 이용할 수 있습니다.")
        schedules = OperationService.get_schedules(db, store_id=current_user.email)
        # 직원 이름을 여기서 붙여 보낸다 — 화면이 별도 조회로 맞추려다 실패하면
        # 근무가 전부 '(삭제된 직원)'으로 보였다. 조회 1번으로 id→이름 맵을 만든다.
        emp_ids = {s.employee_id for s in schedules}
        emp_map = {
            e.id: e for e in db.query(Employee).filter(Employee.id.in_(emp_ids)).all()
        } if emp_ids else {}
        data = []
        for s in schedules:
            item = ScheduleResponse.model_validate(s)
            emp = emp_map.get(s.employee_id)
            if emp is not None:
                item.employee_name = emp.name
                item.employee_role = emp.role
            data.append(item)
        return CommonResponse(success=True, data=data, message="스케줄 조회가 완료되었습니다.")
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))

@router.get("/schedules/{schedule_id}", response_model=CommonResponse)
def get_schedule_api(
    schedule_id: int,
    db: Session = Depends(get_db),
    current_user: Optional[User] = Depends(get_current_user_optional),
):
    """지정한 ID에 해당하는 특정 스케줄 일정을 단건 조회합니다. (로그인 매장 근무만)

    연번 id를 훑으면 남의 매장 직원 출퇴근 시각까지 읽히므로 변경과 같은 소유권 검사를 탄다.
    """
    try:
        _assert_schedule_owned(db, schedule_id, current_user)
        schedule = OperationService.get_schedule_by_id(db, schedule_id)
        if not schedule:
            raise HTTPException(status_code=404, detail="존재하지 않는 스케줄 번호입니다.")
        return CommonResponse(
            success=True,
            data=ScheduleResponse.model_validate(schedule),
            message="스케줄 조회가 완료되었습니다."
        )
    except HTTPException as e:
        raise e
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))

@router.patch("/schedules/{schedule_id}", response_model=CommonResponse)
def update_schedule_api(
    schedule_id: int,
    payload: ScheduleUpdate,
    db: Session = Depends(get_db),
    current_user: Optional[User] = Depends(get_current_user_optional),
):
    """스케줄 근무 시각 및 실제 출퇴근 시각을 수정(PATCH)합니다. (로그인 매장 근무만)"""
    try:
        _assert_schedule_owned(db, schedule_id, current_user)
        schedule = OperationService.update_schedule(db, schedule_id, payload)
        if not schedule:
            raise HTTPException(status_code=404, detail="수정할 스케줄 정보를 찾을 수 없습니다.")
        return CommonResponse(
            success=True,
            data=ScheduleResponse.model_validate(schedule),
            message="스케줄 정보 수정이 완료되었습니다."
        )
    except HTTPException:
        raise
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e))
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"서버 오류: {str(e)}")

def _assert_schedule_owned(db: Session, schedule_id: int, current_user: Optional[User]) -> None:
    """이 스케줄이 로그인 매장 직원의 것인지 확인한다.

    공유 DB에 여러 매장이 섞여 있고 schedule_id는 연번이라, 확인 없이 두면 옆 매장의
    근무를 지우거나 고칠 수 있다. 비로그인 변경은 거부한다 — 예전엔 '무검사 통과'라
    토큰 없이 아무 매장의 근무든 지울 수 있었다 (2026-08-06 감사).
    """
    if current_user is None:
        raise HTTPException(status_code=401, detail="로그인이 필요합니다.")
    row = (
        db.query(Employee.store_id)
        .join(Schedule, Schedule.employee_id == Employee.id)
        .filter(Schedule.id == schedule_id)
        .first()
    )
    # store_id가 NULL인 레거시 행도 '내 것 아님'으로 본다 — falsy 통과로 두면
    # 아무 매장이나 남의 NULL 직원 근무를 고치고 지울 수 있다.
    if row is not None and row[0] != current_user.email:
        raise HTTPException(status_code=404, detail="해당 스케줄을 찾을 수 없습니다.")


def _assert_employee_owned(db: Session, employee_id: int, current_user: Optional[User]) -> None:
    """이 직원이 로그인 매장 소속인지 확인한다 (스케줄과 같은 정책 — 비로그인은 거부).

    확인 없이 두면 employee_id 연번만 알면 옆 매장 직원을 수정·삭제하거나, 남의 직원에게
    근무·기피시간을 붙일 수 있다.
    """
    if current_user is None:
        raise HTTPException(status_code=401, detail="로그인이 필요합니다.")
    row = db.query(Employee.store_id).filter(Employee.id == employee_id).first()
    if row is not None and row[0] != current_user.email:
        raise HTTPException(status_code=404, detail="해당 직원을 찾을 수 없습니다.")


@router.delete("/schedules/{schedule_id}", response_model=CommonResponse)
def delete_schedule_api(
    schedule_id: int,
    db: Session = Depends(get_db),
    current_user: Optional[User] = Depends(get_current_user_optional),
):
    """특정 근무 스케줄 일정을 영구 삭제(Hard Delete)합니다."""
    try:
        _assert_schedule_owned(db, schedule_id, current_user)
        success = OperationService.delete_schedule(db, schedule_id)
        if not success:
            raise HTTPException(status_code=404, detail="삭제할 스케줄 정보를 찾을 수 없습니다.")
        return CommonResponse(success=True, data=None, message="스케줄 정보가 성공적으로 삭제되었습니다.")
    except HTTPException:
        raise
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))

@router.post("/schedules/recommend", response_model=CommonResponse)
def recommend_schedule_api(
    payload: ScheduleRecommendationRequest,
    db: Session = Depends(get_db),
    current_user: Optional[User] = Depends(get_current_user_optional),
):
    """실제 과거 매출 데이터를 시간대별로 분석하여 최적의 알바 근무 스케줄 추천안을 도출합니다.

    [매장 판정] payload.store_id는 믿지 않는다 — 항상 로그인 매장으로 계산하고,
    비로그인은 거부한다. 예전엔 토큰 없이 임의 store_id의 매출·직원 데이터로
    추천안을 뽑아볼 수 있었다 (2026-08-06 감사).
    """
    try:
        if current_user is None:
            raise HTTPException(status_code=401, detail="로그인이 필요합니다.")
        store_id = current_user.email
        recommendation_result = OperationService.recommend_schedule(
            db=db,
            period_start=payload.target_date,
            period_end=payload.target_date,
            store_id=store_id
        )
        data = ScheduleRecommendationResponse(
            target_date=recommendation_result["target_date"],
            hourly_recommendations=recommendation_result["hourly_recommendations"],
            total_recommended_hours=recommendation_result["total_recommended_hours"],
            estimated_payroll_cost=recommendation_result["estimated_payroll_cost"],
            warnings=recommendation_result.get("warnings", []),
            summary=recommendation_result["summary"]
        )
        return CommonResponse(
            success=True,
            data=data,
            message="스케줄 추천 연산이 완료되었습니다."
        )

    except HTTPException:
        raise  # 401 등 의도된 상태 코드가 아래 except에 삼켜져 500이 되지 않게
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e))
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"서버 오류: {str(e)}")


# ----------------------------------------------------
# 챗봇 / ERP 신규: 직원별 기피/불가 시간 API 엔드포인트
# ----------------------------------------------------

@router.post("/unavailability", response_model=CommonResponse)
def create_unavailability_api(
    payload: EmployeeUnavailabilityCreate,
    db: Session = Depends(get_db),
    current_user: Optional[User] = Depends(get_current_user_optional),
):
    """직원의 기피/불가 시간(Hard/Soft)을 신규 등록합니다. (로그인 매장 직원에게만)"""
    try:
        _assert_employee_owned(db, payload.employee_id, current_user)
        unav = EmployeeUnavailabilityService.create_unavailability(db, payload)
        return CommonResponse(
            success=True,
            data=EmployeeUnavailabilityResponse.model_validate(unav),
            message="직원 기피/불가 시간 등록이 완료되었습니다."
        )
    except HTTPException:
        raise
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e))
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"서버 오류: {str(e)}")


@router.get("/unavailability", response_model=CommonResponse)
def list_unavailabilities_api(
    employee_id: Optional[int] = Query(None, description="특정 직원만 조회할 직원 ID (생략 시 전체)"),
    db: Session = Depends(get_db),
    current_user: Optional[User] = Depends(get_current_user_optional),
):
    """등록된 직원 기피/불가 시간 목록을 조회합니다. (로그인 매장 직원 것만)

    [매장 스코핑] 예전엔 전 매장 직원의 기피시간과 이름을 통째로 돌려줬다 — 공유 DB라
    남의 매장 직원 이름이 노출됐다. 로그인 매장 직원으로 한정한다(비로그인은 기존 동작).
    """
    try:
        # 비로그인은 빈 목록 — 예전엔 전 매장 직원의 기피시간·이름이 통째로 나갔다
        if current_user is None:
            return CommonResponse(success=True, data=[], message="로그인 후 이용할 수 있습니다.")
        # 직원 조회는 한 번만 — 같은 쿼리를 id용·이름용으로 두 번 돌리고 있었다
        store_emps = db.query(Employee).filter(Employee.store_id == current_user.email).all()
        store_emp_ids = {e.id for e in store_emps}
        # 남의 매장 직원 id를 콕 집어 조회하려 해도 빈 목록으로 막는다
        rows = [
            u for u in EmployeeUnavailabilityService.get_unavailabilities(db, employee_id)
            if u.employee_id in store_emp_ids
        ]
        name_map = {e.id: e.name for e in store_emps}
        data = []
        for unav in rows:
            item = EmployeeUnavailabilityResponse.model_validate(unav)
            item.employee_name = name_map.get(unav.employee_id)
            data.append(item)
        return CommonResponse(
            success=True,
            data=data,
            message="직원 기피/불가 시간 목록 조회가 완료되었습니다."
        )
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"서버 오류: {str(e)}")


@router.delete("/unavailability/{unavailability_id}", response_model=CommonResponse)
def delete_unavailability_api(
    unavailability_id: int,
    db: Session = Depends(get_db),
    current_user: Optional[User] = Depends(get_current_user_optional),
):
    """등록된 직원 기피/불가 시간 설정을 삭제합니다. (로그인 매장 직원 것만)"""
    try:
        # 이 기피시간이 로그인 매장 직원의 것인지 먼저 확인한다 (연번 id로 남의 것 삭제 방지)
        owner = db.query(EmployeeUnavailability.employee_id).filter(
            EmployeeUnavailability.id == unavailability_id).first()
        if owner is not None:
            _assert_employee_owned(db, owner[0], current_user)
        deleted = EmployeeUnavailabilityService.delete_unavailability(db, unavailability_id)
        if not deleted:
            raise HTTPException(status_code=404, detail=f"존재하지 않는 기피 시간 ID입니다: {unavailability_id}")
        return CommonResponse(
            success=True,
            data=None,
            message="직원 기피/불가 시간 삭제가 완료되었습니다."
        )
    except HTTPException:
        raise
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"서버 오류: {str(e)}")


# GET /settlements/estimated 제거됨:
#   estimated_settlements 테이블에 쓰는 코드가 어디에도 없고(계산은 /settlements/calculate가
#   실시간으로 함), 프론트도 호출하지 않으며, 모델에 store_id가 없어 매장 격리도 불가능했다.
#   → 항상 빈 배열만 주는 오해 소지의 죽은 엔드포인트라 삭제한다. 실시간 정산은
#   POST /settlements/calculate가 담당한다. (모델/테이블은 마이그레이션 이력이라 그대로 둠)


# --- [지출(Expense) 관리] ---

@router.post("/expenses", response_model=CommonResponse)
def create_expense_api(
    payload: ExpenseCreate,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user)
):
    """새 지출(비용) 내역을 등록합니다. (정산·세무의 비용 데이터 소스)"""
    try:
        expense = OperationService.create_expense(
            db=db,
            store_id=current_user.email,
            amount=payload.amount,
            category=payload.category,
            expense_date=payload.expense_date,
            description=payload.description,
        )
        return CommonResponse(
            success=True,
            data=ExpenseResponse.model_validate(expense),
            message="지출 내역 등록이 완료되었습니다."
        )
    except ValueError as e:
        return CommonResponse(success=False, data=None, message=str(e))
    except Exception as e:
        return CommonResponse(success=False, data=None, message=f"서버 오류: {str(e)}")

@router.get("/expenses", response_model=CommonResponse)
def get_expenses_api(
    year_month: Optional[str] = Query(None, description="조회 대상 연월 (YYYY-MM). 생략 시 전체"),
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user)
):
    """등록된 지출(비용) 내역을 조회합니다. (해당 매장 기준)"""
    try:
        expenses = OperationService.get_expenses(db, year_month=year_month, store_id=current_user.email)
        data = [ExpenseResponse.model_validate(e) for e in expenses]
        return CommonResponse(success=True, data=data, message="지출 내역 조회가 완료되었습니다.")
    except Exception as e:
        return CommonResponse(success=False, data=None, message=f"서버 오류: {str(e)}")


# --- [세무 계산] ---

@router.get("/tax/estimate", response_model=CommonResponse)
def estimate_tax_api(
    year_month: str = Query(..., description="대상 연월 (YYYY-MM)"),
    tax_type: str = Query("general", description="과세유형 (general 일반 | simplified 간이)"),
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user)
):
    """DB의 매출·비용·인건비를 자동집계해 부가세+종소세+원천징수 예상 세금을 계산합니다."""
    try:
        # 로그인한 매장 몫만 집계 — store_id=None이면 전 매장 합산이라 다른 매장 수치가 섞였다
        result = TaxService.estimate_taxes(db, year_month, tax_type=tax_type, store_id=current_user.email)
        return CommonResponse(
            success=True,
            data=TaxEstimateResponse(**result),
            message="세무 예상 계산이 완료되었습니다."
        )
    except ValueError as e:
        return CommonResponse(success=False, data=None, message=str(e))
    except Exception as e:
        return CommonResponse(success=False, data=None, message=f"서버 오류: {str(e)}")

@router.post("/tax/estimate", response_model=CommonResponse)
def estimate_tax_manual_api(payload: TaxEstimateRequest):
    """매출·비용을 직접 입력받아 부가세+종소세를 계산합니다. (수동/일회성)"""
    try:
        result = TaxService.estimate_from_amounts(
            total_revenue=payload.total_revenue,
            total_expense=payload.total_expense,
            period=payload.period,
            tax_type=payload.tax_type,
        )
        return CommonResponse(
            success=True,
            data=TaxEstimateResponse(**result),
            message="세무 예상 계산이 완료되었습니다."
        )
    except ValueError as e:
        return CommonResponse(success=False, data=None, message=str(e))
    except Exception as e:
        return CommonResponse(success=False, data=None, message=f"서버 오류: {str(e)}")

@router.post("/forecast/sales", response_model=CommonResponse)
def get_sales_forecast_api(
    payload: ForecastRequest,
    db: Session = Depends(get_db),
    current_user: Optional[User] = Depends(get_current_user_optional),
):
    """미래 일자의 판매량·매출액을 예측합니다. (sales_data 생략 시 DB 자동집계, ARIMA 기본)

    [매장 판정] DB 자동집계는 로그인 필수이고 payload.store_id는 무시한다 — 예전엔
    토큰 없이 임의 store_id의 매출 기반 예측을 뽑을 수 있었다 (2026-08-06 감사).
    sales_data를 직접 넣는 순수 계산은 DB를 안 보므로 그대로 연다.
    """
    try:
        if payload.sales_data is None:
            if current_user is None:
                raise HTTPException(status_code=401, detail="로그인이 필요합니다.")
            store_id = current_user.email
        else:
            store_id = payload.store_id
        result = ForecastingService.forecast_sales(
            target_date=payload.target_date,
            sales_data=payload.sales_data,
            db=db,
            store_id=store_id,
            has_event=payload.has_event,
            engine=payload.engine or "arima",
        )
        data = ForecastResponse(**result)
        return CommonResponse(
            success=True,
            data=data,
            message="판매 예측 계산이 완료되었습니다."
        )
    except HTTPException:
        raise  # 401이 success=False 200으로 뭉개지지 않게
    except ValueError as e:
        return CommonResponse(success=False, data=None, message=str(e))
    except Exception as e:
        return CommonResponse(success=False, data=None, message=f"서버 오류: {str(e)}")

@router.post("/rag/documents", response_model=CommonResponse)
def get_rag_documents_api(payload: dict):
    """세무 계산 결과 및 판매 예측 데이터를 RAG 탐색기가 해독하기 쉬운 문서 형식으로 일괄 변환합니다."""
    try:
        rag_documents = []
        
        # 세무 결과 파싱 및 RAG 문서화
        tax_data = payload.get("tax_result")
        if tax_data:
            tax_doc = OperationService.build_tax_rag_documents(tax_data)
            rag_documents.append(RAGDocumentResponse(**tax_doc))
            
        # 판매 예측 결과 파싱 및 RAG 문서화
        forecast_data = payload.get("forecast_result")
        if forecast_data:
            forecast_doc = OperationService.build_forecast_rag_documents(forecast_data)
            rag_documents.append(RAGDocumentResponse(**forecast_doc))
            
        return CommonResponse(
            success=True,
            data=rag_documents,
            message="RAG 문서 변환이 완료되었습니다."
        )
    except Exception as e:
        return CommonResponse(
            success=False,
            data=None,
            message=f"RAG 문서 가공 실패: {str(e)}"
        )


@router.get("/report-source", response_model=CommonResponse)
def get_report_source_api(period: str = Query("weekly", description="리포트 기준 기간 (daily, weekly, monthly)")):
    # 백엔드 B 및 챗봇 리포트엔진을 위해 자연어로 작성된 운영 요약 리포트 원천을 조회합니다.

    try:
        report_data = OperationService.build_report_source_documents(period)
        data = ReportSourceResponse(
            period=report_data["period"],
            sales_summary=report_data["sales_summary"],
            payroll_summary=report_data["payroll_summary"],
            tax_summary=report_data["tax_summary"],
            forecast_summary=report_data["forecast_summary"]
        )
        return CommonResponse(
            success=True,
            data=data,
            message="리포트 소스 조회가 완료되었습니다."
        )
    except Exception as e:
        return CommonResponse(
            success=False,
            data=None,
            message=str(e)
        )


# --- [5. Square POS 연동 및 재고 자동 차감 API] ---

@router.post("/pos/sync", response_model=CommonResponse)
async def sync_pos_data_api(
    hours: int = Query(24, description="동기화할 최근 시간 범위 (기본 24시간)"),
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user)
):
    # [Square POS 데이터 동기화 및 실시간 재고 차감]

    try:
        from app.services._pos import sync_pos_to_sales
        result = await sync_pos_to_sales(db=db, store_id=current_user.email, hours=hours)
        return CommonResponse(
            success=True,
            data=result,
            message="POS 데이터 및 실시간 재고 차감 동기화가 정상 완료되었습니다!"
        )
    except Exception as e:
        return CommonResponse(
            success=False,
            data=None,
            message=f"POS 동기화 실패: {str(e)}"
        )


# --- [6. 예상 급여 및 예상 손익 정산 계산 API (MVP)] ---

@router.post("/payroll/calculate", response_model=CommonResponse, summary="예상 급여 계산 (MVP + 옵션 A/B)")
def calculate_payroll_api(payload: PayrollCalculateRequest):
    # [예상 급여 계산 API]

    try:
        result = OperationService.calculate_payroll(
            start_time=payload.start_time,
            end_time=payload.end_time,
            break_minutes=payload.break_minutes,
            hourly_rate=payload.hourly_rate,
            weekly_work_hours=payload.weekly_work_hours,
            include_weekly_holiday=payload.include_weekly_holiday,
            deduct_tax=payload.deduct_tax
        )
        response_payload = PayrollCalculateResponse(**result)
        return CommonResponse(
            success=True,
            data=response_payload.model_dump(),
            message="예상 급여 계산이 완료되었습니다."
        )
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e))
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"서버 오류가 발생했습니다: {str(e)}")


@router.get("/payroll/all", response_model=CommonResponse, summary="전체 직원 월별 예상 급여 목록")
def list_all_payroll_api(
    year_month: str = Query(..., description="조회 대상 연월 (YYYY-MM)"),
    db: Session = Depends(get_db),
    current_user: Optional[User] = Depends(get_current_user_optional),
):
    """등록된 모든 직원의 해당 월 예상 급여 목록을 조회합니다. (해당 월 스케줄이 없는 직원은 제외)"""
    import re
    if not re.fullmatch(r"\d{4}-\d{2}", year_month):
        raise HTTPException(status_code=400, detail="year_month는 YYYY-MM 형식이어야 합니다.")
    try:
        # 비로그인은 빈 목록 — 예전엔 전 매장 직원의 급여가 통째로 나갔다 (2026-08-06 감사)
        if current_user is None:
            return CommonResponse(success=True, data=[], message="로그인 후 이용할 수 있습니다.")
        results = OperationService.list_employees_payroll(
            db, year_month, store_id=current_user.email)
        return CommonResponse(
            success=True,
            data=results,
            message="전체 직원 예상 급여 목록 조회가 완료되었습니다."
        )
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"서버 오류: {str(e)}")


@router.post("/settlements/calculate", response_model=CommonResponse, summary="예상 손익 정산 계산 (MVP)")
def calculate_settlement_api(
    payload: SettlementCalculateRequest,
    db: Session = Depends(get_db),
    current_user: Optional[User] = Depends(get_current_user_optional),
):
    # [예상 손익 정산 계산 API]
    # 기간 집계(DB 조회)는 로그인 필수 — 예전엔 토큰 없이 전 매장 매출·지출·급여 합계가
    # 나갔다 (2026-08-06 감사). 매출·비용을 직접 넣는 수동 계산은 DB를 안 보므로 그대로 연다.
    if payload.period_start and payload.period_end and current_user is None:
        raise HTTPException(status_code=401, detail="로그인이 필요합니다.")
    store_id = current_user.email if current_user else None

    try:
        revenue = payload.revenue
        cost = payload.cost
        labor_cost = payload.labor_cost
        other_expense = payload.other_expense or 0
        # 수동 입력 경로는 사장님이 직접 넣은 숫자라 무엇이 들었는지 알 수 없다 — 경고하지 않는다
        fixed_cost_missing = False

        # [한글 주석: 프론트엔드 모바일 앱이 기간 정보를 꽂아 보냈다면, DB에서 일체 실시간 집계를 수행합니다]
        if payload.period_start and payload.period_end:
            from datetime import datetime, timedelta
            from sqlalchemy import func
            from app.models.inventory import Sale
            from app.models.operation import Expense
            
            # 1. 날짜 경계선 파싱 (마지막 날 23:59:59 누락을 막기 위해 종료일의 익일 0시 미만으로 안전하게 검색)
            # sold_at은 timestamptz — naive 경계를 주면 UTC 자정으로 잘려 KST 00:00~08:59
            # 매출이 전날 정산에 들어간다. 경계에 KST를 명시한다.
            from app.utils.datetime_kst import KST
            try:
                p_start_dt = datetime.strptime(payload.period_start, "%Y-%m-%d").replace(tzinfo=KST)
                p_end_dt = datetime.strptime(payload.period_end, "%Y-%m-%d").replace(tzinfo=KST) + timedelta(days=1)
            except ValueError:
                raise HTTPException(status_code=400, detail="날짜 포맷은 YYYY-MM-DD 형식이어야 합니다.")

            # 2. 지정 기간 총 매출(Sale) 자동 집계 — 토큰 있으면 로그인 매장 몫만
            sales_q = db.query(func.sum(Sale.total_price)).filter(
                Sale.sold_at >= p_start_dt,
                Sale.sold_at < p_end_dt
            )
            if store_id:
                sales_q = sales_q.filter(Sale.store_id == store_id)
            revenue = int(sales_q.scalar() or 0)

            # 3. 지정 기간 총 지출 비용(Expense) 자동 집계 — 매장별 스코핑
            expense_q = db.query(Expense.category, func.sum(Expense.amount)).filter(
                Expense.expense_date >= payload.period_start,
                Expense.expense_date <= payload.period_end
            )
            if store_id:
                expense_q = expense_q.filter(Expense.store_id == store_id)
            expense_rows = expense_q.group_by(Expense.category).all()
            cost = int(sum(amount or 0 for _, amount in expense_rows))
            # 지출은 사장님이 손으로 넣는 표라 임대료가 대개 없다. 그러면 월세가 통째로 빠진
            # 금액이 '순이익'으로 찍힌다 — 월세 200만원 매장은 200만원을 벌고 있다고 믿게 된다.
            # 경영 리포트와 같은 규칙(cost_basis)을 쓴다: 두 화면이 다르게 말하면 안 된다.
            fixed_cost_missing = not cost_basis.has_fixed_cost(c for c, _ in expense_rows)

            # 4. 지정 월 총 인건비(labor_cost) 자동 집계 — 해당 매장 직원 급여만 합산
            year_month = payload.period_start[:7]
            employees_payroll = OperationService.list_employees_payroll(db, year_month, store_id=store_id)
            labor_cost = sum(payroll.get("estimated_salary", 0) for payroll in employees_payroll)

        # [한글 주석: 두 경로 모두 유효 데이터가 확보되지 않았다면 에러를 리턴합니다]
        if revenue is None or cost is None or labor_cost is None:
            raise HTTPException(
                status_code=422,
                detail="수동 정산용 매출/비용/인건비 정보 또는 실시간 집계용 기간 정보(period_start/end)를 입력해 주세요."
            )

        result = OperationService.calculate_settlement(
            revenue=revenue,
            cost=cost,
            labor_cost=labor_cost,
            other_expense=other_expense
        )
        response_payload = SettlementCalculateResponse(**result)
        data = response_payload.model_dump()
        # 프론트 정산 카드가 쓰는 total_* 네이밍 호환 필드 (total_sales/expense/payroll/net_profit)
        data.update({
            "total_sales": data["revenue"],
            "total_expense": data["cost"],
            "total_payroll": data["labor_cost"],
            "net_profit": data["estimated_profit"],
            # 임대료가 안 잡힌 매장에서는 화면이 이걸 보고 '순이익'이라 쓰지 않는다
            "fixed_cost_missing": fixed_cost_missing,
            "year_month": (payload.period_start or "")[:7] or None,
            "period_start": payload.period_start,
            "period_end": payload.period_end,
        })
        return CommonResponse(
            success=True,
            data=data,
            message="예상 정산 결과 계산이 완료되었습니다."
        )
    except HTTPException:
        raise  # 날짜 포맷 400 등 의도된 4xx가 아래 except Exception에 삼켜져 500이 되던 문제
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e))
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"서버 오류가 발생했습니다: {str(e)}")


# ----------------------------------------------------
# 원두 추천/리뷰 실데이터 파이프라인 & RAG 고도화 API 엔드포인트
# ----------------------------------------------------

@router.post("/beans/seed-import", response_model=CommonResponse, summary="원두 시드 데이터(JSON/CSV) 일괄 적재 API")
def import_bean_seed_api(
    beans_file: Optional[str] = Query(None, description="원두 시드 파일 경로 (.json 또는 .csv)"),
    db: Session = Depends(get_db),
    _: None = Depends(_require_maintenance_secret),
):
    # [원두 시드 일괄 적재 API]
    # 경로는 프로젝트 안의 .json/.csv만 허용한다 — 임의 경로를 그대로 open()하면
    # 서버가 읽을 수 있는 아무 파일이나 적재→조회로 빼낼 수 있다 (2026-08-06 감사).
    if beans_file:
        project_root = Path(__file__).resolve().parents[4]
        try:
            resolved = Path(beans_file).resolve()
        except OSError:
            raise HTTPException(status_code=400, detail="경로를 해석할 수 없습니다.")
        if resolved.suffix.lower() not in {".json", ".csv"} or not resolved.is_relative_to(project_root):
            raise HTTPException(status_code=400, detail="프로젝트 안의 .json/.csv 파일만 지정할 수 있습니다.")
    try:
        from app.services.operation.seed_service import import_seed_roasteries_and_beans
        res = import_seed_roasteries_and_beans(db, beans_file=beans_file)
        return CommonResponse(
            success=res.get("success", True),
            data=res,
            message=res.get("message", "원두 시드 데이터 적재 완료")
        )
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"시드 적재 중 오류 발생: {str(e)}")


@router.post("/beans/collect", response_model=CommonResponse, summary="원두 판매처·가격 및 리뷰 외부 수집 파이프라인 API")
def collect_beans_data_api(db: Session = Depends(get_db),
                           _: None = Depends(_require_maintenance_secret)):
    # [원두 실데이터 수집 파이프라인 API]
    try:
        from app.services.operation.bean_collection_service import run_collection_pipeline_for_all_beans
        res = run_collection_pipeline_for_all_beans(db)
        return CommonResponse(
            success=res.get("success", True),
            data=res,
            message=res.get("message", "원두 데이터 수집 완료")
        )
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"데이터 수집 파이프라인 실행 중 오류 발생: {str(e)}")


@router.post("/beans/aggregate-reviews", response_model=CommonResponse, summary="원두 리뷰 평점/감성/키워드 집계 스냅샷 갱신 API")
def aggregate_bean_reviews_api(db: Session = Depends(get_db),
                               _: None = Depends(_require_maintenance_secret)):
    # [원두 리뷰 집계 스냅샷 갱신 API]
    try:
        from app.services.operation.bean_review_service import update_all_bean_review_summaries
        res = update_all_bean_review_summaries(db)
        return CommonResponse(
            success=res.get("success", True),
            data=res,
            message=res.get("message", "리뷰 집계 스냅샷 갱신 완료")
        )
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"리뷰 집계 스냅샷 갱신 중 오류 발생: {str(e)}")


@router.post("/beans/index-vectorstore", response_model=CommonResponse, summary="ChromaDB 벡터스토어 리뷰/속성 전체/증분 색인 API")
def index_beans_vectorstore_api(
    full_reindex: bool = Query(False, description="True 설정 시 전체 초기 색인, False 설정 시 증분 색인"),
    db: Session = Depends(get_db),
    _: None = Depends(_require_maintenance_secret),
):
    # [ChromaDB 벡터스토어 색인 API] 쌓인 리뷰 및 원두 속성을 ChromaDB에 색인합니다.

    try:
        from app.services.operation.bean_review_service import index_reviews_to_chromadb
        res = index_reviews_to_chromadb(db, full_reindex=full_reindex)
        return CommonResponse(
            success=res.get("success", True),
            data=res,
            message=res.get("message", "ChromaDB 색인 완료")
        )
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"ChromaDB 색인 중 오류 발생: {str(e)}")


# ----------------------------------------------------
# 원두 챗봇 RAG 고도화 신규 API 엔드포인트
# ----------------------------------------------------

@router.post("/beans/chat", response_model=CommonResponse, summary="원두 챗봇 RAG 자연어 질의응답 (Grounded 답변+근거+신뢰도) API")
def bean_rag_chat_api(
    payload: BeanRAGChatRequest,
    db: Session = Depends(get_db),
    current_user: Optional[User] = Depends(get_current_user_optional),
):
    # [원두 챗봇 RAG 자연어 답변 API] 하이브리드 검색 및 Gemini LLM 근거 기반 답변, Grounding, Confidence 반환
    # Gemini 호출이 들어가므로 비로그인 개방 시 팀 공유 쿼터가 외부에서 소진될 수 있다 — 로그인 필수.
    if current_user is None:
        raise HTTPException(status_code=401, detail="로그인이 필요합니다.")
    try:
        from app.services.operation.bean_rag_service import generate_grounded_answer_service
        res = generate_grounded_answer_service(db, payload)
        return CommonResponse(
            success=True,
            data=res.model_dump(),
            message="원두 RAG 답변 생성이 완료되었습니다."
        )
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"원두 RAG 답변 생성 실패: {str(e)}")


@router.post("/beans/search", response_model=CommonResponse, summary="원두 하이브리드 검색 Top-K 결과 반환 API")
def bean_hybrid_search_api(
    payload: BeanSearchRequest,
    db: Session = Depends(get_db)
):
    # [원두 하이브리드 검색 API] 가중합 점수(유사도 50% + 속성 30% + 신뢰도 20%) 하이브리드 검색
    try:
        from app.services.operation.bean_rag_service import hybrid_bean_search_service
        res = hybrid_bean_search_service(db, payload)
        return CommonResponse(
            success=True,
            data=res.model_dump(),
            message=f"원두 하이브리드 검색 완료 ({res.total_count}건)"
        )
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"원두 하이브리드 검색 실패: {str(e)}")




@router.post("/rag/reindex", response_model=CommonResponse, summary="collected_at 시각 기준 원두 리뷰 증분 색인 API")
def trigger_incremental_reindex_api(
    full_reindex: bool = Query(False, description="True 설정 시 전체 재색인, False 설정 시 증분 색인"),
    db: Session = Depends(get_db),
    _: None = Depends(_require_maintenance_secret),
):
    # [증분 색인 트리거 API] collected_at 기준 신규 수집된 리뷰만 선택하여 고정된 임베딩 모델로 벡터스토어에 증분 임베딩 수행
    try:
        from app.services.operation.bean_rag_service import incremental_reindex_service
        res = incremental_reindex_service(db, full_reindex=full_reindex)
        return CommonResponse(
            success=res.success,
            data=res.model_dump(),
            message=res.message
        )
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"증분 색인 실행 실패: {str(e)}")


# ----------------------------------------------------
# 상품 검색·정렬·오퍼·사전수집 신규 API 엔드포인트
# ----------------------------------------------------

@router.get("/products/search", response_model=CommonResponse, summary="상품 검색·정렬·필터·대체추천 통합 API")
def search_products_api(
    q: Optional[str] = Query(None, description="검색 키워드"),
    sort: str = Query("price_asc", description="정렬 방식 (price_asc 최저가 | price_desc | review_count | relevance)"),
    order: str = Query("asc", description="정렬 차순"),
    min_price: Optional[int] = Query(None, description="최소 가격"),
    max_price: Optional[int] = Query(None, description="최대 가격"),
    in_stock: Optional[bool] = Query(None, description="재고 보유 상품만 조회"),
    source_site: Optional[str] = Query(None, description="판매처 필터"),
    min_rating: Optional[float] = Query(None, description="최소 평점"),
    page: int = Query(1, ge=1, description="페이지 번호"),
    page_size: int = Query(10, ge=1, le=100, description="페이지 당 개수"),
    db: Session = Depends(get_db)
):
    # [상품 검색·정렬·대체추천 API]
    try:
        from app.schemas.product_search import ProductSearchQuery
        from app.services.operation.product_search_service import search_products_service

        query_params = ProductSearchQuery(
            q=q,
            sort=sort,
            order=order,
            min_price=min_price,
            max_price=max_price,
            in_stock=in_stock,
            source_site=source_site,
            min_rating=min_rating,
            page=page,
            page_size=page_size
        )
        res = search_products_service(db, query_params)
        return CommonResponse(
            success=True,
            data=res.model_dump(),
            message=f"상품 검색 완료 ({res.total_count}건)"
        )
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"상품 검색 실패: {str(e)}")


@router.get("/beans/{id}/offers", response_model=CommonResponse, summary="특정 원두 판매처별 오퍼 및 최저가 조회 API")
def get_bean_offers_api(
    id: int,
    sort: str = Query("price", description="정렬 방식 (price 최저가 | review 리뷰순)"),
    db: Session = Depends(get_db)
):
    # [원두 오퍼/최저가 조회 API]
    try:
        from app.services.operation.product_search_service import get_bean_offers_service
        res = get_bean_offers_service(db, bean_id=id, sort=sort)
        return CommonResponse(
            success=True,
            data=res.model_dump(),
            message=f"'{res.bean_name}' 오퍼 조회가 완료되었습니다."
        )
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e))
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"원두 오퍼 조회 실패: {str(e)}")


@router.post("/products/prefetch", response_model=CommonResponse, summary="사전 수집 큐 등록 및 오래된 시세 캐시 갱신 API")
def prefetch_products_api(
    payload: Optional[dict] = None,
    db: Session = Depends(get_db),
    _: None = Depends(_require_maintenance_secret),
):
    # [사전 수집 및 캐시 갱신 API]
    try:
        from app.schemas.product_search import PrefetchRequest
        from app.services.operation.product_search_service import prefetch_and_refresh_cache_service

        req = PrefetchRequest(**payload) if payload else PrefetchRequest()
        res = prefetch_and_refresh_cache_service(db, req)
        return CommonResponse(
            success=res.success,
            data=res.model_dump(),
            message=res.message
        )
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"사전 수집 처리 실패: {str(e)}")



