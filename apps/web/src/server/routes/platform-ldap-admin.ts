/**
 * Control-plane LDAP config admin route — instance-global singleton. Admin-only,
 * mounted at `/api/admin/platform-ldap-config`. Fork of `ldap-admin.ts` against
 * the singleton `platform_ldap_config` row. Gated by `PLATFORM_SSO_ENABLED`.
 *
 *   - `GET  /`     — read the config (sanitized; ciphertext → boolean flags).
 *   - `PUT  /`     — upsert. Encrypts `bindPassword`/`caPem`, merges secrets.
 *   - `POST /test` — service-bind + user-bind round-trip; no provisioning.
 *
 * Self-host only at runtime: on Cloudflare Workers the adapter is unavailable,
 * so `/test` and sign-in surface a clear "not available" message.
 */
import { OpenAPIHono, createRoute, z } from "@hono/zod-openapi";
import { eq } from "drizzle-orm";
import type { MiddlewareHandler } from "hono";
import { AppError, SYSTEM_ROLES } from "@backlex/core";
import * as pg from "@backlex/db/pg";
import * as sqlite from "@backlex/db/sqlite";
import type { AppBindings } from "../app";
import { requireUser } from "../middleware/session";
import { SECURITY, errorResponses } from "../lib/openapi";
import { encryptSecret } from "../lib/crypto";
import { isPlatformSsoEnabled } from "../lib/platform-sso";
import {
  PLATFORM_LDAP_ID,
  resolvePlatformLdapAdapter,
  sanitizeForResponse,
  type PlatformLdapConfigRow,
} from "../services/platform-ldap-config";

const tableFor = (dialect: "pg" | "sqlite") =>
  dialect === "pg" ? pg.schema.platformLdapConfig : sqlite.schema.platformLdapConfig;

const gate: MiddlewareHandler<AppBindings> = async (c, next) => {
  if (!isPlatformSsoEnabled(c.get("ctx").env)) {
    throw new AppError("NOT_FOUND", "Platform SSO is not enabled");
  }
  if (!c.get("auth").roles.includes(SYSTEM_ROLES.admin)) {
    throw new AppError("FORBIDDEN", "Admin role required");
  }
  await next();
};

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
  .catchall(z.string())
  .openapi("PlatformLdapAttributeMap");

const PutInput = z
  .object({
    enabled: z.boolean().optional(),
    url: z.string().min(1).optional(),
    bindDn: z.string().min(1).optional(),
    baseDn: z.string().min(1).optional(),
    userFilter: z.string().min(1).optional(),
    groupFilter: z.union([z.string(), z.literal(""), z.null()]).optional(),
    attributeMap: AttributeMapInput.optional(),
    defaultRoleId: z.union([z.string().min(1), z.null()]).optional(),
    groupsToRoles: z
      .record(z.string(), z.object({ tenantId: z.string(), roleId: z.string() }))
      .nullable()
      .optional(),
    tlsOptions: z.object({ rejectUnauthorized: z.boolean().optional() }).nullable().optional(),
    domainMatch: z.array(z.string().min(1)).nullable().optional(),
    rateLimitPerMinute: z.number().int().min(1).max(600).optional(),
    secrets: z
      .object({
        bindPassword: z.union([z.string(), z.null()]).optional(),
        caPem: z.union([z.string(), z.null()]).optional(),
      })
      .optional(),
  })
  .openapi("PlatformLdapPutInput");

const TestInput = z
  .object({
    username: z.string().min(1).max(320),
    password: z.string().min(1).max(1024),
  })
  .openapi("PlatformLdapTestInput");

const TAG = ["platform-ldap-admin"];
const GATE: MiddlewareHandler<AppBindings>[] = [requireUser, gate];

