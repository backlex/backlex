"""backlex — official Python client.

    from backlex import create_client

    client = create_client("https://api.example.com", api_key="pak_...")
    posts = client.from_("posts").query().where(lambda f: f.eq("published", True)).list()
"""

from __future__ import annotations

from .client import Auth, Client, Collection, Storage, create_client
from .errors import BacklexError
from .query import FilterBuilder, QueryBuilder, normalize_condition
from .types import (
    AuthResult,
    AuthUser,
    Condition,
    Item,
    ItemEvent,
    ItemResponse,
    ListQuery,
    ListResponse,
)

__version__ = "0.0.1"

__all__ = [
    "create_client",
    "Client",
    "Collection",
    "Auth",
    "Storage",
    "QueryBuilder",
    "FilterBuilder",
    "normalize_condition",
    "BacklexError",
    "Condition",
    "Item",
    "ItemEvent",
    "ItemResponse",
    "ListQuery",
    "ListResponse",
    "AuthResult",
    "AuthUser",
    "__version__",
]
