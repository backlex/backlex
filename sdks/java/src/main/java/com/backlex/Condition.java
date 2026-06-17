package com.backlex;

import java.util.LinkedHashMap;

/**
 * The canonical JSON filter grammar ($and / $or / $not / leaf maps). A plain
 * insertion-ordered string-keyed map; values may be nested {@link Condition}s,
 * lists, or scalars. Shared byte-for-byte with the TS / Python / Go / .NET SDKs.
 */
public class Condition extends LinkedHashMap<String, Object> {

    public Condition() {
    }

    public Condition(String key, Object value) {
        put(key, value);
    }
}
