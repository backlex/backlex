"""The backlex client — Python port of ``packages/client/src/index.ts``.

A thin, typed wrapper over the REST + SSE API. Three auth modes, mirrored from
the TS SDK:

* **Server-to-server** — pass ``api_key="pak_..."``; sent as a bearer on every call.
* **App mode** — pass ``workspace="<slug>"``; ``auth.*`` targets that workspace's
  own auth surface, and the session token from ``auth.sign_in`` / ``auth.sign_up``
  is captured and replayed as a bearer. Persist it with ``auth.get_token()`` and
  restore via ``create_client(token=...)``.
* **Cookie session** — omit both; the underlying ``httpx`` client keeps cookies.
"""

from __future__ import annotations

import json
from typing import Any, Dict, List, Optional, cast
from urllib.parse import quote, urlencode

import httpx

from .errors import BacklexError
from .query import QueryBuilder
from .realtime import OnError, OnEvent, Unsubscribe
from .realtime import subscribe as _sse_subscribe
from .types import (
    AuthResult,
    ItemResponse,
    ListQuery,
    ListResponse,
)


def _build_search(q: Optional[ListQuery]) -> str:
    """Serialize a ``ListQuery`` into a URL query string (mirrors ``buildSearch``)."""
    if not q:
        return ""
    params: List[tuple[str, str]] = []
    if q.get("filter"):
        params.append(("filter", json.dumps(q["filter"], separators=(",", ":"))))
    sort = q.get("sort")
    if sort:
        params.append(("sort", ",".join(sort) if isinstance(sort, list) else str(sort)))
    fields = q.get("fields")
    if fields:
        params.append(("fields", ",".join(fields) if isinstance(fields, list) else str(fields)))
    expand = q.get("expand")
    if expand:
        params.append(("expand", ",".join(expand) if isinstance(expand, list) else str(expand)))
    if q.get("limit") is not None:
        params.append(("limit", str(q["limit"])))
    if q.get("offset") is not None:
        params.append(("offset", str(q["offset"])))
    if q.get("meta"):
        params.append(("meta", q["meta"]))
    if q.get("locale"):
        params.append(("locale", q["locale"]))
    if q.get("q"):
        params.append(("q", q["q"]))
    s = urlencode(params)
    return f"?{s}" if s else ""


class Collection:
    """CRUD handle for one collection, returned by ``client.from_(slug)``."""

    def __init__(self, client: "Client", slug: str) -> None:
        self._client = client
        self._slug = slug

    def list(self, query: Optional[ListQuery] = None) -> ListResponse:
        return cast(
            ListResponse,
            self._client.request("GET", f"/api/items/{self._slug}{_build_search(query)}"),
        )

    def query(self) -> QueryBuilder:
        """Fluent, type-safe query builder that compiles to a ``ListQuery``."""
        return QueryBuilder(self.list)

    def aggregate(self, body: Dict[str, Any]) -> Dict[str, Any]:
        """Single-function aggregate (count/sum/avg/min/max), optionally grouped.

        ``body`` = ``{"agg": "sum", "field": "price", "groupBy": "status"}``.
        """
        return cast(
            Dict[str, Any], self._client.request("POST", f"/api/items/{self._slug}/aggregate", body)
        )

    def one(self, id: str, query: Optional[ListQuery] = None) -> ItemResponse:
        # The single-item endpoint accepts the same expand/locale params as list.
        return cast(
            ItemResponse,
            self._client.request("GET", f"/api/items/{self._slug}/{id}{_build_search(query)}"),
        )

    def create(self, data: Dict[str, Any]) -> ItemResponse:
        return cast(
            ItemResponse, self._client.request("POST", f"/api/items/{self._slug}", data)
        )

    def update(self, id: str, patch: Dict[str, Any]) -> ItemResponse:
        return cast(
            ItemResponse,
            self._client.request("PATCH", f"/api/items/{self._slug}/{id}", patch),
        )

    def delete(self, id: str) -> Dict[str, Any]:
        return cast(
            Dict[str, Any], self._client.request("DELETE", f"/api/items/{self._slug}/{id}")
        )

    def publish(self, id: str) -> ItemResponse:
        """Flip a versioned item to published."""
        return cast(
            ItemResponse, self._client.request("POST", f"/api/items/{self._slug}/{id}/publish")
        )

    def unpublish(self, id: str) -> ItemResponse:
        """Flip a versioned item back to draft."""
        return cast(
            ItemResponse,
            self._client.request("POST", f"/api/items/{self._slug}/{id}/publish?unpublish=1"),
        )


