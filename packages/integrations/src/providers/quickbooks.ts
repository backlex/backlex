import {
  currency,
  dateOnly,
  ledgerRef,
  money,
  quickbooksLiteral,
  text,
} from "../accounting";
import { OAUTH_ACCESS_TOKEN_KEY, defineProvider, type DestinationRow } from "../provider";

/**
 * QuickBooks Online — accounting records into a collection, and rows back out
 * as customers and invoices.
 *
 * Two things about Intuit's OAuth are unlike the other providers here. The
 * company id (`realmId`) comes back as a query parameter on the REDIRECT and
 * appears nowhere in the token response, yet every API call needs it — hence
 * `keepFromCallbackQuery`. And the refresh token rotates on every renewal, so
 * the compare-and-set in `ensureAccessToken` is load-bearing rather than
 * defensive: overwriting a concurrent refresh would restore a token Intuit has
 * already invalidated.
 *
 * **Pushing out.** Invoicing, ecommerce and SaaS templates all keep customers
 * and invoices in backlex and then re-key them into the ledger by hand. The
 * write-back is a destination rather than a flow op for the same reason the
 * calendar one is: the engine already owns the watermark walk that re-sends an
 * edited row and the breaker that pauses a sync pointed at a revoked company.
 *
 * What QuickBooks makes hard is the upsert. There is no external-id field and
 * no "create or update" call: you FIND the record by a field Intuit will filter
 * on, then create or update depending on the answer. So a push is one query per
 * batch (an `in (…)` over the whole batch's keys, not per row) followed by one
 * write per row. Three consequences worth knowing before editing this:
 *
 *   - **The lookup key is row data for customers.** A customer is found by
 *     `DisplayName`, which Intuit requires to be unique — there is nowhere else
 *     to put a reference. So a customer name is interpolated into a query, and
 *     {@link quickbooksLiteral} is what makes that safe. An invoice is found by
 *     `DocNumber`, which is ours to choose when the collection does not carry
 *     one.
 *   - **Updates are sparse.** A full update REPLACES the record, so an invoice
 *     whose terms an accountant set in QuickBooks would be silently reset by
 *     the next sync of a row that never knew about them.
 *   - **An invoice needs a customer that exists.** QuickBooks refuses an
 *     invoice with no `CustomerRef`, and the name in the row is not one. A
 *     missing customer is created by default — that is what the QuickBooks UI
 *     itself does when you type a new name on an invoice — and the sync can be
 *     told to skip those rows instead.
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

/** What a push can write. Far shorter than what it can read: a `Payment` or an
 *  `Account` created by an automation is a bookkeeping decision, not a mirror. */
const PUSH_ENTITIES = [
  { value: "Customer", label: "Customers" },
  { value: "Invoice", label: "Invoices" },
] as const;

const PUSH_ENTITY_VALUES = new Set<string>(PUSH_ENTITIES.map((e) => e.value));

/**
 * Rows per push call.
 *
 * One query for the batch plus one write per row, and up to two more queries
 * when invoices have to resolve their customers. 20 rows is ~23 subrequests,
 * and the engine's 20-page budget multiplies it to ~460 — inside a Worker's
 * 1000.
 */
const PUSH_BATCH = 20;

/** Intuit caps `DocNumber` here, and silently truncating an invoice number
 *  would make two rows collide on the same document. */
const DOC_NUMBER_MAX = 21;

const CUSTOMER_COLUMNS = ["displayName", "companyName", "email", "phone", "notes"] as const;
const INVOICE_COLUMNS = [
  "docNumber",
  "customerName",
  "amount",
  "description",
  "txnDate",
  "dueDate",
  "currency",
] as const;

