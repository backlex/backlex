import { defineProvider } from "../provider";

export const telegram = defineProvider({
  id: "telegram",
  label: "Telegram",
  category: "chat",
  capabilities: ["sink"],
  configFields: [
    { key: "botToken", label: "Bot token", placeholder: "123456:ABC-DEF…", secret: true },
    { key: "chatId", label: "Chat ID", placeholder: "-1001234567890" },
  ],
  async deliver(ctx) {
    const token = ctx.str("botToken");
    const chatId = ctx.str("chatId");
    if (!token || !chatId) return null;
    return ctx.post(`https://api.telegram.org/bot${token}/sendMessage`, { chat_id: chatId, text: ctx.event.text });
  },
});
