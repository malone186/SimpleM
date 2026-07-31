"""생두모아 CSV → Roastery/RoasteryBean 안전 적재 스크립트.

[왜 import_seed_beans.py를 쓰면 안 되나]
기존 시드 로더(seed_service.import_beans_from_csv)는 CSV의 id를 explicit PK로 넣는다.
생두모아 CSV의 id(사이트 상품번호 1~1482)는 운영 DB의 기존 원두 id(1~911)와 겹쳐서,
그대로 돌리면 기존 원두 수백 건이 덮여 손상된다 (실측: Neon에서 id 충돌 534건).

이 스크립트는:
  · id를 넣지 않는다 → DB 자동증가로 항상 새 행 (기존 데이터 무손상)
  · 이름(정규화)이 이미 있으면 건너뛴다 → 재실행해도 중복 없음(멱등)
  · 로스터리는 이름으로 찾고 없을 때만 생성

사용:
    DATABASE_URL="<운영 DB>" python scripts/load_saengdoo_beans.py \
        --file scripts/data/saengdoo_beans.csv
"""
import argparse
import csv
import sys
from pathlib import Path

sys.path.append(str(Path(__file__).resolve().parents[1]))

import app.models  # noqa: E402,F401  (모델 전부 등록 — create_all용)
from app.core.database import Base, SessionLocal, engine  # noqa: E402
from app.models.roastery import Roastery, RoasteryBean  # noqa: E402
from app.services.operation.seed_service import validate_and_clean_bean_data  # noqa: E402


def main() -> None:
    ap = argparse.ArgumentParser(description="생두모아 CSV 안전 적재 (autoincrement id + 이름 dedup)")
    ap.add_argument("--file", default="scripts/data/saengdoo_beans.csv")
    args = ap.parse_args()

    Base.metadata.create_all(bind=engine)  # 없는 테이블만 생성 — 기존 데이터에 영향 없음
    db = SessionLocal()
    try:
        before = db.query(RoasteryBean).count()
        existing_names = {n for (n,) in db.query(RoasteryBean.name).all()}
        rost_by_name = {r.name: r for r in db.query(Roastery).all()}

        added = skipped = new_rost = 0
        with open(args.file, encoding="utf-8-sig") as f:
            for row in csv.DictReader(f):
                c = validate_and_clean_bean_data(row)  # 가격/URL 정제 재사용
                if not c or c["name"] in existing_names:
                    skipped += 1
                    continue
                rn = c["roastery_name"]
                rost = rost_by_name.get(rn)
                if rost is None:
                    rost = Roastery(name=rn, roastery_info=f"{rn} (생두모아 수집)")
                    db.add(rost)
                    db.flush()
                    rost_by_name[rn] = rost
                    new_rost += 1
                db.add(RoasteryBean(  # id 미지정 → 자동증가 (기존 원두와 절대 충돌 안 함)
                    name=c["name"], price=c["price"], roastery_id=rost.id,
                    product_url=c["product_url"], description=c["description"],
                    country=c["country"], process=c["process"],
                    blend=c["blend"], decaf=c["decaf"], gesha=c["gesha"],
                    price_per_gram=c["price_per_gram"],
                ))
                existing_names.add(c["name"])
                added += 1
        db.commit()
        after = db.query(RoasteryBean).count()
        print(f"추가 {added} · 건너뜀(중복/무효) {skipped} · 새 로스터리 {new_rost}")
        print(f"원두 {before} → {after}")
    finally:
        db.close()


if __name__ == "__main__":
    main()
