/**
 * The config resources a schema snapshot carries beside its collections.
 *
 * `schema-versions` was a reconciler for exactly one thing — the `collections`
 * metadata rows — and everything else a workspace is configured by (its roles,
 * its flags, its document templates, its channels) had no way to be captured,
 * diffed against another environment, or applied. `templates extract`/`apply`
 * moves those, but it is a SEEDER: additive, skip-by-natural-key, and it never
 * tells you what would change or removes what should not be there. This is the
 * other half — reconciliation — and it reuses the frame that already exists:
 * snapshot, branch, ref, diff, severity, confirm gate.
 *
 * A resource earns a place here by answering four questions cleanly, and the
 * ones that cannot are deliberately absent:
 *
 *  1. **A natural key that really identifies it.** `roles` has a unique
 *     (tenant, name); `flows`, `webhooks`, `sync_hooks`, `cdc_sinks`,
 *     `saved_panels` and `integrations` have NO unique index and no
 *     service-level guard either, so "the same row somewhere else" is not a
 *     question they can answer yet.
 *  2. **Portable config only.** No raw foreign keys that mean nothing in
 *     another workspace — which is why `dashboards` is absent (its
 *     `embed_role_id` is a role UUID) and why a role's grants travel by
 *     collection SLUG, which they already are.
 *  3. **No secrets.** Nothing here has one. Every resource that does —
 *     webhooks and their signing secret, integrations and their credentials,
 *     forms and their token hash — is excluded outright rather than
 *     redacted, because a reconciler that applies a redacted secret would
 *     overwrite a real one with a placeholder.
 *  4. **No runtime state.** `kpis` is absent for this reason alone: it is
 *     otherwise perfect, but `alert_firing` and `alert_last_fired_at` are
 *     another workspace's alarm and promoting them would import it ringing.
 */
import { and, eq, inArray } from "drizzle-orm";
import type { ConfigItem } from "@backlex/db";
import { SYSTEM_ROLES } from "@backlex/core";
import * as pg from "@backlex/db/pg";
import * as sqlite from "@backlex/db/sqlite";
import { nowFor } from "./items-helpers";

type Dialect = "pg" | "sqlite";
export interface ConfigCtx {
  db: unknown;
  dialect: Dialect;
}

const S = (d: Dialect) => (d === "pg" ? pg.schema : sqlite.schema);
// The Pg/Sqlite Drizzle union has no shared callable surface — the same reason
// `schema-versions.ts` declares `type AnyDb = any` and `routes/items.ts` casts
// at each call site. Matching that rather than inventing a narrower shim, which
// is what the first attempt here did: it typed the return as a callable record
// and every query chain resolved to `never`.
type AnyDb = any;
const db = (ctx: ConfigCtx): AnyDb => ctx.db as AnyDb;

/** Drop `undefined` and `null` so a snapshot carries what was set and nothing
 *  else — the same shape rule the collection half follows, and what makes two
 *  environments' documents diffable in git. */
const compact = <T extends Record<string, unknown>>(o: T): ConfigItem => {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(o)) if (v !== undefined && v !== null) out[k] = v;
  return out as ConfigItem;
};

const bool = (v: unknown): boolean => v === true || v === 1;

/** A column stored as TEXT holding JSON (rather than a json-mode column) has to
 *  be parsed on the way out and stringified on the way in, or the target ends
 *  up storing a string of a string. */
const parseJson = <T>(v: unknown, fallback: T): T => {
  if (v == null) return fallback;
  if (typeof v !== "string") return v as T;
  try {
    return JSON.parse(v) as T;
  } catch {
    return fallback;
  }
};

/**
 * One reconcilable config resource.
 *
 * `upsert` and `remove` are per-item rather than batch because the apply engine
 * walks a diff it has already categorised and gated — it applies exactly the
 * changes the operator confirmed, one at a time, so a partial failure names the
 * row it failed on instead of rolling a batch back into a mystery.
 */
export interface ConfigResource {
  /** Registry key, and the key under `document.config`. */
  key: string;
  /** What one row is called, for a diff line a human reads. */
  label: string;
  load(ctx: ConfigCtx, tenantId: string): Promise<ConfigItem[]>;
  upsert(ctx: ConfigCtx, tenantId: string, item: ConfigItem): Promise<void>;
  remove(ctx: ConfigCtx, tenantId: string, key: string): Promise<void>;
}

