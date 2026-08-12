# -*- coding: utf-8 -*-
"""바탕화면 실영수증 5장 — 운영 Gemini OCR 경로 평가 (Qwen 비교용).

ocr_service의 실제 서빙 함수(_preprocess_image + _call_gemini)를 그대로 사용해
운영과 동일 조건(모델 gemini-3.1-flash-lite, responseSchema 강제, 1600² 픽셀버짓,
동일 VLM_PROMPT)으로 돌린다. 정답·채점은 eval_desktop5와 동일.

사용: python eval_desktop5_gemini.py
출력: metrics/eval_desktop5_gemini.json (같은 detail 포맷 → rescore_metrics 대상)
"""

import asyncio
import json
import sys
import time
from pathlib import Path

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE.parent))
from app.services.ai import ocr_service  # noqa: E402  (.env 자동 로드 포함)
from eval35 import score_one  # noqa: E402


async def main():
    rows = []
    for line in (HERE / "data" / "desktop5" / "gt.jsonl").read_text(encoding="utf-8").splitlines():
        if line.strip():
            r = json.loads(line)
            rows.append((Path(r["image"]), r["label"]))
    print(f"samples: {len(rows)}  model: {ocr_service.GEMINI_MODEL}")

    report, agg, times = [], {}, []
    for img_path, gt in rows:
        raw = img_path.read_bytes()
        t0 = time.perf_counter()
        processed = ocr_service._preprocess_image(raw)
        pred = await ocr_service._call_gemini(processed)
        dt = time.perf_counter() - t0
        times.append(dt)
        if not isinstance(pred, dict):
            pred = None
        s = score_one(pred, gt)
        for k, v in s.items():
            agg.setdefault(k, []).append(v)
        report.append({"image": img_path.name, "scores": s, "pred": pred, "gt": gt, "raw": None})
        print(f"  {img_path.name}: parsed={s['parsed']} f1={s['name_f1']:.2f} {dt:.1f}s", flush=True)

    summary = {k: sum(v) / len(v) for k, v in agg.items()}
    out_path = HERE / "metrics" / "eval_desktop5_gemini.json"
    out_path.write_text(json.dumps(
        {"summary": summary, "avg_infer_sec": sum(times) / len(times), "n": len(rows),
         "runtime": f"Gemini API ({ocr_service.GEMINI_MODEL}), 전처리+네트워크 왕복 포함",
         "detail": report},
        ensure_ascii=False, indent=1), encoding="utf-8")
    print(json.dumps(summary, ensure_ascii=False, indent=1))
    print(f"avg_infer_sec: {sum(times)/len(times):.2f}\n-> {out_path}")


if __name__ == "__main__":
    asyncio.run(main())
