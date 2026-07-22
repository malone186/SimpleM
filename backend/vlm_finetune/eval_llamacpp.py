# -*- coding: utf-8 -*-
"""llama-server(파인튜닝 GGUF Q8) 정확도 평가 — eval35.py와 동일 지표/데이터.

양자화(Q8)·서빙엔진 교체가 정확도를 깎지 않는지 transformers 경로와 비교하는 용도.
서버가 떠 있어야 한다 (tools_bin/llama-server.exe ... --port 8089).

    python eval_llamacpp.py            # test 130장
출력: output/eval35_llamacpp.json
"""

import base64
import io
import json
import sys
import time
from pathlib import Path

import httpx
from PIL import Image

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE.parent))
from app.services.ai.vlm_prompt import VLM_PROMPT  # noqa: E402
from eval35 import load_rows, parse_json, score_one  # noqa: E402  (동일 채점 로직 재사용)
from train35 import resize_pixel_budget  # noqa: E402  (학습 v2와 동일 리사이즈)

URL = "http://localhost:8089/v1/chat/completions"
MAX_SIDE = 1024


def main():
    limit = int(sys.argv[1]) if len(sys.argv) > 1 else None
    rows = load_rows("test", limit)
    print(f"eval samples: {len(rows)} (llama.cpp Q8, max_side={MAX_SIDE})")

    report, agg, times = [], {}, []
    for i, (img_path, gt) in enumerate(rows):
        img = Image.open(img_path).convert("RGB")
        img = resize_pixel_budget(img, MAX_SIDE)
        buf = io.BytesIO()
        img.save(buf, "JPEG", quality=88)
        b64 = base64.b64encode(buf.getvalue()).decode()
        t0 = time.perf_counter()
        resp = httpx.post(URL, json={
            "messages": [{"role": "user", "content": [
                {"type": "image_url", "image_url": {"url": f"data:image/jpeg;base64,{b64}"}},
                {"type": "text", "text": VLM_PROMPT}]}],
            "max_tokens": 1024, "temperature": 0,
            "chat_template_kwargs": {"enable_thinking": False}}, timeout=300)
        times.append(time.perf_counter() - t0)
        text = resp.json()["choices"][0]["message"]["content"] or ""
        pred = parse_json(text)
        s = score_one(pred, gt)
        for k, v in s.items():
            agg.setdefault(k, []).append(v)
        report.append({"image": img_path.name, "scores": s, "pred": pred, "gt": gt,
                       "raw": None if pred else text[:500]})
        if (i + 1) % 20 == 0:
            done = {k: sum(v) / len(v) for k, v in agg.items()}
            print(f"  {i + 1}/{len(rows)}  f1={done['name_f1']:.3f} full={done['full_recall']:.3f} "
                  f"avg={sum(times)/len(times):.2f}s", flush=True)

    print("\n=== item metrics (llama.cpp Q8) ===")
    summary = {k: sum(v) / len(v) for k, v in agg.items()}
    for k, v in summary.items():
        print(f"  {k:16s}: {v:.3f}")
    print(f"  avg_infer_sec   : {sum(times)/len(times):.2f}")
    out_path = HERE / "output" / "eval35_llamacpp.json"
    out_path.write_text(json.dumps({"summary": summary, "avg_infer_sec": sum(times) / len(times),
                                    "n": len(rows), "detail": report},
                                   ensure_ascii=False, indent=1), encoding="utf-8")
    print(f"report -> {out_path}")


if __name__ == "__main__":
    main()
