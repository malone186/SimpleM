"""POS 매출 파일(엑셀/CSV) 임포트 (백엔드 B)

각 POS 회사마다 파일 양식이 다르다. 모든 행을 LLM에 보내는 대신, LLM은 "이 파일의
어떤 열이 날짜/메뉴/수량/금액인가"라는 **매핑만 한 번** 알아내고, 그 다음은 pandas가
전체 파일을 결정론적으로 파싱한다. (느리고 비싼 행 단위 LLM 호출을 피한다)

흐름: 업로드 → 표 로드 → [LLM 1회] 열 매핑 → 결정론 파싱 + 메뉴 매칭 → 미리보기
      → (사용자 확인) → Sale 저장 + 레시피 재고 차감

LLM이 틀릴 수 있으므로 save는 절대 자동으로 하지 않는다 — build_preview(미리보기)와
save_import(확정)를 분리해, 사용자가 확인·수정한 뒤에만 DB에 들어간다.
"""
from __future__ import annotations

import csv
import io
import json
import os
import re
from datetime import datetime
from typing import Any, Optional

import httpx

try:
    import pandas as pd
except Exception:  # pandas 미설치 환경 방어
    pd = None  # type: ignore

logger = __import__("logging").getLogger(__name__)

GEMINI_API_KEY = os.getenv("GEMINI_API_KEY", "") or os.getenv("GOOGLE_API_KEY", "")
GEMINI_MODEL = os.getenv("SALES_IMPORT_GEMINI_MODEL") or os.getenv("OCR_GEMINI_MODEL", "gemini-3.1-flash-lite")
GEMINI_TIMEOUT = float(os.getenv("SALES_IMPORT_GEMINI_TIMEOUT", "45"))

MAX_ROWS = 5000  # 한 번에 임포트할 최대 행 (안전장치)


class SalesImportError(Exception):
    pass


# ---------------------------------------------------------------------------
# 1) 파일 → 원본 표(그리드). 헤더 위치는 아직 모르므로 header=None으로 통째로 읽는다.
# ---------------------------------------------------------------------------

def parse_grid(content: bytes, filename: str) -> list[list[str]]:
    """엑셀/CSV 바이트를 문자열 2차원 그리드로 읽는다 (헤더 미지정)."""
    if not content:
        raise SalesImportError("빈 파일입니다.")
    name = (filename or "").lower()

    if name.endswith((".xlsx", ".xls")):
        if pd is None:
            raise SalesImportError("서버에 pandas가 없어 엑셀을 읽을 수 없습니다 (CSV로 올려 주세요).")
        try:
            df = pd.read_excel(io.BytesIO(content), header=None, dtype=str)
        except Exception as e:
            raise SalesImportError(f"엑셀 파일을 읽지 못했습니다: {e}")
        grid = df.fillna("").astype(str).values.tolist()
    else:
        # CSV는 파이썬 csv 모듈로 읽는다 — 상단에 매장명·기간 같은 잡정보 행(열 수가
        # 데이터 행과 다름)이 있어도, pandas처럼 첫 행 열 수로 뒤 행을 잘라내지 않는다.
        # 한국 POS CSV는 utf-8뿐 아니라 cp949(euc-kr)가 흔해 순서대로 폴백한다.
        text = None
        for enc in ("utf-8-sig", "utf-8", "cp949", "euc-kr"):
            try:
                text = content.decode(enc)
                break
            except (UnicodeDecodeError, UnicodeError):
                continue
        if text is None:
            raise SalesImportError("파일 인코딩을 인식하지 못했습니다 (utf-8/cp949 아님).")
        raw = list(csv.reader(io.StringIO(text)))
        width = max((len(r) for r in raw), default=0)
        grid = [r + [""] * (width - len(r)) for r in raw]  # 짧은 행을 최대 너비로 패딩

    # 완전히 빈 행 제거
    grid = [[str(c).strip() for c in row] for row in grid if any(str(c).strip() for c in row)]
    if not grid:
        raise SalesImportError("데이터가 없는 파일입니다.")
    return grid


