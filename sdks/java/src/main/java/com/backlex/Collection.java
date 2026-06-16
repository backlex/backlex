package com.backlex;

import com.fasterxml.jackson.databind.JavaType;
import com.fasterxml.jackson.databind.type.TypeFactory;

/**
 * A typed CRUD handle for one collection. Obtain via
 * {@code client.from(slug, Type.class)}. Use {@code Object.class} (or a Map type)
 * for schema-blind access, or a generated/POJO type.
 */
public final class Collection<T> {

    private final BacklexClient client;
    private final String slug;
    private final JavaType listType;
    private final JavaType itemType;

    Collection(BacklexClient client, String slug, Class<T> type) {
        this.client = client;
        this.slug = slug;
        TypeFactory tf = BacklexClient.MAPPER.getTypeFactory();
        this.listType = tf.constructParametricType(ListResponse.class, type);
        this.itemType = tf.constructParametricType(ItemResponse.class, type);
    }

    public ListResponse<T> list() {
        return list(null);
    }

    public ListResponse<T> list(ListQuery q) {
        return client.request("GET", "/api/items/" + slug + BacklexClient.buildSearch(q), null, listType);
    }

    /** Fluent builder that compiles to a {@link ListQuery}. */
    public QueryBuilder<T> query() {
        return new QueryBuilder<>(this::list);
    }

    public ItemResponse<T> one(String id) {
        return client.request("GET", "/api/items/" + slug + "/" + id, null, itemType);
    }

    public ItemResponse<T> create(Object data) {
        return client.request("POST", "/api/items/" + slug, data, itemType);
    }

    public ItemResponse<T> update(String id, Object patch) {
        return client.request("PATCH", "/api/items/" + slug + "/" + id, patch, itemType);
    }

    public Models.DeleteResult delete(String id) {
        return client.request("DELETE", "/api/items/" + slug + "/" + id, null,
                BacklexClient.MAPPER.getTypeFactory().constructType(Models.DeleteResult.class));
    }
}
