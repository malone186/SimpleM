"""깨진 홍보 이미지 복구 (일회성 유지보수 스크립트)

Cloud Run 로컬 디스크에 저장하던 시절의 홍보 이미지는 배포·스케일 때마다 사라졌다.
문서(generated_documents)에는 URL만 남고 파일이 없어 보관함이 통째로 깨져 보인다.
이 스크립트는 그런 죽은 항목을 찾아 **같은 문서의 문구로 이미지를 다시 만들어** 채우고,
살릴 수 없는 항목은 목록에서 뺀다. 새 이미지는 GCS 버킷에 올라가므로 다시는 안 사라진다.

실행 (backend/ 에서):
    POLLINATIONS_TOKEN=... MARKETING_GCS_BUCKET=brewnote-promo-images \
    GOOGLE_APPLICATION_CREDENTIALS=deploy/github-deployer-key.json \
    python db_repair_promo_images.py [--store s@gmail.com] [--dry-run]

한 번 돌리고 나면 다시 쓸 일이 없어야 정상이다 (GCS 저장이 기본이 됐으므로).
"""
from __future__ import annotations

import argparse
import sys

import httpx


def _alive(url: str) -> bool:
    """이미지 URL이 실제로 살아 있는지 — GCS 절대 URL만 검사 가능(상대 경로는 죽은 것)."""
    if not url.startswith("http"):
        return False
    try:
        r = httpx.head(url, timeout=20, follow_redirects=True)
        return r.status_code == 200
    except httpx.HTTPError:
        return False


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--store", default="s@gmail.com", help="대상 매장(store_id = 이메일)")
    ap.add_argument("--dry-run", action="store_true", help="바꾸지 않고 목록만 출력")
    # 재생성이 실패해 항목만 지워진 문서(이미지 0장)를 다음 실행에서 다시 채우기 위한 옵션.
    # Pollinations가 잠깐 죽으면(실측: 500 "Failed query") 그 순간 걸린 문서가 빈 채로 남는다.
    ap.add_argument("--fill-empty", action="store_true",
                    help="이미지가 하나도 없는 홍보 문서에도 새로 한 장 만든다")
    args = ap.parse_args()

    from app.services.ai import document_service, marketing_service

    docs = document_service.list_documents(args.store, kind=marketing_service.DOC_KIND)
    print(f"홍보 문서 {len(docs)}건 검사")

    repaired = dropped = skipped = 0
    for meta in docs:
        doc = document_service.get_document(args.store, meta["id"])
        content = doc.get("content") or {}
        images = list(content.get("images") or [])
        if not images and not args.fill_empty:
            continue

        live = [im for im in images if _alive(im.get("url", ""))]
        dead = len(images) - len(live)
        if not dead and (live or not args.fill_empty):
            continue

        title = (doc.get("title") or "")[:24]
        if args.dry_run:
            print(f"  [dry] {meta['id']} {title} — " + (f"{dead}장 깨짐" if dead else "이미지 없음"))
            skipped += max(dead, 1)
            continue

        # 죽은 항목을 먼저 걷어내고, 문서에 이미지가 하나도 안 남으면 새로 한 장 만든다.
        if dead:
            content["images"] = live
            document_service.update_document(args.store, meta["id"], content)

        if live:
            dropped += dead
            print(f"  {meta['id']} {title} — 죽은 {dead}장 제거 (살아있는 {len(live)}장 유지)")
            continue

        try:
            # doc_id를 주면 문서의 image_prompt·슬로건을 그대로 써서 만들고 문서에 붙는다
            out = marketing_service.generate_promotion_image(
                args.store, doc_id=meta["id"],
                aspect_ratio=(images[0].get("aspect_ratio") if images else None) or "1:1",
                style=(images[0].get("style") if images else "") or "")
            repaired += 1
            print(f"  {meta['id']} {title} — 재생성 완료 ({out['provider']}) {out['url'][:70]}")
        except marketing_service.MarketingError as e:
            dropped += dead
            print(f"  {meta['id']} {title} — 재생성 실패, 항목만 제거: {e}")

    print(f"\n재생성 {repaired}건 · 제거 {dropped}건" + (f" · dry-run {skipped}건" if args.dry_run else ""))
    return 0


if __name__ == "__main__":
    sys.exit(main())