export const platformLdapAdminRoutes = new OpenAPIHono<AppBindings>()
  .openapi(
    createRoute({
      method: "get",
      path: "/",
      tags: TAG,
      summary: "Get platform LDAP config",
      security: SECURITY,
      middleware: GATE,
      responses: {
        200: { description: "OK", content: { "application/json": { schema: z.any() } } },
        ...errorResponses,
      },
    }),
    async (c) => {
      const ctx = c.get("ctx");
      const t = tableFor(ctx.dialect);
      let row: PlatformLdapConfigRow | undefined;
      try {
        const rows = (await (ctx.db as any)
          .select()
          .from(t)
          .where(eq(t.id, PLATFORM_LDAP_ID))
          .limit(1)) as PlatformLdapConfigRow[];
        row = rows[0];
      } catch {
        row = undefined;
      }
      if (!row) {
        return c.json({
          data: {
            id: PLATFORM_LDAP_ID,
            enabled: false,
            url: "",
            bindDn: "",
            baseDn: "",
            userFilter: "(&(objectClass=person)(uid={{username}}))",
            groupFilter: null,
            attributeMap: { email: "mail", firstName: "givenName", lastName: "sn", groups: "memberOf" },
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
    },
  )
  .openapi(
    createRoute({
      method: "put",
      path: "/",
      tags: TAG,
      summary: "Upsert platform LDAP config",
      security: SECURITY,
      middleware: GATE,
      request: {
        body: { required: true, content: { "application/json": { schema: z.unknown() } } },
      },
      responses: {
        200: { description: "Saved", content: { "application/json": { schema: z.any() } } },
        ...errorResponses,
      },
    }),
    async (c) => {
      const ctx = c.get("ctx");
      const body = PutInput.parse(await c.req.json());
      const t = tableFor(ctx.dialect);

      const existing = (await (ctx.db as any)
        .select()
        .from(t)
        .where(eq(t.id, PLATFORM_LDAP_ID))
        .limit(1)) as PlatformLdapConfigRow[];
      const prior = existing[0];

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
        if (body.groupFilter !== undefined) set.groupFilter = body.groupFilter === "" ? null : body.groupFilter;
        if (body.attributeMap !== undefined) {
          set.attributeMap = { ...(prior.attributeMap ?? {}), ...body.attributeMap };
        }
        if (body.defaultRoleId !== undefined) set.defaultRoleId = body.defaultRoleId;
        if (body.groupsToRoles !== undefined) set.groupsToRoles = body.groupsToRoles;
        if (body.tlsOptions !== undefined) set.tlsOptions = body.tlsOptions;
        if (body.domainMatch !== undefined) set.domainMatch = body.domainMatch;
        if (body.rateLimitPerMinute !== undefined) set.rateLimitPerMinute = body.rateLimitPerMinute;
        await (ctx.db as any).update(t).set(set).where(eq(t.id, PLATFORM_LDAP_ID));
      } else {
        await (ctx.db as any).insert(t).values({
          id: PLATFORM_LDAP_ID,
          enabled: body.enabled ?? false,
          url: body.url ?? "",
          bindDn: body.bindDn ?? "",
          baseDn: body.baseDn ?? "",
          userFilter: body.userFilter ?? "(&(objectClass=person)(uid={{username}}))",
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
          updatedAt: ctx.dialect === "pg" ? new Date() : Date.now(),
        });
      }

      return c.json({ ok: true });
    },
  )
  .openapi(
    createRoute({
      method: "post",
      path: "/test",
      tags: TAG,
      summary: "Test platform LDAP bind",
      security: SECURITY,
      middleware: GATE,
      request: {
        body: { required: true, content: { "application/json": { schema: z.unknown() } } },
      },
      responses: {
        200: { description: "Result", content: { "application/json": { schema: z.any() } } },
        ...errorResponses,
      },
    }),
    async (c) => {
      const ctx = c.get("ctx");
      const body = TestInput.parse(await c.req.json());
      const resolved = await resolvePlatformLdapAdapter({
        db: ctx.db,
        dialect: ctx.dialect,
        env: ctx.env,
      });
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
    },
  );
