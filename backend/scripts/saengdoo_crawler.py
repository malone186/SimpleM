"""생두모아(saengdoo-moa.com) 원두 크롤러 → 기존 원두 시드 로더용 CSV.

목록 페이지(/?page=N)의 카드 패널에서 이름·가격·원산지·판매처를 뽑고(--details 옵션 시
각 상세페이지에서 정확한 가공/품종 + 실제 판매처 '바로가기' 구매링크까지 보강),
seed_service.import_beans_from_csv 가 그대로 먹는 CSV로 저장한다.

    # 크롤 (목록만, 빠름)
    python scripts/saengdoo_crawler.py --out scripts/data/saengdoo_beans.csv
    # 크롤 (상세까지 — 가공/품종/구매링크 보강, ~1,100 요청)
    python scripts/saengdoo_crawler.py --details --out scripts/data/saengdoo_beans.csv
    # DB 적재 (기존 로더 재사용)
    python scripts/import_seed_beans.py --file scripts/data/saengdoo_beans.csv

주의: 생두모아는 여러 판매처를 모은 애그리게이터다. 수집 데이터는 내부 참고용으로만 쓰고
출처(product_url = 판매처 스토어)를 유지한다. 요청 간 딜레이로 예의 있게 크롤한다.
"""
import argparse
import csv
import html
import re
import sys
import time
import urllib.request

UA = "Mozilla/5.0 (compatible; BrewNoteResearch/0.1)"
BASE = "https://saengdoo-moa.com"
COLS = ["id", "name", "price", "roastery", "country", "process",
        "product_url", "description", "blend", "decaf", "gesha", "price_per_gram"]

CARD = re.compile(r'<a\b[^>]*href="/products/(\d+)[^"]*"[^>]*>(.*?)</a>', re.DOTALL)
_PROC = [("내추럴", "내추럴"), ("natural", "내추럴"), ("워시드", "워시드"), ("washed", "워시드"),
         ("허니", "허니"), ("honey", "허니"), ("무산소", "무산소발효"), ("anaerobic", "무산소발효")]


def _get(url):
    req = urllib.request.Request(url, headers={"User-Agent": UA})
    with urllib.request.urlopen(req, timeout=30) as r:
        return r.read().decode("utf-8", "replace")


def _flat(s):
    return html.unescape(re.sub(r"\s+", " ", re.sub(r"<[^>]+>", " ",
                         re.sub(r"<script.*?</script>", " ", s, flags=re.DOTALL)))).strip()


def _infer_process(name):
    low = name.lower()
    for kw, canon in _PROC:
        if kw in low:
            return canon
    return ""


def _has(name, kws):
    low = name.lower()
    return any(k in low for k in kws)


def parse_list_page(h):
    """카드 패널만(카드뷰+표뷰 중복 방지) 파싱해 상품 기본 정보 추출."""
    ci, ti = h.find('data-view-panel="card"'), h.find('data-view-panel="table"')
    if ci != -1:
        h = h[ci:(ti if ti > ci else len(h))]
    rows, seen = [], set()
    for pid, body in CARD.findall(h):
        b = _flat(body)
        pm = re.search(r"([\d,]+)\s*원/kg", b)
        if not pm:
            continue
        price = int(pm.group(1).replace(",", ""))
        om = re.match(r"([가-힣A-Za-z]+)\s", b)
        origin = om.group(1) if om else ""
        nm = re.search(r"^\s*" + (re.escape(origin) + r"\s+" if origin else "") + r"(.+?)\s*" + re.escape(pm.group(1)) + r"\s*원/kg", b)
        name = nm.group(1).strip() if nm else ""
        sm = re.search(r"최저가\s*·\s*([가-힣A-Za-z0-9()]+)", b)
        if not name or name in seen:
            continue
        seen.add(name)
        rows.append({
            "id": pid, "name": name, "price": price,
            "roastery": (sm.group(1) if sm else "생두모아"), "country": origin,
            "process": _infer_process(name),
            "product_url": f"{BASE}/products/{pid}", "description": "",
            "blend": _has(name, ["블렌드", "블랜드", "blend"]),
            "decaf": _has(name, ["디카페인", "디카프", "decaf"]),
            "gesha": _has(name, ["게이샤", "게샤", "geisha", "gesha"]),
            "price_per_gram": round(price / 1000.0, 2),
        })
    return rows


def enrich_from_detail(row):
    """상세페이지에서 정확한 가공/품종 + 판매처 '바로가기' 구매링크로 보강."""
    h = _get(f"{BASE}/products/{row['id']}")
    t = _flat(h)

    def g(p):
        m = re.search(p, t)
        v = m.group(1).strip() if m else ""
        return "" if "정보 없음" in v else v
    process = g(r"가공\s+(.+?)\s+품종")
    variety = g(r"품종\s+(.+?)\s+(?:농장|원산지·가공|$)")
    origin = g(r"원산지\s+(.+?)\s+가공")
    if process:
        row["process"] = process
    if origin and not row.get("country"):
        row["country"] = origin
    if variety:
        row["description"] = f"품종: {variety}"
    m = re.search(r'href="(https?://(?!(?:[^"]*saengdoo-moa\.com|fonts\.))[^"]+)"[^>]*>\s*바로가기', h)
    if m:
        row["product_url"] = m.group(1)  # 실제 판매처 구매링크 우선
    return row


def main():
    ap = argparse.ArgumentParser(description="생두모아 원두 크롤러")
    ap.add_argument("--out", default="scripts/data/saengdoo_beans.csv")
    ap.add_argument("--details", action="store_true", help="상세페이지까지 긁어 가공/품종/구매링크 보강")
    ap.add_argument("--max-pages", type=int, default=30)
    ap.add_argument("--delay", type=float, default=0.5)
    args = ap.parse_args()

    seen, rows = set(), []
    for p in range(1, args.max_pages + 1):
        try:
            page_rows = parse_list_page(_get(f"{BASE}/?page={p}"))
        except Exception as e:
            print(f"page {p} 오류: {e}", file=sys.stderr)
            continue
        fresh = [r for r in page_rows if r["name"] not in seen]
        for r in fresh:
            seen.add(r["name"])
        rows.extend(fresh)
        print(f"page {p}: +{len(fresh)} (누적 {len(rows)})", file=sys.stderr)
        if not fresh:
            break
        time.sleep(args.delay)

    if args.details:
        for i, r in enumerate(rows):
            try:
                enrich_from_detail(r)
            except Exception as e:
                print(f"  상세 실패 id={r['id']}: {e}", file=sys.stderr)
            if (i + 1) % 100 == 0:
                print(f"상세 {i+1}/{len(rows)}", file=sys.stderr)
            time.sleep(args.delay)

    with open(args.out, "w", encoding="utf-8-sig", newline="") as f:
        w = csv.DictWriter(f, fieldnames=COLS)
        w.writeheader()
        w.writerows(rows)
    print(f"\n총 {len(rows)}개 → {args.out}")


if __name__ == "__main__":
    main()
