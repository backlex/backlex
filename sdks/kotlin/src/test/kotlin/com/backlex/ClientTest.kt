package com.backlex

import com.fasterxml.jackson.databind.ObjectMapper
import com.sun.net.httpserver.HttpServer
import org.junit.jupiter.api.AfterEach
import org.junit.jupiter.api.Assertions.assertEquals
import org.junit.jupiter.api.Assertions.assertNull
import org.junit.jupiter.api.Assertions.assertThrows
import org.junit.jupiter.api.Assertions.assertTrue
import org.junit.jupiter.api.BeforeEach
import org.junit.jupiter.api.Test
import java.net.InetSocketAddress
import java.net.URLDecoder
import java.nio.charset.StandardCharsets

/** HTTP-layer tests backed by an in-JVM HttpServer — the Kotlin equivalent of the
 *  Python MockTransport / .NET RecordingHandler tests. */
class ClientTest {
    private val mapper = ObjectMapper()
    private lateinit var server: HttpServer
    private lateinit var base: String

    @Volatile private var lastMethod = ""
    @Volatile private var lastPath = ""
    @Volatile private var lastQuery: String? = null
    @Volatile private var lastAuth: String? = null
    @Volatile private var lastTenant: String? = null
    @Volatile private var lastBody = ""

    @BeforeEach
    fun setUp() {
        server = HttpServer.create(InetSocketAddress("127.0.0.1", 0), 0)
        server.createContext("/") { ex ->
            lastMethod = ex.requestMethod
            lastPath = ex.requestURI.path
            lastQuery = ex.requestURI.rawQuery
            lastAuth = ex.requestHeaders.getFirst("Authorization")
            lastTenant = ex.requestHeaders.getFirst("X-Backlex-Tenant")
            lastBody = ex.requestBody.readBytes().toString(StandardCharsets.UTF_8)

            val (code, json) = route()
            val bytes = json.toByteArray()
            ex.responseHeaders.set("Content-Type", "application/json")
            ex.sendResponseHeaders(code, bytes.size.toLong())
            ex.responseBody.use { it.write(bytes) }
        }
        server.start()
        base = "http://127.0.0.1:${server.address.port}"
    }

    @AfterEach
    fun tearDown() = server.stop(0)

    private fun route(): Pair<Int, String> = when {
        lastPath == "/api/items/missing" ->
            404 to """{"error":{"code":"NOT_FOUND","message":"no such collection"}}"""
        lastPath.endsWith("/aggregate") -> 200 to """{"data":[{"value":42}]}"""
        lastMethod == "POST" && lastPath.endsWith("/sign-in/email") ->
            if (lastPath.startsWith("/api/t/")) 200 to """{"user":{"id":"u1","email":"a@b.c"},"token":"tok_123"}"""
            else 200 to """{"user":{"id":"u1","email":"a@b.c"}}"""
        lastMethod == "DELETE" -> 200 to """{"ok":true}"""
        lastMethod == "POST" || lastMethod == "PATCH" -> 200 to """{"data":{"id":"x1"}}"""
        // Single-item read: /api/items/<slug>/<id> — object-shaped data.
        lastMethod == "GET" && Regex("/api/items/[^/]+/[^/]+").matches(lastPath) -> 200 to """{"data":{"id":"x1"}}"""
        else -> 200 to """{"data":[],"limit":50,"offset":0}"""
    }

    private fun filterParam(): String? =
        lastQuery?.split("&")?.firstOrNull { it.startsWith("filter=") }
            ?.substringAfter("=")?.let { URLDecoder.decode(it, StandardCharsets.UTF_8) }

    @Test
    fun queryStringFilterIsNotDoubleEncoded() {
        val client = BacklexClient.builder(base).apiKey("pak_x").build()
        client.from<Any>("orders").query()
            .where(Filter.eq("status", "active"))
            .orderBy("-created_at")
            .limit(5)
            .list()

        assertEquals("GET", lastMethod)
        assertEquals("/api/items/orders", lastPath)
        // If double percent-encoded, readTree would throw.
        val filter = mapper.readTree(filterParam())
        assertEquals("active", filter.get("status").get("_eq").asText())
    }

