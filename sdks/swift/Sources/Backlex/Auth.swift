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

    /// Email a one-time numeric code (requires the `email-otp` provider). `type` is
    /// `"sign-in"` (default), `"email-verification"` or `"forget-password"`.
    /// Complete a sign-in with `signInEmailOTP`.
    public func sendVerificationOTP(email: String, type: String = "sign-in") async throws -> [String: JSONValue] {
        let body: [String: JSONValue] = ["email": .string(email), "type": .string(type)]
        return try await client.send("POST", "\(base)/email-otp/send-verification-otp", try encodeBody(body))
    }

    /// Complete an email-OTP sign-in with the code from `sendVerificationOTP`. In
    /// app mode the returned session token is captured.
    public func signInEmailOTP(email: String, otp: String) async throws -> AuthResult {
        let body: [String: JSONValue] = ["email": .string(email), "otp": .string(otp)]
        let r: AuthResult = try await client.send("POST", "\(base)/sign-in/email-otp", try encodeBody(body))
        return capture(r)
    }

    /// Send a password-reset email. `redirectTo` is the link target.
    public func requestPasswordReset(email: String, redirectTo: String? = nil) async throws -> [String: JSONValue] {
        var body: [String: JSONValue] = ["email": .string(email)]
        if let redirectTo { body["redirectTo"] = .string(redirectTo) }
        return try await client.send("POST", "\(base)/request-password-reset", try encodeBody(body))
    }

    /// Complete a reset with the token from the email and a new password.
    public func resetPassword(newPassword: String, token: String) async throws -> [String: JSONValue] {
        let body: [String: JSONValue] = ["newPassword": .string(newPassword), "token": .string(token)]
        return try await client.send("POST", "\(base)/reset-password", try encodeBody(body))
    }

    /// Mint a fresh access JWT from the stored session token (app mode).
    public func refresh() async throws -> [String: JSONValue] {
        let body: [String: JSONValue] = ["refreshToken": client.appToken.map(JSONValue.string) ?? .null]
        return try await client.send("POST", "\(base)/token/refresh", try encodeBody(body))
    }

    /// Change the signed-in user's password (requires the current password).
    public func changePassword(newPassword: String, currentPassword: String, revokeOtherSessions: Bool = false) async throws -> [String: JSONValue] {
        let body: [String: JSONValue] = [
            "newPassword": .string(newPassword),
            "currentPassword": .string(currentPassword),
            "revokeOtherSessions": .bool(revokeOtherSessions),
        ]
        return try await client.send("POST", "\(base)/change-password", try encodeBody(body))
    }

    /// Update the signed-in user's profile (e.g. name / image).
    public func updateUser(_ attributes: [String: JSONValue]) async throws -> [String: JSONValue] {
        try await client.send("POST", "\(base)/update-user", try encodeBody(attributes))
    }

    /// Send an email-verification link.
    public func sendVerificationEmail(email: String, callbackURL: String? = nil) async throws -> [String: JSONValue] {
        var body: [String: JSONValue] = ["email": .string(email)]
        if let callbackURL { body["callbackURL"] = .string(callbackURL) }
        return try await client.send("POST", "\(base)/send-verification-email", try encodeBody(body))
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

    /// List the signed-in user's active sessions (one entry per device/login).
    public func listSessions() async throws -> [JSONValue] {
        try await client.send("GET", "\(base)/list-sessions", nil)
    }

    /// Revoke one session by its `token` (from `listSessions`).
    public func revokeSession(token: String) async throws -> [String: JSONValue] {
        let body: [String: JSONValue] = ["token": .string(token)]
        return try await client.send("POST", "\(base)/revoke-session", try encodeBody(body))
    }

    /// Revoke every session except the current one (sign out other devices).
    public func revokeOtherSessions() async throws -> [String: JSONValue] {
        try await client.send("POST", "\(base)/revoke-other-sessions", nil)
    }

    /// Revoke all sessions, including the current one.
    public func revokeSessions() async throws -> [String: JSONValue] {
        try await client.send("POST", "\(base)/revoke-sessions", nil)
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
