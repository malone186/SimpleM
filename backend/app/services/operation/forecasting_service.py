"""판매예측 로직 (백엔드 C 최초 작성 → 백엔드 B 인수)

ARIMA 시계열 모델로 미래 일자의 매출·판매량을 예측한다.
데이터가 부족하거나 모델 학습이 실패하면 단순 이동평균으로 graceful fallback 한다.
입력은 요청 body(sales_data) 또는 DB Sale 테이블 자동집계 둘 다 지원한다.
"""
import os
import pickle
import warnings
import logging
from datetime import datetime
from typing import Any, List, Optional, Tuple

logger = logging.getLogger(__name__)

# ARIMA 학습 최소 데이터 일수 (미만이면 이동평균 폴백)
MIN_POINTS_ARIMA = 14
# 기본 ARIMA 차수 (p, d, q)
DEFAULT_ARIMA_ORDER = (1, 1, 1)
# 학습된 모델 아티팩트 저장 경로
ARTIFACT_DIR = os.path.join(os.path.dirname(os.path.dirname(__file__)), "..", "ml", "artifacts")


class ForecastingService:
    """일별 판매 데이터로부터 매출·판매량을 예측하는 서비스 클래스"""

    # ---------- 데이터 정규화 ----------

    @staticmethod
    def _normalize_series(sales_data: List[Any]) -> Tuple[List[str], List[float], List[float]]:
        """dict 또는 객체 리스트를 (dates, revenues, quantities)로 정규화합니다."""
        dates: List[str] = []
        revenues: List[float] = []
        quantities: List[float] = []
        for item in sales_data:
            if isinstance(item, dict):
                d, rev, qty = item.get("date"), item.get("revenue", 0), item.get("quantity", 0)
            else:
                d = getattr(item, "date", None)
                rev = getattr(item, "revenue", 0)
                qty = getattr(item, "quantity", 0)
            dates.append(str(d))
            revenues.append(float(rev or 0))
            quantities.append(float(qty or 0))
        return dates, revenues, quantities

    @staticmethod
    def _horizon_steps(last_date: Optional[str], target_date: str) -> int:
        """마지막 관측일과 예측 대상일 사이의 예측 스텝 수(최소 1)를 계산합니다."""
        try:
            target = datetime.strptime(target_date, "%Y-%m-%d").date()
            last = datetime.strptime(last_date, "%Y-%m-%d").date()
            return max((target - last).days, 1)
        except (ValueError, TypeError):
            return 1

    # ---------- 예측 엔진 ----------

    @staticmethod
    def _forecast_arima(values: List[float], steps: int) -> Optional[float]:
        """ARIMA로 steps 이후 값을 예측합니다. 실패 시 None 반환(폴백 유도)."""
        try:
            from statsmodels.tsa.arima.model import ARIMA

            with warnings.catch_warnings():
                warnings.simplefilter("ignore")
                model = ARIMA(values, order=DEFAULT_ARIMA_ORDER)
                fitted = model.fit()
                forecast = fitted.forecast(steps=steps)
            predicted = float(forecast[-1])
            return max(predicted, 0.0)
        except Exception as e:  # 수렴 실패·특이행렬 등
            logger.warning("ARIMA 예측 실패, 이동평균 폴백: %s", e)
            return None

    @staticmethod
    def _forecast_moving_average(values: List[float], window: int = 7) -> float:
        """최근 window일 단순 이동평균을 예측값으로 사용합니다."""
        if not values:
            return 0.0
        recent = values[-window:] if len(values) >= window else values
        return sum(recent) / len(recent)

    # ---------- 메인 진입점 ----------

    @classmethod
    def forecast_sales(
        cls,
        target_date: str,
        sales_data: Optional[List[Any]] = None,
        db: Any = None,
        store_id: Optional[str] = None,
        has_event: bool = False,
        engine: str = "arima",
    ) -> dict:
        """지정일의 예상 매출·판매량을 예측합니다.
        - sales_data 제공 시 그대로 사용, 없으면 db에서 자동집계
        - engine: 'arima'(기본) 또는 'average'(강제 이동평균)
        - 데이터 부족/모델 실패 시 이동평균으로 폴백
        """
        # 1. 데이터 확보 (요청 우선, 없으면 DB 집계)
        if not sales_data:
            if db is None:
                raise ValueError("sales_data 또는 DB 세션(db) 중 하나는 반드시 필요합니다.")
            from app.services.operation.operation_service import OperationService
            sales_data = OperationService.get_daily_sales_series(db, store_id=store_id)

        if not sales_data:
            raise ValueError("예측에 사용할 판매 데이터가 없습니다.")

        dates, revenues, quantities = cls._normalize_series(sales_data)
        total_days = len(dates)
        steps = cls._horizon_steps(dates[-1] if dates else None, target_date)

        # 2. 엔진 선택 (데이터 충분하고 arima 요청 시 ARIMA, 아니면 이동평균)
        used_engine = "average"
        pred_sales = pred_qty = None
        if engine == "arima" and total_days >= MIN_POINTS_ARIMA:
            pred_sales = cls._forecast_arima(revenues, steps)
            pred_qty = cls._forecast_arima(quantities, steps)
            if pred_sales is not None and pred_qty is not None:
                used_engine = "arima"

        if used_engine == "average" or pred_sales is None or pred_qty is None:
            pred_sales = cls._forecast_moving_average(revenues)
            pred_qty = cls._forecast_moving_average(quantities)

        # 3. 이벤트 보정
        if has_event:
            pred_sales *= 1.2
            pred_qty *= 1.2

        predicted_sales = int(round(pred_sales))
        predicted_quantity = int(round(pred_qty))

        # 4. 근거 요약
        engine_label = "ARIMA 시계열 모델" if used_engine == "arima" else "단순 이동평균(데이터 부족/폴백)"
        event_note = " · 이벤트 20% 상향 반영" if has_event else ""
        evidence_summary = (
            f"최근 {total_days}일 판매 데이터를 바탕으로 {engine_label}(으)로 예측했습니다. "
            f"예측 매출 {predicted_sales:,}원, 예측 판매량 {predicted_quantity:,}개{event_note}. "
            f"(참고용 예측 수치)"
        )

        return {
            "target_date": target_date,
            "predicted_sales": predicted_sales,
            "predicted_quantity": predicted_quantity,
            "engine": used_engine,
            "evidence_summary": evidence_summary,
        }

    # ---------- 학습 아티팩트 (train 스크립트 연계) ----------

    @staticmethod
    def save_model(store_id: str, payload: dict) -> str:
        """학습 결과(모델·메타)를 pickle 아티팩트로 저장하고 경로를 반환합니다."""
        os.makedirs(ARTIFACT_DIR, exist_ok=True)
        path = os.path.join(ARTIFACT_DIR, f"forecast_{store_id}.pkl")
        with open(path, "wb") as f:
            pickle.dump(payload, f)
        return path

    @staticmethod
    def load_model(store_id: str) -> Optional[dict]:
        """저장된 학습 아티팩트를 로드합니다. 없으면 None."""
        path = os.path.join(ARTIFACT_DIR, f"forecast_{store_id}.pkl")
        if not os.path.exists(path):
            return None
        try:
            with open(path, "rb") as f:
                return pickle.load(f)
        except Exception as e:
            logger.warning("예측 모델 로드 실패: %s", e)
            return None
