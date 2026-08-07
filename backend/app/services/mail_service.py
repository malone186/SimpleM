"""커스텀 비밀번호 재설정 메일 (백엔드 B)

로그인이 Firebase 비밀번호를 검증하므로, 재설정도 반드시 'Firebase 비밀번호'를 바꿔야 한다.
그래서 우리가 링크를 직접 만들지 않고, Firebase Identity Toolkit의 재설정 링크(oobLink)를
받아 그 링크를 우리 문구/디자인의 메일에 담아 보낸다. 링크를 누르면 Firebase가 비밀번호를
바꿔 주므로 앱 로그인이 바로 된다.

두 가지가 있어야 동작한다 (없으면 custom_reset_available()=False → 호출부가 Firebase 기본
메일로 폴백):
  1) FCM_SERVICE_ACCOUNT_JSON  — 링크 생성용(Identity Toolkit admin). FCM에 쓰는 그 서비스계정.
  2) MAIL_SMTP_* / MAIL_FROM    — 발송용 SMTP (Brevo/Resend/SendGrid/SES 등 아무거나. env로 설정)
"""
import json
import logging
import os
import smtplib
import ssl
from email.message import EmailMessage
from typing import Optional

import httpx

logger = logging.getLogger(__name__)

# 링크 생성에 필요한 스코프 (푸시용 messaging 스코프와 별개 — 여기선 계정/재설정 admin)
_IDENTITY_SCOPE = "https://www.googleapis.com/auth/identitytoolkit"

# 이메일 상단 로고 — Gmail은 base64/data-URI 이미지를 막으므로 CID 인라인 첨부로 넣는다.
_LOGO_PATH = os.path.join(os.path.dirname(__file__), "..", "static", "email", "brewnote_logo.png")


def _logo_bytes() -> Optional[bytes]:
    """이메일에 넣을 로고 바이트. 파일이 없으면 None (로고 없이 발송)."""
    try:
        with open(_LOGO_PATH, "rb") as f:
            return f.read()
    except Exception:
        return None


class MailError(RuntimeError):
    """재설정 링크 생성 또는 메일 발송 실패."""


# ---------------------------------------------------------------------------
# 1) 서비스 계정 → Identity Toolkit 재설정 링크(oobLink) 생성
# ---------------------------------------------------------------------------

def _service_account_info() -> Optional[dict]:
    """FCM_SERVICE_ACCOUNT_JSON을 dict로 읽는다 (JSON 내용 또는 파일 경로 모두 허용)."""
    raw = os.getenv("FCM_SERVICE_ACCOUNT_JSON", "").strip()
    if not raw:
        return None
    try:
        return json.loads(raw)
    except (json.JSONDecodeError, ValueError):
        if os.path.exists(raw):
            try:
                with open(raw, encoding="utf-8") as f:
                    return json.load(f)
            except Exception:
                return None
    return None


def _admin_token_and_project() -> tuple[Optional[str], Optional[str]]:
    """서비스 계정으로 Identity Toolkit admin 액세스 토큰을 발급한다."""
    info = _service_account_info()
    if not info:
        return None, None
    try:
        from google.oauth2 import service_account
        import google.auth.transport.requests

        creds = service_account.Credentials.from_service_account_info(
            info, scopes=[_IDENTITY_SCOPE])
        creds.refresh(google.auth.transport.requests.Request())
        return creds.token, info.get("project_id")
    except Exception as e:
        logger.warning("Identity Toolkit 토큰 발급 실패: %s", e)
        return None, None


