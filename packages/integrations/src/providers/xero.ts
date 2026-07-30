import { OAUTH_ACCESS_TOKEN_KEY, defineProvider } from "../provider";

/**
 * Xero — mirror accounting records into a collection.
 *
 * Xero's wrinkle is that the access token is not enough: every call needs an
 * `Xero-Tenant-Id` header naming which organisation to read, and that is only
 * discoverable by calling `/connections` after authorizing. Rather than add a
 * post-connect hook to the OAuth machinery for one provider, `pull` resolves it
 * at the start of each run — one small request per run against a page budget of
 * twenty, which is cheaper than the machinery would be and cannot go stale when
 * the admin changes which organisation they granted.
 */

/** Xero pages at 100 and ignores a larger request. */
const PAGE = 100;

const ENDPOINTS = [
  { value: "Contacts", label: "Contacts" },
  { value: "Invoices", label: "Invoices" },
  { value: "Items", label: "Items / products" },
  { value: "Payments", label: "Payments" },
  { value: "Accounts", label: "Chart of accounts" },
  { value: "BankTransactions", label: "Bank transactions" },
] as const;

const ENDPOINT_VALUES = new Set<string>(ENDPOINTS.map((e) => e.value));

/** Xero returns `/Date(1700000000000+0000)/` for dates, which is not a date to
 *  anything downstream. Unwrap it; leave everything else alone. */
const unwrapDate = (v: unknown): unknown => {
  if (typeof v !== "string") return v;
  const m = /^\/Date\((-?\d+)([+-]\d{4})?\)\/$/.exec(v);
  return m ? new Date(Number(m[1])).toISOString() : v;
};

export const xero = defineProvider({
  id: "xero",
  label: "Xero",
  category: "accounting",
  capabilities: ["source"],
  configFields: [
    { key: "clientId", label: "OAuth client ID", placeholder: "from your Xero app" },
    { key: "clientSecret", label: "OAuth client secret", secret: true },
  ],
  oauth: {
    authorizeUrl: "https://login.xero.com/identity/connect/authorize",
    tokenUrl: "https://identity.xero.com/connect/token",
    // `offline_access` is what makes Xero issue a refresh token at all.
    scopes: [
      "offline_access",
      "accounting.contacts.read",
      "accounting.transactions.read",
      "accounting.settings.read",
    ],
    pkce: true,
    tokenAuth: "basic",
  },
  source: {
    settingFields: [
      { key: "endpoint", label: "Record type", options: ENDPOINTS },
      {
        key: "organisation",
        label: "Organisation name (optional)",
        placeholder: "leave blank for the first one you granted",
      },
    ],
    async pull(ctx) {
      const token = ctx.str(OAUTH_ACCESS_TOKEN_KEY);
      const endpoint = ctx.setting("endpoint");
      if (!token) throw new Error("Xero sync has no access token");
      // Checked rather than trusted: it becomes a URL path segment.
      if (!endpoint || !ENDPOINT_VALUES.has(endpoint)) {
        throw new Error(`Xero sync has an unknown record type "${endpoint ?? ""}"`);
      }

      const auth = { Authorization: `Bearer ${token}`, Accept: "application/json" };
      const connRes = await ctx.fetch("https://api.xero.com/connections", { headers: auth });
      if (!connRes.ok) throw new Error(`Xero connections responded ${connRes.status}`);
      const connections = (await connRes.json()) as { tenantId?: string; tenantName?: string }[];
      const wanted = ctx.setting("organisation");
      const chosen = wanted
        ? connections.find((c) => c.tenantName === wanted)
        : connections[0];
      if (!chosen?.tenantId) {
        throw new Error(
          wanted
            ? `Xero organisation "${wanted}" is not among the ones this connection was granted`
            : "This Xero connection has no organisations — reauthorize and grant one",
        );
      }

      // Xero pages 1-based by page number, not by offset.
      const page = Math.max(1, Number.parseInt(ctx.cursor ?? "1", 10) || 1);
      const url = new URL(`https://api.xero.com/api.xro/2.0/${endpoint}`);
      url.searchParams.set("page", String(page));
      url.searchParams.set("pageSize", String(Math.min(ctx.limit, PAGE)));

      const res = await ctx.fetch(url.toString(), {
        headers: { ...auth, "Xero-Tenant-Id": chosen.tenantId },
      });
      if (!res.ok) throw new Error(`Xero responded ${res.status}`);
      const body = (await res.json()) as Record<string, unknown>;
      const rows = (body[endpoint] as Record<string, unknown>[] | undefined) ?? [];

      // Each endpoint names its id differently (`ContactID`, `InvoiceID`, …),
      // and the singular is the plural minus its trailing "s".
      const idKey = `${endpoint.replace(/s$/, "")}ID`;
      const records = rows
        .filter((r) => typeof r[idKey] === "string")
        .map((r) => ({
          externalId: r[idKey] as string,
          data: Object.fromEntries(
            Object.entries(r)
              .filter(([, v]) => v === null || typeof v !== "object")
              .map(([k, v]) => [k, unwrapDate(v)]),
          ),
        }));

      return { records, cursor: rows.length < Math.min(ctx.limit, PAGE) ? null : String(page + 1) };
    },
  },
});
