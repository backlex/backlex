"""Fluent query builder + filter normalization.

A Python port of ``packages/client/src/query.ts`` and the schema-blind half of
``packages/core/src/condition.ts``. It is **not** a new wire format: every
builder compiles to the same canonical JSON ``Condition`` / ``ListQuery`` the
REST API already speaks, so permissions, AI plans, and serialization all stay on
the one grammar.

    rows = (
        client.from_("orders").query()
        .where(lambda f: f.and_(
            f.eq("status", "active"),
            f.gte("total", 100),
            f.rel("customer", lambda c: c.eq("tier", "gold")),  # -> "customer.tier"
            f.gte("placed_at", f.now(sub={"months": 1})),
        ))
        .select("id", "total", "customer.name")
        .order_by("-placed_at", "id")
        .limit(50)
        .list()
    )["data"]
"""

from __future__ import annotations

from typing import Any, Callable, Dict, List, Optional, cast

from .types import Condition, ListQuery, ListResponse

# ---------------------------------------------------------------------------
# normalize_condition — schema-blind subset (matches the SDK's usage, which
# never passes ``relationFields``: the builder already emits dotted keys).
# ---------------------------------------------------------------------------


def _is_plain_object(v: Any) -> bool:
    return isinstance(v, dict)


def _looks_like_comparison(o: Dict[str, Any]) -> bool:
    keys = list(o.keys())
    return len(keys) > 0 and all(k.startswith("_") for k in keys)


def normalize_condition(raw: Any) -> Condition:
    """Turn any accepted filter shape into the canonical ``Condition``.

    Handles ``$and`` / ``$or`` / ``$not`` (and their ``_`` aliases) and implicit
    equality (``{"status": "active"}`` -> ``{"status": {"_eq": "active"}}``).
    Idempotent. Non-dict input is returned unchanged.
    """
    if not _is_plain_object(raw):
        return cast(Condition, raw)

    and_ = raw.get("$and", raw.get("_and"))
    if isinstance(and_, list):
        return {"$and": [normalize_condition(c) for c in and_]}
    or_ = raw.get("$or", raw.get("_or"))
    if isinstance(or_, list):
        return {"$or": [normalize_condition(c) for c in or_]}
    not_ = raw.get("$not", raw.get("_not"))
    if not_ is not None:
        return {"$not": normalize_condition(not_)}

    out: Dict[str, Any] = {}
    for key, value in raw.items():
        if _is_plain_object(value) and _looks_like_comparison(value):
            out[key] = value
        elif _is_plain_object(value):
            # Unknown object shape (json literal, schema-blind nesting) — pass through.
            out[key] = value
        else:
            out[key] = {"_eq": value}
    return out


def _prefix_keys(cond: Condition, head: str) -> Condition:
    """Prefix every leaf field key of a condition with ``head.`` (relation hop)."""
    if isinstance(cond.get("$and"), list):
        return {"$and": [_prefix_keys(x, head) for x in cond["$and"]]}
    if isinstance(cond.get("$or"), list):
        return {"$or": [_prefix_keys(x, head) for x in cond["$or"]]}
    if cond.get("$not") is not None:
        return {"$not": _prefix_keys(cond["$not"], head)}
    return {f"{head}.{k}": v for k, v in cond.items()}


# ---------------------------------------------------------------------------
# FilterBuilder — the ``f`` passed to ``.where(lambda f: ...)``.
# Python keywords (and/or/not/in) get a trailing underscore.
# ---------------------------------------------------------------------------


