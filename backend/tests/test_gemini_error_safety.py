"""외부 AI 오류에서 API 키·내부 URL이 새지 않는지 검증."""

import httpx

from app.services.ai.gemini_config import safe_error_label
from app.services.ai import web_search_tools


def test_http_error_label_keeps_status_but_removes_secret_url():
    secret = "super-secret-gemini-key"
    request = httpx.Request("POST", f"https://example.test/generate?key={secret}")
    response = httpx.Response(403, request=request)
    error = httpx.HTTPStatusError("forbidden", request=request, response=response)

    label = safe_error_label(error)

    assert label == "HTTPStatusError (HTTP 403)"
    assert secret not in label
    assert "example.test" not in label


def test_non_http_error_label_only_exposes_error_type():
    label = safe_error_label(RuntimeError("DATABASE_URL=postgresql://secret"))

    assert label == "RuntimeError"
    assert "secret" not in label


def test_web_search_http_error_does_not_log_response_body(monkeypatch, caplog):
    secret = "private-account-detail"
    request = httpx.Request("POST", "https://api.tavily.com/search")
    response = httpx.Response(401, request=request, text=secret)

    class FakeClient:
        def __init__(self, **kwargs):
            pass

        def __enter__(self):
            return self

        def __exit__(self, *args):
            return False

        def post(self, *args, **kwargs):
            return response

    monkeypatch.setenv("TAVILY_API_KEY", "test-key")
    monkeypatch.setattr(web_search_tools.httpx, "Client", FakeClient)

    result = web_search_tools.web_search.invoke({"query": "카페 트렌드"})

    assert "HTTP 401" in result
    assert secret not in result
    assert secret not in caplog.text
