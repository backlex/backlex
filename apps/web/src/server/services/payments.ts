/**
 * Payments — connect a payment provider (Stripe / Polar / Lemon Squeezy) to a
 * workspace, receive its signed webhooks, and mirror its objects into ordinary
 * collections.
 *
 * The design decision worth knowing: the synced business data does NOT live in
 * system tables. `ensurePaymentCollections` provisions four MANAGED collections
 * — `payment_customers`, `payment_subscriptions`, `payment_invoices`,
 * `payments` — so everything the platform already does for user data applies to
 * billing data for free: the permission DSL, REST + GraphQL querying, realtime,
 * revisions, the BI panels, exports. Only the connection (`payment_providers`)
 * and the delivery log (`payment_events`) are system tables.
 *
 * Writes go through `ingestRows` in upsert mode rather than `performCreate`:
 * a provider sends the full object on every event and a reconcile re-sends the
 * whole history, so the write must be idempotent on the provider's own id and
 * must not emit a revision per redelivery. The provider id is namespaced
 * (`stripe_cus_123`) so two providers can be connected at once.
 *
 * Every surface (REST, SDK, GraphQL, MCP, CLI) calls these functions — the
 * guards live here, not in the transports.
 */
import { and, desc, eq, isNull, sql } from "drizzle-orm";
import * as pg from "@backlex/db/pg";
import * as sqlite from "@backlex/db/sqlite";
import type { FieldDef } from "@backlex/db";
import { AppError } from "@backlex/core";
import {
  PAYMENT_COLLECTION_SLUGS,
  PAYMENT_PROVIDERS,
  PAYMENT_RECORD_KINDS,
  MASKED_SECRET,
  PAYMENT_MARKER_COLUMNS,
  PAYMENT_SECRET_KEYS,
  fetchPaymentPage,
  isCallbackProvider,
  parseCallbackBody,
  isPaymentProvider,
  maskPaymentConfig,
  normalizePaymentEvent,
  verifyPaymentSignature,
  type FetchLike,
  type PaymentProvider,
  type PaymentRecord,
  type PaymentRecordKind,
} from "@backlex/integrations/payments";
import type { Ctx } from "../context";
import { decryptSecret, encryptSecret, isEncryptedSecret } from "../lib/crypto";
import { createManagedCollection } from "./collections";
import { loadCollection } from "./items/collection-loader";
import { ingestRows } from "./migrate-ingest";

type DbCtx = Pick<Ctx, "db" | "dialect">;
// The PgDb|SqliteDb union can't be queried without per-dialect narrowing; both
// dialects' columns are query-compatible, so queries go through this hatch
// (same shape as services/integrations.ts and services/webhooks.ts).
type AnyDb = any;

const providersTable = (dialect: "pg" | "sqlite") =>
  (dialect === "pg" ? pg.schema.paymentProviders : sqlite.schema.paymentProviders) as
    typeof pg.schema.paymentProviders;

const eventsTable = (dialect: "pg" | "sqlite") =>
  (dialect === "pg" ? pg.schema.paymentEvents : sqlite.schema.paymentEvents) as
    typeof pg.schema.paymentEvents;

const tenantEq = (t: { tenantId: any }, tenantId: string | null) =>
  tenantId === null ? isNull(t.tenantId) : eq(t.tenantId, tenantId);

export interface PaymentProviderRow {
  id: string;
  tenantId: string | null;
  provider: string;
  config: Record<string, unknown>;
  status: string;
  webhookToken: string;
  syncCursor: Record<string, string | null> | null;
  lastEventAt: Date | number | null;
  lastSyncAt: Date | number | null;
  lastSyncError: string | null;
  createdAt: Date | number | null;
}

// ── Secret handling ─────────────────────────────────────────────────────────

const secretKeys = (provider: string) =>
  new Set(PAYMENT_SECRET_KEYS[provider as PaymentProvider] ?? []);

const encryptConfig = async (provider: string, config: Record<string, unknown>, secret: string) => {
  const keys = secretKeys(provider);
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(config)) {
    out[k] =
      keys.has(k) && typeof v === "string" && v && !isEncryptedSecret(v)
        ? await encryptSecret(v, secret)
        : v;
  }
  return out;
};

