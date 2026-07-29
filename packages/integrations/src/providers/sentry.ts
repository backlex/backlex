import { defineProvider } from "../provider";

export const sentry = defineProvider({
  id: "sentry",
  label: "Sentry",
  category: "observability",
  capabilities: ["sink"],
  configFields: [{ key: "dsn", label: "DSN", placeholder: "https://<key>@<host>/<project>", secret: true }],
  async deliver(ctx) {
    const dsn = ctx.str("dsn");
    if (!dsn) return null;
    // A DSN packs the public key, host and project id into one URL; all three
    // are required to address the store endpoint.
    let publicKey = "";
    let host = "";
    let projectId = "";
    try {
      const u = new URL(dsn);
      publicKey = u.username;
      host = u.host;
      projectId = u.pathname.replace(/^\/+/, "");
    } catch {
      return null;
    }
    if (!publicKey || !host || !projectId) return null;
    const { text, event, payload } = ctx.event;
    return ctx.post(
      `https://${host}/api/${projectId}/store/`,
      { message: text, level: "info", platform: "other", tags: { event }, extra: payload },
      { "X-Sentry-Auth": `Sentry sentry_version=7, sentry_client=backlex/1, sentry_key=${publicKey}` },
    );
  },
});
