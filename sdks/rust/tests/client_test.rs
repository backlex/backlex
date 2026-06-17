use backlex::{filter as f, BacklexError, Client, ItemQuery, Transport};
use serde_json::{json, Value};
use std::sync::{Arc, Mutex};

// HTTP-layer tests via an injected mock transport — the Rust equivalent of the
// Python MockTransport / PHP injected-transport tests.

#[derive(Default, Clone)]
struct Rec {
    method: String,
    url: String,
    headers: Vec<(String, String)>,
    body: Option<Vec<u8>>,
}

struct Mock {
    last: Arc<Mutex<Rec>>,
}

impl Transport for Mock {
    fn send(
        &self,
        method: &str,
        url: &str,
        headers: &[(String, String)],
        body: Option<&[u8]>,
    ) -> Result<(u16, Vec<u8>), BacklexError> {
        *self.last.lock().unwrap() = Rec {
            method: method.to_string(),
            url: url.to_string(),
            headers: headers.to_vec(),
            body: body.map(|b| b.to_vec()),
        };
        let (code, text) = route(method, &url_path(url));
        Ok((code, text.into_bytes()))
    }
}

fn url_path(url: &str) -> String {
    let after = url.split_once("://").map(|(_, r)| r).unwrap_or(url);
    let p = match after.find('/') {
        Some(i) => &after[i..],
        None => "/",
    };
    p.split('?').next().unwrap().to_string()
}

