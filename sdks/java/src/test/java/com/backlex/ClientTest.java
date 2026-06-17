package com.backlex;

import static com.backlex.Filter.*;
import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertNull;
import static org.junit.jupiter.api.Assertions.assertThrows;
import static org.junit.jupiter.api.Assertions.assertTrue;

import com.fasterxml.jackson.databind.ObjectMapper;
import com.sun.net.httpserver.HttpServer;
import java.net.InetSocketAddress;
import java.net.URLDecoder;
import java.nio.charset.StandardCharsets;
import java.util.Map;
import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;

/** HTTP-layer tests backed by an in-JVM HttpServer — the Java equivalent of the
 *  Python MockTransport / .NET RecordingHandler tests. */
class ClientTest {

    private static final ObjectMapper M = new ObjectMapper();

    private HttpServer server;
    private String base;

    volatile String lastMethod;
    volatile String lastPath;
    volatile String lastQuery;
    volatile String lastAuth;
    volatile String lastBody;

    @BeforeEach
    void setUp() throws Exception {
        server = HttpServer.create(new InetSocketAddress("127.0.0.1", 0), 0);
        server.createContext("/", ex -> {
            lastMethod = ex.getRequestMethod();
            lastPath = ex.getRequestURI().getPath();
            lastQuery = ex.getRequestURI().getRawQuery();
            lastAuth = ex.getRequestHeaders().getFirst("Authorization");
            lastBody = new String(ex.getRequestBody().readAllBytes(), StandardCharsets.UTF_8);

            int code = 200;
            String json;
            if (lastPath.equals("/api/items/missing")) {
                code = 404;
                json = "{\"error\":{\"code\":\"NOT_FOUND\",\"message\":\"no such collection\"}}";
            } else if (lastMethod.equals("POST") && lastPath.equals("/api/t/myapp/auth/sign-in/email")) {
                json = "{\"user\":{\"id\":\"u1\",\"email\":\"a@b.c\"},\"token\":\"tok_123\"}";
            } else if (lastMethod.equals("DELETE")) {
                json = "{\"ok\":true}";
            } else if (lastMethod.equals("POST") || lastMethod.equals("PATCH")) {
                json = "{\"data\":{\"id\":\"x1\"}}";
            } else {
                json = "{\"data\":[],\"limit\":50,\"offset\":0}";
            }
            byte[] out = json.getBytes(StandardCharsets.UTF_8);
            ex.getResponseHeaders().set("Content-Type", "application/json");
            ex.sendResponseHeaders(code, out.length);
            ex.getResponseBody().write(out);
            ex.close();
        });
        server.start();
        base = "http://127.0.0.1:" + server.getAddress().getPort();
    }

    @AfterEach
    void tearDown() {
        server.stop(0);
    }

    private String filterParam() throws Exception {
        for (String pair : lastQuery.split("&")) {
            int i = pair.indexOf('=');
            if (i > 0 && pair.substring(0, i).equals("filter")) {
                return URLDecoder.decode(pair.substring(i + 1), StandardCharsets.UTF_8);
            }
        }
        return null;
    }

    @Test
    void queryStringFilterIsNotDoubleEncoded() throws Exception {
        BacklexClient client = BacklexClient.builder(base).apiKey("pak_x").build();
        client.from("orders", Object.class).query()
                .where(eq("status", "active"))
                .orderBy("-created_at")
                .limit(5)
                .list();

        assertEquals("GET", lastMethod);
        assertEquals("/api/items/orders", lastPath);
        // If double percent-encoded, readTree would throw.
        var filter = M.readTree(filterParam());
        assertEquals("active", filter.get("status").get("_eq").asText());
    }

    @Test
    void apiKeyBearerHeader() {
        BacklexClient client = BacklexClient.builder(base).apiKey("pak_secret").build();
        client.from("posts", Object.class).list();
        assertEquals("Bearer pak_secret", lastAuth);
    }

    @Test
    void crudMethodsPathsAndBody() throws Exception {
        BacklexClient client = BacklexClient.builder(base).apiKey("pak_x").build();
        Collection<Object> posts = client.from("posts", Object.class);

        posts.create(Map.of("title", "Hi"));
        assertEquals("POST", lastMethod);
        assertEquals("/api/items/posts", lastPath);
        assertEquals("Hi", M.readTree(lastBody).get("title").asText());

        posts.update("p1", Map.of("title", "Edit"));
        assertEquals("PATCH", lastMethod);
        assertEquals("/api/items/posts/p1", lastPath);

        Models.DeleteResult del = posts.delete("p1");
        assertEquals("DELETE", lastMethod);
        assertTrue(del.ok);
    }

    @Test
    void appModeTokenCaptureAndReplay() {
        BacklexClient client = BacklexClient.builder(base).workspace("myapp").build();

        Models.AuthResult res = client.auth.signIn("a@b.c", "pw");
        assertEquals("/api/t/myapp/auth/sign-in/email", lastPath);
        assertEquals("tok_123", res.token);
        assertEquals("tok_123", client.auth.token());

        client.from("posts", Object.class).list();
        assertEquals("Bearer tok_123", lastAuth);

        client.auth.signOut();
        assertNull(client.auth.token());
    }

    @Test
    void errorEnvelopeBecomesBacklexException() {
        BacklexClient client = BacklexClient.builder(base).apiKey("pak_x").build();
        BacklexException ex = assertThrows(BacklexException.class,
                () -> client.from("missing", Object.class).list());
        assertEquals(404, ex.status);
        assertEquals("NOT_FOUND", ex.code);
        assertEquals("no such collection", ex.getMessage());
    }

    @Test
    void controlPlaneAuthDoesNotCaptureToken() {
        BacklexClient client = BacklexClient.builder(base).build();
        client.auth.signIn("a@b.c", "pw");
        assertEquals("/api/auth/sign-in/email", lastPath);
        assertNull(client.auth.token());
    }
}
