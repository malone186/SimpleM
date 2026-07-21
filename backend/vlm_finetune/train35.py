# -*- coding: utf-8 -*-
"""Qwen3.5-0.8B LoRA 파인튜닝 — 실제 영수증 774장 (백엔드 B)

train.py(Qwen3-VL-2B·합성데이터)와 동일한 구조로, 모델만 Qwen3.5-0.8B
(early-fusion 멀티모달)로 바꾸고 data/receipt774/train.jsonl(실제 영수증)을 쓴다.
서빙(ocr_service)과 동일한 프롬프트(vlm_prompt.VLM_PROMPT)로 학습한다.

사용:
    python train35.py                      # 기본 2 epoch
    python train35.py --epochs 3 --max-side 768
출력:
    output/adapter35/  (LoRA 어댑터 — eval35.py가 사용)

실측 (RTX 5060 Laptop 8GB, 2026-07-21): 406장×2epoch=102스텝, 68분, 최종 loss 0.185
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
    Qwen3_5ForConditionalGeneration,
    Trainer,
    TrainingArguments,
)
from peft import LoraConfig, get_peft_model

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE.parent))
from app.services.ai.vlm_prompt import VLM_PROMPT  # noqa: E402

MODEL_ID = "Qwen/Qwen3.5-0.8B"


class ReceiptDataset(Dataset):
    """jsonl(한 줄 = {"image": 절대경로, "label": dict}) -> (PIL, 정답 JSON 문자열)"""

    def __init__(self, jsonl_paths: list[Path], max_side: int):
        self.rows = []
        for p in jsonl_paths:
            for line in p.read_text(encoding="utf-8").splitlines():
                if not line.strip():
                    continue
                row = json.loads(line)
                img = Path(row["image"])
                if not img.is_absolute():
                    img = p.parent / img
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
        target = json.dumps(label, ensure_ascii=False, separators=(", ", ": "))
        return img, target


def make_collate(processor):
    def collate(batch):
        img, target = batch[0]  # batch_size=1 고정
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
        labels[:, : prompt["input_ids"].shape[1]] = -100
        full["labels"] = labels
        return full

    return collate


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--epochs", type=float, default=2.0)
    ap.add_argument("--lr", type=float, default=1e-4)
    ap.add_argument("--max-side", type=int, default=1024)
    ap.add_argument("--grad-accum", type=int, default=8)
    ap.add_argument("--out", type=str, default=str(HERE / "output" / "adapter35"))
    ap.add_argument("--limit", type=int, default=None)
    args = ap.parse_args()

    assert torch.cuda.is_available(), "CUDA GPU가 필요합니다"

    ds = ReceiptDataset([HERE / "data" / "receipt774" / "train.jsonl"], args.max_side)
    if args.limit:
        ds.rows = ds.rows[: args.limit]
    print(f"train samples: {len(ds)}")

    processor = AutoProcessor.from_pretrained(MODEL_ID)
    model = Qwen3_5ForConditionalGeneration.from_pretrained(
        MODEL_ID, dtype=torch.bfloat16, attn_implementation="sdpa", device_map="cuda:0",
    )
    model.config.use_cache = False

    lora = LoraConfig(
        r=16, lora_alpha=32, lora_dropout=0.05, bias="none",
        # 언어모델 attention/MLP projection만. 0.8B는 bf16 LoRA가 8GB에 충분히 들어간다.
        target_modules=r".*(q_proj|k_proj|v_proj|o_proj|gate_proj|up_proj|down_proj)$",
    )
    model = get_peft_model(model, lora)
    model.print_trainable_parameters()
    model.enable_input_require_grads()

    targs = TrainingArguments(
        output_dir=str(HERE / "output" / "ckpt35"),
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
