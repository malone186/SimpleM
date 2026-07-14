"""OCR 로직 (백엔드 B)

AI-2: 거래명세서/영수증 사진 → {상품, 단가, 수량} 구조화 → 등록 초안.

세 가지 백엔드를 지원한다 (OCR_BACKEND 환경변수로 선택, 실패 시 OCR_FALLBACK_BACKEND로 자동 전환):
  - clova_gemini (기본): OCR+LLM 2단계 (PRD §5.2 ②) — CLOVA OCR로 텍스트 추출 후 Gemini가 구조화.
    가장 빠르고(3~5초) 한국어 정확도가 높다. CLOVA 무료 한도(월 100건) 주의.
  - paddle_gemini (기본 폴백): 로컬 PaddleOCR(PP-OCRv5 한국어) + Gemini. CLOVA 한도 초과/장애 시
    자동 사용. 이 노트북 CPU 기준 약 12초, 품목명 정확.
  - ollama_vlm: VLM 단독 (PRD §5.2 ①) — 로컬 gemma4가 이미지에서 바로 추출. 완전 오프라인용.

흐름: analyze_image(초안 생성) → update_draft(사용자 수정) → confirm_draft(사람 승인, 자동 확정 금지)
"""

import asyncio
import base64
import io
import json
import logging
import os
import re
import threading
import time
import uuid
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Optional

import httpx
from PIL import Image, ImageFilter, ImageOps

from app.schemas.ai import (
    OcrDocumentUpdate,
    OcrItem,
    OcrResult,
    RegisterTarget,
)

logger = logging.getLogger(__name__)


def _load_dotenv() -> None:
    """backend/.env를 읽어 아직 없는 환경변수만 채운다 (외부 의존성 없이)."""
    env_file = Path(__file__).resolve().parents[3] / ".env"
    if not env_file.exists():
        return
    for line in env_file.read_text(encoding="utf-8").splitlines():
        line = line.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        key, _, value = line.partition("=")
        if value.strip():
            os.environ.setdefault(key.strip(), value.strip())


_load_dotenv()

# LLM 호출부는 이 모듈 상수/환경변수로만 제어한다 (모델 교체 시 한 곳 수정 — PRD §7)
OCR_BACKEND = os.getenv("OCR_BACKEND", "clova_gemini")
OCR_FALLBACK_BACKEND = os.getenv("OCR_FALLBACK_BACKEND", "paddle_gemini")  # 빈 값이면 폴백 없음

CLOVA_OCR_INVOKE_URL = os.getenv("CLOVA_OCR_INVOKE_URL", "")
CLOVA_OCR_SECRET = os.getenv("CLOVA_OCR_SECRET", "")
GEMINI_API_KEY = os.getenv("GEMINI_API_KEY", "")
GEMINI_MODEL = os.getenv("GEMINI_MODEL", "gemini-2.5-flash")

# PaddleOCR (로컬 폴백) — mobile 모델이 CPU에서 실용적, server 모델은 10배 느림
PADDLE_DET_MODEL = os.getenv("PADDLE_DET_MODEL", "PP-OCRv5_mobile_det")
PADDLE_REC_MODEL = os.getenv("PADDLE_REC_MODEL", "korean_PP-OCRv5_mobile_rec")
OLLAMA_BASE_URL = os.getenv("OLLAMA_BASE_URL", "http://localhost:11434")
# 기본값을 12b로 둔 이유: gemma4:latest(8B)는 Windows에서 이미지를 인식하지 못하는
# Ollama 버그가 있다 (ollama/ollama#16532, 수정 PR #16879 미릴리스 — 2026-07 기준)
OLLAMA_OCR_MODEL = os.getenv("OLLAMA_OCR_MODEL", "gemma4:12b")
OLLAMA_OCR_TIMEOUT = float(os.getenv("OLLAMA_OCR_TIMEOUT", "300"))
OLLAMA_KEEP_ALIVE = os.getenv("OLLAMA_KEEP_ALIVE", "30m")  # 모델을 메모리에 상주시켜 재로드 지연 제거

# 폰 사진은 4000px가 넘어가므로 전송·인코딩 비용을 줄이기 위해 축소한다
MAX_IMAGE_SIDE = int(os.getenv("OCR_MAX_IMAGE_SIDE", "1280"))

