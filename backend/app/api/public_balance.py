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

from fastapi import APIRouter, Depends, Form
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
  .terms {{ background: #F4F1EE; border-radius: 12px; padding: 14px; margin-top: 16px; }}
  .terms-title {{ font-size: 12px; font-weight: 700; color: #6E5544; margin-bottom: 7px; }}
  .terms-item {{ font-size: 11.5px; color: #7A6E65; line-height: 1.7; }}
  .err {{ background: #FFF; border-radius: 14px; padding: 30px 20px;
          text-align: center; box-shadow: 0 6px 18px rgba(78,54,41,0.06); }}
  .err h1 {{ font-size: 16px; margin: 0 0 8px; }}
  .err p {{ font-size: 13px; color: #8C6F56; margin: 0; line-height: 1.6; }}
  .card {{ background: #FFF; border-radius: 16px; padding: 18px;
           box-shadow: 0 6px 18px rgba(78,54,41,0.06); margin-bottom: 14px; }}
  input[type=tel] {{
    width: 100%; padding: 14px 12px; font-size: 17px; border-radius: 10px;
    border: 1px solid rgba(140,111,86,0.25); background: #FAF9F6; color: inherit;
    margin-bottom: 10px;
  }}
  button {{
    width: 100%; padding: 15px; font-size: 16px; font-weight: 700;
    border: 0; border-radius: 12px; background: #2E2521; color: #FFF;
    cursor: pointer; font-family: inherit;
  }}
  button:disabled {{ opacity: .4; }}
  .agree {{ display: flex; gap: 8px; align-items: flex-start;
            font-size: 12px; color: #8C6F56; line-height: 1.5; margin: 10px 0 14px; }}
  .agree input {{ margin-top: 2px; width: 18px; height: 18px; flex: none; }}
  .big-btn {{ padding: 20px; font-size: 18px; }}
  .ok-box {{ background: #E9F5EA; color: #2E7D32; border-radius: 12px;
             padding: 16px; text-align: center; font-weight: 700; font-size: 15px;
             margin-bottom: 14px; }}
  @media (prefers-color-scheme: dark) {{
    body {{ background: #201A16; color: #F0E9E4; }}
    .balance-card, .list, .err, .card {{ background: #2B2320; box-shadow: none; }}
    .row {{ border-bottom-color: #3A312C; }}
    .amt.minus {{ color: #F0E9E4; }}
    input[type=tel] {{ background: #241E1B; border-color: #3A312C; }}
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

        # [한글 주석] 환불은 '잔액에서 뺀 금액'과 '실제로 받은 현금'이 다르다.
        #
        #   잔액 20,000원을 지우고 현금 16,667원을 드린 경우,
        #   amount(-20,000)를 그대로 보여주면 손님은 20,000원을 받았다고 읽는다.
        #   실제로 받은 건 16,667원이라 나중에 "덜 받았다"는 분쟁이 된다.
        #
        #   손님이 알아야 하는 건 '내 손에 들어온 돈'이므로 그걸 크게 쓰고,
        #   잔액이 얼마나 줄었는지는 보조로 적는다.
        if t.tx_type == "REFUND" and t.paid_amount is not None:
            main_amount = t.paid_amount
            extra = f'<div class="memo">잔액 {abs(t.amount):,}원 차감</div>'
        else:
            main_amount = abs(t.amount)
            extra = ""

        memo = (
            f'<div class="memo">{html_mod.escape(t.memo)}</div>'
            if t.memo else ""
        )
        rows.append(
            f'<div class="row"><div class="main">'
            f'<div class="label">{html_mod.escape(svc.TX_LABELS.get(t.tx_type, t.tx_type))}</div>'
            f"{memo}{extra}"
            f'<div class="date">{when}</div></div>'
            f'<div><div class="amt {cls}">{sign}{main_amount:,}원</div>'
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
        # [한글 주석] 손님이 알아야 할 사실만 적는다.
        #   약관 조항("제5조 환불은…")은 효력 여부가 법적 판단이라 여기 쓰지 않는다.
        #   대신 "이 매장에서만 쓴다", "환불은 실제 결제액 기준", "문의는 매장에"
        #   세 가지를 알리면 손님이 나중에 처음 알게 되는 상황이 없어진다.
        #   분쟁의 대부분은 조항이 없어서가 아니라 몰랐기 때문에 생긴다.
        f'<div class="terms">'
        f'<div class="terms-title">알아두실 점</div>'
        f'<div class="terms-item">· 잔액은 <b>{html_mod.escape(shop)}</b>에서만 사용하실 수 있습니다.</div>'
        f'<div class="terms-item">· 충전 시 지급된 보너스가 있는 경우, 환불은 '
        f'실제 결제하신 금액을 기준으로 계산됩니다.</div>'
        f'<div class="terms-item">· 환불·정정 문의는 매장으로 말씀해 주세요. '
        f'이 화면에서는 조회만 가능합니다.</div>'
        f'</div>'
        f'<div class="note">매장에서 말씀해 주시면 잔액으로 결제해 드립니다.</div>'
    )
    return HTMLResponse(_page(body, f"{shop} 잔액 조회"))


# ---------------------------------------------------------------------------
# 계산대 QR — 손님이 자기 폰으로 찍는다
#
# [한글 주석] 스캔 방향을 뒤집은 이유:
#   손님 QR을 사장님 앱이 읽으려면 앱에 카메라가 필요하고, 그러면 네이티브
#   재빌드를 해야 한다. 반대로 매장에 QR을 붙여두고 손님이 자기 폰의
#   기본 카메라로 찍게 하면 우리 앱에는 카메라가 아예 필요 없다.
#   iOS·안드로이드 모두 기본 카메라가 QR을 인식해 브라우저를 열어준다.
# ---------------------------------------------------------------------------

def _checkin_page(shop: str, token: str, customer=None,
                  message: str = "", requested: bool = False) -> str:
    """계산대 QR을 찍은 손님에게 보여줄 화면."""
    if requested and customer:
        # [한글 주석] 여기서 잔액과 이름을 보여주면 안 된다.
        #
        #   이 화면은 '번호만 입력하면' 나온다. 잔액을 띄우면 남의 번호를 아는
        #   사람이 그 사람의 잔액과 이름을 볼 수 있다.
        #   문자로 받는 링크는 추측 불가능한 토큰으로 잘 막아놨는데,
        #   QR 쪽에 뒷문을 열어두는 셈이 된다.
        #
        #   잔액 확인이 필요하면 문자로 받은 본인 링크로 가면 된다.
        #   여기서는 "요청이 전달됐다"만 알리면 목적을 다한다.
        body = (
            f'<div class="shop">{html_mod.escape(shop)}</div>'
            f'<div class="who">결제 요청</div>'
            f'<div class="ok-box">직원에게 전달되었습니다</div>'
            f'<div class="note">직원이 확인하고 결제해 드립니다.<br>'
            f'화면을 닫으셔도 됩니다.<br><br>'
            f'잔액은 충전 시 문자로 받으신 링크에서 확인하실 수 있습니다.</div>'
        )
        return _page(body, f"{shop} 결제 요청")

    # 번호 입력 + 동의
    err = f'<div class="err" style="margin-bottom:14px"><p>{html_mod.escape(message)}</p></div>' if message else ""
    body = (
        f'<div class="shop">{html_mod.escape(shop)}</div>'
        f'<div class="who">선불 회원 조회</div>'
        f'{err}'
        f'<div class="card">'
        f'<form method="post" action="/s/{html_mod.escape(token)}/request">'
        f'<input type="tel" name="phone" inputmode="numeric" autocomplete="tel" '
        f'placeholder="010-1234-5678" required>'
        f'<label class="agree"><input type="checkbox" name="agree" value="1" required>'
        f'<span>선불 잔액 조회·안내를 위해 휴대폰 번호 수집에 동의합니다. '
        f'번호는 이 목적 외에는 사용하지 않습니다.</span></label>'
        f'<button type="submit">확인</button></form></div>'
        f'<div class="note">아직 선불 회원이 아니시면 직원에게 충전을 요청해 주세요.</div>'
    )
    return _page(body, f"{shop} 선불 회원")


def _shop_name(db: Session, store_id: str) -> str:
    owner = db.query(User).filter(User.email == store_id).first()
    return (getattr(owner, "store_name", None) or "브루노트") if owner else "브루노트"


@router.get("/s/{token}", response_class=HTMLResponse, include_in_schema=False)
def store_checkin_page(token: str, db: Session = Depends(get_db)):
    """계산대에 붙여둔 QR을 찍으면 열리는 화면."""
    store_id = svc.store_by_qr_token(db, token)
    if not store_id:
        return HTMLResponse(
            _page('<div class="err"><h1>유효하지 않은 QR입니다</h1>'
                  '<p>매장에 문의해 주세요.</p></div>'), status_code=404)
    return HTMLResponse(_checkin_page(_shop_name(db, store_id), token))


@router.post("/s/{token}/request", response_class=HTMLResponse, include_in_schema=False)
def store_checkin_request(token: str, phone: str = Form(...),
                          db: Session = Depends(get_db)):
    """번호 확인 → 회원이면 결제 요청을 대기 줄에 세운다.

    [한글 주석] 여기서 회원을 새로 만들지 않는다.
    선불 잔액은 사장님이 돈을 받아야 생기는 것이라, 손님이 스스로 회원이 되어도
    잔액이 0이라 할 수 있는 게 없다. 오히려 빈 회원만 쌓인다.
    등록은 충전할 때 사장님이 하고, 여기서는 '이미 회원인지'만 확인한다.
    """
    store_id = svc.store_by_qr_token(db, token)
    if not store_id:
        return HTMLResponse(
            _page('<div class="err"><h1>유효하지 않은 QR입니다</h1>'
                  '<p>매장에 문의해 주세요.</p></div>'), status_code=404)

    shop = _shop_name(db, store_id)
    normalized = svc.normalize_phone(phone)
    if not normalized:
        return HTMLResponse(
            _checkin_page(shop, token, message="휴대폰 번호를 다시 확인해 주세요."),
            status_code=400)

    customer = (
        db.query(Customer)
        .filter(Customer.store_id == store_id, Customer.phone == normalized,
                Customer.is_active.is_(True))
        .first()
    )
    if not customer:
        # [한글 주석] 처음 온 손님이다. 예전엔 여기서 거부했는데,
        # 그러면 사장님이 번호를 대신 물어 적어야 한다 —
        # 잘못 들으면 그대로 틀리고, 동의도 사장님이 대신 체크하게 된다.
        # 손님이 직접 넣으면 오타가 없고 동의도 본인이 한다.
        return HTMLResponse(_signup_page(shop, token, normalized))

    svc.create_checkin(db, store_id, customer)
    return HTMLResponse(_checkin_page(shop, token, customer, requested=True))


def _signup_page(shop: str, token: str, phone: str, message: str = "") -> str:
    """처음 온 손님에게 이름을 받고 등록을 확정하는 화면."""
    err = (f'<div class="err" style="margin-bottom:14px"><p>{html_mod.escape(message)}</p></div>'
           if message else "")
    return _page(
        f'<div class="shop">{html_mod.escape(shop)}</div>'
        f'<div class="who">선불 회원 등록</div>'
        f'{err}'
        f'<div class="card">'
        f'<p style="font-size:13px;color:#8C6F56;line-height:1.7;margin:0 0 14px">'
        f'{html_mod.escape(phone)} 으로 등록합니다.<br>'
        f'이름을 넣어 주시면 직원이 알아보기 쉽습니다.</p>'
        f'<form method="post" action="/s/{html_mod.escape(token)}/signup">'
        f'<input type="hidden" name="phone" value="{html_mod.escape(phone)}">'
        f'<input type="tel" name="name" placeholder="이름 (선택)" '
        f'inputmode="text" style="font-size:16px">'
        f'<label class="agree"><input type="checkbox" name="agree" value="1" required>'
        f'<span>선불 잔액 조회·안내를 위해 휴대폰 번호와 이름 수집에 동의합니다. '
        f'이 목적 외에는 사용하지 않으며, 원하시면 매장에 삭제를 요청하실 수 있습니다.</span></label>'
        f'<button class="big-btn" type="submit">등록하고 충전 요청</button></form></div>'
        f'<div class="note">등록 후 직원에게 충전 금액을 말씀해 주세요.<br>'
        f'충전이 완료되면 잔액 확인 링크를 문자로 보내드립니다.</div>',
        f"{shop} 회원 등록",
    )


@router.post("/s/{token}/signup", response_class=HTMLResponse, include_in_schema=False)
def store_signup(token: str, phone: str = Form(...), name: str = Form(""),
                 agree: str = Form(""), db: Session = Depends(get_db)):
    """손님이 직접 등록한다.

    [한글 주석] 동의를 손님 본인이 하는 게 핵심이다.
    사장님이 대신 체크하는 건 사장님의 진술이지 손님의 동의가 아니다.
    consent_source='SELF'로 남겨 나중에 근거로 쓸 수 있게 한다.
    """
    store_id = svc.store_by_qr_token(db, token)
    if not store_id:
        return HTMLResponse(
            _page('<div class="err"><h1>유효하지 않은 QR입니다</h1>'
                  '<p>매장에 문의해 주세요.</p></div>'), status_code=404)

    shop = _shop_name(db, store_id)
    normalized = svc.normalize_phone(phone)
    if not normalized:
        return HTMLResponse(
            _checkin_page(shop, token, message="휴대폰 번호를 다시 확인해 주세요."),
            status_code=400)
    if not agree:
        return HTMLResponse(
            _signup_page(shop, token, normalized, "동의가 필요합니다."),
            status_code=400)

    customer, _ = svc.create_customer(db, store_id, normalized, name,
                                      consent_source="SELF")
    if not customer:
        return HTMLResponse(
            _signup_page(shop, token, normalized, "등록에 실패했습니다. 직원에게 문의해 주세요."),
            status_code=400)

    # 신규 등록은 충전부터 해야 하므로 결제 요청과 구분해서 줄에 세운다
    svc.create_checkin(db, store_id, customer, kind="SIGNUP")

    body = (
        f'<div class="shop">{html_mod.escape(shop)}</div>'
        f'<div class="who">등록 완료</div>'
        f'<div class="ok-box">직원에게 전달되었습니다</div>'
        f'<div class="note">충전하실 금액을 직원에게 말씀해 주세요.<br>'
        f'충전이 완료되면 잔액 확인 링크를 문자로 보내드립니다.</div>'
    )
    return HTMLResponse(_page(body, f"{shop} 등록 완료"))
