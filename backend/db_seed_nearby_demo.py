"""주변 상권 변화 데모 시드 (백엔드 B) — '신규 개업'과 '폐업 추정'을 실제로 만들어 본다

주변 카페 감시는 어제와 오늘을 비교해야 변화가 나온다. 관측을 오늘 시작한 매장은
기준선만 있고 변화가 0건이라, 화면도 알림도 확인할 방법이 없다.
이 스크립트는 **실제 스캔 함수를 그대로 태워** 지난 나흘치 관측을 만들어 준다.

  D-3  네이버로 실제 수집한 카페들 → 기준선 (원래 있던 가게)
  D-2  그중 한 곳이 검색에서 사라지기 시작 (실종 1회)
  D-1  실종 2회 + 반경 안의 다른 실제 카페 한 곳이 처음 등장
  오늘 실종 3회 → 폐업 추정 확정 / 새 카페 2회 연속 관측 → 신규 개업 확정

수집만 흉내 내고(어느 날 무엇이 검색됐는지) 판정은 손대지 않는다 —
2회 연속·3회 실종·부실 스캔 생략 같은 규칙이 실제로 도는지 이 시드로 확인할 수 있다.

시드가 끝나면 알림은 '아직 안 보낸' 상태로 남는다 — 스케줄러가 다음에 돌 때 실제로 발송된다.
미리 문구만 확인하고 싶으면 --notify를 준다(발송은 가로채지만 중복 방지 이력은 진짜로 남으므로,
그 뒤에는 스케줄러가 다시 보내지 않는다는 점에 주의).

    python db_seed_nearby_demo.py                 # 시나리오만 주입 (알림은 살려 둔다)
    python db_seed_nearby_demo.py --notify        # 주입 + 폰에 뜰 문구 미리보기 (알림을 소진한다)
    python db_seed_nearby_demo.py --reset         # 실제 상태로 되돌리기 (오늘 기준선만 다시 잡는다)
    python db_seed_nearby_demo.py --store a@b.com # 다른 매장

오늘 하루는 데모 상태가 유지된다 — 시드가 오늘까지 관측을 채워 두어 지도 화면의 백그라운드
재스캔이 돌지 않고, 스케줄러의 스캔도 하루 한 번 잠금에 걸린다. 내일부터는 실제 스캔이
돌면서 진짜 상권 상태로 수렴한다.

주의: 여기서 '폐업'으로 표시되는 가게는 실제로는 영업 중인 실제 카페다(데모용 표시일 뿐).
      확인이 끝나면 --reset으로 되돌리는 것을 권한다. 되돌리지 않아도 내일 이후 실제
      스캔이 돌면서 저절로 실제 상태로 수렴한다.
"""

import argparse
import sys
from datetime import date, timedelta

from app.core.database import SessionLocal
from app.models.ai import NearbyCafeWatch, SentNotification
from app.services.ai import nearby_cafe_service, nearby_watch_service

STORE = "s@gmail.com"


def _out(*args):
    """윈도우 콘솔(cp949)에서도 한글·이모지가 깨지지 않게 직접 인코딩해 쓴다."""
    sys.stdout.buffer.write((" ".join(str(a) for a in args) + "\n").encode("utf-8", "replace"))
    sys.stdout.buffer.flush()


def _store_point(db, store_id: str):
    point = nearby_watch_service.store_point(db, store_id)
    if not point:
        _out(f"[중단] {store_id} 계정에 매장 위치가 등록돼 있지 않습니다.")
        raise SystemExit(1)
    return point


def _clear(db, store_id: str) -> None:
    """관측 대장과 '주변 소식' 발송 이력을 비운다 — 시나리오를 처음부터 다시 만들기 위해."""
    n = db.query(NearbyCafeWatch).filter(NearbyCafeWatch.store_id == store_id).delete()
    keys = db.query(SentNotification).filter(
        SentNotification.store_id == store_id,
        SentNotification.category == "nearby",
    ).delete()
    db.commit()
    _out(f"기존 관측 {n}건 · 주변 소식 발송 이력 {keys}건 정리")


def _collect_real(lat: float, lon: float, store_name: str) -> list[dict]:
    """네이버에서 실제 주변 카페를 한 번 걷어 온다 (시나리오의 재료)."""
    found = nearby_cafe_service.find_nearby_cafes(
        lat, lon, radius_m=nearby_watch_service.WATCH_RADIUS_M, limit=60, exclude_name=store_name)
    return found["cafes"]