const decryptConfig = async (provider: string, config: Record<string, unknown>, secret: string) => {
  const keys = secretKeys(provider);
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(config)) {
    out[k] =
      keys.has(k) && typeof v === "string" && isEncryptedSecret(v)
        ? ((await decryptSecret(v, secret)) ?? "")
        : v;
  }
  return out;
};

/** Public (masked) view — never leaks a decrypted key. */
export const toPublicProvider = (row: PaymentProviderRow) => ({
  id: row.id,
  provider: row.provider,
  status: row.status,
  config: maskPaymentConfig(row.provider, (row.config ?? {}) as Record<string, unknown>),
  webhookToken: row.webhookToken,
  webhookPath: `/api/payments/webhook/${row.webhookToken}`,
  syncCursor: row.syncCursor ?? null,
  lastEventAt: row.lastEventAt,
  lastSyncAt: row.lastSyncAt,
  lastSyncError: row.lastSyncError,
  createdAt: row.createdAt,
});

export type PublicPaymentProvider = ReturnType<typeof toPublicProvider>;

/** URL-safe, unguessable path segment for the public receive endpoint. */
const newWebhookToken = (): string => {
  const bytes = crypto.getRandomValues(new Uint8Array(24));
  let s = "";
  for (const b of bytes) s += String.fromCharCode(b);
  return `pwh_${btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "")}`;
};

// ── Provider CRUD ───────────────────────────────────────────────────────────

export interface ConnectProviderInput {
  provider: string;
  config?: Record<string, unknown>;
  status?: "connected" | "disabled";
}

/**
 * Connect (or reconfigure) a provider. One row per (tenant, provider).
 *
 * A reconnect MERGES config: the admin UI reads secrets back masked, so
 * re-submitting the form must not overwrite a stored key with `sk_l…3f9x`.
 * Only keys present in `input.config` are touched, and a masked value for a
 * secret key is treated as "unchanged".
 */
export async function connectProvider(
  ctx: DbCtx,
  tenantId: string,
  input: ConnectProviderInput,
  authSecret: string,
): Promise<PublicPaymentProvider> {
  if (!isPaymentProvider(input.provider)) {
    throw new AppError(
      "VALIDATION",
      `Unknown payment provider "${input.provider}" — expected one of ${PAYMENT_PROVIDERS.join(", ")}`,
    );
  }
  const t = providersTable(ctx.dialect);
  const db = ctx.db as AnyDb;
  const existing = (await db
    .select()
    .from(t)
    .where(and(tenantEq(t, tenantId), eq(t.provider, input.provider)))
    .limit(1)) as PaymentProviderRow[];

  const incoming = input.config ?? {};
  const keys = secretKeys(input.provider);
  const merged: Record<string, unknown> = { ...(existing[0]?.config ?? {}) };
  for (const [k, v] of Object.entries(incoming)) {
    // A masked read (`MASKED_SECRET`) coming back from the connect dialog means
    // "leave the stored one alone" — never persist the mask itself.
    if (keys.has(k) && typeof v === "string" && (v === "" || v.includes(MASKED_SECRET))) {
      continue;
    }
    merged[k] = v;
  }
  const config = await encryptConfig(input.provider, merged, authSecret);
  const status = input.status ?? "connected";

  if (existing[0]) {
    await db
      .update(t)
      .set({ config, status, updatedAt: new Date() })
      .where(eq(t.id, existing[0].id));
    return toPublicProvider({ ...existing[0], config, status });
  }

  const row = {
    id: crypto.randomUUID(),
    tenantId,
    provider: input.provider,
    config,
    status,
    webhookToken: newWebhookToken(),
    syncCursor: null,
    lastEventAt: null,
    lastSyncAt: null,
    lastSyncError: null,
    createdAt: new Date(),
  };
  await db.insert(t).values(row);
  return toPublicProvider(row as PaymentProviderRow);
}

export async function listProviders(
  ctx: DbCtx,
  tenantId: string,
): Promise<PublicPaymentProvider[]> {
  const t = providersTable(ctx.dialect);
  const rows = (await (ctx.db as AnyDb)
    .select()
    .from(t)
    .where(tenantEq(t, tenantId))
    .orderBy(desc(t.createdAt))) as PaymentProviderRow[];
  return rows.map(toPublicProvider);
}

