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
from peft import LoraConfig, get_peft_model, prepare_model_for_kbit_training

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE.parent))
from app.services.ai.vlm_prompt import VLM_PROMPT  # noqa: E402

MODEL_ID = "Qwen/Qwen3.5-0.8B"


def resize_pixel_budget(img: Image.Image, budget_side: int) -> Image.Image:
    """총 픽셀 수가 budget_side² 이하가 되도록 종횡비를 유지하며 축소한다.

    '긴 변 고정' 방식은 세로로 긴 영수증(예: 700×3000)을 239×1024로 뭉개
    글자가 소실된다. 픽셀 예산 방식은 같은 연산량으로 618×2650을 유지한다.
    """
    budget = budget_side * budget_side
    w, h = img.size
    if w * h > budget:
        scale = (budget / (w * h)) ** 0.5
        img = img.resize((max(1, int(w * scale)), max(1, int(h * scale))), Image.LANCZOS)
    return img


def augment_receipt(img: Image.Image, rng: "random.Random") -> Image.Image:
    """실사용 촬영 조건 합성 — 그림자·원근·회전·조명·노이즈 (학습 전용).

    어려운 실측 사례(손 그림자, 비스듬한 촬영, 저대비 도트 인쇄)를 흉내 낸다.
    확률적으로 적용해 원본 분포도 절반가량 유지한다.
    """
    from PIL import ImageDraw, ImageEnhance, ImageFilter

    w, h = img.size
    # 1) 원근 왜곡 (비스듬한 촬영) — 모서리를 최대 4%씩 무작위 이동
    if rng.random() < 0.5:
        d = 0.04
        j = lambda: rng.uniform(-d, d)  # noqa: E731
        src = [(0, 0), (w, 0), (w, h), (0, h)]
        dst = [(w * j(), h * j()), (w * (1 + j()), h * j()),
               (w * (1 + j()), h * (1 + j())), (w * j(), h * (1 + j()))]
        import numpy as np
        A = []
        for (x, y), (u, v) in zip(dst, src):
            A.append([x, y, 1, 0, 0, 0, -u * x, -u * y])
            A.append([0, 0, 0, x, y, 1, -v * x, -v * y])
        B = np.array([c for pt in src for c in pt], dtype=float)
        coeffs = np.linalg.lstsq(np.array(A, dtype=float), B, rcond=None)[0]
        img = img.transform((w, h), Image.PERSPECTIVE, coeffs, Image.BILINEAR, fillcolor=(200, 200, 200))
    # 2) 소각도 회전
    if rng.random() < 0.4:
        img = img.rotate(rng.uniform(-3, 3), Image.BILINEAR, expand=False, fillcolor=(200, 200, 200))
    # 3) 그림자 — 반투명 어두운 다각형을 합성 (손·폰 그림자)
    if rng.random() < 0.5:
        overlay = Image.new("L", img.size, 0)
        draw = ImageDraw.Draw(overlay)
        cx, cy = rng.uniform(0, w), rng.uniform(h * 0.3, h)
        pts = [(cx + rng.uniform(-w * 0.5, w * 0.5), cy + rng.uniform(-h * 0.4, h * 0.4)) for _ in range(5)]
        draw.polygon(pts, fill=rng.randint(60, 130))
        overlay = overlay.filter(ImageFilter.GaussianBlur(rng.uniform(10, 40)))
        black = Image.new("RGB", img.size, (0, 0, 0))
        img = Image.composite(black, img, overlay)  # 마스크 밝기만큼 어두워짐
    # 4) 조명/대비/채도 요동 (저대비 도트 인쇄·형광등)
    if rng.random() < 0.6:
        img = ImageEnhance.Brightness(img).enhance(rng.uniform(0.7, 1.25))
        img = ImageEnhance.Contrast(img).enhance(rng.uniform(0.65, 1.2))
        img = ImageEnhance.Color(img).enhance(rng.uniform(0.6, 1.2))
    # 5) 흐림 (초점 미스)
    if rng.random() < 0.2:
        img = img.filter(ImageFilter.GaussianBlur(rng.uniform(0.5, 1.2)))
    # 6) 저해상도 열화 — 웹 축소본·구형 폰 사진 모사 (실측 실패 사례: 387×516 업로드).
    #    작게 줄였다가 되돌려 디테일을 뭉갠다. 열화 후에도 라벨은 그대로이므로
    #    모델이 뭉개진 글자에서 문맥으로 복원하는 것을 배운다.
    if rng.random() < 0.35:
        w2, h2 = img.size
        factor = rng.uniform(0.35, 0.65)
        img = img.resize((max(1, int(w2 * factor)), max(1, int(h2 * factor))), Image.BILINEAR)
        img = img.resize((w2, h2), Image.BILINEAR)
    # 7) JPEG 재압축 노이즈 (메신저·웹 전송 화질)
    if rng.random() < 0.35:
        import io as _io
        buf = _io.BytesIO()
        img.save(buf, "JPEG", quality=rng.randint(25, 60))
        buf.seek(0)
        img = Image.open(buf).convert("RGB")
    return img


