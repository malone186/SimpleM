#!/bin/bash
# 2B 학습 완료 직후 논스톱 마무리: 병합 -> GGUF Q8 변환 -> 메타 패치 -> 서버(8090) -> 평가
set -e
cd "C:/Users/USER/Desktop/final/backend/vlm_finetune"

export PYTHONIOENCODING=utf-8 PYTHONUNBUFFERED=1 PYTHONUTF8=1

echo "[1/5] LoRA 병합 (CPU)"
python export_merged35.py --adapter output/adapter2b --out output/merged2b 2>&1 | tail -1

echo "[2/5] GGUF Q8 변환 (본체 + mmproj — 0.8B용 mmproj는 hidden 차원이 달라 재사용 불가)"
python tools_llamacpp/convert_hf_to_gguf.py output/merged2b --outfile output/qwen35-2b-ocr-q8.gguf --outtype q8_0 2>&1 | tail -1
python tools_llamacpp/convert_hf_to_gguf.py output/merged2b --outfile output/mmproj-qwen35-2b.gguf --mmproj 2>&1 | tail -1

echo "[3/5] 메타데이터 패치 (block_count는 merged2b config 실측값)"
BLOCKS=$(python - <<'EOF'
import json
cfg = json.load(open("output/merged2b/config.json"))
print(cfg.get("num_hidden_layers") or cfg["text_config"]["num_hidden_layers"])
EOF
)
python - <<'EOF'
from gguf import GGUFReader
r = GGUFReader("output/qwen35-2b-ocr-q8.gguf")
for k in ("qwen35.block_count", "qwen35.nextn_predict_layers"):
    f = r.fields.get(k)
    print(k, f.parts[-1].tolist() if f else "absent")
EOF
python tools_llamacpp/gguf-py/gguf/scripts/gguf_set_metadata.py output/qwen35-2b-ocr-q8.gguf qwen35.block_count "$BLOCKS" --force 2>&1 | tail -1 || true
python tools_llamacpp/gguf-py/gguf/scripts/gguf_set_metadata.py output/qwen35-2b-ocr-q8.gguf qwen35.nextn_predict_layers 0 --force 2>&1 | tail -1 || true

echo "[4/5] llama-server 기동 (포트 8090 — 운영 8089 무간섭)"
./tools_bin/llama-server.exe -m output/qwen35-2b-ocr-q8.gguf --mmproj output/mmproj-qwen35-2b.gguf -ngl 99 --port 8090 --ctx-size 8192 > output/llamaserver_2b_log.txt 2>&1 &
SRV=$!
until curl -s http://localhost:8090/health 2>/dev/null | grep -q ok; do sleep 2; done
echo "server ready"

echo "[5/5] test 130장 평가"
LLAMACPP_EVAL_PORT=8090 python - <<'EOF'
import os, sys, io, json, time, base64
sys.path.insert(0, '..'); sys.path.insert(0, '.')
import httpx
from PIL import Image
from app.services.ai.vlm_prompt import VLM_PROMPT
from eval35 import load_rows, parse_json, score_one
from train35 import resize_pixel_budget

rows = load_rows("test", None)
agg, times = {}, []
for i, (img_path, gt) in enumerate(rows):
    img = Image.open(img_path).convert("RGB")
    img = resize_pixel_budget(img, 1024)
    buf = io.BytesIO(); img.save(buf, "JPEG", quality=88)
    b64 = base64.b64encode(buf.getvalue()).decode()
    t0 = time.perf_counter()
    resp = httpx.post("http://localhost:8090/v1/chat/completions", json={
        "messages": [{"role": "user", "content": [
            {"type": "image_url", "image_url": {"url": f"data:image/jpeg;base64,{b64}"}},
            {"type": "text", "text": VLM_PROMPT}]}],
        "max_tokens": 1024, "temperature": 0,
        "chat_template_kwargs": {"enable_thinking": False}}, timeout=300)
    times.append(time.perf_counter() - t0)
    text = resp.json()["choices"][0]["message"]["content"] or ""
    s = score_one(parse_json(text), gt)
    for k, v in s.items():
        agg.setdefault(k, []).append(v)
    if (i + 1) % 20 == 0:
        d = {k: sum(v)/len(v) for k, v in agg.items()}
        print(f"  {i+1}/130 f1={d['name_f1']:.3f} full={d['full_recall']:.3f} avg={sum(times)/len(times):.1f}s", flush=True)
summary = {k: sum(v)/len(v) for k, v in agg.items()}
summary["avg_infer_sec"] = sum(times)/len(times)
print("=== 2B GGUF Q8 (test 130) ===")
for k, v in summary.items():
    print(f"  {k:16s}: {v:.3f}")
json.dump(summary, open("output/eval_2b_gguf.json", "w"), indent=1)
EOF

kill $SRV 2>/dev/null || true
echo "FINISH2B_DONE"
