# -*- coding: utf-8 -*-
"""한국어 영수증/거래명세서 합성 데이터 생성기 (백엔드 B)

실제 영수증 레이아웃 4종을 고정폭 한글 폰트(굴림체/돋움체)로 렌더링하고
폰 촬영 노이즈(회전·원근·블러·JPEG 열화·배경)를 입혀 (이미지, 정답 JSON) 쌍을 만든다.
정답 JSON은 app/services/ai/vlm_prompt.py의 EXTRACTION_SCHEMA와 동일한 구조.

사용:
    python synth_gen.py --train 600 --val 60 --seed 42
출력:
    data/synth/images/{train,val}_NNNN.jpg
    data/synth/train.jsonl, data/synth/val.jsonl  (한 줄 = {"image": ..., "label": ...})
"""

import argparse
import io
import json
import random
import unicodedata
from datetime import datetime, timedelta
from pathlib import Path

from PIL import Image, ImageDraw, ImageEnhance, ImageFilter, ImageFont

OUT_DIR = Path(__file__).resolve().parent / "data" / "synth"

FONT_GULIMCHE = ("C:/Windows/Fonts/gulim.ttc", 1)   # 굴림체 (고정폭)
FONT_DOTUMCHE = ("C:/Windows/Fonts/gulim.ttc", 3)   # 돋움체 (고정폭)
FONT_MALGUN_BOLD = ("C:/Windows/Fonts/malgunbd.ttf", 0)

# ---------------------------------------------------------------------------
# 고정폭 정렬 유틸 — 한글은 2칸, ASCII는 1칸
# ---------------------------------------------------------------------------

def wlen(s: str) -> int:
    return sum(2 if unicodedata.east_asian_width(c) in "WF" else 1 for c in s)


def cut(s: str, width: int) -> str:
    """표시 폭 기준으로 자른다 (품목명이 칸을 넘칠 때)."""
    out, w = "", 0
    for c in s:
        cw = 2 if unicodedata.east_asian_width(c) in "WF" else 1
        if w + cw > width:
            break
        out += c
        w += cw
    return out


def pad(s: str, width: int, align: str = "l") -> str:
    s = cut(s, width)
    fill = width - wlen(s)
    if align == "r":
        return " " * fill + s
    if align == "c":
        left = fill // 2
        return " " * left + s + " " * (fill - left)
    return s + " " * fill


def won(v) -> str:
    return f"{int(v):,}"


# ---------------------------------------------------------------------------
# 데이터 풀
# ---------------------------------------------------------------------------

MART_ITEMS = [  # (이름, 최저가, 최고가, 면세여부주로)
    ("서울우유 1L", 2500, 3400, True), ("굿모닝우유 900ML", 1300, 2600, True),
    ("양파 1.5kg", 2000, 4500, True), ("무", 500, 2000, True), ("깻잎", 500, 1500, True),
    ("대파", 1500, 3500, True), ("청양고추 150g", 1200, 2800, True), ("브로커리", 1000, 2500, True),
    ("두부 300g", 900, 2200, True), ("콩나물 340g", 800, 1800, True), ("계란 30구", 5500, 8900, True),
    ("삼겹살 500g", 8900, 14900, True), ("닭가슴살 600g", 4900, 8900, True),
    ("신라면 5입", 3500, 4800, False), ("진라면 매운맛 5입", 3200, 4500, False),
    ("코카콜라 1.5L", 2400, 3600, False), ("칠성사이다 1.5L", 2200, 3200, False),
    ("삼다수 2L", 900, 1500, False), ("햇반 210g", 1000, 1900, False),
    ("오뚜기 케찹 500g", 2500, 3900, False), ("백설 설탕 1kg", 1900, 3200, False),
    ("포카칩 66g", 1300, 1900, False), ("초코파이 12입", 4200, 5900, False),
    ("하선정 장아찌 150g", 1300, 2500, False), ("종가집 김치 500g", 5900, 8900, False),
    ("바나나 1송이", 2900, 4900, True), ("사과 4입", 4900, 8900, True),
]

