import { currency, dateOnly, ledgerRef, money, text, xeroLiteral } from "../accounting";
import { OAUTH_ACCESS_TOKEN_KEY, defineProvider, type DestinationRow, type FetchLike } from "../provider";

/**
 * Xero — accounting records into a collection, and rows back out as contacts
 * and invoices.
 *
 * Xero's wrinkle in BOTH directions is that the access token is not enough:
 * every call needs an `Xero-Tenant-Id` header naming which organisation to
 * touch, and that is only discoverable by calling `/connections` after
 * authorizing. Rather than add a post-connect hook to the OAuth machinery for
 * one provider, it is resolved at the start of each run — one small request
 * against a page budget of twenty, which is cheaper than the machinery would be
 * and cannot go stale when the admin changes which organisation they granted.
 *
 * **Pushing out.** Xero is the friendlier half of the accounting write-back.
 * Like QuickBooks it has no upsert, so a push looks the batch up first and then
 * decides create-or-update — but unlike QuickBooks it takes the whole batch in
 * ONE call, so a push is two requests rather than one per row. Three things it
 * does differently, each of which would be a bug if assumed away:
 *
 *   - **A contact is created for you.** An invoice may name its contact and
 *     Xero will make one if the name is new. QuickBooks refuses, which is why
 *     that provider has a setting about it and this one does not.
 *   - **A paid or voided invoice cannot be modified.** Xero answers with a
 *     validation error, and since the engine retries a failed batch the sync
 *     would pause on a row whose only crime is having been paid. The lookup
 *     already returns the status, so those rows are left alone.
 *   - **Line items replace, they do not merge.** Sending one line means the
 *     invoice HAS one line afterwards. That is the right behaviour for a
 *     mirrored row and the wrong one for an invoice an accountant has since
 *     itemised — which is the other half of why paid invoices are left alone.
 */

/** Xero pages at 100 and ignores a larger request. */
const PAGE = 100;

/**
 * Rows per push call.
 *
 * Two requests per batch whatever the size, so this is bounded by the `where`
 * expression instead: 25 OR'd terms is a query string Xero and every proxy in
 * front of it will accept.
 */
const PUSH_BATCH = 25;

const ENDPOINTS = [
  { value: "Contacts", label: "Contacts" },
  { value: "Invoices", label: "Invoices" },
  { value: "Items", label: "Items / products" },
  { value: "Payments", label: "Payments" },
  { value: "Accounts", label: "Chart of accounts" },
  { value: "BankTransactions", label: "Bank transactions" },
] as const;

const ENDPOINT_VALUES = new Set<string>(ENDPOINTS.map((e) => e.value));

/** What a push can write — the two record types a collection actually models. */
const PUSH_ENDPOINTS = [
  { value: "Contacts", label: "Contacts" },
  { value: "Invoices", label: "Invoices" },
] as const;

const PUSH_ENDPOINT_VALUES = new Set<string>(PUSH_ENDPOINTS.map((e) => e.value));

/** Xero's own caps. Truncating past them makes two rows share one key. */
const CONTACT_NUMBER_MAX = 50;
const INVOICE_NUMBER_MAX = 255;

/** Statuses Xero refuses to modify. Sending one is a permanent 400, which the
 *  engine would retry until the breaker paused the whole sync. */
const FROZEN = new Set(["PAID", "VOIDED", "DELETED"]);

