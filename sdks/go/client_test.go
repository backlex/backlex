package backlex

import (
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

type capture struct {
	method string
	path   string
	query  map[string][]string
	auth   string
	tenant string
	body   []byte
}

// newServer returns an httptest server that records the last request into *cap
// and answers with canned responses keyed by path/method.
func newServer(cap *capture) *httptest.Server {
	return httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		body, _ := io.ReadAll(r.Body)
		*cap = capture{
			method: r.Method,
			path:   r.URL.Path,
			query:  r.URL.Query(),
			auth:   r.Header.Get("Authorization"),
			tenant: r.Header.Get("X-Backlex-Tenant"),
			body:   body,
		}
		w.Header().Set("Content-Type", "application/json")
		switch {
		case r.URL.Path == "/api/items/missing":
			w.WriteHeader(404)
			_, _ = w.Write([]byte(`{"error":{"code":"NOT_FOUND","message":"no such collection"}}`))
		case strings.HasSuffix(r.URL.Path, "/aggregate"):
			_, _ = w.Write([]byte(`{"data":[{"value":42}]}`))
		case r.Method == "POST" && strings.HasPrefix(r.URL.Path, "/api/t/") && strings.Contains(r.URL.Path, "/sign-in/email"):
			// Workspace sign-in (email or email-otp) returns a session token.
			_, _ = w.Write([]byte(`{"user":{"id":"u1","email":"a@b.c"},"token":"tok_123"}`))
		case r.Method == "DELETE":
			_, _ = w.Write([]byte(`{"ok":true}`))
		case r.Method == "POST" || r.Method == "PATCH":
			_, _ = w.Write([]byte(`{"data":{"id":"x1"}}`))
		case r.Method == "GET" && strings.Count(r.URL.Path, "/") == 4:
			// Single-item read: /api/items/<slug>/<id> — object-shaped data.
			_, _ = w.Write([]byte(`{"data":{"id":"x1"}}`))
		default:
			_, _ = w.Write([]byte(`{"data":[],"limit":50,"offset":0}`))
		}
	}))
}

func TestQueryStringNotDoubleEncoded(t *testing.T) {
	var cap capture
	srv := newServer(&cap)
	defer srv.Close()

	c := New(srv.URL, WithAPIKey("pak_x"))
	_, err := From[map[string]any](c, "orders").Query().
		Where(Eq("status", "active")).
		OrderBy("-created_at").
		Limit(5).
		List()
	if err != nil {
		t.Fatalf("list: %v", err)
	}

	if cap.method != "GET" || cap.path != "/api/items/orders" {
		t.Fatalf("method/path: %s %s", cap.method, cap.path)
	}
	// If the filter were double percent-encoded, this Unmarshal would fail.
	var filter map[string]any
	if err := json.Unmarshal([]byte(cap.query["filter"][0]), &filter); err != nil {
		t.Fatalf("filter not clean JSON: %v (raw=%q)", err, cap.query["filter"][0])
	}
	eq(t, filter, map[string]any{"status": map[string]any{"_eq": "active"}})
	if cap.query["sort"][0] != "-created_at" || cap.query["limit"][0] != "5" {
		t.Fatalf("sort/limit: %v", cap.query)
	}
}

func TestQueryExtrasSerialize(t *testing.T) {
	var cap capture
	srv := newServer(&cap)
	defer srv.Close()
	c := New(srv.URL)
	if _, err := From[map[string]any](c, "posts").Query().Expand("author").Locale("tr").Search("hi").List(); err != nil {
		t.Fatal(err)
	}
	if cap.query["expand"][0] != "author" || cap.query["locale"][0] != "tr" || cap.query["q"][0] != "hi" {
		t.Fatalf("extras: %v", cap.query)
	}
}

func TestOneWithQueryExtras(t *testing.T) {
	var cap capture
	srv := newServer(&cap)
	defer srv.Close()
	c := New(srv.URL)
	if _, err := From[map[string]any](c, "posts").One("p1", &ItemQuery{Expand: []string{"author"}, Locale: "tr"}); err != nil {
		t.Fatal(err)
	}
	if cap.path != "/api/items/posts/p1" {
		t.Fatalf("one path: %s", cap.path)
	}
	if cap.query["expand"][0] != "author" || cap.query["locale"][0] != "tr" {
		t.Fatalf("one extras: %v", cap.query)
	}
}

func TestPublishUnpublishPaths(t *testing.T) {
	var cap capture
	srv := newServer(&cap)
	defer srv.Close()
	c := New(srv.URL)
	if _, err := From[map[string]any](c, "posts").Publish("p1"); err != nil {
		t.Fatal(err)
	}
	if cap.method != "POST" || cap.path != "/api/items/posts/p1/publish" {
		t.Fatalf("publish: %s %s", cap.method, cap.path)
	}
	if _, err := From[map[string]any](c, "posts").Unpublish("p1"); err != nil {
		t.Fatal(err)
	}
	if cap.query["unpublish"][0] != "1" {
		t.Fatalf("unpublish: %v", cap.query)
	}
}

func TestAggregatePath(t *testing.T) {
	var cap capture
	srv := newServer(&cap)
	defer srv.Close()
	c := New(srv.URL)
	if _, err := From[map[string]any](c, "orders").Aggregate(map[string]any{"agg": "sum", "field": "total"}); err != nil {
		t.Fatal(err)
	}
	if cap.method != "POST" || cap.path != "/api/items/orders/aggregate" {
		t.Fatalf("aggregate: %s %s", cap.method, cap.path)
	}
}

func TestTenantHeader(t *testing.T) {
	var cap capture
	srv := newServer(&cap)
	defer srv.Close()
	c := New(srv.URL, WithTenant("myapp"))
	if _, err := From[map[string]any](c, "posts").List(nil); err != nil {
		t.Fatal(err)
	}
	if cap.tenant != "myapp" {
		t.Fatalf("tenant header: %q", cap.tenant)
	}
}

