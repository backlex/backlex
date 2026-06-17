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
All clients are Apache-2.0, verified with offline contract + HTTP-layer tests, and
**published** (`0.0.1`): Python (PyPI), .NET (NuGet), Ruby (RubyGems), Dart (pub.dev),
Rust (crates.io), Go (`backlex-go`), Swift (`backlex-swift`). PHP is staged in
[`backlex-php`](https://github.com/backlex/backlex-php) pending a Packagist submission;
Java + Kotlin are wired for Maven Central pending GPG/Portal secrets. The release
runbook lives in
[`sdks/PUBLISHING.md`](https://github.com/backlex/backlex/blob/main/sdks/PUBLISHING.md).
:::

## Client and server usage

backlex ships **one SDK per language — not a client/server split.** The same
client works in a browser or mobile app (end-user scoped) and on a trusted server
(key scoped); which one you're in is decided by *how you authenticate*, and the
permission DSL enforces the boundary server-side either way.

There are three auth modes:

1. **Server-to-server (trusted backend)** — pass a static API key (`pak_…`). It's
   sent as a bearer on every call, and the call is bound by that key's granted
   permissions plus its per-key guards (tool allow-lists, a read-only flag). Use
   it from your backend, CI, or scripts — never ship a `pak_` key in a
   browser/mobile bundle.
2. **App mode (end-user client)** — pass a `workspace` slug. `auth.*` then targets
   that workspace's own end-user auth pool, and the session token returned by
   sign-in/up is captured and replayed as a bearer. This is the browser/mobile
   path: each user acts as themselves, constrained by their role's permissions.
   Persist the token (`auth.getToken()` / `auth.token`) and restore it next launch.
3. **Cookie session (same-origin browser)** — omit both; the client rides the
   cookie session (the admin SPA path).

```ts
// server — elevated, bound by the key's permissions + guards
const api = createClient({ url, apiKey: process.env.BACKLEX_API_KEY });

// browser / mobile app — end-user scoped
const app = createClient({ url, workspace: "myapp" });
await app.auth.signIn({ email, password }); // token captured + replayed

// same-origin browser (admin SPA) — cookie session
const web = createClient({ url });
```

The option names are idiomatic per language (`apiKey` / `api_key`, `workspace`,
`token`) — see each SDK's README.

**Why there's no separate "admin SDK":** the permission DSL and per-key guards run
on the **server**, so the same client is safe in both contexts — a `pak_` key with
a read-only flag and a tool allow-list *is* the guard, not a separate package.
Privileged management operations (schema, users, roles) are reachable today via the
raw `request()` escape hatch; a typed admin module is on the roadmap.

### Anonymous & public reads

A public collection (one whose built-in `public` role has a read permission) needs
**no credential at all** — construct the client with neither `apiKey` nor a token.
On a multi-tenant deployment, pass the `tenant` option so the server knows which
workspace to read; the client sends it as the `X-Backlex-Tenant` header. (A
single-tenant self-host resolves the default tenant automatically, so the option
is optional there.)

```ts
const pub = createClient({ url, tenant: "myapp" });   // anonymous, tenant-scoped
const { data } = await pub.from("posts").list({ filter: { published: { _eq: true } } });
```

The `tenant` option exists in every SDK (`tenant` / `Tenant` / `WithTenant` /
`.tenant(...)`); the server ignores it for app-mode bearer sessions, since their
tenant comes from the session.

### Query extras & aggregates

The query builder also exposes the rest of the list API: `expand` (inline
single-hop relations), `locale` (collapse `i18n_text` fields to one locale, or
`"*"` for the full map), and `search` (free-text across readable text fields). And
every collection has `aggregate` — a single-function `count`/`sum`/`avg`/`min`/`max`
over one column, optionally grouped:

```ts
const top = await client.from("orders").query()
  .expand("customer").locale("en").search("urgent").list();

const byStatus = await client.from("orders")
  .aggregate({ agg: "sum", field: "total", groupBy: "status" });
// → { data: [ { label: "paid", value: 9300 }, { label: "pending", value: 410 } ] }
```

`expand` and `locale` also work when reading a **single** item — `one(id)` takes an
optional query so you can inline a relation or pick a locale without dropping to the
list endpoint:

```ts
const order = await client.from("orders").one("ord_42", { expand: "customer", locale: "en" });
```

### Password reset & token refresh

Beyond sign-in/up, every SDK's `auth` exposes:

- **`requestPasswordReset(email, redirectTo?)`** — send the reset email.
- **`resetPassword(newPassword, token)`** — complete it with the token from the email.
- **`refresh()`** (app mode) — mint a fresh short-lived **access JWT** from the
  stored session token. The SDK's own requests keep using the session token; reach
  for `refresh()` when a downstream service needs a proper access token. (Sessions
  themselves last the workspace's `session_lifetime`; once that elapses the user
  re-authenticates.)

### Passwordless: email one-time codes

When the workspace enables the `email-otp` provider, sign-in is a two-step flow —
mail a code, then exchange it for a session. In app mode the returned token is
captured and replayed exactly like a password sign-in:

```ts
await client.auth.sendVerificationOTP({ email: "user@acme.com" }); // type defaults to "sign-in"
// …user reads the code from their inbox…
const { user } = await client.auth.signInEmailOTP({ email: "user@acme.com", otp: "123456" });
```

`sendVerificationOTP` also drives the `"email-verification"` and `"forget-password"`
flows via its `type` argument. (For the click-a-link variant, use `signInMagicLink`.)

### Managing active sessions

Every `auth` exposes the session list and three revoke verbs — enough to build a
"signed-in devices" screen with a remote sign-out button:

```ts
const sessions = await client.auth.listSessions();      // one row per device/login
await client.auth.revokeSession({ token: sessions[0].token }); // kill one
await client.auth.revokeOtherSessions();                // sign out everywhere else
await client.auth.revokeSessions();                     // sign out everywhere (incl. here)
```

### Publishing versioned items

Collections with draft/publish versioning expose two helpers on every collection
handle. They map to the same `POST /api/items/<slug>/<id>/publish` endpoint —
`unpublish` just flips it back with `?unpublish=1`:

```ts
await client.from("posts").publish("post-id");   // draft → published
await client.from("posts").unpublish("post-id"); // published → draft
```

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