def seed(db, store_id: str) -> list[dict]:
    lat, lon = _store_point(db, store_id)
    store_name = nearby_watch_service.store_name_of(db, store_id)

    cafes = _collect_real(lat, lon, store_name)
    if len(cafes) < 5:
        _out(f"[중단] 수집된 카페가 {len(cafes)}곳뿐이라 시나리오를 만들 수 없습니다.")
        raise SystemExit(1)

    # 새로 생긴 것으로 쓸 가게는 '가장 먼 곳'을 고른다 — 평소 목록(상위 30곳)에 잘 안 잡히는
    # 자리라, 시드를 지운 뒤 실제 스캔이 돌아도 다시 신규로 뜨는 혼란이 적다.
    newcomer = cafes[-1]
    # 문을 닫는 것으로 쓸 가게는 세 번째로 가까운 곳 — 카드에서 바로 눈에 띄는 거리다.
    closing = cafes[2]
    baseline = [c for c in cafes if c["name"] != newcomer["name"]]

    _out(f"매장: {store_name or store_id} ({lat:.5f}, {lon:.5f})")
    _out(f"실제 수집: {len(cafes)}곳")
    _out(f"  · 신규 개업으로 쓸 실제 카페 : {newcomer['name']} ({newcomer['distance_m']}m)")
    _out(f"  · 폐업 추정으로 쓸 실제 카페 : {closing['name']} ({closing['distance_m']}m)")

    _clear(db, store_id)

    today = date.today()
    surviving = [c for c in baseline if c["name"] != closing["name"]]
    # (며칠 전인지, 그날 검색에 잡힌 카페들) — 마지막 날은 오늘이어야 한다.
    # 오늘까지 관측이 채워져 있어야 지도 화면을 열 때 백그라운드 재스캔이 돌지 않아
    # 방금 만든 시나리오가 실제 검색 결과로 덮이지 않는다.
    timeline = [
        (3, baseline),                      # 기준선
        (2, surviving),                     # 실종 1회
        (1, surviving + [newcomer]),        # 실종 2회 / 신규 1회
        (0, surviving + [newcomer]),        # 실종 3회 → 폐업 / 신규 2회 → 개업
    ]

    original = nearby_cafe_service.find_nearby_cafes
    try:
        for days_ago, visible in timeline:
            day = today - timedelta(days=days_ago)
            snapshot = list(visible)
            # 그날 '검색에 잡힌 것'만 돌려주도록 수집 함수를 갈아끼운다 (판정 로직은 진짜 그대로)
            nearby_cafe_service.find_nearby_cafes = (
                lambda *a, _s=snapshot, **kw: {"region": "", "radius_m": 1000,
                                               "count": len(_s), "cafes": _s, "cached": False}
            )
            result = nearby_watch_service.scan_cafe_changes(
                db, store_id, lat, lon, exclude_name=store_name, today=day)
            _out(f"  {day} 수집 {result['scanned']:>2}곳 → "
                 f"신규 {[c['name'] for c in result['opened']] or '-'} / "
                 f"폐업 {[c['name'] for c in result['closed']] or '-'}"
                 + (f"  (건너뜀: {result['skipped']})" if result["skipped"] else ""))
    finally:
        nearby_cafe_service.find_nearby_cafes = original

    changes = nearby_watch_service.recent_changes(db, store_id)
    _out("")
    _out(f"[결과] 관측 중 {changes['tracked']}곳 · 마지막 스캔 {changes['last_scan']}")
    for c in changes["opened"]:
        _out(f"  신규  {c['name']} · {c['distance_m']}m · {c['first_seen']}부터 확인됨")
    for c in changes["closed"]:
        _out(f"  폐업? {c['name']} · {c['distance_m']}m · {c['closed_on']}부터 검색에서 사라짐")
    if not changes["count"]:
        _out("  (변화 없음 — 시나리오가 제대로 들어가지 않았습니다)")
    return timeline[-1][1]


def _lock_today_scan(db, store_id: str) -> None:
    """오늘 몫의 스캔을 '이미 돌았다'고 표시한다.

    이게 없으면 오늘 도는 스케줄러가 실제 검색으로 한 번 더 훑으면서, 방금 폐업으로
    표시한 가게가 검색에 다시 잡혀 시나리오가 그 자리에서 풀린다. 알림 자체는 이 잠금과
    무관하게 나간다 — 규칙 8은 보낼 목록을 대장의 '아직 안 알린 변화'에서 가져오기 때문이다.
    """
    from sqlalchemy.exc import IntegrityError

    key = f"cafescan:{date.today().isoformat()}"
    if db.query(SentNotification).filter(SentNotification.store_id == store_id,
                                         SentNotification.dedupe_key == key).first():
        return
    db.add(SentNotification(store_id=store_id, dedupe_key=key, category="nearby",
                            title="[내부] 주변 카페 스캔", body=""))
    try:
        db.commit()
    except IntegrityError:
        db.rollback()