def _sample_text(grid: list[list[str]], n: int = 15) -> str:
    """LLM에 보낼 상단 n행 미리보기 (행 인덱스 포함)."""
    lines = []
    for i, row in enumerate(grid[:n]):
        cells = " | ".join(c[:40] for c in row)
        lines.append(f"[row {i}] {cells}")
    return "\n".join(lines)


# ---------------------------------------------------------------------------
# 2) 열 매핑 추론 — LLM(있으면) 또는 키워드 휴리스틱(폴백)
# ---------------------------------------------------------------------------

_MAPPING_SCHEMA = {
    "type": "object",
    "properties": {
        "header_row": {"type": "integer"},
        "date_col": {"type": "integer", "nullable": True},
        "item_col": {"type": "integer", "nullable": True},
        "qty_col": {"type": "integer", "nullable": True},
        "amount_col": {"type": "integer", "nullable": True},
        "date_format": {"type": "string", "nullable": True},
        "confidence": {"type": "number"},
        "notes": {"type": "string", "nullable": True},
    },
    "propertyOrdering": ["header_row", "date_col", "item_col", "qty_col",
                         "amount_col", "date_format", "confidence", "notes"],
}

_MAPPING_PROMPT = (
    "다음은 카페 POS기가 출력한 매출 파일의 상단 일부다. 열(column)은 0부터 시작하는 정수 인덱스로 지칭한다.\n"
    "우리 시스템의 매출 스키마(날짜, 메뉴명, 수량, 총결제금액)에 이 파일의 어느 열이 대응하는지 찾아라.\n"
    "- header_row: 실제 열 제목이 있는 행의 인덱스 (상단에 매장명·기간 같은 잡정보가 있을 수 있음)\n"
    "- date_col/item_col/qty_col/amount_col: 각 항목에 해당하는 열 인덱스 (없으면 null)\n"
    "- date_format: 날짜 열의 파이썬 strftime 포맷 (예: %Y-%m-%d %H:%M). 모르면 null\n"
    "- confidence: 0~1 확신도\n"
    "표현이 달라도(수량/판매수량/Qty, 금액/판매금액/합계 등) 의미로 판단하라.\n"
    "오직 JSON만 반환한다.\n\n"
)


def _heuristic_mapping(grid: list[list[str]]) -> dict[str, Any]:
    """LLM 없이 헤더 키워드로 매핑 추정 (폴백·테스트용)."""
    KEYS = {
        "date_col": ["일시", "날짜", "일자", "판매일", "결제일", "date", "time", "datetime"],
        "item_col": ["메뉴", "상품", "품목", "제품", "item", "product", "name"],
        "qty_col": ["수량", "잔수", "판매수량", "qty", "quantity", "count"],
        "amount_col": ["금액", "매출", "판매금액", "결제금액", "합계", "amount", "total", "price"],
    }
    # 헤더 행 = 위에서부터 키워드가 가장 많이 걸리는 행
    best_row, best_hits = 0, -1
    for i, row in enumerate(grid[:10]):
        joined = " ".join(row).lower()
        hits = sum(1 for kws in KEYS.values() for k in kws if k in joined)
        if hits > best_hits:
            best_hits, best_row = hits, i
    header = [str(c).lower() for c in grid[best_row]]
    mapping: dict[str, Any] = {"header_row": best_row, "date_format": None,
                               "source": "heuristic",
                               "confidence": 0.4 if best_hits > 0 else 0.1,
                               "notes": "키워드 휴리스틱 (AI 미사용)"}
    for field, kws in KEYS.items():
        idx = None
        for ci, col in enumerate(header):
            if any(k in col for k in kws):
                idx = ci
                break
        mapping[field] = idx
    return mapping


