package com.backlex

import java.net.URLEncoder
import java.nio.charset.StandardCharsets

/**
 * Auth surface. In app mode (workspace set) calls target that workspace's own
 * auth pool (`/api/t/<slug>/auth/...`); otherwise the control plane.
 */
class Auth(private val client: BacklexClient) {
    private val tf = client.mapper.typeFactory
    private val authType = tf.constructType(AuthResult::class.java)
    private val mapType = tf.constructMapType(LinkedHashMap::class.java, String::class.java, Any::class.java)

    private fun base(): String =
        if (client.workspace.isNullOrEmpty()) "/api/auth"
        else "/api/t/${URLEncoder.encode(client.workspace, StandardCharsets.UTF_8)}/auth"

    private fun capture(r: AuthResult): AuthResult {
        if (!client.workspace.isNullOrEmpty() && !r.token.isNullOrEmpty()) client.appToken = r.token
        return r
    }

    /** Sign up with email + password. Pass name=null to omit it. */
    fun signUp(email: String, password: String, name: String? = null): AuthResult {
        val body = linkedMapOf<String, Any?>("email" to email, "password" to password)
        if (name != null) body["name"] = name
        return capture(client.request("POST", "${base()}/sign-up/email", body, authType))
    }

    fun signIn(email: String, password: String): AuthResult {
        val body = linkedMapOf<String, Any?>("email" to email, "password" to password)
        return capture(client.request("POST", "${base()}/sign-in/email", body, authType))
    }

    /** Begin an OAuth sign-in; navigate the user to the returned URL. */
    fun signInSocial(provider: String, callbackUrl: String? = null, errorCallbackUrl: String? = null): SocialResult {
        val body = linkedMapOf<String, Any?>("provider" to provider, "disableRedirect" to true)
        if (callbackUrl != null) body["callbackURL"] = callbackUrl
        if (errorCallbackUrl != null) body["errorCallbackURL"] = errorCallbackUrl
        return client.request("POST", "${base()}/sign-in/social", body, tf.constructType(SocialResult::class.java))
    }

    /** Send a one-time sign-in link by email. */
    fun signInMagicLink(email: String, callbackUrl: String? = null): Map<String, Any?> {
        val body = linkedMapOf<String, Any?>("email" to email)
        if (callbackUrl != null) body["callbackURL"] = callbackUrl
        return client.request("POST", "${base()}/sign-in/magic-link", body, mapType)
    }

    /** Clear the session; in app mode also drops the captured token. */
    fun signOut() {
        client.request<Map<String, Any?>?>("POST", "${base()}/sign-out", null, mapType)
        if (!client.workspace.isNullOrEmpty()) client.appToken = null
    }

    /** Send a password-reset email. Pass redirectTo=null to omit. */
    fun requestPasswordReset(email: String, redirectTo: String? = null): Map<String, Any?> {
        val body = linkedMapOf<String, Any?>("email" to email)
        if (redirectTo != null) body["redirectTo"] = redirectTo
        return client.request("POST", "${base()}/request-password-reset", body, mapType)
    }

    /** Complete a reset with the token from the email and a new password. */
    fun resetPassword(newPassword: String, token: String): Map<String, Any?> =
        client.request(
            "POST", "${base()}/reset-password",
            linkedMapOf<String, Any?>("newPassword" to newPassword, "token" to token), mapType,
        )

    /** Mint a fresh access JWT from the stored session token (app mode). */
    fun refresh(): Map<String, Any?> =
        client.request(
            "POST", "${base()}/token/refresh",
            linkedMapOf<String, Any?>("refreshToken" to client.appToken), mapType,
        )

    /** Current session payload, or `{"user": null}`. */
    fun session(): Map<String, Any?> = client.request("GET", "${base()}/get-session", null, mapType)

    /** Public auth surface (provider list + policy flags). */
    fun providers(): AuthSurface {
        val wrapType = tf.constructParametricType(ItemResponse::class.java, AuthSurface::class.java)
        val wrap: ItemResponse<AuthSurface> = client.request("GET", "${base()}/providers", null, wrapType)
        return wrap.data
    }

    /** Current workspace session token (app mode); persist and restore via the builder. */
    val token: String? get() = client.appToken

    /** Restore a workspace session token (app mode). */
    fun setToken(token: String?) {
        client.appToken = token
    }
}
