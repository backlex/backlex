// Package backlex is the official Go client for the backlex API — a thin, typed
// wrapper over the same REST + SSE surface the TypeScript SDK (@backlex/client)
// speaks: CRUD, a fluent query builder, auth, realtime, and storage.
//
// Three auth modes, mirrored from the TS SDK:
//
//   - Server-to-server: WithAPIKey("pak_...") — sent as a bearer on every call.
//   - App mode:         WithWorkspace("slug") — auth.* targets that workspace's
//     own auth surface and the session token from SignIn/SignUp is captured and
//     replayed as a bearer. Persist it with auth.Token() and restore via
//     WithToken(...).
//   - Cookie session:   omit both; the client keeps a cookie jar.
package backlex

import (
	"bytes"
	"encoding/json"
	"io"
	"net/http"
	"net/http/cookiejar"
	"net/url"
	"strconv"
	"strings"
)

// Client is the top-level backlex client. Construct with New.
type Client struct {
	url       string
	apiKey    string
	workspace string
	appToken  string
	http      *http.Client

	Auth    *Auth
	Storage *Storage
}

// Option configures a Client (functional-options pattern).
type Option func(*Client)

// WithAPIKey sets a static server key (pak_...) sent as a bearer on every call.
func WithAPIKey(key string) Option { return func(c *Client) { c.apiKey = key } }

// WithWorkspace puts the client in app mode against the named workspace.
func WithWorkspace(slug string) Option { return func(c *Client) { c.workspace = slug } }

// WithToken restores a previously-saved workspace session token (app mode).
func WithToken(token string) Option { return func(c *Client) { c.appToken = token } }

// WithHTTPClient supplies a custom *http.Client (timeouts, proxies, testing).
func WithHTTPClient(h *http.Client) Option { return func(c *Client) { c.http = h } }

// New constructs a Client. baseURL is the API origin, e.g. "https://api.example.com".
func New(baseURL string, opts ...Option) *Client {
	c := &Client{url: strings.TrimRight(baseURL, "/")}
	for _, o := range opts {
		o(c)
	}
	if c.http == nil {
		// A cookie jar keeps same-origin cookie sessions working across calls.
		jar, _ := cookiejar.New(nil)
		c.http = &http.Client{Jar: jar}
	}
	c.Auth = &Auth{client: c}
	c.Storage = &Storage{client: c}
	return c
}

func (c *Client) authHeader(req *http.Request) {
	switch {
	case c.apiKey != "":
		req.Header.Set("Authorization", "Bearer "+c.apiKey)
	case c.appToken != "":
		req.Header.Set("Authorization", "Bearer "+c.appToken)
	}
}

// Do is the raw escape hatch — issues a request with auth headers applied and,
// when out is non-nil, decodes a JSON response body into it.
func (c *Client) Do(method, path string, body, out any) error {
	var rdr io.Reader
	if body != nil {
		b, err := json.Marshal(body)
		if err != nil {
			return err
		}
		rdr = bytes.NewReader(b)
	}
	req, err := http.NewRequest(method, c.url+path, rdr)
	if err != nil {
		return err
	}
	req.Header.Set("Content-Type", "application/json")
	c.authHeader(req)

	resp, err := c.http.Do(req)
	if err != nil {
		return err
	}
	defer resp.Body.Close()

	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		var env errorEnvelope
		raw, _ := io.ReadAll(resp.Body)
		_ = json.Unmarshal(raw, &env) // best-effort; nil env yields a generic Error
		return newError(resp.StatusCode, &env)
	}
	if out == nil || resp.StatusCode == http.StatusNoContent {
		return nil
	}
	return json.NewDecoder(resp.Body).Decode(out)
}

// buildSearch serializes a ListQuery into a URL query string (mirrors buildSearch
// in index.ts). Returns "" or "?...". The filter is compact JSON, encoded exactly
// once (url.Values.Encode handles percent-encoding; the result is later carried
// verbatim as RawQuery, so there is no double-encoding).
func buildSearch(q *ListQuery) string {
	if q == nil {
		return ""
	}
	v := url.Values{}
	if len(q.Filter) > 0 {
		b, _ := json.Marshal(q.Filter)
		v.Set("filter", string(b))
	}
	if len(q.Sort) > 0 {
		v.Set("sort", strings.Join(q.Sort, ","))
	}
	if len(q.Fields) > 0 {
		v.Set("fields", strings.Join(q.Fields, ","))
	}
	if q.Limit != nil {
		v.Set("limit", strconv.Itoa(*q.Limit))
	}
	if q.Offset != nil {
		v.Set("offset", strconv.Itoa(*q.Offset))
	}
	if q.Meta != "" {
		v.Set("meta", q.Meta)
	}
	if s := v.Encode(); s != "" {
		return "?" + s
	}
	return ""
}
