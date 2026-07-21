# c:\Users\USER\Documents\본 프로젝트\SimpleM\backend\scripts\check_tables.py
import sys
import os
sys.path.insert(0, os.path.abspath(os.path.join(os.path.dirname(__file__), "..")))

from sqlalchemy import text
from app.core.database import engine

def check_db():
    print("=" * 60)
    print("     [DB 스키마 및 테이블 현황 점검]")
    print("=" * 60)
    with engine.connect() as conn:
        # 1. 전체 스키마 목록
        schemas = [r[0] for r in conn.execute(text("SELECT schema_name FROM information_schema.schemata;")).fetchall()]
        print(f"1. 존재 스키마 목록: {schemas}")

        # 2. public 스키마 내 테이블 목록
        public_tables = [r[0] for r in conn.execute(text("SELECT table_name FROM information_schema.tables WHERE table_schema='public';")).fetchall()]
        print(f"2. 'public' 스키마 테이블 목록 ({len(public_tables)}개): {public_tables}")

        # 3. simplem 스키마 존재 시 테이블 목록
        if 'simplem' in schemas:
            simplem_tables = [r[0] for r in conn.execute(text("SELECT table_name FROM information_schema.tables WHERE table_schema='simplem';")).fetchall()]
            print(f"3. 'simplem' 스키마 테이블 목록 ({len(simplem_tables)}개): {simplem_tables}")
            
            if 'bean_reviews' in simplem_tables:
                count = conn.execute(text("SELECT COUNT(*) FROM simplem.bean_reviews;")).scalar()
                print(f"   -> simplem.bean_reviews 총 데이터 수: {count}건")
        else:
            print("3. 'simplem' 전용 스키마가 아직 공용 DB 상에 생성되지 않음")

        # 4. public 스키마 내 bean_reviews 여부
        if 'bean_reviews' in public_tables:
            count = conn.execute(text("SELECT COUNT(*) FROM public.bean_reviews;")).scalar()
            print(f"   -> public.bean_reviews 총 데이터 수: {count}건")

if __name__ == "__main__":
    check_db()