export const quickbooks = defineProvider({
  id: "quickbooks",
  label: "QuickBooks Online",
  category: "accounting",
  capabilities: ["source", "destination"],
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
  destination: {
    batchSize: PUSH_BATCH,
    // No `requiredScope`: Intuit's one accounting scope is read AND write, so a
    // connection made when QuickBooks was source-only can already push. Xero
    // splits the two and does need one — the asymmetry is the provider's, not
    // an oversight here.
    columns: [
      { value: "displayName", label: "Customer name", when: { entity: ["Customer"] } },
      { value: "companyName", label: "Company", when: { entity: ["Customer"] } },
      { value: "email", label: "Email", when: { entity: ["Customer"] } },
      { value: "phone", label: "Phone", when: { entity: ["Customer"] } },
      { value: "notes", label: "Notes", when: { entity: ["Customer"] } },
      { value: "docNumber", label: "Invoice number", when: { entity: ["Invoice"] } },
      { value: "customerName", label: "Customer name", when: { entity: ["Invoice"] } },
      { value: "amount", label: "Amount", when: { entity: ["Invoice"] } },
      { value: "description", label: "Line description", when: { entity: ["Invoice"] } },
      { value: "txnDate", label: "Invoice date", when: { entity: ["Invoice"] } },
      { value: "dueDate", label: "Due date", when: { entity: ["Invoice"] } },
      { value: "currency", label: "Currency code", when: { entity: ["Invoice"] } },
    ],
    settingFields: [
      { key: "entity", label: "Record type", options: PUSH_ENTITIES },
      {
        key: "environment",
        label: "Environment",
        options: [
          { value: "production", label: "Production" },
          { value: "sandbox", label: "Sandbox" },
        ],
      },
      {
        key: "item",
        label: "Invoice line product/service (optional)",
        placeholder: "Services — the name as it appears in QuickBooks",
      },
      {
        key: "missingCustomer",
        label: "When the invoice names an unknown customer (optional)",
        options: [
          { value: "create", label: "Create the customer in QuickBooks" },
          { value: "skip", label: "Skip the invoice" },
        ],
      },
    ],
    async push(ctx) {
      const token = ctx.str(OAUTH_ACCESS_TOKEN_KEY);
      const realmId = ctx.str("realmId");
      const entity = ctx.setting("entity");
      if (!token) throw new Error("QuickBooks write-back has no access token");
      if (!realmId) {
        throw new Error("QuickBooks connection is missing its company id — reauthorize the connection");
      }
      // Checked rather than trusted: it becomes a URL path segment and a query
      // keyword, and the admin form is not the only way in.
      if (!entity || !PUSH_ENTITY_VALUES.has(entity)) {
        throw new Error(`QuickBooks write-back has an unknown record type "${entity ?? ""}"`);
      }
      assertColumns(entity, ctx.columns);

      const host =
        ctx.setting("environment") === "sandbox"
          ? "https://sandbox-quickbooks.api.intuit.com"
          : "https://quickbooks.api.intuit.com";
      const api = client(ctx.fetch, host, realmId, token);

      if (entity === "Customer") await pushCustomers(api, ctx.rows);
      else await pushInvoices(api, ctx);
    },
  },
});

/* ── The push ────────────────────────────────────────────────────────────── */

type Qbo = ReturnType<typeof client>;

/** One QuickBooks entity, as much of it as a push cares about. */
interface Existing {
  Id: string;
  SyncToken: string;
}

/**
 * A thin wrapper over the three calls a push makes.
 *
 * It exists so the URL shape, the minor version and the error decoding are
 * written once: a create and an update differ by a single query parameter, and
 * the one that reads as harmless (`operation=update` missing) is the one that
 * creates a duplicate.
 */
const client = (
  doFetch: (input: string, init?: RequestInit) => Promise<Response>,
  host: string,
  realmId: string,
  token: string,
) => {
  const base = `${host}/v3/company/${encodeURIComponent(realmId)}`;
  const headers = {
    Authorization: `Bearer ${token}`,
    Accept: "application/json",
    "Content-Type": "application/json",
  };

  const call = async (url: string, init?: RequestInit): Promise<Record<string, unknown>> => {
    const res = await doFetch(url, { ...init, headers });
    if (!res.ok) throw await failure(res);
    return (await res.json().catch(() => ({}))) as Record<string, unknown>;
  };

  return {
    /** Run a query. `statement` must already be escaped — see `quickbooksLiteral`. */
    async query<T>(entity: string, statement: string): Promise<T[]> {
      const url = new URL(`${base}/query`);
      url.searchParams.set("query", statement);
      url.searchParams.set("minorversion", "70");
      const body = await call(url.toString());
      const response = body.QueryResponse as Record<string, unknown> | undefined;
      return ((response?.[entity] as T[] | undefined) ?? []) as T[];
    },
    /** Create, or update in SPARSE mode — a full update replaces the record. */
    async write(entity: string, body: Record<string, unknown>, existing?: Existing): Promise<Existing> {
      const url = new URL(`${base}/${entity.toLowerCase()}`);
      url.searchParams.set("minorversion", "70");
      if (existing) url.searchParams.set("operation", "update");
      const payload = existing
        ? { ...body, Id: existing.Id, SyncToken: existing.SyncToken, sparse: true }
        : body;
      const out = await call(url.toString(), { method: "POST", body: JSON.stringify(payload) });
      const saved = out[entity] as Existing | undefined;
      if (!saved?.Id) throw new Error(`QuickBooks accepted the ${entity} but returned no id`);
      return saved;
    },
  };
};