def generate_reset_link(email: str, continue_url: str = "") -> Optional[str]:
    """이메일의 Firebase 재설정 링크를 만든다. 메일은 발송하지 않고 링크만 돌려준다.

    해당 이메일의 Firebase 계정이 없으면 None (이메일 열거 방지를 위해 호출부가 조용히 성공 처리).
    """
    token, project_id = _admin_token_and_project()
    if not token or not project_id:
        raise MailError("재설정 링크 생성용 서비스 계정이 설정되지 않았습니다.")

    body: dict = {"requestType": "PASSWORD_RESET", "email": email, "returnOobLink": True}
    if continue_url:
        body["continueUrl"] = continue_url
    try:
        resp = httpx.post(
            f"https://identitytoolkit.googleapis.com/v1/projects/{project_id}/accounts:sendOobCode",
            headers={"Authorization": f"Bearer {token}"},
            json=body,
            timeout=15,
        )
    except Exception as e:
        raise MailError(f"재설정 링크 요청 실패: {e}")

    if resp.status_code == 400 and "EMAIL_NOT_FOUND" in resp.text:
        logger.info("재설정 링크 생략 — Firebase 계정 없음: %s", email)
        return None  # 해당 Firebase 계정 없음 — 조용히 넘긴다
    if resp.status_code >= 400:
        raise MailError(f"재설정 링크 생성 실패({resp.status_code})")
    return resp.json().get("oobLink")


def provision_firebase_account(email: str) -> bool:
    """백엔드 DB에만 있는 가입자의 Firebase 계정을 만들어 준다 (임의 비밀번호).

    로그인이 Firebase 비밀번호를 검증하는데, mock 모드에서 가입한(백엔드 전용) 계정은
    Firebase에 없어서 재설정 링크 생성이 EMAIL_NOT_FOUND로 끝난다 → 메일이 조용히 안 나갔다.
    계정을 만들어 두면 재설정 링크가 동작하고, 링크에서 설정한 새 비밀번호로 Firebase
    로그인이 된다. 임의 비밀번호는 아무도 모르는 값이라 이 계정으로 몰래 로그인할 수 없고,
    기존 비밀번호의 백엔드 폴백 로그인도 그대로 동작한다.
    """
    token, project_id = _admin_token_and_project()
    if not token or not project_id:
        return False
    import secrets
    try:
        resp = httpx.post(
            f"https://identitytoolkit.googleapis.com/v1/projects/{project_id}/accounts",
            headers={"Authorization": f"Bearer {token}"},
            json={"email": email, "password": secrets.token_urlsafe(24), "emailVerified": False},
            timeout=15,
        )
    except Exception as e:
        logger.warning("Firebase 계정 프로비저닝 실패(%s): %s", email, e)
        return False
    if resp.status_code >= 400:
        logger.warning("Firebase 계정 프로비저닝 실패(%s): HTTP %s", email, resp.status_code)
        return False
    logger.info("Firebase 계정 프로비저닝 완료(재설정용): %s", email)
    return True


# ---------------------------------------------------------------------------
# 2) SMTP로 커스텀 메일 발송
# ---------------------------------------------------------------------------

def smtp_configured() -> bool:
    return all(os.getenv(k) for k in ("MAIL_SMTP_HOST", "MAIL_SMTP_USER",
                                      "MAIL_SMTP_PASSWORD", "MAIL_FROM"))


