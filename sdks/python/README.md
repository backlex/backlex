# backlex — Python SDK

Official Python client for the backlex API. A thin, typed wrapper over the same
REST + SSE surface the TypeScript SDK (`@backlex/client`) speaks — CRUD, a fluent
query builder, auth, realtime, and storage.

This package is the **reference port** for backlex's multi-language SDK effort
(Python → Go → .NET/Java → Swift/Kotlin). It demonstrates the **hybrid** model:
hand-written ergonomic layer on top, optional OpenAPI-generated models
underneath (see [Hybrid codegen](#hybrid-codegen)).

```bash
pip install backlex
```

## Quickstart

```python
from backlex import create_client

client = create_client("https://api.example.com", api_key="pak_...")

# CRUD
post = client.from_("posts").create({"title": "Hello"})["data"]
client.from_("posts").update(post["id"], {"title": "Edited"})
client.from_("posts").delete(post["id"])

# Fluent query builder → compiles to canonical JSON (same wire format as TS)
rows = (
    client.from_("orders").query()
    .where(lambda f: f.and_(
        f.eq("status", "active"),
        f.gte("total", 100),
        f.rel("customer", lambda c: c.eq("tier", "gold")),   # → "customer.tier"
        f.gte("placed_at", f.now(sub={"months": 1})),
    ))
    .select("id", "total", "customer.name")
    .order_by("-placed_at", "id")
    .limit(50)
    .list()
)["data"]
```

## Auth

```python
# Server-to-server: pass api_key="pak_..." to create_client (bearer on every call).

# App mode — end-users of a workspace:
client = create_client("https://api.example.com", workspace="myapp")
res = client.auth.sign_in("user@example.com", "password")   # token auto-captured
token = client.auth.get_token()                              # persist this
# later: create_client(..., workspace="myapp", token=token) to restore the session
client.auth.sign_out()
```

`auth.providers()` returns the public auth surface (provider list + policy flags)
for rendering a sign-in screen. `auth.sign_in_social(provider)` and
`auth.sign_in_magic_link(email)` are also available.

## Realtime (SSE)

```python
unsub = client.subscribe("items:posts", lambda ev: print(ev["event"], ev["data"]))
# ... runs on a background daemon thread, auto-reconnects ...
unsub()
```

## Storage

```python
client.storage.put("avatars/me.png", open("me.png", "rb").read(), "image/png")
data = client.storage.download("avatars/me.png").content
client.storage.list(prefix="avatars/")
client.storage.delete("avatars/me.png")
```

## Errors

Every non-2xx response raises `BacklexError` with `.status`, `.code`, and
`.details` (the `{ "error": {...} }` envelope), so you branch on codes, not
strings.

## Hybrid codegen

The hand-written layer above is stable and small. For **typed models** of your
collections and the system API, generate them from the OpenAPI spec the server
already ships — no Python-specific wire format is introduced.

```bash
# 1. System API models from the static OpenAPI spec:
openapi-generator generate \
  -i apps/web/src/server/lib/openapi-static.generated.json \
  -g python -o sdks/python/_generated --skip-validate

# 2. Per-collection types: the `backlex gen-types` CLI emits these for the
#    TS SDK today; the Python equivalent reads /api/collections and writes
#    TypedDicts you pass as `client.from_("posts")  # -> dict[Post]`.
```

Generated models live alongside (not inside) the hand-written package, so the
ergonomic surface stays clean while models track the spec.

## Develop

```bash
cd sdks/python
pip install -e ".[dev]"
pytest          # offline: query-builder + normalization contract tests
mypy            # strict
ruff check .
```

## Parity with the TS SDK

| TS (`@backlex/client`)        | Python (`backlex`)                       |
| ----------------------------- | ---------------------------------------- |
| `createClient(opts)`          | `create_client(url, ...)`                |
| `client.from(slug)`           | `client.from_(slug)`                     |
| `.query().where(f => ...)`    | `.query().where(lambda f: ...)`          |
| `f.and / or / not / in`       | `f.and_ / or_ / not_ / in_`              |
| `.orderBy().withMeta()`       | `.order_by().with_meta()`                |
| `client.subscribe(ch, cb)`    | `client.subscribe(ch, cb)` → `unsub()`   |
| `auth.signIn / getToken`      | `auth.sign_in / get_token`               |
| `BacklexError`                | `BacklexError`                           |
