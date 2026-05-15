/**
 * LDAP / Active Directory config admin route. Admin-only, single-row config
 * keyed on the active workspace's `tenant_id` (the `_global` sentinel works
 * as a fallback, same as `email-config`). Mounted at `/api/admin/ldap-config`.
 *
 * Endpoints:
 *   - `GET    /`        — read the active workspace's config (sanitized).
 *   - `PUT    /`        — upsert. Encrypts `bindPassword` and `caPem` and
 *                          merges into the stored `secrets` blob; omitted
 *                          secret keys leave existing ciphertext intact.
 *   - `POST   /test`    — debug: try a service-bind + user-bind for the given
 *                          username/password WITHOUT provisioning anything.
 *
 * After every mutating call we `invalidateTenantAuth(auth.tenantId)` so the
 * next `/api/t/<slug>/auth/*` request rebuilds its cached transport.
 */
import { Hono } from "hono";
import { z } from "zod";
import { eq } from "drizzle-orm";
import { AppError, SYSTEM_ROLES } from "@workeros/core";
import * as pg from "@workeros/db/pg";
import * as sqlite from "@workeros/db/sqlite";
import type { AppBindings } from "../app";
import { requireUser } from "../middleware/session";
import { encryptSecret } from "../lib/crypto";
import {
  GLOBAL_LDAP_CONFIG_ID,
  resolveLdapAdapter,
  sanitizeForResponse,
  type LdapConfigRow,
} from "../services/ldap-config";
import { invalidateTenantAuth } from "../services/tenant-auth";

const tableFor = (dialect: "pg" | "sqlite") =>
  dialect === "pg" ? pg.schema.ldapConfigs : sqlite.schema.ldapConfigs;

const requireAdmin = (auth: { roles: string[] }) => {
  if (!auth.roles.includes(SYSTEM_ROLES.admin))
    throw new AppError("FORBIDDEN", "Admin role required");
};

/** Secret keys recognised in `secrets`. Used to scope what the PUT body may
 *  set and what the GET response advertises as "configured". */
const SECRET_KEYS = ["bindPassword", "caPem"] as const;
type SecretKey = (typeof SECRET_KEYS)[number];

const AttributeMapInput = z
  .object({
    email: z.string().min(1).optional(),
    firstName: z.string().min(1).optional(),
    lastName: z.string().min(1).optional(),
    groups: z.string().min(1).optional(),
  })
  .partial()
  .catchall(z.string());

const PutInput = z.object({
  enabled: z.boolean().optional(),
  url: z.string().min(1).optional(),
  bindDn: z.string().min(1).optional(),
  baseDn: z.string().min(1).optional(),
  userFilter: z.string().min(1).optional(),
  groupFilter: z.union([z.string(), z.literal(""), z.null()]).optional(),
  attributeMap: AttributeMapInput.optional(),
  defaultRoleId: z.union([z.string().min(1), z.null()]).optional(),
  groupsToRoles: z.record(z.string(), z.string()).nullable().optional(),
  tlsOptions: z
    .object({ rejectUnauthorized: z.boolean().optional() })
    .nullable()
    .optional(),
  domainMatch: z.array(z.string().min(1)).nullable().optional(),
  rateLimitPerMinute: z.number().int().min(1).max(600).optional(),
  /** Plaintext secret material. `""`/`null` clears the key; omitted leaves
   *  the existing ciphertext untouched. */
  secrets: z
    .object({
      bindPassword: z.union([z.string(), z.null()]).optional(),
      caPem: z.union([z.string(), z.null()]).optional(),
    })
    .optional(),
});

const TestInput = z.object({
  username: z.string().min(1).max(320),
  password: z.string().min(1).max(1024),
});

