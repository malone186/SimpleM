#!/usr/bin/env python3
"""영수증 OCR 정량 평가 — CER·필드정확도·완전일치·F1·영수증정확도·추론시간.

`vlm_finetune/eval35.py`(보관)와 다른 점: 그쪽은 파인튜닝 Qwen을 GPU로 돌리는 전용
스크립트이고 품목명 판정이 완전 일치뿐이라 한 글자 오독과 완전 오답을 구분하지 못했다.
여기서는 운영과 같은 경로(app.services.ai.ocr_service)를 그대로 호출하고, CER을 넣어
'거의 맞음'을 점수에 반영한다.

    python evals/ocr/score.py --images ~/Desktop/test --models gemini-3.1-flash-lite,gemini-3.1-flash

지표 정의 (모두 0~1, 클수록 좋음. CER만 작을수록 좋음)
  CER           문자 오류율 = 편집거리 / 정답 글자수. 품목명을 정답 순서대로 이어 붙여 계산.
  Field Accuracy 문서 단위 필드(doc_type·발행일·상호·합계·세액·공급가액)의 정답률.
                 정답이 null인 필드는 이미지에 정보가 없다는 뜻이라 채점에서 뺀다.
  Exact Match   품목 한 줄(이름+수량+금액)이 통째로 맞은 비율.
  F1            품목명 정밀도·재현율의 조화평균 (중복 품목은 다중집합으로 센다).
  Complete Receipt  영수증 1장의 모든 품목과 모든 채점 대상 필드가 전부 맞았는지 (0/1).
                 사람이 한 군데도 안 고쳐도 되는 비율이라 실사용에 가장 가깝다.
  Inference Time 장당 처리 시간(초). 정확도와 맞바꾸는 값이라 함께 본다.
"""
from __future__ import annotations

import argparse
import asyncio
import json
import re
import sys
import time
from collections import Counter
from pathlib import Path
from typing import Any, Optional

BACKEND = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(BACKEND))

SCORED_FIELDS = ["doc_type", "issued_date", "vendor_name", "total", "tax", "subtotal"]


# ── 정규화 ──────────────────────────────────────────────────────────────────
def norm_name(s: Optional[str]) -> str:
    """품목명 비교용 정규화 — 공백 제거 + 소문자. 인쇄 폭에 따라 띄어쓰기가 흔들리는데
    그건 인식 오류가 아니라서 뺀다."""
    return re.sub(r"\s+", "", (s or "")).lower()


def as_num(v: Any) -> Optional[float]:
    if v is None or v == "":
        return None
    try:
        return float(str(v).replace(",", "").replace("원", "").strip())
    except (TypeError, ValueError):
        return None


def num_eq(a: Any, b: Any) -> bool:
    """금액·수량 비교. 0.5 미만 차이는 같게 본다 (2 vs 2.0 같은 표기 차이 흡수)."""
    x, y = as_num(a), as_num(b)
    if x is None or y is None:
        return x is None and y is None
    return abs(x - y) < 0.5


def norm_date(v: Any) -> Optional[str]:
    """2023-04-28 / 2023.04.28 / 2023/04/28 를 같은 값으로 본다 (구분자는 인식 문제가 아니다)."""
    if not v:
        return None
    m = re.search(r"(\d{4})\D(\d{1,2})\D(\d{1,2})", str(v))
    return f"{m.group(1)}-{int(m.group(2)):02d}-{int(m.group(3)):02d}" if m else str(v).strip()


def levenshtein(a: str, b: str) -> int:
    """편집거리 (삽입·삭제·치환). CER 계산용 — 외부 의존성 없이 O(len(a)·len(b))."""
    if a == b:
        return 0
    if not a:
        return len(b)
    if not b:
        return len(a)
    prev = list(range(len(b) + 1))
    for i, ca in enumerate(a, 1):
        cur = [i]
        for j, cb in enumerate(b, 1):
            cur.append(min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (ca != cb)))
        prev = cur
    return prev[-1]


