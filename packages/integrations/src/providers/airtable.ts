import { OAUTH_ACCESS_TOKEN_KEY, defineProvider } from "../provider";

/**
 * Airtable — read a table into a collection.
 *
 * Unlike Sheets, Airtable gives every record a stable id, so a row that moves
 * stays the same record and an edit is an update rather than a delete plus an
 * insert. That is the whole difference between the two connectors.
 */

/** Airtable's own page cap. Asking for more is an error, not a bigger page. */
const PAGE = 100;

export const airtable = defineProvider({
  id: "airtable",
  label: "Airtable",
  category: "productivity",
  capabilities: ["source"],
  configFields: [
    { key: "clientId", label: "OAuth client ID", placeholder: "from your Airtable OAuth integration" },
    { key: "clientSecret", label: "OAuth client secret", secret: true },
  ],
  oauth: {
    authorizeUrl: "https://airtable.com/oauth2/v1/authorize",
    tokenUrl: "https://airtable.com/oauth2/v1/token",
    scopes: ["data.records:read", "schema.bases:read"],
    // Airtable requires PKCE — the authorize call is rejected without it.
    pkce: true,
    tokenAuth: "basic",
  },
  source: {
    settingFields: [
      { key: "baseId", label: "Base ID", placeholder: "app…" },
      { key: "tableName", label: "Table name or ID", placeholder: "Tasks" },
      { key: "viewName", label: "View (optional)", placeholder: "Grid view" },
    ],
    async pull(ctx) {
      const token = ctx.str(OAUTH_ACCESS_TOKEN_KEY);
      const baseId = ctx.setting("baseId");
      const table = ctx.setting("tableName");
      if (!token || !baseId || !table) throw new Error("Airtable sync is missing its base or table");

      const url = new URL(
        `https://api.airtable.com/v0/${encodeURIComponent(baseId)}/${encodeURIComponent(table)}`,
      );
      url.searchParams.set("pageSize", String(Math.min(ctx.limit, PAGE)));
      const view = ctx.setting("viewName");
      if (view) url.searchParams.set("view", view);
      // Airtable's offset is opaque and goes in a query parameter, never a path
      // segment — it round-trips through our database and back out.
      if (ctx.cursor) url.searchParams.set("offset", ctx.cursor);

      const res = await ctx.fetch(url.toString(), { headers: { Authorization: `Bearer ${token}` } });
      if (!res.ok) throw new Error(`Airtable responded ${res.status}`);
      const body = (await res.json()) as {
        records?: { id?: string; fields?: Record<string, unknown> }[];
        offset?: string;
      };

      const records = (body.records ?? [])
        .filter((r): r is { id: string; fields?: Record<string, unknown> } => typeof r.id === "string")
        .map((r) => ({ externalId: r.id, data: r.fields ?? {} }));

      return { records, cursor: typeof body.offset === "string" ? body.offset : null };
    },
  },
});
