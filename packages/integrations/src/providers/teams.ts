import { defineProvider } from "../provider";

export const teams = defineProvider({
  id: "teams",
  label: "Microsoft Teams",
  category: "chat",
  capabilities: ["sink"],
  configFields: [
    { key: "webhookUrl", label: "Incoming webhook URL", placeholder: "https://…webhook.office.com/…", secret: true },
  ],
  async deliver(ctx) {
    const url = ctx.str("webhookUrl");
    if (!url || !url.startsWith("https://")) return null;
    return ctx.post(url, { text: ctx.event.text });
  },
});
