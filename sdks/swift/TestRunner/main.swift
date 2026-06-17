import Foundation
@testable import Backlex

// A tiny self-contained test runner (CommandLineTools ships no XCTest /
// swift-testing for the macOS host). Exits non-zero if any check fails.
// Covers the same contract as the Python/Go/.NET/Java/Kotlin suites: the query
// builder compiles to byte-identical canonical JSON, and the HTTP layer wires
// paths/encoding/auth/errors correctly (via a URLProtocol mock).

var failures = 0
func check(_ cond: Bool, _ msg: String) {
    if cond { print("ok   - \(msg)") } else { failures += 1; print("FAIL - \(msg)") }
}

// MARK: - Query builder (offline) ------------------------------------------

check(Filter.normalize(Filter.and(Filter.eq("status", "active"), Filter.gte("total", 100)))
        == ["$and": [["status": ["_eq": "active"]], ["total": ["_gte": 100]]]],
      "leaf + logical")

check(Filter.rel("customer", Filter.eq("tier", "gold"))
        == ["customer.tier": ["_eq": "gold"]],
      "relation hop prefixes keys")

check(Filter.rel("customer", Filter.eq("tier", "gold"), Filter.gte("age", 18))
        == ["$and": [["customer.tier": ["_eq": "gold"]], ["customer.age": ["_gte": 18]]]],
      "relation hop, multiple conds")

check(Filter.gte("placed_at", Filter.now(sub: ["months": 1]))
        == ["placed_at": ["_gte": ["$now": ["sub": ["months": 1]]]]],
      "now relative date")

check(Filter.normalize(["status": "active"]) == ["status": ["_eq": "active"]], "implicit equality")
check(Filter.normalize(["_and": [["a": 1]]]) == ["$and": [["a": ["_eq": 1]]]], "alias _and -> $and")
check(Filter.normalize(["_not": ["a": 1]]) == ["$not": ["a": ["_eq": 1]]], "alias _not -> $not")
let once = Filter.normalize(["status": "active"])
check(Filter.normalize(once) == once, "normalize idempotent")

do {
    let q = BacklexClient("http://x").from("posts", as: JSONValue.self).query()
        .where(Filter.eq("published", true))
        .select("id", "title")
        .orderBy("-created_at", "id")
        .limit(50).offset(10).withMeta("filter_count")
        .toQuery()
    check(q.filter == ["published": ["_eq": true]]
            && q.sort == ["-created_at", "id"]
            && q.limit == 50 && q.offset == 10 && q.meta == "filter_count",
          "toQuery assembly")
}

// MARK: - HTTP layer (URLProtocol mock) ------------------------------------

final class MockURLProtocol: URLProtocol {
    nonisolated(unsafe) static var lastRequest: URLRequest?
    nonisolated(unsafe) static var lastBody: Data?

    override class func canInit(with request: URLRequest) -> Bool { true }
    override class func canonicalRequest(for request: URLRequest) -> URLRequest { request }
    override func stopLoading() {}

    override func startLoading() {
        MockURLProtocol.lastRequest = request
        MockURLProtocol.lastBody = MockURLProtocol.body(request)
        let (status, data) = MockURLProtocol.route(request)
        let resp = HTTPURLResponse(url: request.url!, statusCode: status, httpVersion: nil,
                                   headerFields: ["Content-Type": "application/json"])!
        client?.urlProtocol(self, didReceive: resp, cacheStoragePolicy: .notAllowed)
        client?.urlProtocol(self, didLoad: data)
        client?.urlProtocolDidFinishLoading(self)
    }

