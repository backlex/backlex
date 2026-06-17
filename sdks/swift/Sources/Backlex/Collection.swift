import Foundation

/// A typed CRUD handle for one collection. Obtain via `client.from(slug, as:)`.
public struct Collection<T: Decodable> {
    let client: BacklexClient
    let slug: String

    public func list(_ query: ListQuery? = nil) async throws -> ListResponse<T> {
        try await client.send("GET", "/api/items/\(slug)\(BacklexClient.buildSearch(query))", nil)
    }

    /// Fluent builder that compiles to a ``ListQuery``.
    public func query() -> QueryBuilder<T> {
        QueryBuilder { try await self.list($0) }
    }

    /// Single-function aggregate (count/sum/avg/min/max), optionally grouped.
    public func aggregate<B: Encodable>(_ body: B) async throws -> AggregateResponse {
        try await client.send("POST", "/api/items/\(slug)/aggregate", try JSONEncoder().encode(body))
    }

    public func one(_ id: String) async throws -> ItemResponse<T> {
        try await client.send("GET", "/api/items/\(slug)/\(id)", nil)
    }

    public func create<B: Encodable>(_ data: B) async throws -> ItemResponse<T> {
        try await client.send("POST", "/api/items/\(slug)", try JSONEncoder().encode(data))
    }

    public func update<B: Encodable>(_ id: String, _ patch: B) async throws -> ItemResponse<T> {
        try await client.send("PATCH", "/api/items/\(slug)/\(id)", try JSONEncoder().encode(patch))
    }

    public func delete(_ id: String) async throws -> DeleteResult {
        try await client.send("DELETE", "/api/items/\(slug)/\(id)", nil)
    }
}
