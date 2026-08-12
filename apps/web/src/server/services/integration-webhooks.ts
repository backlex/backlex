/**
 * Inbound webhooks — a provider calling us, landing where a pull would.
 *
 * The receiving half of `integration-syncs.ts`. That file walks a provider on a
 * schedule; this one is walked BY the provider, and everything downstream of the
 * verdict is deliberately the same code: same mapping, same `ingestSourceRecords`,
 * same namespaced ids. A delivery about an order the poll already imported
 * therefore updates that row rather than minting a second one beside it, which no
 * amount of care in two parallel implementations could have guaranteed.
 *
 * Three things are load-bearing here, and none of them is the HTTP.
 *
 * **The token is the only thing that says which workspace this is.** The request
 * arrives unauthenticated, so the token row is where tenancy begins — and every
 * query after it is scoped by the tenant that row named. It is looked up
 * WITHOUT a tenant filter for exactly that reason, and that is the one query in
 * this file where that is true.
 *
 * **The secret is checked before the body is believed.** `verify` runs against
 * the raw bytes, before anything is parsed and before any row is touched. A
 * failed check is a 400 that is never retried; an error THROWN while deciding is
 * a 5xx, because "we could not tell" and "it was forged" must not look the same
 * to a provider.
 *
 * **The delivery row is claimed before it is applied.** Retries are the normal
 * case — EasyPost six times, Trendyol every five minutes until it succeeds — so
 * the unique index on (sync, delivery id) is what makes a replay a duplicate
 * rather than a second write. A `failed` row is deliberately NOT a claim: the
 * provider is retrying because we failed, and refusing it would strand the one
 * delivery we most need.
 */

import { and, desc, eq, sql } from "drizzle-orm";
import * as pg from "@backlex/db/pg";
import * as sqlite from "@backlex/db/sqlite";
import { AppError } from "@backlex/core";
import {
  INTEGRATION_WEBHOOKS,
  matchesEventFilter,
  parseWebhookDelivery,
  providerFor,
  registerWebhook,
  unregisterWebhook,
  verifyWebhookDelivery,
  webhookFor,
  type FetchLike,
  type WebhookRecord,
} from "@backlex/integrations";
import type { Ctx } from "../context";
import { decryptSecret, encryptSecret, isEncryptedSecret } from "../lib/crypto";
import { loadCollection } from "./items/collection-loader";
import { ingestRows } from "./migrate-ingest";
import { queryAll } from "./items/sql-helpers";
import { ensureAccessToken } from "./integrations-oauth";
import {
  decryptConfig,
  getSyncRow,
  ingestSourceRecords,
  loadChildCollections,
  toPublicSync,
  webhookPathFor,
  type PublicSync,
  type SyncRow,
} from "./integration-syncs";

type AnyDb = any;

const syncsTableFor = (dialect: "pg" | "sqlite") =>
  (dialect === "pg"
    ? pg.schema.integrationSyncs
    : sqlite.schema.integrationSyncs) as typeof pg.schema.integrationSyncs;

const integrationsTableFor = (dialect: "pg" | "sqlite") =>
  (dialect === "pg" ? pg.schema.integrations : sqlite.schema.integrations) as typeof pg.schema.integrations;

const deliveriesTableFor = (dialect: "pg" | "sqlite") =>
  (dialect === "pg"
    ? pg.schema.integrationWebhookDeliveries
    : sqlite.schema.integrationWebhookDeliveries) as typeof pg.schema.integrationWebhookDeliveries;

/**
 * Records one delivery may carry.
 *
 * A marketplace posts one package; this exists for the day one posts a thousand
 * because a seller's catalogue was re-priced. Truncating is wrong (the rest are
 * never re-sent) so it refuses instead, which a retry-until-success provider
 * turns into a retry — and the poll picks the rest up regardless.
 */
const MAX_RECORDS_PER_DELIVERY = 500;

/** Deliveries shown in the panel. Enough to see a pattern, not a log viewer. */
const DELIVERY_PAGE = 50;