/* ── roles (+ their grants) ─────────────────────────────────────────────── */

const SYSTEM = new Set<string>([SYSTEM_ROLES.admin, SYSTEM_ROLES.authenticated, SYSTEM_ROLES.public]);

const roles: ConfigResource = {
  key: "roles",
  label: "role",
  async load(ctx, tenantId) {
    const s = S(ctx.dialect);
    const rows = (await db(ctx)
      .select()
      .from(s.roles)
      .where(eq(s.roles.tenantId, tenantId))) as unknown as Record<string, unknown>[];
    // The three system roles exist in every workspace before anything is
    // applied, so carrying them would be three rows the apply must recognise
    // as no-ops — and one that could DELETE `admin` if a target had drifted.
    const mine = rows.filter((r) => !SYSTEM.has(String(r.name)));
    if (mine.length === 0) return [];
    // `permissions` carries no tenant_id — it is scoped only transitively via
    // `role_id` — so the QUERY is constrained to this workspace's own role ids
    // rather than reading every row and filtering after. The filter would be
    // correct either way; "select everything and discard what is not ours" is
    // the shape a later refactor turns into a leak.
    const grants = (await db(ctx)
      .select()
      .from(s.permissions)
      .where(
        inArray(
          s.permissions.roleId,
          mine.map((r) => String(r.id)),
        ),
      )) as unknown as Record<string, unknown>[];
    const byRole = new Map<string, Record<string, unknown>[]>();
    for (const g of grants) {
      const arr = byRole.get(String(g.roleId)) ?? [];
      arr.push(g);
      byRole.set(String(g.roleId), arr);
    }
    return mine.map((r) =>
      compact({
        key: String(r.name),
        description: r.description,
        mcpTools: r.mcpTools ?? undefined,
        mcpReadOnly: bool(r.mcpReadOnly) ? true : undefined,
        orgAssignable: bool(r.orgAssignable) ? true : undefined,
        // Grants travel by collection SLUG, which is what they already store —
        // there is no id to re-resolve, which is exactly why roles qualify.
        grants: (byRole.get(String(r.id)) ?? [])
          .map((g) =>
            compact({
              collection: g.collection,
              action: g.action,
              fields: g.fields ?? undefined,
              condition: g.condition ?? undefined,
            }),
          )
          .sort((a, b) => `${a.collection}.${a.action}`.localeCompare(`${b.collection}.${b.action}`)),
      }),
    );
  },
  async upsert(ctx, tenantId, item) {
    const s = S(ctx.dialect);
    const name = item.key;
    if (SYSTEM.has(name)) return; // never reconcile a system role
    const now = nowFor(ctx.dialect);
    const existing = (await db(ctx)
      .select()
      .from(s.roles)
      .where(and(eq(s.roles.tenantId, tenantId), eq(s.roles.name, name)))
      .limit(1)) as unknown as Record<string, unknown>[];
    let roleId = existing[0] ? String(existing[0].id) : crypto.randomUUID();
    const values = {
      name,
      description: (item.description as string | undefined) ?? null,
      mcpTools: (item.mcpTools as string[] | undefined) ?? null,
      mcpReadOnly: item.mcpReadOnly === true,
      orgAssignable: item.orgAssignable === true,
      updatedAt: now,
    };
    if (existing[0]) {
      await db(ctx).update(s.roles).set(values).where(eq(s.roles.id, roleId));
    } else {
      roleId = crypto.randomUUID();
      await db(ctx)
        .insert(s.roles)
        .values({ id: roleId, tenantId, admin: false, createdAt: now, ...values });
    }
    // Grants are REPLACED, not merged. A reconciler's job is to make the target
    // match the document; merging would leave a grant the document removed in
    // place, which is the one direction that widens access silently.
    await db(ctx).delete(s.permissions).where(eq(s.permissions.roleId, roleId));
    for (const g of (item.grants as Record<string, unknown>[] | undefined) ?? []) {
      await db(ctx)
        .insert(s.permissions)
        .values({
          id: crypto.randomUUID(),
          roleId,
          collection: String(g.collection),
          action: String(g.action),
          fields: (g.fields as string[] | undefined) ?? null,
          condition: g.condition ?? null,
          createdAt: now,
        });
    }
  },
  async remove(ctx, tenantId, key) {
    if (SYSTEM.has(key)) return;
    const s = S(ctx.dialect);
    await db(ctx)
      .delete(s.roles)
      .where(and(eq(s.roles.tenantId, tenantId), eq(s.roles.name, key)));
  },
};

