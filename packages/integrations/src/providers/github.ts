import { defineProvider } from "../provider";

export const github = defineProvider({
  id: "github",
  label: "GitHub",
  category: "issue-tracking",
  capabilities: ["sink"],
  configFields: [
    { key: "token", label: "Access token (repo scope)", placeholder: "ghp_…", secret: true },
    { key: "repo", label: "Repository", placeholder: "owner/name" },
  ],
  async deliver(ctx) {
    const token = ctx.str("token");
    const repo = ctx.str("repo"); // "owner/name"
    if (!token || !repo) return null;
    return ctx.post(
      `https://api.github.com/repos/${repo}/dispatches`,
      { event_type: `backlex.${ctx.event.event}`, client_payload: ctx.event.payload },
      { Authorization: `Bearer ${token}`, Accept: "application/vnd.github+json", "User-Agent": "backlex" },
    );
  },
});
