package com.backlex

/**
 * Static condition constructors — a Kotlin port of the leaf/logical helpers in
 * query.ts. Compose them and pass to [QueryBuilder.where]. Everything compiles
 * to the canonical JSON [Condition] the REST API speaks.
 *
 * ```kotlin
 * val rows = client.from<Order>("orders").query()
 *     .where(Filter.and(
 *         Filter.eq("status", "active"),
 *         Filter.gte("total", 100),
 *         Filter.rel("customer", Filter.eq("tier", "gold")),   // -> "customer.tier"
 *         Filter.gte("placed_at", Filter.now(sub = mapOf("months" to 1))),
 *     ))
 *     .select("id", "total", "customer.name")
 *     .orderBy("-placed_at", "id")
 *     .limit(50)
 *     .list()
 * ```
 */
object Filter {

    private fun leaf(field: String, op: String, value: Any?): Condition =
        mapOf(field to mapOf(op to value))

    fun eq(f: String, v: Any?): Condition = leaf(f, "_eq", v)
    fun neq(f: String, v: Any?): Condition = leaf(f, "_neq", v)
    fun gt(f: String, v: Any?): Condition = leaf(f, "_gt", v)
    fun gte(f: String, v: Any?): Condition = leaf(f, "_gte", v)
    fun lt(f: String, v: Any?): Condition = leaf(f, "_lt", v)
    fun lte(f: String, v: Any?): Condition = leaf(f, "_lte", v)
    fun `in`(f: String, vs: List<Any?>): Condition = leaf(f, "_in", vs)
    fun nin(f: String, vs: List<Any?>): Condition = leaf(f, "_nin", vs)
    fun between(f: String, lo: Any?, hi: Any?): Condition = leaf(f, "_between", listOf(lo, hi))
    fun isNull(f: String, isNull: Boolean = true): Condition = leaf(f, "_null", isNull)
    fun empty(f: String): Condition = leaf(f, "_empty", true)
    fun nempty(f: String): Condition = leaf(f, "_nempty", true)
    fun contains(f: String, v: String): Condition = leaf(f, "_contains", v)
    fun icontains(f: String, v: String): Condition = leaf(f, "_icontains", v)
    fun startsWith(f: String, v: String): Condition = leaf(f, "_starts_with", v)
    fun endsWith(f: String, v: String): Condition = leaf(f, "_ends_with", v)

    fun and(vararg conds: Condition): Condition = mapOf("\$and" to conds.toList())
    fun or(vararg conds: Condition): Condition = mapOf("\$or" to conds.toList())
    fun not(cond: Condition): Condition = mapOf("\$not" to cond)

    /**
     * Traverse a relation one hop: every leaf key produced by [conds] is prefixed
     * with `head + "."`. Multiple conds are ANDed first.
     */
    fun rel(head: String, vararg conds: Condition): Condition {
        val inner = if (conds.size == 1) conds[0] else mapOf("\$and" to conds.toList())
        return prefixKeys(inner, head)
    }

    /** Relative-date value, e.g. `Filter.now(sub = mapOf("months" to 1))`. */
    fun now(add: Map<String, Int>? = null, sub: Map<String, Int>? = null): Map<String, Any?> {
        val opts = LinkedHashMap<String, Any?>()
        if (add != null) opts["add"] = add
        if (sub != null) opts["sub"] = sub
        return mapOf("\$now" to opts)
    }

    private fun prefixKeys(cond: Condition, head: String): Condition {
        (cond["\$and"] as? List<*>)?.let { return mapOf("\$and" to it.map { c -> prefixKeys(asCond(c), head) }) }
        (cond["\$or"] as? List<*>)?.let { return mapOf("\$or" to it.map { c -> prefixKeys(asCond(c), head) }) }
        (cond["\$not"] as? Map<*, *>)?.let { return mapOf("\$not" to prefixKeys(asCond(it), head)) }
        val out = LinkedHashMap<String, Any?>()
        for ((k, v) in cond) out["$head.$k"] = v
        return out
    }

    /**
     * Turn any accepted filter shape into the canonical Condition: handles
     * $and/$or/$not (and their `_` aliases) and implicit equality
     * (`{"status":"active"}` -> `{"status":{"_eq":"active"}}`). Idempotent.
     */
    fun normalize(raw: Any?): Condition {
        val m = raw as? Map<*, *> ?: return emptyMap()

        val and = m["\$and"] ?: m["_and"]
        if (and is List<*>) return mapOf("\$and" to and.map { normalize(it) })
        val or = m["\$or"] ?: m["_or"]
        if (or is List<*>) return mapOf("\$or" to or.map { normalize(it) })
        if (m.containsKey("\$not") || m.containsKey("_not")) {
            return mapOf("\$not" to normalize(m["\$not"] ?: m["_not"]))
        }

        val out = LinkedHashMap<String, Any?>()
        for ((k, v) in m) {
            val key = k.toString()
            out[key] = when {
                v is Map<*, *> && looksLikeComparison(v) -> v
                v is Map<*, *> -> v // unknown object shape — pass through
                else -> mapOf("_eq" to v)
            }
        }
        return out
    }

    @Suppress("UNCHECKED_CAST")
    private fun asCond(v: Any?): Condition = v as? Condition ?: (v as Map<String, Any?>)

    private fun looksLikeComparison(o: Map<*, *>): Boolean =
        o.isNotEmpty() && o.keys.all { it.toString().startsWith("_") }
}
