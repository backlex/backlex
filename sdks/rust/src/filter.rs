//! Static condition constructors — a Rust port of the leaf/logical helpers in
//! query.ts. Compose them and pass to [`crate::QueryBuilder::filter`]. Everything
//! compiles to the canonical JSON `Condition` (a [`serde_json::Value`] object) the
//! REST API speaks. This module is pure (no IO) and compiles to `wasm32`.
//!
//! ```ignore
//! use backlex::filter as f;
//! let cond = f::and(vec![
//!     f::eq("status", "active".into()),
//!     f::gte("total", 100.into()),
//!     f::rel("customer", vec![f::eq("tier", "gold".into())]), // -> "customer.tier"
//!     f::gte("placed_at", f::now(None, Some([("months".into(), 1.into())].into()))),
//! ]);
//! ```

use serde_json::{Map, Value};

fn obj(key: &str, value: Value) -> Value {
    let mut m = Map::new();
    m.insert(key.to_string(), value);
    Value::Object(m)
}

fn leaf(field: &str, op: &str, value: Value) -> Value {
    obj(field, obj(op, value))
}

pub fn eq(f: &str, v: Value) -> Value { leaf(f, "_eq", v) }
pub fn neq(f: &str, v: Value) -> Value { leaf(f, "_neq", v) }
pub fn gt(f: &str, v: Value) -> Value { leaf(f, "_gt", v) }
pub fn gte(f: &str, v: Value) -> Value { leaf(f, "_gte", v) }
pub fn lt(f: &str, v: Value) -> Value { leaf(f, "_lt", v) }
pub fn lte(f: &str, v: Value) -> Value { leaf(f, "_lte", v) }
pub fn in_(f: &str, vs: Vec<Value>) -> Value { leaf(f, "_in", Value::Array(vs)) }
pub fn nin(f: &str, vs: Vec<Value>) -> Value { leaf(f, "_nin", Value::Array(vs)) }
pub fn between(f: &str, lo: Value, hi: Value) -> Value { leaf(f, "_between", Value::Array(vec![lo, hi])) }
pub fn is_null(f: &str, is_null: bool) -> Value { leaf(f, "_null", Value::Bool(is_null)) }
pub fn empty(f: &str) -> Value { leaf(f, "_empty", Value::Bool(true)) }
pub fn nempty(f: &str) -> Value { leaf(f, "_nempty", Value::Bool(true)) }
pub fn contains(f: &str, v: &str) -> Value { leaf(f, "_contains", Value::String(v.into())) }
pub fn icontains(f: &str, v: &str) -> Value { leaf(f, "_icontains", Value::String(v.into())) }
pub fn starts_with(f: &str, v: &str) -> Value { leaf(f, "_starts_with", Value::String(v.into())) }
pub fn ends_with(f: &str, v: &str) -> Value { leaf(f, "_ends_with", Value::String(v.into())) }

pub fn and(conds: Vec<Value>) -> Value { obj("$and", Value::Array(conds)) }
pub fn or(conds: Vec<Value>) -> Value { obj("$or", Value::Array(conds)) }
pub fn not(cond: Value) -> Value { obj("$not", cond) }

/// Traverse a relation one hop: every leaf key produced by `conds` is prefixed
/// with `head.`. Multiple conds are ANDed first.
pub fn rel(head: &str, conds: Vec<Value>) -> Value {
    let inner = if conds.len() == 1 {
        conds.into_iter().next().unwrap()
    } else {
        obj("$and", Value::Array(conds))
    };
    prefix_keys(&inner, head)
}

/// Relative-date value, e.g. `now(None, Some(map))`.
pub fn now(add: Option<Map<String, Value>>, sub: Option<Map<String, Value>>) -> Value {
    let mut opts = Map::new();
    if let Some(a) = add {
        opts.insert("add".into(), Value::Object(a));
    }
    if let Some(s) = sub {
        opts.insert("sub".into(), Value::Object(s));
    }
    obj("$now", Value::Object(opts))
}

fn prefix_keys(cond: &Value, head: &str) -> Value {
    let o = match cond.as_object() {
        Some(o) => o,
        None => return cond.clone(),
    };
    if let Some(arr) = o.get("$and").and_then(|v| v.as_array()) {
        return obj("$and", Value::Array(arr.iter().map(|c| prefix_keys(c, head)).collect()));
    }
    if let Some(arr) = o.get("$or").and_then(|v| v.as_array()) {
        return obj("$or", Value::Array(arr.iter().map(|c| prefix_keys(c, head)).collect()));
    }
    if let Some(n) = o.get("$not") {
        if n.is_object() {
            return obj("$not", prefix_keys(n, head));
        }
    }
    let mut out = Map::new();
    for (k, v) in o {
        out.insert(format!("{}.{}", head, k), v.clone());
    }
    Value::Object(out)
}

/// Turn any accepted filter shape into the canonical Condition: handles
/// $and/$or/$not (and their `_` aliases) and implicit equality
/// (`{"status":"active"}` -> `{"status":{"_eq":"active"}}`). Idempotent.
pub fn normalize(raw: &Value) -> Value {
    let o = match raw.as_object() {
        Some(o) => o,
        None => return Value::Object(Map::new()),
    };

    if let Some(arr) = o.get("$and").or_else(|| o.get("_and")).and_then(|v| v.as_array()) {
        return obj("$and", Value::Array(arr.iter().map(normalize).collect()));
    }
    if let Some(arr) = o.get("$or").or_else(|| o.get("_or")).and_then(|v| v.as_array()) {
        return obj("$or", Value::Array(arr.iter().map(normalize).collect()));
    }
    if o.contains_key("$not") || o.contains_key("_not") {
        let inner = o.get("$not").or_else(|| o.get("_not")).unwrap();
        return obj("$not", normalize(inner));
    }

    let mut out = Map::new();
    for (k, v) in o {
        // Any object (a comparison map or nested shape) passes through unchanged;
        // a scalar or array value gets implicit equality.
        let val = if v.is_object() {
            v.clone()
        } else {
            obj("_eq", v.clone())
        };
        out.insert(k.clone(), val);
    }
    Value::Object(out)
}
