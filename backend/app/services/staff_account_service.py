"""직원 로그인 계정 로직 (백엔드 B)

[한글 주석] 이 기능이 푸는 문제:

  계산대에 서는 사람은 대개 알바생인데, 지금은 잔액을 차감하려면
  사장님 계정으로 로그인해야 한다. 그 계정에는 매출·정산·급여·직원 명부가
  전부 보인다. 알바생에게 넘길 수 있는 계정이 아니다.

  그래서 '단골 차감은 되지만 돈 나가는 일과 급여는 못 보는' 계정을 만든다.

핵심 설계 — 토큰에 매장 이메일을 담는다:

  직원 이메일을 sub에 담으면 안 된다. 기존 API 150여 군데가
  current_user.email을 매장 식별자로 쓰고 있어서, 직원 이메일이 들어가면
  "재고 목록이 빈다", "엉뚱한 매장에 저장된다" 같은 일이 조용히 벌어진다.
  에러가 나면 차라리 낫지만 그렇지도 않다.

  그래서 sub에는 매장(사장님) 이메일을 그대로 넣고, staff_id를 따로 실어
  '누가 조작했는지'만 구분한다. 기존 코드는 아무것도 바뀌지 않는다.
"""
import logging
import re
import secrets
from datetime import datetime, timedelta, timezone
from typing import Any, Dict, List, Optional, Tuple

from sqlalchemy.orm import Session

from app.core.auth import ALGORITHM, SECRET_KEY, get_password_hash, verify_password
from app.models.membership import StaffAccount

logger = logging.getLogger(__name__)

# [한글 주석] 직원 토큰 유효기간.
#   계산대 기기는 하루 종일 켜져 있으므로 너무 짧으면 영업 중에 로그아웃된다.
#   반대로 무기한이면 퇴사자 폰에 계속 살아 있게 된다. 12시간이면 한 영업일을 덮는다.
STAFF_TOKEN_HOURS = 12

_LOGIN_ID_RE = re.compile(r"^[a-zA-Z0-9_]{3,20}$")


def _now() -> datetime:
    return datetime.now(timezone.utc)


def generate_password(length: int = 6) -> str:
    """초기 비밀번호 — 계산대에서 불러주고 입력하는 용도라 숫자로 짧게.

    [한글 주석] 강한 비밀번호가 아니다. 매장 안에서 쓰는 계정이고
    토큰 유효기간이 12시간이라 위험이 제한적이다.
    대신 사장님이 언제든 재발급할 수 있게 했다.
    """
    return "".join(secrets.choice("0123456789") for _ in range(length))


def create_staff_account(db: Session, store_id: str, name: str,
                         login_id: str,
                         employee_id: Optional[int] = None,
                         password: Optional[str] = None
                         ) -> Tuple[Optional[StaffAccount], str, Optional[str]]:
    """직원 계정을 만든다. (계정, 메시지, 초기비밀번호)를 돌려준다."""
    login_id = (login_id or "").strip()
    if not _LOGIN_ID_RE.match(login_id):
        return None, "아이디는 영문·숫자 3~20자로 지어 주세요.", None
    if not (name or "").strip():
        return None, "이름을 입력해 주세요.", None

    exists = db.query(StaffAccount).filter(StaffAccount.login_id == login_id).first()
    if exists:
        return None, "이미 사용 중인 아이디입니다.", None

    raw = password or generate_password()
    acc = StaffAccount(
        store_id=store_id,
        employee_id=employee_id,
        login_id=login_id,
        hashed_password=get_password_hash(raw),
        name=name.strip(),
    )
    db.add(acc)
    db.commit()
    db.refresh(acc)
    return acc, "직원 계정을 만들었습니다.", raw


def reset_password(db: Session, store_id: str,
                   staff_id: int) -> Tuple[bool, str, Optional[str]]:
    """비밀번호를 새로 발급한다 — 잊었거나 유출됐을 때."""
    acc = db.query(StaffAccount).filter(StaffAccount.id == staff_id).first()
    if not acc or acc.store_id != store_id:
        return False, "직원 계정을 찾을 수 없습니다.", None
    raw = generate_password()
    acc.hashed_password = get_password_hash(raw)
    db.commit()
    return True, "새 비밀번호를 발급했습니다.", raw


