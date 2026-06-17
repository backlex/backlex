use crate::client::{self, Client};
use crate::error::BacklexError;
use crate::filter;
use serde_json::Value;

/// Query parameters a list/query call serializes into the URL.
#[derive(Default, Clone)]
pub struct ListQuery {
    pub filter: Option<Value>,
    pub sort: Vec<String>,
    pub fields: Vec<String>,
    pub expand: Vec<String>,
    pub limit: Option<i64>,
    pub offset: Option<i64>,
    pub meta: Option<String>,
    pub locale: Option<String>,
    pub q: Option<String>,
}

/// Per-call options for [`Collection::one`](crate::Collection::one). The single-item
/// read endpoint accepts the same expand/locale params as the list endpoint.
#[derive(Default, Clone)]
pub struct ItemQuery {
    pub expand: Vec<String>,
    pub locale: Option<String>,
}

/// Chainable builder that compiles to a [`ListQuery`] and runs it. Builder methods
/// consume `self` and return it, so calls chain.
pub struct QueryBuilder {
    client: Client,
    slug: String,
    q: ListQuery,
}

impl QueryBuilder {
    pub(crate) fn new(client: Client, slug: String) -> Self {
        QueryBuilder {
            client,
            slug,
            q: ListQuery::default(),
        }
    }

    /// Set the filter (normalized to canonical form). Named `filter` because
    /// `where` is a Rust keyword.
    pub fn filter(mut self, cond: Value) -> Self {
        self.q.filter = Some(filter::normalize(&cond));
        self
    }

    pub fn select(mut self, fields: &[&str]) -> Self {
        self.q.fields.extend(fields.iter().map(|s| s.to_string()));
        self
    }

    pub fn order_by(mut self, sorts: &[&str]) -> Self {
        self.q.sort.extend(sorts.iter().map(|s| s.to_string()));
        self
    }

    /// Inline single-hop relations (replaces each FK with the related object).
    pub fn expand(mut self, rels: &[&str]) -> Self {
        self.q.expand.extend(rels.iter().map(|s| s.to_string()));
        self
    }

    /// Project i18n_text fields to one locale, or "*" for the full map.
    pub fn locale(mut self, loc: &str) -> Self {
        self.q.locale = Some(loc.to_string());
        self
    }

    /// Free-text search across readable text fields.
    pub fn search(mut self, text: &str) -> Self {
        self.q.q = Some(text.to_string());
        self
    }

    pub fn limit(mut self, n: i64) -> Self {
        self.q.limit = Some(n);
        self
    }

    pub fn offset(mut self, n: i64) -> Self {
        self.q.offset = Some(n);
        self
    }

    /// Request an extra COUNT: "filter_count", "total_count", or "*".
    pub fn with_meta(mut self, m: &str) -> Self {
        self.q.meta = Some(m.to_string());
        self
    }

    /// The assembled [`ListQuery`] — the canonical input the API takes.
    pub fn to_query(&self) -> &ListQuery {
        &self.q
    }

    pub fn list(&self) -> Result<Value, BacklexError> {
        let path = format!("/api/items/{}{}", self.slug, client::build_search(&self.q));
        self.client.request("GET", &path, None)
    }
}
