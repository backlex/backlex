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

  Future<dynamic> one(String id) => _client.request('GET', '/api/items/$_slug/$id');

  Future<dynamic> create(Map<String, dynamic> data) =>
      _client.request('POST', '/api/items/$_slug', data);

  Future<dynamic> update(String id, Map<String, dynamic> patch) =>
      _client.request('PATCH', '/api/items/$_slug/$id', patch);

  Future<dynamic> delete(String id) => _client.request('DELETE', '/api/items/$_slug/$id');
}
