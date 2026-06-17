package com.backlex

/** Chainable builder that compiles to a [ListQuery] and runs it. */
class QueryBuilder<T>(private val listFn: (ListQuery) -> ListResponse<T>) {
    private val q = ListQuery()

    fun where(cond: Condition) = apply { q.filter = Filter.normalize(cond) }

    /** Replace the filter with a raw canonical condition (escape hatch). */
    fun filter(cond: Condition) = apply { q.filter = Filter.normalize(cond) }

    fun select(vararg fields: String) = apply { q.fields.addAll(fields) }

    fun orderBy(vararg sorts: String) = apply { q.sort.addAll(sorts) }

    /** Inline single-hop relations (replaces each FK with the related object). */
    fun expand(vararg rels: String) = apply { q.expand.addAll(rels) }

    /** Project i18n_text fields to one locale, or "*" for the full map. */
    fun locale(loc: String) = apply { q.locale = loc }

    /** Free-text search across readable text fields. */
    fun search(text: String) = apply { q.q = text }

    fun limit(n: Int) = apply { q.limit = n }

    fun offset(n: Int) = apply { q.offset = n }

    /** Request an extra COUNT: "filter_count", "total_count", or "*". */
    fun withMeta(m: String) = apply { q.meta = m }

    /** The assembled [ListQuery] — the canonical input the API takes. */
    fun toQuery(): ListQuery = q

    fun list(): ListResponse<T> = listFn(q)
}
