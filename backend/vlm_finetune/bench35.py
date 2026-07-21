# -*- coding: utf-8 -*-
"""Qwen3.5-0.8B OCR 속도 벤치마크 — 최적화 방법별 지연시간·정확도 동시 측정 (백엔드 B)

같은 test 이미지 N장에 대해 (모델 로드 시간, 첫 추론, 이후 평균 추론 시간, name_f1)을
측정한다. 첫 추론이 유독 느린 것(커널 컴파일·캐시 워밍)을 분리해서 보기 위함.

사용:
    python bench35.py --mode hf                 # transformers bf16 + adapter 병합
    python bench35.py --mode hf --four-bit      # bitsandbytes nf4
    python bench35.py --mode hf --max-side 768
    python bench35.py --mode server --port 8033 # llama-server(GGUF) — 서버는 미리 띄울 것
출력: 콘솔 + output/bench35_<tag>.json
"""

import argparse
import base64
import io
import json
import statistics
import sys
import time
from pathlib import Path

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE.parent))
sys.path.insert(0, str(HERE))

from PIL import Image

from app.services.ai.vlm_prompt import VLM_PROMPT  # noqa: E402
from eval35 import load_rows, parse_json, score_one  # noqa: E402


def prep_image(path: Path, max_side: int) -> Image.Image:
    img = Image.open(path).convert("RGB")
    if max(img.size) > max_side:
        img.thumbnail((max_side, max_side), Image.LANCZOS)
    return img


def run_hf(args, rows):
    import torch
    from transformers import AutoProcessor, Qwen3_5ForConditionalGeneration

    t0 = time.perf_counter()
    processor = AutoProcessor.from_pretrained("Qwen/Qwen3.5-0.8B")
    quant = None
    if args.four_bit:
        from transformers import BitsAndBytesConfig
        quant = BitsAndBytesConfig(load_in_4bit=True, bnb_4bit_quant_type="nf4",
                                   bnb_4bit_use_double_quant=True,
                                   bnb_4bit_compute_dtype=torch.bfloat16)
    model = Qwen3_5ForConditionalGeneration.from_pretrained(
        "Qwen/Qwen3.5-0.8B", dtype=torch.bfloat16,
        attn_implementation=args.attn, device_map="cuda:0", quantization_config=quant)
    adapter = HERE / "output" / "adapter35"
    if not args.base and (adapter / "adapter_config.json").exists():
        from peft import PeftModel
        model = PeftModel.from_pretrained(model, str(adapter))
        if quant is None:
            model = model.merge_and_unload()
    model.eval()
    load_sec = time.perf_counter() - t0

    times, scores = [], []
    for img_path, gt in rows:
        img = prep_image(img_path, args.max_side)
        inputs = processor.apply_chat_template(
            [{"role": "user", "content": [{"type": "image", "image": img},
                                          {"type": "text", "text": VLM_PROMPT}]}],
            tokenize=True, add_generation_prompt=True, return_dict=True,
            return_tensors="pt").to(model.device)
        t1 = time.perf_counter()
        with torch.inference_mode():
            out = model.generate(**inputs, max_new_tokens=args.max_new_tokens, do_sample=False)
        times.append(time.perf_counter() - t1)
        text = processor.decode(out[0][inputs["input_ids"].shape[1]:], skip_special_tokens=True)
        scores.append(score_one(parse_json(text), gt))
    return load_sec, times, scores


def run_server(args, rows):
    """llama-server(OpenAI 호환)에 base64 이미지로 요청. 서버는 미리 띄워져 있어야 한다."""
    import httpx

    url = f"http://127.0.0.1:{args.port}/v1/chat/completions"
    times, scores = [], []
    load_sec = 0.0  # 서버가 이미 상주 — 로드 시간은 서버 기동 로그에서 별도 확인
    for img_path, gt in rows:
        img = prep_image(img_path, args.max_side)
        buf = io.BytesIO()
        img.save(buf, format="PNG")
        b64 = base64.b64encode(buf.getvalue()).decode()
        payload = {
            "messages": [{"role": "user", "content": [
                {"type": "image_url", "image_url": {"url": f"data:image/png;base64,{b64}"}},
                {"type": "text", "text": VLM_PROMPT}]}],
            "max_tokens": args.max_new_tokens,
            "temperature": 0,
        }
        t1 = time.perf_counter()
        r = httpx.post(url, json=payload, timeout=300)
        r.raise_for_status()
        times.append(time.perf_counter() - t1)
        text = r.json()["choices"][0]["message"]["content"]
        scores.append(score_one(parse_json(text), gt))
    return load_sec, times, scores


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--mode", choices=["hf", "server"], default="hf")
    ap.add_argument("--n", type=int, default=15, help="벤치마크 이미지 수")
    ap.add_argument("--max-side", type=int, default=1024)
    ap.add_argument("--max-new-tokens", type=int, default=1024)
    ap.add_argument("--four-bit", action="store_true")
    ap.add_argument("--base", action="store_true", help="어댑터 없이")
    ap.add_argument("--attn", default="sdpa")
    ap.add_argument("--port", type=int, default=8033)
    ap.add_argument("--tag", required=True, help="결과 파일·표에 쓸 이름 (예: hf_bf16)")
    args = ap.parse_args()

    rows = load_rows("test", args.n)
    print(f"bench[{args.tag}] {args.mode}, n={len(rows)}, max_side={args.max_side}")

    load_sec, times, scores = (run_hf if args.mode == "hf" else run_server)(args, rows)

    first = times[0]
    steady = times[1:] if len(times) > 1 else times
    agg = {k: sum(s[k] for s in scores) / len(scores) for k in scores[0]}
    result = {
        "tag": args.tag, "n": len(rows), "load_sec": round(load_sec, 1),
        "first_infer_sec": round(first, 2),
        "steady_avg_sec": round(statistics.mean(steady), 2),
        "steady_median_sec": round(statistics.median(steady), 2),
        "name_f1": round(agg["name_f1"], 3), "full_recall": round(agg["full_recall"], 3),
        "parsed": round(agg["parsed"], 3),
        "config": {"max_side": args.max_side, "max_new_tokens": args.max_new_tokens,
                   "four_bit": args.four_bit, "attn": args.attn, "mode": args.mode},
    }
    print(json.dumps(result, ensure_ascii=False, indent=1))
    out = HERE / "output" / f"bench35_{args.tag}.json"
    out.parent.mkdir(parents=True, exist_ok=True)
    out.write_text(json.dumps(result, ensure_ascii=False, indent=1), encoding="utf-8")
    print(f"-> {out}")


if __name__ == "__main__":
    main()