/** Customers: the display name IS the key, because there is nowhere else to
 *  put one. Intuit requires it unique, which is what makes that work at all. */
const pushCustomers = async (api: Qbo, rows: readonly DestinationRow[]): Promise<void> => {
  const wanted = new Map<string, DestinationRow>();
  for (const row of rows) {
    const name = text(row.displayName);
    // A customer with no name is not a customer QuickBooks will accept, and
    // failing the batch on one empty column would strand the other 19 rows.
    if (name) wanted.set(name, row);
  }
  if (wanted.size === 0) return;

  const found = await lookupCustomers(api, [...wanted.keys()]);
  for (const [name, row] of wanted) {
    const body: Record<string, unknown> = { DisplayName: name.slice(0, 100) };
    const company = text(row.companyName);
    if (company) body.CompanyName = company;
    const email = text(row.email);
    if (email) body.PrimaryEmailAddr = { Address: email };
    const phone = text(row.phone);
    if (phone) body.PrimaryPhone = { FreeFormNumber: phone };
    const notes = text(row.notes);
    if (notes) body.Notes = notes;
    await api.write("Customer", body, found.get(name));
  }
};

/** Name → the customer QuickBooks already holds. One query for the batch. */
const lookupCustomers = async (api: Qbo, names: string[]): Promise<Map<string, Existing>> => {
  const out = new Map<string, Existing>();
  if (names.length === 0) return out;
  const list = names.map((n) => `'${quickbooksLiteral(n)}'`).join(", ");
  // `select *` rather than a column list: QuickBooks supports only `select *`
  // and `select count(*)`, and a column list fails as a parse error that reads
  // like a permissions problem.
  const rows = await api.query<{ Id?: string; SyncToken?: string; DisplayName?: string }>(
    "Customer",
    `select * from Customer where DisplayName in (${list})`,
  );
  for (const r of rows) {
    if (r.Id && r.SyncToken && r.DisplayName) {
      out.set(r.DisplayName, { Id: r.Id, SyncToken: r.SyncToken });
    }
  }
  return out;
};

/** Invoices: keyed on `DocNumber`, which is ours to mint when the collection
 *  has none, and resolved against a customer that must exist first. */
const pushInvoices = async (
  api: Qbo,
  ctx: {
    rows: readonly DestinationRow[];
    syncKey: string;
    setting(key: string): string | null;
  },
): Promise<void> => {
  const createMissing = ctx.setting("missingCustomer") !== "skip";
  const itemName = ctx.setting("item");

  interface Pending {
    row: DestinationRow;
    docNumber: string;
    customerName: string;
    amount: number;
  }
  const pending: Pending[] = [];
  for (const row of ctx.rows) {
    const rowId = String(row.id ?? "");
    const customerName = text(row.customerName);
    const amount = money(row.amount);
    // An invoice with no customer or no amount is not an invoice QuickBooks
    // will take. Skipped like a calendar row with no start: one empty column
    // must not stop the rest of the batch.
    if (!rowId || !customerName || amount === null) continue;
    const docNumber = (text(row.docNumber) ?? (await ledgerRef(ctx.syncKey, rowId))).slice(
      0,
      DOC_NUMBER_MAX,
    );
    pending.push({ row, docNumber, customerName, amount });
  }
  if (pending.length === 0) return;

  const customers = await lookupCustomers(api, [...new Set(pending.map((p) => p.customerName))]);
  const invoices = await lookupInvoices(api, pending.map((p) => p.docNumber));
  const itemId = itemName ? await lookupItem(api, itemName) : null;

  for (const p of pending) {
    let customer = customers.get(p.customerName);
    if (!customer) {
      if (!createMissing) continue;
      // What the QuickBooks UI does when you type a new name on an invoice.
      customer = await api.write("Customer", { DisplayName: p.customerName.slice(0, 100) });
      customers.set(p.customerName, customer);
    }

    const line: Record<string, unknown> = {
      Amount: p.amount,
      DetailType: "SalesItemLineDetail",
      SalesItemLineDetail: itemId ? { ItemRef: { value: itemId } } : {},
    };
    const description = text(p.row.description);
    if (description) line.Description = description;

    const body: Record<string, unknown> = {
      DocNumber: p.docNumber,
      CustomerRef: { value: customer.Id },
      Line: [line],
    };
    const txnDate = dateOnly(p.row.txnDate);
    if (txnDate) body.TxnDate = txnDate;
    const dueDate = dateOnly(p.row.dueDate);
    if (dueDate) body.DueDate = dueDate;
    const code = currency(p.row.currency);
    if (code) body.CurrencyRef = { value: code };

    await api.write("Invoice", body, invoices.get(p.docNumber));
  }
};

