"""OCR 로직 (백엔드 B)

AI-2: 거래명세서/영수증 사진 → {상품, 단가, 수량} 구조화 → 등록 초안.

세 가지 VLM 백엔드를 지원한다 (OCR_BACKEND 환경변수로 선택, 폴백 없음):
  - llamacpp_vlm (기본): 파인튜닝 Qwen3.5-0.8B를 GGUF(Q8)로 변환해 llama.cpp 서버로
    서빙 — RTX 5060 실측 웜 3.3초/장 (transformers 13초 대비 4배). 서버가 없으면
    warmup 때 tools_bin/llama-server.exe를 자동 기동한다.
    변환/벤치는 backend/vlm_finetune/ (export_merged35.py → convert → gguf 메타 패치).
  - qwen_vlm: 같은 파인튜닝 모델을 transformers로 직접 로드 (PRD §5.2 ①).
    외부 프로세스가 없어 단순하지만 느리다. 학습은 backend/vlm_finetune/train35.py.
  - ollama_vlm: VLM 단독 — 로컬 gemma4가 이미지에서 바로 추출. 완전 오프라인용.

(CLOVA OCR + Gemini 2단계 경로는 파인튜닝 VLM 전환으로 삭제됨 — 외부 API 의존과
 월 100건 무료 한도 관리가 사라졌다)

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
from concurrent.futures import ThreadPoolExecutor
from datetime import date, datetime, timedelta, timezone
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
from app.services.ai.vlm_prompt import EXTRACTION_SCHEMA, RULES, VLM_PROMPT

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
OCR_BACKEND = os.getenv("OCR_BACKEND", "llamacpp_vlm")

_VLM_FINETUNE_DIR = Path(__file__).resolve().parents[3] / "vlm_finetune"

# llama.cpp 서버 (파인튜닝 Qwen3.5-0.8B GGUF Q8 — vlm_finetune/output에서 변환)
LLAMACPP_BASE_URL = os.getenv("LLAMACPP_BASE_URL", "http://localhost:8089")
LLAMACPP_TIMEOUT = float(os.getenv("LLAMACPP_TIMEOUT", "120"))
LLAMACPP_AUTOSTART = os.getenv("LLAMACPP_AUTOSTART", "1") == "1"
LLAMACPP_SERVER_EXE = Path(os.getenv("LLAMACPP_SERVER_EXE", _VLM_FINETUNE_DIR / "tools_bin" / "llama-server.exe"))
LLAMACPP_MODEL_GGUF = Path(os.getenv("LLAMACPP_MODEL_GGUF", _VLM_FINETUNE_DIR / "output" / "qwen35-08b-ocr-q8.gguf"))
LLAMACPP_MMPROJ_GGUF = Path(os.getenv("LLAMACPP_MMPROJ_GGUF", _VLM_FINETUNE_DIR / "output" / "mmproj-qwen35-08b.gguf"))

# 파인튜닝 Qwen VLM (backend/vlm_finetune/train35.py가 만든 LoRA 어댑터)
QWEN_VLM_BASE = os.getenv("QWEN_VLM_BASE", "Qwen/Qwen3.5-0.8B")
QWEN_VLM_ADAPTER_DIR = Path(
    os.getenv("QWEN_VLM_ADAPTER_DIR", _VLM_FINETUNE_DIR / "output" / "adapter35")
)
# 1024는 품목 20개+에서, 1536도 24품목+할인줄에서 JSON이 잘린다 (실측 2건).
# ctx 8192 기준 vision ~1200 + 프롬프트 ~400 + 2048 생성 = 여유 있음.
QWEN_VLM_MAX_NEW_TOKENS = int(os.getenv("QWEN_VLM_MAX_NEW_TOKENS", "2048"))
# 4bit(bnb nf4)는 VRAM을 아끼는 대신 매 토큰마다 역양자화가 들어가 오히려 2배 느리다.
# RTX 5060(8GB) 실측: 4bit 10 tok/s·25초 vs bf16+어댑터병합 20 tok/s·14초, 피크 VRAM 4.5GB.
# 2B 모델은 bf16으로도 8GB에 충분히 들어가므로 기본은 bf16. VRAM이 더 좁은 GPU에서만 1로 켤 것.
QWEN_VLM_LOAD_4BIT = os.getenv("QWEN_VLM_LOAD_4BIT", "0") == "1"
# LoRA 어댑터를 베이스 가중치에 합쳐 매 토큰 추가 행렬곱을 없앤다 (4bit일 땐 합칠 수 없어 자동 무시).
QWEN_VLM_MERGE_ADAPTER = os.getenv("QWEN_VLM_MERGE_ADAPTER", "1") == "1"
# 서버 기동 시 모델 미리 로드 (첫 요청의 ~25초 지연 제거). GPU를 다른 작업(학습·벤치)에
# 쓰는 중이면 0으로 꺼서 VRAM 경합을 피한다.
QWEN_VLM_WARMUP = os.getenv("QWEN_VLM_WARMUP", "1") == "1"
# 추론 해상도는 학습(train.py --max-side, 기본 1024)과 반드시 일치시킨다.
# 1280(기본 전처리)으로 넣으면 학습 때 안 본 해상도라 정확도가 떨어지고,
# vision 토큰이 (1280/1024)^2≈1.56배로 늘어 prefill이 그만큼 느려진다.
QWEN_VLM_MAX_IMAGE_SIDE = int(os.getenv("QWEN_VLM_MAX_IMAGE_SIDE", "1024"))
# Blackwell(RTX 50)은 flash_attention_2를 지원하지만 sm_120 휠이 없을 수 있어 기본은 sdpa.
# flash-attn이 설치돼 있으면 QWEN_VLM_ATTN=flash_attention_2로 prefill을 더 줄일 수 있다.
QWEN_VLM_ATTN = os.getenv("QWEN_VLM_ATTN", "sdpa")

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

# 추출 프롬프트/스키마는 vlm_prompt.py가 단일 소스 (학습 스크립트와 공유)
_EXTRACTION_SCHEMA = EXTRACTION_SCHEMA
_RULES = RULES
_PROMPT = VLM_PROMPT

# 문서 종류 → 등록 대상 추천 (사용자가 확정 전 변경 가능)
# receipt는 원래 expense(지출)였으나 지출 기능이 미구현이라 확정해도 보관만 되므로,
# 구매 영수증은 재고 입고로 추천한다 (백엔드 C가 expense 구현하면 되돌릴 것)
_TARGET_BY_DOC_TYPE: dict[str, RegisterTarget] = {
    "purchase_statement": "inventory_inbound",
    "tax_invoice": "inventory_inbound",
    "receipt": "inventory_inbound",
    "sales_summary": "sales",
}

# ---------------------------------------------------------------------------
# 초안 저장소 — PostgreSQL(ocr_documents 테이블) 우선, DB 연결 불가 시 인메모리 폴백.
# 폴백 시 서버 재시작하면 초안이 사라지지만 OCR 기능 자체는 계속 동작한다 (PRD §7 가용성).
# ---------------------------------------------------------------------------
_DRAFTS: dict[str, dict[str, Any]] = {}  # 인메모리 폴백
_db_available: Optional[bool] = None


def _check_db() -> bool:
    """첫 사용 시 1회만 DB 연결을 확인하고 결과를 캐시한다."""
    global _db_available
    if _db_available is None:
        try:
            from sqlalchemy import text as _text

            import app.models  # noqa: F401 — OcrDocument를 Base.metadata에 등록
            from app.core.database import Base, SessionLocal, engine

            Base.metadata.create_all(bind=engine)  # 테이블 없으면 생성 (있으면 no-op)
            with SessionLocal() as session:
                session.execute(_text("SELECT 1"))
            _db_available = True
            logger.info("OCR 저장소: PostgreSQL(ocr_documents) 사용")
        except Exception as e:
            _db_available = False
            logger.warning("OCR 저장소: DB 연결 불가(%s) — 인메모리 폴백 (재시작 시 초안 소실)", e)
    return _db_available


def _row_to_draft(row) -> dict[str, Any]:
    """DB 행(문서+품목)을 서비스 표준 draft dict로 복원한다. 검증 경고는 재계산."""
    result = OcrResult(
        doc_type=row.doc_type,
        vendor={"name": row.vendor_name, "biz_no": None, "phone": None},
        issued_date=row.issued_date,
        items=[
            OcrItem(
                name=item.name,
                spec=item.spec,
                quantity=float(item.quantity) if item.quantity is not None else None,
                unit=item.unit,
                unit_price=float(item.unit_price) if item.unit_price is not None else None,
                amount=float(item.amount) if item.amount is not None else None,
            )
            for item in row.items
        ],
        discount=float(row.discount) if row.discount is not None else None,
        subtotal=float(row.subtotal) if row.subtotal is not None else None,
        tax=float(row.tax) if row.tax is not None else None,
        total=float(row.total) if row.total is not None else None,
    )
    warnings = _validate_result(result)  # 저장하지 않으므로 조회 시 재계산 (항상 최신 로직 기준)
    return {
        "id": row.id,
        "status": row.status,
        "filename": None,
        "image_path": None,  # 원본은 uploads/ocr/{id}.* 규칙으로 디스크에만 보관
        "result": result,
        "suggested_target": row.target,
        "warnings": warnings,
        "confirmed_target": row.target if row.status == "confirmed" else None,
        "applied": row.applied,
        "elapsed_sec": None,
        "ocr_backend": None,
        "created_at": row.created_at,
        "updated_at": row.updated_at,
    }


def _save_draft_background(draft: dict[str, Any]) -> None:
    """초안 저장을 백그라운드 스레드에서 — 원격 DB 왕복(~2초)이 OCR 응답을 막지 않게 한다.

    사용자는 응답을 받고 품목을 검토한 뒤에야 수정/확정하므로 그사이 저장이 끝난다.
    실패하면 로그만 남는다 (조회/확정 시 404로 드러나므로 재촬영으로 복구 가능).
    """
    try:
        _save_draft(draft)
    except Exception:
        logger.exception("OCR %s 초안 백그라운드 저장 실패", draft["id"])


def _save_draft(draft: dict[str, Any]) -> None:
    """초안을 저장(생성/갱신)한다. 품목은 ocr_items에 행 단위로 저장."""
    if not _check_db():
        _DRAFTS[draft["id"]] = draft
        return
    from app.core.database import SessionLocal
    from app.models import ai as ai_models

    result: OcrResult = draft["result"]
    with SessionLocal() as session:
        row = session.get(ai_models.OcrDocument, draft["id"]) or ai_models.OcrDocument(id=draft["id"])
        row.status = draft["status"]
        row.doc_type = result.doc_type
        row.vendor_name = result.vendor.name
        row.issued_date = result.issued_date
        row.discount = result.discount
        row.subtotal = result.subtotal
        row.tax = result.tax
        row.total = result.total
        row.target = draft["confirmed_target"] or draft["suggested_target"]
        row.applied = draft["applied"]
        row.created_at = draft["created_at"]
        row.updated_at = draft["updated_at"]
        # 품목은 통째로 교체 (수정 시 추가/삭제/변경을 한 번에 반영)
        row.items = [
            ai_models.OcrItem(
                position=idx,
                name=item.name,
                spec=item.spec,
                quantity=item.quantity,
                unit=item.unit,
                unit_price=item.unit_price,
                amount=item.amount,
            )
            for idx, item in enumerate(result.items)
        ]
        session.add(row)
        session.commit()


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
    gray = small.convert("L")
    mask = gray.point(lambda p: 255 if p > 200 else 0)
    mask = mask.filter(ImageFilter.MinFilter(5))  # 배경의 작은 밝은 점 제거
    bbox = mask.getbbox()
    if not bbox:
        return img
    area_ratio = (bbox[2] - bbox[0]) * (bbox[3] - bbox[1]) / (small.width * small.height)
    if not (0.10 <= area_ratio <= 0.95):  # 전체가 밝거나(이미 문서 전체 사진) 못 찾은 경우
        return img
    # 안전장치: bbox 안팎의 밝기 차이가 작으면 배경도 밝은 장면(나무 탁자 등)이라
    # 탐지가 불안정하다 — 크롭하면 영수증 하단이 잘려나가는 실측 사고(590×680→448×502,
    # 품목 3개+합계 유실)가 있었다. 확실할 때만 자른다.
    import numpy as np
    arr = np.asarray(gray, dtype=np.float32)
    inside = arr[bbox[1]:bbox[3], bbox[0]:bbox[2]].mean()
    outside_mask = np.ones(arr.shape, dtype=bool)
    outside_mask[bbox[1]:bbox[3], bbox[0]:bbox[2]] = False
    if not outside_mask.any() or inside - arr[outside_mask].mean() < 40:
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
    """폰 사진 대비: EXIF 회전 보정 + 문서 영역 자동 크롭 + 크기 정규화 + JPEG 재인코딩.

    크기 정규화는 두 방향:
    - 큰 사진: 총 픽셀이 max_side² 이하가 되도록 종횡비 유지 축소. '긴 변 고정'은
      세로로 긴 영수증(700×3000)을 239×1024로 뭉개 글자가 소실된다 — 픽셀 예산
      방식이면 같은 연산량으로 494×2121을 유지한다 (학습 v2와 동일 방식).
    - 아주 작은 사진(웹 축소본 등, 실측 387×516 업로드): 2배 업스케일. 정보가 늘진
      않지만 글자 픽셀 크기를 학습 분포에 근접시켜 인식률이 오른다.
    """
    try:
        img = Image.open(io.BytesIO(image_bytes))
        img = ImageOps.exif_transpose(img)
        img = img.convert("RGB")
        img = _auto_crop_document(img)
        if max(img.size) < 900:  # 저해상도 구제 업스케일
            img = img.resize((img.width * 2, img.height * 2), Image.LANCZOS)
        budget = max_side * max_side
        if img.width * img.height > budget:
            scale = (budget / (img.width * img.height)) ** 0.5
            img = img.resize((max(1, int(img.width * scale)), max(1, int(img.height * scale))), Image.LANCZOS)
        buf = io.BytesIO()
        img.save(buf, "JPEG", quality=88)
        return buf.getvalue()
    except Exception:
        logger.warning("이미지 전처리 실패 — 원본 그대로 사용", exc_info=True)
        return image_bytes


def _upscale_for_rescue(image_bytes: bytes, side: int) -> Optional[bytes]:
    """저해상도 이미지를 학습 해상도(side)로 업스케일한 JPEG를 반환. 이미 크면 None.

    파인튜닝 모델은 학습 때 본 스케일보다 훨씬 작은 이미지(카톡 전송본 등)에서 품목을
    헛읽고 반복 루프에 빠진다 — 387px 영수증 실측: 원본 전멸, 업스케일 후 9/9 정확.
    단 중간 해상도(900px대)는 업스케일이 오히려 루프를 유발하므로(실측) 항상 쓰지 않고,
    1차 시도가 파싱 실패했을 때의 구제용으로만 쓴다.
    """
    try:
        img = Image.open(io.BytesIO(image_bytes))
        if max(img.size) >= side:
            return None
        scale = side / max(img.size)
        img = img.convert("RGB").resize(
            (round(img.width * scale), round(img.height * scale)), Image.LANCZOS
        )
        buf = io.BytesIO()
        img.save(buf, "JPEG", quality=92)
        return buf.getvalue()
    except Exception:
        return None


def _parse_model_json(content: str) -> dict[str, Any]:
    """모델 응답에서 JSON을 최대한 회수한다 (코드펜스·앞뒤 잡설·꼬리 절단 허용)."""
    content = content.strip()
    if content.startswith("```"):
        content = re.sub(r"^```(?:json)?\s*|\s*```$", "", content, flags=re.DOTALL)
    try:
        return json.loads(content)
    except json.JSONDecodeError:
        match = re.search(r"\{.*\}", content, re.DOTALL)
        if match:
            try:
                return json.loads(match.group())
            except json.JSONDecodeError:
                pass
        # 생성 한도에 걸려 꼬리가 잘린 경우: 마지막 완전한 품목(`}`)까지 자르고 닫는다.
        # 품목 일부를 잃더라도 인식 실패보다 낫다 — 유실 가능성은 검증 경고가 알려준다.
        cut = content.rfind("},")
        if cut != -1:
            repaired = content[: cut + 1] + "]}"
            try:
                result = json.loads(repaired)
                logger.warning("모델 응답 꼬리 절단 복구 — 품목 일부 유실 가능 (원본 %d자)", len(content))
                return result
            except json.JSONDecodeError:
                pass
        raise


# 파인튜닝 Qwen VLM — 프로세스당 1회 로드해 상주시킨다 (로드 ~17초, 이후 호출 10초대)
_qwen_vlm: Optional[tuple[Any, Any]] = None
_qwen_vlm_lock = threading.Lock()
# GPU는 하나뿐이라 추론을 직렬화한다. 기본 executor를 쓰면 동시 요청이 같은 GPU에서
# 겹쳐 서로를 느리게 만들고 VRAM 피크가 겹쳐 OOM이 난다.
_qwen_vlm_executor = ThreadPoolExecutor(max_workers=1, thread_name_prefix="qwen-vlm")


def _load_qwen_vlm() -> tuple[Any, Any]:
    global _qwen_vlm
    with _qwen_vlm_lock:
        if _qwen_vlm is None:
            import torch
            # AutoModelForImageTextToText가 config로 클래스를 찾으므로 Qwen3-VL과
            # Qwen3.5(early-fusion) 모두 이 한 줄로 로드된다.
            from transformers import AutoModelForImageTextToText, AutoProcessor

            device = "cuda:0" if torch.cuda.is_available() else "cpu"
            dtype = torch.bfloat16 if device.startswith("cuda") else torch.float32
            logger.info("Qwen VLM 로드 시작 — %s (%s, 4bit=%s)", QWEN_VLM_BASE, device, QWEN_VLM_LOAD_4BIT)
            processor = AutoProcessor.from_pretrained(QWEN_VLM_BASE)
            quant = None
            if QWEN_VLM_LOAD_4BIT and device.startswith("cuda"):
                from transformers import BitsAndBytesConfig

                quant = BitsAndBytesConfig(
                    load_in_4bit=True, bnb_4bit_quant_type="nf4",
                    bnb_4bit_use_double_quant=True, bnb_4bit_compute_dtype=torch.bfloat16,
                )
            model = AutoModelForImageTextToText.from_pretrained(
                QWEN_VLM_BASE, dtype=dtype, attn_implementation=QWEN_VLM_ATTN, device_map=device,
                quantization_config=quant,
            )
            if (QWEN_VLM_ADAPTER_DIR / "adapter_config.json").exists():
                from peft import PeftModel

                model = PeftModel.from_pretrained(model, str(QWEN_VLM_ADAPTER_DIR))
                # 4bit 위에서는 병합 시 역양자화가 필요해 지원되지 않는다 — bf16일 때만 합친다.
                if QWEN_VLM_MERGE_ADAPTER and quant is None:
                    model = model.merge_and_unload()
                    logger.info("Qwen VLM LoRA 어댑터 병합 — %s", QWEN_VLM_ADAPTER_DIR)
                else:
                    logger.info("Qwen VLM LoRA 어댑터 적용 — %s", QWEN_VLM_ADAPTER_DIR)
            else:
                logger.warning("Qwen VLM 어댑터 없음(%s) — 베이스 모델로 동작. "
                               "backend/vlm_finetune/train.py로 학습하세요", QWEN_VLM_ADAPTER_DIR)
            model.eval()
            _qwen_vlm = (model, processor)
    return _qwen_vlm


def _qwen_vlm_infer_sync(image_bytes: bytes) -> dict[str, Any]:
    """동기 추론 본체 — 이벤트 루프를 막지 않도록 executor에서 호출된다."""
    import torch

    model, processor = _load_qwen_vlm()
    img = Image.open(io.BytesIO(image_bytes)).convert("RGB")
    inputs = processor.apply_chat_template(
        [{"role": "user", "content": [{"type": "image", "image": img}, {"type": "text", "text": _PROMPT}]}],
        tokenize=True, add_generation_prompt=True, return_dict=True, return_tensors="pt",
    ).to(model.device)
    with torch.inference_mode():
        out = model.generate(**inputs, max_new_tokens=QWEN_VLM_MAX_NEW_TOKENS, do_sample=False)
    return _parse_model_json(
        processor.decode(out[0][inputs["input_ids"].shape[1]:], skip_special_tokens=True)
    )


async def _call_qwen_vlm(image_bytes: bytes) -> dict[str, Any]:
    """파인튜닝 Qwen3-VL 호출 — 이미지 1장을 구조화 JSON으로 (외부 API 없음)."""
    try:
        return await asyncio.get_running_loop().run_in_executor(
            _qwen_vlm_executor, _qwen_vlm_infer_sync, image_bytes
        )
    except json.JSONDecodeError as e:
        raise OcrError(f"Qwen VLM 응답이 JSON이 아닙니다: {e}") from e
    except OcrError:
        raise
    except Exception as e:
        raise OcrError(f"Qwen VLM 추론 실패: {e}") from e


# ---------------------------------------------------------------------------
# llama.cpp 백엔드 — 파인튜닝 GGUF를 상주 서버로 서빙 (웜 3.3초/장, transformers의 4배)
# ---------------------------------------------------------------------------
_llamacpp_proc: Optional[Any] = None  # 우리가 직접 띄운 경우에만 핸들 보관


def _llamacpp_healthy() -> bool:
    try:
        return httpx.get(f"{LLAMACPP_BASE_URL}/health", timeout=2).status_code == 200
    except httpx.HTTPError:
        return False


def _start_llamacpp_server() -> None:
    """llama-server를 백그라운드 프로세스로 기동한다 (이미 떠 있으면 아무것도 안 함).

    모델 로드까지 수 초 걸리므로 기동 직후 요청은 _call_llamacpp_vlm의 재시도가 흡수한다.
    """
    global _llamacpp_proc
    if _llamacpp_healthy():
        logger.info("llama.cpp 서버 이미 실행 중 — %s", LLAMACPP_BASE_URL)
        return
    if not (LLAMACPP_SERVER_EXE.exists() and LLAMACPP_MODEL_GGUF.exists() and LLAMACPP_MMPROJ_GGUF.exists()):
        logger.warning("llama.cpp 자동 기동 불가 — 실행파일/GGUF 없음 (%s). "
                       "vlm_finetune/README의 GGUF 변환 절차를 확인하세요", LLAMACPP_SERVER_EXE)
        return
    import subprocess

    port = LLAMACPP_BASE_URL.rsplit(":", 1)[-1]
    _llamacpp_proc = subprocess.Popen(
        [str(LLAMACPP_SERVER_EXE), "-m", str(LLAMACPP_MODEL_GGUF), "--mmproj", str(LLAMACPP_MMPROJ_GGUF),
         "-ngl", "99", "--port", port, "--ctx-size", "8192"],
        stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
        creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0),
    )
    logger.info("llama.cpp 서버 기동 — %s (pid %s)", LLAMACPP_BASE_URL, _llamacpp_proc.pid)


async def _call_llamacpp_vlm(image_bytes: bytes, rescue_bytes: Optional[bytes] = None) -> dict[str, Any]:
    """llama-server(OpenAI 호환) 호출 — 이미지 1장을 구조화 JSON으로.

    enable_thinking=False가 필수: 기본 챗 템플릿이 thinking 모드를 켜서
    토큰 한도를 추론으로 전부 태우고 content가 빈 채로 끝난다 (실측).

    temperature=0이라 같은 이미지 재요청은 같은 출력만 반환한다. 그래서 JSON 파싱
    실패(저해상도 반복 루프로 출력이 잘린 경우)는 재요청 대신 업스케일본(rescue_bytes)으로
    한 번 더 시도한다. HTTP 오류만 같은 이미지로 재시도한다(서버 자동 기동 직후 로드 지연).
    """
    variants = [image_bytes] + ([rescue_bytes] if rescue_bytes is not None else [])
    last_error: Exception | None = None
    for img in variants:
        payload = {
            "messages": [{"role": "user", "content": [
                {"type": "image_url",
                 "image_url": {"url": f"data:image/jpeg;base64,{base64.b64encode(img).decode()}"}},
                {"type": "text", "text": _PROMPT},
            ]}],
            "max_tokens": QWEN_VLM_MAX_NEW_TOKENS,
            "temperature": 0,
            "chat_template_kwargs": {"enable_thinking": False},
        }
        content: Optional[str] = None
        for attempt in (1, 2, 3):
            try:
                async with httpx.AsyncClient(timeout=LLAMACPP_TIMEOUT) as client:
                    resp = await client.post(f"{LLAMACPP_BASE_URL}/v1/chat/completions", json=payload)
                    resp.raise_for_status()
                content = resp.json()["choices"][0]["message"]["content"] or ""
                break
            except (httpx.HTTPError, KeyError) as e:
                last_error = e
                if attempt < 3:
                    await asyncio.sleep(3 * attempt)
        if content is None:
            continue
        try:
            return _parse_model_json(content)
        except json.JSONDecodeError as e:
            last_error = e
            if img is not variants[-1]:
                logger.warning("llama.cpp 출력 JSON 파싱 실패 — 업스케일본으로 구제 재시도")
    raise OcrError(f"llama.cpp OCR 실패 ({LLAMACPP_BASE_URL}): {last_error}")


def warmup_ocr_backend() -> None:
    """서버 기동 시 백엔드를 예열한다 — 첫 요청의 로드 지연 제거.

    - llamacpp_vlm: llama-server가 없으면 자동 기동 (LLAMACPP_AUTOSTART=0으로 끌 수 있음)
    - qwen_vlm: transformers 모델을 미리 로드 (~17초)
    앱 시작을 막지 않도록 백그라운드 스레드에서 돌린다. 실패해도 첫 요청 때 다시
    시도하므로 로그만 남기고 넘어간다.
    """
    if OCR_BACKEND == "llamacpp_vlm" and LLAMACPP_AUTOSTART:
        threading.Thread(target=_start_llamacpp_server, name="llamacpp-warmup", daemon=True).start()
        return
    if OCR_BACKEND != "qwen_vlm" or not QWEN_VLM_WARMUP:
        return

    def _warm() -> None:
        try:
            _load_qwen_vlm()
            logger.info("Qwen VLM 예열 완료")
        except Exception as e:  # 예열 실패가 서버 기동을 막아선 안 된다
            logger.warning("Qwen VLM 예열 실패 — 첫 요청 때 다시 로드합니다: %s", e)

    threading.Thread(target=_warm, name="qwen-vlm-warmup", daemon=True).start()


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
        # 부동소수점 잔재 정리 (6900.000000000001 → 6900.0)
        for field in ("quantity", "unit_price", "amount"):
            value = getattr(item, field)
            if value is not None:
                setattr(item, field, round(value, 2))
        q, u, a = item.quantity, item.unit_price, item.amount
        known = sum(v is not None for v in (q, u, a))
        if known == 3:
            expected = q * u
            if abs(expected - a) > max(abs(a) * AMOUNT_TOLERANCE, AMOUNT_TOLERANCE_ABS):
                # 금액(실제 청구액)을 기준으로 단가를 역산했을 때 차이가 작으면(±20%)
                # 단가 한 자릿수 오독(실측: 9,800→9,600)이므로 자동 보정한다.
                # 차이가 크면 수량 오독일 수 있어 보정하지 않고 경고만 남긴다.
                implied_u = a / q if q else None
                if implied_u and abs(implied_u - u) <= abs(u) * 0.2:
                    item.unit_price = round(implied_u, 2)
                    item.warnings.append(
                        f"단가 자동 보정: {u:,.0f} → {implied_u:,.0f} (금액 {a:,.0f} 기준)"
                    )
                else:
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


def _merge_duplicate_items(result: OcrResult) -> None:
    """[OCR 결과 품목 중복 병합 알고리즘]
    하나의 영수증 명세서 내에 동일한 이름을 지닌 품목이 여러 개 흩어져 판독될 경우,
    이를 한 줄로 합치고 수량(quantity)과 총금액(amount)을 합산해 줍니다.
    """
    if not result.items:
        return

    merged: dict[tuple[str, str], OcrItem] = {}

    for item in result.items:
        if not item.name:
            continue
        # 이름이 숫자·기호뿐이면 품목이 아니라 바코드/상품코드 줄이다
        # (코스트코 영수증의 '652125' 같은 줄을 모델이 품목으로 뽑는 실측 사례 차단)
        if re.fullmatch(r"[\d\-*#. ]{5,}", item.name.strip()):
            continue
        # '@CJ_1만원1천원' 같은 할인/프로모션 설명 줄 — 수량·단가·금액이 전부 비면 품목이 아니다
        if item.name.strip().startswith("@") and item.quantity is None and item.amount is None:
            continue
            
        # 이름과 단위를 기준으로 묶어줍니다.
        name_clean = item.name.strip()
        unit_clean = (item.unit or "").strip()
        key = (name_clean, unit_clean)
        
        if key not in merged:
            merged[key] = item
        else:
            existing = merged[key]
            # 1. 수량 합산
            if item.quantity is not None:
                existing.quantity = (existing.quantity or 0.0) + item.quantity
            # 2. 총액 합산
            if item.amount is not None:
                existing.amount = (existing.amount or 0.0) + item.amount
            # 3. 규격(spec) 합산 (콤마로 이어서 유실되지 않게)
            if item.spec and existing.spec and item.spec != existing.spec:
                existing.spec = f"{existing.spec}, {item.spec}"
            elif item.spec and not existing.spec:
                existing.spec = item.spec
                
            # 4. 단가 재조정
            # 총액과 수량이 존재하면 단가를 역산하고, 그렇지 않으면 기존 단가를 유지합니다.
            if existing.amount is not None and existing.quantity and existing.quantity > 0:
                existing.unit_price = round(existing.amount / existing.quantity, 2)
            elif item.unit_price is not None and existing.unit_price is None:
                existing.unit_price = item.unit_price

    result.items = list(merged.values())


def _now() -> datetime:
    return datetime.now(timezone.utc)


async def _run_backend(backend: str, image_bytes: bytes) -> dict[str, Any]:
    """지정한 백엔드로 구조화 결과를 얻는다. 폴백 없이 실패는 그대로 올린다."""
    if backend == "llamacpp_vlm":
        # 학습과 같은 해상도(기본 1024)로 — train/serve skew 방지 + vision 토큰 축소
        std = _preprocess_image(image_bytes, max_side=QWEN_VLM_MAX_IMAGE_SIDE)
        return await _call_llamacpp_vlm(std, rescue_bytes=_upscale_for_rescue(std, QWEN_VLM_MAX_IMAGE_SIDE))
    if backend == "qwen_vlm":
        return await _call_qwen_vlm(_preprocess_image(image_bytes, max_side=QWEN_VLM_MAX_IMAGE_SIDE))
    if backend == "ollama_vlm":
        return await _call_vlm(_preprocess_image(image_bytes))
    raise OcrError(f"알 수 없는 OCR 백엔드: {backend}")


async def analyze_image(image_bytes: bytes, filename: Optional[str] = None) -> dict[str, Any]:
    """이미지 1장을 OCR해 등록 초안을 만든다. 초안은 사람이 확정하기 전까지 아무 데도 반영되지 않는다."""
    # OCR 실패 시에도 원인 분석이 가능하도록 원본을 먼저 저장한다
    doc_id = uuid.uuid4().hex[:12]
    UPLOAD_DIR.mkdir(parents=True, exist_ok=True)
    suffix = Path(filename).suffix if filename else ".jpg"
    image_path = UPLOAD_DIR / f"{doc_id}{suffix}"
    image_path.write_bytes(image_bytes)

    started = time.perf_counter()
    raw = await _run_backend(OCR_BACKEND, image_bytes)
    elapsed = round(time.perf_counter() - started, 1)
    logger.info("OCR %s 완료 — %.1fs (%s)", doc_id, elapsed, OCR_BACKEND)

    result = OcrResult.model_validate(raw)
    _merge_duplicate_items(result)  # 동일 품목 수량/금액 자동 병합
    doc_warnings = _validate_result(result)

    now = _now()
    draft = {
        "id": doc_id,
        "status": "draft",
        "filename": filename,
        "image_path": str(image_path),
        "result": result,
        "suggested_target": _TARGET_BY_DOC_TYPE.get(result.doc_type),
        "warnings": doc_warnings,
        "confirmed_target": None,
        "applied": False,
        "elapsed_sec": elapsed,
        "ocr_backend": OCR_BACKEND,
        "created_at": now,
        "updated_at": now,
    }
    # 저장을 기다리지 않고 바로 응답한다 — 원격 DB 저장 ~2초가 인식 체감 속도에서 빠진다
    asyncio.get_running_loop().run_in_executor(None, _save_draft_background, draft)
    return draft


def get_draft(doc_id: str) -> dict[str, Any]:
    if not _check_db():
        if doc_id not in _DRAFTS:
            raise DraftNotFoundError(doc_id)
        return _DRAFTS[doc_id]
    from app.core.database import SessionLocal
    from app.models.ai import OcrDocument

    with SessionLocal() as session:
        row = session.get(OcrDocument, doc_id)
        if row is None:
            raise DraftNotFoundError(doc_id)
        return _row_to_draft(row)


def list_drafts(status: Optional[str] = None) -> list[dict[str, Any]]:
    if not _check_db():
        docs = sorted(_DRAFTS.values(), key=lambda d: d["created_at"], reverse=True)
        if status:
            docs = [d for d in docs if d["status"] == status]
        return docs
    from app.core.database import SessionLocal
    from app.models.ai import OcrDocument

    with SessionLocal() as session:
        query = session.query(OcrDocument).order_by(OcrDocument.created_at.desc())
        if status:
            query = query.filter(OcrDocument.status == status)
        return [_row_to_draft(row) for row in query.all()]


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
    _save_draft(draft)
    return draft


def confirm_draft(
    doc_id: str,
    target: Optional[RegisterTarget] = None,
    store_id: Optional[str] = None,
) -> tuple[dict[str, Any], str]:
    """사람이 검토를 마친 초안을 확정하고 대상 시스템 반영을 시도한다.

    store_id는 로그인한 사장님의 매장 식별자(이메일) — 재고 반영 시 어느 매장인지에 필요.
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
    applied, message = _apply_to_target(draft, resolved, store_id)
    draft["applied"] = applied
    draft["updated_at"] = _now()
    _save_draft(draft)
    return draft, message


