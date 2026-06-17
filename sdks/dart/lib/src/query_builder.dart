part of backlex;

/// Chainable builder that compiles to a ListQuery map and runs it.
class QueryBuilder {
  final Future<dynamic> Function(Map<String, dynamic>) _listFn;
  final Map<String, dynamic> _q = {
    'filter': null,
    'sort': <String>[],
    'fields': <String>[],
    'limit': null,
    'offset': null,
    'meta': null,
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
