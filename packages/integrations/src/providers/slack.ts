import { defineProvider } from "../provider";

export const slack = defineProvider({
  id: "slack",
  label: "Slack",
  category: "chat",
  capabilities: ["sink"],
  configFields: [
    { key: "webhookUrl", label: "Incoming webhook URL", placeholder: "https://hooks.slack.com/services/…", secret: true },
  ],
  async deliver(ctx) {
    const url = ctx.str("webhookUrl");
    // Pinned to the official webhook host so a stored config can't be used to
    // POST workspace events at an arbitrary URL.
    if (!url || !url.startsWith("https://hooks.slack.com/")) return null;
    return ctx.post(url, { text: `*${ctx.event.text}*` });
  },
});
