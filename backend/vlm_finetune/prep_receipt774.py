# -*- coding: utf-8 -*-
"""Desktop의 실제 영수증 774장 + items_*.csv -> 학습용 jsonl 변환 (백엔드 B)

데이터 특성 (2026-07-21 분석):
  - 이미지 분할은 폴더 기준: train 464 / val 154 / test 156
  - items_train/val/test.csv는 이미지 단위가 아니라 "품목 행" 단위로 랜덤 분할되어
    있어 (IMG00562의 품목 001~005가 세 CSV에 흩어져 있음), 세 CSV를 전부 합쳐야
    이미지 1장의 완전한 품목 리스트가 된다.
  - Item_Name 컬럼은 영수증 한 줄의 토큰들이 ', '로 이어진 원문 텍스트
    (품목명·바코드·단가·수량·금액 순서 뒤섞임). 수량/단가/금액은 별도 숫자
    컬럼(Number of units/Price/Total Price)이 정답이므로 이름만 파싱한다.
  - CSV에 한 줄도 없는 이미지 105장은 라벨이 없어 제외한다.

출력: data/receipt774/{train,val,test}.jsonl  (한 줄 = {"image": 경로, "label": dict})
라벨 형식은 vlm_prompt.EXTRACTION_SCHEMA의 부분집합:
  {"doc_type": "receipt", "items": [{"name", "spec": null, "quantity", "unit": null,
   "unit_price", "amount"}]}
vendor/날짜/합계는 CSV에 정답이 없어 라벨에 넣지 않는다 (학습 손실에서 제외됨).
"""

import csv
import json
import re
from pathlib import Path

HERE = Path(__file__).resolve().parent
DESKTOP = Path("C:/Users/USER/Desktop")
OUT_DIR = HERE / "data" / "receipt774"

# 코드성 토큰: [12345], $*211091, *213060, 000136, 8801117488802, '#', '*#' 등
_CODE = re.compile(r"^[\[\]$*#i:\-+~=. ]*[\d\[\]$*#,.\-]*$")
_NUM = re.compile(r"^[+\-]?[\d,]+(\.\d+)?[ ]?[*#]*$")


def _is_text_token(tok: str) -> bool:
    """품목명 후보인지 — 한글이 있거나, 숫자/코드가 아닌 영문 단어가 있으면 True."""
    tok = tok.strip()
    if not tok:
        return False
    if re.search(r"[가-힣]", tok):
        return True
    if _NUM.match(tok) or _CODE.match(tok):
        return False
    # 영문 이름 (예: 'PAKET QORACHOY', 'Qiyma 6000')
    return bool(re.search(r"[A-Za-z]{2,}", tok))


def parse_name(raw: str) -> str | None:
    """Item_Name 원문에서 품목명 토큰을 복원한다.

    ', ' 분리 후 첫 텍스트 토큰을 이름으로 삼되, 괄호가 안 닫혔고 다음 토큰에
    ')'가 있을 때만 이어 붙인다 (예: '상추(적, 청) 1봉'). 영수증이 이름을 중간에서
    자른 경우('칵테일새우살(중')는 미닫힌 채 그대로가 인쇄된 원문이므로 두지 않는다.
    """
    tokens = [t for t in raw.split(", ")]
    name = None
    for i, tok in enumerate(tokens):
        if _is_text_token(tok):
            name = tok.strip()
            while (name.count("(") > name.count(")") and i + 1 < len(tokens)
                   and ")" in tokens[i + 1]):
                i += 1
                name = f"{name}, {tokens[i].strip()}"
            break
    return name


def _to_num(s: str) -> float | int | None:
    s = (s or "").strip()
    if not s:
        return None
    try:
        v = float(s)
    except ValueError:
        return None
    return int(v) if v == int(v) else v


def load_all_items() -> dict[str, list[dict]]:
    """세 CSV를 합쳐 이미지별 품목 리스트를 만든다 (행 단위 분할 복원)."""
    by_img: dict[str, list[dict]] = {}
    for split in ("train", "val", "test"):
        with open(DESKTOP / f"items_{split}.csv", encoding="utf-8-sig") as f:
            for r in csv.DictReader(f):
                name = parse_name(r["Item_Name"])
                if not name:
                    continue
                by_img.setdefault(r["image_name"], []).append({
                    "name": name,
                    "spec": None,
                    "quantity": _to_num(r["Number of units"]),
                    "unit": None,
                    "unit_price": _to_num(r["Price"]),
                    "amount": _to_num(r["Total Price"]),
                })
    # 영수증 인쇄 순서 복원: 품목명 앞 줄번호('001 ', '04 ')가 전부 있으면 그걸로 정렬
    for items in by_img.values():
        keys = [re.match(r"^(\d{1,3})[ *]", i["name"]) for i in items]
        if len(items) > 1 and all(keys):
            items.sort(key=lambda i: int(re.match(r"^(\d{1,3})[ *]", i["name"]).group(1)))
    return by_img


def main():
    by_img = load_all_items()
    OUT_DIR.mkdir(parents=True, exist_ok=True)
    for split in ("train", "val", "test"):
        img_dir = DESKTOP / split / split / "images"
        rows, skipped = [], []
        imgs = [p for p in img_dir.iterdir() if p.suffix.lower() in (".png", ".jpg", ".jpeg")]
        for img in sorted(imgs):
            stem = img.stem
            if stem not in by_img:
                skipped.append(stem)
                continue
            label = {"doc_type": "receipt", "items": by_img[stem]}
            rows.append({"image": str(img).replace("\\", "/"), "label": label})
        out = OUT_DIR / f"{split}.jsonl"
        with open(out, "w", encoding="utf-8") as f:
            for r in rows:
                f.write(json.dumps(r, ensure_ascii=False) + "\n")
        print(f"{split}: {len(rows)} labeled, {len(skipped)} skipped (no CSV rows) -> {out}")
    total_items = sum(len(v) for v in by_img.values())
    print(f"images with labels: {len(by_img)}, total items: {total_items}")


if __name__ == "__main__":
    main()