// ── The endpoint's lifecycle ─────────────────────────────────────────────────

export interface WebhookEndpoint {
  /** The full URL to give the provider, origin included. */
  url: string;
  /**
   * The secret, returned EXACTLY ONCE by the call that minted it.
   *
   * Null on a read. It is a bearer credential a third party also holds, and a
   * field that kept handing it back would put it in a browser cache, a
   * screenshot and an activity log. Lost means rotate.
   */
  secret: string | null;
  events: string[];
  /** True when we told the provider about this endpoint ourselves. */
  registered: boolean;
  /** Present when registration was possible and failed — the endpoint is live
   *  and the provider has not been told. */
  registrationError?: string;
}

/** The origin a provider will be told to call. */
const originOf = (ctx: Ctx): string => {
  const base = (ctx.env.APP_URL ?? "").replace(/\/+$/, "");
  if (!base) {
    // A relative path is not something a third party can post to, and inventing
    // an origin from a request header would let a caller choose where the
    // provider is pointed.
    throw new AppError("BAD_REQUEST", "Set APP_URL before turning on a webhook endpoint — a provider needs an absolute URL");
  }
  return base;
};

export const webhookUrlFor = (ctx: Ctx, token: string): string => `${originOf(ctx)}${webhookPathFor(token)}`;

/** A routing token. Opaque, and long enough that guessing one is not a strategy. */
const newToken = (): string => `${crypto.randomUUID()}${crypto.randomUUID()}`.replace(/-/g, "");

/**
 * A secret.
 *
 * The same construction as the token and for the same reason — 256 bits of
 * `randomUUID` — but a separate value: the token travels in a URL, which ends up
 * in the provider's logs and a proxy's access log, and a secret that could be
 * read off a URL would be no secret at all.
 */
const newSecret = (): string => `${crypto.randomUUID()}${crypto.randomUUID()}`.replace(/-/g, "");

/**
 * Which event keys this endpoint accepts.
 *
 * An empty list means every event the provider declares, matching the outbound
 * delivery filter. An unknown key is refused rather than dropped: a subscription
 * to an event that does not exist is silence, and silence is what an operator
 * came to this screen to fix.
 */
const validateEvents = (kind: string, events: readonly string[] | undefined): string[] => {
  if (!events || events.length === 0) return [];
  const declared = new Set((INTEGRATION_WEBHOOKS[kind]?.events ?? []).map((e) => e.key));
  const out: string[] = [];
  for (const raw of events) {
    const key = typeof raw === "string" ? raw.trim() : "";
    if (!key) continue;
    if (!declared.has(key)) {
      throw new AppError("VALIDATION", `${kind} does not send "${key}"`);
    }
    if (!out.includes(key)) out.push(key);
  }
  return out;
};

const loadSyncForEndpoint = async (
  ctx: Ctx,
  tenantId: string,
  syncId: string,
): Promise<{ row: SyncRow; kind: string; config: Record<string, unknown> }> => {
  const row = await getSyncRow(ctx, tenantId, syncId);
  if (!row) throw new AppError("NOT_FOUND", "Sync not found");
  const integrations = integrationsTableFor(ctx.dialect);
  const [integration] = (await (ctx.db as AnyDb)
    .select()
    .from(integrations)
    .where(and(eq(integrations.tenantId, tenantId), eq(integrations.id, row.integrationId)))) as {
    kind: string;
    config: Record<string, unknown> | null;
  }[];
  if (!integration) throw new AppError("NOT_FOUND", "Integration not found");
  if (!webhookFor(integration.kind)) {
    throw new AppError("BAD_REQUEST", `${integration.kind} does not send webhooks`);
  }
  // A delivery lands through THIS sync's collection and mapping — that is the
  // whole design, and it is why the endpoint lives on the sync rather than in a
  // table of its own. So only a sync that receives rows may have one. A
  // marketplace connected as a listing has the same webhook capability and the
  // same credentials, but its collection is the seller's PRODUCTS: turning an
  // endpoint on there would upsert incoming order packages into the product
  // catalog through a mapping written for listings. A push is refused for the
  // mirror-image reason — it has no landing at all.
  if (row.direction !== "pull" && row.direction !== "inbound") {
    throw new AppError(
      "VALIDATION",
      `A ${row.direction} sync has nowhere to put a delivery — turn the endpoint on from the sync that brings ${integration.kind} rows in`,
    );
  }
  return { row, kind: integration.kind, config: (integration.config ?? {}) as Record<string, unknown> };
};

