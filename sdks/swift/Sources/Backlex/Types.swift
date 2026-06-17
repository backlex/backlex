import Foundation

/// Query parameters a list/query call serializes into the URL.
public struct ListQuery {
    public var filter: Condition?
    public var sort: [String] = []
    public var fields: [String] = []
    public var expand: [String] = [] // inline single-hop relations
    public var limit: Int?
    public var offset: Int?
    public var meta: String? // "filter_count" | "total_count" | "*"
    public var locale: String? // one locale, or "*" for the full i18n map
    public var q: String? // free-text search across readable text fields
    public init() {}
}

/// Per-call options for `one(_:query:)`. The single-item read endpoint accepts
/// the same `expand`/`locale` params as the list endpoint.
public struct ItemQuery {
    public var expand: [String] = [] // inline single-hop relations
    public var locale: String? // one locale, or "*" for the full i18n map
    public init() {}
}

/// One aggregate row: `{value}` ungrouped, or `{label, value}` grouped.
public struct AggregateRow: Decodable {
    public let value: Double
    public let label: JSONValue?
}

/// The `{ "data": [...] }` envelope from `Collection.aggregate`.
public struct AggregateResponse: Decodable {
    public let data: [AggregateRow]
}

/// Result of a collection list/query call.
public struct ListResponse<T: Decodable>: Decodable {
    public let data: [T]
    public let limit: Int
    public let offset: Int
    public let meta: [String: Int]?
}

/// Single-item envelope: `{ "data": {...} }`.
public struct ItemResponse<T: Decodable>: Decodable {
    public let data: T
}

/// A realtime event frame: `{ "event": ..., "data": {...} }`.
public struct ItemEvent<T: Decodable>: Decodable {
    public let event: String // "created" | "updated" | "deleted"
    public let data: T
}

/// The authenticated principal returned by sign-in/up.
public struct AuthUser: Decodable {
    public let id: String
    public let email: String
    public let name: String?
    public let image: String?
}

/// The sign-in/up envelope. `token` is only set in app mode.
public struct AuthResult: Decodable {
    public let user: AuthUser
    public let token: String?
}

/// The `{ "ok": true }` envelope returned by delete endpoints.
public struct DeleteResult: Decodable {
    public let ok: Bool
}

/// Describes one stored object.
public struct FileRow: Decodable {
    public let key: String
    public let size: Int
    public let contentType: String?
    public let ownerId: String?
    public let uploadedAt: String
}