func TestPasswordResetPath(t *testing.T) {
	var cap capture
	srv := newServer(&cap)
	defer srv.Close()
	c := New(srv.URL)
	if _, err := c.Auth.RequestPasswordReset("a@b.c", ""); err != nil {
		t.Fatal(err)
	}
	if cap.path != "/api/auth/request-password-reset" {
		t.Fatalf("path: %s", cap.path)
	}
}

func TestEmailOTPFlow(t *testing.T) {
	var cap capture
	srv := newServer(&cap)
	defer srv.Close()
	c := New(srv.URL)
	if _, err := c.Auth.SendVerificationOTP("a@b.c", ""); err != nil {
		t.Fatal(err)
	}
	if cap.path != "/api/auth/email-otp/send-verification-otp" {
		t.Fatalf("send path: %s", cap.path)
	}

	app := New(srv.URL, WithWorkspace("myapp"))
	res, err := app.Auth.SignInEmailOTP("a@b.c", "123456")
	if err != nil {
		t.Fatal(err)
	}
	if cap.path != "/api/t/myapp/auth/sign-in/email-otp" {
		t.Fatalf("signin path: %s", cap.path)
	}
	if res.Token != "tok_123" || app.Auth.Token() != "tok_123" {
		t.Fatalf("token not captured: %q / %q", res.Token, app.Auth.Token())
	}
}

func TestChangePasswordPath(t *testing.T) {
	var cap capture
	srv := newServer(&cap)
	defer srv.Close()
	c := New(srv.URL)
	if _, err := c.Auth.ChangePassword("new", "old", false); err != nil {
		t.Fatal(err)
	}
	if cap.path != "/api/auth/change-password" {
		t.Fatalf("path: %s", cap.path)
	}
}

func TestAPIKeyBearer(t *testing.T) {
	var cap capture
	srv := newServer(&cap)
	defer srv.Close()
	c := New(srv.URL, WithAPIKey("pak_secret"))
	if _, err := From[map[string]any](c, "posts").List(nil); err != nil {
		t.Fatal(err)
	}
	if cap.auth != "Bearer pak_secret" {
		t.Fatalf("auth header: %q", cap.auth)
	}
}

func TestCRUDMethodsPathsBody(t *testing.T) {
	var cap capture
	srv := newServer(&cap)
	defer srv.Close()
	c := New(srv.URL, WithAPIKey("pak_x"))
	posts := From[map[string]any](c, "posts")

	if _, err := posts.Create(map[string]any{"title": "Hi"}); err != nil {
		t.Fatal(err)
	}
	if cap.method != "POST" || cap.path != "/api/items/posts" {
		t.Fatalf("create: %s %s", cap.method, cap.path)
	}
	var sent map[string]any
	_ = json.Unmarshal(cap.body, &sent)
	eq(t, sent, map[string]any{"title": "Hi"})

	if _, err := posts.Update("p1", map[string]any{"title": "Edit"}); err != nil {
		t.Fatal(err)
	}
	if cap.method != "PATCH" || cap.path != "/api/items/posts/p1" {
		t.Fatalf("update: %s %s", cap.method, cap.path)
	}

	del, err := posts.Delete("p1")
	if err != nil {
		t.Fatal(err)
	}
	if cap.method != "DELETE" || !del.OK {
		t.Fatalf("delete: %s ok=%v", cap.method, del.OK)
	}
}

func TestAppModeTokenCaptureAndReplay(t *testing.T) {
	var cap capture
	srv := newServer(&cap)
	defer srv.Close()
	c := New(srv.URL, WithWorkspace("myapp"))

	res, err := c.Auth.SignIn("a@b.c", "pw")
	if err != nil {
		t.Fatal(err)
	}
	if cap.path != "/api/t/myapp/auth/sign-in/email" {
		t.Fatalf("auth path: %s", cap.path)
	}
	if res.Token != "tok_123" || c.Auth.Token() != "tok_123" {
		t.Fatalf("token not captured: %q / %q", res.Token, c.Auth.Token())
	}

	if _, err := From[map[string]any](c, "posts").List(nil); err != nil {
		t.Fatal(err)
	}
	if cap.auth != "Bearer tok_123" {
		t.Fatalf("token not replayed: %q", cap.auth)
	}

	if err := c.Auth.SignOut(); err != nil {
		t.Fatal(err)
	}
	if c.Auth.Token() != "" {
		t.Fatalf("token not cleared: %q", c.Auth.Token())
	}
}

func TestErrorEnvelope(t *testing.T) {
	var cap capture
	srv := newServer(&cap)
	defer srv.Close()
	c := New(srv.URL, WithAPIKey("pak_x"))

	_, err := From[map[string]any](c, "missing").List(nil)
	var be *Error
	if !errors.As(err, &be) {
		t.Fatalf("expected *Error, got %T", err)
	}
	if be.Status != 404 || be.Code != "NOT_FOUND" || be.Message != "no such collection" {
		t.Fatalf("error fields: %+v", be)
	}
}

func TestControlPlaneAuthNoTokenCapture(t *testing.T) {
	var cap capture
	srv := newServer(&cap)
	defer srv.Close()
	c := New(srv.URL) // no workspace → control plane

	// control-plane sign-in hits /api/auth and returns no token in our stub
	_, _ = c.Auth.SignIn("a@b.c", "pw")
	if cap.path != "/api/auth/sign-in/email" {
		t.Fatalf("path: %s", cap.path)
	}
	if c.Auth.Token() != "" {
		t.Fatalf("token should not be captured in control-plane mode: %q", c.Auth.Token())
	}
}