/**
 * Turn the endpoint on, and tell the provider about it where we can.
 *
 * Idempotent on the token: calling it again keeps the same URL and mints a new
 * secret, which is what an operator who lost the first one needs. It is NOT
 * idempotent at the provider — a second registration would leave the first
 * behind delivering to the same URL — so an existing one is removed first.
 *
 * Registration failure does not roll the endpoint back. The token and secret are
 * real and the URL works; what failed is one API call an operator can retry, and
 * throwing here would discard a perfectly good secret they have already been
 * shown. The error travels back with the endpoint instead.
 */
export async function enableWebhook(
  ctx: Ctx,
  tenantId: string,
  syncId: string,
  input: { events?: readonly string[] } = {},
  fetchImpl?: FetchLike,
): Promise<WebhookEndpoint> {
  const { row, kind, config } = await loadSyncForEndpoint(ctx, tenantId, syncId);
  const hook = webhookFor(kind)!;
  if (hook.landing === "patch" && !row.matchField) {
    // Without it a delivery has a value and no column to find it in. Refused
    // here rather than at the first delivery, which would be a 500 an operator
    // sees hours later as "the carrier stopped updating".
    throw new AppError(
      "VALIDATION",
      `${kind} sends updates about existing rows — set the sync's match field before turning the endpoint on`,
    );
  }
  const events = validateEvents(kind, input.events ?? row.webhookEvents ?? []);

  const token = row.webhookToken ?? newToken();
  const secret = newSecret();
  const url = webhookUrlFor(ctx, token);

  // Remove ours before adding another, so re-enabling does not accumulate
  // registrations at the provider that all point here.
  await removeRegistration(ctx, kind, config, row, url, events, fetchImpl);

  let externalId: string | null = null;
  let registrationError: string | undefined;
  if (hook.register) {
    try {
      const live = await registerWebhook(
        kind,
        { config: await connectionConfig(ctx, kind, config, row.integrationId), url, secret, events },
        fetchImpl,
      );
      externalId = live.id;
    } catch (e) {
      registrationError = e instanceof Error ? e.message : String(e);
    }
  }

  const t = syncsTableFor(ctx.dialect);
  await (ctx.db as AnyDb)
    .update(t)
    .set({
      webhookToken: token,
      // Encrypted at rest like every other credential this workspace holds. The
      // verifier decrypts it per delivery; nothing reads it out to a caller.
      webhookSecret: await encryptSecret(secret, ctx.env.AUTH_SECRET),
      webhookEvents: events,
      webhookExternalId: externalId,
      updatedAt: new Date(),
    })
    .where(and(eq(t.tenantId, tenantId), eq(t.id, syncId)));

  return {
    url,
    secret,
    events,
    registered: Boolean(externalId),
    ...(registrationError ? { registrationError } : {}),
  };
}

/**
 * Turn it off.
 *
 * The provider is asked to stop first, but its answer does not decide anything:
 * the columns are cleared either way. An operator turning off a firehose cannot
 * be blocked by the firehose being unreachable — and once the token is gone the
 * deliveries resolve to nothing, which is a 404 for the provider and no rows
 * for us.
 */
export async function disableWebhook(
  ctx: Ctx,
  tenantId: string,
  syncId: string,
  fetchImpl?: FetchLike,
): Promise<void> {
  const { row, kind, config } = await loadSyncForEndpoint(ctx, tenantId, syncId);
  if (!row.webhookToken) return;
  await removeRegistration(
    ctx,
    kind,
    config,
    row,
    webhookUrlFor(ctx, row.webhookToken),
    row.webhookEvents ?? [],
    fetchImpl,
  );

  const t = syncsTableFor(ctx.dialect);
  await (ctx.db as AnyDb)
    .update(t)
    .set({
      webhookToken: null,
      webhookSecret: null,
      webhookExternalId: null,
      updatedAt: new Date(),
    })
    .where(and(eq(t.tenantId, tenantId), eq(t.id, syncId)));
}

