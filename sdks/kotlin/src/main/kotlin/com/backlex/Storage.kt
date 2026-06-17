package com.backlex

import java.net.URLEncoder
import java.nio.charset.StandardCharsets

/** File operations against `/api/storage`. */
class Storage(private val client: BacklexClient) {
    private val tf = client.mapper.typeFactory
    private val mapType = tf.constructMapType(LinkedHashMap::class.java, String::class.java, Any::class.java)
    private val deleteType = tf.constructType(DeleteResult::class.java)

    private fun enc(s: String): String = URLEncoder.encode(s, StandardCharsets.UTF_8)

    /** List stored objects, optionally filtered by key prefix. */
    fun list(prefix: String? = null): List<FileRow> {
        var path = "/api/storage"
        if (!prefix.isNullOrEmpty()) path += "?prefix=${enc(prefix)}"
        val wrapType = tf.constructParametricType(
            ItemResponse::class.java,
            tf.constructCollectionType(List::class.java, FileRow::class.java),
        )
        val wrap: ItemResponse<List<FileRow>> = client.request("GET", path, null, wrapType)
        return wrap.data
    }

    /** Upload bytes under key. Pass contentType/folderId=null to omit them. */
    fun put(key: String, body: ByteArray, contentType: String? = null, folderId: String? = null): Map<String, Any?> {
        var path = "/api/storage/${enc(key)}"
        if (!folderId.isNullOrEmpty()) path += "?folderId=${enc(folderId)}"
        return client.sendRaw("PUT", path, body, contentType, mapType)
    }

    /** Fetch the raw bytes for key. */
    fun download(key: String): ByteArray = client.downloadRaw("/api/storage/${enc(key)}")

    /** Remove the object at key. */
    fun delete(key: String): DeleteResult =
        client.request("DELETE", "/api/storage/${enc(key)}", null, deleteType)
}
