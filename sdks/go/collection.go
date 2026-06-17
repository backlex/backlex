package backlex

// Collection is a CRUD handle for one collection. Because Go methods cannot have
// their own type parameters, obtain one via the package-level generic From:
//
//	posts := backlex.From[Post](client, "posts")
//	res, err := posts.Query().Where(backlex.Eq("published", true)).List()
//
// Use map[string]any as T for schema-blind access, or a generated struct.
type Collection[T any] struct {
	client *Client
	slug   string
}

// From returns a typed CRUD handle for the given collection slug.
func From[T any](c *Client, slug string) *Collection[T] {
	return &Collection[T]{client: c, slug: slug}
}

func (col *Collection[T]) List(q *ListQuery) (*ListResponse[T], error) {
	var out ListResponse[T]
	if err := col.client.Do("GET", "/api/items/"+col.slug+buildSearch(q), nil, &out); err != nil {
		return nil, err
	}
	return &out, nil
}

// Query returns a fluent builder that compiles to a ListQuery.
func (col *Collection[T]) Query() *QueryBuilder[T] {
	return &QueryBuilder[T]{listFn: col.List}
}

// Aggregate runs a single-function aggregate (count/sum/avg/min/max), optionally
// grouped. body = map[string]any{"agg": "sum", "field": "price", "groupBy": "status"}.
func (col *Collection[T]) Aggregate(body any) (*AggregateResponse, error) {
	var out AggregateResponse
	if err := col.client.Do("POST", "/api/items/"+col.slug+"/aggregate", body, &out); err != nil {
		return nil, err
	}
	return &out, nil
}

func (col *Collection[T]) One(id string) (*ItemResponse[T], error) {
	var out ItemResponse[T]
	if err := col.client.Do("GET", "/api/items/"+col.slug+"/"+id, nil, &out); err != nil {
		return nil, err
	}
	return &out, nil
}

func (col *Collection[T]) Create(data any) (*ItemResponse[T], error) {
	var out ItemResponse[T]
	if err := col.client.Do("POST", "/api/items/"+col.slug, data, &out); err != nil {
		return nil, err
	}
	return &out, nil
}

func (col *Collection[T]) Update(id string, patch any) (*ItemResponse[T], error) {
	var out ItemResponse[T]
	if err := col.client.Do("PATCH", "/api/items/"+col.slug+"/"+id, patch, &out); err != nil {
		return nil, err
	}
	return &out, nil
}

func (col *Collection[T]) Delete(id string) (*DeleteResult, error) {
	var out DeleteResult
	if err := col.client.Do("DELETE", "/api/items/"+col.slug+"/"+id, nil, &out); err != nil {
		return nil, err
	}
	return &out, nil
}

// Publish flips a versioned item to published.
func (col *Collection[T]) Publish(id string) (*ItemResponse[T], error) {
	var out ItemResponse[T]
	if err := col.client.Do("POST", "/api/items/"+col.slug+"/"+id+"/publish", nil, &out); err != nil {
		return nil, err
	}
	return &out, nil
}

// Unpublish flips a versioned item back to draft.
func (col *Collection[T]) Unpublish(id string) (*ItemResponse[T], error) {
	var out ItemResponse[T]
	if err := col.client.Do("POST", "/api/items/"+col.slug+"/"+id+"/publish?unpublish=1", nil, &out); err != nil {
		return nil, err
	}
	return &out, nil
}
