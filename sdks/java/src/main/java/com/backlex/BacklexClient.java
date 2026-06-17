package com.backlex;

import com.fasterxml.jackson.annotation.JsonAutoDetect;
import com.fasterxml.jackson.annotation.JsonInclude;
import com.fasterxml.jackson.annotation.PropertyAccessor;
import com.fasterxml.jackson.databind.DeserializationFeature;
import com.fasterxml.jackson.databind.JavaType;
import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import java.io.BufferedReader;
import java.io.InputStream;
import java.io.InputStreamReader;
import java.net.URI;
import java.net.URLEncoder;
import java.net.http.HttpClient;
import java.net.http.HttpRequest;
import java.net.http.HttpResponse;
import java.nio.charset.StandardCharsets;
import java.util.ArrayList;
import java.util.List;
import java.util.function.Consumer;

/**
 * The official Java client for the backlex API — a thin, typed wrapper over the
 * same REST + SSE surface the TypeScript SDK (@backlex/client) speaks. Build with
 * {@link #builder(String)}. Three auth modes: server key, workspace app mode
 * (token capture), or cookie session. Calls are synchronous and throw the
 * unchecked {@link BacklexException} on failure.
 */
public final class BacklexClient {

    static final ObjectMapper MAPPER = new ObjectMapper()
            .configure(DeserializationFeature.FAIL_ON_UNKNOWN_PROPERTIES, false)
            .setVisibility(PropertyAccessor.FIELD, JsonAutoDetect.Visibility.ANY)
            .setVisibility(PropertyAccessor.GETTER, JsonAutoDetect.Visibility.NONE)
            .setVisibility(PropertyAccessor.IS_GETTER, JsonAutoDetect.Visibility.NONE)
            .setSerializationInclusion(JsonInclude.Include.NON_NULL);

    final String url;
    final String apiKey;
    final String workspace;
    final String tenant;
    volatile String appToken;
    final HttpClient http;

    public final Auth auth;
    public final Storage storage;

    private BacklexClient(Builder b) {
        this.url = b.url.endsWith("/") ? b.url.substring(0, b.url.length() - 1) : b.url;
        this.apiKey = b.apiKey;
        this.workspace = b.workspace;
        this.tenant = b.tenant;
        this.appToken = b.token;
        // A cookie manager keeps same-origin cookie sessions working across calls.
        this.http = b.http != null
                ? b.http
                : HttpClient.newBuilder()
                    .cookieHandler(new java.net.CookieManager())
                    .followRedirects(HttpClient.Redirect.NORMAL)
                    .build();
        this.auth = new Auth(this);
        this.storage = new Storage(this);
    }

    public static Builder builder(String baseUrl) {
        return new Builder(baseUrl);
    }

    /** Fluent options for {@link BacklexClient}. */
    public static final class Builder {
        private final String url;
        private String apiKey;
        private String workspace;
        private String token;
        private String tenant;
        private HttpClient http;

        private Builder(String url) {
            this.url = url;
        }

        /** Static server key (pak_...) sent as a bearer on every call. */
        public Builder apiKey(String key) { this.apiKey = key; return this; }

        /** Workspace slug — puts the client in app mode (auth + token capture). */
        public Builder workspace(String slug) { this.workspace = slug; return this; }

        /** Restore a previously-saved workspace session token (app mode). */
        public Builder token(String token) { this.token = token; return this; }

        /** Scope every request to a tenant/workspace (slug or id) via the
         *  X-Backlex-Tenant header — for anonymous public reads or a pak_ key
         *  addressing a tenant other than its home one. */
        public Builder tenant(String tenant) { this.tenant = tenant; return this; }

        /** Custom HttpClient (timeouts, proxies, testing). */
        public Builder httpClient(HttpClient http) { this.http = http; return this; }

        public BacklexClient build() {
            return new BacklexClient(this);
        }
    }

    void applyAuth(HttpRequest.Builder rb) {
        if (apiKey != null && !apiKey.isEmpty()) {
            rb.header("Authorization", "Bearer " + apiKey);
        } else if (appToken != null && !appToken.isEmpty()) {
            rb.header("Authorization", "Bearer " + appToken);
        }
        if (tenant != null && !tenant.isEmpty()) {
            rb.header("X-Backlex-Tenant", tenant);
        }
    }

    /** Typed CRUD handle for a collection. */
    public <T> Collection<T> from(String slug, Class<T> type) {
        return new Collection<>(this, slug, type);
    }

    /** Raw escape hatch — issues a request with auth headers applied. */
    @SuppressWarnings("unchecked")
    <R> R request(String method, String path, Object body, JavaType type) {
        String payload = null;
        if (body != null) {
            try {
                payload = MAPPER.writeValueAsString(body);
            } catch (Exception e) {
                throw new BacklexException(0, "ENCODE", e.getMessage(), null);
            }
        }
        HttpRequest.Builder rb = HttpRequest.newBuilder(URI.create(url + path))
                .method(method, payload == null
                        ? HttpRequest.BodyPublishers.noBody()
                        : HttpRequest.BodyPublishers.ofString(payload, StandardCharsets.UTF_8))
                .header("Content-Type", "application/json");
        applyAuth(rb);

        HttpResponse<String> resp;
        try {
            resp = http.send(rb.build(), HttpResponse.BodyHandlers.ofString());
        } catch (Exception e) {
            throw new BacklexException(0, "NETWORK", e.getMessage(), null);
        }

        int sc = resp.statusCode();
        if (sc < 200 || sc >= 300) {
            throw makeError(sc, resp.body());
        }
        String text = resp.body();
        if (sc == 204 || text == null || text.isEmpty() || type == null) {
            return null;
        }
        try {
            return (R) MAPPER.readValue(text, type);
        } catch (Exception e) {
            throw new BacklexException(sc, "PARSE", e.getMessage(), null);
        }
    }