async def infer_mapping(grid: list[list[str]]) -> dict[str, Any]:
    """열 매핑을 LLM으로 추론. 키가 없거나 실패하면 휴리스틱으로 폴백.

    어떤 엔진이 왜 쓰였는지 결과에 남긴다(source/notes/error) — 폴백이 조용히 일어나
    "무엇이 문제인지" 알기 어렵던 걸, 미리보기에서 바로 보이게 하기 위함.
    """
    if not GEMINI_API_KEY:
        m = _heuristic_mapping(grid)
        m["notes"] = "AI 키 없음 → 키워드 휴리스틱"
        return m
    payload = {
        "contents": [{"parts": [{"text": _MAPPING_PROMPT + _sample_text(grid)}]}],
        "generationConfig": {
            "responseMimeType": "application/json",
            "responseSchema": _MAPPING_SCHEMA,
            "temperature": 0,
            "maxOutputTokens": 512,
        },
    }
    try:
        async with httpx.AsyncClient(timeout=GEMINI_TIMEOUT) as client:
            resp = await client.post(
                f"https://generativelanguage.googleapis.com/v1beta/models/{GEMINI_MODEL}:generateContent",
                json=payload, headers={"x-goog-api-key": GEMINI_API_KEY})
            resp.raise_for_status()
            content = resp.json()["candidates"][0]["content"]["parts"][0]["text"]
            content = re.sub(r"^```(?:json)?\s*|\s*```$", "", content.strip(), flags=re.DOTALL)
            data = json.loads(content)
            data.setdefault("header_row", 0)
            data.setdefault("confidence", 0.5)
            data["source"] = "ai"
            data.setdefault("notes", "AI 자동 분석")
            return data
    except Exception as e:
        logger.warning(f"[매출 임포트] LLM 매핑 실패 — 휴리스틱 폴백: {e}")
        fallback = _heuristic_mapping(grid)
        fallback["notes"] = "AI 분석 실패 → 키워드 휴리스틱 폴백"
        fallback["error"] = str(e)[:200]
        return fallback


# ---------------------------------------------------------------------------
# 3) 매핑 적용 → 미리보기 행 (메뉴 매칭 · 경고 포함). 결정론적.
# ---------------------------------------------------------------------------

def _norm(s: str) -> str:
    return re.sub(r"\s+", "", str(s or "")).lower()


def _to_int(s: str) -> Optional[int]:
    if s is None:
        return None
    m = re.sub(r"[^\d-]", "", str(s))  # 통화기호·콤마 제거
    if m in ("", "-"):
        return None
    try:
        return int(m)
    except ValueError:
        return None


def _parse_date(s: str, fmt: Optional[str]) -> Optional[str]:
    raw = str(s or "").strip()
    if not raw:
        return None
    if fmt:
        try:
            return datetime.strptime(raw, fmt).isoformat()
        except ValueError:
            pass
    # 흔한 포맷 자동 시도
    for f in ("%Y-%m-%d %H:%M:%S", "%Y-%m-%d %H:%M", "%Y-%m-%d", "%Y/%m/%d %H:%M",
              "%Y/%m/%d", "%Y.%m.%d %H:%M", "%Y.%m.%d", "%m/%d/%Y"):
        try:
            return datetime.strptime(raw[:len(datetime.now().strftime(f)) + 4], f).isoformat()
        except ValueError:
            continue
    return None


