use crate::client::{self, Client};
use crate::error::BacklexError;
use serde_json::{json, Value};

/// Auth surface. In app mode (workspace set) calls target that workspace's own
/// auth pool (`/api/t/<slug>/auth/...`); otherwise the control plane.
pub struct Auth {
    client: Client,
}

impl Auth {
    pub(crate) fn new(client: Client) -> Self {
        Auth { client }
    }

    fn workspace_set(&self) -> bool {
        self.client.workspace().map(|w| !w.is_empty()).unwrap_or(false)
    }

    fn base(&self) -> String {
        match self.client.workspace() {
            Some(ws) if !ws.is_empty() => format!("/api/t/{}/auth", client::enc(ws)),
            _ => "/api/auth".to_string(),
        }
    }

    fn capture(&self, r: Value) -> Value {
        if self.workspace_set() {
            if let Some(t) = r.get("token").and_then(|v| v.as_str()) {
                self.client.set_token(Some(t.to_string()));
            }
        }
        r
    }

    /// Sign up with email + password. Pass `name: None` to omit it.
    pub fn sign_up(&self, email: &str, password: &str, name: Option<&str>) -> Result<Value, BacklexError> {
        let mut body = json!({ "email": email, "password": password });
        if let Some(n) = name {
            body["name"] = json!(n);
        }
        let r = self.client.request("POST", &format!("{}/sign-up/email", self.base()), Some(&body))?;
        Ok(self.capture(r))
    }

    pub fn sign_in(&self, email: &str, password: &str) -> Result<Value, BacklexError> {
        let body = json!({ "email": email, "password": password });
        let r = self.client.request("POST", &format!("{}/sign-in/email", self.base()), Some(&body))?;
        Ok(self.capture(r))
    }

    /// Begin an OAuth sign-in; navigate the user to the returned URL.
    pub fn sign_in_social(
        &self,
        provider: &str,
        callback_url: Option<&str>,
        error_callback_url: Option<&str>,
    ) -> Result<Value, BacklexError> {
        let mut body = json!({ "provider": provider, "disableRedirect": true });
        if let Some(c) = callback_url {
            body["callbackURL"] = json!(c);
        }
        if let Some(e) = error_callback_url {
            body["errorCallbackURL"] = json!(e);
        }
        self.client.request("POST", &format!("{}/sign-in/social", self.base()), Some(&body))
    }

    /// Send a one-time sign-in link by email.
    pub fn sign_in_magic_link(&self, email: &str, callback_url: Option<&str>) -> Result<Value, BacklexError> {
        let mut body = json!({ "email": email });
        if let Some(c) = callback_url {
            body["callbackURL"] = json!(c);
        }
        self.client.request("POST", &format!("{}/sign-in/magic-link", self.base()), Some(&body))
    }

    /// Clear the session; in app mode also drops the captured token.
    pub fn sign_out(&self) -> Result<(), BacklexError> {
        self.client.request("POST", &format!("{}/sign-out", self.base()), None)?;
        if self.workspace_set() {
            self.client.set_token(None);
        }
        Ok(())
    }

    /// Current session payload, or `{"user": null}`.
    pub fn session(&self) -> Result<Value, BacklexError> {
        self.client.request("GET", &format!("{}/get-session", self.base()), None)
    }

    /// Public auth surface (provider list + policy flags).
    pub fn providers(&self) -> Result<Value, BacklexError> {
        let r = self.client.request("GET", &format!("{}/providers", self.base()), None)?;
        Ok(r.get("data").cloned().unwrap_or(Value::Null))
    }

    /// Current workspace session token (app mode).
    pub fn token(&self) -> Option<String> {
        self.client.token()
    }

    /// Restore a workspace session token (app mode).
    pub fn set_token(&self, t: Option<String>) {
        self.client.set_token(t);
    }
}
