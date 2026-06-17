package com.backlex;

import java.util.ArrayList;
import java.util.List;

/**
 * Per-call options for {@code one(id, ...)}. The single-item read endpoint
 * accepts the same expand/locale params as the list endpoint.
 */
public class ItemQuery {
    public List<String> expand = new ArrayList<>(); // inline single-hop relations
    public String locale; // one locale, or "*" for the full i18n map
}
