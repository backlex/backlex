# backlex — .NET SDK

Official .NET client for the backlex API. A thin, typed wrapper over the same
REST + SSE surface the TypeScript SDK (`@backlex/client`) speaks — CRUD, a fluent
query builder, auth, realtime, and storage. Async throughout; **zero NuGet
dependencies** (only `System.Net.Http` + `System.Text.Json` from the BCL).

Part of backlex's multi-language SDK effort; follows the **hybrid** model:
hand-written ergonomic layer here, optional OpenAPI-generated models underneath
(see [Hybrid codegen](#hybrid-codegen)).

```bash
dotnet add package Backlex
```

## Quickstart

```csharp
using Backlex;
using static Backlex.Filter;

var client = new BacklexClient("https://api.example.com",
    new BacklexClientOptions { ApiKey = "pak_..." });

// CRUD — From<T> is a generic method.
var created = await client.From<Dictionary<string, object?>>("posts")
    .CreateAsync(new Dictionary<string, object?> { ["title"] = "Hello" });

// Fluent query builder → compiles to canonical JSON (same wire format as TS/Python/Go)
var res = await client.From<Dictionary<string, object?>>("orders").Query()
    .Where(And(
        Eq("status", "active"),
        Gte("total", 100),
        Rel("customer", Eq("tier", "gold")),                  // → "customer.tier"
        Gte("placed_at", Now(sub: new() { ["months"] = 1 }))))
    .Select("id", "total", "customer.name")
    .OrderBy("-placed_at", "id")
    .Limit(50)
    .ListAsync();
```

Use a generated POCO (or `Dictionary<string, object?>`) as the type argument for
typed rows: `client.From<Post>("posts")`.

## Auth

```csharp
// Server-to-server: BacklexClientOptions { ApiKey = "pak_..." } — bearer on every call.

// App mode — end-users of a workspace:
var client = new BacklexClient(url, new BacklexClientOptions { Workspace = "myapp" });
var res = await client.Auth.SignInAsync("user@example.com", "password"); // token auto-captured
var token = client.Auth.Token;                                            // persist this
// later: new BacklexClientOptions { Workspace = "myapp", Token = token } to restore
await client.Auth.SignOutAsync();
```

`client.Auth.ProvidersAsync()` returns the public auth surface. `SignInSocialAsync`
and `SignInMagicLinkAsync` are also available.

## Realtime (SSE)

```csharp
using var sub = client.Subscribe<Post>("items:posts", ev =>
    Console.WriteLine($"{ev.Event}: {ev.Data.Title}"));
// disposing `sub` unsubscribes; the reader runs on a background task
```

## Storage

```csharp
await client.Storage.PutAsync("avatars/me.png", bytes, "image/png");
byte[] data = await client.Storage.DownloadAsync("avatars/me.png");
await client.Storage.ListAsync("avatars/");
await client.Storage.DeleteAsync("avatars/me.png");
```

## Errors

Every non-2xx response throws `BacklexException` with `Status`, `Code`, `Message`,
and `Details`:

```csharp
try { await client.From<Post>("missing").ListAsync(); }
catch (BacklexException e) when (e.Status == 404) { /* ... */ }
```

## Hybrid codegen

The hand-written layer is small and stable. For **typed models** of the system
API and your collections, generate them from the OpenAPI spec the server ships —
no .NET-specific wire format is introduced.

```bash
# System API models from the static OpenAPI spec:
openapi-generator generate \
  -i apps/web/src/server/lib/openapi-static.generated.json \
  -g csharp -o sdks/dotnet/src/Backlex.Models

# Per-collection types: pass a generated POCO (or Dictionary<string,object?>) as From<T>.
```

## Develop

```bash
cd sdks/dotnet
dotnet build src/Backlex            # zero warnings (TreatWarningsAsErrors)
dotnet test  tests/Backlex.Tests    # offline: query-builder + HTTP-layer contract
```

> The PoC targets `net10.0` (the locally-installed SDK). A published package would
> multi-target `net8.0;net10.0`.

## Parity with the TS SDK

| TS (`@backlex/client`)        | .NET (`Backlex`)                                       |
| ----------------------------- | ------------------------------------------------------ |
| `createClient(opts)`          | `new BacklexClient(url, opts)`                          |
| `client.from(slug)`           | `client.From<T>(slug)`                                  |
| `.query().where(f => ...)`    | `.Query().Where(And(...))` (`using static Backlex.Filter`) |
| `f.eq / and / rel / now`      | `Eq / And / Rel / Now`                                 |
| `.orderBy().withMeta()`       | `.OrderBy().WithMeta()`                                |
| `client.subscribe(ch, cb)`    | `client.Subscribe<T>(ch, cb)` → `IDisposable`          |
| `auth.signIn / getToken`      | `client.Auth.SignInAsync / Token`                      |
| `BacklexError`                | `BacklexException`                                     |