/* ── feature flags ──────────────────────────────────────────────────────── */

const flags: ConfigResource = {
  key: "flags",
  label: "flag",
  async load(ctx, tenantId) {
    const s = S(ctx.dialect);
    const rows = (await db(ctx)
      .select()
      .from(s.featureFlags)
      .where(eq(s.featureFlags.tenantId, tenantId))) as unknown as Record<string, unknown>[];
    return rows.map((r) =>
      compact({
        key: String(r.key),
        enabled: bool(r.enabled) ? true : undefined,
        value: r.value ?? undefined,
        rules: r.rules ?? undefined,
        description: r.description,
      }),
    );
  },
  async upsert(ctx, tenantId, item) {
    const s = S(ctx.dialect);
    const now = nowFor(ctx.dialect);
    const existing = (await db(ctx)
      .select()
      .from(s.featureFlags)
      .where(
        and(eq(s.featureFlags.tenantId, tenantId), eq(s.featureFlags.key, item.key)),
      )
      .limit(1)) as unknown as Record<string, unknown>[];
    const values = {
      enabled: item.enabled === true,
      value: item.value ?? null,
      rules: item.rules ?? null,
      description: (item.description as string | undefined) ?? null,
      updatedAt: now,
    };
    if (existing[0]) {
      await db(ctx)
        .update(s.featureFlags)
        .set(values)
        .where(eq(s.featureFlags.id, String(existing[0].id)));
    } else {
      await db(ctx)
        .insert(s.featureFlags)
        .values({
          id: crypto.randomUUID(),
          tenantId,
          key: item.key,
          createdAt: now,
          ...values,
        });
    }
  },
  async remove(ctx, tenantId, key) {
    const s = S(ctx.dialect);
    await db(ctx)
      .delete(s.featureFlags)
      .where(and(eq(s.featureFlags.tenantId, tenantId), eq(s.featureFlags.key, key)));
  },
};

/* ── document templates ─────────────────────────────────────────────────── */

const documents: ConfigResource = {
  key: "documents",
  label: "document template",
  async load(ctx, tenantId) {
    const s = S(ctx.dialect);
    const rows = (await db(ctx)
      .select()
      .from(s.documentTemplates)
      .where(eq(s.documentTemplates.tenantId, tenantId))) as unknown as Record<
      string,
      unknown
    >[];
    return rows.map((r) =>
      compact({
        key: String(r.key),
        name: r.name,
        description: r.description,
        bodyHtml: r.bodyHtml,
        headerHtml: r.headerHtml,
        footerHtml: r.footerHtml,
        pageOptions: r.pageOptions ?? undefined,
        filename: r.filename,
        variables: r.variables ?? undefined,
        // `updatedBy` is a user id — provenance, not config, and meaningless
        // in another workspace.
      }),
    );
  },
  async upsert(ctx, tenantId, item) {
    const s = S(ctx.dialect);
    const now = nowFor(ctx.dialect);
    const existing = (await db(ctx)
      .select()
      .from(s.documentTemplates)
      .where(
        and(
          eq(s.documentTemplates.tenantId, tenantId),
          eq(s.documentTemplates.key, item.key),
        ),
      )
      .limit(1)) as unknown as Record<string, unknown>[];
    const values = {
      name: String(item.name ?? item.key),
      description: (item.description as string | undefined) ?? null,
      bodyHtml: String(item.bodyHtml ?? ""),
      headerHtml: (item.headerHtml as string | undefined) ?? null,
      footerHtml: (item.footerHtml as string | undefined) ?? null,
      pageOptions: item.pageOptions ?? null,
      filename: (item.filename as string | undefined) ?? null,
      variables: (item.variables as string[] | undefined) ?? null,
      updatedAt: now,
    };
    if (existing[0]) {
      await db(ctx)
        .update(s.documentTemplates)
        .set(values)
        .where(eq(s.documentTemplates.id, String(existing[0].id)));
    } else {
      await db(ctx)
        .insert(s.documentTemplates)
        .values({
          id: crypto.randomUUID(),
          tenantId,
          key: item.key,
          createdAt: now,
          ...values,
        });
    }
  },
  async remove(ctx, tenantId, key) {
    const s = S(ctx.dialect);
    await db(ctx)
      .delete(s.documentTemplates)
      .where(
        and(
          eq(s.documentTemplates.tenantId, tenantId),
          eq(s.documentTemplates.key, key),
        ),
      );
  },
};

