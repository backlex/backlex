# backlex — Swift SDK

Official Swift client for the backlex API (iOS + macOS). A thin, typed wrapper
over the same REST + SSE surface the TypeScript SDK (`@backlex/client`) speaks —
CRUD, a fluent query builder, auth, realtime, and storage. `async/await`
throughout via `URLSession`; **zero dependencies** (Foundation + Codable only).

Part of backlex's multi-language SDK effort; follows the **hybrid** model:
hand-written ergonomic layer here, optional OpenAPI-generated models underneath
(see [Hybrid codegen](#hybrid-codegen)).

```swift
// Package.swift
.package(url: "https://github.com/backlex/backlex-swift", from: "0.0.1")  // not yet published
```

## Quickstart

```swift
import Backlex

struct Post: Decodable { let id: String; let title: String }

let client = BacklexClient("https://api.example.com", apiKey: "pak_...")

// CRUD — from(slug, as:) with a Decodable model (or JSONValue for schema-blind).
let created = try await client.from("posts", as: Post.self).create(["title": "Hello"] as JSONValue)

// Fluent query builder → compiles to canonical JSON (same wire format as TS/Python/Go/.NET/Java)
let res = try await client.from("orders", as: Order.self).query()
    .where(Filter.and(
        Filter.eq("status", "active"),
        Filter.gte("total", 100),
        Filter.rel("customer", Filter.eq("tier", "gold")),     // → "customer.tier"
        Filter.gte("placed_at", Filter.now(sub: ["months": 1]))
    ))
    .select("id", "total", "customer.name")
    .orderBy("-placed_at", "id")
    .limit(50)
    .list()
```

`JSONValue` is `ExpressibleBy*Literal`, so condition values and request bodies
read as plain Swift literals (`"active"`, `100`, `true`, `["a", "b"]`).

## Auth

```swift
// Server-to-server: BacklexClient(url, apiKey: "pak_...") — bearer on every call.

// App mode — end-users of a workspace:
let client = BacklexClient(url, workspace: "myapp")
let res = try await client.auth.signIn(email: "user@example.com", password: "secret") // token auto-captured
let token = client.auth.token                                                          // persist this
// later: BacklexClient(url, workspace: "myapp", token: token) to restore
try await client.auth.signOut()
```

`client.auth.providers()` returns the public auth surface. `signInSocial` and
`signInMagicLink` are also available.

## Realtime (SSE)

```swift
let sub = client.subscribe("items:posts", as: Post.self) { ev in
    print(ev.event, ev.data.title)
}
// ... runs on a Task, auto-reconnects ...
sub.cancel()
```

## Storage

```swift
_ = try await client.storage.put("avatars/me.png", pngData, contentType: "image/png")
let data = try await client.storage.download("avatars/me.png")
_ = try await client.storage.list(prefix: "avatars/")
_ = try await client.storage.delete("avatars/me.png")
```

## Errors

Every non-2xx response throws `BacklexError` with `status`, `code`, `message`,
and `details`:

```swift
do { _ = try await client.from("missing", as: Post.self).list() }
catch let e as BacklexError where e.status == 404 { /* ... */ }
```

## Hybrid codegen

The hand-written layer is small and stable. For **typed models** of the system
API and your collections, generate them from the OpenAPI spec the server ships —
no Swift-specific wire format is introduced.

```bash
openapi-generator generate \
  -i apps/web/src/server/lib/openapi-static.generated.json \
  -g swift5 -o sdks/swift/Generated
# Per-collection types: pass a generated/Decodable struct (or JSONValue) as `as:`.
```

## Develop

```bash
cd sdks/swift
swift build
swift run backlex-tests   # offline: query-builder + URLProtocol HTTP-layer contract
```

> The PoC's test runner is a self-contained executable (`swift run backlex-tests`)
> because the CI image here ships neither XCTest nor swift-testing for the macOS
> host. With full Xcode, port the runner to `@Test`/`XCTest` under `Tests/`.

## Parity with the TS SDK

| TS (`@backlex/client`)        | Swift (`Backlex`)                                  |
| ----------------------------- | -------------------------------------------------- |
| `createClient(opts)`          | `BacklexClient(url, apiKey:/workspace:/token:)`    |
| `client.from(slug)`           | `client.from(slug, as: T.self)`                    |
| `.query().where(f => ...)`    | `.query().where(Filter.and(...))`                  |
| `f.eq / and / rel / now`      | `Filter.eq / and / rel / now`                      |
| `.orderBy().withMeta()`       | `.orderBy().withMeta()`                            |
| `client.subscribe(ch, cb)`    | `client.subscribe(ch, as:) { }` → `.cancel()`      |
| `auth.signIn / getToken`      | `client.auth.signIn / token`                       |
| `BacklexError`                | `BacklexError`                                     |
