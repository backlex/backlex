use backlex::filter as f;
use serde_json::json;

// serde_json::Value compares objects by content (key order independent), so these
// assert the Rust builder emits byte-identical canonical JSON to the other SDKs.

#[test]
fn leaf_and_logical() {
    let c = f::normalize(&f::and(vec![f::eq("status", json!("active")), f::gte("total", json!(100))]));
    assert_eq!(c, json!({"$and": [{"status": {"_eq": "active"}}, {"total": {"_gte": 100}}]}));
}

#[test]
fn relation_hop_prefixes_keys() {
    let c = f::rel("customer", vec![f::eq("tier", json!("gold"))]);
    assert_eq!(c, json!({"customer.tier": {"_eq": "gold"}}));
}

#[test]
fn relation_hop_multiple_conds() {
    let c = f::rel("customer", vec![f::eq("tier", json!("gold")), f::gte("age", json!(18))]);
    assert_eq!(c, json!({"$and": [{"customer.tier": {"_eq": "gold"}}, {"customer.age": {"_gte": 18}}]}));
}

#[test]
fn now_relative_date() {
    let mut sub = serde_json::Map::new();
    sub.insert("months".into(), json!(1));
    let c = f::gte("placed_at", f::now(None, Some(sub)));
    assert_eq!(c, json!({"placed_at": {"_gte": {"$now": {"sub": {"months": 1}}}}}));
}

#[test]
fn normalize_implicit_equality_and_aliases() {
    assert_eq!(f::normalize(&json!({"status": "active"})), json!({"status": {"_eq": "active"}}));
    assert_eq!(f::normalize(&json!({"_and": [{"a": 1}]})), json!({"$and": [{"a": {"_eq": 1}}]}));
    assert_eq!(f::normalize(&json!({"_not": {"a": 1}})), json!({"$not": {"a": {"_eq": 1}}}));

    let once = f::normalize(&json!({"status": "active"}));
    assert_eq!(f::normalize(&once), once);
}
