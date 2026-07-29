import { defineProvider } from "../provider";

export const opsgenie = defineProvider({
  id: "opsgenie",
  label: "Opsgenie",
  category: "observability",
  capabilities: ["sink"],
  configFields: [
    { key: "apiKey", label: "API key", placeholder: "Opsgenie API integration key", secret: true },
    { key: "region", label: "Region (optional)", placeholder: "us or eu" },
  ],
  async deliver(ctx) {
    const apiKey = ctx.str("apiKey");
    if (!apiKey) return null;
    const region = ctx.str("region")?.trim().toLowerCase() === "eu" ? "api.eu." : "api.";
    const { event } = ctx.event;
    return ctx.post(
      `https://${region}opsgenie.com/v2/alerts`,
      { message: ctx.event.text, tags: [`event:${event}`], details: { event } },
      { Authorization: `GenieKey ${apiKey}` },
    );
  },
});
