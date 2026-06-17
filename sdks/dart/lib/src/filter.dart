part of backlex;

/// The canonical JSON filter grammar (`$and`/`$or`/`$not` maps or leaf field
/// maps), shared byte-for-byte with the other SDKs.
typedef Condition = Map<String, dynamic>;

/// Static condition constructors — a Dart port of the leaf/logical helpers in
/// query.ts. Compose them and pass to [QueryBuilder.where]. Everything compiles
/// to the canonical JSON [Condition] the REST API speaks.
///
///     final rows = await client.from('orders').query()
///         .where(Filter.and([
///           Filter.eq('status', 'active'),
///           Filter.gte('total', 100),
///           Filter.rel('customer', [Filter.eq('tier', 'gold')]),  // -> "customer.tier"
///           Filter.gte('placed_at', Filter.now(sub: {'months': 1})),
///         ]))
///         .select(['id', 'total', 'customer.name'])
///         .orderBy(['-placed_at', 'id'])
///         .limit(50)
///         .list();
class Filter {
  Filter._();

  static Condition _leaf(String f, String op, dynamic v) => {
        f: {op: v}
      };

  static Condition eq(String f, dynamic v) => _leaf(f, '_eq', v);
  static Condition neq(String f, dynamic v) => _leaf(f, '_neq', v);
  static Condition gt(String f, dynamic v) => _leaf(f, '_gt', v);
  static Condition gte(String f, dynamic v) => _leaf(f, '_gte', v);
  static Condition lt(String f, dynamic v) => _leaf(f, '_lt', v);
  static Condition lte(String f, dynamic v) => _leaf(f, '_lte', v);
  static Condition isIn(String f, List<dynamic> vs) => _leaf(f, '_in', vs);
  static Condition nin(String f, List<dynamic> vs) => _leaf(f, '_nin', vs);
  static Condition between(String f, dynamic lo, dynamic hi) => _leaf(f, '_between', [lo, hi]);
  static Condition isNull(String f, [bool isNull = true]) => _leaf(f, '_null', isNull);
  static Condition empty(String f) => _leaf(f, '_empty', true);
  static Condition nempty(String f) => _leaf(f, '_nempty', true);
  static Condition contains(String f, String v) => _leaf(f, '_contains', v);
  static Condition icontains(String f, String v) => _leaf(f, '_icontains', v);
  static Condition startsWith(String f, String v) => _leaf(f, '_starts_with', v);
  static Condition endsWith(String f, String v) => _leaf(f, '_ends_with', v);

  static Condition and(List<Condition> conds) => {'\$and': conds};
  static Condition or(List<Condition> conds) => {'\$or': conds};
  static Condition not(Condition cond) => {'\$not': cond};

  /// Traverse a relation one hop: every leaf key produced by [conds] is prefixed
  /// with `head.`. Multiple conds are ANDed first.
  static Condition rel(String head, List<Condition> conds) {
    final inner = conds.length == 1 ? conds[0] : <String, dynamic>{'\$and': conds};
    return _prefixKeys(inner, head);
  }

  /// Relative-date value, e.g. `Filter.now(sub: {'months': 1})`.
  static Map<String, dynamic> now({Map<String, int>? add, Map<String, int>? sub}) {
    final opts = <String, dynamic>{};
    if (add != null) opts['add'] = add;
    if (sub != null) opts['sub'] = sub;
    return {'\$now': opts};
  }

  static Condition _prefixKeys(Condition cond, String head) {
    if (cond['\$and'] is List) {
      return {'\$and': (cond['\$and'] as List).map((c) => _prefixKeys(c as Condition, head)).toList()};
    }
    if (cond['\$or'] is List) {
      return {'\$or': (cond['\$or'] as List).map((c) => _prefixKeys(c as Condition, head)).toList()};
    }
    if (cond['\$not'] is Map) {
      return {'\$not': _prefixKeys(cond['\$not'] as Condition, head)};
    }
    final out = <String, dynamic>{};
    cond.forEach((k, v) => out['$head.$k'] = v);
    return out;
  }

  /// Turn any accepted filter shape into the canonical Condition: handles
  /// `$and`/`$or`/`$not` (and their `_` aliases) and implicit equality
  /// (`{'status': 'active'}` -> `{'status': {'_eq': 'active'}}`). Idempotent.
  static Condition normalize(dynamic raw) {
    if (raw is! Map) return {};

    final and = raw['\$and'] ?? raw['_and'];
    if (and is List) return {'\$and': and.map((c) => normalize(c)).toList()};
    final or = raw['\$or'] ?? raw['_or'];
    if (or is List) return {'\$or': or.map((c) => normalize(c)).toList()};
    if (raw.containsKey('\$not') || raw.containsKey('_not')) {
      return {'\$not': normalize(raw['\$not'] ?? raw['_not'])};
    }

    final out = <String, dynamic>{};
    raw.forEach((k, v) {
      if (v is Map && _comparison(v)) {
        out[k as String] = v;
      } else if (v is Map) {
        out[k as String] = v; // unknown object shape — pass through
      } else {
        out[k as String] = {'_eq': v};
      }
    });
    return out;
  }

  static bool _comparison(Map o) =>
      o.isNotEmpty && o.keys.every((k) => k is String && k.startsWith('_'));
}
