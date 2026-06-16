package backlex

import (
	"bufio"
	"context"
	"encoding/json"
	"io"
	"net/http"
	"strings"
	"time"
)

const reconnectDelay = 3 * time.Second

// Subscribe opens an SSE subscription to a realtime channel (e.g. "items:posts")
// and invokes onEvent for each frame. It returns an unsubscribe func — the same
// contract as the TS SDK's client.subscribe. The reader runs on a goroutine and
// auto-reconnects on a dropped stream (3s back-off), replaying via Last-Event-ID
// when the server supplies ids. onError may be nil.
//
// Because Go methods cannot have type parameters, Subscribe is a package-level
// generic: backlex.Subscribe[Post](client, "items:posts", handler, nil).
func Subscribe[T any](
	c *Client,
	channel string,
	onEvent func(ItemEvent[T]),
	onError func(error),
) func() {
	ctx, cancel := context.WithCancel(context.Background())
	url := c.url + "/api/realtime/" + channel + "/subscribe"

	go func() {
		lastID := ""
		for ctx.Err() == nil {
			req, err := http.NewRequestWithContext(ctx, "GET", url, nil)
			if err != nil {
				if onError != nil {
					onError(err)
				}
				return
			}
			req.Header.Set("Accept", "text/event-stream")
			c.authHeader(req)
			if lastID != "" {
				req.Header.Set("Last-Event-ID", lastID)
			}

			resp, err := c.http.Do(req)
			switch {
			case err != nil:
				if ctx.Err() == nil && onError != nil {
					onError(err)
				}
			case resp.StatusCode != http.StatusOK:
				if onError != nil {
					onError(newError(resp.StatusCode, nil))
				}
				resp.Body.Close()
			default:
				readSSE(resp.Body, &lastID, onEvent, onError)
				resp.Body.Close()
			}

			// Back off before reconnecting, unless we've been unsubscribed.
			select {
			case <-ctx.Done():
				return
			case <-time.After(reconnectDelay):
			}
		}
	}()

	return cancel
}

// readSSE parses an SSE byte stream until it ends, dispatching complete events.
func readSSE[T any](
	r io.Reader,
	lastID *string,
	onEvent func(ItemEvent[T]),
	onError func(error),
) {
	br := bufio.NewReader(r)
	var data []string
	for {
		line, err := br.ReadString('\n')
		if err != nil {
			return // stream ended / cancelled; caller reconnects
		}
		line = strings.TrimRight(line, "\r\n")
		switch {
		case line == "":
			// Blank line dispatches the buffered event.
			if len(data) > 0 {
				payload := strings.Join(data, "\n")
				data = nil
				var ev ItemEvent[T]
				if jerr := json.Unmarshal([]byte(payload), &ev); jerr != nil {
					if onError != nil {
						onError(jerr)
					}
				} else {
					onEvent(ev)
				}
			}
		case strings.HasPrefix(line, ":"):
			// Comment / heartbeat frame.
		case strings.HasPrefix(line, "id:"):
			*lastID = strings.TrimSpace(line[len("id:"):])
		case strings.HasPrefix(line, "data:"):
			data = append(data, strings.TrimPrefix(line[len("data:"):], " "))
		}
	}
}
