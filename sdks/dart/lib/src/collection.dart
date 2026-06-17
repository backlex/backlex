part of backlex;

/// A CRUD handle for one collection. Obtain via `client.from('slug')`.
class Collection {
  final Client _client;
  final String _slug;

  Collection(this._client, this._slug);

  Future<dynamic> list([Map<String, dynamic>? query]) =>
      _client.request('GET', '/api/items/$_slug${Client.buildSearch(query)}');

  /// Fluent builder that compiles to a ListQuery.
  QueryBuilder query() => QueryBuilder((q) => list(q));

  /// Single-function aggregate (count/sum/avg/min/max), optionally grouped.
  /// `body` = `{'agg': 'sum', 'field': 'price', 'groupBy': 'status'}`.
  Future<dynamic> aggregate(Map<String, dynamic> body) =>
      _client.request('POST', '/api/items/$_slug/aggregate', body);

  Future<dynamic> one(String id) => _client.request('GET', '/api/items/$_slug/$id');

  Future<dynamic> create(Map<String, dynamic> data) =>
      _client.request('POST', '/api/items/$_slug', data);

  Future<dynamic> update(String id, Map<String, dynamic> patch) =>
      _client.request('PATCH', '/api/items/$_slug/$id', patch);

  Future<dynamic> delete(String id) => _client.request('DELETE', '/api/items/$_slug/$id');
}