# ── 채점 ────────────────────────────────────────────────────────────────────
def score_one(gt: dict, pred: dict) -> dict:
    """영수증 1장 채점. pred는 OcrResult를 dict로 편 것."""
    gt_items, pred_items = gt.get("items", []), pred.get("items", [])

    # CER — 품목명을 순서대로 이어 붙인 한 덩어리로 비교. 줄 단위로 재면 정답과 예측의
    # 줄을 먼저 짝지어야 하는데, 그 짝짓기 자체가 또 다른 판정이라 편향이 들어간다.
    gt_text = "".join(norm_name(i.get("name")) for i in gt_items)
    pred_text = "".join(norm_name(i.get("name")) for i in pred_items)
    cer = levenshtein(pred_text, gt_text) / max(len(gt_text), 1)

    # F1 — 품목명 다중집합 비교 (같은 품목이 두 줄 있으면 두 번 맞혀야 한다)
    gt_names = Counter(norm_name(i.get("name")) for i in gt_items)
    pred_names = Counter(norm_name(i.get("name")) for i in pred_items)
    name_hit = sum((gt_names & pred_names).values())
    precision = name_hit / max(len(pred_items), 1)
    recall = name_hit / max(len(gt_items), 1)
    f1 = 2 * precision * recall / (precision + recall) if (precision + recall) else 0.0

    # Exact Match — 이름+수량+금액이 모두 맞은 줄. 정답 줄마다 아직 안 쓴 예측 줄에서 찾는다
    used: set[int] = set()
    exact_hit = 0
    for g in gt_items:
        for k, p in enumerate(pred_items):
            if k in used:
                continue
            if (norm_name(p.get("name")) == norm_name(g.get("name"))
                    and num_eq(p.get("quantity"), g.get("quantity"))
                    and num_eq(p.get("amount"), g.get("amount"))):
                used.add(k)
                exact_hit += 1
                break
    exact = exact_hit / max(len(gt_items), 1)

    # Field Accuracy — 정답이 null인 필드(이미지에 정보 없음)는 분모에서 제외
    field_res: dict[str, bool] = {}
    for f in SCORED_FIELDS:
        want = gt.get(f)
        if want is None:
            continue
        got = pred.get(f)
        if f == "issued_date":
            ok = norm_date(got) == norm_date(want)
        elif f == "vendor_name":
            ok = norm_name(got) == norm_name(want)
        elif f == "doc_type":
            ok = str(got or "") == str(want)
        else:
            ok = num_eq(got, want)
        field_res[f] = bool(ok)
    field_acc = sum(field_res.values()) / max(len(field_res), 1)

    # Complete Receipt — 품목 전부 + 필드 전부. 하나라도 틀리면 사람이 손대야 한다
    complete = int(
        exact_hit == len(gt_items)
        and len(pred_items) == len(gt_items)
        and all(field_res.values())
    )

    return {
        "cer": cer, "field_acc": field_acc, "exact": exact, "f1": f1,
        "complete": complete, "precision": precision, "recall": recall,
        "n_gt": len(gt_items), "n_pred": len(pred_items),
        "fields": field_res,
    }


def flatten(result: Any) -> dict:
    """OcrResult(pydantic) → 채점용 평면 dict"""
    d = result.model_dump() if hasattr(result, "model_dump") else dict(result)
    return {
        "doc_type": d.get("doc_type"),
        "issued_date": d.get("issued_date"),
        "vendor_name": (d.get("vendor") or {}).get("name"),
        "total": d.get("total"), "tax": d.get("tax"), "subtotal": d.get("subtotal"),
        "items": d.get("items") or [],
    }