    static func route(_ req: URLRequest) -> (Int, Data) {
        let path = req.url!.path
        let method = req.httpMethod ?? "GET"
        func j(_ s: String) -> Data { Data(s.utf8) }
        if path == "/api/items/missing" {
            return (404, j(#"{"error":{"code":"NOT_FOUND","message":"no such collection"}}"#))
        }
        if method == "POST" && path.hasSuffix("/sign-in/email") {
            return path.hasPrefix("/api/t/")
                ? (200, j(#"{"user":{"id":"u1","email":"a@b.c"},"token":"tok_123"}"#))
                : (200, j(#"{"user":{"id":"u1","email":"a@b.c"}}"#))
        }
        if method == "DELETE" { return (200, j(#"{"ok":true}"#)) }
        if method == "POST" || method == "PATCH" { return (200, j(#"{"data":{"id":"x1"}}"#)) }
        return (200, j(#"{"data":[],"limit":50,"offset":0}"#))
    }

    static func body(_ req: URLRequest) -> Data? {
        if let b = req.httpBody { return b }
        guard let stream = req.httpBodyStream else { return nil }
        stream.open(); defer { stream.close() }
        var data = Data(); var buf = [UInt8](repeating: 0, count: 4096)
        while stream.hasBytesAvailable {
            let n = stream.read(&buf, maxLength: 4096)
            if n <= 0 { break }
            data.append(buf, count: n)
        }
        return data
    }
}

func mockClient(apiKey: String? = nil, workspace: String? = nil) -> BacklexClient {
    let cfg = URLSessionConfiguration.ephemeral
    cfg.protocolClasses = [MockURLProtocol.self]
    return BacklexClient("http://test", apiKey: apiKey, workspace: workspace,
                         session: URLSession(configuration: cfg))
}

do {
    let client = mockClient(apiKey: "pak_x")
    _ = try await client.from("orders", as: JSONValue.self).query()
        .where(Filter.eq("status", "active")).orderBy("-created_at").limit(5).list()
    let req = MockURLProtocol.lastRequest!
    let comps = URLComponents(url: req.url!, resolvingAgainstBaseURL: false)!
    let filterValue = comps.queryItems!.first { $0.name == "filter" }!.value!
    let parsed = try JSONDecoder().decode(JSONValue.self, from: Data(filterValue.utf8))
    check(req.url!.path == "/api/items/orders" && parsed == ["status": ["_eq": "active"]],
          "query string filter is not double-encoded")
}

do {
    let client = mockClient(apiKey: "pak_secret")
    _ = try await client.from("posts", as: JSONValue.self).list()
    check(MockURLProtocol.lastRequest!.value(forHTTPHeaderField: "Authorization") == "Bearer pak_secret",
          "api key bearer header")
}

do {
    let client = mockClient(apiKey: "pak_x")
    let posts = client.from("posts", as: JSONValue.self)
    _ = try await posts.create(["title": "Hi"] as JSONValue)
    let sent = try JSONDecoder().decode(JSONValue.self, from: MockURLProtocol.lastBody!)
    let createOK = MockURLProtocol.lastRequest!.httpMethod == "POST"
        && MockURLProtocol.lastRequest!.url!.path == "/api/items/posts" && sent == ["title": "Hi"]
    _ = try await posts.update("p1", ["title": "Edit"] as JSONValue)
    let updateOK = MockURLProtocol.lastRequest!.httpMethod == "PATCH"
        && MockURLProtocol.lastRequest!.url!.path == "/api/items/posts/p1"
    let del = try await posts.delete("p1")
    check(createOK && updateOK && MockURLProtocol.lastRequest!.httpMethod == "DELETE" && del.ok,
          "CRUD methods, paths, body")
}

do {
    let client = mockClient(workspace: "myapp")
    let res = try await client.auth.signIn(email: "a@b.c", password: "pw")
    let signedIn = MockURLProtocol.lastRequest!.url!.path == "/api/t/myapp/auth/sign-in/email"
        && res.token == "tok_123" && client.auth.token == "tok_123"
    _ = try await client.from("posts", as: JSONValue.self).list()
    let replayed = MockURLProtocol.lastRequest!.value(forHTTPHeaderField: "Authorization") == "Bearer tok_123"
    try await client.auth.signOut()
    check(signedIn && replayed && client.auth.token == nil, "app-mode token capture + replay")
}

do {
    let client = mockClient(apiKey: "pak_x")
    var caught = false
    do { _ = try await client.from("missing", as: JSONValue.self).list() }
    catch let e as BacklexError { caught = e.status == 404 && e.code == "NOT_FOUND" }
    check(caught, "error envelope -> BacklexError(404, NOT_FOUND)")
}

do {
    let client = mockClient()
    _ = try await client.auth.signIn(email: "a@b.c", password: "pw")
    check(MockURLProtocol.lastRequest!.url!.path == "/api/auth/sign-in/email" && client.auth.token == nil,
          "control-plane auth does not capture token")
}

print(failures == 0 ? "\nALL PASSED" : "\n\(failures) FAILED")
exit(failures == 0 ? 0 : 1)
