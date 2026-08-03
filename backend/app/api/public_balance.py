"""손님용 잔액 조회 페이지 (백엔드 B)

[한글 주석] 왜 앱 화면이 아니라 백엔드가 HTML을 직접 주는가:

  손님은 우리 앱을 깔지 않는다. 회원가입도 로그인도 하지 않는다.
  문자로 받은 링크를 누르면 바로 잔액이 보여야 한다.

  앱 안의 화면으로 만들면 로그인 화면을 먼저 만나거나, 웹 번들
  (수 MB)을 받느라 몇 초를 기다린다. 잔액 하나 보려고 그럴 이유가 없다.
  여기서 주는 페이지는 외부 리소스가 없어 한 번의 요청으로 끝난다.

  URL을 /api/v1/... 이 아니라 짧은 /b/{token}으로 둔 이유는 문자 때문이다.
  단문(SMS) 한도가 90바이트라 링크가 길면 그만큼 본문을 못 쓴다.
"""
import html as html_mod
import logging

from fastapi import APIRouter, Depends
from fastapi.responses import HTMLResponse
from sqlalchemy.orm import Session

from app.core.database import get_db
from app.models.membership import Customer
from app.models.user import User
from app.services import membership_service as svc

logger = logging.getLogger(__name__)
router = APIRouter()

_TX_SIGN = {"CHARGE": "+", "USE": "-", "REFUND": "-", "ADJUST": ""}


def _page(body: str, title: str = "잔액 조회") -> str:
    """공통 껍데기. 외부 폰트·스크립트를 쓰지 않아 오프라인에서도 즉시 뜬다."""
    return f"""<!DOCTYPE html>
<html lang="ko">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">
<meta name="robots" content="noindex,nofollow">
<title>{html_mod.escape(title)}</title>
<style>
  * {{ box-sizing: border-box; -webkit-tap-highlight-color: transparent; }}
  body {{
    margin: 0; padding: 20px 16px 40px;
    font-family: -apple-system, BlinkMacSystemFont, "Apple SD Gothic Neo",
                 "Malgun Gothic", sans-serif;
    background: #FAF9F6; color: #4E3629;
    -webkit-font-smoothing: antialiased;
  }}
  .wrap {{ max-width: 420px; margin: 0 auto; }}
  .shop {{ font-size: 13px; color: #8C6F56; margin-bottom: 4px; }}
  .who {{ font-size: 17px; font-weight: 700; margin-bottom: 16px; }}
  .balance-card {{
    background: #FFF; border-radius: 16px; padding: 22px 18px;
    box-shadow: 0 6px 18px rgba(78,54,41,0.06); margin-bottom: 16px;
    text-align: center;
  }}
  .balance-label {{ font-size: 12px; color: #8C6F56; }}
  .balance {{ font-size: 34px; font-weight: 800; letter-spacing: -0.5px; margin: 6px 0 0; }}
  .section {{ font-size: 12px; color: #8C6F56; margin: 0 0 8px 2px; }}
  .list {{ background: #FFF; border-radius: 14px; overflow: hidden;
           box-shadow: 0 6px 18px rgba(78,54,41,0.06); }}
  .row {{ display: flex; align-items: center; gap: 10px;
          padding: 13px 15px; border-bottom: 1px solid #F2EFEC; }}
  .row:last-child {{ border-bottom: none; }}
  .row .main {{ flex: 1; min-width: 0; }}
  .row .label {{ font-size: 13.5px; font-weight: 600; }}
  .row .memo {{ font-size: 11.5px; color: #9A8F86; margin-top: 2px;
                overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }}
  .row .date {{ font-size: 11px; color: #B0A79E; margin-top: 2px; }}
  .amt {{ font-size: 14px; font-weight: 700; white-space: nowrap; }}
  .amt.plus {{ color: #2E7D32; }}
  .amt.minus {{ color: #4E3629; }}
  .after {{ font-size: 10.5px; color: #B0A79E; text-align: right; margin-top: 2px; }}
  .empty {{ padding: 26px 16px; text-align: center; color: #9A8F86; font-size: 13px; }}
  .note {{ font-size: 11px; color: #B0A79E; line-height: 1.6;
           margin-top: 18px; text-align: center; }}
  .err {{ background: #FFF; border-radius: 14px; padding: 30px 20px;
          text-align: center; box-shadow: 0 6px 18px rgba(78,54,41,0.06); }}
  .err h1 {{ font-size: 16px; margin: 0 0 8px; }}
  .err p {{ font-size: 13px; color: #8C6F56; margin: 0; line-height: 1.6; }}
  @media (prefers-color-scheme: dark) {{
    body {{ background: #201A16; color: #F0E9E4; }}
    .balance-card, .list, .err {{ background: #2B2320; box-shadow: none; }}
    .row {{ border-bottom-color: #3A312C; }}
    .amt.minus {{ color: #F0E9E4; }}
  }}
</style>
</head>
<body><div class="wrap">{body}</div></body>
</html>"""