/** Best-effort: a registration we cannot remove is noise, not a reason to stop. */
const removeRegistration = async (
  ctx: Ctx,
  kind: string,
  config: Record<string, unknown>,
  row: SyncRow,
  url: string,
  events: readonly string[],
  fetchImpl?: FetchLike,
): Promise<void> => {
  if (!row.webhookExternalId) return;
  try {
    await unregisterWebhook(
      kind,
      {
        config: await connectionConfig(ctx, kind, config, row.integrationId),
        url,
        secret: "",
        events,
        id: row.webhookExternalId,
      },
      fetchImpl,
    );
  } catch {
    // Deliberately swallowed. See `unregisterWebhook`'s contract: the caller
    // removes its own subscription regardless, and the alternative is an
    // operator who cannot disable an endpoint because the provider is down.
  }
};

/** Decrypted config, with a fresh OAuth token for the providers that use one. */
const connectionConfig = async (
  ctx: Ctx,
  kind: string,
  stored: Record<string, unknown>,
  integrationId: string,
): Promise<Record<string, unknown>> => {
  const config = await decryptConfig(kind, stored, ctx.env.AUTH_SECRET);
  if (!providerFor(kind)?.oauth) return config;
  const token = await ensureAccessToken(
    ctx,
    { id: integrationId, kind, config: stored } as never,
    ctx.env.AUTH_SECRET,
  );
  if (!token) throw new AppError("UNAUTHORIZED", "OAuth connection needs re-authorizing");
  return { ...config, _oauthAccessToken: token };
};

/** Change which events this endpoint accepts, at the provider too where it can. */
export async function updateWebhookEvents(
  ctx: Ctx,
  tenantId: string,
  syncId: string,
  events: readonly string[],
  fetchImpl?: FetchLike,
): Promise<PublicSync> {
  const { row, kind } = await loadSyncForEndpoint(ctx, tenantId, syncId);
  if (!row.webhookToken) throw new AppError("BAD_REQUEST", "This sync has no webhook endpoint");
  const next = validateEvents(kind, events);

  const t = syncsTableFor(ctx.dialect);
  await (ctx.db as AnyDb)
    .update(t)
    .set({ webhookEvents: next, updatedAt: new Date() })
    .where(and(eq(t.tenantId, tenantId), eq(t.id, syncId)));

  // A provider that filters server-side has to be told, or a deselected event
  // keeps arriving and is dropped here — which works, and wastes every delivery.
  // Re-registering is the only way to say so on both providers that ship with
  // this, so the endpoint is re-announced with the same URL and a new secret.
  if (row.webhookExternalId) await enableWebhook(ctx, tenantId, syncId, { events: next }, fetchImpl);

  const updated = await getSyncRow(ctx, tenantId, syncId);
  if (!updated) throw new Error("sync row missing after update");
  return toPublicSync(updated);
}

// ── Receiving ────────────────────────────────────────────────────────────────

export type DeliveryStatus =
  /** Records landed. */
  | "applied"
  /** A body this provider does not recognise — a ping, or a new event kind. */
  | "ignored"
  /** A real event the subscription is not subscribed to. */
  | "filtered"
  /** Seen before. The provider is retrying something already applied. */
  | "duplicate"
  /** Understood, verified, and no row in the collection holds the id it names. */
  | "unmatched"
  /** The secret did not check out. */
  | "rejected"
  /** Our failure. Recorded so the retry has something to compare against. */
  | "failed";

export type ReceiveOutcome =
  | { ok: true; status: Exclude<DeliveryStatus, "rejected" | "failed">; written: number }
  | { ok: false; status: "unknown_token" | "disabled" | "rejected"; reason?: string };

