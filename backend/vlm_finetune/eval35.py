# -*- coding: utf-8 -*-
"""Qwen3.5-0.8B 평가 — 실제 영수증 test 세트(data/receipt774/test.jsonl) 품목 정확도.

라벨엔 품목(items)만 정답이 있으므로 품목 지표만 집계한다:
  - parsed           : 응답이 JSON으로 파싱된 비율
  - item_count_acc   : 품목 개수가 정확히 일치한 이미지 비율
  - name_recall      : 정답 품목명(공백 제거·소문자)이 예측에 존재한 비율
  - full_recall      : 이름+수량+금액까지 모두 일치한 비율
  - name_precision   : 예측 품목 중 정답에 존재하는 비율 (환각 페널티)
  - name_f1          : recall/precision 조화평균

사용:
    python eval35.py --base            # 파인튜닝 전 (베이스라인)
    python eval35.py                   # output/adapter35 적용 (기본 병합)
    python eval35.py --limit 20
출력: 콘솔 요약 + output/eval35_{base|ft}.json
"""

import argparse
import json
import re
import sys
import time
from pathlib import Path

import torch
from PIL import Image
from transformers import AutoProcessor, Qwen3_5ForConditionalGeneration

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE.parent))
from app.services.ai.vlm_prompt import VLM_PROMPT  # noqa: E402

MODEL_ID = "Qwen/Qwen3.5-0.8B"


def load_rows(split: str, limit: int | None):
    rows = []
    path = HERE / "data" / "receipt774" / f"{split}.jsonl"
    for line in path.read_text(encoding="utf-8").splitlines():
        if line.strip():
            r = json.loads(line)
            rows.append((Path(r["image"]), r["label"]))
    return rows[:limit] if limit else rows


def parse_json(text: str):
    text = text.strip()
    if text.startswith("```"):
        text = re.sub(r"^```(?:json)?\s*|\s*```$", "", text, flags=re.DOTALL)
    try:
        return json.loads(text)
    except json.JSONDecodeError:
        m = re.search(r"\{.*\}", text, re.DOTALL)
        if m:
            try:
                return json.loads(m.group())
            except json.JSONDecodeError:
                return None
    return None


def norm_name(s):
    return re.sub(r"\s+", "", str(s or "")).lower()


def _eq_num(a, b):
    if a is None or b is None:
        return a == b
    try:
        return abs(float(a) - float(b)) < 0.5
    except (TypeError, ValueError):
        return False