@router.get("/b/{token}", response_class=HTMLResponse, include_in_schema=False)
def public_balance_page(token: str, db: Session = Depends(get_db)):
    """문자로 받은 링크로 여는 잔액 페이지.

    [한글 주석] 조회만 가능하다. 여기서 차감할 수 있으면 손님이 자기 잔액을
    임의로 쓸 수 있게 되어 부정 사용이 생긴다. 차감은 사장님 앱에서만 한다.

    토큰이 틀려도 '있다/없다'를 구분해 알려주지 않는다 — 토큰을 무작위로
    넣어보며 유효한 것을 찾아내는 시도에 단서를 주지 않기 위해서다.
    """
    customer = db.query(Customer).filter(Customer.access_token == token).first()
    if not customer or not customer.is_active:
        return HTMLResponse(
            _page(
                '<div class="err"><h1>유효하지 않은 링크입니다</h1>'
                '<p>링크가 만료되었거나 주소가 잘못되었습니다.<br>'
                '매장에 문의해 주세요.</p></div>',
                "잔액 조회",
            ),
            status_code=404,
        )

    owner = db.query(User).filter(User.email == customer.store_id).first()
    shop = (getattr(owner, "store_name", None) or "브루노트") if owner else "브루노트"
    who = customer.name or svc.mask_phone(customer.phone)

    rows = []
    for t in svc.list_transactions(db, customer.id, 20):
        sign = _TX_SIGN.get(t.tx_type, "")
        cls = "plus" if t.amount > 0 else "minus"
        when = t.created_at.strftime("%m/%d") if t.created_at else ""
        memo = (
            f'<div class="memo">{html_mod.escape(t.memo)}</div>'
            if t.memo else ""
        )
        rows.append(
            f'<div class="row"><div class="main">'
            f'<div class="label">{html_mod.escape(svc.TX_LABELS.get(t.tx_type, t.tx_type))}</div>'
            f"{memo}"
            f'<div class="date">{when}</div></div>'
            f'<div><div class="amt {cls}">{sign}{abs(t.amount):,}원</div>'
            f'<div class="after">잔액 {t.balance_after:,}원</div></div></div>'
        )

    history = (
        f'<div class="list">{"".join(rows)}</div>'
        if rows
        else '<div class="list"><div class="empty">아직 이용 내역이 없습니다.</div></div>'
    )

    body = (
        f'<div class="shop">{html_mod.escape(shop)}</div>'
        f'<div class="who">{html_mod.escape(who)}님</div>'
        f'<div class="balance-card">'
        f'<div class="balance-label">사용하실 수 있는 잔액</div>'
        f'<div class="balance">{customer.balance or 0:,}원</div></div>'
        f'<div class="section">이용 내역</div>{history}'
        f'<div class="note">이 화면은 조회 전용입니다.<br>'
        f'매장에서 말씀해 주시면 잔액으로 결제해 드립니다.</div>'
    )
    return HTMLResponse(_page(body, f"{shop} 잔액 조회"))
