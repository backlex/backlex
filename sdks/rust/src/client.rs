use crate::auth::Auth;
use crate::collection::Collection;
use crate::error::BacklexError;
use crate::query::{ItemQuery, ListQuery};
use crate::storage::Storage;
use serde_json::Value;
use std::io::Read;
use std::sync::{Arc, Mutex};

/// Pluggable HTTP transport. The default ([`UreqTransport`]) uses `ureq`; tests
/// inject a mock. `send` returns `(status, body_bytes)`.
pub trait Transport: Send + Sync {
    fn send(
        &self,
        method: &str,
        url: &str,
        headers: &[(String, String)],
        body: Option<&[u8]>,
    ) -> Result<(u16, Vec<u8>), BacklexError>;
}

struct Inner {
    url: String,
    api_key: Option<String>,
    workspace: Option<String>,
    tenant: Option<String>,
    app_token: Mutex<Option<String>>,
    transport: Box<dyn Transport>,
}

/// The official Rust client for the backlex API — a thin wrapper over the same
/// REST + SSE surface the TypeScript SDK (@backlex/client) speaks. Cheap to clone
/// (an `Arc` internally). Three auth modes: server key, workspace app mode (token
/// capture), or cookie session.
#[derive(Clone)]
pub struct Client {
    inner: Arc<Inner>,
}

/// Builder for [`Client`].
pub struct ClientBuilder {
    url: String,
    api_key: Option<String>,
    workspace: Option<String>,
    token: Option<String>,
    tenant: Option<String>,
    transport: Option<Box<dyn Transport>>,
}

impl ClientBuilder {
    pub fn api_key(mut self, k: impl Into<String>) -> Self {
        self.api_key = Some(k.into());
        self
    }
    pub fn workspace(mut self, w: impl Into<String>) -> Self {
        self.workspace = Some(w.into());
        self
    }
    pub fn token(mut self, t: impl Into<String>) -> Self {
        self.token = Some(t.into());
        self
    }
    /// Scope every request to a tenant/workspace (slug or id) via the
    /// X-Backlex-Tenant header — for anonymous public reads or a pak_ key
    /// addressing a tenant other than its home one.
    pub fn tenant(mut self, t: impl Into<String>) -> Self {
        self.tenant = Some(t.into());
        self
    }
    pub fn transport(mut self, t: Box<dyn Transport>) -> Self {
        self.transport = Some(t);
        self
    }
    pub fn build(self) -> Client {
        Client {
            inner: Arc::new(Inner {
                url: self.url.trim_end_matches('/').to_string(),
                api_key: self.api_key,
                workspace: self.workspace,
                tenant: self.tenant,
                app_token: Mutex::new(self.token),
                transport: self.transport.unwrap_or_else(|| Box::new(UreqTransport)),
            }),
        }
    }
}

impl Client {
    pub fn builder(url: impl Into<String>) -> ClientBuilder {
        ClientBuilder {
            url: url.into(),
            api_key: None,
            workspace: None,
            token: None,
            tenant: None,
            transport: None,
        }
    }

    /// CRUD handle for a collection.
    pub fn from(&self, slug: impl Into<String>) -> Collection {
        Collection::new(self.clone(), slug.into())
    }

    pub fn auth(&self) -> Auth {
        Auth::new(self.clone())
    }

    pub fn storage(&self) -> Storage {
        Storage::new(self.clone())
    }

    /// Current workspace session token (app mode); persist and restore via the builder.
    pub fn token(&self) -> Option<String> {
        self.inner.app_token.lock().unwrap().clone()
    }

    /// Restore a workspace session token (app mode).
    pub fn set_token(&self, t: Option<String>) {
        *self.inner.app_token.lock().unwrap() = t;
    }

    pub(crate) fn url(&self) -> &str {
        &self.inner.url
    }

    pub(crate) fn workspace(&self) -> Option<&str> {
        self.inner.workspace.as_deref()
    }

    pub(crate) fn tenant(&self) -> Option<&str> {
        self.inner.tenant.as_deref()
    }

    pub(crate) fn auth_header(&self) -> Option<String> {
        if let Some(k) = &self.inner.api_key {
            return Some(format!("Bearer {}", k));
        }
        self.inner
            .app_token
            .lock()
            .unwrap()
            .as_ref()
            .map(|t| format!("Bearer {}", t))
    }

    /// Raw escape hatch — issues a JSON request with auth headers applied.
    pub fn request(&self, method: &str, path: &str, body: Option<&Value>) -> Result<Value, BacklexError> {
        let mut headers = vec![("Content-Type".to_string(), "application/json".to_string())];
        if let Some(a) = self.auth_header() {
            headers.push(("Authorization".to_string(), a));
        }
        if let Some(t) = self.tenant() {
            headers.push(("X-Backlex-Tenant".to_string(), t.to_string()));
        }
        let body_bytes = body.map(|b| serde_json::to_vec(b).unwrap());
        let url = format!("{}{}", self.inner.url, path);
        let (status, bytes) = self
            .inner
            .transport
            .send(method, &url, &headers, body_bytes.as_deref())?;
        let text = String::from_utf8_lossy(&bytes);
        if !(200..300).contains(&status) {
            return Err(BacklexError::from_body(status, &text));
        }
        if status == 204 || text.is_empty() {
            return Ok(Value::Null);
        }
        Ok(serde_json::from_str(&text).unwrap_or(Value::Null))
    }

