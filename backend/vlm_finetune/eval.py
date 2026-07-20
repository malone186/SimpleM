# -*- coding: utf-8 -*-
"""파인튜닝 모델 평가 — 검증셋(합성 val + data/real에 이미지가 있으면 실제 영수증)을
추론해 필드 정확도를 집계한다.

사용:
    python eval.py                     # output/adapter 어댑터 적용 평가
    python eval.py --base              # 어댑터 없이 베이스 모델만 (파인튜닝 전 기준선)
    python eval.py --limit 20          # 앞 20건만 (빠른 확인)
출력: 콘솔 요약 + output/eval_report.json (건별 예측/정답 포함)
"""

import argparse
import json
import re
import sys
from pathlib import Path

import torch
from PIL import Image
from transformers import AutoProcessor, Qwen3VLForConditionalGeneration

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE.parent))
from app.services.ai.vlm_prompt import VLM_PROMPT  # noqa: E402

MODEL_ID = "Qwen/Qwen3-VL-2B-Instruct"


def load_rows(limit: int | None):
    rows = []
    synth = HERE / "data" / "synth" / "val.jsonl"
    for line in synth.read_text(encoding="utf-8").splitlines():
        if line.strip():
            r = json.loads(line)
            rows.append((synth.parent / r["image"], r["label"], "synth"))
    real_labels = HERE / "data" / "real" / "labels"
    for lp in sorted(real_labels.glob("*.json")):
        meta = json.loads(lp.read_text(encoding="utf-8"))
        img = HERE / "data" / "real" / meta["image"]
        if img.exists():  # 실제 영수증 원본은 사용자가 data/real/에 넣어야 평가에 포함된다
            rows.append((img, meta["label"], "real"))
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


def score_one(pred: dict | None, gt: dict) -> dict:
    if pred is None:
        return {"parsed": 0}
    s = {"parsed": 1}
    s["doc_type"] = int(pred.get("doc_type") == gt["doc_type"])
    for f in ("total", "tax", "subtotal", "discount"):
        s[f] = int(pred.get(f) == gt.get(f))
    s["issued_date"] = int(pred.get("issued_date") == gt.get("issued_date"))
    gt_items = gt.get("items", [])
    pred_items = pred.get("items") or []
    s["item_count"] = int(len(pred_items) == len(gt_items))
    # 품목 매칭: 정규화 이름 기준. 이름이 맞으면 수량·금액까지 맞는지 본다
    pred_by_name = {norm_name(i.get("name")): i for i in pred_items if isinstance(i, dict)}
    name_hit = amt_hit = 0
    for gi in gt_items:
        pi = pred_by_name.get(norm_name(gi["name"]))
        if pi is not None:
            name_hit += 1
            if pi.get("quantity") == gi.get("quantity") and pi.get("amount") == gi.get("amount"):
                amt_hit += 1
    n = max(len(gt_items), 1)
    s["item_name_recall"] = name_hit / n
    s["item_full_recall"] = amt_hit / n
    return s


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--base", action="store_true", help="어댑터 없이 베이스 모델 평가")
    ap.add_argument("--adapter", type=str, default=str(HERE / "output" / "adapter"))
    ap.add_argument("--limit", type=int, default=None)
    ap.add_argument("--max-side", type=int, default=768)
    ap.add_argument("--4bit", dest="use_4bit", action="store_true",
                    help="베이스를 4bit로 로드 (8GB VRAM). 어댑터도 이 위에 올린다")
    args = ap.parse_args()

    rows = load_rows(args.limit)
    print(f"eval samples: {len(rows)} (synth={sum(1 for r in rows if r[2] == 'synth')}, "
          f"real={sum(1 for r in rows if r[2] == 'real')})")

    processor = AutoProcessor.from_pretrained(MODEL_ID)
    quant = None
    if args.use_4bit:
        from transformers import BitsAndBytesConfig
        quant = BitsAndBytesConfig(
            load_in_4bit=True, bnb_4bit_quant_type="nf4",
            bnb_4bit_use_double_quant=True, bnb_4bit_compute_dtype=torch.bfloat16,
        )
    model = Qwen3VLForConditionalGeneration.from_pretrained(
        MODEL_ID, dtype=torch.bfloat16, attn_implementation="sdpa", device_map="cuda:0",
        quantization_config=quant,
    )
    if not args.base:
        from peft import PeftModel
        model = PeftModel.from_pretrained(model, args.adapter)
        print(f"adapter loaded: {args.adapter}")
    model.eval()

    report, agg = [], {}
    for i, (img_path, gt, kind) in enumerate(rows):
        img = Image.open(img_path).convert("RGB")
        if max(img.size) > args.max_side:
            img.thumbnail((args.max_side, args.max_side), Image.LANCZOS)
        inputs = processor.apply_chat_template(
            [{"role": "user", "content": [{"type": "image", "image": img},
                                          {"type": "text", "text": VLM_PROMPT}]}],
            tokenize=True, add_generation_prompt=True, return_dict=True, return_tensors="pt",
        ).to(model.device)
        with torch.inference_mode():
            out = model.generate(**inputs, max_new_tokens=1024, do_sample=False)
        text = processor.decode(out[0][inputs["input_ids"].shape[1]:], skip_special_tokens=True)
        pred = parse_json(text)
        s = score_one(pred, gt)
        for k, v in s.items():
            agg.setdefault(k, []).append(v)
        report.append({"image": str(img_path.name), "kind": kind, "scores": s,
                       "pred": pred, "gt": gt, "raw": None if pred else text[:500]})
        if (i + 1) % 10 == 0:
            print(f"  {i + 1}/{len(rows)}")

    print("\n=== field accuracy ===")
    for k, vals in agg.items():
        print(f"  {k:18s}: {sum(vals) / len(vals):.3f}")
    out_path = HERE / "output" / "eval_report.json"
    out_path.parent.mkdir(parents=True, exist_ok=True)
    out_path.write_text(json.dumps(report, ensure_ascii=False, indent=1), encoding="utf-8")
    print(f"\nreport -> {out_path}")


if __name__ == "__main__":
    main()
