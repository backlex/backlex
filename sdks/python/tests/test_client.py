"""HTTP-layer tests using ``httpx.MockTransport`` — no live server.

These pin the wire contract that the offline query tests can't: exact method +
path + query-string encoding + headers + body, plus auth-token capture and the
error envelope. The mock handler records each request so we can assert on it.
"""

from __future__ import annotations

import json
from typing import Any, List

import httpx
import pytest

from backlex import BacklexError, create_client


class Recorder:
    def __init__(self) -> None:
        self.requests: List[httpx.Request] = []

    def handler(self, request: httpx.Request) -> httpx.Response:
        self.requests.append(request)
        path = request.url.path
        if path.endswith("/sign-in/email"):
            return httpx.Response(200, json={"user": {"id": "u1", "email": "a@b.c"}, "token": "tok_123"})
        if path == "/api/items/missing":
            return httpx.Response(
                404, json={"error": {"code": "NOT_FOUND", "message": "no such collection"}}
            )
        if request.method == "DELETE":
            return httpx.Response(200, json={"ok": True})
        if request.method in ("POST", "PATCH"):
            return httpx.Response(200, json={"data": {"id": "x1"}})
        return httpx.Response(200, json={"data": [], "limit": 50, "offset": 0})

    @property
    def last(self) -> httpx.Request:
        return self.requests[-1]


def _client(rec: Recorder, **kw: Any) -> Any:
    http = httpx.Client(transport=httpx.MockTransport(rec.handler))
    return create_client("http://test", http=http, **kw)


def test_query_string_filter_is_not_double_encoded() -> None:
    rec = Recorder()
    client = _client(rec, api_key="pak_x")
    client.from_("orders").query().where(lambda f: f.eq("status", "active")).order_by(
        "-created_at"
    ).limit(5).list()

    req = rec.last
    assert req.method == "GET"
    assert req.url.path == "/api/items/orders"
    # httpx decodes params; the filter must round-trip to the canonical JSON,
    # proving no double percent-encoding happened on the wire.
    assert json.loads(req.url.params["filter"]) == {"status": {"_eq": "active"}}
    assert req.url.params["sort"] == "-created_at"
    assert req.url.params["limit"] == "5"


def test_api_key_bearer_header() -> None:
    rec = Recorder()
    client = _client(rec, api_key="pak_secret")
    client.from_("posts").list()
    assert rec.last.headers["authorization"] == "Bearer pak_secret"


def test_crud_methods_paths_and_body() -> None:
    rec = Recorder()
    client = _client(rec, api_key="pak_x")

    client.from_("posts").create({"title": "Hi"})
    assert rec.last.method == "POST"
    assert rec.last.url.path == "/api/items/posts"
    assert json.loads(rec.last.content) == {"title": "Hi"}

    client.from_("posts").update("p1", {"title": "Edit"})
    assert rec.last.method == "PATCH"
    assert rec.last.url.path == "/api/items/posts/p1"

    client.from_("posts").one("p1")
    assert rec.last.method == "GET"
    assert rec.last.url.path == "/api/items/posts/p1"

    client.from_("posts").one("p1", {"expand": "author", "locale": "tr"})
    assert rec.last.url.path == "/api/items/posts/p1"
    assert dict(rec.last.url.params)["expand"] == "author"
    assert dict(rec.last.url.params)["locale"] == "tr"

    out = client.from_("posts").delete("p1")
    assert rec.last.method == "DELETE"
    assert out == {"ok": True}


def test_app_mode_token_capture_and_replay() -> None:
    rec = Recorder()
    client = _client(rec, workspace="myapp")

    res = client.auth.sign_in("a@b.c", "pw")
    # sign-in hit the workspace-scoped auth surface
    assert rec.requests[-1].url.path == "/api/t/myapp/auth/sign-in/email"
    assert res["token"] == "tok_123"
    assert client.auth.get_token() == "tok_123"

    # subsequent data calls replay the captured token as a bearer
    client.from_("posts").list()
    assert rec.last.headers["authorization"] == "Bearer tok_123"

    client.auth.sign_out()
    assert client.auth.get_token() is None


def test_error_envelope_becomes_backlex_error() -> None:
    rec = Recorder()
    client = _client(rec, api_key="pak_x")
    with pytest.raises(BacklexError) as ei:
        client.from_("missing").list()
    assert ei.value.status == 404
    assert ei.value.code == "NOT_FOUND"
    assert str(ei.value) == "no such collection"


def test_query_extras_serialize() -> None:
    rec = Recorder()
    client = _client(rec)
    client.from_("posts").query().expand("author").locale("tr").search("hi").list()
    params = dict(rec.last.url.params)
    assert params.get("expand") == "author"
    assert params.get("locale") == "tr"
    assert params.get("q") == "hi"


def test_aggregate_hits_the_right_path() -> None:
    rec = Recorder()
    client = _client(rec)
    client.from_("orders").aggregate({"agg": "sum", "field": "total"})
    assert rec.last.method == "POST"
    assert rec.last.url.path == "/api/items/orders/aggregate"


def test_publish_unpublish_paths() -> None:
    rec = Recorder()
    client = _client(rec)
    client.from_("posts").publish("p1")
    assert rec.last.method == "POST"
    assert rec.last.url.path == "/api/items/posts/p1/publish"
    client.from_("posts").unpublish("p1")
    assert dict(rec.last.url.params).get("unpublish") == "1"


def test_tenant_header_is_sent() -> None:
    rec = Recorder()
    client = _client(rec, tenant="myapp")
    client.from_("posts").list()
    assert rec.last.headers.get("x-backlex-tenant") == "myapp"


def test_password_reset_hits_the_right_path() -> None:
    rec = Recorder()
    client = _client(rec)
    client.auth.request_password_reset("a@b.c")
    assert rec.last.url.path == "/api/auth/request-password-reset"


def test_change_password_hits_the_right_path() -> None:
    rec = Recorder()
    client = _client(rec)
    client.auth.change_password("new", "old")
    assert rec.last.url.path == "/api/auth/change-password"


def test_control_plane_auth_does_not_capture_token() -> None:
    rec = Recorder()
    client = _client(rec)  # no workspace → control-plane mode
    client.auth.sign_in("a@b.c", "pw")
    assert rec.last.url.path == "/api/auth/sign-in/email"
    # token only captured in app mode
    assert client.auth.get_token() is None
