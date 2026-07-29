import { asHttpsBase, recordId } from "../lib";
import { defineProvider } from "../provider";

export const meilisearch = defineProvider({
  id: "meilisearch",
  label: "Meilisearch",
  category: "search",
  capabilities: ["sink"],
  configFields: [
    { key: "host", label: "Host", placeholder: "https://ms.example.com" },
    { key: "apiKey", label: "API key", placeholder: "Master or write key", secret: true },
    { key: "indexName", label: "Index name", placeholder: "items" },
  ],
  async deliver(ctx) {
    const host = ctx.str("host");
    const apiKey = ctx.str("apiKey");
    const indexName = ctx.str("indexName");
    if (!host || !apiKey || !indexName) return null;
    const { event, payload } = ctx.event;
    return ctx.post(
      `${asHttpsBase(host)}/indexes/${encodeURIComponent(indexName)}/documents`,
      [{ ...payload, id: recordId(payload, event) }],
      { Authorization: `Bearer ${apiKey}` },
    );
  },
});
