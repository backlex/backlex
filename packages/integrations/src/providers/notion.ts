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
/** Notion's page cap for a database query. */
const PAGE = 100;

/**
 * Notion returns every property as a tagged object rather than a value, so a
 * pull has to flatten before anything downstream can store it.
 *
 * Unknown types collapse to `null` rather than to the raw object: writing a
 * nested structure into a text column produces `[object Object]`, which looks
 * like data and is not. A dropped value is visibly missing.
 */
const flattenProperty = (prop: unknown): unknown => {
  if (!prop || typeof prop !== "object") return null;
  const p = prop as Record<string, any>;
  switch (p.type) {
    case "title":
    case "rich_text":
      return (p[p.type] as { plain_text?: string }[] | undefined)?.map((t) => t.plain_text ?? "").join("") ?? "";
    case "number":
      return typeof p.number === "number" ? p.number : null;
    case "checkbox":
      return Boolean(p.checkbox);
    case "select":
      return p.select?.name ?? null;
    case "status":
      return p.status?.name ?? null;
    case "multi_select":
      return (p.multi_select as { name?: string }[] | undefined)?.map((o) => o.name ?? "").join(", ") ?? "";
    case "date":
      return p.date?.start ?? null;
    case "url":
    case "email":
    case "phone_number":
      return typeof p[p.type] === "string" ? p[p.type] : null;
    case "created_time":
    case "last_edited_time":
      return typeof p[p.type] === "string" ? p[p.type] : null;
    case "people":
      return (p.people as { name?: string }[] | undefined)?.map((u) => u.name ?? "").join(", ") ?? "";
    case "formula":
      return flattenProperty(p.formula);
    default:
      return null;
  }
};

export const notion = defineProvider({
  id: "notion",
  label: "Notion",
  category: "productivity",
  capabilities: ["sink", "source"],
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
  source: {
    settingFields: [
      { key: "databaseId", label: "Database ID", placeholder: "32-char id from the database URL" },
    ],
    async pull(ctx) {
      const token = ctx.str(OAUTH_ACCESS_TOKEN_KEY);
      const databaseId = ctx.setting("databaseId");
      if (!token || !databaseId) throw new Error("Notion sync is missing its database id");

      const res = await ctx.fetch(
        `https://api.notion.com/v1/databases/${encodeURIComponent(databaseId)}/query`,
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${token}`,
            "Notion-Version": "2022-06-28",
          },
          body: JSON.stringify({
            page_size: Math.min(ctx.limit, PAGE),
            // Opaque, and a query-body field rather than part of the URL.
            ...(ctx.cursor ? { start_cursor: ctx.cursor } : {}),
          }),
        },
      );
      if (!res.ok) throw new Error(`Notion responded ${res.status}`);
      const body = (await res.json()) as {
        results?: { id?: string; properties?: Record<string, unknown> }[];
        next_cursor?: string | null;
        has_more?: boolean;
      };

      const records = (body.results ?? [])
        .filter((r): r is { id: string; properties?: Record<string, unknown> } => typeof r.id === "string")
        .map((r) => ({
          externalId: r.id,
          data: Object.fromEntries(
            Object.entries(r.properties ?? {}).map(([k, v]) => [k, flattenProperty(v)]),
          ),
        }));

      return {
        records,
        cursor: body.has_more && typeof body.next_cursor === "string" ? body.next_cursor : null,
      };
    },
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