/** Internal read — returns the row with secrets STILL ENCRYPTED. */
export async function getProviderRow(
  ctx: DbCtx,
  tenantId: string,
  id: string,
): Promise<PaymentProviderRow> {
  const t = providersTable(ctx.dialect);
  const rows = (await (ctx.db as AnyDb)
    .select()
    .from(t)
    .where(and(tenantEq(t, tenantId), eq(t.id, id)))
    .limit(1)) as PaymentProviderRow[];
  if (!rows[0]) throw new AppError("NOT_FOUND", "Payment provider not connected");
  return rows[0];
}

/** Resolve a public webhook token to its provider row. Tenant-free by design —
 *  the token IS the routing key for an unauthenticated request. */
export async function getProviderByToken(
  ctx: DbCtx,
  token: string,
): Promise<PaymentProviderRow | null> {
  if (!token) return null;
  const t = providersTable(ctx.dialect);
  const rows = (await (ctx.db as AnyDb)
    .select()
    .from(t)
    .where(eq(t.webhookToken, token))
    .limit(1)) as PaymentProviderRow[];
  return rows[0] ?? null;
}

export async function disconnectProvider(
  ctx: DbCtx,
  tenantId: string,
  id: string,
): Promise<void> {
  const t = providersTable(ctx.dialect);
  const e = eventsTable(ctx.dialect);
  await getProviderRow(ctx, tenantId, id);
  // The event log is meaningless without its provider, and its dedupe index is
  // keyed on provider_id — leaving it would let a re-connect inherit stale
  // "already processed" rows under a recycled id.
  await (ctx.db as AnyDb).delete(e).where(eq(e.providerId, id));
  await (ctx.db as AnyDb).delete(t).where(and(tenantEq(t, tenantId), eq(t.id, id)));
}

/** Issue a fresh receive URL. Invalidates the old one immediately — the admin
 *  must paste the new URL into the provider dashboard. */
export async function rotateWebhookToken(
  ctx: DbCtx,
  tenantId: string,
  id: string,
): Promise<PublicPaymentProvider> {
  const row = await getProviderRow(ctx, tenantId, id);
  const t = providersTable(ctx.dialect);
  const webhookToken = newWebhookToken();
  await (ctx.db as AnyDb)
    .update(t)
    .set({ webhookToken, updatedAt: new Date() })
    .where(eq(t.id, id));
  return toPublicProvider({ ...row, webhookToken });
}

// ── The four synced collections ─────────────────────────────────────────────

const money = (name: string, label: string): FieldDef => ({
  name,
  type: "integer",
  label,
  interface: "number",
  // Providers quote money in the currency's minor unit (cents). Storing the
  // integer verbatim avoids float drift; the admin formats it on display.
  description: "Minor units (e.g. cents).",
});

const statusChoices = (values: string[]): FieldDef["options"] => ({
  choices: values.map((v) => ({ value: v, label: v.replace(/_/g, " ") })),
});

const PROVIDER_FIELD: FieldDef = {
  name: "provider",
  type: "text",
  required: true,
  indexed: true,
  interface: "dropdown",
  options: {
    choices: PAYMENT_PROVIDERS.map((p) => ({ value: p, label: p })),
  },
  description: "Which connected provider this row was synced from.",
};

const EXTERNAL_ID_FIELD: FieldDef = {
  name: "external_id",
  type: "text",
  required: true,
  indexed: true,
  label: "Provider ID",
  description: "The object's id in the provider's own system.",
};

const METADATA_FIELD: FieldDef = {
  name: "metadata",
  type: "json",
  interface: "json",
  group: "Raw",
  sectionCollapsible: true,
  sectionCollapsed: true,
};

const SOURCE_CREATED_FIELD: FieldDef = {
  name: "source_created_at",
  type: "timestamp",
  indexed: true,
  label: "Created at (provider)",
  group: "Raw",
  sectionCollapsible: true,
  sectionCollapsed: true,
};

/** Field definitions per synced collection. Deliberately flat and boring —
 *  these are a mirror of somebody else's schema, not a place to be clever. */