export interface ReceiveInput {
  token: string;
  /** MUST be the exact bytes the provider sent — a signature covers those. */
  rawBody: string;
  headers: Headers | Record<string, string>;
}

/**
 * Apply one delivery.
 *
 * Throws only on OUR failures, which the route turns into a 5xx so the provider
 * retries. Everything the provider could be responsible for — an unknown token,
 * a bad secret, an unrecognised body — comes back as an outcome, because those
 * need a 4xx and a retry would never fix them.
 */
export async function receiveDelivery(ctx: Ctx, input: ReceiveInput): Promise<ReceiveOutcome> {
  const found = await findByToken(ctx, input.token);
  if (!found) return { ok: false, status: "unknown_token" };
  const { row, kind, config, integrationStatus } = found;

  // A disabled sync is an operator saying "stop". Answering 4xx is what makes a
  // provider stop retrying rather than queue an hour of deliveries to replay the
  // moment it is re-enabled.
  if (!row.enabled) return { ok: false, status: "disabled" };
  if (integrationStatus !== "connected") return { ok: false, status: "disabled" };
  if (!webhookFor(kind)) return { ok: false, status: "disabled" };

  const secret = await readSecret(ctx, row);
  if (!secret) {
    // A token with no secret is a half-written endpoint, not an authenticated
    // request. Refusing is the only safe reading.
    return { ok: false, status: "rejected", reason: "no_secret" };
  }

  const decrypted = await decryptConfig(kind, config, ctx.env.AUTH_SECRET);
  // Before the body is parsed and before any row is touched. `verify` returning
  // false is a verdict; throwing out of it is our own failure and propagates as
  // a 5xx rather than being read as a forgery.
  const genuine = await verifyWebhookDelivery(kind, {
    rawBody: input.rawBody,
    headers: input.headers,
    secret,
    config: decrypted,
  });
  if (!genuine) {
    await recordDelivery(ctx, row, {
      event: "unverified",
      deliveryId: await digest(input.rawBody),
      status: "rejected",
      rowsWritten: 0,
      error: "the delivery did not present the endpoint's secret",
    });
    return { ok: false, status: "rejected", reason: "signature_mismatch" };
  }

  const delivery = parseWebhookDelivery(kind, {
    rawBody: input.rawBody,
    headers: input.headers,
    config: decrypted,
  });
  if (!delivery) {
    // Recorded and accepted. A 4xx here would have Trendyol deactivate a working
    // endpoint over a ping, and a 5xx would have EasyPost retry a body it will
    // never send differently.
    await recordDelivery(ctx, row, {
      event: "unrecognised",
      deliveryId: await digest(input.rawBody),
      status: "ignored",
      rowsWritten: 0,
    });
    return { ok: true, status: "ignored", written: 0 };
  }

  /**
   * The identity a retry is recognised by.
   *
   * A provider's own event id when it sends one. Otherwise a digest of the body,
   * which is weaker in one specific way worth stating: two genuinely distinct
   * deliveries with identical bytes collapse into one. For a status change that
   * is the same write twice, so collapsing costs nothing — whereas leaving the
   * guard off would let a retry re-apply, which for an upsert of a stale payload
   * means walking a row backwards.
   */
  const deliveryId = delivery.deliveryId ?? (await digest(input.rawBody));

  const claim = await claimDelivery(ctx, row, delivery.event, deliveryId);
  if (claim === "duplicate") return { ok: true, status: "duplicate", written: 0 };

  const subscribed = row.webhookEvents ?? [];
  const wanted = delivery.records.filter((r) => matchesEventFilter(subscribed, r.event ?? delivery.event));
  if (wanted.length === 0) {
    // Two different facts, one answer: either the whole delivery is for an event
    // this endpoint does not want, or it carried no records at all. Both are
    // "understood, nothing to do", and both are worth being visible in the log.
    const status: DeliveryStatus =
      delivery.records.length === 0 || matchesEventFilter(subscribed, delivery.event) ? "ignored" : "filtered";
    await settleDelivery(ctx, claim.id, { status, rowsWritten: 0 });
    return { ok: true, status, written: 0 };
  }
  if (wanted.length > MAX_RECORDS_PER_DELIVERY) {
    const error = `delivery carried ${wanted.length} records, more than the ${MAX_RECORDS_PER_DELIVERY} one request may apply`;
    await settleDelivery(ctx, claim.id, { status: "failed", rowsWritten: 0, error });
    // Our limit, so it reads as our failure: the provider retries, and the
    // scheduled pull picks the rows up in the meantime.
    throw new AppError("BAD_REQUEST", error);
  }

  try {
    const applied = await applyRecords(ctx, row, kind, wanted);
    const status: DeliveryStatus = applied.written > 0 ? "applied" : "unmatched";
    await settleDelivery(ctx, claim.id, {
      status,
      rowsWritten: applied.written,
      ...(applied.unmatched.length > 0
        ? { error: `no row matched: ${applied.unmatched.slice(0, 5).join(", ")}` }
        : {}),
    });
    return { ok: true, status, written: applied.written };
  } catch (e) {
    const error = e instanceof Error ? e.message : String(e);
    // Left as `failed` rather than deleted, and that is what lets the retry
    // through: `claimDelivery` treats a failed row as unclaimed, because the
    // provider is retrying precisely because we failed.
    await settleDelivery(ctx, claim.id, { status: "failed", rowsWritten: 0, error });
    throw e;
  }
}

