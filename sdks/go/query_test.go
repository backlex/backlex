package backlex

import (
	"encoding/json"
	"reflect"
	"testing"
)

// canon round-trips a value through JSON so map ordering doesn't matter and we
// compare the canonical wire shape, not Go's in-memory representation.
func canon(t *testing.T, v any) any {
	t.Helper()
	b, err := json.Marshal(v)
	if err != nil {
		t.Fatalf("marshal: %v", err)
	}
	var out any
	if err := json.Unmarshal(b, &out); err != nil {
		t.Fatalf("unmarshal: %v", err)
	}
	return out
}

func eq(t *testing.T, got, want any) {
	t.Helper()
	if !reflect.DeepEqual(canon(t, got), canon(t, want)) {
		gb, _ := json.Marshal(got)
		wb, _ := json.Marshal(want)
		t.Fatalf("\n got: %s\nwant: %s", gb, wb)
	}
}

func TestLeafAndLogical(t *testing.T) {
	c := NormalizeCondition(And(Eq("status", "active"), Gte("total", 100)))
	eq(t, c, map[string]any{
		"$and": []any{
			map[string]any{"status": map[string]any{"_eq": "active"}},
			map[string]any{"total": map[string]any{"_gte": 100}},
		},
	})
}

func TestRelationHopPrefixesKeys(t *testing.T) {
	c := Rel("customer", Eq("tier", "gold"))
	eq(t, c, map[string]any{"customer.tier": map[string]any{"_eq": "gold"}})
}

func TestRelationHopMultipleConds(t *testing.T) {
	c := Rel("customer", Eq("tier", "gold"), Gte("age", 18))
	eq(t, c, map[string]any{
		"$and": []any{
			map[string]any{"customer.tier": map[string]any{"_eq": "gold"}},
			map[string]any{"customer.age": map[string]any{"_gte": 18}},
		},
	})
}

func TestNowRelativeDate(t *testing.T) {
	c := Gte("placed_at", Now(nil, map[string]int{"months": 1}))
	eq(t, c, map[string]any{
		"placed_at": map[string]any{"_gte": map[string]any{"$now": map[string]any{"sub": map[string]any{"months": 1}}}},
	})
}

func TestNormalizeImplicitEqualityAndAliases(t *testing.T) {
	eq(t, NormalizeCondition(map[string]any{"status": "active"}),
		map[string]any{"status": map[string]any{"_eq": "active"}})
	eq(t, NormalizeCondition(map[string]any{"_and": []any{map[string]any{"a": 1}}}),
		map[string]any{"$and": []any{map[string]any{"a": map[string]any{"_eq": 1}}}})
	eq(t, NormalizeCondition(map[string]any{"_not": map[string]any{"a": 1}}),
		map[string]any{"$not": map[string]any{"a": map[string]any{"_eq": 1}}})

	// Idempotent.
	once := NormalizeCondition(map[string]any{"status": "active"})
	eq(t, NormalizeCondition(once), once)
}

func TestToQueryAssembly(t *testing.T) {
	b := &QueryBuilder[map[string]any]{}
	b.Where(Eq("published", true)).
		Select("id", "title").
		OrderBy("-created_at", "id").
		Limit(50).
		Offset(10).
		WithMeta("filter_count")
	q := b.ToQuery()

	eq(t, q.Filter, map[string]any{"published": map[string]any{"_eq": true}})
	if got := q.Sort; !reflect.DeepEqual(got, []string{"-created_at", "id"}) {
		t.Fatalf("sort: %v", got)
	}
	if *q.Limit != 50 || *q.Offset != 10 || q.Meta != "filter_count" {
		t.Fatalf("scalars: %+v", q)
	}
}
