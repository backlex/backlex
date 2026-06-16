package com.backlex;

import static com.backlex.Filter.*;
import static org.junit.jupiter.api.Assertions.assertEquals;

import com.fasterxml.jackson.databind.ObjectMapper;
import java.util.List;
import java.util.Map;
import org.junit.jupiter.api.Test;

class QueryTest {

    private static final ObjectMapper M = new ObjectMapper();

    /** Compare two values by their canonical JSON tree (key order independent). */
    private static void jsonEq(Object got, Object want) {
        try {
            assertEquals(M.readTree(M.writeValueAsString(want)), M.readTree(M.writeValueAsString(got)));
        } catch (Exception e) {
            throw new RuntimeException(e);
        }
    }

    @Test
    void leafAndLogical() {
        Object c = normalize(and(eq("status", "active"), gte("total", 100)));
        jsonEq(c, Map.of("$and", List.of(
                Map.of("status", Map.of("_eq", "active")),
                Map.of("total", Map.of("_gte", 100)))));
    }

    @Test
    void relationHopPrefixesKeys() {
        jsonEq(rel("customer", eq("tier", "gold")),
                Map.of("customer.tier", Map.of("_eq", "gold")));
    }

    @Test
    void relationHopMultipleConds() {
        jsonEq(rel("customer", eq("tier", "gold"), gte("age", 18)),
                Map.of("$and", List.of(
                        Map.of("customer.tier", Map.of("_eq", "gold")),
                        Map.of("customer.age", Map.of("_gte", 18)))));
    }

    @Test
    void nowRelativeDate() {
        jsonEq(gte("placed_at", now(null, Map.of("months", 1))),
                Map.of("placed_at", Map.of("_gte", Map.of("$now", Map.of("sub", Map.of("months", 1))))));
    }

    @Test
    void normalizeImplicitEqualityAndAliases() {
        jsonEq(normalize(Map.of("status", "active")), Map.of("status", Map.of("_eq", "active")));
        jsonEq(normalize(Map.of("_and", List.of(Map.of("a", 1)))),
                Map.of("$and", List.of(Map.of("a", Map.of("_eq", 1)))));

        Object once = normalize(Map.of("status", "active"));
        jsonEq(normalize(once), once);
    }

    @Test
    void toQueryAssembly() {
        BacklexClient client = BacklexClient.builder("http://x").build();
        ListQuery q = client.from("posts", Object.class).query()
                .where(eq("published", true))
                .select("id", "title")
                .orderBy("-created_at", "id")
                .limit(50)
                .offset(10)
                .withMeta("filter_count")
                .toQuery();

        jsonEq(q.filter, Map.of("published", Map.of("_eq", true)));
        assertEquals(List.of("-created_at", "id"), q.sort);
        assertEquals(50, q.limit);
        assertEquals(10, q.offset);
        assertEquals("filter_count", q.meta);
    }
}
