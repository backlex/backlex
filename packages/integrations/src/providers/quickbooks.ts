import { OAUTH_ACCESS_TOKEN_KEY, defineProvider } from "../provider";

/**
 * QuickBooks Online — mirror accounting records into a collection.
 *
 * Two things about Intuit's OAuth are unlike the other providers here. The
 * company id (`realmId`) comes back as a query parameter on the REDIRECT and
 * appears nowhere in the token response, yet every API call needs it — hence
 * `keepFromCallbackQuery`. And the refresh token rotates on every renewal, so
 * the compare-and-set in `ensureAccessToken` is load-bearing rather than
 * defensive: overwriting a concurrent refresh would restore a token Intuit has
 * already invalidated.
 */

/** Intuit's own page cap for a query. */
const PAGE = 100;

/** Entities worth mirroring. A closed list because the query is built from it —
 *  free text here would be a way to aim the query at something unintended. */
const ENTITIES = [
  { value: "Customer", label: "Customers" },
  { value: "Invoice", label: "Invoices" },
  { value: "Item", label: "Items / products" },
  { value: "Payment", label: "Payments" },
  { value: "Vendor", label: "Vendors" },
  { value: "Bill", label: "Bills" },
  { value: "Account", label: "Chart of accounts" },
] as const;

const ENTITY_VALUES = new Set<string>(ENTITIES.map((e) => e.value));

export const quickbooks = defineProvider({
  id: "quickbooks",
  label: "QuickBooks Online",
  category: "accounting",
  capabilities: ["source"],
  configFields: [
    { key: "clientId", label: "OAuth client ID", placeholder: "from your Intuit app" },
    { key: "clientSecret", label: "OAuth client secret", secret: true },
  ],
  oauth: {
    authorizeUrl: "https://appcenter.intuit.com/connect/oauth2",
    tokenUrl: "https://oauth.platform.intuit.com/oauth2/v1/tokens/bearer",
    scopes: ["com.intuit.quickbooks.accounting"],
    pkce: true,
    // Intuit rejects the body form with an opaque 401.
    tokenAuth: "basic",
    // The company id arrives on the redirect and nowhere else.
    keepFromCallbackQuery: ["realmId"],
  },
  source: {
    settingFields: [
      { key: "entity", label: "Record type", options: ENTITIES },
      {
        key: "environment",
        label: "Environment",
        options: [
          { value: "production", label: "Production" },
          { value: "sandbox", label: "Sandbox" },
        ],
      },
    ],
    async pull(ctx) {
      const token = ctx.str(OAUTH_ACCESS_TOKEN_KEY);
      const realmId = ctx.str("realmId");
      const entity = ctx.setting("entity");
      if (!token) throw new Error("QuickBooks sync has no access token");
      if (!realmId) {
        throw new Error("QuickBooks connection is missing its company id — reauthorize the connection");
      }
      // Checked rather than trusted: this value is interpolated into the query
      // string Intuit parses, and the admin form is not the only way in.
      if (!entity || !ENTITY_VALUES.has(entity)) {
        throw new Error(`QuickBooks sync has an unknown record type "${entity ?? ""}"`);
      }

      const host =
        ctx.setting("environment") === "sandbox"
          ? "https://sandbox-quickbooks.api.intuit.com"
          : "https://quickbooks.api.intuit.com";
      // 1-based, and its own field rather than an opaque token, so it is parsed
      // back out of our database rather than pasted into the query.
      const start = Math.max(1, Number.parseInt(ctx.cursor ?? "1", 10) || 1);
      const limit = Math.min(ctx.limit, PAGE);

      const url = new URL(`${host}/v3/company/${encodeURIComponent(realmId)}/query`);
      url.searchParams.set(
        "query",
        `select * from ${entity} startposition ${start} maxresults ${limit}`,
      );
      url.searchParams.set("minorversion", "70");

      const res = await ctx.fetch(url.toString(), {
        headers: { Authorization: `Bearer ${token}`, Accept: "application/json" },
      });
      if (!res.ok) throw new Error(`QuickBooks responded ${res.status}`);
      const body = (await res.json()) as { QueryResponse?: Record<string, unknown> };
      const rows = (body.QueryResponse?.[entity] as { Id?: string }[] | undefined) ?? [];

      const records = rows
        .filter((r): r is { Id: string } & Record<string, unknown> => typeof r.Id === "string")
        .map((r) => ({ externalId: r.Id, data: flatten(r) }));

      // A short page means the entity ran out; the next run starts over and
      // picks up edits, since QuickBooks has no incremental cursor here.
      return { records, cursor: rows.length < limit ? null : String(start + rows.length) };
    },
  },
});

/**
 * QuickBooks nests values one level deep in places (`CustomerRef.value`,
 * `TotalAmt`), so flatten to `Parent_Child` scalars.
 *
 * Anything deeper collapses to `null` rather than being stringified: a nested
 * object written into a text column reads `[object Object]`, which looks like
 * data and is not. A dropped value is visibly missing.
 */
const flatten = (row: Record<string, unknown>): Record<string, unknown> => {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(row)) {
    if (v === null || typeof v !== "object") {
      out[k] = v;
      continue;
    }
    if (Array.isArray(v)) continue;
    for (const [ck, cv] of Object.entries(v as Record<string, unknown>)) {
      if (cv === null || typeof cv !== "object") out[`${k}_${ck}`] = cv;
    }
  }
  return out;
};
