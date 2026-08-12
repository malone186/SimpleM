# -*- coding: utf-8 -*-
"""저장된 평가 JSON(pred/gt)에서 확장 지표를 재계산한다 — 모델 재실행 없음.

eval35.py가 남긴 detail[].pred / detail[].gt를 읽어 다음을 계산:
  - CER                      : 품목명 문자 오류율 (정규화 이름 기준, 아래 정의 참고)
  - field accuracy           : 필드별(name/quantity/unit_price/amount) 정확도
  - exact match (item)       : 4개 필드가 모두 맞은 품목 비율 (micro, gt 기준)
  - complete receipt acc     : 영수증 단위 완전 정답 비율
  - (기존 summary의 name_f1, avg_infer_sec는 그대로 인용)

2B(eval_2b_q4_1024.json)는 pred/gt가 없어 이미지별 scores에서 파생 가능한
complete receipt accuracy(3필드 기준)만 계산한다.

CER 정의: gt 품목과 pred 품목을 (1) 정규화 이름 완전 일치 → (2) 남은 것끼리
편집거리 최소 순 그리디로 짝지은 뒤, 짝의 편집거리 합 ÷ gt 이름 총 글자수.
짝이 없는 gt 품목은 전체 삭제(이름 길이만큼 오류)로 계산. 남는 pred 품목
(환각)은 CER엔 넣지 않는다 — 환각은 name_precision/F1이 담당.

사용: python rescore_metrics.py   → metrics/rescore_extended.json + 콘솔 요약
"""

import json
import re
from collections import Counter
from pathlib import Path

HERE = Path(__file__).resolve().parent
METRICS = HERE / "metrics"


def norm_name(s):
    return re.sub(r"\s+", "", str(s or "")).lower()


def norm_name_noprefix(s):
    """번호 접두어("001 ", "13 ") 무시 정규화 — Gemini가 접두어를 떼고 출력해
    표기 차이가 이름 오답으로 채점되는 것을 막는다. '1인분'처럼 숫자 뒤에
    공백이 없으면 이름의 일부로 보고 보존한다."""
    return norm_name(re.sub(r"^\s*\d+\s+", "", str(s or "")))


def _eq_num(a, b):
    if a is None or b is None:
        return a == b
    try:
        return abs(float(a) - float(b)) < 0.5
    except (TypeError, ValueError):
        return False


def lev(a: str, b: str) -> int:
    if not a:
        return len(b)
    if not b:
        return len(a)
    prev = list(range(len(b) + 1))
    for i, ca in enumerate(a, 1):
        cur = [i]
        for j, cb in enumerate(b, 1):
            cur.append(min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (ca != cb)))
        prev = cur
    return prev[-1]


FIELDS = ("name", "quantity", "unit_price", "amount")


def pair_items(gt_items, pred_items, norm=norm_name):
    """(gt_idx, pred_idx) 짝 목록. 이름 완전일치 우선, 나머지는 편집거리 그리디."""
    gt_names = [norm(g.get("name")) for g in gt_items]
    pr_names = [norm(p.get("name")) for p in pred_items]
    pairs, used_gt, used_pr = [], set(), set()
    # 1) 멀티셋 완전 일치 (eval35.score_one과 동일한 정신)
    by_name = {}
    for j, n in enumerate(pr_names):
        by_name.setdefault(n, []).append(j)
    taken = Counter()
    for i, n in enumerate(gt_names):
        cand = by_name.get(n, [])
        if taken[n] < len(cand):
            j = cand[taken[n]]
            taken[n] += 1
            pairs.append((i, j))
            used_gt.add(i)
            used_pr.add(j)
    # 2) 남은 것끼리 편집거리 최소 순 그리디
    rest_gt = [i for i in range(len(gt_items)) if i not in used_gt]
    rest_pr = [j for j in range(len(pred_items)) if j not in used_pr]
    cand = sorted(
        ((lev(gt_names[i], pr_names[j]), i, j) for i in rest_gt for j in rest_pr)
    )
    for d, i, j in cand:
        if i not in used_gt and j not in used_pr:
            pairs.append((i, j))
            used_gt.add(i)
            used_pr.add(j)
    unmatched_gt = [i for i in range(len(gt_items)) if i not in used_gt]
    return pairs, unmatched_gt