def _build_message(to_email: str, link: str) -> EmailMessage:
    from email.utils import make_msgid

    sender = os.getenv("MAIL_FROM", "")
    sender_name = os.getenv("MAIL_FROM_NAME", "브루노트")
    msg = EmailMessage()
    msg["Subject"] = "[브루노트] 비밀번호 재설정 안내"
    msg["From"] = f"{sender_name} <{sender}>"
    msg["To"] = to_email

    logo = _logo_bytes()
    logo_cid = make_msgid(domain="brewnote") if logo else None
    logo_img = (
        f'<img src="cid:{logo_cid[1:-1]}" alt="브루노트" width="240" '
        'style="display:block;width:240px;max-width:80%;height:auto;margin:0 auto 20px"/>'
        if logo_cid else ""
    )

    text = (
        "안녕하세요, 브루노트입니다.\n\n"
        "비밀번호 재설정 요청이 접수되었습니다. 아래 링크에서 새 비밀번호를 설정해 주세요.\n\n"
        f"{link}\n\n"
        "본인이 요청하지 않으셨다면 이 메일을 무시하셔도 됩니다. 비밀번호는 변경되지 않습니다.\n\n"
        "- 브루노트 드림"
    )
    msg.set_content(text)
    # 카드 배경(#FCF8F4)은 로고 PNG의 배경색과 동일하게 — 로고가 네모 티 없이 녹아든다.
    # 버튼·링크(#473017)는 로고의 BREWNOTE 글자색과 같은 딥 에스프레소 브라운.
    msg.add_alternative(
        f"""<!doctype html><html><body style="margin:0;background:#EFE5D6;padding:24px;font-family:'Apple SD Gothic Neo',sans-serif;color:#3E2F23">
  <div style="max-width:480px;margin:0 auto;background:#FCF8F4;border-radius:16px;padding:28px">
    {logo_img}
    <h1 style="font-size:20px;margin:0 0 6px;text-align:center">비밀번호 재설정</h1>
    <p style="color:#7A6A5A;font-size:14px;line-height:1.6;margin:0 0 20px;text-align:center;word-break:keep-all">
      안녕하세요, 브루노트입니다.<br/>비밀번호 재설정 요청이 접수되었습니다.<br/>
      아래 버튼을 눌러<br/>새 비밀번호를 설정해 주세요.
    </p>
    <div style="text-align:center">
      <a href="{link}" style="display:inline-block;background:#473017;color:#fff;text-decoration:none;font-weight:800;padding:13px 24px;border-radius:12px;font-size:15px">비밀번호 재설정하기</a>
    </div>
    <p style="color:#A99C90;font-size:12px;line-height:1.6;margin:22px 0 0">
      버튼이 눌리지 않으면 이 주소를 브라우저에 붙여 넣으세요:<br/>
      <a href="{link}" style="color:#473017;word-break:break-all">{link}</a>
    </p>
    <p style="color:#A99C90;font-size:12px;line-height:1.6;margin:16px 0 0">
      본인이 요청하지 않으셨다면 이 메일을 무시하셔도 됩니다. 비밀번호는 변경되지 않습니다.
    </p>
  </div>
</body></html>""",
        subtype="html",
    )
    if logo:
        msg.get_payload()[-1].add_related(logo, maintype="image", subtype="png", cid=logo_cid)
    return msg


def _send(msg: EmailMessage) -> None:
    host = os.getenv("MAIL_SMTP_HOST", "")
    port = int(os.getenv("MAIL_SMTP_PORT", "587"))
    user = os.getenv("MAIL_SMTP_USER", "")
    password = os.getenv("MAIL_SMTP_PASSWORD", "")
    try:
        if port == 465:  # 암시적 SSL
            with smtplib.SMTP_SSL(host, port, timeout=20, context=ssl.create_default_context()) as s:
                s.login(user, password)
                s.send_message(msg)
        else:  # STARTTLS (587 등)
            with smtplib.SMTP(host, port, timeout=20) as s:
                s.starttls(context=ssl.create_default_context())
                s.login(user, password)
                s.send_message(msg)
    except Exception as e:
        raise MailError(f"메일 발송 실패: {e}")


# ---------------------------------------------------------------------------
# 공개 인터페이스
# ---------------------------------------------------------------------------

def custom_reset_available() -> bool:
    """커스텀 재설정 메일을 쓸 수 있는가 (서비스 계정 + SMTP 둘 다 설정됨)."""
    return _service_account_info() is not None and smtp_configured()


def send_password_reset(email: str, continue_url: str = "") -> bool:
    """Firebase 재설정 링크를 만들어 커스텀 메일로 보낸다. 발송했으면 True.

    해당 이메일의 Firebase 계정이 없으면 아무 일도 하지 않고 False를 돌려준다
    (열거 방지 — 호출부는 백엔드 DB 가입자면 프로비저닝 후 재시도, 아니면 성공 처리).
    """
    link = generate_reset_link(email, continue_url)
    if link is None:
        return False  # Firebase 계정 없음
    _send(_build_message(email, link))
    logger.info("비밀번호 재설정 메일 발송: %s", email)
    return True
