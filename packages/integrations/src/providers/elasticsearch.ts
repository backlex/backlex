import { asHttpsBase, recordId } from "../lib";
import { defineProvider } from "../provider";

/**
 * Elasticsearch / OpenSearch document sink.
 *
 * Uses `POST /<index>/_update/<id>` with `doc_as_upsert` rather than
 * `PUT /<index>/_doc/<id>`: the update API is a real POST endpoint (so it fits
 * the shared JSON `post` helper), and `doc_as_upsert` makes create and update
 * events converge on one call — the document is inserted when the id is new and
 * merged otherwise. Both the path and the auth header are identical on
 * OpenSearch, which forked from Elasticsearch 7.x, so one adapter covers both.
 */
export const elasticsearch = defineProvider({
  id: "elasticsearch",
  label: "Elasticsearch / OpenSearch",
  category: "search",
  capabilities: ["sink"],
  configFields: [
    { key: "host", label: "Host", placeholder: "https://es.example.com:9200" },
    { key: "apiKey", label: "API key", placeholder: "Encoded key (ApiKey auth)", secret: true },
    { key: "indexName", label: "Index name", placeholder: "items" },
  ],
  async deliver(ctx) {
    const host = ctx.str("host");
    const apiKey = ctx.str("apiKey");
    const indexName = ctx.str("indexName");
    if (!host || !apiKey || !indexName) return null;
    const { event, payload } = ctx.event;
    const id = recordId(payload, event);
    return ctx.post(
      `${asHttpsBase(host)}/${encodeURIComponent(indexName)}/_update/${encodeURIComponent(id)}`,
      { doc: payload, doc_as_upsert: true },
      { Authorization: `ApiKey ${apiKey}` },
    );
  },
});
