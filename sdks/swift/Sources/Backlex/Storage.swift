import Foundation

/// File operations against `/api/storage`.
public struct Storage {
    let client: BacklexClient

    /// List stored objects, optionally filtered by key prefix.
    public func list(prefix: String? = nil) async throws -> [FileRow] {
        var path = "/api/storage"
        if let p = prefix, !p.isEmpty {
            path += "?prefix=\(BacklexClient.enc(p))"
        }
        let wrap: ItemResponse<[FileRow]> = try await client.send("GET", path, nil)
        return wrap.data
    }

    /// Upload bytes under `key`. Pass `contentType`/`folderId` nil to omit them.
    public func put(_ key: String, _ body: Data, contentType: String? = nil, folderId: String? = nil) async throws -> [String: JSONValue] {
        var path = "/api/storage/\(BacklexClient.enc(key))"
        if let fid = folderId, !fid.isEmpty {
            path += "?folderId=\(BacklexClient.enc(fid))"
        }
        return try await client.sendRaw("PUT", path, body, contentType: contentType)
    }

    /// Fetch the raw bytes for `key`.
    public func download(_ key: String) async throws -> Data {
        try await client.downloadRaw("/api/storage/\(BacklexClient.enc(key))")
    }

    /// Remove the object at `key`.
    public func delete(_ key: String) async throws -> DeleteResult {
        try await client.send("DELETE", "/api/storage/\(BacklexClient.enc(key))", nil)
    }
}
