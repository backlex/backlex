use serde_json::Value;
use std::fmt;

/// A non-2xx response from the backlex API (or a transport failure), mirroring the
/// TS SDK's BacklexError. The API returns errors as
/// `{ "error": { "code", "message", "details"? } }`; callers branch on `status` /
/// `code` rather than parsing strings.
#[derive(Debug, Clone)]
pub struct BacklexError {
    /// HTTP status code (0 for transport/decoding failures).
    pub status: u16,
    /// Machine-readable code ("VALIDATION", "UNAUTHORIZED", ...); "UNKNOWN" if absent.
    pub code: String,
    pub message: String,
    /// Optional structured details from the error envelope.
    pub details: Option<Value>,
}

impl BacklexError {
    pub fn new(status: u16, code: impl Into<String>, message: impl Into<String>) -> Self {
        BacklexError {
            status,
            code: code.into(),
            message: message.into(),
            details: None,
        }
    }

    /// Parse the `{ "error": {...} }` envelope from a response body.
    pub fn from_body(status: u16, body: &str) -> Self {
        let mut code = "UNKNOWN".to_string();
        let mut message = format!("HTTP {}", status);
        let mut details = None;
        if !body.is_empty() {
            if let Ok(env) = serde_json::from_str::<Value>(body) {
                if let Some(err) = env.get("error").and_then(|e| e.as_object()) {
                    if let Some(c) = err.get("code").and_then(|v| v.as_str()) {
                        code = c.to_string();
                    }
                    if let Some(m) = err.get("message").and_then(|v| v.as_str()) {
                        message = m.to_string();
                    }
                    details = err.get("details").cloned();
                }
            }
        }
        BacklexError {
            status,
            code,
            message,
            details,
        }
    }
}

impl fmt::Display for BacklexError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "backlex: {} {}: {}", self.status, self.code, self.message)
    }
}

impl std::error::Error for BacklexError {}
