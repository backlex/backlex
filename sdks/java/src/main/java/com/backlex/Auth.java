package com.backlex;

import com.fasterxml.jackson.databind.JavaType;
import com.fasterxml.jackson.databind.type.TypeFactory;
import java.net.URLEncoder;
import java.nio.charset.StandardCharsets;
import java.util.LinkedHashMap;
import java.util.Map;

/**
 * Auth surface. In app mode (workspace set) calls target that workspace's own
 * auth pool (/api/t/&lt;slug&gt;/auth/*); otherwise the control plane.
 */
public final class Auth {

    private final BacklexClient client;
    private final JavaType authResultType;
    private final JavaType mapType;
    private final JavaType mapListType;

    Auth(BacklexClient client) {
        this.client = client;
        TypeFactory tf = BacklexClient.MAPPER.getTypeFactory();
        this.authResultType = tf.constructType(Models.AuthResult.class);
        this.mapType = tf.constructMapType(LinkedHashMap.class, String.class, Object.class);
        this.mapListType = tf.constructCollectionType(java.util.List.class, mapType);
    }

    private String base() {
        if (client.workspace == null || client.workspace.isEmpty()) {
            return "/api/auth";
        }
        return "/api/t/" + URLEncoder.encode(client.workspace, StandardCharsets.UTF_8) + "/auth";
    }

    private Models.AuthResult capture(Models.AuthResult r) {
        if (client.workspace != null && !client.workspace.isEmpty() && r.token != null && !r.token.isEmpty()) {
            client.appToken = r.token;
        }
        return r;
    }

    /** Sign up with email + password. Pass name=null to omit it. */
    public Models.AuthResult signUp(String email, String password, String name) {
        Map<String, Object> body = new LinkedHashMap<>();
        body.put("email", email);
        body.put("password", password);
        if (name != null) body.put("name", name);
        return capture(client.request("POST", base() + "/sign-up/email", body, authResultType));
    }

    public Models.AuthResult signIn(String email, String password) {
        Map<String, Object> body = new LinkedHashMap<>();
        body.put("email", email);
        body.put("password", password);
        return capture(client.request("POST", base() + "/sign-in/email", body, authResultType));
    }

    /** Begin an OAuth sign-in; navigate the user to the returned URL. */
    public Models.SocialResult signInSocial(String provider, String callbackUrl, String errorCallbackUrl) {
        Map<String, Object> body = new LinkedHashMap<>();
        body.put("provider", provider);
        body.put("disableRedirect", true);
        if (callbackUrl != null) body.put("callbackURL", callbackUrl);
        if (errorCallbackUrl != null) body.put("errorCallbackURL", errorCallbackUrl);
        return client.request("POST", base() + "/sign-in/social", body,
                BacklexClient.MAPPER.getTypeFactory().constructType(Models.SocialResult.class));
    }

    /** Send a one-time sign-in link by email. */
    public Map<String, Object> signInMagicLink(String email, String callbackUrl) {
        Map<String, Object> body = new LinkedHashMap<>();
        body.put("email", email);
        if (callbackUrl != null) body.put("callbackURL", callbackUrl);
        return client.request("POST", base() + "/sign-in/magic-link", body, mapType);
    }

    /**
     * Email a one-time numeric code (requires the email-otp provider). {@code type}
     * is "sign-in", "email-verification" or "forget-password". Complete a sign-in
     * with {@link #signInEmailOtp}.
     */
    public Map<String, Object> sendVerificationOtp(String email, String type) {
        Map<String, Object> body = new LinkedHashMap<>();
        body.put("email", email);
        body.put("type", type == null ? "sign-in" : type);
        return client.request("POST", base() + "/email-otp/send-verification-otp", body, mapType);
    }

    /** Complete an email-OTP sign-in with the code from {@link #sendVerificationOtp}. */
    public Models.AuthResult signInEmailOtp(String email, String otp) {
        Map<String, Object> body = new LinkedHashMap<>();
        body.put("email", email);
        body.put("otp", otp);
        return capture(client.request("POST", base() + "/sign-in/email-otp", body, authResultType));
    }