const PAYMENT_COLLECTION_FIELDS: Record<PaymentRecordKind, FieldDef[]> = {
  customer: [
    PROVIDER_FIELD,
    EXTERNAL_ID_FIELD,
    { name: "email", type: "text", indexed: true, interface: "email", width: "half" },
    { name: "name", type: "text", width: "half" },
    { name: "currency", type: "text", width: "half" },
    { name: "delinquent", type: "boolean", interface: "toggle", width: "half" },
    METADATA_FIELD,
    SOURCE_CREATED_FIELD,
  ],
  subscription: [
    PROVIDER_FIELD,
    EXTERNAL_ID_FIELD,
    { name: "customer", type: "relation", to: "payment_customers", indexed: true },
    {
      name: "status",
      type: "text",
      indexed: true,
      interface: "dropdown",
      width: "half",
      options: statusChoices([
        "active",
        "trialing",
        "past_due",
        "unpaid",
        "paused",
        "canceled",
        "incomplete",
        "expired",
      ]),
    },
    { name: "product_name", type: "text", width: "half" },
    money("price_amount", "Price"),
    { name: "currency", type: "text", width: "half" },
    {
      name: "billing_interval",
      type: "text",
      interface: "dropdown",
      width: "half",
      options: statusChoices(["day", "week", "month", "year"]),
    },
    { name: "quantity", type: "integer", width: "half" },
    { name: "current_period_start", type: "timestamp", width: "half" },
    { name: "current_period_end", type: "timestamp", indexed: true, width: "half" },
    { name: "cancel_at_period_end", type: "boolean", interface: "toggle", width: "half" },
    { name: "canceled_at", type: "timestamp", width: "half" },
    { name: "trial_end", type: "timestamp", width: "half" },
    METADATA_FIELD,
    SOURCE_CREATED_FIELD,
  ],
  invoice: [
    PROVIDER_FIELD,
    EXTERNAL_ID_FIELD,
    { name: "customer", type: "relation", to: "payment_customers", indexed: true },
    { name: "subscription", type: "relation", to: "payment_subscriptions", indexed: true },
    { name: "number", type: "text", width: "half" },
    {
      name: "status",
      type: "text",
      indexed: true,
      interface: "dropdown",
      width: "half",
      options: statusChoices(["draft", "open", "paid", "void", "uncollectible", "pending", "refunded"]),
    },
    money("amount_due", "Amount due"),
    money("amount_paid", "Amount paid"),
    money("amount_remaining", "Amount remaining"),
    { name: "currency", type: "text", width: "half" },
    { name: "hosted_url", type: "text", interface: "url", label: "Hosted invoice URL" },
    { name: "due_at", type: "timestamp", width: "half" },
    { name: "paid_at", type: "timestamp", indexed: true, width: "half" },
    METADATA_FIELD,
    SOURCE_CREATED_FIELD,
  ],
  payment: [
    PROVIDER_FIELD,
    EXTERNAL_ID_FIELD,
    { name: "customer", type: "relation", to: "payment_customers", indexed: true },
    { name: "invoice", type: "relation", to: "payment_invoices", indexed: true },
    money("amount", "Amount"),
    money("amount_refunded", "Amount refunded"),
    { name: "currency", type: "text", width: "half" },
    {
      name: "status",
      type: "text",
      indexed: true,
      interface: "dropdown",
      width: "half",
      options: statusChoices(["succeeded", "pending", "failed", "refunded", "canceled"]),
    },
    { name: "method", type: "text", width: "half" },
    { name: "failure_reason", type: "text", width: "half" },
    { name: "processed_at", type: "timestamp", indexed: true, width: "half" },
    METADATA_FIELD,
    SOURCE_CREATED_FIELD,
  ],
};

const COLLECTION_META: Record<
  PaymentRecordKind,
  { singular: string; plural: string; note: string; icon: string; sortOrder: number }
> = {
  customer: {
    singular: "Payment customer",
    plural: "Payment customers",
    note: "Billing accounts mirrored from the connected payment provider.",
    icon: "Users",
    sortOrder: 1,
  },
  subscription: {
    singular: "Subscription",
    plural: "Subscriptions",
    note: "Recurring plans mirrored from the connected payment provider.",
    icon: "RotateCcw",
    sortOrder: 2,
  },
  invoice: {
    singular: "Invoice",
    plural: "Invoices",
    note: "Billing documents mirrored from the connected payment provider.",
    icon: "ScrollText",
    sortOrder: 3,
  },
  payment: {
    singular: "Payment",
    plural: "Payment transactions",
    note: "Settled and attempted charges mirrored from the connected payment provider.",
    icon: "CreditCard",
    sortOrder: 4,
  },
};

