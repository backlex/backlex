package com.backlex;

import java.util.ArrayList;
import java.util.List;

/** Query parameters a list/query call serializes into the URL. */
public class ListQuery {
    public Condition filter;
    public List<String> sort = new ArrayList<>();
    public List<String> fields = new ArrayList<>();
    public List<String> expand = new ArrayList<>(); // inline single-hop relations
    public Integer limit;
    public Integer offset;
    public String meta; // "filter_count" | "total_count" | "*"
    public String locale; // one locale, or "*" for the full i18n map
    public String q; // free-text search across readable text fields
}
