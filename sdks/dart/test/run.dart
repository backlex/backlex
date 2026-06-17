import 'dart:convert';
import 'dart:io';

import 'package:backlex/backlex.dart';

// Self-contained runner (avoids the package:test dependency). Exits non-zero on
// any failure. Covers the same contract as the other SDK suites: the query
// builder compiles to byte-identical canonical JSON, and the HTTP layer wires
// paths/encoding/auth/errors correctly (via an in-process HttpServer).

int failures = 0;
void check(bool cond, String msg) {
  if (cond) {
    print('ok   - $msg');
  } else {
    failures++;
    print('FAIL - $msg');
  }
}

bool deepEq(dynamic a, dynamic b) {
  if (a is Map && b is Map) {
    if (a.length != b.length) return false;
    for (final k in a.keys) {
      if (!b.containsKey(k) || !deepEq(a[k], b[k])) return false;
    }
    return true;
  }
  if (a is List && b is List) {
    if (a.length != b.length) return false;
    for (var i = 0; i < a.length; i++) {
      if (!deepEq(a[i], b[i])) return false;
    }
    return true;
  }
  return a == b;
}

List<dynamic> route(Map<String, dynamic> last) {
  final method = last['method'] as String;
  final path = last['path'] as String;
  if (path == '/api/items/missing') {
    return [404, '{"error":{"code":"NOT_FOUND","message":"no such collection"}}'];
  }
  if (method == 'POST' && path.endsWith('/sign-in/email')) {
    return path.startsWith('/api/t/')
        ? [200, '{"user":{"id":"u1","email":"a@b.c"},"token":"tok_123"}']
        : [200, '{"user":{"id":"u1","email":"a@b.c"}}'];
  }
  if (method == 'DELETE') return [200, '{"ok":true}'];
  if (method == 'POST' || method == 'PATCH') return [200, '{"data":{"id":"x1"}}'];
  return [200, '{"data":[],"limit":50,"offset":0}'];
}

