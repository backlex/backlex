package com.backlex

import com.fasterxml.jackson.databind.JavaType

/**
 * A typed CRUD handle for one collection. Obtain via `client.from<T>(slug)`
 * (reified) or `client.from(slug, T::class.java)`.
 */
class Collection<T>(
    private val client: BacklexClient,
    private val slug: String,
    type: JavaType,
) {
    private val tf = client.mapper.typeFactory
    private val listType: JavaType = tf.constructParametricType(ListResponse::class.java, type)
    private val itemType: JavaType = tf.constructParametricType(ItemResponse::class.java, type)
    private val deleteType: JavaType = tf.constructType(DeleteResult::class.java)

    fun list(q: ListQuery? = null): ListResponse<T> =
        client.request("GET", "/api/items/$slug${client.buildSearch(q)}", null, listType)

    /** Fluent builder that compiles to a [ListQuery]. */
    fun query(): QueryBuilder<T> = QueryBuilder { list(it) }

    fun one(id: String): ItemResponse<T> =
        client.request("GET", "/api/items/$slug/$id", null, itemType)

    fun create(data: Any): ItemResponse<T> =
        client.request("POST", "/api/items/$slug", data, itemType)

    fun update(id: String, patch: Any): ItemResponse<T> =
        client.request("PATCH", "/api/items/$slug/$id", patch, itemType)

    fun delete(id: String): DeleteResult =
        client.request("DELETE", "/api/items/$slug/$id", null, deleteType)
}
