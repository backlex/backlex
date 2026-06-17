---
title: Client SDKs
description: Official backlex clients for eleven languages — one API, one wire format, idiomatic in each.
---

The TypeScript SDK ([`@backlex/client`](/docs/sdk-and-cli/)) is the reference
client. Alongside it, backlex ships native clients for ten more languages, so an
app in (almost) any stack talks to backlex the same way.

Every client wraps the **same** REST + SSE surface — CRUD, a fluent query
builder, auth (server key / workspace app-mode token capture / cookie session),
realtime (SSE), storage, and a uniform error type. Nothing language-specific ever
hits the wire.

## Languages

| Language | Package dir | Transport | Runtime deps |
|---|---|---|---|
| TypeScript | [`packages/client`](https://github.com/backlex/backlex/tree/main/packages/client) | `fetch` + `EventSource` | none |
| Python | [`sdks/python`](https://github.com/backlex/backlex/tree/main/sdks/python) | httpx | httpx |
| Go | [`sdks/go`](https://github.com/backlex/backlex/tree/main/sdks/go) | `net/http` | none (stdlib) |
| Rust | [`sdks/rust`](https://github.com/backlex/backlex/tree/main/sdks/rust) | ureq (pluggable) | serde_json, ureq |
| Java | [`sdks/java`](https://github.com/backlex/backlex/tree/main/sdks/java) | `java.net.http` | Jackson |
| Kotlin | [`sdks/kotlin`](https://github.com/backlex/backlex/tree/main/sdks/kotlin) | `java.net.http` | Jackson |
| Swift | [`sdks/swift`](https://github.com/backlex/backlex/tree/main/sdks/swift) | URLSession | none (Foundation) |
| Dart / Flutter | [`sdks/dart`](https://github.com/backlex/backlex/tree/main/sdks/dart) | `dart:io` HttpClient | none (SDK) |
| C# / .NET | [`sdks/dotnet`](https://github.com/backlex/backlex/tree/main/sdks/dotnet) | HttpClient | none (BCL) |
| Ruby | [`sdks/ruby`](https://github.com/backlex/backlex/tree/main/sdks/ruby) | `net/http` | none (stdlib) |
| PHP | [`sdks/php`](https://github.com/backlex/backlex/tree/main/sdks/php) | curl | none (ext-curl) |

:::note
The non-TypeScript clients are proof-of-concept ports today — verified with
offline contract tests, not yet published to package registries (PyPI, crates.io,
Maven Central, pub.dev, NuGet, RubyGems, Packagist). Use them from the repo, or
follow the language's README for a local install.
:::

## One wire format, eleven languages

The query builder in every SDK compiles to the **identical canonical JSON**
`Condition` grammar the server already speaks — `$and` / `$or` / `$not` maps, leaf
`{ "field": { "_op": value } }` entries, dotted relation paths, and `$now`
relative dates. The server required **zero changes** to support all of them.

The same fluent query, in a few languages:

```python
# Python
client.from_("orders").query() \
    .where(lambda f: f.and_(
        f.eq("status", "active"),
        f.gte("total", 100),
        f.rel("customer", lambda c: c.eq("tier", "gold")),
    )) \
    .order_by("-placed_at").limit(50).list()
```

```go
// Go
backlex.From[Order](client, "orders").Query().
    Where(backlex.And(
        backlex.Eq("status", "active"),
        backlex.Gte("total", 100),
        backlex.Rel("customer", backlex.Eq("tier", "gold")),
    )).
    OrderBy("-placed_at").Limit(50).List()
```

```swift
// Swift
try await client.from("orders", as: Order.self).query()
    .where(Filter.and(
        Filter.eq("status", "active"),
        Filter.gte("total", 100),
        Filter.rel("customer", Filter.eq("tier", "gold"))
    ))
    .orderBy("-placed_at", "id").limit(50).list()
```

```rust
// Rust
client.from("orders").query()
    .filter(f::and(vec![
        f::eq("status", json!("active")),
        f::gte("total", json!(100)),
        f::rel("customer", vec![f::eq("tier", json!("gold"))]),
    ]))
    .order_by(&["-placed_at"]).limit(50).list()?;
```

All four serialize to byte-identical JSON:

```json
{"$and":[{"status":{"_eq":"active"}},{"total":{"_gte":100}},{"customer.tier":{"_eq":"gold"}}]}
```

## Idiomatic, not generated

Each SDK is a **hand-written ergonomic layer** — it feels native in its language,
not like a generated stub:

- **Construction** — `createClient(...)` (TS) · `Client.builder(...).build()`
  (Kotlin, Rust) · `BacklexClient.builder(...)` (Java) · `new Client(url, [...])`
  (PHP) · `Client(url, apiKey:)` (Swift, Dart, Python).
- **Reserved-word operators** — `and`/`or`/`not`/`in` become `and_`/`or_`/`not_`/`in_`
  (Python, Ruby, PHP), `And`/`Or` (Go, C#), or the where-clause is spelled
  `filter(...)` where `where` is reserved (Rust).
- **Async vs blocking** — `async`/`await` in TS, C#, Swift, Dart; blocking in Go,
  Java, Kotlin, Ruby, PHP, Rust. Realtime returns an unsubscribe handle backed by
  a background thread/task — except PHP, which has no threads and exposes a
  blocking `subscribe`.
- **Errors** — every client raises/returns a typed error (`BacklexError` /
  `BacklexException` / `Backlex::Error` / `*backlex.Error`) carrying `status`,
  `code`, and `details` from the `{ "error": {...} }` envelope.

## Typed models (hybrid codegen)

The hand-written layer is small and stable. For **typed models** of the system
API and your collections, generate them from the OpenAPI spec the server already
ships (`apps/web/src/server/lib/openapi-static.generated.json`):

```bash
openapi-generator generate \
  -i apps/web/src/server/lib/openapi-static.generated.json \
  -g <python|go|rust|java|kotlin|swift5|dart|csharp|ruby|php> \
  -o sdks/<lang>/generated
```

Generated models live beside (not inside) the hand-written package, so the
ergonomic surface stays clean while models track the spec. (The TypeScript SDK
pairs with `backlex gen-types` instead — see [SDK & CLI](/docs/sdk-and-cli/).)

## WebAssembly

There is no separate WASM SDK. The Rust client's filter core (condition builders
+ normalization) is pure `serde_json` with no IO, so it compiles to
`wasm32-unknown-unknown` as-is. Swap its pluggable `Transport` for a
`fetch`-backed one to run the whole client in the browser or at the edge from a
single Rust core.

## Per-SDK docs

Each client has its own README with a quickstart, auth/realtime/storage examples,
and a TS-parity table:
[Python](https://github.com/backlex/backlex/tree/main/sdks/python) ·
[Go](https://github.com/backlex/backlex/tree/main/sdks/go) ·
[Rust](https://github.com/backlex/backlex/tree/main/sdks/rust) ·
[Java](https://github.com/backlex/backlex/tree/main/sdks/java) ·
[Kotlin](https://github.com/backlex/backlex/tree/main/sdks/kotlin) ·
[Swift](https://github.com/backlex/backlex/tree/main/sdks/swift) ·
[Dart](https://github.com/backlex/backlex/tree/main/sdks/dart) ·
[.NET](https://github.com/backlex/backlex/tree/main/sdks/dotnet) ·
[Ruby](https://github.com/backlex/backlex/tree/main/sdks/ruby) ·
[PHP](https://github.com/backlex/backlex/tree/main/sdks/php).
