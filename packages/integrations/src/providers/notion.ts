import { OAUTH_ACCESS_TOKEN_KEY, defineProvider } from "../provider";

/**
 * Notion — the first OAuth-connected provider.
 *
 * The sink appends a paragraph block to a page the admin nominates, rather than
 * creating a row in a database. Creating a database row means knowing that
 * database's property schema (which property is the title, what types the rest
 * are), and getting it wrong fails the write with a validation error the
 * operator cannot act on. Appending a block works against any page the
 * integration was granted, with no schema coupling at all.
 */
export const notion = defineProvider({
  id: "notion",
  label: "Notion",
  category: "productivity",
  capabilities: ["sink"],
  configFields: [
    { key: "clientId", label: "OAuth client ID", placeholder: "from your Notion integration" },
    { key: "clientSecret", label: "OAuth client secret", placeholder: "secret_…", secret: true },
    { key: "pageId", label: "Target page ID", placeholder: "32-char id from the page URL" },
  ],
  oauth: {
    authorizeUrl: "https://api.notion.com/v1/oauth/authorize",
    tokenUrl: "https://api.notion.com/v1/oauth/token",
    // Notion has no scope parameter — access is chosen by the user in the
    // consent screen's page picker, so an empty list is correct here.
    scopes: [],
    authorizeParams: { owner: "user" },
    // Notion returns 401 with no detail when the credentials are in the body.
    tokenAuth: "basic",
    // Notion tokens do not expire and no refresh token is issued; without this
    // the refresh path would read a missing token as a broken connection.
    nonExpiring: true,
    keepFromTokenResponse: ["workspace_name", "workspace_id"],
  },
  async deliver(ctx) {
    const token = ctx.str(OAUTH_ACCESS_TOKEN_KEY);
    const pageId = ctx.str("pageId");
    if (!token || !pageId) return null;
    const { event, text } = ctx.event;
    const r = await ctx.fetch(`https://api.notion.com/v1/blocks/${encodeURIComponent(pageId)}/children`, {
      method: "PATCH",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${token}`,
        // Required on every request; Notion rejects calls without it.
        "Notion-Version": "2022-06-28",
      },
      body: JSON.stringify({
        children: [
          {
            object: "block",
            type: "paragraph",
            paragraph: {
              rich_text: [{ type: "text", text: { content: `${text} (${event})`.slice(0, 2000) } }],
            },
          },
        ],
      }),
    });
    return { ok: r.ok, status: r.status };
  },
});
