# backlex — Go SDK

Official Go client for the backlex API. A thin, typed wrapper over the same
REST + SSE surface the TypeScript SDK (`@backlex/client`) speaks — CRUD, a fluent
query builder, auth, realtime, and storage. Generics give typed rows without
codegen.

Part of backlex's multi-language SDK effort; follows the **hybrid** model
established by the Python port: hand-written ergonomic layer here, optional
OpenAPI-generated models underneath (see [Hybrid codegen](#hybrid-codegen)).

```bash
go get github.com/backlex/backlex-go   # not yet published
```

## Quickstart

```go
import backlex "github.com/backlex/backlex-go"

type Post struct {
    ID        string `json:"id"`
    Title     string `json:"title"`
    Published bool   `json:"published"`
}

client := backlex.New("https://api.example.com", backlex.WithAPIKey("pak_..."))

// CRUD — From[T] is a package-level generic (Go methods can't be generic).
created, _ := backlex.From[Post](client, "posts").Create(map[string]any{"title": "Hello"})
backlex.From[Post](client, "posts").Update(created.Data.ID, map[string]any{"title": "Edited"})
backlex.From[Post](client, "posts").Delete(created.Data.ID)

// Fluent query builder → compiles to canonical JSON (same wire format as TS/Python)
res, err := backlex.From[Post](client, "orders").Query().
    Where(backlex.And(
        backlex.Eq("status", "active"),
        backlex.Gte("total", 100),
        backlex.Rel("customer", backlex.Eq("tier", "gold")),   // → "customer.tier"
        backlex.Gte("placed_at", backlex.Now(nil, map[string]int{"months": 1})),
    )).
    Select("id", "total", "customer.name").
    OrderBy("-placed_at", "id").
    Limit(50).
    List()
```

## Auth

```go
// Server-to-server: backlex.WithAPIKey("pak_...") — bearer on every call.

// App mode — end-users of a workspace:
client := backlex.New(url, backlex.WithWorkspace("myapp"))
res, _ := client.Auth.SignIn("user@example.com", "password")  // token auto-captured
token := client.Auth.Token()                                   // persist this
// later: backlex.New(url, backlex.WithWorkspace("myapp"), backlex.WithToken(token))
client.Auth.SignOut()
```

`client.Auth.Providers()` returns the public auth surface for rendering a sign-in
screen. `SignInSocial` and `SignInMagicLink` are also available.

## Realtime (SSE)

```go
unsub := backlex.Subscribe[Post](client, "items:posts", func(ev backlex.ItemEvent[Post]) {
    fmt.Println(ev.Event, ev.Data.Title)
}, nil)
defer unsub()  // stop the subscription; the reader runs on a goroutine
```

## Storage

```go
client.Storage.Put("avatars/me.png", pngBytes, "image/png", "")
data, _ := client.Storage.Download("avatars/me.png")
client.Storage.List("avatars/")
client.Storage.Delete("avatars/me.png")
```

## Errors

Every non-2xx response is a `*backlex.Error` with `Status`, `Code`, `Message`, and
`Details`. Use `errors.As`:

```go
var be *backlex.Error
if errors.As(err, &be) && be.Status == 404 { /* ... */ }
```

## Hybrid codegen

The hand-written layer above is small and stable. For **typed models** of the
system API and your collections, generate them from the OpenAPI spec the server
ships — no Go-specific wire format is introduced.

```bash
# System API models from the static OpenAPI spec:
openapi-generator generate \
  -i apps/web/src/server/lib/openapi-static.generated.json \
  -g go -o sdks/go/internal/genmodels --package-name genmodels

# Per-collection types: pass a generated struct (or map[string]any) as From[T].
```

## Develop

```bash
cd sdks/go
go test ./...     # offline: query-builder + httptest HTTP-layer contract
go vet ./...
gofmt -l .        # should print nothing
```

## Parity with the TS SDK

| TS (`@backlex/client`)        | Go (`backlex`)                                  |
| ----------------------------- | ----------------------------------------------- |
| `createClient(opts)`          | `backlex.New(url, opts...)`                      |
| `client.from(slug)`           | `backlex.From[T](client, slug)`                  |
| `.query().where(f => ...)`    | `.Query().Where(backlex.And(...))`               |
| `f.eq / and / rel / now`      | `backlex.Eq / And / Rel / Now`                   |
| `.orderBy().withMeta()`       | `.OrderBy().WithMeta()`                          |
| `client.subscribe(ch, cb)`    | `backlex.Subscribe[T](client, ch, cb, onErr)`    |
| `auth.signIn / getToken`      | `client.Auth.SignIn / Token`                     |
| `BacklexError`                | `*backlex.Error`                                 |
