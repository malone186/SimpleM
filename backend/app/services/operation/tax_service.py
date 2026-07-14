"""세금계산 로직 (백엔드 C)"""

class TaxService:
    """세무 관리 및 예상 세액 연산을 담당하는 서비스 클래스"""

    @staticmethod
    def calculate_estimated_tax(total_revenue: int, total_expense: int, tax_rate: float, period: str = "2026-07") -> dict:
        """매출, 비용, 세율을 입력받아 면책 문구를 동봉한 예상 세금을 계산합니다."""
        # 1. 입력값의 논리적 범위 검증
        if total_revenue < 0 or total_expense < 0:
            raise ValueError("매출액과 비용은 0 이상이어야 합니다.")
            
        if tax_rate < 0.0 or tax_rate > 1.0:
            raise ValueError("세율은 0 이상 1 이하의 실수여야 합니다.")

        # 2. 세액 산정 (과세 표준액 산출 시 적자 방지 적용)
        taxable_amount = max(total_revenue - total_expense, 0)
        estimated_tax = int(taxable_amount * tax_rate)

        # 3. 출력할 요약 문장 및 disclaimer 정의
        summary_text = f"총 매출 {total_revenue:,}원과 총 비용 {total_expense:,}원을 기준으로 예상 세금은 {estimated_tax:,}원입니다."
        disclaimer_text = "이 계산은 참고용 예상값이며 실제 신고 금액과 다를 수 있습니다. 정확한 신고는 세무 전문가 또는 관련 기관 확인이 필요합니다."

        return {
            "period": period,
            "total_revenue": total_revenue,
            "total_expense": total_expense,
            "taxable_amount": taxable_amount,
            "tax_rate": tax_rate,
            "estimated_tax": estimated_tax,
            "summary": summary_text,
            "disclaimer": disclaimer_text
        }
