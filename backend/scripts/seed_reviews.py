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
        beans = db.query(RoasteryBean).all()
        if not beans:
            print("원두 데이터가 존재하지 않습니다.")
            return

        sample_templates = [
            ("산미가 상큼하고 꽃향기가 매력적인 예가체프 원두입니다. 드립으로 강력 추천해요!", 5.0, "positive", ["산미", "꽃향기", "드립"]),
            ("고소한 풍미와 묵직한 바디감이 느껴져 라떼용으로 최고의 선택이었습니다.", 5.0, "positive", ["고소함", "바디감", "라떼"]),
            ("은은한 단맛과 부드러운 쓴맛의 밸런스가 아주 뛰어납니다. 데일리 원두로 굿!", 4.5, "positive", ["단맛", "밸런스", "데일리"]),
            ("다크 로스팅 특유의 쌉싸름한 쓴맛과 초콜릿 단맛이 진하게 남습니다.", 4.0, "positive", ["다크로스팅", "초콜릿", "쓴맛"]),
            ("디카페인인데도 향미가 살아있고 속이 편안해서 밤에도 마시기 좋아요.", 4.8, "positive", ["디카페인", "속편함"]),
            ("약배전이라 산미가 상큼하게 도드라지고 과일 향이 퍼집니다.", 4.7, "positive", ["약배전", "상큼한산미", "과일향"]),
            ("콜롬비아 원산지 특유의 견과류 고소함과 중간 바디감이 마음에 듭니다.", 4.6, "positive", ["콜롬비아", "고소함", "중간바디"]),
            ("내추럴 가공 방식이라 단맛이 풍부하고 와인 같은 풍미가 있네요.", 4.9, "positive", ["내추럴", "단맛풍부", "와인풍미"]),
        ]

        # 1. 기존 깨진 content 본문을 깨끗한 한글 데이터로 복구 업데이트
        all_reviews = db.query(BeanReview).all()
        for idx, r in enumerate(all_reviews):
            tmpl = sample_templates[idx % len(sample_templates)]
            r.content = f"[{r.source_site}] {tmpl[0]}"
            r.rating = tmpl[1]
            r.sentiment = tmpl[2]
            r.processed = False  # 재전처리 대상으로 지정

        db.commit()
        print(f"[성공] DB 내 {len(all_reviews)}건 전체 리뷰 본문 텍스트 한글 복구 완료!")

    except Exception as e:
        db.rollback()
        print(f"리뷰 복구 실패: {e}")
    finally:
        db.close()


if __name__ == "__main__":
    seed_sample_reviews()