    pub(crate) fn send_raw(
        &self,
        method: &str,
        path: &str,
        body: Option<&[u8]>,
        content_type: Option<&str>,
    ) -> Result<(u16, Vec<u8>), BacklexError> {
        let mut headers = Vec::new();
        if let Some(ct) = content_type {
            headers.push(("Content-Type".to_string(), ct.to_string()));
        }
        if let Some(a) = self.auth_header() {
            headers.push(("Authorization".to_string(), a));
        }
        if let Some(t) = self.tenant() {
            headers.push(("X-Backlex-Tenant".to_string(), t.to_string()));
        }
        let url = format!("{}{}", self.inner.url, path);
        let (status, bytes) = self.inner.transport.send(method, &url, &headers, body)?;
        if !(200..300).contains(&status) {
            return Err(BacklexError::from_body(status, &String::from_utf8_lossy(&bytes)));
        }
        Ok((status, bytes))
    }
}

/// Serialize a ListQuery into a URL query string (mirrors buildSearch in
/// index.ts). The filter is compact JSON, percent-encoded exactly once.
pub(crate) fn build_search(q: &ListQuery) -> String {
    let mut parts: Vec<String> = Vec::new();
    if let Some(f) = &q.filter {
        if f.as_object().map(|o| !o.is_empty()).unwrap_or(false) {
            parts.push(format!("filter={}", enc(&serde_json::to_string(f).unwrap())));
        }
    }
    if !q.sort.is_empty() {
        parts.push(format!("sort={}", enc(&q.sort.join(","))));
    }
    if !q.fields.is_empty() {
        parts.push(format!("fields={}", enc(&q.fields.join(","))));
    }
    if !q.expand.is_empty() {
        parts.push(format!("expand={}", enc(&q.expand.join(","))));
    }
    if let Some(l) = q.limit {
        parts.push(format!("limit={}", l));
    }
    if let Some(o) = q.offset {
        parts.push(format!("offset={}", o));
    }
    if let Some(m) = &q.meta {
        parts.push(format!("meta={}", enc(m)));
    }
    if let Some(loc) = &q.locale {
        parts.push(format!("locale={}", enc(loc)));
    }
    if let Some(text) = &q.q {
        parts.push(format!("q={}", enc(text)));
    }
    if parts.is_empty() {
        String::new()
    } else {
        format!("?{}", parts.join("&"))
    }
}

/// Serialize an [`ItemQuery`] — a strict subset of [`build_search`] (expand + locale).
pub(crate) fn build_item_search(q: &ItemQuery) -> String {
    let mut parts: Vec<String> = Vec::new();
    if !q.expand.is_empty() {
        parts.push(format!("expand={}", enc(&q.expand.join(","))));
    }
    if let Some(loc) = &q.locale {
        parts.push(format!("locale={}", enc(loc)));
    }
    if parts.is_empty() {
        String::new()
    } else {
        format!("?{}", parts.join("&"))
    }
}

/// Percent-encode a query value, escaping everything but RFC 3986 unreserved
/// characters — equivalent to JS `encodeURIComponent`, so no double-encoding.
pub(crate) fn enc(s: &str) -> String {
    let mut out = String::new();
    for b in s.bytes() {
        match b {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'_' | b'.' | b'~' => out.push(b as char),
            _ => out.push_str(&format!("%{:02X}", b)),
        }
    }
    out
}

struct UreqTransport;

impl Transport for UreqTransport {
    fn send(
        &self,
        method: &str,
        url: &str,
        headers: &[(String, String)],
        body: Option<&[u8]>,
    ) -> Result<(u16, Vec<u8>), BacklexError> {
        let mut req = ureq::request(method, url);
        for (k, v) in headers {
            req = req.set(k, v);
        }
        let result = match body {
            Some(b) => req.send_bytes(b),
            None => req.call(),
        };
        match result {
            Ok(resp) => read_response(resp),
            Err(ureq::Error::Status(code, resp)) => {
                let mut buf = Vec::new();
                let _ = resp.into_reader().read_to_end(&mut buf);
                Ok((code, buf))
            }
            Err(e) => Err(BacklexError::new(0, "NETWORK", e.to_string())),
        }
    }
}

fn read_response(resp: ureq::Response) -> Result<(u16, Vec<u8>), BacklexError> {
    let code = resp.status();
    let mut buf = Vec::new();
    resp.into_reader()
        .read_to_end(&mut buf)
        .map_err(|e| BacklexError::new(0, "NETWORK", e.to_string()))?;
    Ok((code, buf))
}
