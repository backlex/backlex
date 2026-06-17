# backlex — Dart / Flutter SDK

Official Dart client for the backlex API (Dart VM + Flutter: iOS, Android, web,
desktop from one codebase). A thin wrapper over the same REST + SSE surface the
TypeScript SDK (`@backlex/client`) speaks — CRUD, a fluent query builder, auth,
realtime, and storage. **Zero pub dependencies** (`dart:io` + `dart:convert`).

Part of backlex's multi-language SDK effort; follows the **hybrid** model:
hand-written ergonomic layer here, optional OpenAPI-generated models underneath.

```yaml
# pubspec.yaml
dependencies:
  backlex: ^0.0.1   # not yet published
```

## Quickstart

```dart
import 'package:backlex/backlex.dart';

final client = Client('https://api.example.com', apiKey: 'pak_...');

// CRUD
final created = await client.from('posts').create({'title': 'Hello'});

// Fluent query builder → compiles to canonical JSON (same wire format as every other SDK)
final res = await client.from('orders').query()
    .where(Filter.and([
      Filter.eq('status', 'active'),
      Filter.gte('total', 100),
      Filter.rel('customer', [Filter.eq('tier', 'gold')]),   // -> "customer.tier"
      Filter.gte('placed_at', Filter.now(sub: {'months': 1})),
    ]))
    .select(['id', 'total', 'customer.name'])
    .orderBy(['-placed_at', 'id'])
    .limit(50)
    .list();
```

`Filter.and/or` take a `List`; `in` is `Filter.isIn` (Dart reserves `in`).

## Auth

```dart
// Server-to-server: Client(url, apiKey: 'pak_...') — bearer on every call.

// App mode — end-users of a workspace:
final client = Client(url, workspace: 'myapp');
final res = await client.auth.signIn('user@example.com', 'secret'); // token auto-captured
final token = client.auth.token;                                     // persist this
// later: Client(url, workspace: 'myapp', token: token)
await client.auth.signOut();
```

`client.auth.providers()` returns the public auth surface. `signInSocial` and
`signInMagicLink` are also available.

## Realtime (SSE)

```dart
final sub = client.subscribe('items:posts', (ev) => print('${ev['event']}: ${ev['data']}'));
// ... auto-reconnects ...
sub.cancel();
```

## Storage

```dart
await client.storage.put('avatars/me.png', bytes, contentType: 'image/png');
final data = await client.storage.download('avatars/me.png');
await client.storage.list('avatars/');
await client.storage.delete('avatars/me.png');
```

## Errors

Every non-2xx response (and transport failures) throw `BacklexException` with
`status`, `code`, `details`:

```dart
try { await client.from('missing').list(); }
on BacklexException catch (e) { if (e.status == 404) { /* ... */ } }
```

## Hybrid codegen

For **typed models**, generate them from the OpenAPI spec the server ships:

```bash
openapi-generator generate \
  -i apps/web/src/server/lib/openapi-static.generated.json \
  -g dart -o sdks/dart/generated
```

## Develop

```bash
cd sdks/dart
dart pub get
dart analyze lib
dart run test/run.dart   # offline: query-builder + in-process HttpServer contract
```

## Parity with the TS SDK

| TS (`@backlex/client`)     | Dart (`backlex`)                              |
| -------------------------- | --------------------------------------------- |
| `createClient(opts)`       | `Client(url, apiKey:/workspace:/token:)`      |
| `client.from(slug)`        | `client.from(slug)`                           |
| `.query().where(f => ...)` | `.query().where(Filter.and([...]))`           |
| `f.eq / and / rel / now`   | `Filter.eq / and / rel / now`                 |
| `.orderBy().withMeta()`    | `.orderBy([...]).withMeta()`                  |
| `client.subscribe(ch, cb)` | `client.subscribe(ch, cb)` → `.cancel()`      |
| `auth.signIn / getToken`   | `client.auth.signIn / token`                  |
| `BacklexError`             | `BacklexException`                            |