export interface ProvisionResult {
  /** Slugs that this call created. */
  created: string[];
  /** Slugs that already existed as sync targets and were left untouched. */
  existing: string[];
  /**
   * Slugs already taken by a collection that ISN'T a sync target (no
   * `provider` / `external_id` columns). Nothing is written to these — the
   * admin has to rename their collection or ours. Surfaced rather than
   * silently skipped, because silently skipping is how billing data goes
   * missing without anyone noticing.
   */
  conflicts: string[];
}

/** Does this collection look like one of ours? A pre-existing collection with
 *  the same slug but none of our columns belongs to somebody else. */
const isSyncTarget = (collection: { fields: FieldDef[] }): boolean => {
  const names = new Set(collection.fields.map((f) => f.name));
  return PAYMENT_MARKER_COLUMNS.every((c) => names.has(c));
};

/**
 * Create the four sync targets if they're missing. Idempotent and additive —
 * an existing collection (even one an admin has extended with extra fields) is
 * never modified. Order matters: `payment_customers` first, because the other
 * three hold a relation to it.
 */
export async function ensurePaymentCollections(
  ctx: DbCtx,
  tenantId: string,
): Promise<ProvisionResult> {
  const created: string[] = [];
  const existing: string[] = [];
  const conflicts: string[] = [];
  for (const kind of PAYMENT_RECORD_KINDS) {
    const slug = PAYMENT_COLLECTION_SLUGS[kind];
    const m = COLLECTION_META[kind];
    const out = await createManagedCollection(ctx, tenantId, {
      slug,
      singular: m.singular,
      plural: m.plural,
      note: m.note,
      icon: m.icon,
      color: "teal",
      group: "Payments",
      sortOrder: m.sortOrder,
      displayTemplate: kind === "customer" ? "{{name}}" : "{{external_id}}",
      defaultSort: "-source_created_at",
      fields: PAYMENT_COLLECTION_FIELDS[kind],
      tenantScoped: true,
    });
    if (out.created) {
      created.push(slug);
      continue;
    }
    // Already there — but is it OURS? `createManagedCollection` is idempotent
    // on the slug, so it happily "skips" a collection that has nothing to do
    // with payments.
    try {
      const collection = await loadCollection(ctx, tenantId, slug);
      (isSyncTarget(collection) ? existing : conflicts).push(slug);
    } catch {
      // The slug is taken by a physical table with no active collection row
      // (archived / adopted-then-archived). Treat as a conflict — we can't
      // verify its shape, so we must not write to it.
      conflicts.push(slug);
    }
  }
  return { created, existing, conflicts };
}

// ── Writing normalized records into the collections ─────────────────────────

/**
 * Upsert normalized records into their collections. Rows are grouped by kind
 * and written in dependency order so a customer exists before the subscription
 * that points at it (relation integrity is app-level, but an ordered write
 * keeps the admin from flashing a dangling reference).
 *
 * A missing collection is provisioned on the spot: an admin who connects a
 * provider and immediately receives an event should not lose it.
 */
