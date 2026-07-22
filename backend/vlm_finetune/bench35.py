# -*- coding: utf-8 -*-
"""Qwen3.5-0.8B OCR 속도 벤치마크 — 방법별 장당 추론 시간 비교 (백엔드 B)

같은 test 이미지 N장으로 각 구성을 측정한다. 콜드(첫 실행)와 웜(이후 평균)을
구분해 기록한다 — 서빙은 예열(warmup) 후 웜 시간이 사용자 체감이다.

사용:
    python bench35.py --config hf_bf16_merged       # transformers 경로
    python bench35.py --config hf_bf16_merged_768   # 해상도 768
    python bench35.py --config hf_bf16_adapter      # 어댑터 미병합 (매 토큰 LoRA 행렬곱)
출력: output/bench35_<config>.json
llama.cpp 경로는 별도 (tools_bin/llama-mtmd-cli 직접 측정)
"""

import argparse
import json
import sys
import time
from pathlib import Path

import torch
from PIL import Image

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE.parent))
from app.services.ai.vlm_prompt import VLM_PROMPT  # noqa: E402

MODEL_ID = "Qwen/Qwen3.5-0.8B"


def load_images(n: int, max_side: int):
    rows = []
    path = HERE / "data" / "receipt774" / "test.jsonl"
    for line in path.read_text(encoding="utf-8").splitlines()[:n]:
        r = json.loads(line)
        img = Image.open(r["image"]).convert("RGB")
        if max(img.size) > max_side:
            img.thumbnail((max_side, max_side), Image.LANCZOS)
        rows.append(img)
    return rows


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--config", required=True,
                    choices=["hf_bf16_merged", "hf_bf16_merged_768", "hf_bf16_adapter"])
    ap.add_argument("--n", type=int, default=8)
    ap.add_argument("--max-new-tokens", type=int, default=1024)
    args = ap.parse_args()

    max_side = 768 if args.config.endswith("768") else 1024
    imgs = load_images(args.n, max_side)

    from transformers import AutoProcessor, Qwen3_5ForConditionalGeneration
    from peft import PeftModel

    t0 = time.perf_counter()
    processor = AutoProcessor.from_pretrained(MODEL_ID)
    model = Qwen3_5ForConditionalGeneration.from_pretrained(
        MODEL_ID, dtype=torch.bfloat16, attn_implementation="sdpa", device_map="cuda:0",
    )
    model = PeftModel.from_pretrained(model, str(HERE / "output" / "adapter35"))
    if "adapter" not in args.config:
        model = model.merge_and_unload()
    model.eval()
    load_sec = time.perf_counter() - t0

    times, toks = [], []
    for img in imgs:
        inputs = processor.apply_chat_template(
            [{"role": "user", "content": [{"type": "image", "image": img},
                                          {"type": "text", "text": VLM_PROMPT}]}],
            tokenize=True, add_generation_prompt=True, return_dict=True, return_tensors="pt",
        ).to(model.device)
        t0 = time.perf_counter()
        with torch.inference_mode():
            out = model.generate(**inputs, max_new_tokens=args.max_new_tokens, do_sample=False)
        times.append(time.perf_counter() - t0)
        toks.append(out.shape[1] - inputs["input_ids"].shape[1])

    result = {
        "config": args.config, "n": len(imgs), "max_side": max_side,
        "load_sec": round(load_sec, 1),
        "cold_sec": round(times[0], 2),
        "warm_avg_sec": round(sum(times[1:]) / max(len(times) - 1, 1), 2),
        "warm_tok_per_sec": round(sum(toks[1:]) / max(sum(times[1:]), 1e-9), 1),
        "times": [round(t, 2) for t in times], "new_tokens": toks,
    }
    print(json.dumps(result, indent=2))
    out_path = HERE / "output" / f"bench35_{args.config}.json"
    out_path.write_text(json.dumps(result, indent=2), encoding="utf-8")
    print(f"-> {out_path}")


if __name__ == "__main__":
    main()
