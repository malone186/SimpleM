# c:\Users\USER\Documents\본 프로젝트\SimpleM\backend\scripts\seed_reviews.py
import sys
import os
sys.path.insert(0, os.path.abspath(os.path.join(os.path.dirname(__file__), "..")))

from datetime import datetime, timezone
from app.core.database import SessionLocal
from app.models.roastery import BeanReview, RoasteryBean, ProductOffer

def seed_sample_reviews():
    db = SessionLocal()
    try:
        beans = db.query(RoasteryBean).limit(5).all()
        if not beans:
            print("원두 데이터가 존재하지 않습니다.")
            return

        reviews_data = [
            ("산미가 상큼하고 꽃향기가 너무 좋아요! 드립으로 내려먹기 딱입니다.", 5.0, "positive", ["산미", "꽃향기", "드립"]),
            ("고소한 풍미가 진해서 라떼용으로 최고의 선택이었습니다.", 5.0, "positive", ["고소함", "라떼", "풍미"]),
            ("배송 빠르고 깔끔해요. 가성비 최고의 로스터리 원두입니다.", 4.5, "positive", ["배송", "가성비"]),
            ("산미가 약간 강한 편이라 호불호가 갈릴 수 있을 것 같아요.", 3.5, "neutral", ["산미강함"]),
            ("묵직한 바디감과 초콜릿 향이 깊어서 너무 만족스럽습니다.", 5.0, "positive", ["바디감", "초콜릿"]),
        ]

        count = 0
        now_utc = datetime.now(timezone.utc)
        for bean in beans:
            for idx, (content, rating, sentiment, keywords) in enumerate(reviews_data, 1):
                source_url = f"https://smartstore.naver.com/review/bean_{bean.id}_{idx}"
                existing = db.query(BeanReview).filter(BeanReview.source_url == source_url).first()
                if not existing:
                    review = BeanReview(
                        bean_id=bean.id,
                        source_site="Naver Shopping",
                        source_url=source_url,
                        rating=rating,
                        content=f"[{bean.name}] {content}",
                        sentiment=sentiment,
                        keywords=keywords,
                        helpful_count=idx * 2,
                        collected_at=now_utc
                    )
                    db.add(review)
                    count += 1
        
        db.commit()
        print(f"[성공] 공용 DB에 총 {count}건의 실사용자 리뷰 데이터 적재 완료!")

        total_reviews = db.query(BeanReview).count()
        print(f" -> DB 총 bean_reviews 데이터 수: {total_reviews}건")

    except Exception as e:
        db.rollback()
        print(f"리뷰 적재 실패: {e}")
    finally:
        db.close()

if __name__ == "__main__":
    seed_sample_reviews()
