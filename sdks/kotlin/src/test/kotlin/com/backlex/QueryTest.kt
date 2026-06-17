package com.backlex

import com.fasterxml.jackson.databind.ObjectMapper
import org.junit.jupiter.api.Assertions.assertEquals
import org.junit.jupiter.api.Test

class QueryTest {
    private val mapper = ObjectMapper()

    /** Compare two values by their canonical JSON tree (key order independent). */
    private fun jsonEq(got: Any?, want: Any?) {
        assertEquals(mapper.readTree(mapper.writeValueAsString(want)), mapper.readTree(mapper.writeValueAsString(got)))
    }

    @Test
    fun leafAndLogical() {
        val c = Filter.normalize(Filter.and(Filter.eq("status", "active"), Filter.gte("total", 100)))
        jsonEq(c, mapOf("\$and" to listOf(
            mapOf("status" to mapOf("_eq" to "active")),
            mapOf("total" to mapOf("_gte" to 100)),
        )))
    }

    @Test
    fun relationHopPrefixesKeys() {
        jsonEq(Filter.rel("customer", Filter.eq("tier", "gold")),
            mapOf("customer.tier" to mapOf("_eq" to "gold")))
    }

    @Test
    fun relationHopMultipleConds() {
        jsonEq(Filter.rel("customer", Filter.eq("tier", "gold"), Filter.gte("age", 18)),
            mapOf("\$and" to listOf(
                mapOf("customer.tier" to mapOf("_eq" to "gold")),
                mapOf("customer.age" to mapOf("_gte" to 18)),
            )))
    }

    @Test
    fun nowRelativeDate() {
        jsonEq(Filter.gte("placed_at", Filter.now(sub = mapOf("months" to 1))),
            mapOf("placed_at" to mapOf("_gte" to mapOf("\$now" to mapOf("sub" to mapOf("months" to 1))))))
    }

    @Test
    fun normalizeImplicitEqualityAndAliases() {
        jsonEq(Filter.normalize(mapOf("status" to "active")), mapOf("status" to mapOf("_eq" to "active")))
        jsonEq(Filter.normalize(mapOf("_and" to listOf(mapOf("a" to 1)))),
            mapOf("\$and" to listOf(mapOf("a" to mapOf("_eq" to 1)))))

        val once = Filter.normalize(mapOf("status" to "active"))
        jsonEq(Filter.normalize(once), once)
    }

    @Test
    fun toQueryAssembly() {
        val q = BacklexClient.builder("http://x").build().from<Any>("posts").query()
            .where(Filter.eq("published", true))
            .select("id", "title")
            .orderBy("-created_at", "id")
            .limit(50)
            .offset(10)
            .withMeta("filter_count")
            .toQuery()

        jsonEq(q.filter, mapOf("published" to mapOf("_eq" to true)))
        assertEquals(listOf("-created_at", "id"), q.sort)
        assertEquals(50, q.limit)
        assertEquals(10, q.offset)
        assertEquals("filter_count", q.meta)
    }
}