export async function applyPaymentRecords(
  ctx: Ctx,
  tenantId: string,
  records: PaymentRecord[],
): Promise<{ written: number; failed: number }> {
  if (records.length === 0) return { written: 0, failed: 0 };
  const byKind = new Map<PaymentRecordKind, Record<string, unknown>[]>();
  for (const r of records) {
    const list = byKind.get(r.kind) ?? [];
    list.push(r.row);
    byKind.set(r.kind, list);
  }

  let written = 0;
  let failed = 0;
  for (const kind of PAYMENT_RECORD_KINDS) {
    const rows = byKind.get(kind);
    if (!rows || rows.length === 0) continue;
    const slug = PAYMENT_COLLECTION_SLUGS[kind];
    let collection: Awaited<ReturnType<typeof loadCollection>>;
    try {
      collection = await loadCollection(ctx, tenantId, slug);
    } catch {
      await ensurePaymentCollections(ctx, tenantId);
      collection = await loadCollection(ctx, tenantId, slug);
    }
    // An adopted table is somebody else's data; refuse rather than write into it.
    if (collection.adopted) {
      throw new AppError(
        "VALIDATION",
        `Collection "${slug}" is adopted — payments sync only writes to managed collections`,
      );
    }
    // Same slug, different table. Writing here would either corrupt unrelated
    // business data or fail row-by-row and look like a clean sync.
    if (!isSyncTarget(collection)) {
      throw new AppError(
        "VALIDATION",
        `Collection "${slug}" already exists but isn't a payments sync target ` +
          `(no ${PAYMENT_MARKER_COLUMNS.join(" / ")} column). Rename it, then reconnect.`,
      );
    }
    // Last write wins within one batch: a reconcile page can legitimately
    // carry the same id twice (a Polar order maps to invoice + payment).
    const deduped = new Map<string, Record<string, unknown>>();
    for (const row of rows) deduped.set(String(row.id), row);
    const out = await ingestRows(ctx, collection, tenantId, [...deduped.values()], {
      mode: "upsert",
    });
    written += out.inserted + out.updated;
    failed += out.failed.length;
    if (out.failed.length > 0) {
      // A rejected row is a schema mismatch, not a transient blip. Throwing
      // marks the event `failed` with the reason and lets the provider retry —
      // the upsert is idempotent, so a retry after the admin fixes the column
      // simply lands. Reporting success here would lose the record silently.
      throw new AppError(
        "VALIDATION",
        `${out.failed.length} row(s) rejected by "${slug}": ${out.failed[0]?.error ?? "unknown"}`,
      );
    }
  }
  return { written, failed };
}

// ── Webhook receive path ────────────────────────────────────────────────────

export interface ReceiveWebhookInput {
  token: string;
  rawBody: string;
  headers: Headers | Record<string, string>;
  /** Injectable clock (ms) for the replay window — tests pin it. */
  nowMs?: number;
}

export type ReceiveOutcome =
  | { ok: true; status: "processed" | "duplicate" | "ignored"; eventId: string; written: number }
  | { ok: false; status: "unknown_token" | "disabled" | "invalid_signature"; reason?: string };

/**
 * Handle one inbound delivery: verify the signature over the RAW body, dedupe
 * on the provider's event id, normalize, then upsert.
 *
 * Dedupe is enforced by the unique index, not by a read-then-write — two
 * concurrent retries of the same delivery would both pass a `SELECT` check.
 * The insert is the lock: whoever loses the race gets `duplicate`.
 */
