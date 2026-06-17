"""Error type mirrored from the TS SDK's ``BacklexError``.

The API returns errors as ``{ "error": { "code", "message", "details"? } }``;
this wraps that envelope so callers can branch on ``status`` / ``code`` instead
of parsing strings.
"""

from __future__ import annotations

from typing import Any, Optional


class BacklexError(Exception):
    """A non-2xx response from the backlex API.

    Attributes:
        status:  HTTP status code.
        code:    Machine-readable error code (e.g. ``"VALIDATION"``,
                 ``"UNAUTHORIZED"``); ``"UNKNOWN"`` if the body had no envelope.
        details: Optional structured details from the error envelope.
    """

    status: int
    code: str
    details: Optional[Any]

    def __init__(self, status: int, body: Optional[dict[str, Any]]) -> None:
        err = (body or {}).get("error") if isinstance(body, dict) else None
        message = (err or {}).get("message") or f"HTTP {status}"
        super().__init__(message)
        self.status = status
        self.code = (err or {}).get("code") or "UNKNOWN"
        self.details = (err or {}).get("details")

    def __repr__(self) -> str:  # pragma: no cover - debugging aid
        return f"BacklexError(status={self.status}, code={self.code!r}, message={str(self)!r})"
