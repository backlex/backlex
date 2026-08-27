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
import type { MiddlewareHandler } from "hono";
import { AppError, SYSTEM_ROLES } from "@backlex/core";
import * as pg from "@backlex/db/pg";
import * as sqlite from "@backlex/db/sqlite";
import type { AppBindings } from "../app";
import { requireUser } from "../middleware/session";
import { SECURITY, errorResponses } from "../lib/openapi";
import { isEdgeRuntime } from "../lib/runtime";
import { isPlatformSsoEnabled } from "../lib/platform-sso";
import { defaultHook } from "../lib/openapi-router";
import {
  PLATFORM_LDAP_ID,
  resolvePlatformLdapAdapter,
  sanitizeForResponse,
  type PlatformLdapConfigRow,
} from "../services/platform-ldap-config";
import {
  type ConfigRowKey,
  mergeConfigSecrets,
  readOwnConfigRow,
  saveOwnConfigRow,
} from "../services/provider-config";

/** This table is an INSTANCE-wide singleton keyed on a fixed `id`, not one row
 *  per workspace — the one config in the family that is not tenant-scoped. It
 *  is otherwise the same handler with the same check-then-act race, so it names
 *  its key and shares services/provider-config.ts rather than keeping a copy. */
const singletonKey = (table: { id: unknown }): ConfigRowKey => ({
  column: table.id,
  prop: "id",
  value: PLATFORM_LDAP_ID,
});

/** The attribute names a stock directory uses — the merge base for a partial
 *  update and what the "nothing configured" GET body reports. */
const DEFAULT_ATTRIBUTE_MAP = {
  email: "mail",
  firstName: "givenName",
  lastName: "sn",
  groups: "memberOf",
} as const;

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

/**
 * Enabling LDAP on a runtime that cannot open a TCP socket.
 *
 * `PUT` accepted a full config with `enabled: true` on a Cloudflare Workers
 * tenant and answered a bare `{ok:true}`; only the separate `/test` call ever
 * said that the adapter cannot run here. An operator who configures LDAP and
 * does not press Test believes SSO is on. Measured on a live tenant
 * 2026-08-27.
 *
 * A warning rather than a refusal, deliberately: the row is PORTABLE. The same
 * config is correct the moment this workspace is served by a Bun or Node
 * self-host, and `providersFor` already hides the provider while the runtime
 * cannot serve it — so the stored `true` is a statement of intent, not a lie.
 * Refusing the write would make the config unauthorable from the very
 * deployment most tenants are administered on.
 */
const edgeLdapWarning = (enabled: unknown): string | undefined =>
  enabled === true && isEdgeRuntime()
    ? "Stored, but LDAP cannot run on this runtime: it needs a raw TCP socket, which Cloudflare Workers, Vercel Edge, Netlify Edge and Deno Deploy all block. Sign-in will not offer LDAP here — use SAML SSO, or serve this workspace from a Bun/Node deployment. POST /test reports the same thing."
    : undefined;

export const platformLdapAdminRoutes = new OpenAPIHono<AppBindings>({ defaultHook })
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
      const row = await readOwnConfigRow<PlatformLdapConfigRow>(ctx, t, singletonKey(t));
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
        200: {
          description: "Saved",
          content: {
            "application/json": {
              schema: z.object({
                ok: z.boolean(),
                warning: z.string().optional().openapi({
                  description:
                    "Present when the config was stored but cannot take effect on this runtime — today, `enabled: true` on an edge runtime with no raw TCP.",
                }),
              }),
            },
          },
        },
        ...errorResponses,
      },
    }),
    async (c) => {
      const ctx = c.get("ctx");
      const body = PutInput.parse(await c.req.json());
      const t = tableFor(ctx.dialect);

      const prior = await readOwnConfigRow<PlatformLdapConfigRow>(ctx, t, singletonKey(t));

      const secrets = await mergeConfigSecrets({
        stored: prior?.secrets,
        patch: body.secrets as Record<string, unknown> | undefined,
        allowed: SECRET_KEYS,
        authSecret: ctx.env.AUTH_SECRET,
      });

      // `always` is what the request decided; `onCreate` is what a column the
      // request omitted should be on a NEW row (on an existing one, omitted
      // means "leave it alone"). `always` is spread last into the INSERT, so a
      // column in both takes the request's value — what the old insert path's
      // `body.X ?? default` did.
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
      // Merged, and what it merges over differs by path — the prior row when
      // there is one, the built-in defaults when there is not. The UI sends only
      // the field the user edited, so merging is what stops a partial update
      // clobbering the other mappings.
      if (body.attributeMap !== undefined) {
        always.attributeMap = {
          ...(prior?.attributeMap ?? DEFAULT_ATTRIBUTE_MAP),
          ...body.attributeMap,
        };
      } else {
        onCreate.attributeMap = DEFAULT_ATTRIBUTE_MAP;
      }

      await saveOwnConfigRow(ctx, t, singletonKey(t), { always, onCreate });

      const warning = edgeLdapWarning(always.enabled);
      return c.json(warning ? { ok: true, warning } : { ok: true });
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
