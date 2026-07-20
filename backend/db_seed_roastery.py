# c:\STUDY\SimpleM\backend\db_seed_roastery.py
import json
import os
import sys

# [한글 주석] 파이썬이 패키지를 임포트할 때 'app' 폴더를 정상적으로 발견하도록 루트 검색 경로를 지정합니다.
sys.path.append(os.path.dirname(os.path.abspath(__file__)))

from app.core.database import SessionLocal
from app.models.roastery import Roastery, RoasteryBean

def seed_data():
    # 데이터베이스 통신 연결 통로 개설
    db = SessionLocal()
    try:
        # [한글 주석] 테스트 시 데이터가 꼬이거나 중복되는 것을 막기 위해 
        # 원두와 로스터리 관련 기존 데이터를 한 번 깨끗하게 청소(비우기)합니다.
        print("기존 데이터베이스 내부의 로스터리 및 원두 데이터 초기화 중...")
        db.query(RoasteryBean).delete()
        db.query(Roastery).delete()
        db.commit()

        # 1. 로스터리(Roastery) 데이터 불러오기 및 가공
        roasteries_path = "../mungmung_roasteries.json"
        print(f"로스터리 원본 파일 불러오는 중: {roasteries_path}")
        with open(roasteries_path, "r", encoding="utf-8") as f:
            roastery_list = json.load(f)

        print(f"로스터리 데이터 가공 중 (총 {len(roastery_list)}개)...")
        roastery_mappings = []
        roastery_name_to_id = {}  # 원두와 로스터리를 이름으로 엮어주기 위한 통역 사전

        for r in roastery_list:
            # [한글 주석] 이름 끝에 공백(' ')이 붙어있는 등의 결함을 방지하기 위해 공백을 지워줍니다.
            cleaned_name = r["name"].strip()
            
            roastery_mappings.append({
                "id": r["id"],
                "name": cleaned_name,
                "thumbnail_url": r.get("thumbnailUrl"),
                "roastery_info": r.get("roasteryinfo"),
                "file_path": r.get("filePath")
            })
            roastery_name_to_id[cleaned_name] = r["id"]

        # 대량 데이터를 고속으로 저장하기 위해 벌크 매핑 인서트 기능을 사용합니다.
        db.bulk_insert_mappings(Roastery, roastery_mappings)
        db.commit()
        print("[성공] 로스터리 업체 정보 적재 완료!")

        # 2. 원두(RoasteryBean) 데이터 불러오기 및 가공
        beans_path = "../mungmung_beans.json"
        print(f"원두 원본 파일 불러오는 중: {beans_path}")
        with open(beans_path, "r", encoding="utf-8") as f:
            bean_list = json.load(f)

        print(f"원두 데이터 가공 및 관계 조립 중 (총 {len(bean_list)}개)...")
        bean_mappings = []
        skipped_count = 0  # 매칭 실패로 누락된 수 카운트

        for b in bean_list:
            bean_roastery_name = b["roastery"].strip()
            
            # 원두의 로스터리 이름을 사전에서 검색하여 상위 로스터리 ID를 구합니다.
            roastery_id = roastery_name_to_id.get(bean_roastery_name)
            if not roastery_id:
                # 키워드가 완전히 똑같지 않고 조금 다를 때를 대비한 2차 검색(부분 일치)
                matched = False
                for r_name, r_id in roastery_name_to_id.items():
                    if r_name in bean_roastery_name or bean_roastery_name in r_name:
                        roastery_id = r_id
                        matched = True
                        break
                if not matched:
                    # 어느 로스터리에도 속하지 않는 미아 데이터는 탈락시킵니다.
                    skipped_count += 1
                    continue

            # 가격 데이터 숫자로 정제 (예: "16000" -> 16000)
            raw_price = b.get("price", "0")
            try:
                price_val = int(float(str(raw_price).replace(",", "")))
            except ValueError:
                price_val = 0

            # 1g당 단가 정보 파싱
            price_pg = b.get("pricepergram")
            if price_pg is not None:
                try:
                    price_pg = float(price_pg)
                except ValueError:
                    price_pg = 0.0

            # [한글 주석: 로그인하지 않은 유저도 상품 사양을 즉시 조회할 수 있도록 naverProductId 기반의 쇼핑 카탈로그 주소로 링크를 교체 가공합니다]
            naver_id = b.get("naverProductId")
            if naver_id:
                product_url = f"https://search.shopping.naver.com/catalog/{naver_id}"
            else:
                product_url = b.get("productUrl")

            bean_mappings.append({
                "id": b["id"],
                "name": b["name"],
                "price": price_val,
                "roastery_id": roastery_id,
                "thumbnail_url": b.get("thumbnailUrl"),
                "product_url": product_url,
                "date_added": b.get("dateAdded"),
                "best": bool(b.get("best")),
                "new": bool(b.get("new")),
                "sold_out": bool(b.get("soldOut")),
                "description": b.get("description", ""),
                "country": b.get("country", ""),
                "process": b.get("process", ""),
                "blend": bool(b.get("blend")),
                "decaf": bool(b.get("decaf")),
                "gesha": bool(b.get("gesha")),
                "price_per_gram": price_pg,
                "naver_product_id": b.get("naverProductId")
            })

        print(f"원두 벌크 적재 실행 중 (적재할 상품 수: {len(bean_mappings)}개, 매칭 실패 제외: {skipped_count}개)...")
        
        # 1만 4천 개 이상의 데이터를 한 번에 고속(수 초 내)으로 저장
        db.bulk_insert_mappings(RoasteryBean, bean_mappings)
        db.commit()
        print("[성공] 원두 상품 정보 벌크 적재 완료!")

    except Exception as e:
        db.rollback()
        print(f"[오류] 데이터 적재 중 오류 발생으로 롤백되었습니다. 원인: {e}", file=sys.stderr)
        raise e
    finally:
        db.close()

if __name__ == "__main__":
    seed_data()
