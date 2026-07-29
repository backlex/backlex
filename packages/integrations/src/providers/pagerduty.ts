import { defineProvider } from "../provider";

export const pagerduty = defineProvider({
  id: "pagerduty",
  label: "PagerDuty",
  category: "observability",
  capabilities: ["sink"],
  configFields: [
    { key: "routingKey", label: "Integration routing key", placeholder: "Events API v2 key", secret: true },
  ],
  async deliver(ctx) {
    const routingKey = ctx.str("routingKey");
    if (!routingKey) return null;
    return ctx.post("https://events.pagerduty.com/v2/enqueue", {
      routing_key: routingKey,
      event_action: "trigger",
      payload: {
        summary: ctx.event.text,
        source: "backlex",
        severity: "info",
        custom_details: ctx.event.payload,
      },
    });
  },
});