/**
 * Which workspace owns this endpoint, or null.
 *
 * The route needs it before any work happens: an unauthenticated request cannot
 * be metered or quota-checked until something says whose it is, and the token row
 * is the only thing that does. Deliberately a second, narrow read rather than
 * threading the whole row out of {@link receiveDelivery} — the same shape the
 * payment receiver uses, and the cost is one indexed lookup on a request that is
 * about to do considerably more than that.
 */
export async function tenantForWebhookToken(ctx: Ctx, token: string): Promise<string | null> {
  const found = await findByToken(ctx, token);
  return found?.row.tenantId ?? null;
}

/** The subscription this token names, and the connection behind it. */
const findByToken = async (
  ctx: Ctx,
  token: string,
): Promise<
  | { row: SyncRow; kind: string; config: Record<string, unknown>; integrationStatus: string }
  | null
> => {
  // Bounded before it reaches a query: the token is a fixed-length hex string,
  // and anything else is a probe rather than a delivery.
  if (!/^[0-9a-f]{32,128}$/.test(token)) return null;
  const t = syncsTableFor(ctx.dialect);
  // The one query here with no tenant filter, because the token is what
  // establishes the tenant. Everything after this is scoped by `row.tenantId`.
  const [row] = (await (ctx.db as AnyDb).select().from(t).where(eq(t.webhookToken, token))) as SyncRow[];
  if (!row) return null;

  const integrations = integrationsTableFor(ctx.dialect);
  const [integration] = (await (ctx.db as AnyDb)
    .select()
    .from(integrations)
    .where(and(eq(integrations.tenantId, row.tenantId), eq(integrations.id, row.integrationId)))) as {
    kind: string;
    config: Record<string, unknown> | null;
    status: string;
  }[];
  if (!integration) return null;
  return {
    row,
    kind: integration.kind,
    config: (integration.config ?? {}) as Record<string, unknown>,
    integrationStatus: integration.status,
  };
};

const readSecret = async (ctx: Ctx, row: SyncRow): Promise<string | null> => {
  const stored = row.webhookSecret;
  if (typeof stored !== "string" || !stored) return null;
  if (!isEncryptedSecret(stored)) return stored;
  return (await decryptSecret(stored, ctx.env.AUTH_SECRET)) ?? null;
};

/** SHA-256 of the body, hex — the delivery id for a provider that sends none. */
const digest = async (body: string): Promise<string> => {
  const bytes = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(body));
  return Array.from(new Uint8Array(bytes), (b) => b.toString(16).padStart(2, "0")).join("");
};