CONV_ITEMS = [
    ("참치마요 삼각김밥", 1100, 1500, False), ("전주비빔 삼각김밥", 1100, 1500, False),
    ("제육볶음 도시락", 4500, 5900, False), ("바나나맛우유", 1500, 1900, False),
    ("빙그레)바나나우유240", 1500, 1900, False), ("코카)콜라500ml", 2000, 2600, False),
    ("마늘빅프랑크", 1800, 2500, False), ("틈새라면 컵", 1500, 2200, False),
    ("라라스윗)바닐라파인트474", 5900, 7900, False), ("라라스윗)초코파인트474ml", 5900, 7900, False),
    ("서울)비엔나소세지", 2800, 3900, False), ("남양)프렌치카페컵", 1800, 2500, False),
    ("롯데)의성마늘햄", 3200, 4500, False), ("농심)새우깡90g", 1300, 1700, False),
    ("해태)맛동산155g", 1900, 2500, False), ("동원)덴마크우유500", 1900, 2700, False),
    ("풀무원)찌개두부", 1900, 2800, False), ("CJ)햇반흑미밥", 1400, 2100, False),
    ("예거라들러레몬", 2900, 3900, False), ("마운틴블러스트500", 1900, 2500, False),
    ("비닐봉투 보증금", 20, 100, False),
]

REST_ITEMS = [
    ("생삼겹살", 7000, 15000), ("목살", 8000, 15000), ("항정살", 12000, 18000),
    ("김치찌개", 7000, 9000), ("된장찌개", 7000, 9000), ("공기밥", 1000, 2000),
    ("밥+된장", 2000, 3000), ("냉면", 5000, 9000), ("소주", 4000, 6000),
    ("맥주", 3000, 6000), ("음료수", 1000, 3000), ("계란찜", 3000, 5000),
    ("주먹밥", 2000, 4000), ("라면사리", 1000, 2000), ("숯불향 닭갈비", 9000, 13000),
]

CAFE_ITEMS = [
    ("아메리카노 (ICE)", 2500, 5000), ("아메리카노 (HOT)", 2500, 4500),
    ("카페라떼", 3500, 5500), ("바닐라라떼", 4000, 6000), ("카푸치노", 3500, 5500),
    ("콜드브루", 4000, 6000), ("자몽에이드", 4500, 6500), ("레몬에이드", 4500, 6500),
    ("녹차라떼", 4000, 6000), ("초코라떼", 4000, 6000), ("딸기스무디", 5000, 7000),
    ("플레인베이글", 3000, 4500), ("크루아상", 3500, 5000), ("치즈케이크", 5500, 7500),
    ("샷 추가", 500, 700), ("휘핑 추가", 500, 1000),
]

STATEMENT_ITEMS = [  # (이름, 규격, 단위, 최저단가, 최고단가) — 카페 식자재 발주
    ("에스프레소 원두", "1kg", "EA", 18000, 35000), ("디카페인 원두", "500g", "EA", 15000, 25000),
    ("멸균우유", "1L", "EA", 1800, 2800), ("바리스타 우유", "1L", "BOX", 22000, 33000),
    ("바닐라 시럽", "750ml", "EA", 8000, 14000), ("헤이즐넛 시럽", "750ml", "EA", 8000, 14000),
    ("초코 파우더", "1kg", "EA", 9000, 16000), ("녹차 파우더", "500g", "EA", 12000, 22000),
    ("휘핑크림", "500ml", "EA", 4500, 8000), ("연유", "500g", "EA", 4000, 7000),
    ("아이스컵 92파이", "50입", "줄", 3500, 6500), ("핫컵 13온스", "50입", "줄", 4000, 7000),
    ("컵뚜껑 92파이", "50입", "줄", 2500, 4500), ("빨대 21cm", "500입", "BOX", 5000, 9000),
    ("냅킨", "1000매", "BOX", 8000, 15000), ("캐리어 2구", "100입", "BOX", 12000, 20000),
    ("자몽청", "1kg", "EA", 9000, 15000), ("레몬청", "1kg", "EA", 9000, 15000),
    ("타피오카 펄", "3kg", "EA", 12000, 20000), ("크림치즈", "1.36kg", "EA", 14000, 22000),
    ("베이글 생지", "12입", "BOX", 15000, 25000), ("크루아상 생지", "20입", "BOX", 18000, 30000),
]