    /** Send a password-reset email. Pass redirectTo=null to omit. */
    public Map<String, Object> requestPasswordReset(String email, String redirectTo) {
        Map<String, Object> body = new LinkedHashMap<>();
        body.put("email", email);
        if (redirectTo != null) body.put("redirectTo", redirectTo);
        return client.request("POST", base() + "/request-password-reset", body, mapType);
    }

    /** Complete a reset with the token from the email and a new password. */
    public Map<String, Object> resetPassword(String newPassword, String token) {
        Map<String, Object> body = new LinkedHashMap<>();
        body.put("newPassword", newPassword);
        body.put("token", token);
        return client.request("POST", base() + "/reset-password", body, mapType);
    }

    /** Mint a fresh access JWT from the stored session token (app mode). */
    public Map<String, Object> refresh() {
        Map<String, Object> body = new LinkedHashMap<>();
        body.put("refreshToken", client.appToken);
        return client.request("POST", base() + "/token/refresh", body, mapType);
    }

    /** Change the signed-in user's password (requires the current password). */
    public Map<String, Object> changePassword(String newPassword, String currentPassword, boolean revokeOtherSessions) {
        Map<String, Object> body = new LinkedHashMap<>();
        body.put("newPassword", newPassword);
        body.put("currentPassword", currentPassword);
        body.put("revokeOtherSessions", revokeOtherSessions);
        return client.request("POST", base() + "/change-password", body, mapType);
    }

    /** Update the signed-in user's profile (e.g. name / image). */
    public Map<String, Object> updateUser(Map<String, Object> attributes) {
        return client.request("POST", base() + "/update-user", attributes, mapType);
    }

    /** Send an email-verification link. Pass callbackUrl=null to omit. */
    public Map<String, Object> sendVerificationEmail(String email, String callbackUrl) {
        Map<String, Object> body = new LinkedHashMap<>();
        body.put("email", email);
        if (callbackUrl != null) body.put("callbackURL", callbackUrl);
        return client.request("POST", base() + "/send-verification-email", body, mapType);
    }

    /** Clear the session; in app mode also drops the captured token. */
    public void signOut() {
        client.request("POST", base() + "/sign-out", null, mapType);
        if (client.workspace != null && !client.workspace.isEmpty()) {
            client.appToken = null;
        }
    }

    /** Current session payload, or {"user": null}. */
    public Map<String, Object> session() {
        return client.request("GET", base() + "/get-session", null, mapType);
    }

    /** List the signed-in user's active sessions (one row per device/login). */
    public java.util.List<Map<String, Object>> listSessions() {
        return client.request("GET", base() + "/list-sessions", null, mapListType);
    }

    /** Revoke one session by its {@code token} (from {@link #listSessions}). */
    public Map<String, Object> revokeSession(String token) {
        Map<String, Object> body = new LinkedHashMap<>();
        body.put("token", token);
        return client.request("POST", base() + "/revoke-session", body, mapType);
    }

    /** Revoke every session except the current one (sign out other devices). */
    public Map<String, Object> revokeOtherSessions() {
        return client.request("POST", base() + "/revoke-other-sessions", null, mapType);
    }

    /** Revoke all sessions, including the current one. */
    public Map<String, Object> revokeSessions() {
        return client.request("POST", base() + "/revoke-sessions", null, mapType);
    }

    /** Public auth surface (provider list + policy flags). */
    public Models.AuthSurface providers() {
        JavaType wrap = BacklexClient.MAPPER.getTypeFactory()
                .constructParametricType(ItemResponse.class, Models.AuthSurface.class);
        ItemResponse<Models.AuthSurface> r = client.request("GET", base() + "/providers", null, wrap);
        return r != null && r.data != null ? r.data : new Models.AuthSurface();
    }

    /** Current workspace session token (app mode); persist and restore via the builder. */
    public String token() {
        return client.appToken;
    }

    /** Restore a workspace session token (app mode). */
    public void setToken(String token) {
        client.appToken = token;
    }
}
