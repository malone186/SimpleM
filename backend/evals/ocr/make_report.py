#!/usr/bin/env python3
"""results.json → 발표용 결과 이미지(PNG).

HTML로 그린 뒤 Chrome(Playwright)으로 캡처한다 — matplotlib으로 표를 그리면 한글 폰트와
정렬을 일일이 맞춰야 하는데, 슬라이드에 넣을 표는 브라우저 렌더링이 훨씬 깔끔하다.

    python evals/ocr/make_report.py --out ~/Desktop/OCR_평가결과.png
"""
from __future__ import annotations

import argparse
import json
from pathlib import Path

HERE = Path(__file__).parent

# 6개 지표 정의 — (키, 표시명, 화살표, 소수 자리). 화살표는 '클수록 좋음/작을수록 좋음'.
METRICS = [
    ("f1", "F1-Score", "↑", 3),
    ("cer", "CER", "↓", 3),
    ("field_acc", "Field Accuracy", "↑", 3),
    ("exact", "Exact Match", "↑", 3),
    ("complete", "Complete Receipt", "↑", 3),
    ("sec_median", "Inference Time", "↓", 1),
]


def build_html(data: dict, gt: dict) -> str:
    results = data["results"]
    n_img = results[0].get("images", 5)
    repeat = results[0].get("repeat", 1)
    n_items = sum(len(r["items"]) for r in gt["receipts"])

    # 지표별 1등 찾기 (CER·시간은 최솟값이 1등)
    best = {}
    for key, _, arrow, _ in METRICS:
        vals = [r[key] for r in results]
        best[key] = min(vals) if arrow == "↓" else max(vals)

    head = "".join(
        f'<th>{name}<span class="arrow">{arrow}</span></th>' for _, name, arrow, _ in METRICS
    )
    rows = ""
    for r in results:
        prod = "gemini-3.1-flash-lite" in r["model"]
        cells = ""
        for key, _, _, nd in METRICS:
            v = r[key]
            txt = f"{v:.{nd}f}" + ("초" if key == "sec_median" else "")
            win = "win" if abs(v - best[key]) < 1e-9 else ""
            cells += f'<td class="num {win}">{txt}</td>'
        tag = '<span class="badge">운영 기본</span>' if prod else ""
        rows += f'<tr class="{"prod" if prod else ""}"><td class="model">{r["model"]}{tag}</td>{cells}</tr>'

    # 영수증별 난이도 (운영 모델 기준 F1)
    prod_r = next((r for r in results if "gemini-3.1-flash-lite" in r["model"]), results[0])
    per_img: dict[str, list] = {}
    for d in prod_r["detail"]:
        per_img.setdefault(d["label"], []).append(d["f1"])
    img_rows = "".join(
        f'<tr><td>{label}</td><td class="num">{sum(v)/len(v):.3f}</td></tr>'
        for label, v in per_img.items()
    )

    return f"""<meta charset="utf-8">
<style>
  * {{ box-sizing: border-box; }}
  body {{ margin: 0; padding: 40px 44px; width: 1280px;
         font-family: 'Pretendard','Apple SD Gothic Neo','Malgun Gothic',sans-serif;
         background: #FAF9F6; color: #2C1D14; }}
  h1 {{ font-size: 30px; margin: 0 0 6px; letter-spacing: -0.5px; }}
  .sub {{ font-size: 14.5px; color: #6B5B4E; margin-bottom: 24px; }}
  table {{ border-collapse: collapse; width: 100%; background: #fff; border-radius: 12px;
           overflow: hidden; box-shadow: 0 2px 10px rgba(78,54,41,.07); }}
  th, td {{ padding: 13px 12px; text-align: center; font-size: 14.5px;
            border-bottom: 1px solid #F0EBE4; }}
  th {{ background: #4E3629; color: #F6F1E8; font-weight: 600; font-size: 13.5px; }}
  .arrow {{ opacity: .65; margin-left: 3px; font-size: 11.5px; }}
  td.model {{ text-align: left; font-weight: 600; font-family: ui-monospace,Menlo,monospace;
              font-size: 13px; white-space: nowrap; }}
  td.num {{ font-variant-numeric: tabular-nums; }}
  tr.prod {{ background: #FFF8F0; }}
  .badge {{ display: inline-block; margin-left: 7px; padding: 2px 7px; border-radius: 9px;
            background: #E07A3A; color: #fff; font-size: 10.5px; font-weight: 700;
            font-family: 'Pretendard',sans-serif; }}
  .win {{ font-weight: 800; color: #C0532A; }}
  .grid {{ display: flex; gap: 20px; margin-top: 22px; }}
  .card {{ flex: 1; background: #fff; border-radius: 12px; padding: 16px 18px;
           box-shadow: 0 2px 10px rgba(78,54,41,.07); }}
  .card h3 {{ margin: 0 0 10px; font-size: 14px; color: #4E3629; }}
  .card table {{ box-shadow: none; border-radius: 0; }}
  .card td {{ padding: 7px 6px; font-size: 13px; text-align: left; }}
  .card td.num {{ text-align: right; font-weight: 700; }}
  .defs {{ font-size: 12.5px; line-height: 1.85; color: #5A4A3D; }}
  .defs b {{ color: #2C1D14; }}
  .ref {{ background: #F7F4EF; }}
  .warn {{ display: inline-block; margin-left: 5px; padding: 2px 6px; border-radius: 8px;
           background: #E8DFD2; color: #6B5B4E; font-size: 10px; font-weight: 700; }}
  .refnote {{ margin-top: 8px; font-size: 11px; line-height: 1.6; color: #7A6A5C; }}
  .note {{ margin-top: 20px; font-size: 12px; color: #7A6A5C; line-height: 1.7;
           border-top: 1px solid #E8E1D8; padding-top: 14px; }}
</style>
<h1>영수증 OCR 모델 정량 평가</h1>
<div class="sub">실제 영수증 <b>{n_img}장</b> · 정답 품목 <b>{n_items}개</b> · 모델당 <b>{repeat}회 반복</b> 측정 평균
&nbsp;|&nbsp; 정답은 사람이 직접 라벨링하고 금액 합계로 검산</div>

<table><thead><tr><th style="text-align:left">모델</th>{head}</tr></thead><tbody>{rows}</tbody></table>

<div class="grid">
  <div class="card">
    <h3>지표 정의</h3>
    <div class="defs">
      <b>F1-Score</b> 품목명 정밀도·재현율의 조화평균<br>
      <b>CER</b> 문자 오류율 — 편집거리 ÷ 정답 글자수<br>
      <b>Field Accuracy</b> 상호·발행일·합계·세액 등 문서 필드 정답률<br>
      <b>Exact Match</b> 이름+수량+금액이 통째로 맞은 품목 비율<br>
      <b>Complete Receipt</b> 한 장을 <b>한 군데도 안 고쳐도</b> 되는 비율<br>
      <b>Inference Time</b> 장당 처리 시간(중앙값)
    </div>
  </div>
  <div class="card">
    <h3>영수증별 난이도 (운영 모델 F1)</h3>
    <table><tbody>{img_rows}</tbody></table>
  </div>
  <div class="card ref">
    <h3>참고 · 자체 파인튜닝 모델 <span class="warn">다른 평가셋</span></h3>
    <table><tbody>
      <tr><td>Qwen3.5-0.8B 파인튜닝 전</td><td class="num">0.028</td></tr>
      <tr><td>Qwen3.5-0.8B 파인튜닝</td><td class="num">0.500</td></tr>
      <tr><td>Qwen3-VL-2B 파인튜닝</td><td class="num">0.666</td></tr>
    </tbody></table>
    <div class="refnote">실영수증 130장 기준 품목명 F1 (2026-07 아카이브).
    위 표(5장)와 <b>평가셋이 달라 직접 비교 불가</b> — 자체 모델을 접은 근거로만 인용.</div>
  </div>
</div>

<div class="note">
  측정: 운영과 동일한 OCR 경로(<code>app/services/ai/ocr_service.py</code>) 호출 · 채점 스크립트
  <code>backend/evals/ocr/score.py</code> · 정답 <code>ground_truth.json</code><br>
  Inference Time은 <b>중앙값</b> — 429·5xx 재시도(최대 3회)가 평균을 왜곡해서다.
  CER이 1을 넘는 경우는 모델이 정답보다 많은 품목을 뽑은 것(0원 옵션을 품목으로 셈).
</div>
"""


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--results", default=str(HERE / "results.json"))
    ap.add_argument("--gt", default=str(HERE / "ground_truth.json"))
    ap.add_argument("--out", default=str(Path.home() / "Desktop" / "OCR_평가결과.png"))
    args = ap.parse_args()

    data = json.loads(Path(args.results).read_text(encoding="utf-8"))
    gt = json.loads(Path(args.gt).read_text(encoding="utf-8"))
    html = build_html(data, gt)
    tmp = HERE / "_report.html"
    tmp.write_text(html, encoding="utf-8")

    from playwright.sync_api import sync_playwright
    with sync_playwright() as p:
        b = p.chromium.launch(channel="chrome")
        # 높이를 작게 잡고 full_page로 찍는다 — viewport가 크면 콘텐츠 아래 빈 여백까지 담긴다
        pg = b.new_page(viewport={"width": 1280, "height": 400}, device_scale_factor=2)
        pg.goto(tmp.resolve().as_uri())
        pg.wait_for_timeout(500)
        pg.screenshot(path=args.out, full_page=True)
        b.close()
    print(f"→ {args.out}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
