import { asHttpsBase, recordId } from "../lib";
import { defineProvider } from "../provider";

/**
 * Typesense document sink.
 *
 * `POST /collections/<name>/documents?action=upsert` is the single-document
 * upsert: it creates the document when `id` is new and replaces it otherwise,
 * which is what a record event needs (create and update deliver the same way).
 * Typesense reserves `id` as the document key and requires it to be a string,
 * so `recordId` supplies it exactly like the Algolia/Meilisearch sinks do.
 */
export const typesense = defineProvider({
  id: "typesense",
  label: "Typesense",
  category: "search",
  capabilities: ["sink"],
  configFields: [
    { key: "host", label: "Host", placeholder: "https://xxx.a1.typesense.net" },
    { key: "apiKey", label: "API key", placeholder: "Admin or write-scoped key", secret: true },
    { key: "collectionName", label: "Collection name", placeholder: "items" },
  ],
  async deliver(ctx) {
    const host = ctx.str("host");
    const apiKey = ctx.str("apiKey");
    const collectionName = ctx.str("collectionName");
    if (!host || !apiKey || !collectionName) return null;
    const { event, payload } = ctx.event;
    return ctx.post(
      `${asHttpsBase(host)}/collections/${encodeURIComponent(collectionName)}/documents?action=upsert`,
      { ...payload, id: recordId(payload, event) },
      { "X-TYPESENSE-API-KEY": apiKey },
    );
  },
});