const CONTACT_COLUMNS = [
  "contactNumber",
  "name",
  "firstName",
  "lastName",
  "email",
  "phone",
  "taxNumber",
] as const;
const INVOICE_COLUMNS = [
  "invoiceNumber",
  "contactName",
  "amount",
  "description",
  "date",
  "dueDate",
  "currency",
  "reference",
] as const;

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
  capabilities: ["source", "destination"],
  configFields: [
    { key: "clientId", label: "OAuth client ID", placeholder: "from your Xero app" },
    { key: "clientSecret", label: "OAuth client secret", secret: true },
  ],
  oauth: {
    authorizeUrl: "https://login.xero.com/identity/connect/authorize",
    tokenUrl: "https://identity.xero.com/connect/token",
    // `offline_access` is what makes Xero issue a refresh token at all.
    //
    // The `.read` scopes stay alongside the write ones for the same reason
    // Google Calendar keeps `calendar.readonly`: Xero shows the consent screen
    // per scope, and an admin connecting this only to mirror their books in
    // should see reading listed rather than a bare "create and update
    // transactions". A connection authorized before the write-back existed
    // keeps pulling and is refused at the moment a push sync is SAVED.
    scopes: [
      "offline_access",
      "accounting.contacts",
      "accounting.contacts.read",
      "accounting.transactions",
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

      const tenantId = await resolveTenant(ctx.fetch, token, ctx.setting("organisation"));
      const headers = authHeaders(token, tenantId);

      // Xero pages 1-based by page number, not by offset.
      const page = Math.max(1, Number.parseInt(ctx.cursor ?? "1", 10) || 1);
      const url = new URL(`https://api.xero.com/api.xro/2.0/${endpoint}`);
      url.searchParams.set("page", String(page));
      url.searchParams.set("pageSize", String(Math.min(ctx.limit, PAGE)));

      const res = await ctx.fetch(url.toString(), { headers });
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
  destination: {
    batchSize: PUSH_BATCH,
    // Both, because Xero grants write per record type and a connection
    // reauthorized for this direction receives them together — so requiring
    // both is exactly the test for "authorized before the write-back existed".
    requiredScope: ["accounting.contacts", "accounting.transactions"],
    columns: [
      { value: "contactNumber", label: "Contact code", when: { endpoint: ["Contacts"] } },
      { value: "name", label: "Contact name", when: { endpoint: ["Contacts"] } },
      { value: "firstName", label: "First name", when: { endpoint: ["Contacts"] } },
      { value: "lastName", label: "Last name", when: { endpoint: ["Contacts"] } },
      { value: "email", label: "Email", when: { endpoint: ["Contacts"] } },
      { value: "phone", label: "Phone", when: { endpoint: ["Contacts"] } },
      { value: "taxNumber", label: "Tax number", when: { endpoint: ["Contacts"] } },
      { value: "invoiceNumber", label: "Invoice number", when: { endpoint: ["Invoices"] } },
      { value: "contactName", label: "Contact name", when: { endpoint: ["Invoices"] } },
      { value: "amount", label: "Amount", when: { endpoint: ["Invoices"] } },
      { value: "description", label: "Line description", when: { endpoint: ["Invoices"] } },
      { value: "date", label: "Invoice date", when: { endpoint: ["Invoices"] } },
      { value: "dueDate", label: "Due date", when: { endpoint: ["Invoices"] } },
      { value: "currency", label: "Currency code", when: { endpoint: ["Invoices"] } },
      { value: "reference", label: "Reference", when: { endpoint: ["Invoices"] } },
    ],
    settingFields: [
      { key: "endpoint", label: "Record type", options: PUSH_ENDPOINTS },
      {
        key: "organisation",
        label: "Organisation name (optional)",
        placeholder: "leave blank for the first one you granted",
      },
      {
        key: "invoiceStatus",
        label: "Invoice status (optional)",
        options: [
          { value: "DRAFT", label: "Draft — nothing posts to the ledger" },
          { value: "SUBMITTED", label: "Submitted for approval" },
          { value: "AUTHORISED", label: "Authorised — posts to the ledger" },
        ],
      },
      {
        key: "invoiceType",
        label: "Invoice type (optional)",
        options: [
          { value: "ACCREC", label: "Sales invoice (money in)" },
          { value: "ACCPAY", label: "Bill (money out)" },
        ],
      },
      {
        key: "accountCode",
        label: "Account code (optional)",
        placeholder: "200 — the revenue account the line posts to",
      },
    ],
    async push(ctx) {
      const token = ctx.str(OAUTH_ACCESS_TOKEN_KEY);
      const endpoint = ctx.setting("endpoint");
      if (!token) throw new Error("Xero write-back has no access token");
      if (!endpoint || !PUSH_ENDPOINT_VALUES.has(endpoint)) {
        throw new Error(`Xero write-back has an unknown record type "${endpoint ?? ""}"`);
      }
      assertColumns(endpoint, ctx.columns);

      const tenantId = await resolveTenant(ctx.fetch, token, ctx.setting("organisation"));
      const api = client(ctx.fetch, token, tenantId);

      if (endpoint === "Contacts") await pushContacts(api, ctx.rows, ctx.syncKey);
      else await pushInvoices(api, ctx);
    },
  },
});

/* ── Shared plumbing ─────────────────────────────────────────────────────── */

const authHeaders = (token: string, tenantId: string) => ({
  Authorization: `Bearer ${token}`,
  Accept: "application/json",
  "Xero-Tenant-Id": tenantId,
});

/**
 * Which organisation this connection is acting on.
 *
 * A connection can be granted several, and the token says nothing about which:
 * only `/connections` does. Named rather than positional when the admin says
 * so, because "the first one you granted" changes as they connect more.
 */
