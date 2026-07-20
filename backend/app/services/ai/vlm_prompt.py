"""VLM OCR 프롬프트·스키마 단일 소스 (백엔드 B)

ocr_service(서빙)와 vlm_finetune(학습)이 같은 프롬프트를 import한다.
학습 때 본 프롬프트와 추론 프롬프트가 한 글자라도 다르면 파인튜닝 효과가
떨어지므로, 문구 수정은 반드시 이 파일에서만 하고 수정 후 재학습을 고려할 것.
"""

from typing import Any

# 구조화 추출 결과 JSON 스키마 — Ollama structured output 및 학습 정답 포맷의 기준
EXTRACTION_SCHEMA: dict[str, Any] = {
    "type": "object",
    "properties": {
        "doc_type": {
            "type": "string",
            "enum": ["purchase_statement", "tax_invoice", "receipt", "sales_summary", "unknown"],
        },
        "vendor": {
            "type": "object",
            "properties": {
                "name": {"type": ["string", "null"]},
                "biz_no": {"type": ["string", "null"]},
                "phone": {"type": ["string", "null"]},
            },
        },
        "issued_date": {"type": ["string", "null"]},
        "items": {
            "type": "array",
            "items": {
                "type": "object",
                "properties": {
                    "name": {"type": "string"},
                    "spec": {"type": ["string", "null"]},
                    "quantity": {"type": ["number", "null"]},
                    "unit": {"type": ["string", "null"]},
                    "unit_price": {"type": ["number", "null"]},
                    "amount": {"type": ["number", "null"]},
                },
                "required": ["name"],
            },
        },
        "discount": {"type": ["number", "null"]},
        "subtotal": {"type": ["number", "null"]},
        "tax": {"type": ["number", "null"]},
        "total": {"type": ["number", "null"]},
    },
    "required": ["doc_type", "items"],
}

RULES = """규칙:
- doc_type: 거래명세서=purchase_statement, 세금계산서=tax_invoice, 구매 영수증=receipt, 매출 일마감/정산표=sales_summary, 판별 불가=unknown
- vendor: 공급자(판매자) 정보. 사업자등록번호는 biz_no에 숫자와 하이픈만.
- issued_date: 발행일을 YYYY-MM-DD로. 없으면 null.
- items: 품목 표의 각 행. 품목명(name)은 적힌 그대로. 규격(spec), 수량(quantity), 단위(unit), 단가(unit_price), 금액(amount)을 채우고 읽을 수 없는 값은 null.
- 금액류는 쉼표 없는 숫자로. subtotal=공급가액, tax=세액, total=합계.
- 할인: "판촉/팝 할인", "쿠폰", "멤버십 할인" 등 할인 줄은 품목(items)에 넣지 말고 discount에 할인 총액을 양수로 넣으세요 (-420이면 discount=420). 품목 amount는 할인 전 금액 그대로.
- "합계수량/금액" 같은 소계 줄도 품목이 아닙니다.
- 품목 표 바깥(주로 하단이나 우측 아래)의 공급가액·세액·합계 요약과 상단의 전화번호도 빠뜨리지 말고 읽으세요.
- 영수증에서 품목명 아래 줄의 긴 바코드 숫자(예: 8809599360081)는 품목이 아니므로 무시하세요. 수량·금액이 품목명과 다른 줄에 있어도 같은 품목으로 묶으세요.
- "행사", "할인" 같은 표시는 품목이 아닙니다. 과세물품가액=subtotal, 부가세=tax, 합계=total로 취급하세요.
- 원문에 없는 값을 추측해 만들지 마세요. 불확실하면 null."""

VLM_PROMPT = f"""당신은 한국어 거래 서류 인식 전문가입니다. 첨부된 이미지에서 정보를 추출해 JSON으로 반환하세요.

{RULES}
"""
