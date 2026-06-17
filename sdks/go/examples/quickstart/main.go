// Quickstart tour of the Go SDK.
//
//	BACKLEX_URL=http://localhost:5173 BACKLEX_KEY=pak_... go run ./examples/quickstart
package main

import (
	"errors"
	"fmt"
	"os"

	backlex "github.com/backlex/backlex-go"
)

// Post is an example row type — pair with `backlex gen-types` output or a struct.
type Post struct {
	ID        string `json:"id"`
	Title     string `json:"title"`
	Published bool   `json:"published"`
}

func main() {
	url := os.Getenv("BACKLEX_URL")
	if url == "" {
		url = "http://localhost:5173"
	}
	client := backlex.New(url, backlex.WithAPIKey(os.Getenv("BACKLEX_KEY")))

	// Fluent query builder → compiles to canonical JSON (same wire format as TS/Python).
	q := backlex.From[Post](client, "posts").Query().
		Where(backlex.And(
			backlex.Eq("published", true),
			backlex.Gte("views", 100),
			backlex.Rel("author", backlex.Eq("tier", "gold")),
			backlex.Gte("created_at", backlex.Now(nil, map[string]int{"days": 7})),
		)).
		Select("id", "title", "author.name").
		OrderBy("-created_at").
		Limit(10).
		WithMeta("filter_count")

	res, err := q.List()
	if err != nil {
		var be *backlex.Error
		if errors.As(err, &be) {
			fmt.Printf("list failed: %d %s — %s\n", be.Status, be.Code, be.Message)
		} else {
			fmt.Println("list failed:", err)
		}
		return
	}
	fmt.Printf("got %d posts (meta=%v)\n", len(res.Data), res.Meta)

	// CRUD
	// created, _ := backlex.From[Post](client, "posts").Create(map[string]any{"title": "Hello"})
	// backlex.From[Post](client, "posts").Update(created.Data.ID, map[string]any{"title": "Edited"})
	// backlex.From[Post](client, "posts").Delete(created.Data.ID)

	// Realtime (SSE on a goroutine)
	// unsub := backlex.Subscribe[Post](client, "items:posts", func(ev backlex.ItemEvent[Post]) {
	// 	fmt.Println("event:", ev.Event, ev.Data.Title)
	// }, nil)
	// defer unsub()
}
