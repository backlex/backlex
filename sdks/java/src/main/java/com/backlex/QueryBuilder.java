package com.backlex;

import java.util.Arrays;
import java.util.function.Function;

/** Chainable builder that compiles to a {@link ListQuery} and runs it. */
public final class QueryBuilder<T> {

    private final Function<ListQuery, ListResponse<T>> listFn;
    private final ListQuery q = new ListQuery();

    QueryBuilder(Function<ListQuery, ListResponse<T>> listFn) {
        this.listFn = listFn;
    }

    public QueryBuilder<T> where(Condition cond) {
        q.filter = Filter.normalize(cond);
        return this;
    }

    /** Replace the filter with a raw canonical condition (escape hatch). */
    public QueryBuilder<T> rawFilter(Condition cond) {
        q.filter = Filter.normalize(cond);
        return this;
    }

    public QueryBuilder<T> select(String... fields) {
        q.fields.addAll(Arrays.asList(fields));
        return this;
    }

    public QueryBuilder<T> orderBy(String... sorts) {
        q.sort.addAll(Arrays.asList(sorts));
        return this;
    }

    public QueryBuilder<T> limit(int n) {
        q.limit = n;
        return this;
    }

    public QueryBuilder<T> offset(int n) {
        q.offset = n;
        return this;
    }

    /** Request an extra COUNT: "filter_count", "total_count", or "*". */
    public QueryBuilder<T> withMeta(String m) {
        q.meta = m;
        return this;
    }

    /** The assembled {@link ListQuery} — the canonical input the API takes. */
    public ListQuery toQuery() {
        return q;
    }

    public ListResponse<T> list() {
        return listFn.apply(q);
    }
}
