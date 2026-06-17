"""Wire types, mirrored from ``packages/client/src/types.ts``.

These are intentionally thin: the API speaks plain JSON, so responses arrive as
``dict`` / ``list``. ``TypedDict`` gives editors structure without forcing a
deserialization layer. The canonical ``Condition`` grammar is shared with the
TS SDK and the server — there is no Python-specific wire format.
"""

from __future__ import annotations

import sys
from typing import Any, Dict, List, Optional

if sys.version_info >= (3, 11):
    from typing import NotRequired, TypedDict
else:  # pragma: no cover - 3.9 / 3.10 fallback
    from typing_extensions import NotRequired, TypedDict

# A row from a collection. The SDK does not impose a schema — pair with
# ``backlex gen-types`` output (or hand-written ``TypedDict``s) for typing.
Item = Dict[str, Any]

# The canonical JSON filter grammar (``$and`` / ``$or`` / ``$not`` / leaf maps).
Condition = Dict[str, Any]

# Meta-count request flag.
MetaFlag = str  # "filter_count" | "total_count" | "*"


class ListResponse(TypedDict):
    """Result of a collection list/query call."""

    data: List[Item]
    limit: int
    offset: int
    meta: NotRequired[Dict[str, int]]


class ItemResponse(TypedDict):
    """Single-item envelope: ``{ "data": {...} }``."""

    data: Item


class ListQuery(TypedDict, total=False):
    """The query parameters a list/query call serializes into the URL."""

    filter: Condition
    sort: Any  # str | list[str]
    fields: Any  # str | list[str]
    expand: Any  # str | list[str] — inline single-hop relations
    limit: int
    offset: int
    meta: MetaFlag
    locale: str  # collapse i18n_text to one locale, or "*" for the full map
    q: str  # free-text search across readable text fields


class ItemEvent(TypedDict):
    """A realtime event frame: ``{ "event": ..., "data": {...} }``."""

    event: str  # "created" | "updated" | "deleted"
    data: Item


class AuthUser(TypedDict, total=False):
    id: str
    email: str
    name: Optional[str]
    image: Optional[str]


class AuthResult(TypedDict, total=False):
    user: AuthUser
    token: str