    BacklexException makeError(int status, String body) {
        String code = "UNKNOWN";
        String message = "HTTP " + status;
        Object details = null;
        if (body != null && !body.isEmpty()) {
            try {
                JsonNode root = MAPPER.readTree(body);
                JsonNode err = root.get("error");
                if (err != null && err.isObject()) {
                    if (err.hasNonNull("code")) code = err.get("code").asText();
                    if (err.hasNonNull("message")) message = err.get("message").asText();
                    if (err.has("details")) details = MAPPER.convertValue(err.get("details"), Object.class);
                }
            } catch (Exception ignored) {
                // Non-JSON error body — keep the generic message.
            }
        }
        return new BacklexException(status, code, message, details);
    }

    /**
     * Serialize a ListQuery into a URL query string (mirrors buildSearch in
     * index.ts). The filter is compact JSON, percent-encoded exactly once.
     */
    static String buildSearch(ListQuery q) {
        if (q == null) {
            return "";
        }
        List<String> parts = new ArrayList<>();
        if (q.filter != null && !q.filter.isEmpty()) {
            try {
                parts.add("filter=" + enc(MAPPER.writeValueAsString(q.filter)));
            } catch (Exception e) {
                throw new BacklexException(0, "ENCODE", e.getMessage(), null);
            }
        }
        if (!q.sort.isEmpty()) {
            parts.add("sort=" + enc(String.join(",", q.sort)));
        }
        if (!q.fields.isEmpty()) {
            parts.add("fields=" + enc(String.join(",", q.fields)));
        }
        if (q.limit != null) {
            parts.add("limit=" + q.limit);
        }
        if (q.offset != null) {
            parts.add("offset=" + q.offset);
        }
        if (q.meta != null && !q.meta.isEmpty()) {
            parts.add("meta=" + enc(q.meta));
        }
        return parts.isEmpty() ? "" : "?" + String.join("&", parts);
    }

    private static String enc(String s) {
        return URLEncoder.encode(s, StandardCharsets.UTF_8);
    }

    // -- Realtime (SSE) ------------------------------------------------------

    /**
     * Subscribe to a realtime channel (e.g. "items:posts"). Returns a
     * {@link Subscription}; {@link Subscription#close()} unsubscribes. The reader
     * runs on a daemon thread and auto-reconnects on a dropped stream (3s
     * back-off), replaying via Last-Event-ID. {@code onError} may be null.
     */
    public <T> Subscription subscribe(
            String channel,
            Class<T> type,
            Consumer<ItemEvent<T>> onEvent,
            Consumer<Throwable> onError) {
        Subscription sub = new Subscription();
        JavaType evType = MAPPER.getTypeFactory().constructParametricType(ItemEvent.class, type);
        String surl = url + "/api/realtime/" + channel + "/subscribe";
        Thread t = new Thread(() -> runSse(surl, sub, evType, onEvent, onError), "backlex-sse:" + channel);
        t.setDaemon(true);
        sub.attachThread(t);
        t.start();
        return sub;
    }

    private <T> void runSse(
            String surl,
            Subscription sub,
            JavaType evType,
            Consumer<ItemEvent<T>> onEvent,
            Consumer<Throwable> onError) {
        String lastId = null;
        while (!sub.isStopped()) {
            try {
                HttpRequest.Builder rb = HttpRequest.newBuilder(URI.create(surl))
                        .GET()
                        .header("Accept", "text/event-stream");
                applyAuth(rb);
                if (lastId != null) {
                    rb.header("Last-Event-ID", lastId);
                }
                HttpResponse<InputStream> resp = http.send(rb.build(), HttpResponse.BodyHandlers.ofInputStream());
                if (resp.statusCode() != 200) {
                    if (onError != null) {
                        onError.accept(new BacklexException(resp.statusCode(), "UNKNOWN", "HTTP " + resp.statusCode(), null));
                    }
                } else {
                    sub.setStream(resp.body());
                    lastId = readSse(resp.body(), sub, evType, onEvent, onError, lastId);
                }
            } catch (Exception e) {
                if (!sub.isStopped() && onError != null) {
                    onError.accept(e);
                }
            }
            if (sub.isStopped()) {
                return;
            }
            try {
                Thread.sleep(3000);
            } catch (InterruptedException e) {
                return;
            }
        }
    }

    @SuppressWarnings("unchecked")
    private <T> String readSse(
            InputStream in,
            Subscription sub,
            JavaType evType,
            Consumer<ItemEvent<T>> onEvent,
            Consumer<Throwable> onError,
            String lastId) throws Exception {
        BufferedReader br = new BufferedReader(new InputStreamReader(in, StandardCharsets.UTF_8));
        List<String> data = new ArrayList<>();
        String line;
        while (!sub.isStopped() && (line = br.readLine()) != null) {
            if (line.isEmpty()) {
                if (!data.isEmpty()) {
                    String payload = String.join("\n", data);
                    data.clear();
                    try {
                        ItemEvent<T> ev = (ItemEvent<T>) MAPPER.readValue(payload, evType);
                        if (ev != null) {
                            onEvent.accept(ev);
                        }
                    } catch (Exception ex) {
                        if (onError != null) {
                            onError.accept(ex);
                        }
                    }
                }
            } else if (line.charAt(0) == ':') {
                // Comment / heartbeat frame.
            } else if (line.startsWith("id:")) {
                lastId = line.substring(3).trim();
            } else if (line.startsWith("data:")) {
                String d = line.substring(5);
                if (d.startsWith(" ")) {
                    d = d.substring(1);
                }
                data.add(d);
            }
        }
        return lastId;
    }
}