/* ── broadcast channels ─────────────────────────────────────────────────── */

const channels: ConfigResource = {
  key: "channels",
  label: "channel",
  async load(ctx, tenantId) {
    const s = S(ctx.dialect);
    const rows = (await db(ctx)
      .select()
      .from(s.broadcastChannels)
      .where(eq(s.broadcastChannels.tenantId, tenantId))) as unknown as Record<
      string,
      unknown
    >[];
    return rows.map((r) =>
      compact({
        // The PATTERN is the natural key here, not the name — that is what the
        // unique index is on, and what a subscriber actually addresses.
        key: String(r.pattern),
        name: r.name,
        subscribe: parseJson(r.subscribe, {}),
        publish: parseJson(r.publish, {}),
        presence: bool(r.presence) ? true : undefined,
        replay: bool(r.replay) ? true : undefined,
        retentionHours: r.retentionHours,
        enabled: bool(r.enabled) ? undefined : false,
      }),
    );
  },
  async upsert(ctx, tenantId, item) {
    const s = S(ctx.dialect);
    const now = nowFor(ctx.dialect);
    const existing = (await db(ctx)
      .select()
      .from(s.broadcastChannels)
      .where(
        and(
          eq(s.broadcastChannels.tenantId, tenantId),
          eq(s.broadcastChannels.pattern, item.key),
        ),
      )
      .limit(1)) as unknown as Record<string, unknown>[];
    const values = {
      name: String(item.name ?? item.key),
      // TEXT columns holding JSON — stringified on the way in for the same
      // reason `load` parses on the way out.
      subscribe: JSON.stringify(item.subscribe ?? {}),
      publish: JSON.stringify(item.publish ?? {}),
      presence: item.presence === true,
      replay: item.replay === true,
      retentionHours: typeof item.retentionHours === "number" ? item.retentionHours : 24,
      enabled: item.enabled !== false,
      updatedAt: now,
    };
    if (existing[0]) {
      await db(ctx)
        .update(s.broadcastChannels)
        .set(values)
        .where(eq(s.broadcastChannels.id, String(existing[0].id)));
    } else {
      await db(ctx)
        .insert(s.broadcastChannels)
        .values({
          id: crypto.randomUUID(),
          tenantId,
          pattern: item.key,
          createdAt: now,
          ...values,
        });
    }
  },
  async remove(ctx, tenantId, key) {
    const s = S(ctx.dialect);
    await db(ctx)
      .delete(s.broadcastChannels)
      .where(
        and(
          eq(s.broadcastChannels.tenantId, tenantId),
          eq(s.broadcastChannels.pattern, key),
        ),
      );
  },
};

/** Every reconcilable resource, in apply order. Roles come first so a later
 *  resource that names one already has it. */
export const CONFIG_RESOURCES: ConfigResource[] = [roles, flags, documents, channels];

export const configResource = (key: string): ConfigResource | undefined =>
  CONFIG_RESOURCES.find((r) => r.key === key);

/** The whole config half of a live workspace. */
export const loadLiveConfig = async (
  ctx: ConfigCtx,
  tenantId: string,
): Promise<Record<string, ConfigItem[]>> => {
  const out: Record<string, ConfigItem[]> = {};
  for (const r of CONFIG_RESOURCES) out[r.key] = await r.load(ctx, tenantId);
  return out;
};
