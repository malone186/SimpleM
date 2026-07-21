# c:\Users\USER\Documents\본 프로젝트\SimpleM\backend\scripts\test_product_search_pipeline.py
"""
[한글 주석] 상품 검색·정렬·필터·대체추천·오퍼조회·prefetch 캐시 E2E 통합 테스트 스크립트
"""

import sys
import os

# 백엔드 최상위 디렉터리를 sys.path에 추가하여 app 모듈 접근 허용
sys.path.insert(0, os.path.abspath(os.path.join(os.path.dirname(__file__), "..")))

from fastapi.testclient import TestClient
from app.main import app
from app.core.database import SessionLocal
from app.models.roastery import RoasteryBean, ProductOffer, Roastery

client = TestClient(app)


def setup_dummy_products_and_offers():
    """
    [한글 주석] 테스트용 더미 원두 및 판매처 오퍼(재고있음/품절) 데이터베이스 초기화
    """
    db = SessionLocal()
    try:
        from sqlalchemy import text
        # 시퀀스 리셋 (Primary Key 충돌 방지)
        db.execute(text("SELECT setval('roastery_beans_id_seq', (SELECT COALESCE(MAX(id), 1) FROM roastery_beans));"))
        db.execute(text("SELECT setval('product_offers_id_seq', (SELECT COALESCE(MAX(id), 1) FROM product_offers));"))
        db.commit()

        # 기존 로스터리 사용 또는 생성
        roastery = db.query(Roastery).first()
        if not roastery:
            roastery = Roastery(name="테스트 로스터리", roastery_info="검색 테스트용 로스터리")
            db.add(roastery)
            db.commit()
            db.refresh(roastery)


        # 1. 기존 원두 가져오기 또는 생성
        bean_in_stock = db.query(RoasteryBean).filter(RoasteryBean.name.ilike("%에티오피아%") | RoasteryBean.name.ilike("%BG블렌드%")).first()
        if not bean_in_stock:
            bean_in_stock = RoasteryBean(
                name="에티오피아 예가체프 (200g)",
                price=14000,
                roastery_id=roastery.id,
                country="에티오피아",
                process="워시드",
                description="상큼한 산미와 꽃향기"
            )
            db.add(bean_in_stock)
            db.commit()
            db.refresh(bean_in_stock)
        else:
            bean_in_stock.country = "에티오피아"
            db.commit()

        # 2. 오퍼 2건 추가
        offer1 = db.query(ProductOffer).filter(ProductOffer.product_url == "https://testmall.com/offer1").first()
        if not offer1:
            offer1 = ProductOffer(
                bean_id=bean_in_stock.id,
                source_site="네이버 쇼핑",
                product_url="https://testmall.com/offer1",
                price=13500,
                in_stock=True,
                rating=4.8,
                review_count=150
            )
            db.add(offer1)

        offer2 = db.query(ProductOffer).filter(ProductOffer.product_url == "https://testmall.com/offer2").first()
        if not offer2:
            offer2 = ProductOffer(
                bean_id=bean_in_stock.id,
                source_site="쿠팡",
                product_url="https://testmall.com/offer2",
                price=14000,
                in_stock=True,
                rating=4.9,
                review_count=80
            )
            db.add(offer2)

        # 3. 전량 품절 원두 추가/조회
        bean_out_of_stock = db.query(RoasteryBean).filter(RoasteryBean.name == "품절 전용 블루마운틴 (200g)").first()
        if not bean_out_of_stock:
            bean_out_of_stock = RoasteryBean(
                name="품절 전용 블루마운틴 (200g)",
                price=45000,
                roastery_id=roastery.id,
                country="자메이카",
                process="워시드",
                description="최고급 자메이카 원두"
            )
            db.add(bean_out_of_stock)
            db.commit()
            db.refresh(bean_out_of_stock)

        offer_out = db.query(ProductOffer).filter(ProductOffer.product_url == "https://testmall.com/offer_out").first()
        if not offer_out:
            offer_out = ProductOffer(
                bean_id=bean_out_of_stock.id,
                source_site="가델로 공식몰",
                product_url="https://testmall.com/offer_out",
                price=45000,
                in_stock=False,  # 전량 품절
                rating=5.0,
                review_count=30
            )
            db.add(offer_out)

        db.commit()
        print(" - 테스트용 더미 원두 및 오퍼 적재 완료!")
        return bean_in_stock.id
    except Exception as e:
        db.rollback()
        print(f" - 더미 데이터 준비 주의: {e}")
        return 1
    finally:
        db.close()