Future<void> main() async {
  // ---- Query builder (offline) -------------------------------------------
  check(
      deepEq(
          Filter.normalize(Filter.and([Filter.eq('status', 'active'), Filter.gte('total', 100)])),
          {
            '\$and': [
              {'status': {'_eq': 'active'}},
              {'total': {'_gte': 100}}
            ]
          }),
      'leaf + logical');

  check(deepEq(Filter.rel('customer', [Filter.eq('tier', 'gold')]), {'customer.tier': {'_eq': 'gold'}}),
      'relation hop prefixes keys');

  check(
      deepEq(Filter.rel('customer', [Filter.eq('tier', 'gold'), Filter.gte('age', 18)]), {
        '\$and': [
          {'customer.tier': {'_eq': 'gold'}},
          {'customer.age': {'_gte': 18}}
        ]
      }),
      'relation hop, multiple conds');

  check(
      deepEq(Filter.gte('placed_at', Filter.now(sub: {'months': 1})),
          {'placed_at': {'_gte': {'\$now': {'sub': {'months': 1}}}}}),
      'now relative date');

  check(deepEq(Filter.normalize({'status': 'active'}), {'status': {'_eq': 'active'}}), 'implicit equality');
  check(deepEq(Filter.normalize({'_and': [{'a': 1}]}), {'\$and': [{'a': {'_eq': 1}}]}), 'alias _and -> \$and');
  check(deepEq(Filter.normalize({'_not': {'a': 1}}), {'\$not': {'a': {'_eq': 1}}}), 'alias _not -> \$not');
  final once = Filter.normalize({'status': 'active'});
  check(deepEq(Filter.normalize(once), once), 'normalize idempotent');

  final q = Client('http://x').from('posts').query()
      .where(Filter.eq('published', true))
      .select(['id', 'title'])
      .orderBy(['-created_at', 'id'])
      .limit(50)
      .offset(10)
      .withMeta('filter_count')
      .toQuery();
  check(
      deepEq(q['filter'], {'published': {'_eq': true}}) &&
          deepEq(q['sort'], ['-created_at', 'id']) &&
          q['limit'] == 50 &&
          q['offset'] == 10 &&
          q['meta'] == 'filter_count',
      'toQuery assembly');

  // ---- HTTP layer (in-process HttpServer) --------------------------------
  final last = <String, dynamic>{};
  final server = await HttpServer.bind(InternetAddress.loopbackIPv4, 0);
  server.listen((HttpRequest req) async {
    last['method'] = req.method;
    last['path'] = req.uri.path;
    last['queryParams'] = req.uri.queryParameters;
    last['auth'] = req.headers.value('Authorization');
    last['tenant'] = req.headers.value('X-Backlex-Tenant');
    last['body'] = await utf8.decoder.bind(req).join();
    final r = route(last);
    req.response.headers.contentType = ContentType.json;
    req.response.statusCode = r[0] as int;
    req.response.write(r[1]);
    await req.response.close();
  });
  final base = 'http://127.0.0.1:${server.port}';

  var client = Client(base, apiKey: 'pak_x');
  await client.from('orders').query().where(Filter.eq('status', 'active')).orderBy(['-created_at']).limit(5).list();
  final filterParam = (last['queryParams'] as Map<String, String>)['filter'];
  check(
      last['method'] == 'GET' &&
          last['path'] == '/api/items/orders' &&
          deepEq(jsonDecode(filterParam!), {'status': {'_eq': 'active'}}),
      'query string filter is not double-encoded');

  client = Client(base, apiKey: 'pak_secret');
  await client.from('posts').list();
  check(last['auth'] == 'Bearer pak_secret', 'api key bearer header');

  client = Client(base, tenant: 'myapp');
  await client.from('posts').list();
  check(last['tenant'] == 'myapp', 'tenant header is sent');

  client = Client(base);
  await client.auth.requestPasswordReset('a@b.c');
  check(last['path'] == '/api/auth/request-password-reset', 'password reset hits the right path');

  client = Client(base, apiKey: 'pak_x');
  final posts = client.from('posts');
  await posts.create({'title': 'Hi'});
  final createOk = last['method'] == 'POST' &&
      last['path'] == '/api/items/posts' &&
      deepEq(jsonDecode(last['body'] as String), {'title': 'Hi'});
  await posts.update('p1', {'title': 'Edit'});
  final updateOk = last['method'] == 'PATCH' && last['path'] == '/api/items/posts/p1';
  final del = await posts.delete('p1');
  check(createOk && updateOk && last['method'] == 'DELETE' && (del as Map)['ok'] == true,
      'CRUD methods, paths, body');

  client = Client(base, workspace: 'myapp');
  final res = await client.auth.signIn('a@b.c', 'pw');
  final signedIn = last['path'] == '/api/t/myapp/auth/sign-in/email' &&
      res['token'] == 'tok_123' &&
      client.auth.token == 'tok_123';
  await client.from('posts').list();
  final replayed = last['auth'] == 'Bearer tok_123';
  await client.auth.signOut();
  check(signedIn && replayed && client.auth.token == null, 'app-mode token capture + replay');

  client = Client(base, apiKey: 'pak_x');
  var caught = false;
  try {
    await client.from('missing').list();
  } on BacklexException catch (e) {
    caught = e.status == 404 && e.code == 'NOT_FOUND';
  }
  check(caught, 'error envelope -> BacklexException(404, NOT_FOUND)');

  client = Client(base);
  await client.auth.signIn('a@b.c', 'pw');
  check(last['path'] == '/api/auth/sign-in/email' && client.auth.token == null,
      'control-plane auth does not capture token');

  await server.close(force: true);
  print(failures == 0 ? '\nALL PASSED' : '\n$failures FAILED');
  exit(failures == 0 ? 0 : 1);
}
