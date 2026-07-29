import { defineProvider } from "../provider";

export const discord = defineProvider({
  id: "discord",
  label: "Discord",
  category: "chat",
  capabilities: ["sink"],
  configFields: [
    { key: "webhookUrl", label: "Webhook URL", placeholder: "https://discord.com/api/webhooks/…", secret: true },
  ],
  async deliver(ctx) {
    const url = ctx.str("webhookUrl");
    if (!url || !/^https:\/\/discord(app)?\.com\/api\/webhooks\//.test(url)) return null;
    return ctx.post(url, { content: ctx.event.text });
  },
});
