//! Official Rust client for the backlex API.
//!
//! ```ignore
//! use backlex::{filter as f, Client};
//! use serde_json::json;
//!
//! let client = Client::builder("https://api.example.com").api_key("pak_...").build();
//! let rows = client.from("posts").query()
//!     .filter(f::eq("published", json!(true)))
//!     .limit(10)
//!     .list()?;
//! ```

pub mod filter;

mod auth;
mod client;
mod collection;
mod error;
mod query;
mod realtime;
mod storage;

pub use auth::Auth;
pub use client::{Client, ClientBuilder, Transport};
pub use collection::Collection;
pub use error::BacklexError;
pub use query::{ListQuery, QueryBuilder};
pub use storage::Storage;
pub use realtime::Subscription;