fn route(method: &str, path: &str) -> (u16, String) {
    if path == "/api/items/missing" {
        return (404, r#"{"error":{"code":"NOT_FOUND","message":"no such collection"}}"#.into());
    }
    if path.ends_with("/aggregate") {
        return (200, r#"{"data":[{"value":42}]}"#.into());
    }
    if path.ends_with("/list-sessions") {
        return (200, r#"[{"id":"s1","token":"sess_1"}]"#.into());
    }
    if method == "POST" && path.contains("/sign-in/email") {
        // email + email-otp
        return if path.starts_with("/api/t/") {
            (200, r#"{"user":{"id":"u1","email":"a@b.c"},"token":"tok_123"}"#.into())
        } else {
            (200, r#"{"user":{"id":"u1","email":"a@b.c"}}"#.into())
        };
    }
    if method == "DELETE" {
        return (200, r#"{"ok":true}"#.into());
    }
    if method == "POST" || method == "PATCH" {
        return (200, r#"{"data":{"id":"x1"}}"#.into());
    }
    (200, r#"{"data":[],"limit":50,"offset":0}"#.into())
}

fn pct_decode(s: &str) -> String {
    let b = s.as_bytes();
    let mut out = Vec::new();
    let mut i = 0;
    while i < b.len() {
        if b[i] == b'%' && i + 2 < b.len() {
            if let Ok(h) = u8::from_str_radix(&s[i + 1..i + 3], 16) {
                out.push(h);
                i += 3;
                continue;
            }
        }
        out.push(b[i]);
        i += 1;
    }
    String::from_utf8_lossy(&out).to_string()
}

fn mk(builder: impl FnOnce(backlex::ClientBuilder) -> backlex::ClientBuilder) -> (Client, Arc<Mutex<Rec>>) {
    let last = Arc::new(Mutex::new(Rec::default()));
    let client = builder(Client::builder("http://test"))
        .transport(Box::new(Mock { last: last.clone() }))
        .build();
    (client, last)
}

#[test]
fn query_string_filter_is_not_double_encoded() {
    let (client, last) = mk(|b| b.api_key("pak_x"));
    client
        .from("orders")
        .query()
        .filter(f::eq("status", json!("active")))
        .order_by(&["-created_at"])
        .limit(5)
        .list()
        .unwrap();

    let rec = last.lock().unwrap();
    assert_eq!(rec.method, "GET");
    assert_eq!(url_path(&rec.url), "/api/items/orders");
    let query = rec.url.split('?').nth(1).unwrap();
    let filter_enc = query
        .split('&')
        .find(|p| p.starts_with("filter="))
        .unwrap()
        .trim_start_matches("filter=");
    // If double percent-encoded, this parse would fail.
    let parsed: Value = serde_json::from_str(&pct_decode(filter_enc)).unwrap();
    assert_eq!(parsed, json!({"status": {"_eq": "active"}}));
}

#[test]
fn password_reset_hits_the_right_path() {
    let (client, last) = mk(|b| b);
    client.auth().request_password_reset("a@b.c", None).unwrap();
    assert_eq!(url_path(&last.lock().unwrap().url), "/api/auth/request-password-reset");
}

#[test]
fn change_password_hits_the_right_path() {
    let (client, last) = mk(|b| b);
    client.auth().change_password("new", "old", false).unwrap();
    assert_eq!(url_path(&last.lock().unwrap().url), "/api/auth/change-password");
}

#[test]
fn session_management() {
    let (client, last) = mk(|b| b);
    let sessions = client.auth().list_sessions().unwrap();
    assert_eq!(url_path(&last.lock().unwrap().url), "/api/auth/list-sessions");
    assert_eq!(sessions[0]["token"], json!("sess_1"));

    client.auth().revoke_session("sess_1").unwrap();
    {
        let l = last.lock().unwrap();
        assert_eq!(url_path(&l.url), "/api/auth/revoke-session");
        let sent: Value = serde_json::from_slice(l.body.as_ref().unwrap()).unwrap();
        assert_eq!(sent["token"], json!("sess_1"));
    }

    client.auth().revoke_other_sessions().unwrap();
    assert_eq!(url_path(&last.lock().unwrap().url), "/api/auth/revoke-other-sessions");
}

#[test]
fn email_otp_flow() {
    let (client, last) = mk(|b| b);
    client.auth().send_verification_otp("a@b.c", None).unwrap();
    assert_eq!(url_path(&last.lock().unwrap().url), "/api/auth/email-otp/send-verification-otp");

    let (app, last2) = mk(|b| b.workspace("myapp"));
    let res = app.auth().sign_in_email_otp("a@b.c", "123456").unwrap();
    assert_eq!(url_path(&last2.lock().unwrap().url), "/api/t/myapp/auth/sign-in/email-otp");
    assert_eq!(res["token"], json!("tok_123"));
    assert_eq!(app.token().as_deref(), Some("tok_123"));
}

#[test]
fn query_extras_serialize() {
    let (client, last) = mk(|b| b);
    client
        .from("posts")
        .query()
        .expand(&["author"])
        .locale("tr")
        .search("hi")
        .list()
        .unwrap();
    let url = last.lock().unwrap().url.clone();
    assert!(url.contains("expand=author"));
    assert!(url.contains("locale=tr"));
    assert!(url.contains("q=hi"));
}

#[test]
fn aggregate_hits_the_right_path() {
    let (client, last) = mk(|b| b);
    let res = client
        .from("orders")
        .aggregate(&json!({ "agg": "sum", "field": "total" }))
        .unwrap();
    assert_eq!(url_path(&last.lock().unwrap().url), "/api/items/orders/aggregate");
    assert_eq!(res["data"][0]["value"], json!(42));
}

#[test]
fn one_forwards_expand_and_locale() {
    let (client, last) = mk(|b| b);
    let q = ItemQuery { expand: vec!["author".to_string()], locale: Some("tr".to_string()) };
    client.from("posts").one("p1", Some(&q)).unwrap();
    let url = &last.lock().unwrap().url;
    assert_eq!(url_path(url), "/api/items/posts/p1");
    assert!(url.contains("expand=author"));
    assert!(url.contains("locale=tr"));
}

#[test]
fn publish_unpublish_paths() {
    let (client, last) = mk(|b| b);
    client.from("posts").publish("p1").unwrap();
    let pub_ok = url_path(&last.lock().unwrap().url) == "/api/items/posts/p1/publish";
    client.from("posts").unpublish("p1").unwrap();
    assert!(pub_ok && last.lock().unwrap().url.contains("unpublish=1"));
}

#[test]
fn tenant_header_is_sent() {
    let (client, last) = mk(|b| b.tenant("myapp"));
    client.from("posts").list().unwrap();
    assert!(last
        .lock()
        .unwrap()
        .headers
        .contains(&("X-Backlex-Tenant".to_string(), "myapp".to_string())));
}

#[test]
fn api_key_bearer_header() {
    let (client, last) = mk(|b| b.api_key("pak_secret"));
    client.from("posts").list().unwrap();
    assert!(last
        .lock()
        .unwrap()
        .headers
        .contains(&("Authorization".to_string(), "Bearer pak_secret".to_string())));
}

#[test]
fn crud_methods_paths_and_body() {
    let (client, last) = mk(|b| b.api_key("pak_x"));
    let posts = client.from("posts");

    posts.create(&json!({"title": "Hi"})).unwrap();
    {
        let rec = last.lock().unwrap();
        assert_eq!(rec.method, "POST");
        assert_eq!(url_path(&rec.url), "/api/items/posts");
        let sent: Value = serde_json::from_slice(rec.body.as_ref().unwrap()).unwrap();
        assert_eq!(sent, json!({"title": "Hi"}));
    }

    posts.update("p1", &json!({"title": "Edit"})).unwrap();
    {
        let rec = last.lock().unwrap();
        assert_eq!(rec.method, "PATCH");
        assert_eq!(url_path(&rec.url), "/api/items/posts/p1");
    }

    let del = posts.delete("p1").unwrap();
    assert_eq!(last.lock().unwrap().method, "DELETE");
    assert_eq!(del["ok"], json!(true));
}

#[test]
fn app_mode_token_capture_and_replay() {
    let (client, last) = mk(|b| b.workspace("myapp"));

    let res = client.auth().sign_in("a@b.c", "pw").unwrap();
    assert_eq!(url_path(&last.lock().unwrap().url), "/api/t/myapp/auth/sign-in/email");
    assert_eq!(res["token"], json!("tok_123"));
    assert_eq!(client.token().as_deref(), Some("tok_123"));

    client.from("posts").list().unwrap();
    assert!(last
        .lock()
        .unwrap()
        .headers
        .contains(&("Authorization".to_string(), "Bearer tok_123".to_string())));

    client.auth().sign_out().unwrap();
    assert_eq!(client.token(), None);
}

#[test]
fn error_envelope_becomes_backlex_error() {
    let (client, _last) = mk(|b| b.api_key("pak_x"));
    let err = client.from("missing").list().unwrap_err();
    assert_eq!(err.status, 404);
    assert_eq!(err.code, "NOT_FOUND");
    assert_eq!(err.message, "no such collection");
}

#[test]
fn control_plane_auth_does_not_capture_token() {
    let (client, last) = mk(|b| b);
    client.auth().sign_in("a@b.c", "pw").unwrap();
    assert_eq!(url_path(&last.lock().unwrap().url), "/api/auth/sign-in/email");
    assert_eq!(client.token(), None);
}
