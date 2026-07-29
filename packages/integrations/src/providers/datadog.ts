import { defineProvider } from "../provider";

export const datadog = defineProvider({
  id: "datadog",
  label: "Datadog",
  category: "observability",
  capabilities: ["sink"],
  configFields: [
    { key: "apiKey", label: "API key", placeholder: "Datadog API key", secret: true },
    { key: "site", label: "Site (optional)", placeholder: "datadoghq.com" },
  ],
  async deliver(ctx) {
    const apiKey = ctx.str("apiKey");
    if (!apiKey) return null;
    const site = ctx.str("site") ?? "datadoghq.com";
    const { text, event } = ctx.event;
    return ctx.post(
      `https://api.${site}/api/v1/events`,
      { title: text, text, tags: [`event:${event}`] },
      { "DD-API-KEY": apiKey },
    );
  },
});
