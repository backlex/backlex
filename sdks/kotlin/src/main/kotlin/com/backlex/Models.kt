package com.backlex

/**
 * The canonical JSON filter grammar ($and / $or / $not / leaf maps), a plain
 * string-keyed map shared byte-for-byte with the other SDKs.
 */
typealias Condition = Map<String, Any?>

/** A non-2xx response from the backlex API (or a transport failure). Callers
 *  branch on [status] / [code] rather than parsing strings. */
class BacklexException(
    val status: Int,
    val code: String,
    message: String,
    val details: Any? = null,
) : RuntimeException(message)

/** Query parameters a list/query call serializes into the URL. */
class ListQuery {
    var filter: Condition? = null
    val sort = mutableListOf<String>()
    val fields = mutableListOf<String>()
    var limit: Int? = null
    var offset: Int? = null
    var meta: String? = null // "filter_count" | "total_count" | "*"
}

/** Result of a collection list/query call. */
data class ListResponse<T>(
    val data: List<T> = emptyList(),
    val limit: Int = 0,
    val offset: Int = 0,
    val meta: Map<String, Int>? = null,
)

/** Single-item envelope: `{ "data": {...} }`. */
data class ItemResponse<T>(val data: T)

/** A realtime event frame: `{ "event": ..., "data": {...} }`. */
data class ItemEvent<T>(val event: String = "", val data: T)

/** The authenticated principal returned by sign-in/up. */
data class AuthUser(
    val id: String = "",
    val email: String = "",
    val name: String? = null,
    val image: String? = null,
)

/** The sign-in/up envelope. [token] is only set in app mode. */
data class AuthResult(val user: AuthUser = AuthUser(), val token: String? = null)

/** The `{ "ok": true }` envelope returned by delete endpoints. */
data class DeleteResult(val ok: Boolean = false)

/** Describes one stored object. */
data class FileRow(
    val key: String = "",
    val size: Long = 0,
    val contentType: String? = null,
    val ownerId: String? = null,
    val uploadedAt: String = "",
)

/** One enabled sign-in method in the public auth surface. */
data class AuthProvider(
    val id: String = "",
    val kind: String = "",
    val label: String = "",
    val enabled: Boolean = false,
)

/** The public description of a workspace's auth (no secrets). */
data class AuthSurface(
    val tenantId: String? = null,
    val providers: List<AuthProvider> = emptyList(),
    val policy: Map<String, Any?> = emptyMap(),
)

/** The `{ "url", "redirect" }` envelope from `signInSocial`. */
data class SocialResult(val url: String = "", val redirect: Boolean = false)