def rescore_35(path: Path, norm=norm_name):
    data = json.loads(path.read_text(encoding="utf-8"))
    ed_sum = ref_chars = 0
    field_hit = Counter()
    n_gt_items = exact_items = 0
    complete3 = complete4 = 0
    recalls, precisions, f1s, full_recalls = [], [], [], []
    n_img = len(data["detail"])
    for row in data["detail"]:
        gt_items = row["gt"].get("items", [])
        pred = row["pred"]
        pred_items = [i for i in ((pred or {}).get("items") or []) if isinstance(i, dict)]
        n_gt_items += len(gt_items)
        ref_chars += sum(len(norm(g.get("name"))) for g in gt_items)
        if pred is None:
            ed_sum += sum(len(norm(g.get("name"))) for g in gt_items)
            recalls.append(0.0)
            precisions.append(0.0)
            f1s.append(0.0)
            full_recalls.append(0.0)
            continue
        pairs, unmatched_gt = pair_items(gt_items, pred_items, norm)
        ok3 = ok4 = name_hit = 0
        for i, j in pairs:
            g, p = gt_items[i], pred_items[j]
            gn, pn = norm(g.get("name")), norm(p.get("name"))
            ed_sum += lev(gn, pn)
            f_ok = {
                "name": gn == pn,
                "quantity": _eq_num(p.get("quantity"), g.get("quantity")),
                "unit_price": _eq_num(p.get("unit_price"), g.get("unit_price")),
                "amount": _eq_num(p.get("amount"), g.get("amount")),
            }
            for f, ok in f_ok.items():
                field_hit[f] += ok
            if f_ok["name"]:
                name_hit += 1
            if f_ok["name"] and f_ok["quantity"] and f_ok["amount"]:
                ok3 += 1
                if f_ok["unit_price"]:
                    ok4 += 1
                    exact_items += 1
        ed_sum += sum(len(norm(gt_items[i].get("name"))) for i in unmatched_gt)
        r = name_hit / max(len(gt_items), 1)
        p = name_hit / max(len(pred_items), 1)
        recalls.append(r)
        precisions.append(p)
        f1s.append(2 * p * r / (p + r) if p + r else 0.0)
        full_recalls.append(ok3 / max(len(gt_items), 1))
        if len(pred_items) == len(gt_items) and ok3 == len(gt_items):
            complete3 += 1
            if ok4 == len(gt_items):
                complete4 += 1
    nd = max(n_gt_items, 1)
    return {
        "n_images": n_img,
        "n_gt_items": n_gt_items,
        "norm": "noprefix" if norm is norm_name_noprefix else "strict",
        "cer_name": ed_sum / max(ref_chars, 1),
        "field_accuracy": {f: field_hit[f] / nd for f in FIELDS},
        "field_accuracy_avg": sum(field_hit[f] for f in FIELDS) / (4 * nd),
        "exact_match_item": exact_items / nd,
        "exact_match_3field_macro": sum(full_recalls) / n_img,
        "complete_receipt_acc_3field": complete3 / n_img,
        "complete_receipt_acc_4field": complete4 / n_img,
        "name_f1_macro": sum(f1s) / n_img,
        "name_f1_summary_strict": data["summary"]["name_f1"],
        "avg_infer_sec": data.get("avg_infer_sec") or data["summary"].get("avg_infer_sec"),
    }


def rescore_2b(path: Path):
    data = json.loads(path.read_text(encoding="utf-8"))
    det = data["detail"]
    complete3 = sum(
        1 for r in det
        if r["scores"]["item_count_acc"] == 1 and r["scores"]["full_recall"] == 1.0
    )
    return {
        "n_images": len(det),
        "complete_receipt_acc_3field": complete3 / len(det),
        "name_f1": data["summary"]["name_f1"],
        "avg_infer_sec": data["summary"]["avg_infer_sec"],
        "note": "pred/gt 미보존 — CER·필드별 정확도·4필드 지표는 GPU 재실행 필요",
    }


def main():
    out = {
        "qwen35_0.8b_v2_llamacpp_q8": rescore_35(METRICS / "eval35_llamacpp.json"),
        "qwen35_0.8b_v2_transformers_bf16": rescore_35(METRICS / "eval35_ft_v2.json"),
        "qwen35_0.8b_base": rescore_35(METRICS / "eval35_base.json"),
        "qwen3_vl_2b_q4_1024": rescore_2b(METRICS / "eval_2b_q4_1024.json"),
    }
    # 바탕화면 5장 세트 (eval_desktop5*.py 산출물, pred/gt 포함 → 전 지표 가능).
    # 접두어 무시 정규화로 세 시스템(0.8B·2B·Gemini)을 같은 코드로 채점한다 —
    # Gemini가 "001 " 번호 접두어를 떼고 출력해 strict 채점은 표기 차이를 오답 처리함.
    for tag, key in (("35", "desktop5_qwen35_0.8b_v2"),
                     ("2b", "desktop5_qwen35_2b"),
                     ("gemini", "desktop5_gemini_api")):
        p = METRICS / f"eval_desktop5_{tag}.json"
        if p.exists():
            out[key] = rescore_35(p, norm=norm_name_noprefix)
    path = METRICS / "rescore_extended.json"
    path.write_text(json.dumps(out, ensure_ascii=False, indent=1), encoding="utf-8")
    print(json.dumps(out, ensure_ascii=False, indent=1))
    print(f"-> {path}")


if __name__ == "__main__":
    main()
