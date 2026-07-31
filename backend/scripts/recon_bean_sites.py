"""원두 사이트 정찰 스크립트 — 크롤링 가능 여부 확인 + 샘플 HTML 저장

[한글 주석] 왜 이 단계가 필요한가:
  1) robots.txt 확인 — 사이트가 크롤링을 허용하는지 먼저 본다. 이걸 건너뛰면
     약관 위반이 될 수 있고, 실제로 차단당하면 수집기가 통째로 무용지물이 된다.
  2) 샘플 HTML 저장 — 사이트마다 구조가 완전히 달라서, 실제 HTML을 봐야
     파서를 정확히 짤 수 있다. 구조를 모른 채 짠 파서는 반드시 빗나간다.

사용법:
    python scripts/recon_bean_sites.py                 # 기본 목록 정찰
    python scripts/recon_bean_sites.py <URL> <URL> ... # 특정 URL 정찰

결과는 scripts/_recon/ 폴더에 저장된다.
"""
import os
import sys
import time
import urllib.parse
import urllib.request
import urllib.robotparser

# [한글 주석] 한국어 Windows 콘솔(cp949)에서 출력이 깨지거나 죽지 않도록 UTF-8로 강제한다.
try:
    sys.stdout.reconfigure(encoding='utf-8', errors='replace')
except Exception:
    pass

OUT_DIR = os.path.join(os.path.dirname(os.path.abspath(__file__)), "_recon")

# 예의를 갖춘 User-Agent — 정체를 숨기지 않는다.
UA = "SimpleM-BrewNote/1.0 (bean price research; contact: admin@simplem.com)"

# [한글 주석] 정찰 대상. 사장님이 알려주신 사이트의 '상품 목록' 또는 '상품 상세' URL을 넣으면 된다.
# 여기 URL은 예시이며, 실제 주소로 교체해야 한다.
DEFAULT_TARGETS = [
    # "https://<코케비즈 주소>/상품목록페이지",
    # "https://<생두모아 주소>/상품목록페이지",
]


def check_robots(url: str) -> tuple:
    """robots.txt를 읽어 이 URL을 크롤링해도 되는지 판정한다."""
    parsed = urllib.parse.urlparse(url)
    robots_url = f"{parsed.scheme}://{parsed.netloc}/robots.txt"
    rp = urllib.robotparser.RobotFileParser()
    rp.set_url(robots_url)
    try:
        rp.read()
        allowed = rp.can_fetch(UA, url)
        delay = rp.crawl_delay(UA)
        return allowed, delay, robots_url, None
    except Exception as e:
        # robots.txt가 없으면 명시적 금지가 없는 것 — 다만 판단은 사람이 한다.
        return None, None, robots_url, str(e)[:120]


def fetch(url: str, timeout: int = 15) -> tuple:
    req = urllib.request.Request(url, headers={"User-Agent": UA, "Accept-Language": "ko-KR,ko;q=0.9"})
    with urllib.request.urlopen(req, timeout=timeout) as r:
        charset = r.headers.get_content_charset() or "utf-8"
        return r.status, r.read().decode(charset, errors="replace")


def slugify(url: str) -> str:
    p = urllib.parse.urlparse(url)
    base = (p.netloc + p.path).replace("/", "_").replace(".", "-")
    return (base[:70] or "page") + ".html"


def main(targets):
    os.makedirs(OUT_DIR, exist_ok=True)
    if not targets:
        print("정찰할 URL이 없습니다.")
        print("사용법: python scripts/recon_bean_sites.py <URL> [<URL> ...]")
        print("예)     python scripts/recon_bean_sites.py https://example.com/beans")
        return

    print(f"정찰 대상 {len(targets)}건\n" + "=" * 70)
    for url in targets:
        print(f"\n* {url}")

        allowed, delay, robots_url, err = check_robots(url)
        if allowed is True:
            print(f"  robots.txt: [허용] 크롤링 허용  ({robots_url})")
        elif allowed is False:
            print(f"  robots.txt: [금지] 크롤링 금지  ({robots_url})")
            print("     → 이 사이트는 수집 대상에서 제외해야 합니다.")
            continue
        else:
            print(f"  robots.txt: [주의] 확인 불가 ({err}) — 수동 확인 필요")

        if delay:
            print(f"  요청 간격 권고(crawl-delay): {delay}초")

        try:
            status, html = fetch(url)
            path = os.path.join(OUT_DIR, slugify(url))
            with open(path, "w", encoding="utf-8") as f:
                f.write(html)
            print(f"  HTTP {status} · {len(html):,}자 저장 → {path}")

            low = html.lower()
            hints = []
            for kw, label in [
                ("원두", "원두"), ("생두", "생두"), ("로스팅", "로스팅"),
                ("가격", "가격"), ("원", "가격단위"), ("리뷰", "리뷰"), ("후기", "후기"),
            ]:
                if kw in html:
                    hints.append(label)
            print(f"  본문 단서: {', '.join(dict.fromkeys(hints)) or '없음'}")
            if "<script" in low and html.count("원두") < 3:
                print("  [주의] 상품 정보가 JS로 늦게 로드될 가능성 (정적 HTML에 내용이 적음)")
        except Exception as e:
            print(f"  [실패] 접속 실패: {type(e).__name__} {str(e)[:100]}")

        time.sleep(1.0)  # 예의상 간격

    print("\n" + "=" * 70)
    print(f"저장 폴더: {OUT_DIR}")
    print("이 폴더의 HTML 파일을 Claude에게 보여주면 파서를 만들 수 있습니다.")


if __name__ == "__main__":
    main(sys.argv[1:] or DEFAULT_TARGETS)