def test_product_search_pipeline():
    """
    [한글 주석] 상품 검색 통합 테스트 실행
    """
    print("\n" + "=" * 75)
    print("      [SimpleM 상품 검색·정렬·대체추천·캐시 E2E 통합 테스트 시작]")
    print("=" * 75)

    target_bean_id = setup_dummy_products_and_offers()

    # -------------------------------------------------------------------------
    # [시나리오 1] 최저가 정렬 및 재고 보유 상품 우선 배치 검증
    # -------------------------------------------------------------------------
    print("\n[시나리오 1] 최저가 정렬 (GET /api/v1/operation/products/search?q=에티오피아&sort=price_asc)")
    print("-" * 75)

    res1 = client.get("/api/v1/operation/products/search?q=에티오피아&sort=price_asc")
    assert res1.status_code == 200, f"API 실패: {res1.text}"
    data1 = res1.json()["data"]

    print(f" - 검색된 총 오퍼 수: {data1['total_count']}건")
    print(f" - 품절 전용 여부: {data1['has_out_of_stock_only']}")
    for idx, item in enumerate(data1["items"], 1):
        print(f" [{idx}] {item['bean_name']} ({item['source_site']}) | 가격: {item['price']:,}원 | 재고: {item['in_stock']} | 시세시각: {item['updated_at']}")

    assert data1["total_count"] > 0, "검색 결과가 존재해야 합니다."
    assert data1["items"][0]["in_stock"] == True, "최저가 정렬 시 재고 보유 상품이 최상단이어야 합니다."

    # -------------------------------------------------------------------------
    # [시나리오 2] 전량 품절 시 재고 없음 대체 추천(Alternatives) 제안 검증
    # -------------------------------------------------------------------------
    print("\n\n[시나리오 2] 품절 상품 검색 시 대체 추천 제안 (GET /api/v1/operation/products/search?q=블루마운틴)")
    print("-" * 75)

    res2 = client.get("/api/v1/operation/products/search?q=블루마운틴")
    assert res2.status_code == 200, f"API 실패: {res2.text}"
    data2 = res2.json()["data"]

    print(f" - 검색된 총 오퍼 수: {data2['total_count']}건")
    print(f" - 품절 전용 여부: {data2['has_out_of_stock_only']}")
    print(f" - 대체 추천(Alternatives) 수: {len(data2['alternatives'])}건")
    
    for idx, alt in enumerate(data2["alternatives"], 1):
        print(f" [대체추천 {idx}] {alt['name']} ({alt['roastery_name']}) | 가격: {alt['price']:,}원 | 추천사유: {alt['reason']}")

    assert data2["has_out_of_stock_only"] == True, "품절 전용 여부가 True여야 합니다."
    assert len(data2["alternatives"]) > 0, "재고 있는 대체 추천 원두가 제공되어야 합니다."

    # -------------------------------------------------------------------------
    # [시나리오 3] 특정 원두 판매처별 오퍼 및 최저가 조회
    # -------------------------------------------------------------------------
    print(f"\n\n[시나리오 3] 원두별 오퍼 및 최저가 조회 (GET /api/v1/operation/beans/{target_bean_id}/offers)")
    print("-" * 75)

    res3 = client.get(f"/api/v1/operation/beans/{target_bean_id}/offers?sort=price")

    assert res3.status_code == 200, f"API 실패: {res3.text}"
    data3 = res3.json()["data"]

    print(f" - 원두명: {data3['bean_name']} ({data3['roastery_name']})")
    print(f" - 최저가 오퍼 가격: {data3['best_offer_price']:,}원")
    print(f" - 판매처 수: {data3['total_offers']}개")

    assert data3["best_offer_price"] > 0, "최저가 오퍼 가격이 계산되어야 합니다."

    # -------------------------------------------------------------------------
    # [시나리오 4] 사전 수집 큐 등록 및 오래된 시세 캐시 갱신 (POST /products/prefetch)
    # -------------------------------------------------------------------------
    print("\n\n[시나리오 4] 사전 수집 및 캐시 갱신 (POST /api/v1/operation/products/prefetch)")
    print("-" * 75)

    payload4 = {
        "target_keywords": ["에티오피아", "디카페인"],
        "force_refresh": True
    }
    res4 = client.post("/api/v1/operation/products/prefetch", json=payload4)
    assert res4.status_code == 200, f"API 실패: {res4.text}"
    data4 = res4.json()["data"]

    print(f" - 수집 큐 등록 키워드 수: {data4['enqueued_count']}개")
    print(f" - 갱신된 시세 캐시 오퍼 수: {data4['refreshed_offers_count']}건")
    print(f" - 메시지: {data4['message']}")

    assert data4["success"] == True, "사전 수집 처리가 성공해야 합니다."

    print("\n" + "=" * 75)
    print("      [상품 검색·정렬·대체추천·캐시 E2E 통합 테스트 성공 완료!]")
    print("=" * 75)


if __name__ == "__main__":
    test_product_search_pipeline()
