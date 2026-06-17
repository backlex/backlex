//! Quickstart tour of the Rust SDK.
//!   BACKLEX_URL=http://localhost:5173 BACKLEX_KEY=pak_... cargo run --example quickstart

use backlex::{filter as f, BacklexError, Client};
use serde_json::json;

fn main() {
    let url = std::env::var("BACKLEX_URL").unwrap_or_else(|_| "http://localhost:5173".into());
    let mut builder = Client::builder(url);
    if let Ok(key) = std::env::var("BACKLEX_KEY") {
        builder = builder.api_key(key);
    }
    let client = builder.build();

    // Fluent query builder → compiles to canonical JSON (same wire format as every other SDK).
    let mut sub = serde_json::Map::new();
    sub.insert("days".into(), json!(7));
    let query = client
        .from("posts")
        .query()
        .filter(f::and(vec![
            f::eq("published", json!(true)),
            f::gte("views", json!(100)),
            f::rel("author", vec![f::eq("tier", json!("gold"))]),
            f::gte("created_at", f::now(None, Some(sub))),
        ]))
        .select(&["id", "title", "author.name"])
        .order_by(&["-created_at"])
        .limit(10)
        .with_meta("filter_count");

    match query.list() {
        Ok(res) => {
            let n = res.get("data").and_then(|d| d.as_array()).map(|a| a.len()).unwrap_or(0);
            println!("got {} posts (meta={:?})", n, res.get("meta"));
        }
        Err(BacklexError { status, code, message, .. }) => {
            println!("list failed: {} {} — {}", status, code, message);
        }
    }

    // CRUD
    // let created = client.from("posts").create(&json!({ "title": "Hello" }))?;

    // Realtime (SSE on a thread)
    // let sub = client.subscribe("items:posts", |ev| println!("event: {}", ev["event"]));
    // std::thread::sleep(std::time::Duration::from_secs(5));
    // sub.cancel();
}
