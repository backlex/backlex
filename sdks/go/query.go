package backlex

// Fluent query builder + filter helpers — a Go port of query.ts and the
// schema-blind half of condition.ts. Filters compile to the same canonical JSON
// Condition the REST API already speaks; ToQuery() returns a plain ListQuery, so
// there is no new wire format.
//
// Go has no lambda-DSL, so leaf/logical conditions are package-level functions:
//
//	rows, err := backlex.From[Order](client, "orders").Query().
//		Where(backlex.And(
//			backlex.Eq("status", "active"),
//			backlex.Gte("total", 100),
//			backlex.Rel("customer", backlex.Eq("tier", "gold")), // -> "customer.tier"
//			backlex.Gte("placed_at", backlex.Now(nil, map[string]int{"months": 1})),
//		)).
//		Select("id", "total", "customer.name").
//		OrderBy("-placed_at", "id").
//		Limit(50).
//		List()

func leaf(field, op string, value any) Condition {
	return Condition{field: map[string]any{op: value}}
}

// Comparison + logical condition constructors.

func Eq(field string, v any) Condition     { return leaf(field, "_eq", v) }
func Neq(field string, v any) Condition    { return leaf(field, "_neq", v) }
func Gt(field string, v any) Condition     { return leaf(field, "_gt", v) }
func Gte(field string, v any) Condition    { return leaf(field, "_gte", v) }
func Lt(field string, v any) Condition     { return leaf(field, "_lt", v) }
func Lte(field string, v any) Condition    { return leaf(field, "_lte", v) }
func In(field string, vs []any) Condition  { return leaf(field, "_in", vs) }
func Nin(field string, vs []any) Condition { return leaf(field, "_nin", vs) }
func Between(field string, lo, hi any) Condition {
	return leaf(field, "_between", []any{lo, hi})
}
func IsNull(field string, isNull bool) Condition { return leaf(field, "_null", isNull) }
func Empty(field string) Condition               { return leaf(field, "_empty", true) }
func Nempty(field string) Condition              { return leaf(field, "_nempty", true) }
func Contains(field, v string) Condition         { return leaf(field, "_contains", v) }
func IContains(field, v string) Condition        { return leaf(field, "_icontains", v) }
func StartsWith(field, v string) Condition       { return leaf(field, "_starts_with", v) }
func EndsWith(field, v string) Condition         { return leaf(field, "_ends_with", v) }

func And(conds ...Condition) Condition { return Condition{"$and": toAnySlice(conds)} }
func Or(conds ...Condition) Condition  { return Condition{"$or": toAnySlice(conds)} }
func Not(cond Condition) Condition     { return Condition{"$not": cond} }

// Rel traverses a relation one hop: every leaf key produced by conds is prefixed
// with head + ".". Multiple conds are ANDed before prefixing.
func Rel(head string, conds ...Condition) Condition {
	var inner Condition
	if len(conds) == 1 {
		inner = conds[0]
	} else {
		inner = And(conds...)
	}
	return prefixKeys(inner, head)
}

// Now is a relative-date value, e.g. Now(nil, map[string]int{"months": 1}).
func Now(add, sub map[string]int) map[string]any {
	opts := map[string]any{}
	if add != nil {
		opts["add"] = add
	}
	if sub != nil {
		opts["sub"] = sub
	}
	return map[string]any{"$now": opts}
}

func toAnySlice(conds []Condition) []any {
	out := make([]any, len(conds))
	for i, c := range conds {
		out[i] = c
	}
	return out
}

// prefixKeys prefixes every leaf field key of a condition with head+"." (relation hop).
func prefixKeys(cond Condition, head string) Condition {
	if arr, ok := cond["$and"].([]any); ok {
		return Condition{"$and": mapConds(arr, head)}
	}
	if arr, ok := cond["$or"].([]any); ok {
		return Condition{"$or": mapConds(arr, head)}
	}
	if not, ok := cond["$not"]; ok {
		if nc, ok := not.(Condition); ok {
			return Condition{"$not": prefixKeys(nc, head)}
		}
	}
	out := Condition{}
	for k, v := range cond {
		out[head+"."+k] = v
	}
	return out
}

