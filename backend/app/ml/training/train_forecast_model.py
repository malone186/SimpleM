"""예측 모델 학습 (백엔드 C 최초 작성 → 백엔드 B 인수)

DB의 Sale 테이블에서 매장별 일별 매출 시계열을 집계해 ARIMA 모델을 학습하고,
그 결과를 backend/app/ml/artifacts/forecast_<store_id>.pkl 로 저장한다.

실행:
    python -m app.ml.training.train_forecast_model --store <store_id>
    python -m app.ml.training.train_forecast_model --all
"""
import argparse
import logging
import warnings
from datetime import datetime, timezone

from app.core.database import SessionLocal
from app.models.inventory import Sale
from app.services.operation.operation_service import OperationService
from app.services.operation.forecasting_service import (
    ForecastingService,
    DEFAULT_ARIMA_ORDER,
    MIN_POINTS_ARIMA,
)

logging.basicConfig(level=logging.INFO, format="%(asctime)s [%(levelname)s] %(message)s")
logger = logging.getLogger("train_forecast")


def _distinct_store_ids(db) -> list:
    """Sale 테이블에 존재하는 모든 매장 식별자 목록을 반환합니다."""
    rows = db.query(Sale.store_id).distinct().all()
    return [r[0] for r in rows if r[0]]


def train_store(db, store_id: str) -> bool:
    """단일 매장의 일별 매출 시계열로 ARIMA를 학습하고 아티팩트를 저장합니다."""
    series = OperationService.get_daily_sales_series(db, store_id=store_id)
    if len(series) < MIN_POINTS_ARIMA:
        logger.warning(
            "매장 %s: 데이터 %d일 < 최소 %d일 → 학습 생략(예측은 이동평균 폴백)",
            store_id, len(series), MIN_POINTS_ARIMA,
        )
        return False

    revenues = [row["revenue"] for row in series]
    quantities = [row["quantity"] for row in series]

    try:
        from statsmodels.tsa.arima.model import ARIMA

        with warnings.catch_warnings():
            warnings.simplefilter("ignore")
            revenue_model = ARIMA(revenues, order=DEFAULT_ARIMA_ORDER).fit()
            quantity_model = ARIMA(quantities, order=DEFAULT_ARIMA_ORDER).fit()
    except Exception as e:
        logger.error("매장 %s: ARIMA 학습 실패 — %s", store_id, e)
        return False

    payload = {
        "store_id": store_id,
        "order": DEFAULT_ARIMA_ORDER,
        "last_date": series[-1]["date"],
        "n_points": len(series),
        "revenue_model": revenue_model,
        "quantity_model": quantity_model,
        "trained_at": datetime.now(timezone.utc).isoformat(),
    }
    path = ForecastingService.save_model(store_id, payload)
    logger.info("매장 %s: 학습 완료 (%d일) → %s", store_id, len(series), path)
    return True


def main() -> None:
    parser = argparse.ArgumentParser(description="판매예측 ARIMA 모델 학습")
    parser.add_argument("--store", help="학습할 매장 식별자(store_id)")
    parser.add_argument("--all", action="store_true", help="Sale에 존재하는 모든 매장 학습")
    args = parser.parse_args()

    db = SessionLocal()
    try:
        if args.all:
            store_ids = _distinct_store_ids(db)
            if not store_ids:
                logger.warning("Sale 테이블에 매장 데이터가 없습니다.")
                return
            trained = sum(train_store(db, sid) for sid in store_ids)
            logger.info("전체 학습 완료: %d/%d 매장", trained, len(store_ids))
        elif args.store:
            train_store(db, args.store)
        else:
            parser.error("--store <id> 또는 --all 중 하나를 지정하세요.")
    finally:
        db.close()


if __name__ == "__main__":
    main()
