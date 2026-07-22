# -*- coding: utf-8 -*-
"""llama-server(GGUF Q8) 웜 추론 속도 측정 — test 이미지 N장 순차 요청.

서버를 먼저 띄워야 한다:
    tools_bin/llama-server.exe -m output/qwen35-08b-ocr-q8.gguf \
        --mmproj output/mmproj-qwen35-08b.gguf -ngl 99 --port 8089 --ctx-size 8192
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

URL = "http://localhost:8089/v1/chat/completions"
N = int(sys.argv[1]) if len(sys.argv) > 1 else 6
MAX_SIDE = int(sys.argv[2]) if len(sys.argv) > 2 else 1024

rows = []
for line in (HERE / "data" / "receipt774" / "test.jsonl").read_text(encoding="utf-8").splitlines()[:N]:
    r = json.loads(line)
    img = Image.open(r["image"]).convert("RGB")
    if max(img.size) > MAX_SIDE:
        img.thumbnail((MAX_SIDE, MAX_SIDE), Image.LANCZOS)
    buf = io.BytesIO()
    img.save(buf, "JPEG", quality=88)
    rows.append((Path(r["image"]).name, base64.b64encode(buf.getvalue()).decode()))

times, out_toks = [], []
for name, b64 in rows:
    payload = {
        "messages": [{"role": "user", "content": [
            {"type": "image_url", "image_url": {"url": f"data:image/jpeg;base64,{b64}"}},
            {"type": "text", "text": VLM_PROMPT},
        ]}],
        "max_tokens": 1024, "temperature": 0,
    }
    t0 = time.perf_counter()
    resp = httpx.post(URL, json=payload, timeout=300)
    dt = time.perf_counter() - t0
    resp.raise_for_status()
    data = resp.json()
    content = data["choices"][0]["message"]["content"]
    ct = data.get("usage", {}).get("completion_tokens")
    times.append(dt)
    out_toks.append(ct)
    ok = "JSON_OK" if content.strip().startswith("{") or "{" in content else "??"
    print(f"{name}: {dt:.2f}s, completion_tokens={ct} {ok}")

warm = times[1:] if len(times) > 1 else times
print(f"\ncold: {times[0]:.2f}s")
print(f"warm avg: {sum(warm)/len(warm):.2f}s (n={len(warm)})")
if all(out_toks) and sum(times[1:]) > 0:
    print(f"warm tok/s: {sum(out_toks[1:])/sum(times[1:]):.1f}")
result = {"max_side": MAX_SIDE, "cold_sec": round(times[0], 2),
          "warm_avg_sec": round(sum(warm)/len(warm), 2),
          "times": [round(t, 2) for t in times], "completion_tokens": out_toks}
(HERE / "output" / f"bench_llamacpp_{MAX_SIDE}.json").write_text(json.dumps(result, indent=2), encoding="utf-8")