const lookupInvoices = async (api: Qbo, docNumbers: string[]): Promise<Map<string, Existing>> => {
  const out = new Map<string, Existing>();
  const unique = [...new Set(docNumbers)];
  if (unique.length === 0) return out;
  const list = unique.map((n) => `'${quickbooksLiteral(n, DOC_NUMBER_MAX)}'`).join(", ");
  const rows = await api.query<{ Id?: string; SyncToken?: string; DocNumber?: string }>(
    "Invoice",
    `select * from Invoice where DocNumber in (${list})`,
  );
  for (const r of rows) {
    if (r.Id && r.SyncToken && r.DocNumber) out.set(r.DocNumber, { Id: r.Id, SyncToken: r.SyncToken });
  }
  return out;
};

/**
 * The product/service an invoice line points at.
 *
 * Named rather than given as an id, because an operator knows what their items
 * are called and not what QuickBooks numbered them. A name that matches nothing
 * throws: it is a configuration mistake, and posting the invoices without the
 * line item would file them against the wrong account.
 */
const lookupItem = async (api: Qbo, name: string): Promise<string> => {
  const rows = await api.query<{ Id?: string }>(
    "Item",
    `select * from Item where Name = '${quickbooksLiteral(name)}'`,
  );
  const id = rows[0]?.Id;
  if (!id) throw new Error(`QuickBooks has no product/service named "${name}"`);
  return id;
};

/**
 * Refuse a mapping that belongs to the other record type.
 *
 * The save-time check narrows the column list by the chosen record type, so
 * this only fires for a sync whose settings were changed by something that
 * skipped it. Named explicitly because the alternative is QuickBooks accepting
 * a customer body with a `dueDate` it ignores.
 */
const assertColumns = (entity: string, columns: Readonly<Record<string, string>>): void => {
  const allowed = new Set<string>(entity === "Customer" ? CUSTOMER_COLUMNS : INVOICE_COLUMNS);
  for (const target of Object.keys(columns)) {
    // The engine always sends the primary key, whatever the mapping says.
    if (target === "id" || allowed.has(target)) continue;
    throw new Error(`QuickBooks ${entity} has no column "${target}" — remap this sync`);
  }
};

/** Turn a failed call into something an operator can act on. Intuit answers
 *  every failure with the same envelope, and the status alone is not enough:
 *  a 401 means reconnect, a 429 means wait, and they read identically. */
const failure = async (res: Response): Promise<Error> => {
  const body = (await res.json().catch(() => ({}))) as {
    Fault?: { Error?: { Message?: string; Detail?: string }[] };
  };
  const first = body.Fault?.Error?.[0];
  const detail = (first?.Detail ?? first?.Message ?? "").slice(0, 200);
  if (res.status === 401) {
    return new Error("QuickBooks rejected the credentials — reauthorize the connection");
  }
  if (res.status === 429) return new Error("QuickBooks rate-limited the write — it will be retried");
  return new Error(`QuickBooks responded ${res.status}${detail ? `: ${detail}` : ""}`);
};

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
