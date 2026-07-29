import { asHttpsBase, b64 } from "../lib";
import { defineProvider } from "../provider";

export const jira = defineProvider({
  id: "jira",
  label: "Jira",
  category: "issue-tracking",
  capabilities: ["sink"],
  configFields: [
    { key: "baseUrl", label: "Base URL", placeholder: "https://your-org.atlassian.net" },
    { key: "email", label: "Account email", placeholder: "you@example.com" },
    { key: "apiToken", label: "API token", placeholder: "Atlassian API token", secret: true },
    { key: "projectKey", label: "Project key", placeholder: "ENG" },
  ],
  async deliver(ctx) {
    const baseUrl = ctx.str("baseUrl");
    const email = ctx.str("email");
    const apiToken = ctx.str("apiToken");
    const projectKey = ctx.str("projectKey");
    if (!baseUrl || !email || !apiToken || !projectKey) return null;
    const auth = b64(`${email}:${apiToken}`);
    if (!auth) return null;
    const { text } = ctx.event;
    return ctx.post(
      `${asHttpsBase(baseUrl)}/rest/api/3/issue`,
      {
        fields: {
          project: { key: projectKey },
          summary: text,
          issuetype: { name: "Task" },
          description: {
            type: "doc",
            version: 1,
            content: [{ type: "paragraph", content: [{ type: "text", text }] }],
          },
        },
      },
      { Authorization: `Basic ${auth}` },
    );
  },
});
