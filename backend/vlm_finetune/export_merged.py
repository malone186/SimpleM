"""LoRA 어댑터를 베이스에 병합해 일반 HF 모델로 저장한다.

용도: GGUF(llama.cpp/Ollama)나 vLLM 서빙으로 넘기려면 어댑터가 아닌 단일 모델이어야 한다.
서빙(ocr_service)은 로드 시점에 알아서 병합하므로 이 스크립트 없이도 동작한다 —
이건 "더 빠른 추론 엔진으로 옮길 때"만 필요한 준비 단계다.

    python export_merged.py                      # output/merged 에 저장
    python export_merged.py --out D:/qwen-merged

이후 GGUF 변환 (llama.cpp 필요):
    python convert_hf_to_gguf.py <merged> --outfile qwen3vl-2b-ocr.gguf --outtype q8_0
    # vision 타워는 mmproj-*.gguf 로 함께 떨어진다
    ollama create simplem-ocr -f Modelfile
"""

import argparse
from pathlib import Path

import torch
from peft import PeftModel
from transformers import AutoProcessor, Qwen3VLForConditionalGeneration

HERE = Path(__file__).resolve().parent
BASE = "Qwen/Qwen3-VL-2B-Instruct"


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--adapter", default=str(HERE / "output" / "adapter"))
    ap.add_argument("--out", default=str(HERE / "output" / "merged"))
    args = ap.parse_args()

    if not (Path(args.adapter) / "adapter_config.json").exists():
        raise SystemExit(f"어댑터가 없습니다: {args.adapter} — 먼저 train.py로 학습하세요")

    # 병합은 CPU에서 해도 된다(가중치 덧셈뿐). GPU를 서빙에 쓰는 중이어도 안전하도록 CPU 고정.
    print(f"베이스 로드: {BASE} (bf16, CPU)")
    model = Qwen3VLForConditionalGeneration.from_pretrained(
        BASE, dtype=torch.bfloat16, device_map="cpu"
    )
    print(f"어댑터 적용: {args.adapter}")
    model = PeftModel.from_pretrained(model, args.adapter)
    model = model.merge_and_unload()

    out = Path(args.out)
    out.mkdir(parents=True, exist_ok=True)
    model.save_pretrained(out, safe_serialization=True)
    # 프로세서/토크나이저가 같이 있어야 변환 스크립트와 서빙 엔진이 전처리를 재현할 수 있다
    AutoProcessor.from_pretrained(BASE).save_pretrained(out)
    print(f"저장 완료: {out}")


if __name__ == "__main__":
    main()