REGIONS = ["서울특별시 송파구", "서울특별시 마포구", "경기 의정부시", "경기 용인시 처인구",
           "경기 수원시 팔달구", "인천 남동구", "부산 해운대구", "대전 서구", "경북 경주시", "전북 전주시"]
ROADS = ["중앙로", "동남로 8길", "전대로 78번길", "문화로", "시장길", "번영로", "테헤란로", "공단로"]
NAMES = ["김민수", "박지훈", "이서연", "최영호", "정다은", "임부옥", "한상철", "오수진", "최경호", "강동원"]

MART_BRANDS = ["농협 하나로마트", "탑마트", "식자재왕마트", "그린마트", "행복마트", "홈플러스 익스프레스"]
CONV_BRANDS = ["GS25", "CU", "세븐일레븐", "이마트24"]
REST_BRANDS = ["한돈당", "돼지익는마을", "청기와숯불갈비", "전주밥상", "김밥천국", "온기족발", "바다횟집"]
CAFE_BRANDS = ["카페 온도", "커피볶는집", "달빛로스터리", "빈브라더스", "모모카페", "어반그라인드"]
SUPPLIERS = ["누리식자재유통", "한결상사", "대명F&B", "커피플랜트", "제일종합식품", "우성유통", "동방식자재마트"]
BRANCH = ["중앙점", "역전점", "문정점", "포곡골든점", "시청점", "대학로점", "터미널점", "본점", "수정점"]


def rand_biz(rng) -> str:
    return f"{rng.randint(100, 899)}-{rng.randint(10, 99)}-{rng.randint(10000, 99999)}"


def rand_phone(rng) -> str:
    area = rng.choice(["02", "031", "032", "051", "042", "054", "063", "070"])
    return f"{area}-{rng.randint(200, 999)}-{rng.randint(1000, 9999)}"


def rand_date(rng) -> datetime:
    start = datetime(2019, 1, 1)
    return start + timedelta(days=rng.randint(0, 2700), hours=rng.randint(8, 22), minutes=rng.randint(0, 59))


def date_variants(dt: datetime, rng) -> str:
    yoil = "월화수목금토일"[dt.weekday()]
    return rng.choice([
        dt.strftime("%Y-%m-%d %H:%M"),
        dt.strftime("%Y/%m/%d %H:%M:%S"),
        dt.strftime(f"[판 매] %Y-%m-%d ({yoil}) %H:%M:%S"),
        dt.strftime("%Y년 %m월 %d일 %H:%M"),
        dt.strftime("판매일시:%Y-%m-%d %H:%M"),
    ])


def empty_item(name, spec=None, quantity=None, unit=None, unit_price=None, amount=None):
    return {"name": name, "spec": spec, "quantity": quantity, "unit": unit,
            "unit_price": unit_price, "amount": amount}


# ---------------------------------------------------------------------------
# 템플릿 — 각각 (lines, label) 반환. lines 항목: (text, style)
#   style: "h"=대형 헤더, "b"=본문, "s"=소형, "-"=구분선
# ---------------------------------------------------------------------------

W = 42  # 본문 표시 폭 (칸)


def sep(rng):
    return (rng.choice(["-", "=", "*"]) * W, "-")


def _mask(s: str, rng) -> str:
    """전화/사업자번호 일부를 *로 가린다 (실영수증의 개인정보 마스킹 재현)."""
    parts = s.split("-")
    idx = rng.randrange(1, len(parts))
    parts[idx] = "*" * len(parts[idx])
    return "-".join(parts)


