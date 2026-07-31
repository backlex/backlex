import { defineProvider } from "../provider";

/**
 * Google Chat — post record events to a space.
 *
 * The incoming-webhook URL already carries its own key and token as query
 * parameters, which is why it is the secret here rather than a separate field.
 */
export const googleChat = defineProvider({
  id: "google-chat",
  label: "Google Chat",
  category: "chat",
  capabilities: ["sink"],
  configFields: [
    {
      key: "webhookUrl",
      label: "Incoming webhook URL",
      placeholder: "https://chat.googleapis.com/v1/spaces/…?key=…&token=…",
      secret: true,
    },
  ],
  async deliver(ctx) {
    const webhookUrl = ctx.str("webhookUrl");
    if (!webhookUrl) return null;
    // Refused rather than sent: the URL is admin-supplied and the credential is
    // in it, so posting to a host that is not Google's would hand it over.
    let host: string;
    try {
      host = new URL(webhookUrl).hostname;
    } catch {
      return null;
    }
    if (host !== "chat.googleapis.com") return null;
    return ctx.post(webhookUrl, { text: ctx.event.text });
  },
});
