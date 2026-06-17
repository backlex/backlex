package com.backlex;

import com.fasterxml.jackson.databind.JavaType;
import java.net.URI;
import java.net.URLEncoder;
import java.net.http.HttpRequest;
import java.net.http.HttpResponse;
import java.nio.charset.StandardCharsets;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;

/** File operations against /api/storage. */
public final class Storage {

    private final BacklexClient client;

    Storage(BacklexClient client) {
        this.client = client;
    }

    private static String enc(String s) {
        return URLEncoder.encode(s, StandardCharsets.UTF_8);
    }

    /** List stored objects, optionally filtered by key prefix (null for all). */
    public List<Models.FileRow> list(String prefix) {
        String path = "/api/storage";
        if (prefix != null && !prefix.isEmpty()) {
            path += "?prefix=" + enc(prefix);
        }
        JavaType wrapType = BacklexClient.MAPPER.getTypeFactory()
                .constructParametricType(ItemResponse.class,
                        BacklexClient.MAPPER.getTypeFactory().constructCollectionType(List.class, Models.FileRow.class));
        ItemResponse<List<Models.FileRow>> wrap = client.request("GET", path, null, wrapType);
        return wrap != null && wrap.data != null ? wrap.data : new ArrayList<>();
    }

    /** Upload bytes under key. Pass contentType/folderId=null to omit them. */
    public Map<String, Object> put(String key, byte[] body, String contentType, String folderId) {
        String url = client.url + "/api/storage/" + enc(key);
        if (folderId != null && !folderId.isEmpty()) {
            url += "?folderId=" + enc(folderId);
        }
        HttpRequest.Builder rb = HttpRequest.newBuilder(URI.create(url))
                .PUT(HttpRequest.BodyPublishers.ofByteArray(body));
        if (contentType != null && !contentType.isEmpty()) {
            rb.header("Content-Type", contentType);
        }
        client.applyAuth(rb);
        try {
            HttpResponse<String> resp = client.http.send(rb.build(), HttpResponse.BodyHandlers.ofString());
            if (resp.statusCode() < 200 || resp.statusCode() >= 300) {
                throw client.makeError(resp.statusCode(), resp.body());
            }
            String text = resp.body();
            if (text == null || text.isEmpty()) {
                return new LinkedHashMap<>();
            }
            return BacklexClient.MAPPER.readValue(text,
                    BacklexClient.MAPPER.getTypeFactory().constructMapType(LinkedHashMap.class, String.class, Object.class));
        } catch (BacklexException e) {
            throw e;
        } catch (Exception e) {
            throw new BacklexException(0, "NETWORK", e.getMessage(), null);
        }
    }

    /** Fetch the raw bytes for key. */
    public byte[] download(String key) {
        HttpRequest.Builder rb = HttpRequest.newBuilder(URI.create(client.url + "/api/storage/" + enc(key))).GET();
        client.applyAuth(rb);
        try {
            HttpResponse<byte[]> resp = client.http.send(rb.build(), HttpResponse.BodyHandlers.ofByteArray());
            if (resp.statusCode() < 200 || resp.statusCode() >= 300) {
                throw new BacklexException(resp.statusCode(), "UNKNOWN", "HTTP " + resp.statusCode(), null);
            }
            return resp.body();
        } catch (BacklexException e) {
            throw e;
        } catch (Exception e) {
            throw new BacklexException(0, "NETWORK", e.getMessage(), null);
        }
    }

    /** Remove the object at key. */
    public Models.DeleteResult delete(String key) {
        return client.request("DELETE", "/api/storage/" + enc(key), null,
                BacklexClient.MAPPER.getTypeFactory().constructType(Models.DeleteResult.class));
    }
}
