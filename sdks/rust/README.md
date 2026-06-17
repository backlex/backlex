# backlex — Rust SDK

Official Rust client for the backlex API. A thin wrapper over the same REST + SSE
surface the TypeScript SDK (`@backlex/client`) speaks — CRUD, a fluent query
builder, auth, realtime, and storage. Blocking HTTP via `ureq`; the
condition/query-builder core is pure `serde_json` and **compiles to `wasm32`**
(see [WebAssembly](#webassembly)).

Part of backlex's multi-language SDK effort; follows the **hybrid** model:
hand-written ergonomic layer here, optional OpenAPI-generated models underneath.

```toml
# Cargo.toml
[dependencies]
backlex = "0.0.1"   # not yet published
serde_json = "1"
```

## Quickstart

```rust
use backlex::{filter as f, Client};
use serde_json::json;

let client = Client::builder("https://api.example.com").api_key("pak_...").build();

// CRUD
let created = client.from("posts").create(&json!({ "title": "Hello" }))?;

// Fluent query builder → compiles to canonical JSON (same wire format as every other SDK)
let rows = client.from("orders").query()
    .filter(f::and(vec![
        f::eq("status", json!("active")),
        f::gte("total", json!(100)),
        f::rel("customer", vec![f::eq("tier", json!("gold"))]),   // -> "customer.tier"
    ]))
    .select(&["id", "total", "customer.name"])
    .order_by(&["-placed_at", "id"])
    .limit(50)
    .list()?;
```

`.filter(...)` is the where-clause (Rust reserves `where`); `f::in_` covers `in`.

## Auth

```rust
// Server-to-server: Client::builder(url).api_key("pak_...") — bearer on every call.

// App mode — end-users of a workspace:
let client = Client::builder(url).workspace("myapp").build();
let res = client.auth().sign_in("user@example.com", "secret")?; // token auto-captured
let token = client.token();                                      // persist this
// later: Client::builder(url).workspace("myapp").token(token)
client.auth().sign_out()?;
```

`client.auth().providers()` returns the public auth surface. `sign_in_social` and
`sign_in_magic_link` are also available.

## Realtime (SSE)

```rust
let sub = client.subscribe("items:posts", |ev| println!("{}", ev["event"]));
// ... runs on a thread, auto-reconnects ...
sub.cancel();
```

## Storage

```rust
client.storage().put("avatars/me.png", &bytes, Some("image/png"), None)?;
let data = client.storage().download("avatars/me.png")?;
client.storage().list(Some("avatars/"))?;
client.storage().delete("avatars/me.png")?;
```

## Errors

Every non-2xx response (and transport failures) return `Err(BacklexError)` with
`status`, `code`, `details`:

```rust
match client.from("missing").list() {
    Err(e) if e.status == 404 => { /* ... */ }
    _ => {}
}
```

## WebAssembly

The `filter` module (condition builders + `normalize`) is pure `serde_json` with
no IO, so it compiles to `wasm32-unknown-unknown` as-is — share one canonical
query-builder implementation with browser/edge hosts. The HTTP transport is
pluggable via the `Transport` trait: provide a `fetch`-backed transport (e.g. via
`wasm-bindgen`) in place of the default `ureq` one.

```rust
let client = Client::builder(url).transport(Box::new(MyFetchTransport)).build();
```

## Hybrid codegen

For **typed models**, generate them from the OpenAPI spec the server ships:

```bash
openapi-generator generate \
  -i apps/web/src/server/lib/openapi-static.generated.json \
  -g rust -o sdks/rust/generated
```

## Develop

```bash
cd sdks/rust
cargo test           # offline: query-builder + mock-transport HTTP-layer contract
cargo clippy --all-targets
```

## Parity with the TS SDK

| TS (`@backlex/client`)     | Rust (`backlex`)                              |
| -------------------------- | --------------------------------------------- |
| `createClient(opts)`       | `Client::builder(url)...build()`              |
| `client.from(slug)`        | `client.from(slug)`                           |
| `.query().where(f => ...)` | `.query().filter(f::and(vec![...]))`          |
| `f.eq / and / rel / now`   | `f::eq / and / rel / now`                     |
| `.orderBy().withMeta()`    | `.order_by(&[...]).with_meta()`               |
| `client.subscribe(ch, cb)` | `client.subscribe(ch, cb)` → `.cancel()`      |
| `auth.signIn / getToken`   | `client.auth().sign_in / client.token()`      |
| `BacklexError`             | `BacklexError`                                |
