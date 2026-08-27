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
import { OpenAPIHono, createRoute, z } from "@hono/zod-openapi";
import type { MiddlewareHandler } from "hono";
import { AppError, SYSTEM_ROLES } from "@backlex/core";
import * as pg from "@backlex/db/pg";
import * as sqlite from "@backlex/db/sqlite";
import type { AppBindings } from "../app";
import { requireUser } from "../middleware/session";
import { SECURITY, errorResponses } from "../lib/openapi";
import {
  GLOBAL_LDAP_CONFIG_ID,
  resolveLdapAdapter,
  sanitizeForResponse,
  type LdapConfigRow,
} from "../services/ldap-config";
import {
  mergeConfigSecrets,
  readOwnConfigRow,
  saveOwnConfigRow,
  tenantKey,
} from "../services/provider-config";
import { invalidateTenantAuth } from "../services/tenant-auth";
import { defaultHook } from "../lib/openapi-router";
import { readJson } from "../lib/body";

const tableFor = (dialect: "pg" | "sqlite") =>
  dialect === "pg" ? pg.schema.ldapConfigs : sqlite.schema.ldapConfigs;

/** The attribute names a stock directory uses, applied when a workspace has no
 *  row yet and used as the merge base for a partial update. Stated once: the
 *  GET's "nothing configured" body and the PUT's create path have to agree, and
 *  they were two copies of this literal. */
const DEFAULT_ATTRIBUTE_MAP = {
  email: "mail",
  firstName: "givenName",
  lastName: "sn",
  groups: "memberOf",
} as const;

const requireAdminTenantGate: MiddlewareHandler<AppBindings> = async (c, next) => {
  const auth = c.get("auth");
  if (!auth.roles.includes(SYSTEM_ROLES.admin))
    throw new AppError("FORBIDDEN", "Admin role required");
  if (!auth.tenantId) {
    throw new AppError("VALIDATION", "Active workspace required for LDAP admin");
  }
  await next();
};

/** Secret keys recognised in `secrets`. Used to scope what the PUT body may
 *  set and what the GET response advertises as "configured". */
const SECRET_KEYS = ["bindPassword", "caPem"] as const;

const AttributeMapInput = z
  .object({
    email: z.string().min(1).optional(),
    firstName: z.string().min(1).optional(),
    lastName: z.string().min(1).optional(),
    groups: z.string().min(1).optional(),
  })
  .partial()
  .catchall(z.string())
  .openapi("LdapAttributeMap");

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
  })
  .openapi("LdapPutInput");

const TestInput = z
  .object({
    username: z.string().min(1).max(320),
    password: z.string().min(1).max(1024),
  })
  .openapi("LdapTestInput");

const LdapConfigRowSchema = z
  .object({
    tenantId: z.string(),
    enabled: z.boolean(),
    url: z.string(),
    bindDn: z.string(),
    baseDn: z.string(),
    userFilter: z.string(),
    groupFilter: z.string().nullable(),
    attributeMap: AttributeMapInput,
    defaultRoleId: z.string().nullable(),
    groupsToRoles: z.record(z.string(), z.string()).nullable(),
    tlsOptions: z.object({ rejectUnauthorized: z.boolean().optional() }).nullable(),
    secretsSet: z.object({ bindPassword: z.boolean(), caPem: z.boolean() }),
    domainMatch: z.array(z.string()).nullable(),
    rateLimitPerMinute: z.number().int(),
    updatedAt: z.unknown().nullable(),
  })
  .openapi("LdapConfigRow");

const TAGS = ["ldap-admin"];
const GATE: MiddlewareHandler<AppBindings>[] = [requireUser, requireAdminTenantGate];