export async function receiveWebhook(
  ctx: Ctx,
  input: ReceiveWebhookInput,
): Promise<ReceiveOutcome> {
  const provider = await getProviderByToken(ctx, input.token);
  if (!provider) return { ok: false, status: "unknown_token" };
  if (provider.status !== "connected") return { ok: false, status: "disabled" };

  const config = await decryptConfig(
    provider.provider,
    (provider.config ?? {}) as Record<string, unknown>,
    ctx.env.AUTH_SECRET,
  );
  const secret = typeof config.webhookSecret === "string" ? config.webhookSecret : "";
  const verdict = await verifyPaymentSignature(provider.provider, {
    rawBody: input.rawBody,
    headers: input.headers,
    secret,
    // A callback provider signs with its merchant credentials rather than a
    // dedicated webhook secret, so it needs the whole decrypted config.
    config,
    nowMs: input.nowMs,
  });
  if (!verdict.ok) return { ok: false, status: "invalid_signature", reason: verdict.reason };

  let payload: unknown;
  if (isCallbackProvider(provider.provider)) {
    // Callback providers post application/x-www-form-urlencoded, not JSON.
    // MUST go through the shared parser: doing it here with
    // `Object.fromEntries` would take the LAST value of a repeated key while
    // the verifier took the FIRST, so a signed `status=failed` could be
    // recorded as a success.
    payload = parseCallbackBody(input.rawBody);
  } else {
    try {
      payload = JSON.parse(input.rawBody);
    } catch {
      return { ok: false, status: "invalid_signature", reason: "malformed_signature" };
    }
  }

  const headerEventId =
    typeof (input.headers as Headers).get === "function"
      ? (input.headers as Headers).get("webhook-id")
      : ((input.headers as Record<string, string>)["webhook-id"] ?? null);
  const normalized = normalizePaymentEvent(provider.provider, payload, { headerEventId });
  const eventId = normalized.eventId || crypto.randomUUID();
  const tenantId = provider.tenantId;

  const e = eventsTable(ctx.dialect);
  const rowId = crypto.randomUUID();
  const inserted = await (ctx.db as AnyDb)
    .insert(e)
    .values({
      id: rowId,
      tenantId,
      providerId: provider.id,
      externalId: eventId,
      type: normalized.type,
      status: "received",
      recordCount: normalized.records.length,
      payload: payload as Record<string, unknown>,
      createdAt: new Date(),
    })
    .onConflictDoNothing()
    .returning({ id: e.id });
  if (!Array.isArray(inserted) || inserted.length === 0) {
    return { ok: true, status: "duplicate", eventId, written: 0 };
  }

  const t = providersTable(ctx.dialect);
  await (ctx.db as AnyDb)
    .update(t)
    .set({ lastEventAt: new Date(), updatedAt: new Date() })
    .where(eq(t.id, provider.id));

  if (!tenantId || normalized.records.length === 0) {
    await (ctx.db as AnyDb)
      .update(e)
      .set({ status: "skipped", processedAt: new Date() })
      .where(eq(e.id, rowId));
    return { ok: true, status: "ignored", eventId, written: 0 };
  }

  try {
    const { written } = await applyPaymentRecords(ctx, tenantId, normalized.records);
    await (ctx.db as AnyDb)
      .update(e)
      .set({ status: "processed", processedAt: new Date() })
      .where(eq(e.id, rowId));
    return { ok: true, status: "processed", eventId, written };
  } catch (err) {
    // The event row stays as the audit trail of the failure; the provider gets
    // a 500 so its own retry schedule replays the delivery. The dedupe row is
    // cleared so that replay is actually allowed to re-apply.
    await (ctx.db as AnyDb)
      .update(e)
      .set({
        status: "failed",
        error: (err as Error)?.message ?? String(err),
        externalId: `${eventId}:failed:${rowId}`,
        processedAt: new Date(),
      })
      .where(eq(e.id, rowId));
    throw err;
  }
}

// ── Event log ───────────────────────────────────────────────────────────────

export interface ListEventsInput {
  providerId?: string;
  limit?: number;
}

export interface PaymentEventRow {
  id: string;
  providerId: string;
  externalId: string;
  type: string;
  status: string;
  recordCount: number;
  error: string | null;
  createdAt: Date | number | null;
  processedAt: Date | number | null;
}

export async function listPaymentEvents(
  ctx: DbCtx,
  tenantId: string,
  input: ListEventsInput = {},
): Promise<PaymentEventRow[]> {
  const e = eventsTable(ctx.dialect);
  const limit = Math.min(Math.max(input.limit ?? 50, 1), 200);
  const where = input.providerId
    ? and(tenantEq(e, tenantId), eq(e.providerId, input.providerId))
    : tenantEq(e, tenantId);
  const rows = (await (ctx.db as AnyDb)
    .select({
      id: e.id,
      providerId: e.providerId,
      externalId: e.externalId,
      type: e.type,
      status: e.status,
      recordCount: e.recordCount,
      error: e.error,
      createdAt: e.createdAt,
      processedAt: e.processedAt,
    })
    .from(e)
    .where(where)
    .orderBy(desc(e.createdAt))
    .limit(limit)) as PaymentEventRow[];
  return rows;
}

// ── Reconcile ───────────────────────────────────────────────────────────────

export interface ReconcileInput {
  providerId: string;
  /** Restrict to some record kinds; defaults to all four. */
  kinds?: PaymentRecordKind[];
  /** Hard cap on pages per kind, so one call can't run forever. */
  maxPages?: number;
  /** Start from the stored cursor instead of the top of the listing. */
  resume?: boolean;
  fetchImpl?: FetchLike;
}

export interface ReconcileResult {
  provider: string;
  written: number;
  failed: number;
  /** Per-kind page cursor after this run; null means "listing exhausted". */
  cursors: Record<string, string | null>;
  /** Set when a provider call failed — the run stops at that kind. */
  error?: string;
}