// ── Landing the records ──────────────────────────────────────────────────────

/**
 * Write what the delivery said, the way this provider's landing describes.
 *
 * `upsert` goes through the sync's own ingest, which is what makes a webhook and
 * a poll converge on one row. `patch` finds the row that holds the id the
 * delivery names and writes only the fields it carried — an upsert there would
 * mint an emptier second fulfillment beside the one a person and a booking task
 * built.
 */
const applyRecords = async (
  ctx: Ctx,
  row: SyncRow,
  kind: string,
  records: readonly WebhookRecord[],
): Promise<{ written: number; unmatched: string[] }> => {
  const collection = await loadCollection(ctx, row.tenantId, row.collection);
  const landing = webhookFor(kind)?.landing ?? "upsert";

  if (landing === "upsert") {
    const children = await loadChildCollections(ctx, row.tenantId, row);
    const written = await ingestSourceRecords(
      ctx,
      row.tenantId,
      row,
      kind,
      records.map((r) => ({ externalId: r.externalId, data: r.data, ...(r.children ? { children: r.children } : {}) })),
      collection,
      children,
    );
    return { written, unmatched: [] };
  }

  const matchField = row.matchField;
  if (!matchField) {
    // Cannot happen through the admin path — `enableWebhook` refuses it — but a
    // row edited by hand would otherwise silently match every record to nothing.
    throw new AppError("VALIDATION", `Sync ${row.id} patches rows but names no match field`);
  }
  const stored = new Set(collection.fields.filter((f) => !f.computed).map((f) => f.name));
  if (!stored.has(matchField)) {
    throw new AppError("VALIDATION", `Collection "${collection.slug}" has no stored field "${matchField}"`);
  }

  let written = 0;
  const unmatched: string[] = [];
  for (const record of records) {
    const target = await findRowByMatch(ctx, collection, row.tenantId, matchField, record.externalId);
    if (!target) {
      // Not an error. A carrier account can hold consignments this workspace did
      // not book, and a delivery about one of those has nothing here to change.
      unmatched.push(record.externalId);
      continue;
    }
    const patch: Record<string, unknown> = { [collection.pkColumn]: target };
    for (const [external, field] of Object.entries(row.mapping ?? {})) {
      if (record.data[external] !== undefined) patch[field] = record.data[external];
    }
    if (Object.keys(patch).length === 1) continue;

    // `patch`, not `upsert`: the column plan is built from the keys present, so
    // writing a tracking status cannot blank the fulfillment's order, location
    // and shipped-at date on its way past. Same reason the task write-back does.
    const out = await ingestRows(ctx, collection, row.tenantId, [patch], { mode: "patch" });
    if (out.failed.length > 0) {
      throw new AppError(
        "VALIDATION",
        `writing to "${collection.slug}" failed: ${out.failed[0]?.error ?? "unknown"}`,
      );
    }
    written += out.inserted + out.updated;
  }
  return { written, unmatched };
};

/**
 * The primary key of the row holding this external id, or null.
 *
 * Tenant-scoped where the collection is, because the token established one
 * workspace and a shared physical table must not be read across it. `LIMIT 1`
 * with no ordering: two rows carrying one carrier's shipment id is a data
 * problem, and picking either is better than refusing the update outright.
 */
const findRowByMatch = async (
  ctx: Ctx,
  collection: Awaited<ReturnType<typeof loadCollection>>,
  tenantId: string,
  field: string,
  value: string,
): Promise<string | null> => {
  const scope = collection.tenantScoped ? sql` AND ${sql.identifier("tenant_id")} = ${tenantId}` : sql``;
  const rows = await queryAll<Record<string, unknown>>(
    ctx,
    sql`SELECT ${sql.identifier(collection.pkColumn)} AS id FROM ${sql.identifier(collection.physicalTable)} WHERE ${sql.identifier(field)} = ${value}${scope} LIMIT 1`,
  );
  const id = rows[0]?.id;
  return id === undefined || id === null ? null : String(id);
};

