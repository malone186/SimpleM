# c:\Users\USER\Documents\본 프로젝트\SimpleM\backend\app\services\operation\seed_service.py
"""
[한글 주석] 원두 시드 데이터 검증 및 멱등적 일괄 적재 서비스 모듈
CSV 또는 JSON 원두 데이터 파일을 읽어 컬럼 매핑과 유효성을 검증하고, PostgreSQL DB에 일괄 적재합니다.
"""

import os
import csv
import json
import logging
from typing import List, Dict, Any, Optional

from sqlalchemy.orm import Session

from app.models.roastery import Roastery, RoasteryBean
from app.services.operation.bean_review_service import normalize_product_url

logger = logging.getLogger(__name__)


def validate_and_clean_bean_data(b: Dict[str, Any], bean_id_override: Optional[int] = None) -> Optional[Dict[str, Any]]:
    """
    [한글 주석] 원두 시드 데이터 레코드의 컬럼 매핑 및 유효성을 검증하고 정제된 딕셔너리를 반환합니다.
    """
    bean_id = b.get("id") or bean_id_override
    bean_name = (b.get("name") or b.get("bean_name") or "").strip()

    if not bean_name:
        return None

    # 가격 정제 (쉼표 제거 및 숫자 변환)
    raw_price = b.get("price", 0)
    try:
        price = int(float(str(raw_price).replace(",", "")))
    except (ValueError, TypeError):
        price = 15000

    # URL 정규화
    raw_url = b.get("product_url") or b.get("productUrl") or ""
    canonical_url, _ = normalize_product_url(raw_url, bean_id=bean_id)

    return {
        "id": int(bean_id) if bean_id else None,
        "name": bean_name,
        "price": price,
        "roastery_name": (b.get("roastery") or b.get("roastery_name") or "가델로 커피").strip(),
        "thumbnail_url": b.get("thumbnail_url") or b.get("thumbnailUrl"),
        "product_url": canonical_url,
        "date_added": str(b.get("date_added") or b.get("dateAdded") or ""),
        "best": str(b.get("best", "")).lower() in ("true", "1", "yes"),
        "new": str(b.get("new", "")).lower() in ("true", "1", "yes"),
        "sold_out": str(b.get("sold_out") or b.get("soldOut", "")).lower() in ("true", "1", "yes"),
        "description": b.get("description", ""),
        "country": b.get("country", ""),
        "process": b.get("process", ""),
        "blend": str(b.get("blend", "")).lower() in ("true", "1", "yes"),
        "decaf": str(b.get("decaf", "")).lower() in ("true", "1", "yes"),
        "gesha": str(b.get("gesha", "")).lower() in ("true", "1", "yes"),
        "price_per_gram": float(b.get("price_per_gram") or b.get("pricepergram", 0.0) or 0.0),
        "naver_product_id": str(b.get("naver_product_id") or b.get("naverProductId") or "")
    }


def import_beans_from_csv(db: Session, csv_file_path: str) -> Dict[str, Any]:
    """
    [한글 주석] CSV 파일로부터 원두 시드 데이터를 읽어 검증 후 DB에 멱등하게 일괄 적재합니다.
    """
    if not os.path.exists(csv_file_path):
        return {"success": False, "message": f"CSV 파일을 찾을 수 없습니다: {csv_file_path}"}

    imported_count = 0
    skipped_count = 0

    with open(csv_file_path, "r", encoding="utf-8-sig") as f:
        reader = csv.DictReader(f)
        for idx, row in enumerate(reader):
            cleaned = validate_and_clean_bean_data(row, bean_id_override=idx+1)
            if not cleaned:
                skipped_count += 1
                continue

            # 로스터리 매핑
            r_name = cleaned["roastery_name"]
            roastery = db.query(Roastery).filter(Roastery.name == r_name).first()
            if not roastery:
                roastery = Roastery(name=r_name, roastery_info=f"{r_name} 공식 로스터리")
                db.add(roastery)
                db.flush()

            # 원두 멱등 Upsert
            existing = None
            if cleaned["id"]:
                existing = db.query(RoasteryBean).filter(RoasteryBean.id == cleaned["id"]).first()
            if not existing:
                existing = db.query(RoasteryBean).filter(RoasteryBean.name == cleaned["name"]).first()

            if not existing:
                new_bean = RoasteryBean(
                    id=cleaned["id"],
                    name=cleaned["name"],
                    price=cleaned["price"],
                    roastery_id=roastery.id,
                    thumbnail_url=cleaned["thumbnail_url"],
                    product_url=cleaned["product_url"],
                    description=cleaned["description"],
                    country=cleaned["country"],
                    process=cleaned["process"],
                    blend=cleaned["blend"],
                    decaf=cleaned["decaf"],
                    gesha=cleaned["gesha"],
                    price_per_gram=cleaned["price_per_gram"]
                )
                db.add(new_bean)
                imported_count += 1
            else:
                existing.price = cleaned["price"]
                existing.product_url = cleaned["product_url"]
                existing.description = cleaned["description"]

    db.commit()
    return {
        "success": True,
        "imported_count": imported_count,
        "skipped_count": skipped_count,
        "message": f"CSV 시드 데이터 적재 완료 (성공: {imported_count}건, 스킵: {skipped_count}건)"
    }