def set_active(db: Session, store_id: str, staff_id: int,
               active: bool) -> Tuple[bool, str]:
    """퇴사자 계정을 잠근다.

    [한글 주석] 지우지 않고 비활성화한다. 이 직원이 처리한 차감 기록이
    남아 있는데 계정을 지우면 '누가 했는지'를 되짚을 수 없게 된다.
    """
    acc = db.query(StaffAccount).filter(StaffAccount.id == staff_id).first()
    if not acc or acc.store_id != store_id:
        return False, "직원 계정을 찾을 수 없습니다."
    acc.is_active = active
    db.commit()
    return True, "사용 중지했습니다." if not active else "다시 사용할 수 있습니다."


def list_accounts(db: Session, store_id: str) -> List[Dict[str, Any]]:
    rows = (
        db.query(StaffAccount)
        .filter(StaffAccount.store_id == store_id)
        .order_by(StaffAccount.is_active.desc(), StaffAccount.created_at.desc())
        .all()
    )
    return [
        {
            "id": a.id,
            "name": a.name,
            "login_id": a.login_id,
            "is_active": a.is_active,
            "employee_id": a.employee_id,
            "last_login_at": a.last_login_at,
            "created_at": a.created_at,
        }
        for a in rows
    ]


# [무차별 대입 방어] 직원 비밀번호는 6자리 숫자(경우의 수 100만)라 시도 제한이 없으면
# 원격에서 몇 시간이면 뚫린다. 프로세스 메모리 기준 잠금(단일 인스턴스 배포 전제):
# 같은 login_id로 연속 실패가 _LOCK_THRESHOLD회면 _LOCK_MINUTES분 잠근다.
_FAILED: dict[str, tuple[int, "datetime"]] = {}
_LOCK_THRESHOLD = 5
_LOCK_MINUTES = 5


def _login_locked(login_id: str) -> bool:
    count, last = _FAILED.get(login_id, (0, None))
    if count < _LOCK_THRESHOLD or last is None:
        return False
    if _now() - last > timedelta(minutes=_LOCK_MINUTES):
        _FAILED.pop(login_id, None)  # 잠금 만료 — 카운터 리셋
        return False
    return True


def _record_login_failure(login_id: str) -> None:
    count, _ = _FAILED.get(login_id, (0, None))
    _FAILED[login_id] = (count + 1, _now())


def login(db: Session, login_id: str,
          password: str) -> Tuple[Optional[str], str, Optional[StaffAccount]]:
    """직원 로그인 — 성공하면 매장 이메일이 담긴 토큰을 준다."""
    import jwt

    clean_id = (login_id or "").strip()
    if _login_locked(clean_id):
        return None, "로그인 시도가 너무 많았어요. 5분 뒤에 다시 시도해 주세요.", None

    acc = (
        db.query(StaffAccount)
        .filter(StaffAccount.login_id == clean_id)
        .first()
    )
    # [한글 주석] 아이디가 없는 것과 비밀번호가 틀린 것을 구분해 알리지 않는다.
    # 구분해 주면 유효한 아이디를 찾아내는 시도에 단서가 된다.
    if not acc or not verify_password(password or "", acc.hashed_password):
        _record_login_failure(clean_id)
        return None, "아이디 또는 비밀번호가 올바르지 않습니다.", None
    _FAILED.pop(clean_id, None)  # 성공 — 실패 카운터 리셋
    if not acc.is_active:
        return None, "사용이 중지된 계정입니다. 사장님께 문의해 주세요.", None

    payload = {
        # 매장 이메일을 담는 게 핵심 — 기존 API의 store_id 계산이 그대로 동작한다
        "sub": acc.store_id,
        "staff_id": acc.id,
        "name": acc.name,
        "typ": "staff",
        "exp": _now() + timedelta(hours=STAFF_TOKEN_HOURS),
    }
    token = jwt.encode(payload, SECRET_KEY, algorithm=ALGORITHM)

    acc.last_login_at = _now()
    db.commit()
    return token, f"{acc.name}님 로그인되었습니다.", acc
