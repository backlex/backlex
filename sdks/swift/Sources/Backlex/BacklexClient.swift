import Foundation
#if canImport(FoundationNetworking)
import FoundationNetworking
#endif

/// The official Swift client for the backlex API — a thin, typed wrapper over the
/// same REST + SSE surface the TypeScript SDK (@backlex/client) speaks. Three auth
/// modes: server key, workspace app mode (token capture), or cookie session.
/// Async throughout via `URLSession`; throws ``BacklexError`` on failure.
public final class BacklexClient {
    let url: String
    let apiKey: String?
    let workspace: String?
    let tenant: String?
    let session: URLSession

    private let lock = NSLock()
    private var _appToken: String?

    var appToken: String? {
        get { lock.lock(); defer { lock.unlock() }; return _appToken }
        set { lock.lock(); _appToken = newValue; lock.unlock() }
    }

    public private(set) lazy var auth = Auth(client: self)
    public private(set) lazy var storage = Storage(client: self)

    public init(
        _ baseURL: String,
        apiKey: String? = nil,
        workspace: String? = nil,
        token: String? = nil,
        tenant: String? = nil,
        session: URLSession? = nil
    ) {
        self.url = baseURL.hasSuffix("/") ? String(baseURL.dropLast()) : baseURL
        self.apiKey = apiKey
        self.workspace = workspace
        self.tenant = tenant
        self._appToken = token
        if let session {
            self.session = session
        } else {
            let cfg = URLSessionConfiguration.default
            cfg.httpCookieStorage = HTTPCookieStorage() // same-origin cookie sessions
            self.session = URLSession(configuration: cfg)
        }
    }

    /// Typed CRUD handle for a collection. Pass `JSONValue` as the type for
    /// schema-blind access, or a `Decodable` model.
    public func from<T: Decodable>(_ slug: String, as type: T.Type) -> Collection<T> {
        Collection(client: self, slug: slug)
    }

    func applyAuth(_ req: inout URLRequest) {
        if let apiKey {
            req.setValue("Bearer \(apiKey)", forHTTPHeaderField: "Authorization")
        } else if let t = appToken {
            req.setValue("Bearer \(t)", forHTTPHeaderField: "Authorization")
        }
        if let tenant {
            req.setValue(tenant, forHTTPHeaderField: "X-Backlex-Tenant")
        }
    }

    private func perform(_ req: URLRequest) async throws -> (Data, HTTPURLResponse) {
        let data: Data
        let resp: URLResponse
        do {
            (data, resp) = try await session.data(for: req)
        } catch {
            throw BacklexError(status: 0, code: "NETWORK", message: error.localizedDescription, details: nil)
        }
        guard let http = resp as? HTTPURLResponse else {
            throw BacklexError(status: 0, code: "NETWORK", message: "no HTTP response", details: nil)
        }
        if http.statusCode < 200 || http.statusCode >= 300 {
            throw BacklexError.from(status: http.statusCode, body: data)
        }
        return (data, http)
    }

    private func decode<R: Decodable>(_ data: Data, _ status: Int) throws -> R {
        do {
            return try JSONDecoder().decode(R.self, from: data)
        } catch {
            throw BacklexError(status: status, code: "DECODE", message: error.localizedDescription, details: nil)
        }
    }

    /// JSON request with auth headers applied; decodes the response into `R`.
    func send<R: Decodable>(_ method: String, _ path: String, _ body: Data?) async throws -> R {
        guard let u = URL(string: url + path) else {
            throw BacklexError(status: 0, code: "URL", message: "invalid URL: \(path)", details: nil)
        }
        var req = URLRequest(url: u)
        req.httpMethod = method
        req.setValue("application/json", forHTTPHeaderField: "Content-Type")
        if let body { req.httpBody = body }
        applyAuth(&req)
        let (data, http) = try await perform(req)
        return try decode(data, http.statusCode)
    }

    /// Raw-body request (e.g. storage uploads) with a custom content type.
    func sendRaw<R: Decodable>(_ method: String, _ path: String, _ body: Data, contentType: String?) async throws -> R {
        guard let u = URL(string: url + path) else {
            throw BacklexError(status: 0, code: "URL", message: "invalid URL: \(path)", details: nil)
        }
        var req = URLRequest(url: u)
        req.httpMethod = method
        req.httpBody = body
        if let contentType { req.setValue(contentType, forHTTPHeaderField: "Content-Type") }
        applyAuth(&req)
        let (data, http) = try await perform(req)
        return try decode(data, http.statusCode)
    }

    /// Raw byte download.
    func downloadRaw(_ path: String) async throws -> Data {
        guard let u = URL(string: url + path) else {
            throw BacklexError(status: 0, code: "URL", message: "invalid URL: \(path)", details: nil)
        }
        var req = URLRequest(url: u)
        applyAuth(&req)
        let (data, _) = try await perform(req)
        return data
    }

    /// Serialize a ListQuery into a URL query string (mirrors buildSearch in
    /// index.ts). The filter is compact JSON, percent-encoded exactly once.
    static func buildSearch(_ q: ListQuery?) -> String {
        guard let q else { return "" }
        var parts: [String] = []
        if let f = q.filter, !isEmptyObject(f),
           let data = try? JSONEncoder().encode(f),
           let s = String(data: data, encoding: .utf8) {
            parts.append("filter=\(enc(s))")
        }
        if !q.sort.isEmpty { parts.append("sort=\(enc(q.sort.joined(separator: ",")))") }
        if !q.fields.isEmpty { parts.append("fields=\(enc(q.fields.joined(separator: ",")))") }
        if !q.expand.isEmpty { parts.append("expand=\(enc(q.expand.joined(separator: ",")))") }
        if let l = q.limit { parts.append("limit=\(l)") }
        if let o = q.offset { parts.append("offset=\(o)") }
        if let m = q.meta { parts.append("meta=\(enc(m))") }
        if let loc = q.locale { parts.append("locale=\(enc(loc))") }
        if let qq = q.q { parts.append("q=\(enc(qq))") }
        return parts.isEmpty ? "" : "?" + parts.joined(separator: "&")
    }

    /// Serialize an `ItemQuery` — a strict subset of `buildSearch` (expand + locale).
    static func buildItemSearch(_ q: ItemQuery?) -> String {
        guard let q else { return "" }
        var parts: [String] = []
        if !q.expand.isEmpty { parts.append("expand=\(enc(q.expand.joined(separator: ",")))") }
        if let loc = q.locale { parts.append("locale=\(enc(loc))") }
        return parts.isEmpty ? "" : "?" + parts.joined(separator: "&")
    }

    /// Percent-encode a query value, escaping everything but RFC 3986 unreserved
    /// characters — equivalent to JS `encodeURIComponent`, so no double-encoding.
    static func enc(_ s: String) -> String {
        var cs = CharacterSet.alphanumerics
        cs.insert(charactersIn: "-._~")
        return s.addingPercentEncoding(withAllowedCharacters: cs) ?? s
    }

    private static func isEmptyObject(_ v: JSONValue) -> Bool {
        if case .object(let o) = v { return o.isEmpty }
        return false
    }
}