def build_preview(store_id: str, grid: list[list[str]], mapping: dict[str, Any]) -> dict[str, Any]:
    """매핑을 적용해 미리보기 행을 만든다. DB에 저장하지 않는다.

    각 행에 메뉴 매칭 결과(menu_id)와 경고(매칭 실패·수량/날짜 없음)를 붙여 돌려준다.
    """
    from app.models.inventory import Menu
    from app.services.ai.document_service import _session

    header_row = int(mapping.get("header_row") or 0)
    date_c = mapping.get("date_col")
    item_c = mapping.get("item_col")
    qty_c = mapping.get("qty_col")
    amt_c = mapping.get("amount_col")

    if item_c is None:
        raise SalesImportError("메뉴명 열을 찾지 못했습니다. 파일을 확인하거나 열을 직접 지정해 주세요.")

    # 매장 메뉴 목록 (이름 정규화 → id·판매가)
    with _session() as db:
        menus = db.query(Menu).filter(Menu.store_id == store_id).all()
        by_name = {_norm(m.name): {"id": m.id, "name": m.name, "price": m.selling_price} for m in menus}

    data_rows = grid[header_row + 1:]
    rows: list[dict[str, Any]] = []
    for r in data_rows[:MAX_ROWS]:
        def cell(ci: Optional[Any]) -> str:
            if ci is None:
                return ""
            ci = int(ci)
            return r[ci] if 0 <= ci < len(r) else ""

        name = cell(item_c).strip()
        if not name:
            continue  # 메뉴명 없는 행은 합계/공백 행일 가능성 — 건너뜀
        qty = _to_int(cell(qty_c)) if qty_c is not None else 1
        if qty is None:
            qty = 1
        amount = _to_int(cell(amt_c)) if amt_c is not None else None
        sold_at = _parse_date(cell(date_c), mapping.get("date_format")) if date_c is not None else None

        matched = by_name.get(_norm(name))
        warnings = []
        if matched is None:
            warnings.append("메뉴 매칭 안 됨")
        if amount is None:
            if matched:
                amount = matched["price"] * qty  # 금액 없으면 메뉴 판매가로 대체
                warnings.append("금액 없음 → 메뉴 판매가로 추정")
            else:
                warnings.append("금액 없음")
        if sold_at is None and date_c is not None:
            warnings.append("날짜 파싱 실패")

        rows.append({
            "menu_name": name,
            "menu_id": matched["id"] if matched else None,
            "matched_name": matched["name"] if matched else None,
            "quantity": qty,
            "total_price": amount,
            "sold_at": sold_at,
            "warnings": warnings,
        })

    matched_cnt = sum(1 for x in rows if x["menu_id"] is not None)
    return {
        "mapping": mapping,
        # 어떤 엔진으로 열을 매핑했는지 한눈에 (미리보기 배지·디버깅용)
        "source": mapping.get("source", "heuristic"),  # 'ai' | 'heuristic'
        "mapping_note": mapping.get("notes"),
        "mapping_error": mapping.get("error"),          # AI 실패 사유(있을 때만)
        "confidence": mapping.get("confidence"),
        "rows": rows,
        "summary": {
            "total_rows": len(rows),
            "matched": matched_cnt,
            "unmatched": len(rows) - matched_cnt,
            "sum_amount": sum(x["total_price"] or 0 for x in rows),
        },
    }


# ---------------------------------------------------------------------------
# 4) 확정 저장 — 사용자가 확인·수정한 행만 받는다. 파일의 실제 금액·날짜 보존.
#    Sale 생성 + 레시피 재고 차감(record_sales와 동일 정책).
# ---------------------------------------------------------------------------

def save_import(store_id: str, rows: list[dict[str, Any]]) -> dict[str, Any]:
    """확인된 행([{menu_id, quantity, total_price, sold_at}])을 Sale로 저장하고 재고를 차감한다."""
    from app.models.inventory import Menu, Recipe, Sale, Stock, StockTransaction
    from app.services.ai.document_service import _session

    valid = [r for r in rows if r.get("menu_id")]
    if not valid:
        raise SalesImportError("저장할 (메뉴 매칭된) 행이 없습니다.")

    created = 0
    total_amount = 0
    with _session() as db:
        # 매장 메뉴 검증용
        menu_ids = {m.id for m in db.query(Menu).filter(Menu.store_id == store_id).all()}
        for r in valid:
            mid = int(r["menu_id"])
            if mid not in menu_ids:
                continue  # 남의 매장/삭제된 메뉴는 건너뜀 (클라이언트 값 방어)
            qty = max(1, int(r.get("quantity") or 1))
            amount = int(r.get("total_price") or 0)
            sold_at = _coerce_dt(r.get("sold_at"))
            db.add(Sale(menu_id=mid, quantity=qty, total_price=amount,
                        store_id=store_id, sold_at=sold_at))
            # 레시피 기준 재고 차감 (수동 입력과 동일)
            for recipe in db.query(Recipe).filter(Recipe.menu_id == mid).all():
                use = recipe.quantity * qty
                stock = db.query(Stock).filter(Stock.ingredient_id == recipe.ingredient_id).first()
                if stock is not None:
                    stock.current_quantity = max(0.0, stock.current_quantity - use)
                db.add(StockTransaction(ingredient_id=recipe.ingredient_id, quantity_change=-use,
                                        type="OUT", description="POS 파일 매출 반영"))
            created += 1
            total_amount += amount
        db.commit()

    return {"created": created, "total": total_amount}


def _coerce_dt(v: Any) -> datetime:
    if isinstance(v, datetime):
        return v
    if isinstance(v, str) and v:
        try:
            return datetime.fromisoformat(v)
        except ValueError:
            pass
    return datetime.now()
