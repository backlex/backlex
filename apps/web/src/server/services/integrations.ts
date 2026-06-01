/**
 * Workspace integrations (Slack/Discord/Datadog/GitHub) for the project admin.
 *
 * Mirrors the cloud control plane, but the event source here is the DATA plane:
 * `dispatchIntegrations` is called from `publishEvent` on every record
 * created/updated/deleted and fans out to connected integrations via the shared
 * `@backlex/integrations` adapters. Secret config fields are encrypted at rest
 * with AUTH_SECRET (like SSO/email config) and masked on read.
 */
import { and, desc, eq, isNull } from "drizzle-orm";
import * as pg from "@backlex/db/pg";
import * as sqlite from "@backlex/db/sqlite";
import type { PgDb } from "@backlex/db/pg";
import type { SqliteDb } from "@backlex/db/sqlite";
import {
  SECRET_KEYS,
  deliverToIntegration,
  isIntegrationKind,
  maskConfig,
  matchesEventFilter,
  type FetchLike,
  type IntegrationKind,
} from "@backlex/integrations";
import type { Env } from "../env";
import { decryptSecret, encryptSecret, isEncryptedSecret } from "../lib/crypto";

type DbCtx = { db: PgDb | SqliteDb; dialect: "pg" | "sqlite" };
// The PgDb|SqliteDb union can't be queried without per-dialect narrowing; the
// table is the right shape for both, so queries go through this hatch (mirrors
// services/webhooks.ts's `(ctx.db as any)`).
type AnyDb = any;

// Both dialects' columns are query-compatible; type as the PG table so column
// access (`t.tenantId`) is concrete rather than a `never`-collapsing union.
// The DB itself is queried via `AnyDb`, so runtime uses the real dialect table.
const tableFor = (dialect: "pg" | "sqlite") =>
  (dialect === "pg" ? pg.schema.integrations : sqlite.schema.integrations) as typeof pg.schema.integrations;

const tenantEq = (t: typeof pg.schema.integrations, tenantId: string | null) =>
  tenantId === null ? isNull(t.tenantId) : eq(t.tenantId, tenantId);

export interface IntegrationRow {
  id: string;
  tenantId: string | null;
  kind: string;
  config: Record<string, unknown>;
  events: string[] | null;
  status: string;
  lastEventAt: Date | number | null;
  createdAt: Date | number | null;
}

const secretKeys = (kind: string) => new Set(SECRET_KEYS[kind as IntegrationKind] ?? []);

async function encryptConfig(kind: string, config: Record<string, unknown>, secret: string) {
  const keys = secretKeys(kind);
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(config)) {
    out[k] =
      keys.has(k) && typeof v === "string" && v && !isEncryptedSecret(v) ? await encryptSecret(v, secret) : v;
  }
  return out;
}

async function decryptConfig(kind: string, config: Record<string, unknown>, secret: string) {
  const keys = secretKeys(kind);
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(config)) {
    out[k] = keys.has(k) && typeof v === "string" && isEncryptedSecret(v) ? ((await decryptSecret(v, secret)) ?? "") : v;
  }
  return out;
}

/** Public (masked) view of an integration row — never leaks decrypted secrets. */
export function toPublic(row: IntegrationRow) {
  return {
    id: row.id,
    kind: row.kind,
    events: row.events,
    status: row.status,
    config: maskConfig(row.kind, (row.config ?? {}) as Record<string, unknown>),
    lastEventAt: row.lastEventAt,
    createdAt: row.createdAt,
  };
}

/** Connect (or update) an integration for a workspace. One row per (tenant, kind). */
export async function connectIntegration(
  ctx: DbCtx,
  input: { tenantId: string | null; kind: string; config?: Record<string, unknown>; events?: string[] | null },
  authSecret: string,
): Promise<ReturnType<typeof toPublic>> {
  if (!isIntegrationKind(input.kind)) throw new Error(`Unknown integration kind: ${input.kind}`);
  const t = tableFor(ctx.dialect);
  const config = await encryptConfig(input.kind, input.config ?? {}, authSecret);
  const events = input.events ?? null;
  const db = ctx.db as AnyDb;

  const existing = (await db
    .select()
    .from(t)
    .where(and(tenantEq(t, input.tenantId), eq(t.kind, input.kind)))) as IntegrationRow[];

  if (existing[0]) {
    await db
      .update(t)
      .set({ config, events, status: "connected", updatedAt: new Date() })
      .where(eq(t.id, existing[0].id));
    const [row] = (await db.select().from(t).where(eq(t.id, existing[0].id))) as IntegrationRow[];
    if (!row) throw new Error("integration row missing after update");
    return toPublic(row);
  }

  const id = crypto.randomUUID();
  await db.insert(t).values({ id, tenantId: input.tenantId, kind: input.kind, config, events, status: "connected" });
  const [row] = (await db.select().from(t).where(eq(t.id, id))) as IntegrationRow[];
  if (!row) throw new Error("integration row missing after insert");
  return toPublic(row);
}

export async function listIntegrations(ctx: DbCtx, tenantId: string | null) {
  const t = tableFor(ctx.dialect);
  const rows = (await (ctx.db as AnyDb)
    .select()
    .from(t)
    .where(tenantEq(t, tenantId))
    .orderBy(desc(t.createdAt))) as IntegrationRow[];
  return rows.map(toPublic);
}

export async function disconnectIntegration(ctx: DbCtx, tenantId: string | null, id: string): Promise<void> {
  const t = tableFor(ctx.dialect);
  await (ctx.db as AnyDb).delete(t).where(and(tenantEq(t, tenantId), eq(t.id, id)));
}

/**
 * Fan a data event out to the workspace's connected integrations. Called from
 * `publishEvent` (fire-and-forget). Best-effort; never throws into the caller.
 */
export async function dispatchIntegrations(
  env: Env,
  ctx: DbCtx,
  channel: string,
  evt: { event: string; data: unknown },
  fetchImpl?: FetchLike,
): Promise<void> {
  const t = tableFor(ctx.dialect);
  const data = evt.data as Record<string, unknown> | null | undefined;
  const tenantId = (data && typeof data === "object" ? (data.tenantId ?? data.tenant_id) : null) as
    | string
    | null
    | undefined;
  const where = tenantId ? and(eq(t.status, "connected"), eq(t.tenantId, tenantId)) : eq(t.status, "connected");
  const rows = (await (ctx.db as AnyDb).select().from(t).where(where)) as IntegrationRow[];
  if (rows.length === 0) return;

  const collection = channel.startsWith("items:") ? channel.slice("items:".length) : channel;
  const eventName = `${collection}.${evt.event}`;
  const id = data && typeof data === "object" ? data.id : undefined;
  const text = `${collection}: record ${evt.event}${id ? ` #${String(id)}` : ""}`;
  const payload = { collection, event: evt.event, id };

  for (const row of rows) {
    if (!matchesEventFilter(row.events, eventName)) continue;
    const cfg = await decryptConfig(row.kind, (row.config ?? {}) as Record<string, unknown>, env.AUTH_SECRET);
    const out = await deliverToIntegration(row.kind, cfg, { event: eventName, text, payload }, fetchImpl);
    if (out.ok) {
      await (ctx.db as AnyDb).update(t).set({ lastEventAt: new Date() }).where(eq(t.id, row.id));
    }
  }
}
