package backlex

// Wire types, mirrored from packages/client/src/types.ts. The API speaks plain
// JSON; these are the envelopes the SDK (de)serializes. The canonical Condition
// grammar is shared with the TS and Python SDKs — there is no Go-specific wire
// format.

// Condition is the canonical JSON filter grammar ($and / $or / $not / leaf maps).
type Condition = map[string]any

// ListQuery is the set of query parameters a list/query call serializes into the
// URL. Built by QueryBuilder; rarely constructed by hand.
type ListQuery struct {
	Filter Condition
	Sort   []string
	Fields []string
	Limit  *int
	Offset *int
	Meta   string // "filter_count" | "total_count" | "*"
}

// ListResponse is the result of a collection list/query call. T is the row type
// (use map[string]any for schema-blind access, or a generated struct).
type ListResponse[T any] struct {
	Data   []T            `json:"data"`
	Limit  int            `json:"limit"`
	Offset int            `json:"offset"`
	Meta   map[string]int `json:"meta,omitempty"`
}

// ItemResponse is the single-item envelope: {"data": {...}}.
type ItemResponse[T any] struct {
	Data T `json:"data"`
}

// ItemEvent is a realtime event frame: {"event": ..., "data": {...}}.
type ItemEvent[T any] struct {
	Event string `json:"event"` // "created" | "updated" | "deleted"
	Data  T      `json:"data"`
}

// AuthUser is the authenticated principal returned by sign-in/up.
type AuthUser struct {
	ID    string  `json:"id"`
	Email string  `json:"email"`
	Name  *string `json:"name,omitempty"`
	Image *string `json:"image,omitempty"`
}

// AuthResult is the sign-in/up envelope. Token is only present in app mode.
type AuthResult struct {
	User  AuthUser `json:"user"`
	Token string   `json:"token,omitempty"`
}

// DeleteResult is the {"ok": true} envelope returned by delete endpoints.
type DeleteResult struct {
	OK bool `json:"ok"`
}
