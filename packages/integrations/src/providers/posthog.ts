import { asHttpsBase, recordId } from "../lib";
import { defineProvider } from "../provider";

export const posthog = defineProvider({
  id: "posthog",
  label: "PostHog",
  category: "analytics",
  capabilities: ["sink"],
  configFields: [
    { key: "apiKey", label: "Project API key", placeholder: "phc_…", secret: true },
    { key: "host", label: "Host (optional)", placeholder: "https://us.i.posthog.com" },
  ],
  async deliver(ctx) {
    const apiKey = ctx.str("apiKey");
    if (!apiKey) return null;
    const configured = ctx.str("host");
    const host = configured ? asHttpsBase(configured) : "https://us.i.posthog.com";
    const { event, payload } = ctx.event;
    return ctx.post(`${host}/capture/`, {
      api_key: apiKey,
      event,
      distinct_id: recordId(payload, "backlex"),
      properties: { ...payload, $lib: "backlex" },
    });
  },
});