class Auth:
    """Auth surface. In app mode (``workspace`` set), targets the workspace pool."""

    def __init__(self, client: "Client") -> None:
        self._client = client

    @property
    def _base(self) -> str:
        ws = self._client._workspace
        return f"/api/t/{quote(ws)}/auth" if ws else "/api/auth"

    def _capture(self, result: AuthResult) -> AuthResult:
        if self._client._workspace and isinstance(result.get("token"), str):
            self._client._app_token = result["token"]
        return result

    def sign_up(self, email: str, password: str, name: Optional[str] = None) -> AuthResult:
        body: Dict[str, Any] = {"email": email, "password": password}
        if name is not None:
            body["name"] = name
        return self._capture(
            cast(AuthResult, self._client.request("POST", f"{self._base}/sign-up/email", body))
        )

    def sign_in(self, email: str, password: str) -> AuthResult:
        return self._capture(
            cast(
                AuthResult,
                self._client.request(
                    "POST", f"{self._base}/sign-in/email", {"email": email, "password": password}
                ),
            )
        )

    def sign_in_social(
        self,
        provider: str,
        callback_url: Optional[str] = None,
        error_callback_url: Optional[str] = None,
    ) -> Dict[str, Any]:
        """Begin an OAuth sign-in; returns ``{ "url", "redirect" }`` to navigate to."""
        body: Dict[str, Any] = {"provider": provider, "disableRedirect": True}
        if callback_url is not None:
            body["callbackURL"] = callback_url
        if error_callback_url is not None:
            body["errorCallbackURL"] = error_callback_url
        return cast(
            Dict[str, Any], self._client.request("POST", f"{self._base}/sign-in/social", body)
        )

    def sign_in_magic_link(
        self, email: str, callback_url: Optional[str] = None
    ) -> Dict[str, Any]:
        body: Dict[str, Any] = {"email": email}
        if callback_url is not None:
            body["callbackURL"] = callback_url
        return cast(
            Dict[str, Any],
            self._client.request("POST", f"{self._base}/sign-in/magic-link", body),
        )

    def send_verification_otp(self, email: str, type: str = "sign-in") -> Dict[str, Any]:
        """Email a one-time numeric code (requires the ``email-otp`` provider).

        ``type`` is ``"sign-in"`` (default), ``"email-verification"`` or
        ``"forget-password"``. Complete a sign-in with ``sign_in_email_otp``.
        """
        return cast(
            Dict[str, Any],
            self._client.request(
                "POST", f"{self._base}/email-otp/send-verification-otp",
                {"email": email, "type": type},
            ),
        )

    def sign_in_email_otp(self, email: str, otp: str) -> AuthResult:
        """Complete an email-OTP sign-in with the code from ``send_verification_otp``."""
        return self._capture(
            cast(
                AuthResult,
                self._client.request(
                    "POST", f"{self._base}/sign-in/email-otp", {"email": email, "otp": otp}
                ),
            )
        )

    def request_password_reset(self, email: str, redirect_to: Optional[str] = None) -> Dict[str, Any]:
        """Send a password-reset email. ``redirect_to`` is where the link points."""
        body: Dict[str, Any] = {"email": email}
        if redirect_to is not None:
            body["redirectTo"] = redirect_to
        return cast(
            Dict[str, Any],
            self._client.request("POST", f"{self._base}/request-password-reset", body),
        )

    def reset_password(self, new_password: str, token: str) -> Dict[str, Any]:
        """Complete a reset with the token from the email and a new password."""
        return cast(
            Dict[str, Any],
            self._client.request(
                "POST", f"{self._base}/reset-password", {"newPassword": new_password, "token": token}
            ),
        )

    def refresh(self) -> Dict[str, Any]:
        """Mint a fresh access JWT from the stored session token (app mode)."""
        return cast(
            Dict[str, Any],
            self._client.request(
                "POST", f"{self._base}/token/refresh", {"refreshToken": self._client._app_token}
            ),
        )

    def change_password(
        self, new_password: str, current_password: str, revoke_other_sessions: bool = False
    ) -> Dict[str, Any]:
        """Change the signed-in user's password (requires the current password)."""
        body: Dict[str, Any] = {
            "newPassword": new_password,
            "currentPassword": current_password,
            "revokeOtherSessions": revoke_other_sessions,
        }
        return cast(Dict[str, Any], self._client.request("POST", f"{self._base}/change-password", body))

    def update_user(self, attributes: Dict[str, Any]) -> Dict[str, Any]:
        """Update the signed-in user's profile (e.g. ``{"name": ..., "image": ...}``)."""
        return cast(
            Dict[str, Any], self._client.request("POST", f"{self._base}/update-user", attributes)
        )

    def send_verification_email(self, email: str, callback_url: Optional[str] = None) -> Dict[str, Any]:
        """Send an email-verification link."""
        body: Dict[str, Any] = {"email": email}
        if callback_url is not None:
            body["callbackURL"] = callback_url
        return cast(
            Dict[str, Any],
            self._client.request("POST", f"{self._base}/send-verification-email", body),
        )

    def sign_out(self) -> Dict[str, Any]:
        result = cast(Dict[str, Any], self._client.request("POST", f"{self._base}/sign-out"))
        if self._client._workspace:
            self._client._app_token = None
        return result

    def get_session(self) -> Dict[str, Any]:
        return cast(Dict[str, Any], self._client.request("GET", f"{self._base}/get-session"))

    def providers(self) -> Dict[str, Any]:
        """Public auth surface (provider list + policy flags) — no secrets."""
        r = cast(Dict[str, Any], self._client.request("GET", f"{self._base}/providers"))
        return cast(Dict[str, Any], r["data"])

    def get_token(self) -> Optional[str]:
        """The current workspace session token (app mode); persist across reloads."""
        return self._client._app_token

    def set_token(self, token: Optional[str]) -> None:
        self._client._app_token = token