def tpl_mart(rng, conv=False):
    """마트/편의점 POS 영수증."""
    if conv:
        brand = rng.choice(CONV_BRANDS)
        store = brand + rng.choice(BRANCH)
        pool = CONV_ITEMS
    else:
        brand = rng.choice(MART_BRANDS)
        store = brand + " " + rng.choice(BRANCH)
        pool = MART_ITEMS

    biz, phone, owner = rand_biz(rng), rand_phone(rng), rng.choice(NAMES)
    masked = rng.random() < 0.18
    dt = rand_date(rng)
    addr = f"{rng.choice(REGIONS)} {rng.choice(ROADS)} {rng.randint(1, 120)}"

    n_items = rng.randint(2, 8)
    chosen = rng.sample(pool, min(n_items, len(pool)))
    has_unit_price = rng.random() < 0.5      # 단가 열 유무
    with_index = rng.random() < 0.45         # 001, 002 행번호
    with_barcode = rng.random() < 0.4        # 품목 밑 바코드 줄
    p_prefix = (not conv) and rng.random() < 0.3

    name_w = 18 if has_unit_price else 24
    items, gt_items = [], []
    for i, (name, lo, hi, tax_free) in enumerate(chosen, 1):
        price = rng.randrange(lo, hi + 1, 10)
        qty = rng.choices([1, 1, 1, 2, 3], k=1)[0]
        amount = price * qty
        items.append((name, price, qty, amount, tax_free))
        # 정답 품목명은 '이미지에 실제로 렌더링된' 텍스트와 일치해야 한다
        # (열 폭에 잘린 이름을 전체 이름으로 라벨링하면 모델이 없는 글자를 지어내게 됨)
        prefix = f"{i:03d} " if with_index else ""
        disp = cut(prefix + ("P" if p_prefix else "") + name, name_w)[len(prefix):].strip()
        gt_items.append(empty_item(disp, quantity=qty,
                                   unit_price=price if has_unit_price else None, amount=amount))

    gross = sum(a for _, _, _, a, _ in items)
    discount = None
    if rng.random() < 0.3:
        discount = rng.randrange(100, max(200, int(gross * 0.1)), 10)
    total = gross - (discount or 0)
    taxable = sum(a for _, _, _, a, tf in items if not tf) - (discount or 0)
    taxable = max(taxable, 0)
    tax_free_sum = sum(a for _, _, _, a, tf in items if tf)
    subtotal = round(taxable / 1.1) if taxable else None
    tax = taxable - subtotal if taxable else None

    lines = [(pad(store if conv else brand, W, "c"), "h")]
    if not conv:
        lines.append((pad(rng.choice(BRANCH), W, "c"), "b"))
    lines += [
        (f"주소:{addr}", "s"),
        (f"대표:{owner}  사업자:{_mask(biz, rng) if masked else biz}", "s"),
        (f"전화:{_mask(phone, rng) if masked else phone}", "s"),
        (date_variants(dt, rng) + f"  NO:{rng.randint(1000, 99999)}", "s"),
        sep(rng),
    ]
    if has_unit_price:
        lines.append((pad("상품명", 18) + pad("단가", 8, "r") + pad("수량", 5, "r") + pad("금액", 10, "r"), "b"))
    else:
        lines.append((pad("상 품 명", 24) + pad("수량", 6, "r") + pad("금 액", 11, "r"), "b"))
    lines.append(sep(rng))

    for i, (name, price, qty, amount, _) in enumerate(items, 1):
        disp = ("P" if p_prefix else "") + name
        prefix = f"{i:03d} " if with_index else ""
        if has_unit_price:
            row = pad(prefix + disp, name_w) + pad(won(price), 8, "r") + pad(str(qty), 5, "r") + pad(won(amount), 10, "r")
        else:
            row = pad(prefix + disp, name_w) + pad(str(qty), 6, "r") + pad(won(amount), 11, "r")
        lines.append((row, "b"))
        if with_barcode and rng.random() < 0.7:
            lines.append((f" {'*' if rng.random() < 0.3 else ''}{rng.randint(8800000000000, 8809999999999)}", "s"))

    if rng.random() < 0.4:
        lines.append((pad("합계수량/금액", 20) + pad(str(sum(q for _, _, q, _, _ in items)), 6, "r")
                      + pad(won(gross), 15, "r"), "b"))
    if discount:
        lines.append((pad(rng.choice(["판촉/팝 할인", "쿠폰할인", "멤버십 할인", "행사할인"]), 26)
                      + pad(f"-{won(discount)}", 15, "r"), "b"))
    lines.append(sep(rng))
    if tax_free_sum and rng.random() < 0.8:
        lines.append((pad("면세물품가액", 26) + pad(won(tax_free_sum), 15, "r"), "b"))
    if subtotal:
        lines.append((pad(rng.choice(["과세물품가액", "과세 매출"]), 26) + pad(won(subtotal), 15, "r"), "b"))
        lines.append((pad(rng.choice(["부 가 세", "부가세"]), 26) + pad(won(tax), 15, "r"), "b"))
    lines.append((pad(rng.choice(["합       계", "받을금액", "합계금액"]), 24) + pad("W" + won(total), 17, "r"), "h"))
    pay = rng.choice(["신용카드", "현금", "카카오페이"])
    lines.append((pad(pay, 26) + pad(won(total), 15, "r"), "b"))
    if pay == "신용카드":
        lines.append((f"카드번호:{rng.randint(9000, 9999)}-{rng.randint(10, 99)}**-****-{rng.randint(1000, 9999)}", "s"))
        lines.append((f"승인번호:{rng.randint(10000000, 99999999)}  할부:일시불", "s"))
    if rng.random() < 0.4:
        lines.append(sep(rng))
        lines.append((f"적립포인트: {rng.randint(5, 500)}점  누적: {won(rng.randint(1000, 99000))}점", "s"))
    lines.append((pad(rng.choice(["좋은 하루 되세요!", "감사합니다. 또 오세요", "* 교환/환불은 영수증 지참 *"]), W, "c"), "s"))

    label = {
        "doc_type": "receipt",
        "vendor": {"name": store, "biz_no": None if masked else biz, "phone": None if masked else phone},
        "issued_date": dt.strftime("%Y-%m-%d"),
        "items": gt_items,
        "discount": discount,
        "subtotal": subtotal,
        "tax": tax,
        "total": total,
    }
    return lines, label