    @Test
    fun tenantHeaderIsSent() {
        val client = BacklexClient.builder(base).tenant("myapp").build()
        client.from<Any>("posts").list()
        assertEquals("myapp", lastTenant)
    }

    @Test
    fun queryExtrasSerialize() {
        val client = BacklexClient.builder(base).build()
        client.from<Any>("posts").query().expand("author").locale("tr").search("hi").list()
        assertTrue(lastQuery!!.contains("expand=author"))
        assertTrue(lastQuery!!.contains("locale=tr"))
        assertTrue(lastQuery!!.contains("q=hi"))
    }

    @Test
    fun oneForwardsExpandAndLocale() {
        val client = BacklexClient.builder(base).build()
        val q = ItemQuery().apply { expand.add("author"); locale = "tr" }
        client.from<Any>("posts").one("p1", q)
        assertEquals("/api/items/posts/p1", lastPath)
        assertTrue(lastQuery!!.contains("expand=author"))
        assertTrue(lastQuery!!.contains("locale=tr"))
    }

    @Test
    fun publishUnpublishPaths() {
        val client = BacklexClient.builder(base).build()
        client.from<Any>("posts").publish("p1")
        assertEquals("/api/items/posts/p1/publish", lastPath)
        client.from<Any>("posts").unpublish("p1")
        assertTrue(lastQuery!!.contains("unpublish=1"))
    }

    @Test
    fun aggregateHitsTheRightPath() {
        val client = BacklexClient.builder(base).build()
        val res = client.from<Any>("orders").aggregate(mapOf("agg" to "sum", "field" to "total"))
        assertEquals("/api/items/orders/aggregate", lastPath)
        assertEquals(42.0, res.data[0].value, 0.0001)
    }

    @Test
    fun passwordResetHitsTheRightPath() {
        val client = BacklexClient.builder(base).build()
        client.auth.requestPasswordReset("a@b.c")
        assertEquals("/api/auth/request-password-reset", lastPath)
    }

    @Test
    fun changePasswordHitsTheRightPath() {
        val client = BacklexClient.builder(base).build()
        client.auth.changePassword("new", "old")
        assertEquals("/api/auth/change-password", lastPath)
    }

    @Test
    fun apiKeyBearerHeader() {
        val client = BacklexClient.builder(base).apiKey("pak_secret").build()
        client.from<Any>("posts").list()
        assertEquals("Bearer pak_secret", lastAuth)
    }

    @Test
    fun crudMethodsPathsAndBody() {
        val client = BacklexClient.builder(base).apiKey("pak_x").build()
        val posts = client.from<Any>("posts")

        posts.create(mapOf("title" to "Hi"))
        assertEquals("POST", lastMethod)
        assertEquals("/api/items/posts", lastPath)
        assertEquals("Hi", mapper.readTree(lastBody).get("title").asText())

        posts.update("p1", mapOf("title" to "Edit"))
        assertEquals("PATCH", lastMethod)
        assertEquals("/api/items/posts/p1", lastPath)

        val del = posts.delete("p1")
        assertEquals("DELETE", lastMethod)
        assertTrue(del.ok)
    }

    @Test
    fun appModeTokenCaptureAndReplay() {
        val client = BacklexClient.builder(base).workspace("myapp").build()

        val res = client.auth.signIn("a@b.c", "pw")
        assertEquals("/api/t/myapp/auth/sign-in/email", lastPath)
        assertEquals("tok_123", res.token)
        assertEquals("tok_123", client.auth.token)

        client.from<Any>("posts").list()
        assertEquals("Bearer tok_123", lastAuth)

        client.auth.signOut()
        assertNull(client.auth.token)
    }

    @Test
    fun errorEnvelopeBecomesBacklexException() {
        val client = BacklexClient.builder(base).apiKey("pak_x").build()
        val ex = assertThrows(BacklexException::class.java) { client.from<Any>("missing").list() }
        assertEquals(404, ex.status)
        assertEquals("NOT_FOUND", ex.code)
        assertEquals("no such collection", ex.message)
    }

    @Test
    fun controlPlaneAuthDoesNotCaptureToken() {
        val client = BacklexClient.builder(base).build()
        client.auth.signIn("a@b.c", "pw")
        assertEquals("/api/auth/sign-in/email", lastPath)
        assertNull(client.auth.token)
    }
}
