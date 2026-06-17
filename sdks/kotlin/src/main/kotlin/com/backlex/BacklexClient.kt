package com.backlex

import com.fasterxml.jackson.annotation.JsonInclude
import com.fasterxml.jackson.databind.DeserializationFeature
import com.fasterxml.jackson.databind.JavaType
import com.fasterxml.jackson.databind.ObjectMapper
import com.fasterxml.jackson.module.kotlin.registerKotlinModule
import java.io.BufferedReader
import java.io.InputStream
import java.io.InputStreamReader
import java.net.CookieManager
import java.net.URI
import java.net.URLEncoder
import java.net.http.HttpClient
import java.net.http.HttpRequest
import java.net.http.HttpResponse
import java.nio.charset.StandardCharsets

/**
 * The official Kotlin client for the backlex API — a thin, typed wrapper over the
 * same REST + SSE surface the TypeScript SDK (@backlex/client) speaks. Build with
 * [BacklexClient.builder]. Three auth modes: server key, workspace app mode
 * (token capture), or cookie session. Calls are synchronous and throw the
 * unchecked [BacklexException] on failure.
 */
class BacklexClient internal constructor(
    private val url: String,
    private val apiKey: String?,
    internal val workspace: String?,
    token: String?,
    private val tenant: String?,
    private val http: HttpClient,
) {
    internal val mapper: ObjectMapper = ObjectMapper()
        .registerKotlinModule()
        .configure(DeserializationFeature.FAIL_ON_UNKNOWN_PROPERTIES, false)
        .setSerializationInclusion(JsonInclude.Include.NON_NULL)

    @Volatile
    internal var appToken: String? = token

    val auth: Auth = Auth(this)
    val storage: Storage = Storage(this)

    /** Typed CRUD handle for a collection (reified convenience). */
    inline fun <reified T> from(slug: String): Collection<T> = from(slug, T::class.java)

    /** Typed CRUD handle for a collection. */
    fun <T> from(slug: String, type: Class<T>): Collection<T> =
        Collection(this, slug, mapper.typeFactory.constructType(type))

    internal fun applyAuth(rb: HttpRequest.Builder) {
        when {
            !apiKey.isNullOrEmpty() -> rb.header("Authorization", "Bearer $apiKey")
            !appToken.isNullOrEmpty() -> rb.header("Authorization", "Bearer $appToken")
        }
        if (!tenant.isNullOrEmpty()) rb.header("X-Backlex-Tenant", tenant)
    }

    /** Raw escape hatch — issues a request with auth headers applied. */
    @Suppress("UNCHECKED_CAST")
    fun <R> request(method: String, path: String, body: Any?, type: JavaType?): R {
        val payload = body?.let { mapper.writeValueAsString(it) }
        val rb = HttpRequest.newBuilder(URI.create(url + path))
            .method(
                method,
                if (payload == null) HttpRequest.BodyPublishers.noBody()
                else HttpRequest.BodyPublishers.ofString(payload),
            )
            .header("Content-Type", "application/json")
        applyAuth(rb)

        val resp = try {
            http.send(rb.build(), HttpResponse.BodyHandlers.ofString())
        } catch (e: Exception) {
            throw BacklexException(0, "NETWORK", e.message ?: "network error")
        }

        val sc = resp.statusCode()
        if (sc < 200 || sc >= 300) throw makeError(sc, resp.body())
        val text = resp.body()
        if (sc == 204 || text.isNullOrEmpty() || type == null) return null as R
        return try {
            mapper.readValue<Any>(text, type) as R
        } catch (e: Exception) {
            throw BacklexException(sc, "PARSE", e.message ?: "parse error")
        }
    }

    /** Raw-body request (e.g. storage uploads) with a custom content type. */
    @Suppress("UNCHECKED_CAST")
    internal fun <R> sendRaw(method: String, path: String, body: ByteArray, contentType: String?, type: JavaType?): R {
        val rb = HttpRequest.newBuilder(URI.create(url + path))
            .method(method, HttpRequest.BodyPublishers.ofByteArray(body))
        if (!contentType.isNullOrEmpty()) rb.header("Content-Type", contentType)
        applyAuth(rb)
        val resp = try {
            http.send(rb.build(), HttpResponse.BodyHandlers.ofString())
        } catch (e: Exception) {
            throw BacklexException(0, "NETWORK", e.message ?: "network error")
        }
        val sc = resp.statusCode()
        if (sc < 200 || sc >= 300) throw makeError(sc, resp.body())
        val text = resp.body()
        if (text.isNullOrEmpty() || type == null) return null as R
        return mapper.readValue<Any>(text, type) as R
    }

    /** Raw byte download. */
    internal fun downloadRaw(path: String): ByteArray {
        val rb = HttpRequest.newBuilder(URI.create(url + path)).GET()
        applyAuth(rb)
        val resp = try {
            http.send(rb.build(), HttpResponse.BodyHandlers.ofByteArray())
        } catch (e: Exception) {
            throw BacklexException(0, "NETWORK", e.message ?: "network error")
        }
        val sc = resp.statusCode()
        if (sc < 200 || sc >= 300) throw makeError(sc, String(resp.body(), StandardCharsets.UTF_8))
        return resp.body()
    }

    private fun makeError(status: Int, body: String?): BacklexException {
        var code = "UNKNOWN"
        var message = "HTTP $status"
        var details: Any? = null
        if (!body.isNullOrEmpty()) {
            try {
                val err = mapper.readTree(body).get("error")
                if (err != null && err.isObject) {
                    err.get("code")?.takeIf { it.isTextual }?.let { code = it.asText() }
                    err.get("message")?.takeIf { it.isTextual }?.let { message = it.asText() }
                    err.get("details")?.let { details = mapper.convertValue(it, Any::class.java) }
                }
            } catch (_: Exception) {
                // Non-JSON error body — keep the generic message.
            }
        }
        return BacklexException(status, code, message, details)
    }

    /**
     * Serialize a ListQuery into a URL query string (mirrors buildSearch in
     * index.ts). The filter is compact JSON, percent-encoded exactly once.
     */
    internal fun buildSearch(q: ListQuery?): String {
        if (q == null) return ""
        val parts = mutableListOf<String>()
        q.filter?.takeIf { it.isNotEmpty() }?.let { parts.add("filter=" + enc(mapper.writeValueAsString(it))) }
        if (q.sort.isNotEmpty()) parts.add("sort=" + enc(q.sort.joinToString(",")))
        if (q.fields.isNotEmpty()) parts.add("fields=" + enc(q.fields.joinToString(",")))
        if (q.expand.isNotEmpty()) parts.add("expand=" + enc(q.expand.joinToString(",")))
        q.limit?.let { parts.add("limit=$it") }
        q.offset?.let { parts.add("offset=$it") }
        q.meta?.let { parts.add("meta=" + enc(it)) }
        q.locale?.let { parts.add("locale=" + enc(it)) }
        q.q?.let { parts.add("q=" + enc(it)) }
        return if (parts.isEmpty()) "" else "?" + parts.joinToString("&")
    }

    private fun enc(s: String): String = URLEncoder.encode(s, StandardCharsets.UTF_8)

    // -- Realtime (SSE) ------------------------------------------------------

    /** Subscribe to a realtime channel (reified convenience). */
    inline fun <reified T> subscribe(
        channel: String,
        noinline onEvent: (ItemEvent<T>) -> Unit,
        noinline onError: ((Throwable) -> Unit)? = null,
    ): Subscription = subscribe(channel, T::class.java, onEvent, onError)

    /**
     * Subscribe to a realtime channel (e.g. "items:posts"). Returns a
     * [Subscription]; [Subscription.close] unsubscribes. The reader runs on a
     * daemon thread and auto-reconnects on a dropped stream (3s back-off),
     * replaying via Last-Event-ID. [onError] may be null.
     */
    fun <T> subscribe(
        channel: String,
        type: Class<T>,
        onEvent: (ItemEvent<T>) -> Unit,
        onError: ((Throwable) -> Unit)? = null,
    ): Subscription {
        val sub = Subscription()
        val evType = mapper.typeFactory.constructParametricType(ItemEvent::class.java, type)
        val surl = "$url/api/realtime/$channel/subscribe"
        val thread = Thread({ runSse(surl, sub, evType, onEvent, onError) }, "backlex-sse:$channel")
        thread.isDaemon = true
        sub.attachThread(thread)
        thread.start()
        return sub
    }

    private fun <T> runSse(
        surl: String,
        sub: Subscription,
        evType: JavaType,
        onEvent: (ItemEvent<T>) -> Unit,
        onError: ((Throwable) -> Unit)?,
    ) {
        var lastId: String? = null
        while (!sub.stopped) {
            try {
                val rb = HttpRequest.newBuilder(URI.create(surl)).GET().header("Accept", "text/event-stream")
                applyAuth(rb)
                lastId?.let { rb.header("Last-Event-ID", it) }
                val resp = http.send(rb.build(), HttpResponse.BodyHandlers.ofInputStream())
                if (resp.statusCode() != 200) {
                    onError?.invoke(BacklexException(resp.statusCode(), "UNKNOWN", "HTTP ${resp.statusCode()}"))
                } else {
                    sub.setStream(resp.body())
                    lastId = readSse(resp.body(), sub, evType, onEvent, onError, lastId)
                }
            } catch (e: Exception) {
                if (!sub.stopped) onError?.invoke(e)
            }
            if (sub.stopped) return
            try {
                Thread.sleep(3000)
            } catch (e: InterruptedException) {
                return
            }
        }
    }

    @Suppress("UNCHECKED_CAST")
    private fun <T> readSse(
        input: InputStream,
        sub: Subscription,
        evType: JavaType,
        onEvent: (ItemEvent<T>) -> Unit,
        onError: ((Throwable) -> Unit)?,
        lastIdIn: String?,
    ): String? {
        var lastId = lastIdIn
        val reader = BufferedReader(InputStreamReader(input, StandardCharsets.UTF_8))
        val data = mutableListOf<String>()
        while (!sub.stopped) {
            val line = reader.readLine() ?: break
            when {
                line.isEmpty() -> {
                    if (data.isNotEmpty()) {
                        val payload = data.joinToString("\n")
                        data.clear()
                        try {
                            onEvent(mapper.readValue<Any>(payload, evType) as ItemEvent<T>)
                        } catch (e: Exception) {
                            onError?.invoke(e)
                        }
                    }
                }
                line.startsWith(":") -> {}
                line.startsWith("id:") -> lastId = line.substring(3).trim()
                line.startsWith("data:") -> {
                    var d = line.substring(5)
                    if (d.startsWith(" ")) d = d.substring(1)
                    data.add(d)
                }
            }
        }
        return lastId
    }

    class Builder(private val baseUrl: String) {
        private var apiKey: String? = null
        private var workspace: String? = null
        private var token: String? = null
        private var tenant: String? = null
        private var http: HttpClient? = null

        /** Static server key (pak_...) sent as a bearer on every call. */
        fun apiKey(key: String?) = apply { this.apiKey = key }

        /** Workspace slug — puts the client in app mode (auth + token capture). */
        fun workspace(slug: String?) = apply { this.workspace = slug }

        /** Restore a previously-saved workspace session token (app mode). */
        fun token(token: String?) = apply { this.token = token }

        /** Scope every request to a tenant/workspace (slug or id) via the
         *  X-Backlex-Tenant header. */
        fun tenant(tenant: String?) = apply { this.tenant = tenant }

        /** Custom HttpClient (timeouts, proxies, testing). */
        fun httpClient(client: HttpClient) = apply { this.http = client }

        fun build(): BacklexClient = BacklexClient(
            baseUrl.trimEnd('/'),
            apiKey,
            workspace,
            token,
            tenant,
            http ?: HttpClient.newBuilder()
                .cookieHandler(CookieManager())
                .followRedirects(HttpClient.Redirect.NORMAL)
                .build(),
        )
    }

    companion object {
        fun builder(baseUrl: String): Builder = Builder(baseUrl)
    }
}