def tpl_restaurant(rng):
    """음식점 계산서/중간계산서."""
    store = rng.choice(REST_BRANDS)
    biz, phone, owner = rand_biz(rng), rand_phone(rng), rng.choice(NAMES)
    dt = rand_date(rng)
    addr = f"{rng.choice(REGIONS)} {rng.choice(ROADS)} {rng.randint(1, 200)}"

    chosen = rng.sample(REST_ITEMS, rng.randint(2, 6))
    items, gt_items = [], []
    for name, lo, hi in chosen:
        price = rng.randrange(lo, hi + 1, 500)
        qty = rng.randint(1, 25) if price < 3000 else rng.randint(1, 6)
        items.append((name, price, qty, price * qty))
        gt_items.append(empty_item(cut(name, 16).strip(), quantity=qty, unit_price=price, amount=price * qty))
    total = sum(a for _, _, _, a in items)
    with_vat = rng.random() < 0.3
    subtotal = round(total / 1.1) if with_vat else None
    tax = total - subtotal if with_vat else None

    title = rng.choice(["[ 영 수 증 ]", "[ 중간계산서 ]", "[ 계 산 서 ]"])
    lines = [
        (pad(title, W, "c"), "h"),
        ("", "s"),
        (pad(store, W // 2) + pad(f"TEL: {phone}", W // 2, "r"), "b"),
        (f"{biz}  대표:{owner}", "s"),
        (addr, "s"),
        (f"테이블 : [{rng.choice(['홀', '룸1', '룸2', '테라스'])}] {rng.randint(1, 40)}", "b"),
        sep(rng),
        (pad("메뉴", 16) + pad("단가", 8, "r") + pad("수량", 5, "r") + pad("금액", 12, "r"), "b"),
        sep(rng),
    ]
    for name, price, qty, amount in items:
        lines.append((pad(name, 16) + pad(won(price), 8, "r") + pad(str(qty), 5, "r") + pad(won(amount), 12, "r"), "b"))
    lines.append(sep(rng))
    if with_vat:
        lines.append((pad("공급가액", 24) + pad(won(subtotal), 17, "r"), "b"))
        lines.append((pad("부가세", 24) + pad(won(tax), 17, "r"), "b"))
    lines.append((pad("합    계 :", 20) + pad(won(total), 21, "r"), "h"))
    lines.append((pad("받을금액 :", 20) + pad(won(total), 21, "r"), "b"))
    if rng.random() < 0.5:
        lines.append((pad("받은금액 :", 20) + pad("0", 21, "r"), "b"))
    lines.append(sep(rng))
    lines.append((pad(dt.strftime("%Y/%m/%d %H:%M"), W, "r"), "s"))
    lines.append((f"고객수 : {rng.randint(0, 8)}", "s"))

    label = {
        "doc_type": "receipt",
        "vendor": {"name": store, "biz_no": biz, "phone": phone},
        "issued_date": dt.strftime("%Y-%m-%d"),
        "items": gt_items,
        "discount": None,
        "subtotal": subtotal,
        "tax": tax,
        "total": total,
    }
    return lines, label


def tpl_cafe(rng):
    """카페 POS 영수증."""
    store = rng.choice(CAFE_BRANDS) + " " + rng.choice(BRANCH)
    biz, phone = rand_biz(rng), rand_phone(rng)
    dt = rand_date(rng)

    chosen = rng.sample(CAFE_ITEMS, rng.randint(1, 5))
    items, gt_items = [], []
    for name, lo, hi in chosen:
        price = rng.randrange(lo, hi + 1, 100)
        qty = rng.randint(1, 3)
        items.append((name, price, qty, price * qty))
        gt_items.append(empty_item(cut(name, 20).strip(), quantity=qty, unit_price=price, amount=price * qty))
    gross = sum(a for _, _, _, a in items)
    discount = rng.randrange(300, max(500, int(gross * 0.15)), 100) if rng.random() < 0.25 else None
    total = gross - (discount or 0)
    subtotal = round(total / 1.1)
    tax = total - subtotal

    lines = [
        (pad(store, W, "c"), "h"),
        (f"사업자:{biz}  T.{phone}", "s"),
        (f"주문번호 {rng.randint(1, 99)}  {date_variants(dt, rng)}", "s"),
        sep(rng),
        (pad("메뉴명", 20) + pad("단가", 7, "r") + pad("수량", 4, "r") + pad("금액", 10, "r"), "b"),
        sep(rng),
    ]
    for name, price, qty, amount in items:
        lines.append((pad(name, 20) + pad(won(price), 7, "r") + pad(str(qty), 4, "r") + pad(won(amount), 10, "r"), "b"))
    if discount:
        lines.append((pad("멤버십 할인", 24) + pad(f"-{won(discount)}", 17, "r"), "b"))
    lines.append(sep(rng))
    lines.append((pad("공급가액", 24) + pad(won(subtotal), 17, "r"), "b"))
    lines.append((pad("부가세", 24) + pad(won(tax), 17, "r"), "b"))
    lines.append((pad("합계금액", 20) + pad(won(total), 21, "r"), "h"))
    lines.append((pad(rng.choice(["신용카드", "현금", "간편결제"]), 24) + pad(won(total), 17, "r"), "b"))
    lines.append((pad("* WIFI: " + store.replace(" ", "") + " *", W, "c"), "s"))

    label = {
        "doc_type": "receipt",
        "vendor": {"name": store, "biz_no": biz, "phone": phone},
        "issued_date": dt.strftime("%Y-%m-%d"),
        "items": gt_items,
        "discount": discount,
        "subtotal": subtotal,
        "tax": tax,
        "total": total,
    }
    return lines, label


def tpl_statement(rng):
    """거래명세서 — 식자재 납품 (카페 입고의 핵심 케이스)."""
    supplier = rng.choice(SUPPLIERS)
    buyer = rng.choice(CAFE_BRANDS) + " " + rng.choice(BRANCH)
    biz, phone, owner = rand_biz(rng), rand_phone(rng), rng.choice(NAMES)
    dt = rand_date(rng)
    addr = f"{rng.choice(REGIONS)} {rng.choice(ROADS)} {rng.randint(1, 99)}"

    chosen = rng.sample(STATEMENT_ITEMS, rng.randint(3, 9))
    items, gt_items = [], []
    for name, spec, unit, lo, hi in chosen:
        price = rng.randrange(lo, hi + 1, 100)
        qty = rng.randint(1, 10)
        amount = price * qty
        items.append((name, spec, qty, unit, price, amount))
        gt_items.append(empty_item(cut(name, 15).strip(), spec=cut(spec, 6).strip(), quantity=qty,
                                   unit=unit, unit_price=price, amount=amount))
    supply = sum(a for *_, a in items)
    tax = round(supply * 0.1)
    total = supply + tax

    lines = [
        (pad(rng.choice(["거 래 명 세 서", "거래명세표", "납 품 서"]), W, "c"), "h"),
        ("", "s"),
        (pad(f"공급자: {supplier}", W // 2) + pad(f"등록번호: {biz}", W // 2, "r"), "s"),
        (pad(f"대표자: {owner}", W // 2) + pad(f"TEL: {phone}", W // 2, "r"), "s"),
        (f"주소: {addr}", "s"),
        (f"공급받는자: {buyer}   귀하", "b"),
        (f"거래일자: {dt.strftime('%Y-%m-%d')}", "b"),
        sep(rng),
        (pad("품목", 15) + pad("규격", 6) + pad("수량", 3, "r") + pad("단위", 3, "r") + pad("단가", 7, "r") + pad("금액", 8, "r"), "b"),
        sep(rng),
    ]
    for name, spec, qty, unit, price, amount in items:
        lines.append((pad(name, 15) + pad(spec, 6) + pad(str(qty), 3, "r") + pad(unit, 3, "r")
                      + pad(won(price), 7, "r") + pad(won(amount), 8, "r"), "b"))
    lines.append(sep(rng))
    lines.append((pad("공급가액 계", 24) + pad(won(supply), 17, "r"), "b"))
    lines.append((pad("세액(부가세)", 24) + pad(won(tax), 17, "r"), "b"))
    lines.append((pad("합계금액", 20) + pad(won(total), 21, "r"), "h"))
    lines.append((pad(rng.choice(["인수자: ________ (인)", "위와 같이 납품합니다.", "인수 확인: ________"]), W, "r"), "s"))

    label = {
        "doc_type": "purchase_statement",
        "vendor": {"name": supplier, "biz_no": biz, "phone": phone},
        "issued_date": dt.strftime("%Y-%m-%d"),
        "items": gt_items,
        "discount": None,
        "subtotal": supply,
        "tax": tax,
        "total": total,
    }
    return lines, label


# ---------------------------------------------------------------------------
# 렌더링 + 증강
# ---------------------------------------------------------------------------

def render(lines, rng) -> Image.Image:
    body_px = rng.choice([16, 18, 20])
    font_path, font_idx = rng.choice([FONT_GULIMCHE, FONT_DOTUMCHE])
    f_body = ImageFont.truetype(font_path, body_px, index=font_idx)
    f_small = ImageFont.truetype(font_path, body_px - 2, index=font_idx)
    f_head = ImageFont.truetype(FONT_MALGUN_BOLD[0], body_px + 6)

    char_w = body_px // 2  # 고정폭: ASCII 1칸 폭
    width = W * char_w + 40
    line_h = {"h": body_px + 12, "b": body_px + 6, "s": body_px + 3, "-": body_px + 4}
    height = sum(line_h[st] for _, st in lines) + 60

    ink = rng.randint(20, 90)  # 감열지 인쇄 농도
    paper = rng.randint(240, 255)
    img = Image.new("RGB", (width, height), (paper, paper, paper - rng.randint(0, 8)))
    draw = ImageDraw.Draw(img)

    y = 30
    for text, style in lines:
        font = {"h": f_head, "b": f_body, "s": f_small, "-": f_body}[style]
        if style == "h":
            tw = draw.textlength(text.strip(), font=font)
            if tw > width - 30:  # 대형 폰트가 폭을 넘치면 본문 크기로 낮춘다 (숫자 잘림 방지)
                font = f_body
                tw = draw.textlength(text.strip(), font=font)
            draw.text(((width - tw) // 2, y), text.strip(), fill=(ink, ink, ink), font=font)
        else:
            draw.text((20, y), text, fill=(ink, ink, ink), font=font)
        y += line_h[style]
    return img


def augment(img: Image.Image, rng) -> Image.Image:
    """폰 촬영 재현: 회전·원근·배경·조명·블러·노이즈·JPEG 열화."""
    paper = img.getpixel((5, 5))

    # 살짝 회전
    if rng.random() < 0.8:
        img = img.rotate(rng.uniform(-2.5, 2.5), expand=True, fillcolor=paper, resample=Image.BICUBIC)

    # 원근 왜곡 (미세)
    if rng.random() < 0.5:
        w, h = img.size
        dx = [int(rng.uniform(0, 0.03) * w) for _ in range(4)]
        img = img.transform(
            (w, h), Image.QUAD,
            (dx[0], 0, 0, h - dx[1], w - dx[2], h, w, dx[3]),
            resample=Image.BICUBIC, fillcolor=paper,
        )

    # 배경 (책상/테이블)
    bg_color = rng.choice([(180, 140, 100), (200, 200, 205), (120, 90, 60), (230, 225, 215), (90, 90, 95)])
    margin = rng.randint(15, 70)
    bg = Image.new("RGB", (img.width + margin * 2, img.height + margin * 2), bg_color)
    bg.paste(img, (margin, margin))
    img = bg

    img = ImageEnhance.Brightness(img).enhance(rng.uniform(0.72, 1.15))
    img = ImageEnhance.Contrast(img).enhance(rng.uniform(0.8, 1.2))
    if rng.random() < 0.6:
        img = img.filter(ImageFilter.GaussianBlur(rng.uniform(0.2, 0.9)))

    # JPEG 열화
    buf = io.BytesIO()
    img.save(buf, "JPEG", quality=rng.randint(45, 90))
    return Image.open(io.BytesIO(buf.getvalue())).convert("RGB")


TEMPLATES = [
    (lambda r: tpl_mart(r, conv=False), 0.25),
    (lambda r: tpl_mart(r, conv=True), 0.20),
    (tpl_restaurant, 0.15),
    (tpl_cafe, 0.10),
    (tpl_statement, 0.30),
]


def generate_split(name: str, count: int, rng) -> None:
    img_dir = OUT_DIR / "images"
    img_dir.mkdir(parents=True, exist_ok=True)
    rows = []
    fns = [t for t, _ in TEMPLATES]
    weights = [w for _, w in TEMPLATES]
    for i in range(count):
        tpl = rng.choices(fns, weights=weights, k=1)[0]
        lines, label = tpl(rng)
        img = augment(render(lines, rng), rng)
        fname = f"{name}_{i:04d}.jpg"
        img.save(img_dir / fname, "JPEG", quality=92)
        rows.append(json.dumps({"image": f"images/{fname}", "label": label}, ensure_ascii=False))
        if (i + 1) % 50 == 0:
            print(f"  {name}: {i + 1}/{count}")
    (OUT_DIR / f"{name}.jsonl").write_text("\n".join(rows) + "\n", encoding="utf-8")
    print(f"{name} 완료: {count}건 -> {OUT_DIR / (name + '.jsonl')}")


if __name__ == "__main__":
    ap = argparse.ArgumentParser()
    ap.add_argument("--train", type=int, default=600)
    ap.add_argument("--val", type=int, default=60)
    ap.add_argument("--seed", type=int, default=42)
    args = ap.parse_args()

    rng = random.Random(args.seed)
    generate_split("train", args.train, rng)
    generate_split("val", args.val, rng)