export const ldapAdminRoutes = new OpenAPIHono<AppBindings>({ defaultHook })
  /** Read the active workspace's LDAP config (sanitized — no ciphertext). */
  .openapi(
    createRoute({
      method: "get",
      path: "/",
      tags: TAGS,
      summary: "Get LDAP config",
      description:
        "Sanitized — ciphertext secrets are exposed only as boolean `secretsSet` flags.",
      security: SECURITY,
      middleware: GATE,
      responses: {
        200: {
          description: "OK",
          content: {
            "application/json": { schema: z.object({ data: LdapConfigRowSchema }) },
          },
        },
        ...errorResponses,
      },
    }),
    async (c) => {
      const ctx = c.get("ctx");
      const auth = c.get("auth");
      const tenantId = auth.tenantId ?? GLOBAL_LDAP_CONFIG_ID;
      const row = await readOwnConfigRow<LdapConfigRow>(
        ctx,
        tableFor(ctx.dialect),
        tenantKey(tableFor(ctx.dialect), tenantId),
      );
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
            attributeMap: DEFAULT_ATTRIBUTE_MAP,
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
  /** Upsert. Encrypts plaintext secrets into the stored `secrets` blob. */
  .openapi(
    createRoute({
      method: "put",
      path: "/",
      tags: TAGS,
      summary: "Upsert LDAP config",
      description:
        "Encrypts `bindPassword` / `caPem` before storing. Omitted secret keys keep their existing ciphertext; `\"\"` or `null` clears.",
      security: SECURITY,
      middleware: GATE,
      request: {
        body: { required: true, content: { "application/json": { schema: z.unknown() } } },
      },
      responses: {
        200: {
          description: "Saved",
          content: { "application/json": { schema: z.any() } },
        },
        ...errorResponses,
      },
    }),
    async (c) => {
      const ctx = c.get("ctx");
      const auth = c.get("auth");
      const body = PutInput.parse(await readJson(c.req));
      const tenantId = auth.tenantId ?? GLOBAL_LDAP_CONFIG_ID;
      const t = tableFor(ctx.dialect);

      const prior = await readOwnConfigRow<LdapConfigRow>(ctx, t, tenantKey(t, tenantId));

      const secrets = await mergeConfigSecrets({
        stored: prior?.secrets,
        patch: body.secrets as Record<string, unknown> | undefined,
        allowed: SECRET_KEYS,
        authSecret: ctx.env.AUTH_SECRET,
      });

      // `always` is what the request decided; `onCreate` is what a column the
      // request omitted should be on a NEW row (on an existing one, omitted
      // means "leave it alone"). `always` is spread last into the INSERT, so a
      // column present in both takes the request's value — which is exactly
      // what the old `body.X ?? default` insert path did.
      const always: Record<string, unknown> = { secrets };
      const onCreate: Record<string, unknown> = {
        enabled: false,
        url: "",
        bindDn: "",
        baseDn: "",
        userFilter: "(&(objectClass=person)(uid={{username}}))",
        groupFilter: null,
        defaultRoleId: null,
        groupsToRoles: null,
        tlsOptions: null,
        domainMatch: null,
        rateLimitPerMinute: 10,
      };
      if (body.enabled !== undefined) always.enabled = body.enabled;
      if (body.url !== undefined) always.url = body.url;
      if (body.bindDn !== undefined) always.bindDn = body.bindDn;
      if (body.baseDn !== undefined) always.baseDn = body.baseDn;
      if (body.userFilter !== undefined) always.userFilter = body.userFilter;
      if (body.groupFilter !== undefined) {
        always.groupFilter = body.groupFilter === "" ? null : body.groupFilter;
      }
      if (body.defaultRoleId !== undefined) always.defaultRoleId = body.defaultRoleId;
      if (body.groupsToRoles !== undefined) always.groupsToRoles = body.groupsToRoles;
      if (body.tlsOptions !== undefined) always.tlsOptions = body.tlsOptions;
      if (body.domainMatch !== undefined) always.domainMatch = body.domainMatch;
      if (body.rateLimitPerMinute !== undefined) {
        always.rateLimitPerMinute = body.rateLimitPerMinute;
      }
      // The one column the always/onCreate split cannot express on its own: the
      // map is MERGED, and what it merges over differs by path — the prior row
      // when there is one, the built-in defaults when there is not. The UI sends
      // only the field the user edited, so merging is what stops a partial
      // update clobbering the other mappings. Computed here, against the right
      // base, so a single write can carry it.
      if (body.attributeMap !== undefined) {
        always.attributeMap = {
          ...(prior?.attributeMap ?? DEFAULT_ATTRIBUTE_MAP),
          ...body.attributeMap,
        };
      } else {
        onCreate.attributeMap = DEFAULT_ATTRIBUTE_MAP;
      }

      await saveOwnConfigRow(ctx, t, tenantKey(t, tenantId), { always, onCreate });

      if (auth.tenantId) invalidateTenantAuth(auth.tenantId);
      return c.json({ ok: true });
    },
  )
  /**
   * Service-bind + user-bind against the configured directory. Returns the
   * resolved DN + raw attributes so an admin can verify the attribute_map.
   * Does NOT create an `app_users` row or any session.
   */
  .openapi(
    createRoute({
      method: "post",
      path: "/test",
      tags: TAGS,
      summary: "Test LDAP bind",
      description:
        "Service-bind + user-bind round-trip. Does NOT create an `app_users` row or session.",
      security: SECURITY,
      middleware: GATE,
      request: {
        body: { required: true, content: { "application/json": { schema: z.unknown() } } },
      },
      responses: {
        200: {
          description:
            "Result — `ok:false` for any auth/transport failure (still 200).",
          content: {
            "application/json": {
              schema: z.any(),
            },
          },
        },
        ...errorResponses,
      },
    }),
    async (c) => {
      const ctx = c.get("ctx");
      const auth = c.get("auth");
      const body = TestInput.parse(await readJson(c.req));
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
        return c.json({
          ok: false,
          reason: "Authentication failed (bad credentials or no match).",
        });
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
