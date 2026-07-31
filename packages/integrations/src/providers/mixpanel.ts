import { recordId } from "../lib";
import { defineProvider } from "../provider";

/**
 * Mixpanel — the same shape as the PostHog sink: one tracked event per record
 * change, keyed by the record id.
 *
 * `distinct_id` is the RECORD, not a person. That is the convention the other
 * analytics sinks here already follow, and it is the honest one: a record event
 * says a row changed, and backlex does not know which human caused it.
 */
export const mixpanel = defineProvider({
  id: "mixpanel",
  label: "Mixpanel",
  category: "analytics",
  capabilities: ["sink"],
  configFields: [
    { key: "projectToken", label: "Project token", placeholder: "from Project Settings", secret: true },
    {
      key: "region",
      label: "Data residency",
      options: [
        { value: "us", label: "United States" },
        { value: "eu", label: "European Union" },
      ],
    },
  ],
  async deliver(ctx) {
    const token = ctx.str("projectToken");
    if (!token) return null;
    // Sending EU data to the US endpoint is a compliance problem, not a
    // latency one, so the region is a required choice rather than a default.
    const host = ctx.str("region") === "eu" ? "https://api-eu.mixpanel.com" : "https://api.mixpanel.com";
    const { event, payload } = ctx.event;
    return ctx.post(`${host}/track`, [
      {
        event,
        properties: { token, distinct_id: recordId(payload, "backlex"), ...payload, $source: "backlex" },
      },
    ]);
  },
});