def notify_preview(db, store_id: str, today_snapshot: list[dict]) -> None:
    """알림 규칙 7·8을 실제로 돌려 '폰에 뜰 문구'를 찍는다 (FCM 발송만 가로챈다).

    오늘의 수집 결과는 시나리오와 같은 것으로 고정한다 — 규칙 8은 자기가 직접 한 번 훑는데,
    거기서 진짜 검색 결과가 들어오면 방금 만든 폐업·개업이 그 자리에서 되돌려진다.
    """
    from datetime import datetime

    from app.services.ai import notification_service, push_service

    settings = notification_service.get_settings(db, store_id)
    if not settings.push_enabled or not getattr(settings, "nearby_alert", True):
        _out("[안내] 이 매장은 푸시 또는 '주변 소식 알림'이 꺼져 있어 알림이 나가지 않습니다.")
        return

    outbox: list[dict] = []
    real_send = push_service.send_to_store
    real_find = nearby_cafe_service.find_nearby_cafes
    push_service.send_to_store = lambda db_, sid, title, body, data=None, urgent=False: (
        outbox.append({"title": title, "body": body, "data": data}) or 1)
    nearby_cafe_service.find_nearby_cafes = (
        lambda *a, _s=today_snapshot, **kw: {"region": "", "radius_m": 1000,
                                             "count": len(_s), "cafes": _s, "cached": False})

    # 알림은 오전 10시 이후에만 나간다 — 지금이 새벽이어도 문구는 확인할 수 있게 11시로 본다
    now = datetime.now(notification_service.KST).replace(hour=11, minute=0)
    try:
        notification_service.check_nearby_event(db, store_id, settings, now)
        notification_service.check_nearby_cafe(db, store_id, settings, now)
    finally:
        push_service.send_to_store = real_send
        nearby_cafe_service.find_nearby_cafes = real_find

    _out("")
    if not outbox:
        _out("[알림] 보낼 것이 없습니다 (이미 보낸 사건이거나 조건 미충족).")
        return
    _out(f"[알림] 사장님 폰에 뜰 내용 {len(outbox)}건")
    for msg in outbox:
        _out("  ┌ " + msg["title"])
        for line in (msg["body"] or "").split("\n"):
            _out("  │ " + line)
        _out(f"  └ 탭하면 → {msg['data'].get('screen')}")
    _out("")
    _out("실제 발송은 가로챘지만 중복 방지 이력은 남았습니다 — 오늘 스케줄러가 다시 보내지 않습니다.")


def reset(db, store_id: str) -> None:
    """데모 흔적을 지우고 오늘 실제 상태로 기준선을 다시 잡는다."""
    lat, lon = _store_point(db, store_id)
    store_name = nearby_watch_service.store_name_of(db, store_id)
    _clear(db, store_id)
    result = nearby_watch_service.scan_cafe_changes(
        db, store_id, lat, lon, exclude_name=store_name)
    _out(f"실제 상태로 기준선 재설정 — 카페 {result['scanned']}곳 (변화 0건이 정상)")


def main() -> None:
    parser = argparse.ArgumentParser(description="주변 상권 변화 데모 시드")
    parser.add_argument("--store", default=STORE, help="매장 식별자(로그인 이메일)")
    parser.add_argument("--reset", action="store_true", help="데모를 지우고 실제 상태로 되돌린다")
    parser.add_argument("--notify", action="store_true",
                        help="폰에 뜰 알림 문구를 미리 본다 (그 사건은 소진되어 다시 발송되지 않는다)")
    args = parser.parse_args()

    db = SessionLocal()
    try:
        if args.reset:
            reset(db, args.store)
            return
        snapshot = seed(db, args.store)
        if args.notify:
            notify_preview(db, args.store, snapshot)
        else:
            _lock_today_scan(db, args.store)
            _out("")
            _out("알림은 아직 보내지 않은 상태로 남겨 뒀습니다 — 스케줄러가 다음에 돌 때 실제로 발송됩니다.")
            _out("(문구만 먼저 보시려면 --notify)")
    finally:
        db.close()


if __name__ == "__main__":
    main()
