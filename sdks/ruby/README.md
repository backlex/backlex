# backlex — Ruby SDK

Official Ruby client for the backlex API. A thin wrapper over the same REST + SSE
surface the TypeScript SDK (`@backlex/client`) speaks — CRUD, a fluent query
builder, auth, realtime, and storage. **Zero runtime dependencies** (stdlib
`net/http` + `json`).

Part of backlex's multi-language SDK effort; follows the **hybrid** model:
hand-written ergonomic layer here, optional OpenAPI-generated models underneath.

```bash
gem install backlex   # not yet published
```

## Quickstart

```ruby
require "backlex"
F = Backlex::Filter

client = Backlex::Client.new("https://api.example.com", api_key: "pak_...")

# CRUD
created = client.from("posts").create({ "title" => "Hello" })
client.from("posts").update(created["data"]["id"], { "title" => "Edited" })
client.from("posts").delete(created["data"]["id"])

# Fluent query builder → compiles to canonical JSON (same wire format as every other SDK)
rows = client.from("orders").query
             .where(F.and_(
                      F.eq("status", "active"),
                      F.gte("total", 100),
                      F.rel("customer", F.eq("tier", "gold")),   # -> "customer.tier"
                      F.gte("placed_at", F.now(sub: { "months" => 1 }))
                    ))
             .select("id", "total", "customer.name")
             .order_by("-placed_at", "id")
             .limit(50)
             .list
```

Ruby keywords are suffixed with `_`: `and_`, `or_`, `not_`, `in_`.

## Auth

```ruby
# Server-to-server: Backlex::Client.new(url, api_key: "pak_...") — bearer on every call.

# App mode — end-users of a workspace:
client = Backlex::Client.new(url, workspace: "myapp")
res = client.auth.sign_in("user@example.com", "secret")  # token auto-captured
token = client.auth.token                                 # persist this
# later: Backlex::Client.new(url, workspace: "myapp", token: token)
client.auth.sign_out
```

`client.auth.providers` returns the public auth surface. `sign_in_social` and
`sign_in_magic_link` are also available.

## Realtime (SSE)

```ruby
sub = client.subscribe("items:posts", ->(ev) { puts "#{ev['event']}: #{ev['data']}" })
# ... runs on a background thread, auto-reconnects ...
sub.close
```

## Storage

```ruby
client.storage.put("avatars/me.png", bytes, content_type: "image/png")
data = client.storage.download("avatars/me.png")
client.storage.list("avatars/")
client.storage.delete("avatars/me.png")
```

## Errors

Every non-2xx response (and transport failures) raise `Backlex::Error` with
`#status`, `#code`, `#details`:

```ruby
begin
  client.from("missing").list
rescue Backlex::Error => e
  raise unless e.status == 404
end
```

## Hybrid codegen

For **typed models**, generate them from the OpenAPI spec the server ships — no
Ruby-specific wire format is introduced:

```bash
openapi-generator generate \
  -i apps/web/src/server/lib/openapi-static.generated.json \
  -g ruby -o sdks/ruby/generated
```

## Develop

```bash
cd sdks/ruby
ruby -Ilib test/query_test.rb     # offline: query-builder contract
ruby -Ilib test/client_test.rb    # offline: WEBrick HTTP-layer contract
```

## Parity with the TS SDK

| TS (`@backlex/client`)     | Ruby (`Backlex`)                              |
| -------------------------- | --------------------------------------------- |
| `createClient(opts)`       | `Backlex::Client.new(url, api_key:/workspace:/token:)` |
| `client.from(slug)`        | `client.from(slug)`                           |
| `.query().where(f => ...)` | `.query.where(Filter.and_(...))`              |
| `f.eq / and / rel / now`   | `Filter.eq / and_ / rel / now`                |
| `.orderBy().withMeta()`    | `.order_by.with_meta`                         |
| `client.subscribe(ch, cb)` | `client.subscribe(ch, cb)` → `.close`         |
| `auth.signIn / getToken`   | `client.auth.sign_in / token`                 |
| `BacklexError`             | `Backlex::Error`                              |