// ── The delivery log ─────────────────────────────────────────────────────────

/**
 * Claim this delivery, or report that it has already been handled.
 *
 * The unique index on (sync, delivery id) is the guard, not this code: two
 * concurrent deliveries of the same event race to INSERT and one loses. The
 * loser reads back what is there — and a `failed` row is treated as unclaimed,
 * because a provider retrying our failure must be allowed through.
 */
const claimDelivery = async (
  ctx: Ctx,
  row: SyncRow,
  event: string,
  deliveryId: string,
): Promise<{ id: string } | "duplicate"> => {
  const t = deliveriesTableFor(ctx.dialect);
  const id = crypto.randomUUID();
  try {
    await (ctx.db as AnyDb).insert(t).values({
      id,
      tenantId: row.tenantId,
      syncId: row.id,
      integrationId: row.integrationId,
      event: event.slice(0, 100),
      deliveryId: deliveryId.slice(0, 200),
      status: "running",
      rowsWritten: 0,
      createdAt: new Date(),
    });
    return { id };
  } catch {
    const [existing] = (await (ctx.db as AnyDb)
      .select()
      .from(t)
      .where(and(eq(t.syncId, row.id), eq(t.deliveryId, deliveryId.slice(0, 200))))) as {
      id: string;
      status: string;
    }[];
    if (!existing) throw new AppError("INTERNAL", "Could not record the delivery");
    if (existing.status === "failed" || existing.status === "running") {
      // Not a claim. A failed attempt is the reason the provider is calling
      // again, and a `running` row from an invocation that died mid-flight would
      // otherwise wedge this delivery out forever.
      await (ctx.db as AnyDb)
        .update(t)
        .set({ status: "running", error: null, event: event.slice(0, 100) })
        .where(eq(t.id, existing.id));
      return { id: existing.id };
    }
    return "duplicate";
  }
};

const settleDelivery = async (
  ctx: Ctx,
  id: string,
  outcome: { status: DeliveryStatus; rowsWritten: number; error?: string },
): Promise<void> => {
  const t = deliveriesTableFor(ctx.dialect);
  await (ctx.db as AnyDb)
    .update(t)
    .set({
      status: outcome.status,
      rowsWritten: outcome.rowsWritten,
      error: outcome.error ? outcome.error.slice(0, 500) : null,
    })
    .where(eq(t.id, id));
};

/** Record a delivery that never got as far as being claimed. */
const recordDelivery = async (
  ctx: Ctx,
  row: SyncRow,
  entry: { event: string; deliveryId: string; status: DeliveryStatus; rowsWritten: number; error?: string },
): Promise<void> => {
  const claim = await claimDelivery(ctx, row, entry.event, entry.deliveryId);
  if (claim === "duplicate") return;
  await settleDelivery(ctx, claim.id, entry);
};

export interface PublicDelivery {
  id: string;
  syncId: string;
  event: string;
  status: string;
  rowsWritten: number;
  error: string | null;
  createdAt: Date | number | null;
}

/**
 * This subscription's recent deliveries, newest first.
 *
 * The whole health story for an endpoint, which is why the sync row has no
 * `webhook_last_*` columns: one place records what happened, so there is nothing
 * to fall out of step with.
 */
export async function listDeliveries(
  ctx: Ctx,
  tenantId: string,
  syncId: string,
  limit = DELIVERY_PAGE,
): Promise<PublicDelivery[]> {
  const t = deliveriesTableFor(ctx.dialect);
  const rows = (await (ctx.db as AnyDb)
    .select()
    .from(t)
    .where(and(eq(t.tenantId, tenantId), eq(t.syncId, syncId)))
    .orderBy(desc(t.createdAt))
    .limit(Math.min(Math.max(1, limit), DELIVERY_PAGE))) as any[];
  return rows.map((r) => ({
    id: r.id,
    syncId: r.syncId,
    event: r.event,
    status: r.status,
    rowsWritten: r.rowsWritten ?? 0,
    error: r.error ?? null,
    createdAt: r.createdAt ?? null,
  }));
}
