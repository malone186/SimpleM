"""판매예측 로직 (백엔드 C)"""
from typing import List, Any

class ForecastingService:
    """최근 판매 데이터를 가공하여 일별 매출 및 판매량을 예측하는 서비스 클래스"""

    @staticmethod
    def check_forecast_data_sufficiency(sales_data: List[Any]) -> None:
        """판매 데이터의 일수가 예측을 위한 최소 기준(7일)을 만족하는지 검사합니다."""
        if not sales_data or len(sales_data) < 7:
            raise ValueError("예측을 위한 판매 데이터가 최소 7일 이상 필요합니다.")

    @staticmethod
    def calculate_recent_average(sales_data: List[Any]) -> tuple:
        """최근 N일간의 단순 평균 일 매출과 일 판매량을 계산합니다."""
        total_days = len(sales_data)
        total_revenue = 0
        total_quantity = 0

        for item in sales_data:
            rev = getattr(item, "revenue", None)
            qty = getattr(item, "quantity", None)
            
            if rev is None and isinstance(item, dict):
                rev = item.get("revenue", 0)
                qty = item.get("quantity", 0)
                
            total_revenue += rev if rev is not None else 0
            total_quantity += qty if qty is not None else 0

        base_average_sales = total_revenue / total_days
        base_average_quantity = total_quantity / total_days
        return base_average_sales, base_average_quantity

    @staticmethod
    def apply_event_boost(base_sales: float, base_qty: float, has_event: bool) -> tuple:
        """이벤트 발생 여부에 따라 20%의 상향 보정을 적용하여 정수로 반환합니다."""
        if has_event:
            predicted_sales = int(base_sales * 1.2)
            predicted_quantity = int(base_qty * 1.2)
        else:
            predicted_sales = int(base_sales)
            predicted_quantity = int(base_qty)
        return predicted_sales, predicted_quantity

    @staticmethod
    def build_forecast_explanation(total_days: int, avg_sales: int, avg_qty: int, has_event: bool) -> str:
        """단순 평균을 기반으로 예측했음을 알리는 설명 리포트 문구를 생성합니다."""
        event_status = "20% 상향 적용" if has_event else "미적용"
        return (
            f"최근 {total_days}일간의 단순 평균 일 매출 {avg_sales:,}원과 "
            f"평균 판매량 {avg_qty:,}개를 기반으로 한 참고용 예측입니다. "
            f"(이벤트 보정: {event_status})"
        )

    @classmethod
    def forecast_sales(cls, sales_data: List[Any], target_date: str, has_event: bool = False) -> dict:
        """분할 구현된 서브 메소드들을 조율하여 최종 판매 예측 시뮬레이션을 수행합니다."""
        # 1. 데이터 충분 조건 검증
        cls.check_forecast_data_sufficiency(sales_data)

        # 2. 최근 N일의 평균 계산
        base_sales, base_qty = cls.calculate_recent_average(sales_data)

        # 3. 이벤트 보정 적용
        predicted_sales, predicted_quantity = cls.apply_event_boost(base_sales, base_qty, has_event)

        # 4. 참고용 설명문 빌드 (포맷팅용으로는 보정 전 원래 평균값 전달)
        total_days = len(sales_data)
        avg_sales_rounded = int(base_sales)
        avg_qty_rounded = int(base_qty)
        evidence_summary = cls.build_forecast_explanation(total_days, avg_sales_rounded, avg_qty_rounded, has_event)

        return {
            "target_date": target_date,
            "predicted_sales": predicted_sales,
            "predicted_quantity": predicted_quantity,
            "evidence_summary": evidence_summary
        }

