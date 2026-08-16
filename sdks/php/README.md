# backlex — PHP SDK

Official PHP client for the backlex API. A thin wrapper over the same REST + SSE
surface the TypeScript SDK (`@backlex/client`) speaks — CRUD, a fluent query
builder, auth, realtime, and storage. **Zero Composer dependencies** (just
`ext-curl` + `ext-json`).

Part of backlex's multi-language SDK effort; follows the **hybrid** model:
hand-written ergonomic layer here, optional OpenAPI-generated models underneath.

```bash
composer require backlex/backlex
```

## Quickstart

```php
use Backlex\Client;
use Backlex\Filter as F;

$client = new Client('https://api.example.com', ['api_key' => 'pak_...']);

// CRUD
$created = $client->from('posts')->create(['title' => 'Hello']);

// Fluent query builder → compiles to canonical JSON (same wire format as every other SDK)
$rows = $client->from('orders')->query()
    ->where(F::and_(
        F::eq('status', 'active'),
        F::gte('total', 100),
        F::rel('customer', F::eq('tier', 'gold')),       // -> "customer.tier"
        F::gte('placed_at', F::now(sub: ['months' => 1])),
    ))
    ->select('id', 'total', 'customer.name')
    ->orderBy('-placed_at', 'id')
    ->limit(50)
    ->list();
```

PHP keywords are suffixed with `_`: `and_`, `or_`, `not_`, `in_`.

## Auth

```php
// Server-to-server: new Client($url, ['api_key' => 'pak_...']) — bearer on every call.

// App mode — end-users of a workspace:
$client = new Client($url, ['workspace' => 'myapp']);
$res = $client->auth->signIn('user@example.com', 'secret');  // token auto-captured
$token = $client->auth->token();                              // persist this
// later: new Client($url, ['workspace' => 'myapp', 'token' => $token])
$client->auth->signOut();
```

`$client->auth->providers()` returns the public auth surface. `signInSocial` and
`signInMagicLink` are also available.

## Realtime (SSE)

PHP has no background threads, so realtime is the **blocking** model — `subscribe`
reads the stream and calls your handler until it returns `false`:

```php
$client->subscribe('items:posts', function (array $ev): bool {
    echo "{$ev['event']}\n";
    return true; // return false to stop
});
```

## Storage

```php
$client->storage->put('avatars/me.png', $bytes, 'image/png');
$data = $client->storage->download('avatars/me.png');
$client->storage->list('avatars/');
$client->storage->delete('avatars/me.png');
```

## Errors

Every non-2xx response (and transport failures) throw `BacklexException` with
`$status`, `$code`, `$details`:

```php
try { $client->from('missing')->list(); }
catch (BacklexException $e) { if ($e->status === 404) { /* ... */ } }
```

## Hybrid codegen

For **typed models**, generate them from the OpenAPI spec the server ships:

```bash
openapi-generator generate \
  -i apps/web/src/server/lib/openapi-static.generated.json \
  -g php -o sdks/php/generated
```

## Develop

```bash
cd sdks/php
php tests/run.php   # offline: query-builder + injected-transport HTTP-layer contract
```

## Parity with the TS SDK

| TS (`@backlex/client`)     | PHP (`Backlex`)                                  |
| -------------------------- | ------------------------------------------------ |
| `createClient(opts)`       | `new Client($url, ['api_key'=>, 'workspace'=>, 'token'=>])` |
| `client.from(slug)`        | `$client->from($slug)`                           |
| `.query().where(f => ...)` | `->query()->where(F::and_(...))`                 |
| `f.eq / and / rel / now`   | `F::eq / and_ / rel / now`                       |
| `.orderBy().withMeta()`    | `->orderBy()->withMeta()`                        |
| `client.subscribe(ch, cb)` | `$client->subscribe($ch, $cb)` (blocking)        |
| `auth.signIn / getToken`   | `$client->auth->signIn / token`                  |
| `BacklexError`             | `BacklexException`                               |
