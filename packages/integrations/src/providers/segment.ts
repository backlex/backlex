import { b64, recordId } from "../lib";
import { defineProvider } from "../provider";

export const segment = defineProvider({
  id: "segment",
  label: "Segment",
  category: "analytics",
  capabilities: ["sink"],
  configFields: [{ key: "writeKey", label: "Write key", placeholder: "Segment source write key", secret: true }],
  async deliver(ctx) {
    const writeKey = ctx.str("writeKey");
    if (!writeKey) return null;
    // Segment authenticates with HTTP Basic using the write key as the
    // username and an empty password.
    const auth = b64(`${writeKey}:`);
    if (!auth) return null;
    const { event, payload } = ctx.event;
    return ctx.post(
      "https://api.segment.io/v1/track",
      { event, userId: recordId(payload, "backlex"), properties: payload },
      { Authorization: `Basic ${auth}` },
    );
  },
});