async def run_model(model: str, images: list[Path], gt_by_file: dict, repeat: int = 1) -> dict:
    """모델 하나로 전체 이미지를 repeat회 처리하고 평균 지표를 낸다.

    LLM 응답은 같은 입력에도 매번 조금씩 달라서, 1회 측정은 운에 크게 흔들린다
    (실측: 같은 모델·같은 영수증이 한 번은 F1 0.00, 다시 돌리니 0.69). 그래서 여러 번
    돌려 평균을 쓴다. 시간은 평균과 함께 중앙값도 남긴다 — ocr_service가 429·5xx에
    최대 3회 재시도하므로 한 번의 재시도가 평균을 통째로 왜곡한다.
    """
    from app.services.ai import ocr_service
    from app.schemas.ai import OcrResult

    ocr_service.GEMINI_MODEL = model  # 호출 시점에 읽는 모듈 전역이라 교체가 먹는다
    rows = []
    for rep in range(repeat):
        for img in images:
            gt = gt_by_file[img.name]
            started = time.perf_counter()
            pred_dump = None
            try:
                raw = await ocr_service._run_backend("gemini", img.read_bytes(), mime_type="image/jpeg")
                elapsed = time.perf_counter() - started
                pred = flatten(OcrResult.model_validate(raw))
                pred_dump = pred
                s = score_one(gt, pred)
                s["failed"] = False
            except Exception as e:  # 파싱 실패·타임아웃도 성적의 일부다 (0점 처리)
                elapsed = time.perf_counter() - started
                print(f"    ! {img.name}: {type(e).__name__}: {str(e)[:120]}")
                s = {"cer": 1.0, "field_acc": 0.0, "exact": 0.0, "f1": 0.0, "complete": 0,
                     "precision": 0.0, "recall": 0.0, "n_gt": len(gt["items"]), "n_pred": 0,
                     "fields": {}, "failed": True}
            s.update(sec=elapsed, file=img.name, label=gt.get("label"), rep=rep, pred=pred_dump)
            rows.append(s)
            print(f"    [{rep + 1}/{repeat}] {gt.get('label'):22s} F1 {s['f1']:.3f}  "
                  f"CER {s['cer']:.3f}  필드 {s['field_acc']:.3f}  {elapsed:.1f}s")

    n = len(rows)
    avg = lambda k: sum(r[k] for r in rows) / max(n, 1)  # noqa: E731
    secs = sorted(r["sec"] for r in rows)
    return {
        "model": model, "n": n, "repeat": repeat, "images": len(images),
        "cer": avg("cer"), "field_acc": avg("field_acc"), "exact": avg("exact"),
        "f1": avg("f1"), "complete": avg("complete"),
        "sec": avg("sec"), "sec_median": secs[len(secs) // 2] if secs else 0.0,
        "failed_rate": avg("failed"),
        "detail": rows,
    }


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--images", required=True, help="영수증 이미지 폴더")
    ap.add_argument("--gt", default=str(Path(__file__).parent / "ground_truth.json"))
    ap.add_argument("--models", default="gemini-3.1-flash-lite",
                    help="쉼표로 구분한 Gemini 모델 목록")
    ap.add_argument("--repeat", type=int, default=3,
                    help="모델·이미지당 반복 횟수 (LLM 응답 변동을 평균으로 흡수, 기본 3)")
    ap.add_argument("--out", default=str(Path(__file__).parent / "results.json"))
    args = ap.parse_args()

    gt_doc = json.loads(Path(args.gt).read_text(encoding="utf-8"))
    gt_by_file = {r["file"]: r for r in gt_doc["receipts"]}

    img_dir = Path(args.images).expanduser()
    images = sorted(p for p in img_dir.iterdir()
                    if p.suffix.lower() in {".jpg", ".jpeg", ".png"} and p.name in gt_by_file)
    if not images:
        sys.exit(f"정답이 있는 이미지를 못 찾았다: {img_dir}")
    print(f"이미지 {len(images)}장 · 정답 품목 {sum(len(g['items']) for g in gt_by_file.values())}개\n")

    results = []
    for model in [m.strip() for m in args.models.split(",") if m.strip()]:
        print(f"[{model}]")
        results.append(asyncio.run(run_model(model, images, gt_by_file, args.repeat)))
        print()

    Path(args.out).write_text(json.dumps({"results": results}, ensure_ascii=False, indent=2),
                              encoding="utf-8")
    print(f"{'모델':28s} {'F1':>6s} {'CER':>6s} {'필드':>6s} {'완전일치':>8s} {'영수증':>7s} {'평균초':>6s} {'중앙초':>6s}")
    for r in results:
        print(f"{r['model']:28s} {r['f1']:6.3f} {r['cer']:6.3f} {r['field_acc']:6.3f} "
              f"{r['exact']:8.3f} {r['complete']:7.3f} {r['sec']:6.2f} {r['sec_median']:6.2f}")
    print(f"\n→ {args.out}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
