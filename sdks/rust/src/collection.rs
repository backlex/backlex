use crate::client::Client;
use crate::error::BacklexError;
use crate::query::QueryBuilder;
use serde_json::Value;

/// A CRUD handle for one collection. Obtain via `client.from("slug")`.
pub struct Collection {
    client: Client,
    slug: String,
}

impl Collection {
    pub(crate) fn new(client: Client, slug: String) -> Self {
        Collection { client, slug }
    }

    pub fn list(&self) -> Result<Value, BacklexError> {
        self.client.request("GET", &format!("/api/items/{}", self.slug), None)
    }

    /// Fluent builder that compiles to a ListQuery.
    pub fn query(&self) -> QueryBuilder {
        QueryBuilder::new(self.client.clone(), self.slug.clone())
    }

    pub fn one(&self, id: &str) -> Result<Value, BacklexError> {
        self.client.request("GET", &format!("/api/items/{}/{}", self.slug, id), None)
    }

    pub fn create(&self, data: &Value) -> Result<Value, BacklexError> {
        self.client.request("POST", &format!("/api/items/{}", self.slug), Some(data))
    }

    pub fn update(&self, id: &str, patch: &Value) -> Result<Value, BacklexError> {
        self.client.request("PATCH", &format!("/api/items/{}/{}", self.slug, id), Some(patch))
    }

    pub fn delete(&self, id: &str) -> Result<Value, BacklexError> {
        self.client.request("DELETE", &format!("/api/items/{}/{}", self.slug, id), None)
    }
}
