"""문자 발송 방식 실기기 점검 페이지 (백엔드 B)

[한글 주석] 왜 이런 페이지를 두는가:

  단골 알림은 사장님 폰의 기본 문자앱을 여는 방식(sms: 링크)이다.
  서버가 직접 문자를 못 보내기 때문인데(문자는 이동통신망으로 간다),
  이 방식은 기기와 기본 문자앱에 따라 본문이 안 채워지는 경우가 있다.

  특히 구분자가 OS마다 다르다 — iOS는 '&', 안드로이드는 '?'.
  잘못 쓰면 수신번호만 채워지고 본문이 비어서 열린다.
  둘 다 화면상으로는 '문자앱이 열렸다'라서 성공한 것처럼 보인다.

  문제는 이걸 개발 PC에서 확인할 수 없다는 것이다.
  앱을 새로 빌드해 폰에 깔아야 알 수 있는데, 그건 오래 걸린다.

  그래서 폰 브라우저로 열어 눌러보는 페이지를 둔다.
  sms: 스킴은 모바일 브라우저에서도 똑같이 동작하므로,
  여기서 본문이 채워지면 앱에서도 채워진다.
  안 되면 알림 전달 경로를 다시 설계해야 하므로 배포 전에 반드시 확인한다.
"""
import html as html_mod
import logging
from urllib.parse import quote

from fastapi import APIRouter
from fastapi.responses import HTMLResponse

logger = logging.getLogger(__name__)
router = APIRouter()

_SAMPLE_PHONE = "01012345678"
_SAMPLE_TEXT = "[브루노트] 60,000원 충전 완료. 잔액 60,000원\nhttp://example.com/b/AbCd1234"


@router.get("/sms-check", response_class=HTMLResponse, include_in_schema=False)
def sms_check_page():
    """폰 브라우저로 열어 문자앱이 본문까지 채우는지 확인한다."""
    body = quote(_SAMPLE_TEXT)
    ios_url = f"sms:{_SAMPLE_PHONE}&body={body}"
    and_url = f"sms:{_SAMPLE_PHONE}?body={body}"

    # EUC-KR 기준 바이트 수 — 국내 SMS 단문 한도(90)는 UTF-8이 아니라 이 기준이다
    try:
        n = len(_SAMPLE_TEXT.encode("euc-kr"))
    except UnicodeEncodeError:
        n = len(_SAMPLE_TEXT.encode("utf-8"))

    return HTMLResponse(f"""<!DOCTYPE html>
<html lang="ko"><head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="robots" content="noindex,nofollow">
<title>문자 발송 점검</title>
<style>
  body {{ margin:0; padding:20px 16px 60px; background:#FAF9F6; color:#4E3629;
         font-family:-apple-system,BlinkMacSystemFont,"Apple SD Gothic Neo","Malgun Gothic",sans-serif; }}
  .wrap {{ max-width:420px; margin:0 auto; }}
  h1 {{ font-size:18px; margin:0 0 6px; }}
  p.lead {{ font-size:13px; color:#8C6F56; line-height:1.7; margin:0 0 18px; }}
  .card {{ background:#FFF; border-radius:14px; padding:16px; margin-bottom:14px;
           box-shadow:0 6px 18px rgba(78,54,41,.06); }}
  .label {{ font-size:11.5px; color:#8C6F56; margin-bottom:6px; }}
  pre {{ background:#F4F1EE; border-radius:8px; padding:10px; font-size:12px;
         white-space:pre-wrap; word-break:break-all; margin:0 0 12px; line-height:1.6; }}
  a.btn {{ display:block; padding:18px; border-radius:12px; background:#2E2521;
           color:#FFF; text-align:center; font-size:16px; font-weight:700;
           text-decoration:none; margin-bottom:10px; }}
  a.alt {{ background:#8C6F56; }}
  .ok {{ font-size:12.5px; color:#2E7D32; line-height:1.7; }}
  .bad {{ font-size:12.5px; color:#B23B2E; line-height:1.7; }}
  ol {{ font-size:13px; line-height:1.9; padding-left:20px; margin:0; }}
  .meta {{ font-size:11px; color:#B0A79E; margin-top:14px; line-height:1.6; }}
</style></head>
<body><div class="wrap">
  <h1>문자 발송 점검</h1>
  <p class="lead">
    단골 알림이 실제 폰에서 되는지 확인하는 페이지입니다.<br>
    <b>반드시 휴대폰 브라우저로 열어</b> 아래 버튼을 눌러 주세요.
  </p>

  <div class="card">
    <div class="label">보내질 문구 ({n}바이트 / 단문 한도 90)</div>
    <pre>{html_mod.escape(_SAMPLE_TEXT)}</pre>
    <div class="label">받는 번호 (예시)</div>
    <pre>{_SAMPLE_PHONE}</pre>
  </div>

  <a class="btn" href="{html_mod.escape(and_url)}">안드로이드용 — 눌러보기</a>
  <a class="btn alt" href="{html_mod.escape(ios_url)}">아이폰용 — 눌러보기</a>

  <div class="card">
    <div class="label">확인할 것</div>
    <ol>
      <li>문자앱이 열리는가</li>
      <li>받는 사람에 번호가 채워졌는가</li>
      <li><b>본문에 문구와 링크가 채워졌는가</b></li>
      <li>줄바꿈이 살아 있는가</li>
    </ol>
    <p class="ok" style="margin:12px 0 0">
      3번까지 되면 정상입니다. 그대로 쓰시면 됩니다.
    </p>
    <p class="bad" style="margin:6px 0 0">
      문자앱은 열리는데 본문이 비어 있으면 구분자가 안 맞는 것입니다.
      어느 버튼이 됐는지 알려주세요 — 코드를 그쪽으로 맞추겠습니다.
    </p>
  </div>

  <p class="meta">
    구분자가 OS마다 다릅니다(iOS는 &amp;, 안드로이드는 ?).<br>
    둘 다 '문자앱이 열림'까지는 같아서 본문을 봐야 구분됩니다.<br>
    ※ 실제로 보내지 마시고 확인만 하신 뒤 닫으세요.
  </p>
</div></body></html>""")
