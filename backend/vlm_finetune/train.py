# -*- coding: utf-8 -*-
"""Qwen3-VL-2B-Instruct LoRA 파인튜닝 — 영수증 이미지 -> 구조화 JSON (백엔드 B)

서빙(ocr_service)과 동일한 프롬프트(vlm_prompt.VLM_PROMPT)로 학습해
학습-추론 분포를 일치시킨다. 비전 타워는 동결하고 언어모델 projection에만
LoRA를 붙인다 (8GB VRAM 노트북 기준).

사용:
    python train.py                        # data/synth/train.jsonl로 학습
    python train.py --epochs 3 --max-side 768   # OOM이면 max-side를 줄일 것
출력:
    output/adapter/  (LoRA 어댑터 — eval.py와 ocr_service qwen_vlm 백엔드가 사용)
"""

import argparse
import json
import sys
from pathlib import Path

import torch
from PIL import Image
from torch.utils.data import Dataset
from transformers import (
    AutoProcessor,
    BitsAndBytesConfig,
    Qwen3VLForConditionalGeneration,
    Trainer,
    TrainingArguments,
)
from peft import LoraConfig, get_peft_model, prepare_model_for_kbit_training

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE.parent))  # backend/ — app.services.ai.vlm_prompt import용
from app.services.ai.vlm_prompt import VLM_PROMPT  # noqa: E402

MODEL_ID = "Qwen/Qwen3-VL-2B-Instruct"


class ReceiptDataset(Dataset):
    """jsonl(한 줄 = {"image": 상대경로, "label": dict}) -> (PIL, 정답 JSON 문자열)"""

    def __init__(self, jsonl_paths: list[Path], max_side: int):
        self.rows = []
        for p in jsonl_paths:
            base = p.parent
            for line in p.read_text(encoding="utf-8").splitlines():
                if not line.strip():
                    continue
                row = json.loads(line)
                img = base / row["image"]
                if img.exists():
                    self.rows.append((img, row["label"]))
        self.max_side = max_side

    def __len__(self):
        return len(self.rows)

    def __getitem__(self, idx):
        img_path, label = self.rows[idx]
        img = Image.open(img_path).convert("RGB")
        if max(img.size) > self.max_side:
            img.thumbnail((self.max_side, self.max_side), Image.LANCZOS)
        # 정답은 한 줄 JSON — 추론 때도 같은 형태로 뱉게 된다
        target = json.dumps(label, ensure_ascii=False, separators=(", ", ": "))
        return img, target


def make_collate(processor):
    def collate(batch):
        img, target = batch[0]  # batch_size=1 고정 (패딩 없이 단순·안전)
        user_msg = {
            "role": "user",
            "content": [{"type": "image", "image": img}, {"type": "text", "text": VLM_PROMPT}],
        }
        full = processor.apply_chat_template(
            [user_msg, {"role": "assistant", "content": [{"type": "text", "text": target}]}],
            tokenize=True, return_dict=True, return_tensors="pt",
        )
        prompt = processor.apply_chat_template(
            [user_msg],
            tokenize=True, add_generation_prompt=True, return_dict=True, return_tensors="pt",
        )
        labels = full["input_ids"].clone()
        labels[:, : prompt["input_ids"].shape[1]] = -100  # 프롬프트·이미지 토큰은 손실 제외
        full["labels"] = labels
        return full

    return collate


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--epochs", type=float, default=2.0)
    ap.add_argument("--lr", type=float, default=1e-4)
    ap.add_argument("--max-side", type=int, default=1024, help="이미지 최대 변 (OOM이면 768)")
    ap.add_argument("--grad-accum", type=int, default=8)
    ap.add_argument("--out", type=str, default=str(HERE / "output" / "adapter"))
    ap.add_argument("--limit", type=int, default=None, help="샘플 수 제한 (파이프라인 스모크 테스트용)")
    ap.add_argument("--use-4bit", action="store_true",
                    help="QLoRA: 베이스 가중치 4bit 양자화 (8GB VRAM에서 bf16은 손실 계산 시 OOM)")
    args = ap.parse_args()

    assert torch.cuda.is_available(), "CUDA GPU가 필요합니다 (cu128 torch 설치 확인)"

    train_files = [HERE / "data" / "synth" / "train.jsonl"]
    ds = ReceiptDataset(train_files, args.max_side)
    if args.limit:
        ds.rows = ds.rows[: args.limit]
    print(f"train samples: {len(ds)}")

    processor = AutoProcessor.from_pretrained(MODEL_ID)
    quant = None
    if args.use_4bit:
        quant = BitsAndBytesConfig(
            load_in_4bit=True,
            bnb_4bit_quant_type="nf4",
            bnb_4bit_use_double_quant=True,
            bnb_4bit_compute_dtype=torch.bfloat16,
        )
    model = Qwen3VLForConditionalGeneration.from_pretrained(
        MODEL_ID, dtype=torch.bfloat16, attn_implementation="sdpa", device_map="cuda:0",
        quantization_config=quant,
    )
    model.config.use_cache = False
    if args.use_4bit:
        model = prepare_model_for_kbit_training(model, use_gradient_checkpointing=True)

    lora = LoraConfig(
        r=16, lora_alpha=32, lora_dropout=0.05, bias="none",
        # 언어모델 쪽 projection만 — 비전 타워는 동결 (메모리 절약 + 합성데이터 과적합 방지)
        target_modules=r".*language_model.*\.(q_proj|k_proj|v_proj|o_proj|gate_proj|up_proj|down_proj)$",
    )
    model = get_peft_model(model, lora)
    model.print_trainable_parameters()
    model.enable_input_require_grads()  # grad checkpointing + 동결 임베딩 조합에 필요

    targs = TrainingArguments(
        output_dir=str(HERE / "output" / "ckpt"),
        num_train_epochs=args.epochs,
        per_device_train_batch_size=1,
        gradient_accumulation_steps=args.grad_accum,
        learning_rate=args.lr,
        lr_scheduler_type="cosine",
        warmup_ratio=0.03,
        bf16=True,
        gradient_checkpointing=True,
        logging_steps=10,
        save_strategy="epoch",
        save_total_limit=1,
        report_to=[],
        remove_unused_columns=False,
        dataloader_num_workers=0,
    )
    trainer = Trainer(model=model, args=targs, train_dataset=ds, data_collator=make_collate(processor))
    trainer.train()

    out = Path(args.out)
    out.mkdir(parents=True, exist_ok=True)
    model.save_pretrained(str(out))
    processor.save_pretrained(str(out))
    print(f"adapter saved -> {out}")


if __name__ == "__main__":
    main()