def reject_draft(doc_id: str) -> dict[str, Any]:
    draft = get_draft(doc_id)
    if draft["status"] == "rejected":  # 중복 반려 요청은 에러 없이 그대로 성공 처리 (멱등)
        return draft
    if draft["status"] != "draft":
        raise DraftStateError(f"이미 {draft['status']} 상태입니다")
    draft["status"] = "rejected"
    draft["updated_at"] = _now()
    _save_draft(draft)
    return draft


def _apply_to_target(draft: dict[str, Any], target: RegisterTarget, store_id: Optional[str]) -> tuple[bool, str]:
    """확정된 문서를 대상 시스템에 반영."""
    if target == "inventory_inbound":
        if not store_id:
            return False, "확정 완료. 재고 반영은 로그인 상태에서만 가능합니다 (매장 구분 필요)."
        try:
            return _apply_inventory_inbound(draft, store_id)
        except Exception as e:  # 반영 실패해도 확정 상태는 유지, applied=False로 표시
            logger.exception("OCR %s 재고 반영 실패", draft["id"])
            return False, f"확정은 되었으나 재고 반영에 실패했습니다: {e}"

    if not store_id:
        return False, "확정 완료. 지출/판매 반영은 로그인 상태에서만 가능합니다 (매장 구분 필요)."
    try:
        if target == "expense":
            return _apply_expense(draft, store_id)
        if target == "sales":
            return _apply_sales(draft, store_id)
    except Exception as e:  # 반영 실패해도 확정 상태는 유지, applied=False로 표시
        logger.exception("OCR %s %s 반영 실패", draft["id"], target)
        return False, f"확정은 되었으나 {target} 반영에 실패했습니다: {e}"

    return False, f"확정 완료. 알 수 없는 대상({target})이라 확정 상태로만 보관합니다."