func mapConds(arr []any, head string) []any {
	out := make([]any, len(arr))
	for i, c := range arr {
		if cc, ok := c.(Condition); ok {
			out[i] = prefixKeys(cc, head)
		} else {
			out[i] = c
		}
	}
	return out
}

// NormalizeCondition turns any accepted filter shape into the canonical Condition:
// handles $and/$or/$not (and their _ aliases) and implicit equality
// ({"status":"active"} -> {"status":{"_eq":"active"}}). Idempotent.
func NormalizeCondition(raw any) Condition {
	m, ok := raw.(Condition)
	if !ok {
		m2, ok2 := raw.(map[string]any)
		if !ok2 {
			return nil
		}
		m = m2
	}

	if and := firstSlice(m, "$and", "_and"); and != nil {
		return Condition{"$and": normalizeSlice(and)}
	}
	if or := firstSlice(m, "$or", "_or"); or != nil {
		return Condition{"$or": normalizeSlice(or)}
	}
	if not, ok := firstKey(m, "$not", "_not"); ok {
		return Condition{"$not": NormalizeCondition(not)}
	}

	out := Condition{}
	for k, v := range m {
		if obj, ok := asMap(v); ok && looksLikeComparison(obj) {
			out[k] = v
		} else if _, ok := asMap(v); ok {
			out[k] = v // unknown object shape — pass through
		} else {
			out[k] = map[string]any{"_eq": v}
		}
	}
	return out
}

func firstSlice(m map[string]any, keys ...string) []any {
	for _, k := range keys {
		if v, ok := m[k]; ok {
			if s, ok := v.([]any); ok {
				return s
			}
		}
	}
	return nil
}

func firstKey(m map[string]any, keys ...string) (any, bool) {
	for _, k := range keys {
		if v, ok := m[k]; ok {
			return v, true
		}
	}
	return nil, false
}

func normalizeSlice(arr []any) []any {
	out := make([]any, len(arr))
	for i, c := range arr {
		out[i] = NormalizeCondition(c)
	}
	return out
}

func asMap(v any) (map[string]any, bool) {
	if c, ok := v.(Condition); ok {
		return c, true
	}
	m, ok := v.(map[string]any)
	return m, ok
}

func looksLikeComparison(o map[string]any) bool {
	if len(o) == 0 {
		return false
	}
	for k := range o {
		if len(k) == 0 || k[0] != '_' {
			return false
		}
	}
	return true
}

// QueryBuilder assembles a ListQuery and runs it through the collection's list fn.
type QueryBuilder[T any] struct {
	listFn func(*ListQuery) (*ListResponse[T], error)
	q      ListQuery
}

func (b *QueryBuilder[T]) Where(cond Condition) *QueryBuilder[T] {
	b.q.Filter = NormalizeCondition(cond)
	return b
}

// Filter replaces the filter with a raw canonical condition (escape hatch).
func (b *QueryBuilder[T]) Filter(cond Condition) *QueryBuilder[T] {
	b.q.Filter = NormalizeCondition(cond)
	return b
}

func (b *QueryBuilder[T]) Select(fields ...string) *QueryBuilder[T] {
	b.q.Fields = append(b.q.Fields, fields...)
	return b
}

func (b *QueryBuilder[T]) OrderBy(sorts ...string) *QueryBuilder[T] {
	b.q.Sort = append(b.q.Sort, sorts...)
	return b
}

func (b *QueryBuilder[T]) Limit(n int) *QueryBuilder[T] {
	b.q.Limit = &n
	return b
}

func (b *QueryBuilder[T]) Offset(n int) *QueryBuilder[T] {
	b.q.Offset = &n
	return b
}

// WithMeta requests an extra COUNT: "filter_count", "total_count", or "*".
func (b *QueryBuilder[T]) WithMeta(m string) *QueryBuilder[T] {
	b.q.Meta = m
	return b
}

// ToQuery returns the assembled ListQuery — the canonical input the REST API takes.
func (b *QueryBuilder[T]) ToQuery() *ListQuery {
	return &b.q
}

func (b *QueryBuilder[T]) List() (*ListResponse[T], error) {
	return b.listFn(&b.q)
}
