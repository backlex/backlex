package com.backlex;

import java.util.ArrayList;
import java.util.Arrays;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;

/**
 * Static condition constructors — a Java port of the leaf/logical helpers in
 * query.ts. Compose them and pass to {@code QueryBuilder.where}. Everything
 * compiles to the canonical JSON {@link Condition} the REST API speaks.
 *
 * <pre>{@code
 * import static com.backlex.Filter.*;
 *
 * var rows = client.from("orders", Order.class).query()
 *     .where(and(
 *         eq("status", "active"),
 *         gte("total", 100),
 *         rel("customer", eq("tier", "gold")),            // -> "customer.tier"
 *         gte("placed_at", now(null, Map.of("months", 1)))))
 *     .select("id", "total", "customer.name")
 *     .orderBy("-placed_at", "id")
 *     .limit(50)
 *     .list();
 * }</pre>
 */
public final class Filter {

    private Filter() {
    }

    private static Condition leaf(String field, String op, Object value) {
        Map<String, Object> m = new LinkedHashMap<>();
        m.put(op, value);
        return new Condition(field, m);
    }

    public static Condition eq(String f, Object v) { return leaf(f, "_eq", v); }
    public static Condition neq(String f, Object v) { return leaf(f, "_neq", v); }
    public static Condition gt(String f, Object v) { return leaf(f, "_gt", v); }
    public static Condition gte(String f, Object v) { return leaf(f, "_gte", v); }
    public static Condition lt(String f, Object v) { return leaf(f, "_lt", v); }
    public static Condition lte(String f, Object v) { return leaf(f, "_lte", v); }
    public static Condition in(String f, List<?> vs) { return leaf(f, "_in", vs); }
    public static Condition nin(String f, List<?> vs) { return leaf(f, "_nin", vs); }
    public static Condition between(String f, Object lo, Object hi) { return leaf(f, "_between", Arrays.asList(lo, hi)); }
    public static Condition isNull(String f) { return leaf(f, "_null", true); }
    public static Condition isNull(String f, boolean v) { return leaf(f, "_null", v); }
    public static Condition empty(String f) { return leaf(f, "_empty", true); }
    public static Condition nempty(String f) { return leaf(f, "_nempty", true); }
    public static Condition contains(String f, String v) { return leaf(f, "_contains", v); }
    public static Condition icontains(String f, String v) { return leaf(f, "_icontains", v); }
    public static Condition startsWith(String f, String v) { return leaf(f, "_starts_with", v); }
    public static Condition endsWith(String f, String v) { return leaf(f, "_ends_with", v); }

    public static Condition and(Condition... conds) { return new Condition("$and", new ArrayList<Condition>(Arrays.asList(conds))); }
    public static Condition or(Condition... conds) { return new Condition("$or", new ArrayList<Condition>(Arrays.asList(conds))); }
    public static Condition not(Condition cond) { return new Condition("$not", cond); }

    /**
     * Traverse a relation one hop: every leaf key produced by {@code conds} is
     * prefixed with {@code head + "."}. Multiple conds are ANDed first.
     */
    public static Condition rel(String head, Condition... conds) {
        Condition inner = conds.length == 1 ? conds[0] : and(conds);
        return prefixKeys(inner, head);
    }

    /** Relative-date value, e.g. {@code now(null, Map.of("months", 1))}. */
    public static Map<String, Object> now(Map<String, Integer> add, Map<String, Integer> sub) {
        Map<String, Object> opts = new LinkedHashMap<>();
        if (add != null) opts.put("add", add);
        if (sub != null) opts.put("sub", sub);
        Map<String, Object> out = new LinkedHashMap<>();
        out.put("$now", opts);
        return out;
    }

    private static Condition prefixKeys(Condition cond, String head) {
        if (cond.get("$and") instanceof List<?> a) {
            return new Condition("$and", mapList(a, head));
        }
        if (cond.get("$or") instanceof List<?> o) {
            return new Condition("$or", mapList(o, head));
        }
        if (cond.get("$not") instanceof Condition nc) {
            return new Condition("$not", prefixKeys(nc, head));
        }
        Condition out = new Condition();
        for (Map.Entry<String, Object> e : cond.entrySet()) {
            out.put(head + "." + e.getKey(), e.getValue());
        }
        return out;
    }

    private static List<Object> mapList(List<?> a, String head) {
        List<Object> out = new ArrayList<>();
        for (Object x : a) {
            out.add(x instanceof Condition c ? prefixKeys(c, head) : x);
        }
        return out;
    }

    /**
     * Turn any accepted filter shape into the canonical Condition: handles
     * $and/$or/$not (and their _ aliases) and implicit equality
     * ({@code {"status":"active"}} -&gt; {@code {"status":{"_eq":"active"}}}). Idempotent.
     */
    public static Condition normalize(Object raw) {
        if (!(raw instanceof Map<?, ?> m)) {
            return new Condition();
        }

        Object and = first(m, "$and", "_and");
        if (and instanceof List<?> a) {
            return new Condition("$and", normalizeList(a));
        }
        Object or = first(m, "$or", "_or");
        if (or instanceof List<?> a) {
            return new Condition("$or", normalizeList(a));
        }
        if (hasKey(m, "$not", "_not")) {
            return new Condition("$not", normalize(first(m, "$not", "_not")));
        }

        Condition out = new Condition();
        for (Map.Entry<?, ?> e : m.entrySet()) {
            String k = String.valueOf(e.getKey());
            Object v = e.getValue();
            if (v instanceof Map<?, ?> mv && looksLikeComparison(mv)) {
                out.put(k, v);
            } else if (v instanceof Map<?, ?>) {
                out.put(k, v); // unknown object shape — pass through
            } else {
                Map<String, Object> leaf = new LinkedHashMap<>();
                leaf.put("_eq", v);
                out.put(k, leaf);
            }
        }
        return out;
    }

    private static List<Object> normalizeList(List<?> a) {
        List<Object> out = new ArrayList<>();
        for (Object x : a) {
            out.add(normalize(x));
        }
        return out;
    }

    private static Object first(Map<?, ?> m, String... keys) {
        for (String k : keys) {
            if (m.containsKey(k)) return m.get(k);
        }
        return null;
    }

    private static boolean hasKey(Map<?, ?> m, String... keys) {
        for (String k : keys) {
            if (m.containsKey(k)) return true;
        }
        return false;
    }

    private static boolean looksLikeComparison(Map<?, ?> o) {
        if (o.isEmpty()) return false;
        for (Object k : o.keySet()) {
            String s = String.valueOf(k);
            if (s.isEmpty() || s.charAt(0) != '_') return false;
        }
        return true;
    }
}
