"""직원 계정 접근 범위 제한 (백엔드 B)

[한글 주석] 왜 미들웨어로 한 곳에서 막는가:

  처음엔 민감한 엔드포인트마다 require_owner를 하나씩 걸었다.
  그런데 실제로 직원 토큰으로 찔러보니 재고·메뉴 원가·지출이 그대로 뚫려 있었다.
  '막을 것을 세는 방식'은 반드시 빠뜨린다 — 지금 179개인 경로를 다 훑어야 하고,
  앞으로 팀원이 추가하는 엔드포인트는 기본이 '열림'이라 또 뚫린다.

  그래서 뒤집었다. 직원에게 허용할 경로만 적고 나머지는 전부 막는다.
  새 기능이 생겨도 기본이 '닫힘'이라 조용히 새지 않는다.
  직원이 못 쓰는 게 확인되면 그때 화이트리스트에 한 줄 추가하면 된다.

  화면에서 감추는 것과는 별개다. 화면은 오해를 줄이려고 감추는 것이고,
  실제 차단은 여기서 한다. 토큰만 있으면 화면을 거치지 않고 부를 수 있기 때문이다.
"""
import logging

import jwt
from fastapi import Request
from fastapi.responses import JSONResponse

from app.core.auth import ALGORITHM, SECRET_KEY

logger = logging.getLogger(__name__)

# [한글 주석] 직원 계정이 접근할 수 있는 경로.
#
#   단골(membership): 계산대 업무 그 자체. 단 환불·집계 같은 건 이미 require_owner가 막는다.
#   직원 계정(staff-accounts): 로그인과 '내가 누구인지' 확인. 계정 관리는 require_owner가 막는다.
#   재고(inventory): 알바생이 재고를 확인하고 입고를 찍는 건 정상 업무다.
#   인증(auth): 토큰 관련 공통 경로.
#
#   여기 없는 것 — 경영 리포트·지출·매출·정산·급여·원두 분석·챗봇·POS·센서·관리자.
#   특히 챗봇은 매출·급여 조회 도구를 다 갖고 있어 열면 우회 통로가 된다.
STAFF_ALLOWED_PREFIXES = (
    "/api/v1/membership",
    "/api/v1/staff-accounts",
    "/api/v1/inventory",
    "/api/v1/auth",
)

# [한글 주석] 허용 범위 안에서도 막아야 하는 예외.
#
#   /inventory/menus 는 재고 화면에 속하지만 응답에 원가와 원가율이 실려 나온다
#   (아메리카노 판매가 3,000원 / 원가율 24.2%). 마진은 알바생이 볼 정보가 아니다.
#
#   차감할 때 필요한 메뉴 이름과 가격은 /membership/quick-menus가 따로 주므로
#   여기를 막아도 계산대 업무에는 지장이 없다.
STAFF_DENIED_PREFIXES = (
    "/api/v1/inventory/menus",
)

# 인증과 무관한 공개 경로 — 토큰을 보지 않는다
_PUBLIC_PREFIXES = ("/b/", "/s/", "/health", "/docs", "/openapi", "/redoc", "/console")


def is_blocked_for_staff(path: str) -> bool:
    """이 경로를 직원이 부를 수 없는가.

    [한글 주석] 판단을 미들웨어에서 떼어내 테스트할 수 있게 했다.
    권한은 조용히 뚫리는 종류의 버그라(에러가 아니라 '보이면 안 되는 게 보임')
    회귀를 자동으로 잡을 수 있어야 한다.
    """
    if path.startswith(_PUBLIC_PREFIXES):
        return False
    if path.startswith(STAFF_DENIED_PREFIXES):
        return True
    return not path.startswith(STAFF_ALLOWED_PREFIXES)


def _staff_id_from_request(request: Request):
    """요청에 실린 토큰이 직원 것이면 staff_id를 돌려준다."""
    auth = request.headers.get("authorization") or ""
    if not auth.lower().startswith("bearer "):
        return None
    token = auth[7:].strip()
    try:
        payload = jwt.decode(token, SECRET_KEY, algorithms=[ALGORITHM])
    except jwt.PyJWTError:
        # 사장님은 Firebase 토큰을 쓸 수도 있다 — 여기서 못 읽으면 직원이 아니다.
        # 실제 인증 여부는 get_current_user가 판단하므로 통과시킨다.
        return None
    return payload.get("staff_id")


async def staff_scope_middleware(request: Request, call_next):
    """직원 토큰이면 허용 목록 밖의 경로를 막는다."""
    path = request.url.path

    if request.method == "OPTIONS" or path.startswith(_PUBLIC_PREFIXES):
        return await call_next(request)

    staff_id = _staff_id_from_request(request)
    if staff_id and is_blocked_for_staff(path):
        logger.info("[직원 권한] 차단 %s %s (staff_id=%s)", request.method, path, staff_id)
        return JSONResponse(
            status_code=403,
            content={"detail": "직원 계정으로는 사용할 수 없는 기능입니다."},
        )

    return await call_next(request)
