import Foundation

/// A non-2xx response from the backlex API, mirroring the TS SDK's BacklexError.
/// The API returns errors as `{ "error": { "code", "message", "details"? } }`;
/// callers branch on `status` / `code` rather than parsing strings.
public struct BacklexError: Error, CustomStringConvertible {
    /// HTTP status code (0 for transport/decoding failures).
    public let status: Int
    /// Machine-readable code ("VALIDATION", "UNAUTHORIZED", ...); "UNKNOWN" if absent.
    public let code: String
    public let message: String
    /// Optional structured details from the error envelope.
    public let details: JSONValue?

    public init(status: Int, code: String, message: String, details: JSONValue?) {
        self.status = status
        self.code = code
        self.message = message
        self.details = details
    }

    public var description: String { "backlex: \(status) \(code): \(message)" }

    /// Parse the `{ "error": {...} }` envelope from a response body.
    static func from(status: Int, body: Data) -> BacklexError {
        struct Envelope: Decodable {
            struct Inner: Decodable {
                let code: String?
                let message: String?
                let details: JSONValue?
            }
            let error: Inner?
        }
        if let env = try? JSONDecoder().decode(Envelope.self, from: body), let e = env.error {
            return BacklexError(
                status: status,
                code: e.code ?? "UNKNOWN",
                message: e.message ?? "HTTP \(status)",
                details: e.details)
        }
        return BacklexError(status: status, code: "UNKNOWN", message: "HTTP \(status)", details: nil)
    }
}
