# backlex — Kotlin SDK

Official Kotlin client for the backlex API (JVM + Android). A thin, typed wrapper
over the same REST + SSE surface the TypeScript SDK (`@backlex/client`) speaks —
CRUD, a fluent query builder, auth, realtime, and storage. HTTP is the built-in
`java.net.http.HttpClient`; the only runtime dependency is Jackson (+ Kotlin
module).

Part of backlex's multi-language SDK effort; follows the **hybrid** model:
hand-written ergonomic layer here, optional OpenAPI-generated models underneath
(see [Hybrid codegen](#hybrid-codegen)).

```xml
<dependency>
  <groupId>com.backlex</groupId>
  <artifactId>backlex-kotlin</artifactId>
  <version>0.0.1</version>
</dependency>
```

## Quickstart

```kotlin
import com.backlex.BacklexClient
import com.backlex.Filter

data class Post(val id: String = "", val title: String = "", val published: Boolean = false)

val client = BacklexClient.builder("https://api.example.com").apiKey("pak_...").build()

// CRUD — from<T>(slug) is reified; use Map/Any for schema-blind access.
val created = client.from<Post>("posts").create(mapOf("title" to "Hello"))

// Fluent query builder → compiles to canonical JSON (same wire format as TS/Python/Go/.NET/Java/Swift)
val res = client.from<Order>("orders").query()
    .where(Filter.and(
        Filter.eq("status", "active"),
        Filter.gte("total", 100),
        Filter.rel("customer", Filter.eq("tier", "gold")),     // → "customer.tier"
        Filter.gte("placed_at", Filter.now(sub = mapOf("months" to 1))),
    ))
    .select("id", "total", "customer.name")
    .orderBy("-placed_at", "id")
    .limit(50)
    .list()
```

## Auth

```kotlin
// Server-to-server: .apiKey("pak_...") on the builder — bearer on every call.

// App mode — end-users of a workspace:
val client = BacklexClient.builder(url).workspace("myapp").build()
val res = client.auth.signIn("user@example.com", "secret") // token auto-captured
val token = client.auth.token                               // persist this
// later: BacklexClient.builder(url).workspace("myapp").token(token).build()
client.auth.signOut()
```

`client.auth.providers()` returns the public auth surface. `signInSocial` and
`signInMagicLink` are also available.

## Realtime (SSE)

```kotlin
client.subscribe<Post>("items:posts", onEvent = { ev -> println("${ev.event}: ${ev.data}") }).use {
    // ... runs on a daemon thread, auto-reconnects ...
}   // close() (via use) unsubscribes
```

## Storage

```kotlin
client.storage.put("avatars/me.png", bytes, "image/png")
val data = client.storage.download("avatars/me.png")
client.storage.list("avatars/")
client.storage.delete("avatars/me.png")
```

## Errors

Every non-2xx response (and transport failures) throw the unchecked
`BacklexException` with `status`, `code`, `details`:

```kotlin
try { client.from<Post>("missing").list() }
catch (e: BacklexException) { if (e.status == 404) { /* ... */ } }
```

## Hybrid codegen

The hand-written layer is small and stable. For **typed models** of the system
API and your collections, generate them from the OpenAPI spec the server ships —
no Kotlin-specific wire format is introduced.

```bash
openapi-generator generate \
  -i apps/web/src/server/lib/openapi-static.generated.json \
  -g kotlin -o sdks/kotlin/generated
# Per-collection types: pass a generated/data-class type as from<T>("slug").
```

## Develop

```bash
cd sdks/kotlin
mvn test       # offline: query-builder + in-JVM HttpServer HTTP-layer contract
mvn package
```

> Build with a JDK the Kotlin 2.0 compiler accepts (e.g. JDK 17–21). The library
> targets JVM 17 and runs on Android (minSdk with `java.net.http` ≈ API 34, or
> swap the transport for OkHttp on older devices).

## Parity with the TS SDK

| TS (`@backlex/client`)        | Kotlin (`com.backlex`)                               |
| ----------------------------- | ---------------------------------------------------- |
| `createClient(opts)`          | `BacklexClient.builder(url)...build()`               |
| `client.from(slug)`           | `client.from<T>(slug)`                               |
| `.query().where(f => ...)`    | `.query().where(Filter.and(...))`                    |
| `f.eq / and / rel / now`      | `Filter.eq / and / rel / now`                        |
| `.orderBy().withMeta()`       | `.orderBy().withMeta()`                              |
| `client.subscribe(ch, cb)`    | `client.subscribe<T>(ch, onEvent)` → `.close()`      |
| `auth.signIn / getToken`      | `client.auth.signIn / token`                         |
| `BacklexError`                | `BacklexException`                                   |