def _normalize_item_name(name: str) -> str:
    """품목명 매칭용 정규화 — 영수증 표기 잡음을 걷어낸다.

    '01 피코크 초마짬뽕 12' / '▲제주목심구이용' / '논산양촌상추(봉)'처럼 줄번호·마커·
    공백·괄호가 붙어도 같은 상품으로 묶이게 한다. OCR 자소 오타는 여기서 못 잡고
    _find_ingredient의 유사도 매칭이 흡수한다.
    """
    s = re.sub(r"^\s*\d{1,3}\s*[.*)]?\s*", "", name)  # 줄번호 접두 (01, 03* 등)
    s = re.sub(r"[▲@*#()\[\]{}]", "", s)              # 마커·괄호류
    return re.sub(r"\s+", "", s).lower()


def _to_jamo(s: str) -> str:
    """한글 음절을 자소로 분해한다 ('논'→'ㄴㅗㄴ'). 비교 해상도를 자소 단위로 올린다.

    OCR 오타는 '상추→삼후'처럼 자소 하나가 바뀌는 형태라, 음절 단위 비교로는
    통째로 다른 글자가 되어 유사도가 과소평가된다. 자소로 풀면 눈/논은 2/3 일치.
    """
    CHO = "ㄱㄲㄴㄷㄸㄹㅁㅂㅃㅅㅆㅇㅈㅉㅊㅋㅌㅍㅎ"
    JUNG = "ㅏㅐㅑㅒㅓㅔㅕㅖㅗㅘㅙㅚㅛㅜㅝㅞㅟㅠㅡㅢㅣ"
    JONG = " ㄱㄲㄳㄴㄵㄶㄷㄹㄺㄻㄼㄽㄾㄿㅀㅁㅂㅄㅅㅆㅇㅈㅊㅋㅌㅍㅎ"
    out = []
    for ch in s:
        code = ord(ch) - 0xAC00
        if 0 <= code < 11172:
            out.append(CHO[code // 588])
            out.append(JUNG[(code % 588) // 28])
            if code % 28:
                out.append(JONG[code % 28])
        else:
            out.append(ch)
    return "".join(out)


def _find_ingredient(db, store_id: str, name: str, ingredients: list) -> tuple[Any, Optional[str]]:
    """OCR 품목명 → 기존 재료 매칭. (재료, 교정메모) 반환. 없으면 (None, None).

    1) 원문 완전 일치 → 2) 정규화 일치 → 3) 자소 유사도 매칭(75% 이상, 최고 1건).
    3)은 저해상도에서 '상추→삼후' 같은 자소 오타가 나도 재고가 갈라지지 않게 한다.
    자소 기준이라 '두유/두부'(~0.5)·'딸기우유/초코우유'(~0.5)는 합쳐지지 않는다.
    """
    import difflib

    for ing in ingredients:
        if ing.name == name:
            return ing, None
    norm = _normalize_item_name(name)
    if not norm:
        return None, None
    by_norm = {_normalize_item_name(ing.name): ing for ing in ingredients}
    if norm in by_norm:
        return by_norm[norm], None
    jamo = _to_jamo(norm)
    by_jamo = {_to_jamo(k): v for k, v in by_norm.items()}
    close = difflib.get_close_matches(jamo, list(by_jamo.keys()), n=1, cutoff=0.75)
    if close:
        matched = by_jamo[close[0]]
        return matched, f"'{name}' → '{matched.name}' 자동 매칭"
    return None, None


def _apply_inventory_inbound(draft: dict[str, Any], store_id: str) -> tuple[bool, str]:
    """OCR 품목을 백엔드 A의 재고 로직으로 입고 처리한다.

    품목명이 등록된 재료와 (유사도 포함) 일치하면 그 재료에 입고하고, 없으면 재료를
    새로 등록 후 입고한다. 새 재료 이름은 줄번호 접두('01 ')를 뗀 표시용 이름으로
    저장한다. 수량을 못 읽은 품목은 건너뛰고 사용자에게 알린다.
    """
    from app.core.database import SessionLocal
    from app.models.inventory import Ingredient
    from app.schemas.inventory import IngredientCreate, StockAdjust
    from app.services import inventory_service

    result: OcrResult = draft["result"]
    applied_names: list[str] = []
    skipped_names: list[str] = []
    corrections: list[str] = []

    with SessionLocal() as db:
        ingredients = db.query(Ingredient).filter(Ingredient.store_id == store_id).all()
        for item in result.items:
            if not item.name or item.quantity is None or item.quantity <= 0:
                skipped_names.append(item.name or "(이름 미인식)")
                continue

            ingredient, corrected = _find_ingredient(db, store_id, item.name, ingredients)
            if corrected:
                corrections.append(corrected)
            if ingredient is None:
                # 줄번호 접두를 뗀 표시용 이름으로 등록 ('01 피코크 짬뽕' → '피코크 짬뽕')
                display_name = re.sub(r"^\s*\d{1,3}\s*[.*)]?\s*", "", item.name).strip() or item.name
                ingredient = inventory_service.create_ingredient(
                    db, store_id,
                    IngredientCreate(
                        name=display_name,
                        unit=item.unit or "개",
                        current_price=int(item.unit_price or 0),
                    ),
                )
                ingredients.append(ingredient)  # 같은 문서 내 중복 품목이 새 재료를 또 만들지 않게
            elif item.unit_price:
                # 최신 매입 단가 반영 및 단가 변동 이력 자동 적재
                inventory_service.update_ingredient_price(db, store_id, ingredient.id, int(item.unit_price))


            inventory_service.add_or_adjust_stock(
                db, store_id,
                StockAdjust(
                    ingredient_id=ingredient.id,
                    quantity_change=item.quantity,
                    description=f"영수증 OCR 입고 (문서 {draft['id']})",
                ),
            )
            applied_names.append(item.name)

    message = f"재고 반영 완료 — {len(applied_names)}개 품목 입고"
    if corrections:
        message += f" · 오타 자동 교정 {len(corrections)}건: {'; '.join(corrections[:3])}"
    if skipped_names:
        message += f" (수량 미인식으로 제외: {', '.join(skipped_names[:3])})"
    return True, message


_KST = timezone(timedelta(hours=9))


def _parse_issued_date(raw: Optional[str]) -> Optional[date]:
    """발행일 문자열 → date. '2026-07-21' 외에 '2026.7.21', '2026년 7월 21일'도 흡수한다."""
    if not raw:
        return None
    m = re.search(r"(\d{4})\s*[.\-/년]\s*(\d{1,2})\s*[.\-/월]\s*(\d{1,2})", raw)
    if not m:
        return None
    try:
        return date(int(m.group(1)), int(m.group(2)), int(m.group(3)))
    except ValueError:
        return None


def _document_total(result: OcrResult) -> int:
    """문서 금액 — 합계가 없으면 품목별 금액(없으면 수량×단가)을 모아 복원."""
    if result.total and result.total > 0:
        return int(result.total)
    item_sum = 0.0
    for i in result.items:
        if i.amount and i.amount > 0:
            item_sum += i.amount
        elif i.quantity and i.unit_price and i.quantity > 0 and i.unit_price > 0:
            item_sum += i.quantity * i.unit_price
    return int(item_sum)


def _apply_expense(draft: dict[str, Any], store_id: str) -> tuple[bool, str]:
    """확정된 영수증을 백엔드 C의 지출(Expense) 장부에 기록한다.

    문서 1건 = 지출 1건. 카테고리는 문서 종류로 구분하고(매입 문서 → 원자재 매입),
    지출 일자는 발행일, 못 읽었으면 오늘(KST). 정산·세금 추정이 같은 테이블을 읽는다.
    """
    from app.core.database import SessionLocal
    from app.services.operation.operation_service import OperationService

    result: OcrResult = draft["result"]
    amount = _document_total(result)
    if amount <= 0:
        return False, "확정 완료. 금액을 인식하지 못해 지출로 반영하지 못했습니다 — 합계를 수정한 뒤 다시 시도해 주세요."

    expense_date = _parse_issued_date(result.issued_date) or datetime.now(_KST).date()
    category = "원자재 매입" if result.doc_type in ("purchase_statement", "tax_invoice") else "기타 지출"
    vendor = result.vendor.name if result.vendor else None
    description = f"영수증 OCR 지출 (문서 {draft['id']}" + (f", {vendor}" if vendor else "") + ")"

    with SessionLocal() as db:
        OperationService.create_expense(db, store_id, amount, category, expense_date, description)
    return True, f"지출 반영 완료 — {category} {amount:,}원 ({expense_date.isoformat()})"


def _apply_sales(draft: dict[str, Any], store_id: str) -> tuple[bool, str]:
    """확정된 매출 일마감표를 판매(Sale) 기록으로 반영한다.

    품목명을 등록된 메뉴와 (유사도 포함) 매칭해 Sale을 만들고, 수동 판매 입력과
    동일하게 레시피 기준 재고를 차감한다. 금액은 문서의 품목 금액을 우선하고
    없으면 메뉴 판매가×수량. 판매 시각은 발행일 정오(KST), 없으면 지금.
    메뉴에 없는 품목은 건너뛰고 알린다 — 임의 메뉴 생성은 하지 않는다.
    """
    import difflib

    from app.core.database import SessionLocal
    from app.models.inventory import Menu, Recipe, Sale, Stock, StockTransaction

    result: OcrResult = draft["result"]
    issued = _parse_issued_date(result.issued_date)
    sold_at = (
        datetime(issued.year, issued.month, issued.day, 12, 0, tzinfo=_KST)
        if issued else datetime.now(_KST)
    )

    applied_names: list[str] = []
    skipped_names: list[str] = []
    total_applied = 0

    with SessionLocal() as db:
        menus = db.query(Menu).filter(Menu.store_id == store_id).all()
        by_norm = {_normalize_item_name(m.name): m for m in menus}
        by_jamo = {_to_jamo(k): v for k, v in by_norm.items()}

        for item in result.items:
            qty = int(item.quantity or 0)
            if not item.name or qty <= 0:
                skipped_names.append(item.name or "(이름 미인식)")
                continue

            norm = _normalize_item_name(item.name)
            menu = next((m for m in menus if m.name == item.name), None)
            if menu is None:
                menu = by_norm.get(norm)
            if menu is None and norm:
                close = difflib.get_close_matches(_to_jamo(norm), list(by_jamo.keys()), n=1, cutoff=0.75)
                if close:
                    menu = by_jamo[close[0]]
            if menu is None:
                skipped_names.append(item.name)
                continue

            total = int(item.amount) if item.amount and item.amount > 0 else menu.selling_price * qty
            db.add(Sale(menu_id=menu.id, quantity=qty, total_price=total,
                        store_id=store_id, sold_at=sold_at))
            total_applied += total

            # 수동 판매 입력(sales_service)과 동일한 레시피 기준 재고 차감 + 이력 기록
            for recipe in db.query(Recipe).filter(Recipe.menu_id == menu.id).all():
                use = recipe.quantity * qty
                stock = db.query(Stock).filter(Stock.ingredient_id == recipe.ingredient_id).first()
                if stock is not None:
                    stock.current_quantity = max(0.0, stock.current_quantity - use)
                db.add(StockTransaction(ingredient_id=recipe.ingredient_id,
                                        quantity_change=-use, type="OUT",
                                        description=f"{menu.name} 판매 차감 (OCR 문서 {draft['id']})"))
            applied_names.append(item.name)

        if not applied_names:
            db.rollback()
            return False, (
                "확정 완료. 문서 품목이 등록된 메뉴와 일치하지 않아 판매로 반영하지 못했습니다"
                + (f" (미매칭: {', '.join(skipped_names[:3])})" if skipped_names else "")
                + " — 메뉴 관리에서 이름을 맞춘 뒤 다시 시도해 주세요."
            )
        db.commit()

    message = f"판매 반영 완료 — {len(applied_names)}개 품목, 합계 {total_applied:,}원"
    if skipped_names:
        message += f" (메뉴 미매칭으로 제외: {', '.join(skipped_names[:3])})"
    return True, message