const resolveTenant = async (
  doFetch: FetchLike,
  token: string,
  wanted: string | null,
): Promise<string> => {
  const res = await doFetch("https://api.xero.com/connections", {
    headers: { Authorization: `Bearer ${token}`, Accept: "application/json" },
  });
  if (!res.ok) throw new Error(`Xero connections responded ${res.status}`);
  const connections = (await res.json()) as { tenantId?: string; tenantName?: string }[];
  const chosen = wanted ? connections.find((c) => c.tenantName === wanted) : connections[0];
  if (!chosen?.tenantId) {
    throw new Error(
      wanted
        ? `Xero organisation "${wanted}" is not among the ones this connection was granted`
        : "This Xero connection has no organisations — reauthorize and grant one",
    );
  }
  return chosen.tenantId;
};

/* ── The push ────────────────────────────────────────────────────────────── */

type Xero = ReturnType<typeof client>;

/** The two calls a push makes: find the batch, then write the batch. */
const client = (doFetch: FetchLike, token: string, tenantId: string) => {
  const base = "https://api.xero.com/api.xro/2.0";
  const headers = { ...authHeaders(token, tenantId), "Content-Type": "application/json" };

  return {
    /** `where` must already be escaped — see `xeroLiteral`. */
    async find<T>(endpoint: string, where: string): Promise<T[]> {
      const url = new URL(`${base}/${endpoint}`);
      url.searchParams.set("where", where);
      const res = await doFetch(url.toString(), { headers });
      if (!res.ok) throw await failure(res);
      const body = (await res.json().catch(() => ({}))) as Record<string, unknown>;
      return ((body[endpoint] as T[] | undefined) ?? []) as T[];
    },
    /** One POST for the whole batch. Xero takes create and update together —
     *  an element carrying its id is an update, one without it is a create. */
    async save(endpoint: string, records: Record<string, unknown>[]): Promise<void> {
      if (records.length === 0) return;
      const res = await doFetch(`${base}/${endpoint}`, {
        method: "POST",
        headers,
        body: JSON.stringify({ [endpoint]: records }),
      });
      if (!res.ok) throw await failure(res);
    },
  };
};

/** `A=="x" OR A=="y"` over a batch's keys. */
const anyOf = (field: string, values: string[], max: number): string =>
  values.map((v) => `${field}=="${xeroLiteral(v, max)}"`).join(" OR ");

const pushContacts = async (
  api: Xero,
  rows: readonly DestinationRow[],
  syncKey: string,
): Promise<void> => {
  interface Pending {
    row: DestinationRow;
    number: string;
    name: string;
  }
  const pending: Pending[] = [];
  for (const row of rows) {
    const rowId = String(row.id ?? "");
    const name = text(row.name);
    // Xero requires a name and requires it unique; a row with none is not a
    // contact, and failing the batch on it would strand the other 24.
    if (!rowId || !name) continue;
    const number = (text(row.contactNumber) ?? (await ledgerRef(syncKey, rowId))).slice(
      0,
      CONTACT_NUMBER_MAX,
    );
    pending.push({ row, number, name });
  }
  if (pending.length === 0) return;

  const existing = await api.find<{ ContactID?: string; ContactNumber?: string }>(
    "Contacts",
    anyOf("ContactNumber", [...new Set(pending.map((p) => p.number))], CONTACT_NUMBER_MAX),
  );
  const byNumber = new Map<string, string>();
  for (const c of existing) if (c.ContactID && c.ContactNumber) byNumber.set(c.ContactNumber, c.ContactID);

  await api.save(
    "Contacts",
    pending.map((p) => {
      const body: Record<string, unknown> = { ContactNumber: p.number, Name: p.name };
      const id = byNumber.get(p.number);
      if (id) body.ContactID = id;
      const firstName = text(p.row.firstName);
      if (firstName) body.FirstName = firstName;
      const lastName = text(p.row.lastName);
      if (lastName) body.LastName = lastName;
      const email = text(p.row.email);
      if (email) body.EmailAddress = email;
      const taxNumber = text(p.row.taxNumber);
      if (taxNumber) body.TaxNumber = taxNumber;
      const phone = text(p.row.phone);
      // Xero holds phones as a typed list, not a string; DEFAULT is the one its
      // own UI shows on the contact.
      if (phone) body.Phones = [{ PhoneType: "DEFAULT", PhoneNumber: phone }];
      return body;
    }),
  );
};

