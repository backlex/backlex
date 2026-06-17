import Foundation

/// Chainable builder that compiles to a ``ListQuery`` and runs it.
public final class QueryBuilder<T: Decodable> {
    private let listFn: (ListQuery) async throws -> ListResponse<T>
    private var q = ListQuery()

    init(_ listFn: @escaping (ListQuery) async throws -> ListResponse<T>) {
        self.listFn = listFn
    }

    @discardableResult
    public func `where`(_ cond: Condition) -> Self {
        q.filter = Filter.normalize(cond)
        return self
    }

    /// Replace the filter with a raw canonical condition (escape hatch).
    @discardableResult
    public func filter(_ cond: Condition) -> Self {
        q.filter = Filter.normalize(cond)
        return self
    }

    @discardableResult
    public func select(_ fields: String...) -> Self {
        q.fields.append(contentsOf: fields)
        return self
    }

    @discardableResult
    public func orderBy(_ sorts: String...) -> Self {
        q.sort.append(contentsOf: sorts)
        return self
    }

    /// Inline single-hop relations (replaces each FK with the related object).
    @discardableResult
    public func expand(_ rels: String...) -> Self {
        q.expand.append(contentsOf: rels)
        return self
    }

    /// Project `i18n_text` fields to one locale, or `"*"` for the full map.
    @discardableResult
    public func locale(_ loc: String) -> Self {
        q.locale = loc
        return self
    }

    /// Free-text search across readable text fields.
    @discardableResult
    public func search(_ text: String) -> Self {
        q.q = text
        return self
    }

    @discardableResult
    public func limit(_ n: Int) -> Self {
        q.limit = n
        return self
    }

    @discardableResult
    public func offset(_ n: Int) -> Self {
        q.offset = n
        return self
    }

    /// Request an extra COUNT: "filter_count", "total_count", or "*".
    @discardableResult
    public func withMeta(_ m: String) -> Self {
        q.meta = m
        return self
    }

    /// The assembled ``ListQuery`` — the canonical input the API takes.
    public func toQuery() -> ListQuery { q }

    public func list() async throws -> ListResponse<T> {
        try await listFn(q)
    }
}
