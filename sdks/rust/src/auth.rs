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

    /// Email a one-time numeric code (requires the email-otp provider). `otp_type`
    /// is `"sign-in"` (pass `None` for the default), `"email-verification"` or
    /// `"forget-password"`. Complete a sign-in with [`sign_in_email_otp`](Self::sign_in_email_otp).
    pub fn send_verification_otp(&self, email: &str, otp_type: Option<&str>) -> Result<Value, BacklexError> {
        let body = json!({ "email": email, "type": otp_type.unwrap_or("sign-in") });
        self.client.request("POST", &format!("{}/email-otp/send-verification-otp", self.base()), Some(&body))
    }

    /// Complete an email-OTP sign-in with the code from
    /// [`send_verification_otp`](Self::send_verification_otp). In app mode the
    /// returned session token is captured.
    pub fn sign_in_email_otp(&self, email: &str, otp: &str) -> Result<Value, BacklexError> {
        let body = json!({ "email": email, "otp": otp });
        let r = self.client.request("POST", &format!("{}/sign-in/email-otp", self.base()), Some(&body))?;
        Ok(self.capture(r))
    }

    /// Clear the session; in app mode also drops the captured token.
    /// Send a password-reset email. Pass `redirect_to: None` to omit.
    pub fn request_password_reset(&self, email: &str, redirect_to: Option<&str>) -> Result<Value, BacklexError> {
        let mut body = json!({ "email": email });
        if let Some(r) = redirect_to {
            body["redirectTo"] = json!(r);
        }
        self.client.request("POST", &format!("{}/request-password-reset", self.base()), Some(&body))
    }

    /// Complete a reset with the token from the email and a new password.
    pub fn reset_password(&self, new_password: &str, token: &str) -> Result<Value, BacklexError> {
        let body = json!({ "newPassword": new_password, "token": token });
        self.client.request("POST", &format!("{}/reset-password", self.base()), Some(&body))
    }

    /// Mint a fresh access JWT from the stored session token (app mode).
    pub fn refresh(&self) -> Result<Value, BacklexError> {
        let body = json!({ "refreshToken": self.client.token() });
        self.client.request("POST", &format!("{}/token/refresh", self.base()), Some(&body))
    }

    /// Change the signed-in user's password (requires the current password).
    pub fn change_password(&self, new_password: &str, current_password: &str, revoke_other_sessions: bool) -> Result<Value, BacklexError> {
        let body = json!({
            "newPassword": new_password,
            "currentPassword": current_password,
            "revokeOtherSessions": revoke_other_sessions,
        });
        self.client.request("POST", &format!("{}/change-password", self.base()), Some(&body))
    }

    /// Update the signed-in user's profile (e.g. name / image).
    pub fn update_user(&self, attributes: &Value) -> Result<Value, BacklexError> {
        self.client.request("POST", &format!("{}/update-user", self.base()), Some(attributes))
    }

    /// Send an email-verification link. Pass `callback_url: None` to omit.
    pub fn send_verification_email(&self, email: &str, callback_url: Option<&str>) -> Result<Value, BacklexError> {
        let mut body = json!({ "email": email });
        if let Some(c) = callback_url {
            body["callbackURL"] = json!(c);
        }
        self.client.request("POST", &format!("{}/send-verification-email", self.base()), Some(&body))
    }

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

    /// List the signed-in user's active sessions (one entry per device/login).
    pub fn list_sessions(&self) -> Result<Value, BacklexError> {
        self.client.request("GET", &format!("{}/list-sessions", self.base()), None)
    }

    /// Revoke one session by its `token` (from [`list_sessions`](Self::list_sessions)).
    pub fn revoke_session(&self, token: &str) -> Result<Value, BacklexError> {
        let body = json!({ "token": token });
        self.client.request("POST", &format!("{}/revoke-session", self.base()), Some(&body))
    }

    /// Revoke every session except the current one (sign out other devices).
    pub fn revoke_other_sessions(&self) -> Result<Value, BacklexError> {
        self.client.request("POST", &format!("{}/revoke-other-sessions", self.base()), None)
    }

    /// Revoke all sessions, including the current one.
    pub fn revoke_sessions(&self) -> Result<Value, BacklexError> {
        self.client.request("POST", &format!("{}/revoke-sessions", self.base()), None)
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