def score_one(pred: dict | None, gt: dict) -> dict:
    if pred is None:
        return {"parsed": 0, "item_count_acc": 0, "name_recall": 0.0,
                "full_recall": 0.0, "name_precision": 0.0, "name_f1": 0.0}
    gt_items = gt.get("items", [])
    pred_items = [i for i in (pred.get("items") or []) if isinstance(i, dict)]
    s = {"parsed": 1, "item_count_acc": int(len(pred_items) == len(gt_items))}

    # 이름 매칭은 멀티셋으로 (같은 품목이 두 줄 찍히는 영수증 대응)
    from collections import Counter
    pred_names = Counter(norm_name(i.get("name")) for i in pred_items)
    name_hit = full_hit = 0
    used = Counter()
    pred_by_name: dict[str, list[dict]] = {}
    for i in pred_items:
        pred_by_name.setdefault(norm_name(i.get("name")), []).append(i)
    for gi in gt_items:
        n = norm_name(gi["name"])
        if used[n] < pred_names.get(n, 0):
            used[n] += 1
            name_hit += 1
            pi = pred_by_name[n][used[n] - 1]
            if _eq_num(pi.get("quantity"), gi.get("quantity")) and _eq_num(pi.get("amount"), gi.get("amount")):
                full_hit += 1
    n_gt = max(len(gt_items), 1)
    n_pred = max(len(pred_items), 1)
    s["name_recall"] = name_hit / n_gt
    s["full_recall"] = full_hit / n_gt
    s["name_precision"] = name_hit / n_pred
    p, r = s["name_precision"], s["name_recall"]
    s["name_f1"] = 2 * p * r / (p + r) if p + r else 0.0
    return s


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--base", action="store_true", help="어댑터 없이 베이스 모델 평가")
    ap.add_argument("--adapter", type=str, default=str(HERE / "output" / "adapter35"))
    ap.add_argument("--split", type=str, default="test")
    ap.add_argument("--limit", type=int, default=None)
    ap.add_argument("--max-side", type=int, default=1024, help="학습 max-side와 일치시킬 것")
    ap.add_argument("--max-new-tokens", type=int, default=1024)
    ap.add_argument("--no-merge", action="store_true", help="어댑터를 병합하지 않고 평가")
    ap.add_argument("--tag", type=str, default=None, help="리포트 파일명 접미사")
    args = ap.parse_args()

    rows = load_rows(args.split, args.limit)
    print(f"eval samples: {len(rows)} ({args.split})")

    processor = AutoProcessor.from_pretrained(MODEL_ID)
    model = Qwen3_5ForConditionalGeneration.from_pretrained(
        MODEL_ID, dtype=torch.bfloat16, attn_implementation="sdpa", device_map="cuda:0",
    )
    if not args.base:
        from peft import PeftModel
        model = PeftModel.from_pretrained(model, args.adapter)
        print(f"adapter loaded: {args.adapter}")
        if not args.no_merge:
            model = model.merge_and_unload()
            print("adapter merged into base")
    model.eval()

    report, agg, times = [], {}, []
    from train35 import resize_pixel_budget  # 학습과 동일한 리사이즈 (train/serve skew 방지)

    for i, (img_path, gt) in enumerate(rows):
        img = Image.open(img_path).convert("RGB")
        img = resize_pixel_budget(img, args.max_side)
        inputs = processor.apply_chat_template(
            [{"role": "user", "content": [{"type": "image", "image": img},
                                          {"type": "text", "text": VLM_PROMPT}]}],
            tokenize=True, add_generation_prompt=True, return_dict=True, return_tensors="pt",
        ).to(model.device)
        t0 = time.perf_counter()
        with torch.inference_mode():
            out = model.generate(**inputs, max_new_tokens=args.max_new_tokens, do_sample=False)
        times.append(time.perf_counter() - t0)
        text = processor.decode(out[0][inputs["input_ids"].shape[1]:], skip_special_tokens=True)
        pred = parse_json(text)
        s = score_one(pred, gt)
        for k, v in s.items():
            agg.setdefault(k, []).append(v)
        report.append({"image": img_path.name, "scores": s, "pred": pred, "gt": gt,
                       "raw": None if pred else text[:500]})
        if (i + 1) % 10 == 0:
            done = {k: sum(v) / len(v) for k, v in agg.items()}
            print(f"  {i + 1}/{len(rows)}  f1={done['name_f1']:.3f} full={done['full_recall']:.3f} "
                  f"avg_infer={sum(times)/len(times):.1f}s", flush=True)

    print("\n=== item metrics ===")
    summary = {k: sum(v) / len(v) for k, v in agg.items()}
    for k, v in summary.items():
        print(f"  {k:16s}: {v:.3f}")
    print(f"  avg_infer_sec   : {sum(times)/len(times):.2f}")
    tag = args.tag or ("base" if args.base else "ft")
    out_path = HERE / "output" / f"eval35_{tag}.json"
    out_path.parent.mkdir(parents=True, exist_ok=True)
    out_path.write_text(json.dumps({"summary": summary, "avg_infer_sec": sum(times) / len(times),
                                    "n": len(rows), "detail": report},
                                   ensure_ascii=False, indent=1), encoding="utf-8")
    print(f"report -> {out_path}")


if __name__ == "__main__":
    main()