const pushInvoices = async (
  api: Xero,
  ctx: {
    rows: readonly DestinationRow[];
    syncKey: string;
    setting(key: string): string | null;
  },
): Promise<void> => {
  // DRAFT by default: an automation that posts to the ledger on its first run
  // is not something an operator should have to opt OUT of.
  const status = ctx.setting("invoiceStatus") ?? "DRAFT";
  const type = ctx.setting("invoiceType") ?? "ACCREC";
  const accountCode = ctx.setting("accountCode");

  interface Pending {
    row: DestinationRow;
    number: string;
    contactName: string;
    amount: number;
  }
  const pending: Pending[] = [];
  for (const row of ctx.rows) {
    const rowId = String(row.id ?? "");
    const contactName = text(row.contactName);
    const amount = money(row.amount);
    if (!rowId || !contactName || amount === null) continue;
    const number = (text(row.invoiceNumber) ?? (await ledgerRef(ctx.syncKey, rowId))).slice(
      0,
      INVOICE_NUMBER_MAX,
    );
    pending.push({ row, number, contactName, amount });
  }
  if (pending.length === 0) return;

  const existing = await api.find<{ InvoiceID?: string; InvoiceNumber?: string; Status?: string }>(
    "Invoices",
    anyOf("InvoiceNumber", [...new Set(pending.map((p) => p.number))], INVOICE_NUMBER_MAX),
  );
  const byNumber = new Map<string, { id: string; status: string }>();
  for (const inv of existing) {
    if (inv.InvoiceID && inv.InvoiceNumber) {
      byNumber.set(inv.InvoiceNumber, { id: inv.InvoiceID, status: (inv.Status ?? "").toUpperCase() });
    }
  }

  const records: Record<string, unknown>[] = [];
  for (const p of pending) {
    const found = byNumber.get(p.number);
    // A paid or voided invoice is not editable in Xero at all. Sending it is a
    // permanent 400 that would take the batch — and eventually the sync — down
    // with it, over a row that is finished.
    if (found && FROZEN.has(found.status)) continue;

    const line: Record<string, unknown> = {
      // Xero requires a description on every line, and renders an empty one as
      // a blank row on the invoice the customer receives.
      Description: text(p.row.description) ?? `Invoice ${p.number}`,
      Quantity: 1,
      UnitAmount: p.amount,
    };
    if (accountCode) line.AccountCode = accountCode;

    const body: Record<string, unknown> = {
      Type: type,
      InvoiceNumber: p.number,
      // Named, not referenced: Xero creates the contact when the name is new,
      // which is the half of this QuickBooks makes the caller do itself.
      Contact: { Name: p.contactName },
      LineItems: [line],
      Status: status,
    };
    if (found) body.InvoiceID = found.id;
    const date = dateOnly(p.row.date);
    if (date) body.Date = date;
    const dueDate = dateOnly(p.row.dueDate);
    if (dueDate) body.DueDate = dueDate;
    const code = currency(p.row.currency);
    if (code) body.CurrencyCode = code;
    const reference = text(p.row.reference);
    if (reference) body.Reference = reference;
    records.push(body);
  }

  await api.save("Invoices", records);
};

/** Refuse a mapping that belongs to the other record type — see the QuickBooks
 *  twin for why this exists beyond the save-time check. */
const assertColumns = (endpoint: string, columns: Readonly<Record<string, string>>): void => {
  const allowed = new Set<string>(endpoint === "Contacts" ? CONTACT_COLUMNS : INVOICE_COLUMNS);
  for (const target of Object.keys(columns)) {
    if (target === "id" || allowed.has(target)) continue;
    throw new Error(`Xero ${endpoint} has no column "${target}" — remap this sync`);
  }
};

/**
 * Turn a failed call into something an operator can act on.
 *
 * Xero's validation errors are the ones that matter: they name the field and
 * the record, and without them a 400 reads as "Xero said no" with no way to
 * tell a duplicate contact name from a missing account code.
 */
const failure = async (res: Response): Promise<Error> => {
  if (res.status === 401) {
    return new Error("Xero rejected the credentials — reauthorize the connection");
  }
  if (res.status === 403) {
    return new Error(
      "Xero refused the write — reconnect this integration so it also grants write access",
    );
  }
  if (res.status === 429) return new Error("Xero rate-limited the write — it will be retried");
  const body = (await res.json().catch(() => ({}))) as {
    Message?: string;
    Elements?: { ValidationErrors?: { Message?: string }[] }[];
  };
  const detail =
    body.Elements?.flatMap((e) => e.ValidationErrors ?? [])
      .map((v) => v.Message)
      .filter(Boolean)
      .join("; ") ||
    body.Message ||
    "";
  return new Error(`Xero responded ${res.status}${detail ? `: ${detail.slice(0, 200)}` : ""}`);
};
