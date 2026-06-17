"""Offline tests for the query builder + normalization.

These assert the Python builder compiles to byte-identical canonical JSON as the
TS SDK — the contract that keeps every language on one wire format. No server
required: ``QueryBuilder`` is fed a fake list function.
"""

from __future__ import annotations

from typing import Any

from backlex import normalize_condition
from backlex.query import QueryBuilder


def _qb() -> QueryBuilder:
    captured: dict[str, Any] = {}

    def fake_list(q: Any) -> Any:
        captured["q"] = q
        return {"data": [], "limit": 0, "offset": 0}

    qb = QueryBuilder(fake_list)
    qb._captured = captured  # type: ignore[attr-defined]
    return qb


def test_leaf_and_logical() -> None:
    qb = _qb()
    qb.where(lambda f: f.and_(f.eq("status", "active"), f.gte("total", 100)))
    assert qb.to_query()["filter"] == {
        "$and": [{"status": {"_eq": "active"}}, {"total": {"_gte": 100}}]
    }


def test_relation_hop_prefixes_keys() -> None:
    qb = _qb()
    qb.where(lambda f: f.rel("customer", lambda c: c.eq("tier", "gold")))
    assert qb.to_query()["filter"] == {"customer.tier": {"_eq": "gold"}}


def test_now_relative_date() -> None:
    qb = _qb()
    qb.where(lambda f: f.gte("placed_at", f.now(sub={"months": 1})))
    assert qb.to_query()["filter"] == {"placed_at": {"_gte": {"$now": {"sub": {"months": 1}}}}}


def test_full_query_assembly() -> None:
    qb = _qb()
    q = (
        qb.where(lambda f: f.eq("published", True))
        .select("id", "title")
        .order_by("-created_at", "id")
        .limit(50)
        .offset(10)
        .with_meta("filter_count")
        .to_query()
    )
    assert q == {
        "filter": {"published": {"_eq": True}},
        "fields": ["id", "title"],
        "sort": ["-created_at", "id"],
        "limit": 50,
        "offset": 10,
        "meta": "filter_count",
    }


def test_normalize_implicit_equality_and_aliases() -> None:
    assert normalize_condition({"status": "active"}) == {"status": {"_eq": "active"}}
    assert normalize_condition({"_and": [{"a": 1}]}) == {"$and": [{"a": {"_eq": 1}}]}
    assert normalize_condition({"_not": {"a": 1}}) == {"$not": {"a": {"_eq": 1}}}
    # Idempotent.
    once = normalize_condition({"status": "active"})
    assert normalize_condition(once) == once


def test_raw_filter_escape_hatch() -> None:
    qb = _qb()
    qb.filter({"$or": [{"a": {"_eq": 1}}, {"b": {"_eq": 2}}]})
    assert qb.to_query()["filter"] == {"$or": [{"a": {"_eq": 1}}, {"b": {"_eq": 2}}]}
