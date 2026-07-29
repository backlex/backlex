import { recordId } from "../lib";
import { defineProvider } from "../provider";

export const algolia = defineProvider({
  id: "algolia",
  label: "Algolia",
  category: "search",
  capabilities: ["sink"],
  configFields: [
    { key: "appId", label: "Application ID", placeholder: "Algolia app ID" },
    { key: "apiKey", label: "Admin API key", placeholder: "Write-enabled key", secret: true },
    { key: "indexName", label: "Index name", placeholder: "items" },
  ],
  async deliver(ctx) {
    const appId = ctx.str("appId");
    const apiKey = ctx.str("apiKey");
    const indexName = ctx.str("indexName");
    if (!appId || !apiKey || !indexName) return null;
    const { event, payload } = ctx.event;
    return ctx.post(
      `https://${appId}.algolia.net/1/indexes/${encodeURIComponent(indexName)}`,
      { ...payload, objectID: recordId(payload, event) },
      { "X-Algolia-Application-Id": appId, "X-Algolia-API-Key": apiKey },
    );
  },
});
