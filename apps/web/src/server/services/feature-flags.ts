import { and, eq, isNull, or } from "drizzle-orm";
import * as pg from "@backlex/db/pg";
import * as sqlite from "@backlex/db/sqlite";
import { matchesCondition } from "@backlex/db";
import type { AuthSubject, Condition } from "@backlex/core";
import type { Ctx } from "../context";

/**
 * Feature flags / remote config.
 *
 * A flag row is `(tenantId, key)`. A `tenantId IS NULL` row is the global
 * default; a per-tenant row with the same key overrides it. Each flag carries
 * `enabled`, a `value` (remote-config payload), and optional `rules`:
 *   - `condition` — a permission-DSL condition resolved against the caller's
 *     `$user` / `$tenant` (e.g. `{ "$user.roles": { "_contains": "beta" } }`).
 *   - `rollout` — 0–100 percentage, stable per `identity+key` (so the same
 *     caller stays in or out of the bucket across calls). The identity is the
 *     caller's `bucketKey` when one is supplied, else their user id or email.
 *     See `passesRules` for why a logged-out visitor MUST supply one.
 *
 * `evaluateFlags` resolves every flag for a caller; `/api/flags` serves the map.
 */

export interface FlagRow {
  id: string;
  tenantId: string | null;
  key: string;
  enabled: boolean;
  value: unknown;
  rules: { condition?: Condition; rollout?: number } | null;
  description: string | null;
  createdAt: Date | number;
  updatedAt: Date | number;
}

export interface EvaluatedFlag {
  enabled: boolean;
  value: unknown;
}

const tableFor = (dialect: "pg" | "sqlite") =>
  dialect === "pg" ? pg.schema.featureFlags : sqlite.schema.featureFlags;

const nowFor = (dialect: "pg" | "sqlite"): Date | number =>
  dialect === "pg" ? new Date() : Date.now();

/** Deterministic 0–99 bucket from a string (FNV-1a). Same input → same bucket,
 *  so a user's rollout membership is stable across requests. */
const bucketOf = (s: string): number => {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0) % 100;
};

/**
 * Who a rollout percentage buckets on.
 *
 * A rollout is only a SPLIT if different callers hash differently. Until
 * 2026-08-27 this fell back to the literal string `"anon"`, which meant every
 * logged-out visitor on earth shared one bucket per key: measured against a
 * live workspace, a flag at rollout 67 was off for everybody and at 68 was on
 * for everybody. That is a step function, not a rollout — and it broke the one
 * case a rollout percentage exists for, splitting traffic on a public page
 * where nobody is signed in.
 *
 * So an anonymous caller has to say who it is. `bucketKey` is whatever the
 * caller decides is stable for one visitor — the analytics visitor id is the
 * obvious one, since a site running the tag already has it — and it is only
 * ever hashed, never stored or returned.
 *
 * Returning `null` rather than a constant is the point: it is the difference
 * between "this visitor is outside the bucket" and "nobody told me which
 * visitor this is", and only the second one is a configuration mistake worth
 * surfacing (which `rolloutNeedsBucketKey` does, at write time).
 */
const bucketIdentity = (auth: AuthSubject, bucketKey?: string): string | null => {
  const explicit = bucketKey?.trim();
  if (explicit) return explicit;
  return auth.userId ?? auth.email ?? null;
};

/** True when a flag's rollout can only be honoured for callers that identify
 *  themselves — i.e. a partial rollout, which anonymous traffic cannot join
 *  without a `bucketKey`. Used to warn at write time. */
export const rolloutNeedsBucketKey = (
  rules: { rollout?: number } | null | undefined,
): boolean =>
  typeof rules?.rollout === "number" && rules.rollout > 0 && rules.rollout < 100;

/** A flag passes targeting when its condition matches AND the caller falls in
 *  the rollout bucket. No rules → always on (when enabled).
 *
 *  Targeting conditions match against a synthetic **caller-context row** —
 *  `{ user_id, email, roles, tenant_id }` — so a rule reads naturally, e.g.
 *  `{ "roles": { "_contains": "beta" } }` or `{ "email": { "_eq": "a@b.com" } }`.
 *  `$user.*` / `$now` variables still resolve from `auth` on the value side. */
