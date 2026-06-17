part of backlex;

/// Chainable builder that compiles to a ListQuery map and runs it.
class QueryBuilder {
  final Future<dynamic> Function(Map<String, dynamic>) _listFn;
  final Map<String, dynamic> _q = {
    'filter': null,
    'sort': <String>[],
    'fields': <String>[],
    'expand': <String>[],
    'limit': null,
    'offset': null,
    'meta': null,
    'locale': null,
    'q': null,
  };

  QueryBuilder(this._listFn);

  QueryBuilder where(Condition cond) {
    _q['filter'] = Filter.normalize(cond);
    return this;
  }

  /// Replace the filter with a raw canonical condition (escape hatch).
  QueryBuilder filter(Condition cond) {
    _q['filter'] = Filter.normalize(cond);
    return this;
  }

  QueryBuilder select(List<String> fields) {
    (_q['fields'] as List<String>).addAll(fields);
    return this;
  }

  QueryBuilder orderBy(List<String> sorts) {
    (_q['sort'] as List<String>).addAll(sorts);
    return this;
  }

  /// Inline single-hop relations (replaces each FK with the related object).
  QueryBuilder expand(List<String> rels) {
    (_q['expand'] as List<String>).addAll(rels);
    return this;
  }

  /// Project i18n_text fields to one locale, or '*' for the full map.
  QueryBuilder locale(String loc) {
    _q['locale'] = loc;
    return this;
  }

  /// Free-text search across readable text fields.
  QueryBuilder search(String text) {
    _q['q'] = text;
    return this;
  }

  QueryBuilder limit(int n) {
    _q['limit'] = n;
    return this;
  }

  QueryBuilder offset(int n) {
    _q['offset'] = n;
    return this;
  }

  /// Request an extra COUNT: "filter_count", "total_count", or "*".
  QueryBuilder withMeta(String m) {
    _q['meta'] = m;
    return this;
  }

  /// The assembled ListQuery map — the canonical input the API takes.
  Map<String, dynamic> toQuery() => _q;

  Future<dynamic> list() => _listFn(_q);
}
