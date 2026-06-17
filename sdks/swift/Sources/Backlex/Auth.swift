import Foundation

/// One enabled sign-in method in the public auth surface.
public struct AuthProvider: Decodable {
    public let id: String
    public let kind: String
    public let label: String
    public let enabled: Bool
}

/// The public description of a workspace's auth (no secrets).
public struct AuthSurface: Decodable {
    public let tenantId: String?
    public let providers: [AuthProvider]
    public let policy: [String: JSONValue]
}

/// The `{ "url", "redirect" }` envelope from `signInSocial`.
public struct SocialResult: Decodable {
    public let url: String
    public let redirect: Bool
}

/// Auth surface. In app mode (workspace set) calls target that workspace's own
/// auth pool (`/api/t/<slug>/auth/*`); otherwise the control plane.
public struct Auth {
    let client: BacklexClient

    private var base: String {
        if let ws = client.workspace, !ws.isEmpty {
            return "/api/t/\(BacklexClient.enc(ws))/auth"
        }
        return "/api/auth"
    }

    private func capture(_ r: AuthResult) -> AuthResult {
        if let ws = client.workspace, !ws.isEmpty, let t = r.token {
            client.appToken = t
        }
        return r
    }

    private func encodeBody(_ body: [String: JSONValue]) throws -> Data {
        try JSONEncoder().encode(JSONValue.object(body))
    }

    /// Sign up with email + password. Pass `name: nil` to omit it.
    public func signUp(email: String, password: String, name: String? = nil) async throws -> AuthResult {
        var body: [String: JSONValue] = ["email": .string(email), "password": .string(password)]
        if let name { body["name"] = .string(name) }
        let r: AuthResult = try await client.send("POST", "\(base)/sign-up/email", try encodeBody(body))
        return capture(r)
    }

    public func signIn(email: String, password: String) async throws -> AuthResult {
        let body: [String: JSONValue] = ["email": .string(email), "password": .string(password)]
        let r: AuthResult = try await client.send("POST", "\(base)/sign-in/email", try encodeBody(body))
        return capture(r)
    }

    /// Begin an OAuth sign-in; navigate the user to the returned URL.
    public func signInSocial(provider: String, callbackURL: String? = nil, errorCallbackURL: String? = nil) async throws -> SocialResult {
        var body: [String: JSONValue] = ["provider": .string(provider), "disableRedirect": .bool(true)]
        if let callbackURL { body["callbackURL"] = .string(callbackURL) }
        if let errorCallbackURL { body["errorCallbackURL"] = .string(errorCallbackURL) }
        return try await client.send("POST", "\(base)/sign-in/social", try encodeBody(body))
    }

    /// Send a one-time sign-in link by email.
    public func signInMagicLink(email: String, callbackURL: String? = nil) async throws -> [String: JSONValue] {
        var body: [String: JSONValue] = ["email": .string(email)]
        if let callbackURL { body["callbackURL"] = .string(callbackURL) }
        return try await client.send("POST", "\(base)/sign-in/magic-link", try encodeBody(body))
    }

    /// Clear the session; in app mode also drops the captured token.
    public func signOut() async throws {
        let _: [String: JSONValue] = try await client.send("POST", "\(base)/sign-out", nil)
        if let ws = client.workspace, !ws.isEmpty {
            client.appToken = nil
        }
    }

    /// Current session payload, or `{"user": null}`.
    public func session() async throws -> [String: JSONValue] {
        try await client.send("GET", "\(base)/get-session", nil)
    }

    /// Public auth surface (provider list + policy flags).
    public func providers() async throws -> AuthSurface {
        let wrap: ItemResponse<AuthSurface> = try await client.send("GET", "\(base)/providers", nil)
        return wrap.data
    }

    /// Current workspace session token (app mode); persist and restore via `init(token:)`.
    public var token: String? { client.appToken }

    /// Restore a workspace session token (app mode).
    public func setToken(_ token: String?) { client.appToken = token }
}