class ReceiptDataset(Dataset):
    """jsonl(한 줄 = {"image": 절대경로, "label": dict}) -> (PIL, 정답 JSON 문자열)"""

    def __init__(self, jsonl_paths: list[Path], budget_side: int, augment: bool = False):
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
        self.budget_side = budget_side
        self.augment = augment
        self._epoch_seed = 0

    def __len__(self):
        return len(self.rows)

    def __getitem__(self, idx):
        import random as _random

        img_path, label = self.rows[idx]
        img = Image.open(img_path).convert("RGB")
        if self.augment:
            # idx 기반 시드 + 호출마다 증가 -> epoch마다 다른 변형 (재현성은 로그로 충분)
            self._epoch_seed += 1
            img = augment_receipt(img, _random.Random(idx * 100003 + self._epoch_seed))
        img = resize_pixel_budget(img, self.budget_side)
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
    ap.add_argument("--model", type=str, default=MODEL_ID, help="베이스 모델 (예: Qwen/Qwen3.5-2B)")
    ap.add_argument("--use-4bit", action="store_true",
                    help="QLoRA: 베이스 4bit 양자화 — 2B는 bf16이 8GB VRAM을 넘쳐 필수 (0.8B는 불필요)")
    ap.add_argument("--epochs", type=float, default=2.0)
    ap.add_argument("--lr", type=float, default=1e-4)
    ap.add_argument("--max-side", type=int, default=1024,
                    help="픽셀 예산의 한 변 (총 픽셀 max_side² 이하로 종횡비 유지 축소)")
    ap.add_argument("--augment", action="store_true", help="그림자·원근·조명 증강 (실촬영 강건화)")
    ap.add_argument("--grad-accum", type=int, default=8)
    ap.add_argument("--out", type=str, default=str(HERE / "output" / "adapter35"))
    ap.add_argument("--limit", type=int, default=None)
    ap.add_argument("--resume", type=str, default=None,
                    help="중단된 학습 재개: output/ckpt35/checkpoint-N 경로 (OOM 등으로 죽었을 때)")
    args = ap.parse_args()

    assert torch.cuda.is_available(), "CUDA GPU가 필요합니다"

    ds = ReceiptDataset([HERE / "data" / "receipt774" / "train.jsonl"], args.max_side, augment=args.augment)
    if args.limit:
        ds.rows = ds.rows[: args.limit]
    print(f"train samples: {len(ds)}")

    processor = AutoProcessor.from_pretrained(args.model)
    quant = None
    if args.use_4bit:
        from transformers import BitsAndBytesConfig
        quant = BitsAndBytesConfig(
            load_in_4bit=True, bnb_4bit_quant_type="nf4",
            bnb_4bit_use_double_quant=True, bnb_4bit_compute_dtype=torch.bfloat16,
        )
    model = Qwen3_5ForConditionalGeneration.from_pretrained(
        args.model, dtype=torch.bfloat16, attn_implementation="sdpa", device_map="cuda:0",
        quantization_config=quant,
    )
    model.config.use_cache = False
    if args.use_4bit:
        model = prepare_model_for_kbit_training(model, use_gradient_checkpointing=True)

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
    trainer.train(resume_from_checkpoint=args.resume or None)

    out = Path(args.out)
    out.mkdir(parents=True, exist_ok=True)
    model.save_pretrained(str(out))
    processor.save_pretrained(str(out))
    print(f"adapter saved -> {out}")


if __name__ == "__main__":
    main()