class Storage:
    """File operations against ``/api/storage``."""

    def __init__(self, client: "Client") -> None:
        self._client = client

    def list(self, prefix: Optional[str] = None) -> Dict[str, Any]:
        path = "/api/storage"
        if prefix:
            path += f"?prefix={quote(prefix)}"
        return cast(Dict[str, Any], self._client.request("GET", path))

    def put(
        self,
        key: str,
        body: Any,
        content_type: Optional[str] = None,
        folder_id: Optional[str] = None,
    ) -> Dict[str, Any]:
        headers = dict(self._client._auth_header())
        if content_type:
            headers["content-type"] = content_type
        url = f"{self._client._url}/api/storage/{quote(key)}"
        if folder_id:
            url += f"?folderId={folder_id}"
        resp = self._client._http.put(url, headers=headers, content=body)
        if not resp.is_success:
            raise BacklexError(resp.status_code, _safe_json(resp))
        return cast(Dict[str, Any], resp.json())

    def download(self, key: str) -> httpx.Response:
        """Return the raw response; read the bytes via ``.content``."""
        resp = self._client._http.get(
            f"{self._client._url}/api/storage/{quote(key)}",
            headers=self._client._auth_header(),
        )
        if not resp.is_success:
            raise BacklexError(resp.status_code, None)
        return resp

    def delete(self, key: str) -> Dict[str, Any]:
        return cast(
            Dict[str, Any], self._client.request("DELETE", f"/api/storage/{quote(key)}")
        )


def _safe_json(resp: httpx.Response) -> Optional[dict[str, Any]]:
    try:
        return cast("dict[str, Any]", resp.json())
    except Exception:  # noqa: BLE001
        return None


class Client:
    """Top-level backlex client. Prefer the ``create_client`` factory."""

    def __init__(
        self,
        url: str,
        *,
        api_key: Optional[str] = None,
        workspace: Optional[str] = None,
        token: Optional[str] = None,
        tenant: Optional[str] = None,
        http: Optional[httpx.Client] = None,
    ) -> None:
        self._url = url.rstrip("/")
        self._api_key = api_key
        self._workspace = workspace
        self._app_token: Optional[str] = token
        self._tenant = tenant
        # ``follow_redirects`` keeps cookie-session flows working; the client
        # owns a cookie jar so same-origin sessions persist across calls.
        self._http = http or httpx.Client(follow_redirects=True)
        self.auth = Auth(self)
        self.storage = Storage(self)

    # -- internals -----------------------------------------------------------

    def _auth_header(self) -> Dict[str, str]:
        # Auth + optional explicit tenant scoping (slug or id), used by every
        # request path (data, storage, realtime).
        headers: Dict[str, str] = {}
        if self._api_key:
            headers["authorization"] = f"Bearer {self._api_key}"
        elif self._app_token:
            headers["authorization"] = f"Bearer {self._app_token}"
        if self._tenant:
            headers["x-backlex-tenant"] = self._tenant
        return headers

    def request(
        self,
        method: str,
        path: str,
        body: Any = None,
        extra_headers: Optional[Dict[str, str]] = None,
    ) -> Any:
        """Raw escape hatch — issues a request with auth headers applied."""
        headers: Dict[str, str] = {"content-type": "application/json", **self._auth_header()}
        if extra_headers:
            headers.update(extra_headers)
        resp = self._http.request(
            method,
            f"{self._url}{path}",
            headers=headers,
            content=None if body is None else json.dumps(body),
        )
        if not resp.is_success:
            raise BacklexError(resp.status_code, _safe_json(resp))
        if resp.status_code == 204 or not resp.content:
            return None
        return resp.json()

    # -- public surface ------------------------------------------------------

    def from_(self, slug: str) -> Collection:
        """CRUD handle for a collection (``from`` is a Python keyword)."""
        return Collection(self, slug)

    def subscribe(
        self,
        channel: str,
        on_event: OnEvent,
        on_error: Optional[OnError] = None,
    ) -> Unsubscribe:
        """Subscribe to a realtime channel (e.g. ``"items:posts"``). Returns an
        unsubscribe callable. Runs on a background daemon thread."""
        url = f"{self._url}/api/realtime/{channel}/subscribe"
        return _sse_subscribe(self._http, url, self._auth_header, on_event, on_error)

    def close(self) -> None:
        """Close the underlying HTTP client / cookie jar."""
        self._http.close()

    def __enter__(self) -> "Client":
        return self

    def __exit__(self, *exc: Any) -> None:
        self.close()


def create_client(
    url: str,
    *,
    api_key: Optional[str] = None,
    workspace: Optional[str] = None,
    token: Optional[str] = None,
    tenant: Optional[str] = None,
    http: Optional[httpx.Client] = None,
) -> Client:
    """Construct a :class:`Client`. Mirrors the TS ``createClient(opts)`` factory."""
    return Client(
        url, api_key=api_key, workspace=workspace, token=token, tenant=tenant, http=http
    )
