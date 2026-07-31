import { recordId } from "../lib";
import { defineProvider } from "../provider";

/**
 * Amplitude — one event per record change.
 *
 * Amplitude rejects an event that has neither `user_id` nor `device_id`, and it
 * requires `user_id` to be at least five characters. The record id fills both
 * roles; short ids go in as `device_id`, which has no length rule, rather than
 * being silently dropped by the API.
 */
export const amplitude = defineProvider({
  id: "amplitude",
  label: "Amplitude",
  category: "analytics",
  capabilities: ["sink"],
  configFields: [
    { key: "apiKey", label: "API key", placeholder: "from Project Settings", secret: true },
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
    const apiKey = ctx.str("apiKey");
    if (!apiKey) return null;
    const host = ctx.str("region") === "eu" ? "https://api.eu.amplitude.com" : "https://api2.amplitude.com";
    const { event, payload } = ctx.event;
    const id = recordId(payload, "backlex");
    return ctx.post(`${host}/2/httpapi`, {
      api_key: apiKey,
      events: [
        {
          event_type: event,
          ...(id.length >= 5 ? { user_id: id } : { device_id: id }),
          event_properties: payload,
        },
      ],
    });
  },
});
