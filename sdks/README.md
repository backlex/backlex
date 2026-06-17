# backlex SDKs

Official client SDKs for the backlex API, one per ecosystem. They all wrap the
**same** REST + SSE surface that the TypeScript SDK (`packages/client`,
`@backlex/client`) speaks — so an app in any language talks to backlex the same
way, with the same wire format.

> Each is a thin, hand-written ergonomic layer verified with offline contract +
> HTTP-layer tests. All are Apache-2.0 and **release-ready** (LICENSE + registry
> metadata in place), but not yet pushed to a registry — see [`PUBLISHING.md`](./PUBLISHING.md).

## The SDKs

| Language | Dir | Transport | Deps | Tests | Verify |
|---|---|---|---|---|---|
| TypeScript | [`packages/client`](../packages/client) | fetch + EventSource | `@backlex/core` | (repo suite) | — |
| Python | [`python`](./python) | httpx | httpx | 12 | `pytest` · ruff · mypy --strict |
| Go | [`go`](./go) | net/http | none (stdlib) | 12 | `go test` · vet · gofmt |
| .NET (C#) | [`dotnet`](./dotnet) | HttpClient | none (BCL) | 12 | `dotnet test` (0 warnings) |
| Java | [`java`](./java) | java.net.http | Jackson | 12 | `mvn test` |
| Swift | [`swift`](./swift) | URLSession | none (Foundation) | 15 | `swift run backlex-tests` |
| Kotlin | [`kotlin`](./kotlin) | java.net.http | Jackson | 12 | `mvn test` |
| Ruby | [`ruby`](./ruby) | net/http | none (stdlib) | 12 | `ruby -Ilib test/*` |
| PHP | [`php`](./php) | curl | none (ext-curl) | 15 | `php tests/run.php` |
| Dart / Flutter | [`dart`](./dart) | dart:io HttpClient | none (SDK) | 15 | `dart run test/run.dart` |
| Rust | [`rust`](./rust) | ureq (pluggable) | serde_json, ureq | 11 | `cargo test` · clippy |

Every SDK exposes the same surface: **CRUD** (`from(slug)` → list/one/create/update/delete),
a **fluent query builder**, **auth** (server key / workspace app-mode token capture /
cookie session), **realtime** (SSE), **storage**, and a uniform **error** type.

## One wire format, ten languages

The design that makes this cheap to maintain: **nothing language-specific ever
hits the wire.** The query builder in every SDK compiles to the identical
canonical JSON `Condition` grammar the server already speaks — `$and`/`$or`/`$not`
maps, leaf `{ "field": { "_op": value } }` entries, dotted relation paths, and
`$now` relative dates. The server required **zero changes** to support all ten.

Each SDK's test suite includes the same offline **contract tests** that assert the
builder emits byte-identical canonical JSON for a fixed set of cases (leaf +
logical, relation hop, multi-cond `rel`, `$now`, implicit-equality + `_`-aliases,
full query assembly) — plus an **HTTP-layer test** that drives a real request
through the language's HTTP stack (mock transport or in-process server) and
asserts method, path, **single** percent-encoding of the filter (no double-encode),
bearer-token capture/replay, the CRUD verbs/bodies, and the error envelope →
typed error mapping.

## Hybrid model

Each SDK is **hand-written ergonomics + optional generated models**:

- The thin layer here (client, query builder, auth, realtime, storage, errors) is
  authored by hand — it's small, stable, and gives each language idiomatic feel.
- For **typed models** of the system API and your collections, generate them from
  the OpenAPI spec the server already ships
  (`apps/web/src/server/lib/openapi-static.generated.json`) with
  `openapi-generator -g <lang>`; each README has the exact command. Generated
  models live beside (not inside) the hand-written package, so the ergonomic
  surface stays clean while models track the spec.

## Idiomatic conventions per language

Same semantics, native spelling:

- **Factory / construction** — `createClient` → `Client(...)` / `Client::builder()`
  / `BacklexClient.builder()` / `new Client(url, [...])`.
- **Reserved-word operators** — `and`/`or`/`not`/`in` become `and_`/`or_`/`not_`/`in_`
  (Python, Ruby, PHP, Swift backtick `` `in` ``), `And`/`Or`/`Not`/`In` (Go, C#),
  or `filter(...)` for the where-clause where `where` is reserved (Rust, Swift
  uses `` `where` ``).
- **Async vs blocking** — `async/await` (Python\*, C#, Swift, Dart, TS); blocking
  (Go, Java, Kotlin, Ruby, PHP, Rust). Realtime is a background thread/task that
  returns an unsubscribe handle — except PHP, which has no threads and exposes a
  blocking `subscribe`.
- **Generics** — `from<T>()` (C#, Kotlin, Go via `From[T]`), `from(slug, Type.class)`
  (Java), `from(slug, as: T.self)` (Swift); dynamic maps elsewhere.

\* the Python PoC is sync; an async client is a follow-up.

## WebAssembly

No separate SDK. The Rust [`filter`](./rust/src/filter.rs) module (condition
builders + `normalize`) is pure `serde_json` with no IO, so it compiles to
`wasm32-unknown-unknown` as-is; swap the pluggable `Transport` for a `fetch`-backed
one to run the whole client in the browser/edge from one Rust core.

## Status

**Published at `0.0.1`** (Apache-2.0, LICENSE + metadata in every package):

| SDK | Install | SDK | Install |
|---|---|---|---|
| Python | `pip install backlex` | Rust | `cargo add backlex` |
| .NET | `dotnet add package Backlex` | Go | `go get github.com/backlex/backlex-go` |
| Ruby | `gem install backlex` | Swift | SPM via `backlex/backlex-swift` |
| Dart | `dart pub add backlex` | PHP | `composer require backlex/backlex` |

**Pending:** only Java + Kotlin, wired for Maven Central (`mvn -P release deploy`)
pending the GPG key + Portal token secrets. Go/Swift/PHP publish from dedicated mirror
repos (manifest must sit at a repo root) — see [`PUBLISHING.md`](./PUBLISHING.md). The
[`publish-sdks.yml`](../.github/workflows/publish-sdks.yml) workflow packs/validates and
publishes the registry-based SDKs on manual dispatch.

Remaining nice-to-haves: an async Python client and the generated-models codegen
pipeline per package.