/** Pages per kind in one reconcile call. 20 × 100 objects is enough to walk a
 *  small account in one go without holding a Worker request open too long;
 *  larger accounts resume from the stored cursor on the next run. */
const DEFAULT_MAX_PAGES = 20;

/**
 * Pull objects back from the provider API and upsert them. This is what closes
 * the gap webhooks leave: deliveries that failed while the workspace was down,
 * objects created before the integration was connected, and any drift.
 *
 * Safe to run repeatedly — the same idempotent upsert as the webhook path.
 */
export async function reconcileProvider(
  ctx: Ctx,
  tenantId: string,
  input: ReconcileInput,
): Promise<ReconcileResult> {
  const row = await getProviderRow(ctx, tenantId, input.providerId);
  const config = await decryptConfig(
    row.provider,
    (row.config ?? {}) as Record<string, unknown>,
    ctx.env.AUTH_SECRET,
  );
  await ensurePaymentCollections(ctx, tenantId);

  // A callback provider has no listable object catalog — the callback IS the
  // whole surface. Walking pages would 404 forever; reporting a clean sync that
  // synced nothing would be worse.
  if (isCallbackProvider(row.provider)) {
    return {
      provider: row.provider,
      written: 0,
      failed: 0,
      cursors: (row.syncCursor ?? {}) as Record<string, string | null>,
      error:
        `${row.provider} is a callback-style provider: it reports each payment to the callback URL ` +
        `and exposes no object catalog to reconcile against.`,
    };
  }

  const kinds = input.kinds?.length ? input.kinds : [...PAYMENT_RECORD_KINDS];
  const maxPages = Math.min(Math.max(input.maxPages ?? DEFAULT_MAX_PAGES, 1), 100);
  const cursors: Record<string, string | null> = { ...(row.syncCursor ?? {}) };
  let written = 0;
  let failed = 0;
  let error: string | undefined;

  outer: for (const kind of kinds) {
    let cursor = input.resume ? (cursors[kind] ?? null) : null;
    for (let page = 0; page < maxPages; page++) {
      const res = await fetchPaymentPage({
        provider: row.provider,
        config,
        kind,
        cursor,
        fetchImpl: input.fetchImpl,
      });
      if (res.error) {
        error = `${kind}: ${res.error}`;
        break outer;
      }
      if (res.records.length > 0) {
        const out = await applyPaymentRecords(ctx, tenantId, res.records);
        written += out.written;
        failed += out.failed;
      }
      cursor = res.nextCursor;
      cursors[kind] = cursor;
      if (!cursor) break;
    }
  }

  const t = providersTable(ctx.dialect);
  await (ctx.db as AnyDb)
    .update(t)
    .set({
      syncCursor: cursors,
      lastSyncAt: new Date(),
      lastSyncError: error ?? null,
      updatedAt: new Date(),
    })
    .where(eq(t.id, row.id));

  return { provider: row.provider, written, failed, cursors, error };
}

/**
 * Every connected provider across every workspace, for the scheduled sweep.
 * Returns ids only — the caller enqueues one job per row rather than doing the
 * work inline, so a slow provider can't stall the tick.
 */
export async function listConnectedProviders(
  ctx: DbCtx,
): Promise<{ id: string; tenantId: string | null; provider: string }[]> {
  const t = providersTable(ctx.dialect);
  const rows = (await (ctx.db as AnyDb)
    .select({ id: t.id, tenantId: t.tenantId, provider: t.provider })
    .from(t)
    .where(eq(t.status, "connected"))) as { id: string; tenantId: string | null; provider: string }[];
  return rows.filter((r) => r.tenantId);
}

/** Total events recorded per status — the admin page's summary strip. */
export async function paymentEventStats(ctx: DbCtx, tenantId: string) {
  const e = eventsTable(ctx.dialect);
  const rows = (await (ctx.db as AnyDb)
    .select({ status: e.status, count: sql<number>`count(*)` })
    .from(e)
    .where(tenantEq(e, tenantId))
    .groupBy(e.status)) as { status: string; count: number | string }[];
  const out: Record<string, number> = {};
  for (const r of rows) out[r.status] = Number(r.count);
  return out;
}
