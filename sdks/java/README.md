# backlex — Java SDK

Official Java client for the backlex API. A thin, typed wrapper over the same
REST + SSE surface the TypeScript SDK (`@backlex/client`) speaks — CRUD, a fluent
query builder, auth, realtime, and storage. HTTP is the built-in
`java.net.http.HttpClient`; the only runtime dependency is Jackson (the JDK has no
JSON).

Part of backlex's multi-language SDK effort; follows the **hybrid** model:
hand-written ergonomic layer here, optional OpenAPI-generated models underneath
(see [Hybrid codegen](#hybrid-codegen)).

```xml
<dependency>
  <groupId>com.backlex</groupId>
  <artifactId>backlex</artifactId>
  <version>0.0.1</version>
</dependency>
```

## Quickstart

```java
import com.backlex.*;
import static com.backlex.Filter.*;

BacklexClient client = BacklexClient.builder("https://api.example.com")
    .apiKey("pak_...")
    .build();

// CRUD — from(slug, Type.class); use Object.class / a Map type for schema-blind.
ItemResponse<Post> created = client.from("posts", Post.class)
    .create(Map.of("title", "Hello"));

// Fluent query builder → compiles to canonical JSON (same wire format as TS/Python/Go/.NET)
ListResponse<Order> res = client.from("orders", Order.class).query()
    .where(and(
        eq("status", "active"),
        gte("total", 100),
        rel("customer", eq("tier", "gold")),               // → "customer.tier"
        gte("placed_at", now(null, Map.of("months", 1)))))
    .select("id", "total", "customer.name")
    .orderBy("-placed_at", "id")
    .limit(50)
    .list();
```

## Auth

```java
// Server-to-server: .apiKey("pak_...") on the builder — bearer on every call.

// App mode — end-users of a workspace:
BacklexClient client = BacklexClient.builder(url).workspace("myapp").build();
Models.AuthResult res = client.auth.signIn("user@example.com", "password"); // token auto-captured
String token = client.auth.token();                                          // persist this
// later: BacklexClient.builder(url).workspace("myapp").token(token).build()
client.auth.signOut();
```

`client.auth.providers()` returns the public auth surface. `signInSocial` and
`signInMagicLink` are also available.

## Realtime (SSE)

```java
try (Subscription sub = client.subscribe("items:posts", Post.class,
        ev -> System.out.println(ev.event + ": " + ev.data),
        err -> err.printStackTrace())) {
    // ... runs on a daemon thread, auto-reconnects ...
}   // close() unsubscribes
```

## Storage

```java
client.storage.put("avatars/me.png", bytes, "image/png", null);
byte[] data = client.storage.download("avatars/me.png");
client.storage.list("avatars/");
client.storage.delete("avatars/me.png");
```

## Errors

Every non-2xx response (and transport failures) throw the unchecked
`BacklexException` with `status`, `code`, `details`:

```java
try { client.from("missing", Post.class).list(); }
catch (BacklexException e) { if (e.status == 404) { /* ... */ } }
```

## Hybrid codegen

The hand-written layer is small and stable. For **typed models** of the system
API and your collections, generate them from the OpenAPI spec the server ships —
no Java-specific wire format is introduced.

```bash
# System API models from the static OpenAPI spec:
openapi-generator generate \
  -i apps/web/src/server/lib/openapi-static.generated.json \
  -g java -o sdks/java/generated --additional-properties=library=native

# Per-collection types: pass a generated POJO (or Object.class) as from(slug, Type.class).
```

## Develop

```bash
cd sdks/java
mvn test       # offline: query-builder + in-JVM HttpServer HTTP-layer contract
mvn package
```

## Parity with the TS SDK

| TS (`@backlex/client`)        | Java (`com.backlex`)                                  |
| ----------------------------- | ----------------------------------------------------- |
| `createClient(opts)`          | `BacklexClient.builder(url)...build()`                |
| `client.from(slug)`           | `client.from(slug, Type.class)`                       |
| `.query().where(f => ...)`    | `.query().where(and(...))` (`import static Filter.*`) |
| `f.eq / and / rel / now`      | `eq / and / rel / now`                                |
| `.orderBy().withMeta()`       | `.orderBy().withMeta()`                               |
| `client.subscribe(ch, cb)`    | `client.subscribe(ch, Type.class, cb, onErr)`         |
| `auth.signIn / getToken`      | `client.auth.signIn / token`                          |
| `BacklexError`                | `BacklexException`                                    |