const passesRules = (
  flag: FlagRow,
  auth: AuthSubject,
  bucketKey?: string,
): boolean => {
  const rules = flag.rules;
  if (!rules) return true;
  const contextRow: Record<string, unknown> = {
    user_id: auth.userId,
    email: auth.email,
    roles: auth.roles,
    tenant_id: auth.tenantId ?? null,
  };
  if (rules.condition && !matchesCondition(contextRow, rules.condition, auth)) return false;
  if (typeof rules.rollout === "number" && rules.rollout < 100) {
    if (rules.rollout <= 0) return false;
    const id = bucketIdentity(auth, bucketKey);
    // No identity at all — see ANONYMOUS_BUCKET. A rollout below 100 is off for
    // this caller rather than a coin flip, because a coin flip would re-decide
    // on every page load and an A/B test that flickers is worse than one that
    // never starts.
    if (id === null) return false;
    if (bucketOf(`${id}:${flag.key}`) >= rules.rollout) return false;
  }
  return true;
};

/** Load the effective flag rows for a tenant: global defaults overlaid by any
 *  per-tenant row with the same key (tenant wins). */
export const loadFlags = async (
  ctx: Ctx,
  tenantId: string | null,
): Promise<FlagRow[]> => {
  const t = tableFor(ctx.dialect);
  const where =
    tenantId == null
      ? isNull(t.tenantId)
      : or(isNull(t.tenantId), eq(t.tenantId, tenantId));
  const rows = (await (ctx.db as any).select().from(t).where(where)) as FlagRow[];
  const merged = new Map<string, FlagRow>();
  // Global first, then tenant rows overwrite by key.
  for (const r of rows.filter((r) => r.tenantId == null)) merged.set(r.key, r);
  for (const r of rows.filter((r) => r.tenantId != null)) merged.set(r.key, r);
  return [...merged.values()];
};

/** Evaluate every flag for a caller → `{ key: { enabled, value } }`. */
export const evaluateFlags = async (
  ctx: Ctx,
  auth: AuthSubject,
  opts?: { bucketKey?: string },
): Promise<Record<string, EvaluatedFlag>> => {
  const flags = await loadFlags(ctx, auth.tenantId ?? null);
  const out: Record<string, EvaluatedFlag> = {};
  for (const f of flags) {
    const on = Boolean(f.enabled) && passesRules(f, auth, opts?.bucketKey);
    out[f.key] = { enabled: on, value: on ? (f.value ?? null) : null };
  }
  return out;
};

// ── Admin CRUD ──────────────────────────────────────────────────────────────

export interface UpsertFlagInput {
  key: string;
  enabled?: boolean;
  value?: unknown;
  rules?: { condition?: Condition; rollout?: number } | null;
  description?: string | null;
  /** Target scope: a tenant id, or null for the global default row. */
  tenantId: string | null;
}

export const listFlags = async (
  ctx: Ctx,
  tenantId: string | null,
): Promise<FlagRow[]> => {
  const t = tableFor(ctx.dialect);
  const where =
    tenantId == null
      ? isNull(t.tenantId)
      : or(isNull(t.tenantId), eq(t.tenantId, tenantId));
  return (await (ctx.db as any).select().from(t).where(where)) as FlagRow[];
};

const scopeWhere = (t: any, tenantId: string | null, key: string) =>
  tenantId == null
    ? and(isNull(t.tenantId), eq(t.key, key))
    : and(eq(t.tenantId, tenantId), eq(t.key, key));

export const upsertFlag = async (ctx: Ctx, input: UpsertFlagInput): Promise<FlagRow> => {
  const t = tableFor(ctx.dialect);
  const now = nowFor(ctx.dialect);
  const existing = (await (ctx.db as any)
    .select()
    .from(t)
    .where(scopeWhere(t, input.tenantId, input.key))
    .limit(1)) as FlagRow[];
  if (existing[0]) {
    const patch: Record<string, unknown> = { updatedAt: now };
    if (input.enabled !== undefined) patch.enabled = input.enabled;
    if (input.value !== undefined) patch.value = input.value;
    if (input.rules !== undefined) patch.rules = input.rules;
    if (input.description !== undefined) patch.description = input.description;
    await (ctx.db as any).update(t).set(patch).where(eq(t.id, existing[0].id));
    return { ...existing[0], ...patch } as FlagRow;
  }
  const row: FlagRow = {
    id: crypto.randomUUID(),
    tenantId: input.tenantId,
    key: input.key,
    enabled: input.enabled ?? false,
    value: input.value ?? null,
    rules: input.rules ?? null,
    description: input.description ?? null,
    createdAt: now,
    updatedAt: now,
  };
  await (ctx.db as any).insert(t).values(row);
  return row;
};

export const deleteFlag = async (
  ctx: Ctx,
  tenantId: string | null,
  key: string,
): Promise<boolean> => {
  const t = tableFor(ctx.dialect);
  await (ctx.db as any).delete(t).where(scopeWhere(t, tenantId, key));
  return true;
};