class FilterBuilder:
    """Leaf + logical condition constructors. Each method returns a ``Condition``."""

    @staticmethod
    def _leaf(field: str, op: str, value: Any) -> Condition:
        return {field: {op: value}}

    def eq(self, field: str, value: Any) -> Condition:
        return self._leaf(field, "_eq", value)

    def neq(self, field: str, value: Any) -> Condition:
        return self._leaf(field, "_neq", value)

    def gt(self, field: str, value: Any) -> Condition:
        return self._leaf(field, "_gt", value)

    def gte(self, field: str, value: Any) -> Condition:
        return self._leaf(field, "_gte", value)

    def lt(self, field: str, value: Any) -> Condition:
        return self._leaf(field, "_lt", value)

    def lte(self, field: str, value: Any) -> Condition:
        return self._leaf(field, "_lte", value)

    def in_(self, field: str, values: List[Any]) -> Condition:
        return self._leaf(field, "_in", values)

    def nin(self, field: str, values: List[Any]) -> Condition:
        return self._leaf(field, "_nin", values)

    def between(self, field: str, lo: Any, hi: Any) -> Condition:
        return self._leaf(field, "_between", [lo, hi])

    def is_null(self, field: str, is_null: bool = True) -> Condition:
        return self._leaf(field, "_null", is_null)

    def empty(self, field: str) -> Condition:
        return self._leaf(field, "_empty", True)

    def nempty(self, field: str) -> Condition:
        return self._leaf(field, "_nempty", True)

    def contains(self, field: str, value: str) -> Condition:
        return self._leaf(field, "_contains", value)

    def icontains(self, field: str, value: str) -> Condition:
        return self._leaf(field, "_icontains", value)

    def starts_with(self, field: str, value: str) -> Condition:
        return self._leaf(field, "_starts_with", value)

    def ends_with(self, field: str, value: str) -> Condition:
        return self._leaf(field, "_ends_with", value)

    def and_(self, *conds: Condition) -> Condition:
        return {"$and": list(conds)}

    def or_(self, *conds: Condition) -> Condition:
        return {"$or": list(conds)}

    def not_(self, cond: Condition) -> Condition:
        return {"$not": cond}

    def rel(self, head: str, build: "Callable[[FilterBuilder], Condition]") -> Condition:
        """Traverse a relation: keys produced by ``build`` are prefixed ``head.``."""
        return _prefix_keys(build(FilterBuilder()), head)

    def now(
        self,
        add: Optional[Dict[str, int]] = None,
        sub: Optional[Dict[str, int]] = None,
    ) -> Dict[str, Any]:
        """Relative-date value, e.g. ``f.now(sub={"months": 1})``."""
        opts: Dict[str, Any] = {}
        if add is not None:
            opts["add"] = add
        if sub is not None:
            opts["sub"] = sub
        return {"$now": opts}


ListFn = Callable[[ListQuery], ListResponse]


class QueryBuilder:
    """Chainable assembler that compiles to a plain ``ListQuery``."""

    def __init__(self, list_fn: ListFn) -> None:
        self._list_fn = list_fn
        self._filter: Optional[Condition] = None
        self._sort: List[str] = []
        self._fields: List[str] = []
        self._limit: Optional[int] = None
        self._offset: Optional[int] = None
        self._meta: Optional[str] = None

    def where(self, build: Callable[[FilterBuilder], Condition]) -> "QueryBuilder":
        self._filter = normalize_condition(build(FilterBuilder()))
        return self

    def filter(self, cond: Condition) -> "QueryBuilder":
        """Replace the filter with a raw canonical condition (escape hatch)."""
        self._filter = normalize_condition(cond)
        return self

    def select(self, *fields: str) -> "QueryBuilder":
        self._fields.extend(fields)
        return self

    def order_by(self, *sorts: str) -> "QueryBuilder":
        self._sort.extend(sorts)
        return self

    def limit(self, n: int) -> "QueryBuilder":
        self._limit = n
        return self

    def offset(self, n: int) -> "QueryBuilder":
        self._offset = n
        return self

    def with_meta(self, m: str) -> "QueryBuilder":
        """Request an extra COUNT: ``"filter_count"``, ``"total_count"``, or ``"*"``."""
        self._meta = m
        return self

    def to_query(self) -> ListQuery:
        """Assemble the plain ``ListQuery`` — the canonical JSON the REST API takes."""
        q: ListQuery = {}
        if self._filter:
            q["filter"] = self._filter
        if self._sort:
            q["sort"] = self._sort
        if self._fields:
            q["fields"] = self._fields
        if self._limit is not None:
            q["limit"] = self._limit
        if self._offset is not None:
            q["offset"] = self._offset
        if self._meta:
            q["meta"] = self._meta
        return q

    def list(self) -> ListResponse:
        return self._list_fn(self.to_query())