def import_seed_roasteries_and_beans(
    db: Session,
    roasteries_file: Optional[str] = None,
    beans_file: Optional[str] = None
) -> Dict[str, Any]:
    """
    [한글 주석]
    로스터리 및 원두 시드 데이터를 JSON/CSV 파일로부터 컬럼 매핑 검증 후 DB에 멱등하게 일괄 적재합니다.
    """
    base_dir = os.path.dirname(os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__)))))
    
    if not roasteries_file:
        roasteries_file = os.path.join(base_dir, "mungmung_roasteries.json")
    if not beans_file:
        beans_file = os.path.join(base_dir, "mungmung_beans.json")

    # CSV 파일 형식일 경우 처리
    if beans_file and beans_file.endswith(".csv"):
        return import_beans_from_csv(db, beans_file)

    imported_roasteries = 0
    imported_beans = 0
    skipped_beans = 0

    # 1. 로스터리 시드 데이터 적재
    if os.path.exists(roasteries_file):
        with open(roasteries_file, "r", encoding="utf-8") as f:
            r_list = json.load(f)

        roastery_name_to_id = {}
        for r in r_list:
            r_id = r.get("id")
            cleaned_name = r.get("name", "").strip()
            if not cleaned_name:
                continue

            existing = db.query(Roastery).filter(Roastery.id == r_id).first()
            if not existing:
                roastery = Roastery(
                    id=r_id,
                    name=cleaned_name,
                    thumbnail_url=r.get("thumbnailUrl"),
                    roastery_info=r.get("roasteryinfo"),
                    file_path=r.get("filePath")
                )
                db.add(roastery)
                imported_roasteries += 1
            else:
                existing.name = cleaned_name
                existing.roastery_info = r.get("roasteryinfo")

            roastery_name_to_id[cleaned_name] = r_id

        db.commit()
        logger.info("로스터리 시드 데이터 %d건 적재 완료", imported_roasteries)
    else:
        # 파일이 없을 경우 기본 로스터리 생성
        default_r = db.query(Roastery).filter(Roastery.id == 1).first()
        if not default_r:
            default_r = Roastery(id=1, name="가델로 커피", roastery_info="대표 로스터리 브랜딩")
            db.add(default_r)
            db.commit()
            imported_roasteries += 1
        roastery_name_to_id = {"가델로 커피": 1}

    # 2. 원두 시드 데이터 검증 및 적재
    if os.path.exists(beans_file):
        with open(beans_file, "r", encoding="utf-8") as f:
            b_list = json.load(f)

        for idx, b in enumerate(b_list):
            cleaned = validate_and_clean_bean_data(b, bean_id_override=idx+1)
            if not cleaned:
                skipped_beans += 1
                continue

            r_name = cleaned["roastery_name"]
            r_id = roastery_name_to_id.get(r_name, 1)

            existing_bean = db.query(RoasteryBean).filter(RoasteryBean.id == cleaned["id"]).first()
            if not existing_bean:
                new_bean = RoasteryBean(
                    id=cleaned["id"],
                    name=cleaned["name"],
                    price=cleaned["price"],
                    roastery_id=r_id,
                    thumbnail_url=cleaned["thumbnail_url"],
                    product_url=cleaned["product_url"],
                    date_added=cleaned["date_added"],
                    best=cleaned["best"],
                    new=cleaned["new"],
                    sold_out=cleaned["sold_out"],
                    description=cleaned["description"],
                    country=cleaned["country"],
                    process=cleaned["process"],
                    blend=cleaned["blend"],
                    decaf=cleaned["decaf"],
                    gesha=cleaned["gesha"],
                    price_per_gram=cleaned["price_per_gram"],
                    naver_product_id=cleaned["naver_product_id"]
                )
                db.add(new_bean)
                imported_beans += 1
            else:
                existing_bean.name = cleaned["name"]
                existing_bean.price = cleaned["price"]
                existing_bean.product_url = cleaned["product_url"]
                existing_bean.description = cleaned["description"]

        db.commit()
        logger.info("원두 시드 데이터 %d건 적재 완료 (누락/스킵: %d건)", imported_beans, skipped_beans)

    return {
        "success": True,
        "imported_roasteries": imported_roasteries,
        "imported_beans": imported_beans,
        "skipped_beans": skipped_beans,
        "message": f"시드 적재 완료 (로스터리: {imported_roasteries}개, 원두: {imported_beans}개)"
    }

