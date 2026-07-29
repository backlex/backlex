import { defineProvider } from "../provider";

export const linear = defineProvider({
  id: "linear",
  label: "Linear",
  category: "issue-tracking",
  capabilities: ["sink"],
  configFields: [
    { key: "apiKey", label: "API key", placeholder: "lin_api_…", secret: true },
    { key: "teamId", label: "Team ID", placeholder: "UUID of the team" },
  ],
  async deliver(ctx) {
    const apiKey = ctx.str("apiKey");
    const teamId = ctx.str("teamId");
    if (!apiKey || !teamId) return null;
    const { event, text, payload } = ctx.event;
    const description = `Event \`${event}\`\n\n\`\`\`json\n${JSON.stringify(payload, null, 2)}\n\`\`\``;
    return ctx.post(
      "https://api.linear.app/graphql",
      {
        query: "mutation($input: IssueCreateInput!){ issueCreate(input: $input){ success } }",
        variables: { input: { teamId, title: text, description } },
      },
      { Authorization: apiKey },
    );
  },
});
