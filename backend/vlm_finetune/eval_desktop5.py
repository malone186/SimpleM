# -*- coding: utf-8 -*-
"""바탕화면 실영수증 5장(파인튜닝 1~5) — 0.8B·2B 어댑터 재추론 평가.

GGUF/병합본은 삭제된 상태라 transformers bf16 + PEFT 어댑터로 돌린다.
정답은 data/desktop5/gt.jsonl (이미지를 보고 수기 전사, 라벨 규칙은
receipt774와 동일: 품목명은 번호 접두어 포함 인쇄된 그대로, 코드·제조사
행 제외, 금액 0인 옵션 행도 품목 표의 행이므로 포함).

사용:
    python eval_desktop5.py --which 35    # Qwen3.5-0.8B + adapter35_v2
    python eval_desktop5.py --which 2b    # Qwen3-VL-2B + adapter2b
출력: metrics/eval_desktop5_{35|2b}.json (eval35와 같은 detail 포맷 → rescore 가능)
"""

import argparse
import json
import sys
import time
from pathlib import Path

import torch
from PIL import Image
from transformers import AutoProcessor

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE.parent))
from app.services.ai.vlm_prompt import VLM_PROMPT  # noqa: E402
from eval35 import parse_json, score_one  # noqa: E402
from train35 import resize_pixel_budget  # noqa: E402


def load_model(which: str):
    # 주의: adapter2b의 실제 베이스는 Qwen/Qwen3.5-2B다 (adapter_config.json 참조).
    # 아카이브 문서의 "Qwen3-VL-2B" 표기는 초기 train.py(Qwen3-VL-2B-Instruct) 흔적이고,
    # 최종 2B는 train35.py --model Qwen/Qwen3.5-2B로 학습됐다 (finish2b.sh 파이프라인).
    from transformers import Qwen3_5ForConditionalGeneration
    if which == "35":
        base, adapter = "Qwen/Qwen3.5-0.8B", HERE / "output" / "adapter35_v2"
    else:
        base, adapter = "Qwen/Qwen3.5-2B", HERE / "output" / "adapter2b"
    model = Qwen3_5ForConditionalGeneration.from_pretrained(
        base, dtype=torch.bfloat16, attn_implementation="sdpa", device_map="cuda:0")
    from peft import PeftModel
    model = PeftModel.from_pretrained(model, str(adapter))
    model = model.merge_and_unload()  # 서빙과 동일 조건
    model.eval()
    return AutoProcessor.from_pretrained(base), model, str(adapter)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--which", choices=["35", "2b"], required=True)
    ap.add_argument("--max-side", type=int, default=1024)
    ap.add_argument("--max-new-tokens", type=int, default=1536)  # 15품목 영수증 절단 방지
    args = ap.parse_args()

    rows = []
    for line in (HERE / "data" / "desktop5" / "gt.jsonl").read_text(encoding="utf-8").splitlines():
        if line.strip():
            r = json.loads(line)
            rows.append((Path(r["image"]), r["label"]))
    print(f"samples: {len(rows)}")

    processor, model, adapter = load_model(args.which)
    print(f"model ready ({args.which}, adapter={adapter})")

    report, agg, times = [], {}, []
    for img_path, gt in rows:
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
        dt = time.perf_counter() - t0
        times.append(dt)
        text = processor.decode(out[0][inputs["input_ids"].shape[1]:], skip_special_tokens=True)
        pred = parse_json(text)
        s = score_one(pred, gt)
        for k, v in s.items():
            agg.setdefault(k, []).append(v)
        report.append({"image": img_path.name, "scores": s, "pred": pred, "gt": gt,
                       "raw": None if pred else text[:800]})
        print(f"  {img_path.name}: parsed={s['parsed']} f1={s['name_f1']:.2f} {dt:.1f}s", flush=True)

    summary = {k: sum(v) / len(v) for k, v in agg.items()}
    out_path = HERE / "metrics" / f"eval_desktop5_{args.which}.json"
    out_path.write_text(json.dumps(
        {"summary": summary, "avg_infer_sec": sum(times) / len(times), "n": len(rows),
         "runtime": "transformers bf16 (merged adapter), RTX 5060", "detail": report},
        ensure_ascii=False, indent=1), encoding="utf-8")
    print(json.dumps(summary, ensure_ascii=False, indent=1))
    print(f"avg_infer_sec: {sum(times)/len(times):.2f}\n-> {out_path}")


if __name__ == "__main__":
    main()
