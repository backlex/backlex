"""End-to-end tour of the Python SDK.

Run against a local dev server:

    BACKLEX_URL=http://localhost:5173 BACKLEX_KEY=pak_... python examples/quickstart.py
"""

from __future__ import annotations

import os

from backlex import BacklexError, create_client


def main() -> None:
    url = os.environ.get("BACKLEX_URL", "http://localhost:5173")
    key = os.environ.get("BACKLEX_KEY")  # pak_... server key

    client = create_client(url, api_key=key)

    # --- Query builder: compiles to canonical JSON, same wire format as TS ---
    q = (
        client.from_("posts")
        .query()
        .where(
            lambda f: f.and_(
                f.eq("published", True),
                f.gte("views", 100),
                f.rel("author", lambda a: a.eq("tier", "gold")),
                f.gte("created_at", f.now(sub={"days": 7})),
            )
        )
        .select("id", "title", "author.name")
        .order_by("-created_at")
        .limit(10)
        .with_meta("filter_count")
    )
    print("compiled query:", q.to_query())

    try:
        res = q.list()
        print(f"got {len(res['data'])} posts (filter_count={res.get('meta', {})})")
    except BacklexError as e:
        print(f"list failed: {e.status} {e.code} — {e}")

    # --- CRUD ---------------------------------------------------------------
    # created = client.from_("posts").create({"title": "Hello from Python"})
    # client.from_("posts").update(created["data"]["id"], {"title": "Edited"})
    # client.from_("posts").delete(created["data"]["id"])

    # --- Realtime (SSE on a background thread) ------------------------------
    # unsub = client.subscribe("items:posts", lambda ev: print("event:", ev["event"]))
    # ... do work ...
    # unsub()

    client.close()


if __name__ == "__main__":
    main()