export const ldapAdminRoutes = new Hono<AppBindings>()
  .use("*", requireUser, async (c, next) => {
    requireAdmin(c.get("auth"));
    const auth = c.get("auth");
    if (!auth.tenantId) {
      throw new AppError("VALIDATION", "Active workspace required for LDAP admin");
    }
    await next();
  })
  /** Read the active workspace's LDAP config (sanitized — no ciphertext). */
  .get("/", async (c) => {
    const ctx = c.get("ctx");
    const auth = c.get("auth");
    const tenantId = auth.tenantId ?? GLOBAL_LDAP_CONFIG_ID;
    const t = tableFor(ctx.dialect);
    let row: LdapConfigRow | undefined;
    try {
      const rows = (await (ctx.db as any)
        .select()
        .from(t)
        .where(eq(t.tenantId, tenantId))
        .limit(1)) as LdapConfigRow[];
      row = rows[0];
    } catch {
      row = undefined; // table not migrated yet — show empty
    }
    if (!row) {
      return c.json({
        data: {
          tenantId,
          enabled: false,
          url: "",
          bindDn: "",
          baseDn: "",
          userFilter: "(&(objectClass=person)(uid={{username}}))",
          groupFilter: null,
          attributeMap: {
            email: "mail",
            firstName: "givenName",
            lastName: "sn",
            groups: "memberOf",
          },
          defaultRoleId: null,
          groupsToRoles: null,
          tlsOptions: null,
          secretsSet: { bindPassword: false, caPem: false },
          domainMatch: null,
          rateLimitPerMinute: 10,
          updatedAt: null,
        },
      });
    }
    return c.json({ data: sanitizeForResponse(row) });
  })
  /** Upsert. Encrypts plaintext secrets into the stored `secrets` blob. */
  .put("/", async (c) => {
    const ctx = c.get("ctx");
    const auth = c.get("auth");
    const body = PutInput.parse(await c.req.json());
    const tenantId = auth.tenantId ?? GLOBAL_LDAP_CONFIG_ID;
    const t = tableFor(ctx.dialect);

    const existing = (await (ctx.db as any)
      .select()
      .from(t)
      .where(eq(t.tenantId, tenantId))
      .limit(1)) as LdapConfigRow[];
    const prior = existing[0];

    // Merge secrets: encrypt new values, drop cleared ones, keep the rest.
    const secrets: Record<string, string> = { ...(prior?.secrets ?? {}) };
    if (body.secrets) {
      for (const k of SECRET_KEYS) {
        if (!(k in body.secrets)) continue;
        const v = (body.secrets as Record<SecretKey, string | null | undefined>)[k];
        if (typeof v === "string" && v.trim()) {
          secrets[k] = await encryptSecret(v.trim(), ctx.env.AUTH_SECRET);
        } else {
          delete secrets[k];
        }
      }
    }

    if (prior) {
      const set: Record<string, unknown> = {
        updatedAt: ctx.dialect === "pg" ? new Date() : Date.now(),
        secrets,
      };
      if (body.enabled !== undefined) set.enabled = body.enabled;
      if (body.url !== undefined) set.url = body.url;
      if (body.bindDn !== undefined) set.bindDn = body.bindDn;
      if (body.baseDn !== undefined) set.baseDn = body.baseDn;
      if (body.userFilter !== undefined) set.userFilter = body.userFilter;
      if (body.groupFilter !== undefined) {
        set.groupFilter = body.groupFilter === "" ? null : body.groupFilter;
      }
      if (body.attributeMap !== undefined) {
        // Merge over the prior map so a partial update doesn't clobber other
        // attribute mappings (UI sends only the field the user edited).
        set.attributeMap = { ...(prior.attributeMap ?? {}), ...body.attributeMap };
      }
      if (body.defaultRoleId !== undefined) set.defaultRoleId = body.defaultRoleId;
      if (body.groupsToRoles !== undefined) set.groupsToRoles = body.groupsToRoles;
      if (body.tlsOptions !== undefined) set.tlsOptions = body.tlsOptions;
      if (body.domainMatch !== undefined) set.domainMatch = body.domainMatch;
      if (body.rateLimitPerMinute !== undefined)
        set.rateLimitPerMinute = body.rateLimitPerMinute;
      await (ctx.db as any).update(t).set(set).where(eq(t.tenantId, tenantId));
    } else {
      // Insert path — most fields are required by the schema, so default the
      // omitted ones to sensible blanks so the row at least exists.
      const values: Record<string, unknown> = {
        tenantId,
        enabled: body.enabled ?? false,
        url: body.url ?? "",
        bindDn: body.bindDn ?? "",
        baseDn: body.baseDn ?? "",
        userFilter:
          body.userFilter ?? "(&(objectClass=person)(uid={{username}}))",
        groupFilter: body.groupFilter === "" ? null : body.groupFilter ?? null,
        attributeMap: {
          email: "mail",
          firstName: "givenName",
          lastName: "sn",
          groups: "memberOf",
          ...(body.attributeMap ?? {}),
        },
        defaultRoleId: body.defaultRoleId ?? null,
        groupsToRoles: body.groupsToRoles ?? null,
        tlsOptions: body.tlsOptions ?? null,
        secrets,
        domainMatch: body.domainMatch ?? null,
        rateLimitPerMinute: body.rateLimitPerMinute ?? 10,
      };
      await (ctx.db as any).insert(t).values(values);
    }

    if (auth.tenantId) invalidateTenantAuth(auth.tenantId);
    return c.json({ ok: true });
  })
  /**
   * Service-bind + user-bind against the configured directory. Returns the
   * resolved DN + raw attributes so an admin can verify the attribute_map.
   * Does NOT create an `app_users` row or any session.
   */
  .post("/test", async (c) => {
    const ctx = c.get("ctx");
    const auth = c.get("auth");
    const body = TestInput.parse(await c.req.json());
    const resolved = await resolveLdapAdapter(
      { db: ctx.db, dialect: ctx.dialect, env: ctx.env },
      auth.tenantId!,
    );
    if (!resolved) {
      return c.json({
        ok: false,
        reason:
          "LDAP not configured, not enabled, or not available on this runtime (Cloudflare Workers blocks raw TCP — use SAML SSO instead).",
      });
    }
    let result;
    try {
      result = await resolved.adapter.authenticate(body.username, body.password);
    } catch (err) {
      return c.json({
        ok: false,
        reason: `LDAP transport error: ${err instanceof Error ? err.message : String(err)}`,
      });
    }
    if (!result) {
      return c.json({ ok: false, reason: "Authentication failed (bad credentials or no match)." });
    }
    return c.json({
      ok: true,
      dn: result.dn,
      attributes: {
        email: result.email ?? null,
        firstName: result.firstName ?? null,
        lastName: result.lastName ?? null,
        groups: result.groups ?? [],
      },
    });
  });
