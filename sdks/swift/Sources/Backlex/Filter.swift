import Foundation

/// A canonical condition is just a `JSONValue` (an `$and`/`$or`/`$not` map or a
/// leaf field map). Shared byte-for-byte with the other SDKs.
public typealias Condition = JSONValue

/// Static condition constructors — a Swift port of the leaf/logical helpers in
/// query.ts. Compose them and pass to `QueryBuilder.where`. Everything compiles
/// to the canonical JSON `Condition` the REST API speaks.
///
///     let rows = try await client.from("orders", as: Order.self).query()
///         .where(Filter.and(
///             Filter.eq("status", "active"),
///             Filter.gte("total", 100),
///             Filter.rel("customer", Filter.eq("tier", "gold")),   // -> "customer.tier"
///             Filter.gte("placed_at", Filter.now(sub: ["months": 1]))
///         ))
///         .select("id", "total", "customer.name")
///         .orderBy("-placed_at", "id")
///         .limit(50)
///         .list()
public enum Filter {
    private static func leaf(_ field: String, _ op: String, _ value: JSONValue) -> Condition {
        .object([field: .object([op: value])])
    }

    public static func eq(_ f: String, _ v: JSONValue) -> Condition { leaf(f, "_eq", v) }
    public static func neq(_ f: String, _ v: JSONValue) -> Condition { leaf(f, "_neq", v) }
    public static func gt(_ f: String, _ v: JSONValue) -> Condition { leaf(f, "_gt", v) }
    public static func gte(_ f: String, _ v: JSONValue) -> Condition { leaf(f, "_gte", v) }
    public static func lt(_ f: String, _ v: JSONValue) -> Condition { leaf(f, "_lt", v) }
    public static func lte(_ f: String, _ v: JSONValue) -> Condition { leaf(f, "_lte", v) }
    public static func `in`(_ f: String, _ v: [JSONValue]) -> Condition { leaf(f, "_in", .array(v)) }
    public static func nin(_ f: String, _ v: [JSONValue]) -> Condition { leaf(f, "_nin", .array(v)) }
    public static func between(_ f: String, _ lo: JSONValue, _ hi: JSONValue) -> Condition { leaf(f, "_between", .array([lo, hi])) }
    public static func isNull(_ f: String, _ isNull: Bool = true) -> Condition { leaf(f, "_null", .bool(isNull)) }
    public static func empty(_ f: String) -> Condition { leaf(f, "_empty", .bool(true)) }
    public static func nempty(_ f: String) -> Condition { leaf(f, "_nempty", .bool(true)) }
    public static func contains(_ f: String, _ v: String) -> Condition { leaf(f, "_contains", .string(v)) }
    public static func icontains(_ f: String, _ v: String) -> Condition { leaf(f, "_icontains", .string(v)) }
    public static func startsWith(_ f: String, _ v: String) -> Condition { leaf(f, "_starts_with", .string(v)) }
    public static func endsWith(_ f: String, _ v: String) -> Condition { leaf(f, "_ends_with", .string(v)) }

    public static func and(_ conds: Condition...) -> Condition { .object(["$and": .array(conds)]) }
    public static func or(_ conds: Condition...) -> Condition { .object(["$or": .array(conds)]) }
    public static func not(_ cond: Condition) -> Condition { .object(["$not": cond]) }

    /// Traverse a relation one hop: every leaf key produced by `conds` is prefixed
    /// with `head + "."`. Multiple conds are ANDed first.
    public static func rel(_ head: String, _ conds: Condition...) -> Condition {
        let inner = conds.count == 1 ? conds[0] : .object(["$and": .array(conds)])
        return prefixKeys(inner, head)
    }

    /// Relative-date value, e.g. `Filter.now(sub: ["months": 1])`.
    public static func now(add: [String: Int]? = nil, sub: [String: Int]? = nil) -> JSONValue {
        var opts = [String: JSONValue]()
        if let add { opts["add"] = .object(add.mapValues { .int($0) }) }
        if let sub { opts["sub"] = .object(sub.mapValues { .int($0) }) }
        return .object(["$now": .object(opts)])
    }

    static func prefixKeys(_ cond: Condition, _ head: String) -> Condition {
        guard case .object(let m) = cond else { return cond }
        if case .array(let a)? = m["$and"] {
            return .object(["$and": .array(a.map { prefixKeys($0, head) })])
        }
        if case .array(let o)? = m["$or"] {
            return .object(["$or": .array(o.map { prefixKeys($0, head) })])
        }
        if let n = m["$not"], case .object = n {
            return .object(["$not": prefixKeys(n, head)])
        }
        var out = [String: JSONValue]()
        for (k, v) in m { out["\(head).\(k)"] = v }
        return .object(out)
    }

    /// Turn any accepted filter shape into the canonical Condition: handles
    /// $and/$or/$not (and their `_` aliases) and implicit equality
    /// (`["status": "active"]` -> `["status": ["_eq": "active"]]`). Idempotent.
    public static func normalize(_ raw: JSONValue) -> Condition {
        guard case .object(let m) = raw else { return raw }

        if case .array(let a)? = (m["$and"] ?? m["_and"]) {
            return .object(["$and": .array(a.map(normalize))])
        }
        if case .array(let a)? = (m["$or"] ?? m["_or"]) {
            return .object(["$or": .array(a.map(normalize))])
        }
        if let not = (m["$not"] ?? m["_not"]) {
            return .object(["$not": normalize(not)])
        }

        var out = [String: JSONValue]()
        for (k, v) in m {
            if case .object(let mv) = v, looksLikeComparison(mv) {
                out[k] = v
            } else if case .object = v {
                out[k] = v  // unknown object shape — pass through
            } else {
                out[k] = .object(["_eq": v])
            }
        }
        return .object(out)
    }

    private static func looksLikeComparison(_ o: [String: JSONValue]) -> Bool {
        !o.isEmpty && o.keys.allSatisfy { $0.first == "_" }
    }
}
