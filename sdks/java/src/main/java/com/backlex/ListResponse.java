package com.backlex;

import java.util.ArrayList;
import java.util.List;
import java.util.Map;

/** Result of a collection list/query call. */
public class ListResponse<T> {
    public List<T> data = new ArrayList<>();
    public int limit;
    public int offset;
    public Map<String, Integer> meta;
}