UPLOAD_DIR = Path(os.getenv("OCR_UPLOAD_DIR", Path(__file__).resolve().parents[3] / "uploads" / "ocr"))

# 수량×단가=금액 검증 허용 오차: 반올림·부가세 절사 감안
AMOUNT_TOLERANCE = 0.01  # 상대 1%
AMOUNT_TOLERANCE_ABS = 10  # 절대 10원

# Ollama structured output용 JSON 스키마 — 모델 출력을 이 형태로 강제
_EXTRACTION_SCHEMA: dict[str, Any] = {
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

_RULES = """규칙:
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

_PROMPT = f"""당신은 한국어 거래 서류 인식 전문가입니다. 첨부된 이미지에서 정보를 추출해 JSON으로 반환하세요.

{_RULES}
"""

_GEMINI_PROMPT = f"""당신은 한국어 거래 서류 구조화 전문가입니다.
아래는 영수증/거래명세서를 OCR한 원문 텍스트입니다 (줄바꿈은 문서의 실제 줄, OCR 오탈자가 있을 수 있음).
정보를 추출해 JSON으로 반환하세요. 명백한 OCR 오탈자는 문맥으로 바로잡으세요.

{_RULES}
"""

# Gemini responseSchema (OpenAPI 스타일 — nullable 사용)
_GEMINI_SCHEMA: dict[str, Any] = {
    "type": "object",
    "properties": {
        "doc_type": {
            "type": "string",
            "enum": ["purchase_statement", "tax_invoice", "receipt", "sales_summary", "unknown"],
        },
        "vendor": {
            "type": "object",
            "properties": {
                "name": {"type": "string", "nullable": True},
                "biz_no": {"type": "string", "nullable": True},
                "phone": {"type": "string", "nullable": True},
            },
        },
        "issued_date": {"type": "string", "nullable": True},
        "items": {
            "type": "array",
            "items": {
                "type": "object",
                "properties": {
                    "name": {"type": "string"},
                    "spec": {"type": "string", "nullable": True},
                    "quantity": {"type": "number", "nullable": True},
                    "unit": {"type": "string", "nullable": True},
                    "unit_price": {"type": "number", "nullable": True},
                    "amount": {"type": "number", "nullable": True},
                },
                "required": ["name"],
            },
        },
        "discount": {"type": "number", "nullable": True},
        "subtotal": {"type": "number", "nullable": True},
        "tax": {"type": "number", "nullable": True},
        "total": {"type": "number", "nullable": True},
    },
    "required": ["doc_type", "items"],
}

# 문서 종류 → 등록 대상 추천 (사용자가 확정 전 변경 가능)
_TARGET_BY_DOC_TYPE: dict[str, RegisterTarget] = {
    "purchase_statement": "inventory_inbound",
    "tax_invoice": "inventory_inbound",
    "receipt": "expense",
    "sales_summary": "sales",
}

# ---------------------------------------------------------------------------
# 초안 저장소
# TODO(백엔드 B): 백엔드 A의 core/database.py 완성 후 models/ai.py OcrDocument로 전환.
# 그때까지는 인메모리로 유지한다 (서버 재시작 시 초안 소실).
# ---------------------------------------------------------------------------
_DRAFTS: dict[str, dict[str, Any]] = {}


class OcrError(Exception):
    """OCR 처리 실패 (모델 호출/응답 파싱)"""


class DraftNotFoundError(KeyError):
    pass


class DraftStateError(ValueError):
    """초안 상태에서만 가능한 작업을 확정/반려 문서에 시도"""


def _auto_crop_document(img: Image.Image) -> Image.Image:
    """배경 속 밝은 종이(명세서/영수증) 영역만 잘라내 글자 해상도를 높인다.

    실패해도 안전하도록: 밝은 영역을 못 찾거나 비율이 어중간하면 원본을 그대로 쓴다.
    """
    small = img.copy()
    small.thumbnail((400, 400), Image.BILINEAR)
    mask = small.convert("L").point(lambda p: 255 if p > 200 else 0)
    mask = mask.filter(ImageFilter.MinFilter(5))  # 배경의 작은 밝은 점 제거
    bbox = mask.getbbox()
    if not bbox:
        return img
    area_ratio = (bbox[2] - bbox[0]) * (bbox[3] - bbox[1]) / (small.width * small.height)
    if not (0.10 <= area_ratio <= 0.95):  # 전체가 밝거나(이미 문서 전체 사진) 못 찾은 경우
        return img
    sx, sy = img.width / small.width, img.height / small.height
    pad = 8
    return img.crop((
        max(0, int(bbox[0] * sx) - pad),
        max(0, int(bbox[1] * sy) - pad),
        min(img.width, int(bbox[2] * sx) + pad),
        min(img.height, int(bbox[3] * sy) + pad),
    ))


def _preprocess_image(image_bytes: bytes, max_side: int = MAX_IMAGE_SIDE) -> bytes:
    """폰 사진 대비: EXIF 회전 보정 + 문서 영역 자동 크롭 + 축소 + JPEG 재인코딩."""
    try:
        img = Image.open(io.BytesIO(image_bytes))
        img = ImageOps.exif_transpose(img)
        img = img.convert("RGB")
        img = _auto_crop_document(img)
        if max(img.size) > max_side:
            img.thumbnail((max_side, max_side), Image.LANCZOS)
        buf = io.BytesIO()
        img.save(buf, "JPEG", quality=88)
        return buf.getvalue()
    except Exception:
        logger.warning("이미지 전처리 실패 — 원본 그대로 사용", exc_info=True)
        return image_bytes


def _parse_model_json(content: str) -> dict[str, Any]:
    """모델 응답에서 JSON을 최대한 회수한다 (코드펜스·앞뒤 잡설 허용)."""
    content = content.strip()
    if content.startswith("```"):
        content = re.sub(r"^```(?:json)?\s*|\s*```$", "", content, flags=re.DOTALL)
    try:
        return json.loads(content)
    except json.JSONDecodeError:
        match = re.search(r"\{.*\}", content, re.DOTALL)
        if match:
            return json.loads(match.group())
        raise


async def _call_clova_ocr(image_bytes: bytes) -> str:
    """CLOVA OCR(General) 호출 — 이미지에서 줄 단위 텍스트 추출.

    주의: 무료 한도 월 100건. 호출 전 설정을 모두 검증해 헛 호출을 막는다.
    """
    if not CLOVA_OCR_INVOKE_URL or not CLOVA_OCR_SECRET:
        raise OcrError("CLOVA OCR 설정 누락 — backend/.env의 CLOVA_OCR_INVOKE_URL/CLOVA_OCR_SECRET을 확인하세요")

    payload = {
        "version": "V2",
        "requestId": uuid.uuid4().hex,
        "timestamp": int(time.time() * 1000),
        "lang": "ko",
        "images": [{"format": "jpg", "name": "document", "data": base64.b64encode(image_bytes).decode()}],
    }
    try:
        async with httpx.AsyncClient(timeout=60) as client:
            resp = await client.post(
                CLOVA_OCR_INVOKE_URL,
                json=payload,
                headers={"X-OCR-SECRET": CLOVA_OCR_SECRET},
            )
            resp.raise_for_status()
    except httpx.HTTPStatusError as e:
        raise OcrError(f"CLOVA OCR 호출 실패 (HTTP {e.response.status_code}): {e.response.text[:300]}") from e
    except httpx.HTTPError as e:
        raise OcrError(f"CLOVA OCR 호출 실패: {e}") from e

    images = resp.json().get("images", [])
    if not images:
        raise OcrError("CLOVA OCR 응답에 결과가 없습니다")
    image_result = images[0]
    if image_result.get("inferResult") == "ERROR":
        raise OcrError(f"CLOVA OCR 인식 실패: {image_result.get('message', '')}")

    # lineBreak 플래그로 문서의 실제 줄을 복원한다 — LLM 구조화 정확도에 중요
    parts: list[str] = []
    for field in image_result.get("fields", []):
        parts.append(field.get("inferText", ""))
        parts.append("\n" if field.get("lineBreak") else " ")
    text = "".join(parts).strip()
    if not text:
        raise OcrError("CLOVA OCR가 텍스트를 찾지 못했습니다 — 이미지 상태를 확인하세요")
    return text


# PaddleOCR 파이프라인은 로드에 ~15초·수 GB RAM이 들므로 첫 사용 시 1회만 만든다
_paddle_ocr = None
_paddle_lock = threading.Lock()


def _get_paddle_ocr():
    global _paddle_ocr
    if _paddle_ocr is None:
        with _paddle_lock:
            if _paddle_ocr is None:
                from paddleocr import PaddleOCR

                _paddle_ocr = PaddleOCR(
                    text_detection_model_name=PADDLE_DET_MODEL,
                    text_recognition_model_name=PADDLE_REC_MODEL,
                    enable_mkldnn=False,  # Windows CPU oneDNN PIR 버그 우회 (paddle 3.3)
                    use_doc_orientation_classify=False,
                    use_doc_unwarping=False,
                    use_textline_orientation=False,
                )
    return _paddle_ocr


def _merge_ocr_lines(texts: list[str], boxes: list) -> str:
    """인식된 텍스트 조각을 y좌표 기준으로 문서의 실제 줄로 복원한다."""
    entries = []
    for text, box in zip(texts, boxes):
        if isinstance(box[0], (list, tuple)):
            ys = [p[1] for p in box]
            xs = [p[0] for p in box]
        else:  # [x1, y1, x2, y2]
            ys = [box[1], box[3]]
            xs = [box[0], box[2]]
        entries.append((sum(ys) / len(ys), min(xs), text))
    entries.sort(key=lambda e: (e[0], e[1]))

    lines: list[str] = []
    current: list[tuple[float, str]] = []
    current_y: Optional[float] = None
    for y, x, text in entries:
        if current_y is None or abs(y - current_y) < 14:
            current.append((x, text))
            current_y = y if current_y is None else (current_y + y) / 2
        else:
            lines.append(" ".join(t for _, t in sorted(current)))
            current, current_y = [(x, text)], y
    if current:
        lines.append(" ".join(t for _, t in sorted(current)))
    return "\n".join(lines)


def _paddle_ocr_sync(image_bytes: bytes) -> str:
    import numpy as np

    img = Image.open(io.BytesIO(image_bytes)).convert("RGB")
    output = _get_paddle_ocr().predict(np.array(img))
    if not output:
        raise OcrError("PaddleOCR가 결과를 반환하지 않았습니다")
    data = output[0].json if isinstance(output[0].json, dict) else json.loads(output[0].json)
    inner = data.get("res", data)
    texts = inner.get("rec_texts", [])
    boxes = inner.get("rec_boxes", []) or inner.get("dt_polys", [])
    if not texts:
        raise OcrError("PaddleOCR가 텍스트를 찾지 못했습니다 — 이미지 상태를 확인하세요")
    return _merge_ocr_lines(texts, boxes)


async def _call_paddle_ocr(image_bytes: bytes) -> str:
    """로컬 PaddleOCR 호출 — 추론이 CPU 블로킹이므로 스레드에서 돌린다."""
    try:
        return await asyncio.get_running_loop().run_in_executor(None, _paddle_ocr_sync, image_bytes)
    except OcrError:
        raise
    except Exception as e:
        raise OcrError(f"PaddleOCR 실패: {e}") from e


async def _call_gemini_structurer(ocr_text: str) -> dict[str, Any]:
    """Gemini 호출 — OCR 원문 텍스트를 구조화 JSON으로."""
    if not GEMINI_API_KEY:
        raise OcrError("GEMINI_API_KEY 누락 — backend/.env를 확인하세요")

    body = {
        "contents": [{"parts": [{"text": f"{_GEMINI_PROMPT}\n--- OCR 원문 ---\n{ocr_text}"}]}],
        "generationConfig": {
            "temperature": 0,
            "responseMimeType": "application/json",
            "responseSchema": _GEMINI_SCHEMA,
        },
    }
    try:
        async with httpx.AsyncClient(timeout=60) as client:
            resp = await client.post(
                f"https://generativelanguage.googleapis.com/v1beta/models/{GEMINI_MODEL}:generateContent",
                json=body,
                headers={"x-goog-api-key": GEMINI_API_KEY},
            )
            resp.raise_for_status()
    except httpx.HTTPStatusError as e:
        raise OcrError(f"Gemini 호출 실패 (HTTP {e.response.status_code}): {e.response.text[:300]}") from e
    except httpx.HTTPError as e:
        raise OcrError(f"Gemini 호출 실패: {e}") from e

    try:
        content = resp.json()["candidates"][0]["content"]["parts"][0]["text"]
        return _parse_model_json(content)
    except (KeyError, IndexError, json.JSONDecodeError) as e:
        raise OcrError(f"Gemini 응답 파싱 실패: {e}") from e


async def _call_vlm(image_bytes: bytes) -> dict[str, Any]:
    """Ollama VLM 호출 — 이미지 1장을 구조화 JSON으로. 파싱 실패 시 1회 재시도."""
    payload = {
        "model": OLLAMA_OCR_MODEL,
        "messages": [
            {
                "role": "user",
                "content": _PROMPT,
                "images": [base64.b64encode(image_bytes).decode()],
            }
        ],
        "format": _EXTRACTION_SCHEMA,
        # thinking을 끄지 않으면 답변 전에 숨은 추론 토큰을 대량 생성해 수 배 느려지고,
        # 추론만 하다 끝나면 content가 비어 JSON 파싱이 실패한다
        "think": False,
        "options": {"temperature": 0, "num_ctx": 8192, "num_predict": 1536},
        "keep_alive": OLLAMA_KEEP_ALIVE,
        "stream": False,
    }

    last_error: Exception | None = None
    for attempt in (1, 2):
        try:
            async with httpx.AsyncClient(timeout=OLLAMA_OCR_TIMEOUT) as client:
                resp = await client.post(f"{OLLAMA_BASE_URL}/api/chat", json=payload)
                resp.raise_for_status()
        except httpx.HTTPError as e:
            raise OcrError(f"Ollama 호출 실패 ({OLLAMA_OCR_MODEL}): {e}") from e

        content = resp.json().get("message", {}).get("content", "")
        try:
            return _parse_model_json(content)
        except json.JSONDecodeError as e:
            last_error = e
            logger.warning("OCR 응답 파싱 실패 (시도 %d/2): %r", attempt, content[:200])
    raise OcrError(f"모델 응답이 JSON이 아님 (2회 시도): {last_error}")


def _validate_result(result: OcrResult) -> list[str]:
    """수량·단가·금액 간 관계 검증. 빈 값은 채우고, 불일치는 warning으로 사용자에게 넘긴다."""
    doc_warnings: list[str] = []

    for item in result.items:
        item.warnings = []
        q, u, a = item.quantity, item.unit_price, item.amount
        known = sum(v is not None for v in (q, u, a))
        if known == 3:
            expected = q * u
            if abs(expected - a) > max(abs(a) * AMOUNT_TOLERANCE, AMOUNT_TOLERANCE_ABS):
                item.warnings.append(
                    f"수량×단가({expected:,.0f})와 금액({a:,.0f})이 다릅니다 — 확인 필요"
                )
        elif known == 2:
            # 두 값으로 나머지 하나를 계산해 채운다
            if a is None:
                item.amount = q * u
            elif q is None and u:
                item.quantity = round(a / u, 3)
            elif u is None and q:
                item.unit_price = round(a / q, 2)
        elif known <= 1:
            item.warnings.append("수량/단가/금액 중 두 개 이상을 읽지 못했습니다 — 직접 입력 필요")

    amounts = [i.amount for i in result.items if i.amount is not None]
    if amounts:
        items_sum = sum(amounts)
        discount = result.discount or 0
        net = items_sum - discount  # 품목은 할인 전 금액이므로 할인을 빼고 비교
        # 명세서는 품목 금액이 공급가액 기준, 영수증은 부가세 포함(합계) 기준으로 찍히므로
        # 둘 중 어느 쪽과도 맞지 않을 때만 경고한다
        bases = [(v, label) for v, label in ((result.subtotal, "공급가액"), (result.total, "합계")) if v is not None]
        if bases and not any(
            abs(net - v) <= max(abs(v) * AMOUNT_TOLERANCE, AMOUNT_TOLERANCE_ABS) for v, _ in bases
        ):
            v, label = min(bases, key=lambda b: abs(net - b[0]))
            sum_desc = (
                f"품목 합({items_sum:,.0f})−할인({discount:,.0f})={net:,.0f}"
                if discount
                else f"품목 합({items_sum:,.0f})"
            )
            doc_warnings.append(
                f"{sum_desc}이(가) {label}({v:,.0f})과 다릅니다 — 누락되거나 잘못 읽은 품목·할인이 있을 수 있습니다"
            )
    if result.subtotal is not None and result.tax is not None and result.total is not None:
        if abs(result.subtotal + result.tax - result.total) > max(abs(result.total) * AMOUNT_TOLERANCE, AMOUNT_TOLERANCE_ABS):
            doc_warnings.append(
                f"공급가액+세액({result.subtotal + result.tax:,.0f})이 합계({result.total:,.0f})와 다릅니다"
            )
    return doc_warnings


def _now() -> datetime:
    return datetime.now(timezone.utc)


async def _run_backend(backend: str, image_bytes: bytes) -> tuple[dict[str, Any], Optional[str]]:
    """지정한 백엔드로 (구조화 결과, OCR 원문)을 얻는다."""
    if backend == "clova_gemini":
        # CLOVA는 고해상도일수록 정확 — VLM보다 크게 보낸다 (무료 한도는 건수 기준)
        text = await _call_clova_ocr(_preprocess_image(image_bytes, max_side=1920))
        return await _call_gemini_structurer(text), text
    if backend == "paddle_gemini":
        text = await _call_paddle_ocr(_preprocess_image(image_bytes))
        return await _call_gemini_structurer(text), text
    if backend == "ollama_vlm":
        return await _call_vlm(_preprocess_image(image_bytes)), None
    raise OcrError(f"알 수 없는 OCR 백엔드: {backend}")


async def _run_with_fallback(image_bytes: bytes) -> tuple[dict[str, Any], Optional[str], str]:
    """기본 백엔드 실패(한도 초과·네트워크 장애 등) 시 폴백 백엔드로 자동 전환한다."""
    backends = [OCR_BACKEND]
    if OCR_FALLBACK_BACKEND and OCR_FALLBACK_BACKEND != OCR_BACKEND:
        backends.append(OCR_FALLBACK_BACKEND)

    last_error: Optional[OcrError] = None
    for backend in backends:
        try:
            raw, ocr_text = await _run_backend(backend, image_bytes)
            if last_error is not None:
                logger.warning("OCR 폴백 성공: %s → %s", backends[0], backend)
            return raw, ocr_text, backend
        except OcrError as e:
            logger.warning("OCR 백엔드 %s 실패: %s", backend, e)
            last_error = e
    raise last_error if last_error else OcrError("사용 가능한 OCR 백엔드가 없습니다")


async def analyze_image(image_bytes: bytes, filename: Optional[str] = None) -> dict[str, Any]:
    """이미지 1장을 OCR해 등록 초안을 만든다. 초안은 사람이 확정하기 전까지 아무 데도 반영되지 않는다."""
    # OCR 실패 시에도 원인 분석이 가능하도록 원본을 먼저 저장한다
    doc_id = uuid.uuid4().hex[:12]
    UPLOAD_DIR.mkdir(parents=True, exist_ok=True)
    suffix = Path(filename).suffix if filename else ".jpg"
    image_path = UPLOAD_DIR / f"{doc_id}{suffix}"
    image_path.write_bytes(image_bytes)

    started = time.perf_counter()
    raw, ocr_text, used_backend = await _run_with_fallback(image_bytes)
    elapsed = round(time.perf_counter() - started, 1)
    logger.info("OCR %s 완료 — %.1fs (%s)", doc_id, elapsed, used_backend)

    result = OcrResult.model_validate(raw)
    doc_warnings = _validate_result(result)

    now = _now()
    draft = {
        "id": doc_id,
        "status": "draft",
        "filename": filename,
        "image_path": str(image_path),
        "ocr_text": ocr_text,  # CLOVA 원문 (디버깅용, ollama_vlm 경로에서는 None)
        "result": result,
        "suggested_target": _TARGET_BY_DOC_TYPE.get(result.doc_type),
        "warnings": doc_warnings,
        "confirmed_target": None,
        "applied": False,
        "elapsed_sec": elapsed,
        "ocr_backend": used_backend,
        "created_at": now,
        "updated_at": now,
    }
    _DRAFTS[doc_id] = draft
    return draft


def get_draft(doc_id: str) -> dict[str, Any]:
    if doc_id not in _DRAFTS:
        raise DraftNotFoundError(doc_id)
    return _DRAFTS[doc_id]


def list_drafts(status: Optional[str] = None) -> list[dict[str, Any]]:
    docs = sorted(_DRAFTS.values(), key=lambda d: d["created_at"], reverse=True)
    if status:
        docs = [d for d in docs if d["status"] == status]
    return docs


def update_draft(doc_id: str, patch: OcrDocumentUpdate) -> dict[str, Any]:
    """사용자 직접 수정. 수정 후 관계 검증을 다시 돌려 warning을 갱신한다."""
    draft = get_draft(doc_id)
    if draft["status"] != "draft":
        raise DraftStateError(f"{draft['status']} 상태 문서는 수정할 수 없습니다")

    result: OcrResult = draft["result"]
    data = patch.model_dump(exclude_none=True)
    if "suggested_target" in data:
        draft["suggested_target"] = data.pop("suggested_target")
    if "items" in data:
        result.items = [OcrItem.model_validate(i) for i in data.pop("items")]
    for field, value in data.items():
        setattr(result, field, value)
    if patch.doc_type is not None:
        draft["suggested_target"] = _TARGET_BY_DOC_TYPE.get(patch.doc_type, draft["suggested_target"])

    draft["warnings"] = _validate_result(result)
    draft["updated_at"] = _now()
    return draft


def confirm_draft(doc_id: str, target: Optional[RegisterTarget] = None) -> tuple[dict[str, Any], str]:
    """사람이 검토를 마친 초안을 확정하고 대상 시스템 반영을 시도한다.

    챗봇에는 이 함수를 노출하지 않는다 — 확정은 전용 화면에서 사람만 (PRD §5.3 안전장치).
    """
    draft = get_draft(doc_id)
    if draft["status"] != "draft":
        raise DraftStateError(f"이미 {draft['status']} 상태입니다")
    resolved = target or draft["suggested_target"]
    if resolved is None:
        raise DraftStateError("등록 대상(target)을 지정해야 합니다 — 문서 종류를 판별하지 못했습니다")

    draft["status"] = "confirmed"
    draft["confirmed_target"] = resolved
    applied, message = _apply_to_target(draft, resolved)
    draft["applied"] = applied
    draft["updated_at"] = _now()
    return draft, message


def reject_draft(doc_id: str) -> dict[str, Any]:
    draft = get_draft(doc_id)
    if draft["status"] != "draft":
        raise DraftStateError(f"이미 {draft['status']} 상태입니다")
    draft["status"] = "rejected"
    draft["updated_at"] = _now()
    return draft


def _apply_to_target(draft: dict[str, Any], target: RegisterTarget) -> tuple[bool, str]:
    """확정된 문서를 대상 시스템에 반영.

    재고/매출 로직은 백엔드 A 소유이므로 직접 구현하지 않고, A가 합의된 함수를
    inventory_service에 만들면 자동으로 연결된다. 그 전까지는 확정 상태로 보관만 한다.
    """
    result: OcrResult = draft["result"]
    payload = {
        "source": "ocr",
        "ocr_document_id": draft["id"],
        "vendor": result.vendor.model_dump(),
        "issued_date": result.issued_date,
        "items": [i.model_dump(exclude={"warnings"}) for i in result.items],
        "total": result.total,
    }

    # 연동 지점: 백엔드 A와 합의한 함수명 (target별)
    hook_names = {
        "inventory_inbound": "register_inbound_from_ocr",
        "expense": "register_expense_from_ocr",
        "sales": "register_sales_from_ocr",
    }
    try:
        from app.services import inventory_service
        hook = getattr(inventory_service, hook_names[target], None)
    except ImportError:
        hook = None

    if hook is None:
        logger.info("OCR %s 확정 — %s 연동 함수 미구현, 확정 상태로 보관", draft["id"], target)
        return False, f"확정 완료. {target} 반영 함수가 아직 없어 확정 상태로 보관합니다 (연동 시 자동 반영)."
    try:
        hook(payload)
        return True, f"확정 완료 — {target}에 반영되었습니다."
    except Exception as e:  # 반영 실패해도 확정 상태는 유지, applied=False로 표시
        logger.exception("OCR %s의 %s 반영 실패", draft["id"], target)
        return False, f"확정은 되었으나 {target} 반영에 실패했습니다: {e}"
