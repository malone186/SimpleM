# VLM 영수증 OCR 파인튜닝 (백엔드 B)

CLOVA OCR + Gemini 2단계 파이프라인을 **파인튜닝한 Qwen3-VL-2B 하나**로 대체하기 위한
데이터·학습·평가 일체. 학습된 어댑터는 `ocr_service.py`의 `OCR_BACKEND=qwen_vlm` 백엔드가 로드한다.

> 참고: 요구사항의 "qwen3.5 0.8b"는 존재하지 않는 모델이다 (Qwen3 0.6B/1.7B는 텍스트 전용).
> 실존하는 가장 작은 Qwen 비전 모델인 **Qwen3-VL-2B-Instruct**를 사용했다.

## 구성

```
vlm_finetune/
├── synth_gen.py       # 합성 영수증 생성기 (마트/편의점/음식점/카페/거래명세서 5종 레이아웃)
├── train.py           # LoRA SFT (비전 타워 동결, 8GB VRAM 기준)
├── eval.py            # 필드 정확도 평가 (--base로 파인튜닝 전 기준선 비교)
├── data/
│   ├── synth/         # 생성된 학습 데이터 (train.jsonl 600건 / val.jsonl 60건)
│   └── real/labels/   # 실제 영수증 5장의 정답 JSON (사람이 직접 라벨링)
└── output/adapter/    # 학습 결과 (ocr_service가 이 경로를 읽음)
```

## 실행 순서

```powershell
# 0) CUDA torch 필수 (RTX 5060 = Blackwell → cu128)
pip install --index-url https://download.pytorch.org/whl/cu128 torch torchvision --force-reinstall --no-deps
pip install peft accelerate

# 1) 데이터 생성 (이미 생성돼 있으면 생략)
python synth_gen.py --train 600 --val 60 --seed 42

# 2) 학습 (~1시간, VRAM 부족하면 --max-side 768)
python train.py --epochs 2

# 3) 평가 — 파인튜닝 전/후 비교
python eval.py --base --limit 20   # 기준선
python eval.py                     # 파인튜닝 후

# 4) 서빙 전환: backend/.env에서
#    OCR_BACKEND=qwen_vlm
```

## 데이터 설계 노트

- **프롬프트 단일 소스**: 학습·평가·서빙 모두 `app/services/ai/vlm_prompt.py`의
  `VLM_PROMPT`를 사용한다. 프롬프트를 바꾸면 재학습해야 효과가 유지된다.
- **합성 데이터**: 굴림체/돋움체 고정폭 렌더링 + 폰 촬영 증강(회전·원근·블러·JPEG 열화·배경).
  정답 품목명은 이미지에 실제 렌더링된(열 폭에 잘린) 텍스트와 일치시켰다 —
  전체 이름으로 라벨링하면 모델이 이미지에 없는 글자를 지어내도록 학습되기 때문.
- **실제 영수증 라벨 5건**(`data/real/labels/`): 농협 마트·세븐일레븐·GS25·모트모트·한돈당.
  원본 이미지를 `data/real/<라벨의 image 파일명>`으로 넣으면 eval.py가 자동으로 평가에 포함한다.
  (6번째 파란 마트 영수증은 접혀서 판독 불가 → 정답 신뢰성이 없어 제외)
- **공개 한국어 영수증 데이터셋은 미사용**: AI Hub는 로그인/승인 필요, CORD(네이버)는
  인도네시아어 영수증이라 부적합. 대신 합성 생성기로 무제한 확보하는 전략을 택했다.

## 한계와 개선 여지

- 합성 데이터는 감열지 실물 촬영의 모든 변수(구겨짐, 손가락 가림, 그림자)를 재현하지 못한다.
  실제 매장 영수증이 쌓이면 `data/real/`에 (이미지, 라벨) 쌍을 추가해 재학습할 것.
- 세금계산서(tax_invoice) 레이아웃은 합성 미포함 — 현재는 unknown/유사 유형으로 나올 수 있음.
- 첫 호출 시 모델 로드 ~30초 (이후 상주). GPU 미탑재 PC에서는 CPU 추론이라 매우 느림 →
  그런 환경에서는 OCR_BACKEND=clova_gemini 유지.
