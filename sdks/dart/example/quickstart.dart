// Quickstart tour of the Dart SDK (works on Dart VM + Flutter).
//   BACKLEX_URL=http://localhost:5173 BACKLEX_KEY=pak_... dart run example/quickstart.dart

import 'dart:io';

import 'package:backlex/backlex.dart';

Future<void> main() async {
  final url = Platform.environment['BACKLEX_URL'] ?? 'http://localhost:5173';
  final client = Client(url, apiKey: Platform.environment['BACKLEX_KEY']);

  // Fluent query builder → compiles to canonical JSON (same wire format as every other SDK).
  final query = client.from('posts').query()
      .where(Filter.and([
        Filter.eq('published', true),
        Filter.gte('views', 100),
        Filter.rel('author', [Filter.eq('tier', 'gold')]),
        Filter.gte('created_at', Filter.now(sub: {'days': 7})),
      ]))
      .select(['id', 'title', 'author.name'])
      .orderBy(['-created_at'])
      .limit(10)
      .withMeta('filter_count');

  try {
    final res = await query.list() as Map<String, dynamic>;
    print('got ${(res['data'] as List).length} posts (meta=${res['meta']})');
  } on BacklexException catch (e) {
    print('list failed: ${e.status} ${e.code} — ${e.message}');
  }

  // CRUD
  // final created = await client.from('posts').create({'title': 'Hello'});

  // Realtime (SSE)
  // final sub = client.subscribe('items:posts', (ev) => print('event: ${ev['event']}'));
  // await Future<void>.delayed(const Duration(seconds: 5));
  // sub.cancel();
}
