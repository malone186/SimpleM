# -*- coding: utf-8 -*-
"""Qwen3.5-0.8B LoRA 어댑터를 베이스에 병합해 일반 HF 모델로 저장한다.

용도: GGUF(llama.cpp)나 vLLM 서빙으로 넘기려면 어댑터가 아닌 단일 모델이어야 한다.

    python export_merged35.py                    # output/merged35 에 저장

이후 GGUF 변환 (llama.cpp 필요):
    python convert_hf_to_gguf.py <merged35> --outfile qwen35-08b-ocr-q8.gguf --outtype q8_0
    python convert_hf_to_gguf.py <merged35> --outfile mmproj-qwen35-08b.gguf --mmproj
"""

import argparse
from pathlib import Path

import torch
from peft import PeftModel
from transformers import AutoProcessor, Qwen3_5ForConditionalGeneration

HERE = Path(__file__).resolve().parent
BASE = "Qwen/Qwen3.5-0.8B"


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--adapter", default=str(HERE / "output" / "adapter35"))
    ap.add_argument("--out", default=str(HERE / "output" / "merged35"))
    ap.add_argument("--base", default=None,
                    help="베이스 모델 (기본: 어댑터 config의 base_model_name_or_path, 없으면 0.8B)")
    args = ap.parse_args()

    cfg_path = Path(args.adapter) / "adapter_config.json"
    if not cfg_path.exists():
        raise SystemExit(f"어댑터가 없습니다: {args.adapter} — 먼저 train35.py로 학습하세요")

    # 베이스는 어댑터가 기억하는 학습 당시 모델을 따른다 — 0.8B/2B를 같은 스크립트로 병합.
    import json
    base = args.base or json.loads(cfg_path.read_text(encoding="utf-8")).get("base_model_name_or_path") or BASE

    # 병합은 CPU에서 해도 된다(가중치 덧셈뿐). GPU가 평가 중이어도 안전하도록 CPU 고정.
    print(f"베이스 로드: {base} (bf16, CPU)")
    model = Qwen3_5ForConditionalGeneration.from_pretrained(base, dtype=torch.bfloat16, device_map="cpu")
    print(f"어댑터 적용: {args.adapter}")
    model = PeftModel.from_pretrained(model, args.adapter)
    model = model.merge_and_unload()

    out = Path(args.out)
    out.mkdir(parents=True, exist_ok=True)
    model.save_pretrained(out, safe_serialization=True)
    AutoProcessor.from_pretrained(base).save_pretrained(out)
    print(f"저장 완료: {out}")


if __name__ == "__main__":
    main()
