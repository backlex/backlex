use crate::client::{self, Client};
use crate::error::BacklexError;
use serde_json::Value;

/// File operations against `/api/storage`.
pub struct Storage {
    client: Client,
}

impl Storage {
    pub(crate) fn new(client: Client) -> Self {
        Storage { client }
    }

    /// List stored objects, optionally filtered by key prefix.
    pub fn list(&self, prefix: Option<&str>) -> Result<Value, BacklexError> {
        let mut path = "/api/storage".to_string();
        if let Some(p) = prefix {
            if !p.is_empty() {
                path.push_str(&format!("?prefix={}", client::enc(p)));
            }
        }
        let r = self.client.request("GET", &path, None)?;
        Ok(r.get("data").cloned().unwrap_or(Value::Null))
    }

    /// Upload bytes under `key`. Pass `content_type`/`folder_id` None to omit them.
    pub fn put(
        &self,
        key: &str,
        body: &[u8],
        content_type: Option<&str>,
        folder_id: Option<&str>,
    ) -> Result<Value, BacklexError> {
        let mut path = format!("/api/storage/{}", client::enc(key));
        if let Some(fid) = folder_id {
            path.push_str(&format!("?folderId={}", client::enc(fid)));
        }
        let (_, bytes) = self.client.send_raw("PUT", &path, Some(body), content_type)?;
        Ok(serde_json::from_slice(&bytes).unwrap_or(Value::Null))
    }

    /// Fetch the raw bytes for `key`.
    pub fn download(&self, key: &str) -> Result<Vec<u8>, BacklexError> {
        let (_, bytes) = self.client.send_raw("GET", &format!("/api/storage/{}", client::enc(key)), None, None)?;
        Ok(bytes)
    }

    /// Remove the object at `key`.
    pub fn delete(&self, key: &str) -> Result<Value, BacklexError> {
        self.client.request("DELETE", &format!("/api/storage/{}", client::enc(key)), None)
    }
}
