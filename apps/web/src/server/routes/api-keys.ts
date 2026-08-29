import { OpenAPIHono, createRoute, z } from "@hono/zod-openapi";
import { AppError, SYSTEM_ROLES } from "@backlex/core";
import type { Context } from "hono";
import type { AppBindings } from "../app";
import { requireUser } from "../middleware/session";
import { requirePlatformMw } from "../services/roles/guards";
import { SECURITY, OkSchema, errorResponses } from "../lib/openapi";
import { enforceIpRateLimit } from "../lib/auth-rate-limit";
import {
  assertRoleBindable,
  bindableRoles,
  createApiKey,
  listApiKeys,
  revokeApiKey,
  roleMcpProfile,
  updateApiKeyLimits,
  updateApiKeyMcpGuards,
} from "../services/api-keys";
import { allTools } from "../mcp/tools";
import { resolveKind } from "../mcp/kind";
import { defaultHook } from "../lib/openapi-router";

/** Tool names classified as reads — the allowlist a read-only role derives. */
const READ_TOOL_NAMES = allTools
  .filter((t) => resolveKind(t) === "read")
  .map((t) => t.name);

const ApiKeyInput = z
  .object({
    name: z.string().min(1).max(120).optional().openapi({
      description: "Human-readable label. A timestamped default is generated when omitted.",
      example: "Production GitHub Action",
    }),
    userId: z.string().optional().openapi({
      description: "Admin-only — issue a key on behalf of another user.",
    }),
    roleId: z
      .string()
      .min(1)
      .nullable()
      .optional()
      .openapi({
        description:
          "Optional. Scope the key to a single role the owner currently holds. Omit/null = inherit the owner's full role set.",
      }),
    expiresAt: z.string().datetime().optional().openapi({
      description: "ISO-8601 UTC. Must be in the future. Omit for non-expiring keys.",
      example: "2026-12-31T23:59:59Z",
    }),
    mcpTools: z
      .array(z.string().min(1).max(120))
      .nullable()
      .optional()
      .openapi({
        description:
          "Per-key MCP tool allowlist. Omit = default-deny (empty array; the key can't call any MCP tool until the owner opts in). Explicit null = permissive (every tool the server exposes is callable, subject to permissions). Otherwise: only the listed tool names are callable.",
        example: ["collections.list", "collections.read", "schema.list_collections"],
      }),
    mcpReadOnly: z.boolean().optional().openapi({
      description:
        "When true, MCP refuses every write tool (insert / update / delete / grant / revoke / invoke / assign / …) for requests authenticated with this key. REST surface for the same identity is unaffected.",
    }),
    rateLimitPerMinute: z.number().int().min(1).max(1_000_000).nullable().optional().openapi({
      description:
        "Admin-only. Requests-per-minute cap for this key; enforced even on deploys where the global API limiter is off. Null/omit = the shared global budget.",
    }),
    monthlyQuota: z.number().int().min(1).nullable().optional().openapi({
      description:
        "Admin-only. Requests-per-UTC-month quota for this key; over-quota calls get 429 QUOTA_EXCEEDED until the month rolls over. Null/omit = unmetered.",
    }),
  })
  .openapi("ApiKeyInput");

const ApiKeyRow = z
  .object({
    id: z.string(),
    tenantId: z.string().nullable(),
    prefix: z.string().openapi({ description: "First 8 hex chars of the secret key." }),
    name: z.string(),
    userId: z.string(),
    roleId: z.string().nullable(),
    roleName: z.string().nullable(),
    expiresAt: z.unknown().nullable(),
    lastUsedAt: z.unknown().nullable(),
    revokedAt: z.unknown().nullable(),
    createdAt: z.unknown().nullable(),
    mcpTools: z.array(z.string()).nullable(),
    mcpReadOnly: z.boolean(),
    rateLimitPerMinute: z.number().int().nullable(),
    monthlyQuota: z.number().int().nullable(),
  })
  .openapi("ApiKeyRow");

const McpGuardsPatch = z
  .object({
    mcpTools: z.array(z.string().min(1).max(120)).nullable().optional(),
    mcpReadOnly: z.boolean().optional(),
  })
  .openapi("McpGuardsPatch");

const ApiKeyLimitsPatch = z
  .object({
    rateLimitPerMinute: z.number().int().min(1).max(1_000_000).nullable().optional(),
    monthlyQuota: z.number().int().min(1).nullable().optional(),
  })
  .openapi("ApiKeyLimitsPatch");

const ApiKeyCreatedRow = ApiKeyRow.extend({
  secret: z.string().openapi({
    description:
      "Full plaintext key (`pak_<prefix>_<secret>`). Returned exactly once — store it now.",
    example: "pak_a1b2c3d4_...",
  }),
}).openapi("ApiKeyCreatedRow");

const RoleRow = z
  .object({
    id: z.string(),
    name: z.string(),
    description: z.string().nullable().optional(),
  })
  .openapi("RoleRow");

const requireAdmin = (auth: { roles: string[] }) => {
  if (!auth.roles.includes(SYSTEM_ROLES.admin)) {
    throw new AppError("FORBIDDEN", "Admin role required");
  }
};

const requireTenant = (c: Context<AppBindings>): string => {
  const tenantId = c.get("auth")?.tenantId ?? null;
  if (!tenantId) throw new AppError("UNAUTHORIZED", "Active tenant required");
  return tenantId;
};

const defaultName = () =>
  `Key — ${new Date().toISOString().slice(0, 16).replace("T", " ")}`;

const sanitize = (
  row: {
    id: string;
    tenantId: string | null;
    prefix: string;
    name: string;
    userId: string;
    roleId: string | null;
    expiresAt: unknown;
    lastUsedAt: unknown;
    revokedAt: unknown;
    createdAt?: unknown;
    mcpTools?: string[] | null;
    mcpReadOnly?: boolean | number | null;
    rateLimitPerMinute?: number | null;
    monthlyQuota?: number | null;
  },
  roleNames: Map<string, string>,
) => ({
  id: row.id,
  tenantId: row.tenantId,
  prefix: row.prefix,
  name: row.name,
  userId: row.userId,
  roleId: row.roleId,
  roleName: row.roleId ? roleNames.get(row.roleId) ?? null : null,
  expiresAt: row.expiresAt,
  lastUsedAt: row.lastUsedAt,
  revokedAt: row.revokedAt,
  createdAt: row.createdAt,
  mcpTools: row.mcpTools ?? null,
  mcpReadOnly: Boolean(row.mcpReadOnly),
  rateLimitPerMinute: row.rateLimitPerMinute ?? null,
  monthlyQuota: row.monthlyQuota ?? null,
});

export const apiKeysRoutes = new OpenAPIHono<AppBindings>({ defaultHook })
  .openapi(
    createRoute({
      method: "get",
      path: "/",
      tags: ["api-keys"],
      summary: "List API keys",
      description:
        "Returns the caller's keys. Admins see every key in the active workspace; non-admins see only their own.",
      security: SECURITY,
      middleware: [requireUser],
      responses: {
        200: {
          description: "OK",
          content: {
            "application/json": {
              schema: z.object({ data: z.array(ApiKeyRow) }),
            },
          },
        },
        ...errorResponses,
      },
    }),
    async (c) => {
      const ctx = c.get("ctx");
      const auth = c.get("auth");
      const tenantId = requireTenant(c);
      const isAdmin = auth.roles.includes(SYSTEM_ROLES.admin);
      const rows = await listApiKeys(ctx, tenantId, isAdmin ? null : auth.userId);
      const roleNames = new Map<string, string>();
      for (const r of await bindableRoles(ctx, tenantId, auth.userId!, isAdmin)) {
        roleNames.set(r.id, r.name);
      }
      return c.json({ data: rows.map((r) => sanitize(r, roleNames)) });
    },
  )
  .openapi(
    createRoute({
      method: "get",
      path: "/available-roles",
      tags: ["api-keys"],
      summary: "List bindable roles",
      description:
        "Roles the caller may attach to a new key. Admins: every workspace role. Non-admins: only roles they hold.",
      security: SECURITY,
      middleware: [requireUser],
      responses: {
        200: {
          description: "OK",
          content: {
            "application/json": { schema: z.object({ data: z.array(RoleRow) }) },
          },
        },
        ...errorResponses,
      },
    }),
    async (c) => {
      const ctx = c.get("ctx");
      const auth = c.get("auth");
      const tenantId = requireTenant(c);
      const isAdmin = auth.roles.includes(SYSTEM_ROLES.admin);
      const roles = await bindableRoles(ctx, tenantId, auth.userId!, isAdmin);
      return c.json({ data: roles });
    },
  )
  .openapi(
    createRoute({
      method: "get",
      path: "/role-mcp-defaults",
      tags: ["api-keys"],
      summary: "Suggest MCP guards for a role",
      description:
        "Derives sensible default MCP guards for a key scoped to the given role. A read-only role (no write permissions, non-admin) yields read-only mode + an allowlist of the server's read tools; an admin or read/write role yields permissive defaults (read-only off, no allowlist). Omit `roleId` for the no-role / owner's-full-access case (also permissive).",
      security: SECURITY,
      middleware: [requireUser],
      request: {
        query: z.object({
          roleId: z.string().min(1).optional().openapi({
            description: "Role the key will be scoped to. Omit for no role.",
          }),
        }),
      },
      responses: {
        200: {
          description: "OK",
          content: {
            "application/json": {
              schema: z.object({
                data: z.object({
                  readOnly: z.boolean(),
                  tools: z.array(z.string()).nullable(),
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
      const tenantId = requireTenant(c);
      const { roleId } = c.req.valid("query");
      // No role → owner's full access → permissive defaults.
      if (!roleId) {
        return c.json({ data: { readOnly: false, tools: null } });
      }
      const { admin, hasWrite } = await roleMcpProfile(ctx, tenantId, roleId);
      if (admin || hasWrite) {
        return c.json({ data: { readOnly: false, tools: null } });
      }
      // Read-only role: default the key to read-only + the read-tool allowlist.
      return c.json({ data: { readOnly: true, tools: READ_TOOL_NAMES } });
    },
  )
  .openapi(
    createRoute({
      method: "post",
      path: "/",
      tags: ["api-keys"],
      summary: "Create API key",
      description:
        "Issues a new personal API key. The plaintext secret is returned once in the response body and never again.",
      security: SECURITY,
      // A `pak_` key is resolved on the PLATFORM plane by `sessionMiddleware`,
      // so an app-plane caller minting one launders itself across the boundary
      // and comes back holding an operator-shaped credential. `requireUser`
      // alone could not see the difference — it checks only that some user id
      // is set.
      middleware: [requireUser, requirePlatformMw],
      request: {
        body: {
          required: true,
          content: { "application/json": { schema: ApiKeyInput } },
        },
      },
      responses: {
        201: {
          description: "Created — `data.secret` is the only chance to record the key.",
          content: {
            "application/json": {
              schema: z.object({ data: ApiKeyCreatedRow, warning: z.string() }),
            },
          },
        },
        ...errorResponses,
      },
    }),
    async (c) => {
      // Per-IP cap on key creation — a runaway script (or compromised cookie)
      // shouldn't be able to mint hundreds of keys in a minute. Tuned generously
      // since each request is also requireUser-gated.
      await enforceIpRateLimit(c, "apikey-create", 10);
      const ctx = c.get("ctx");
      const auth = c.get("auth");
      const tenantId = requireTenant(c);
      const body = c.req.valid("json");
      const targetUserId = body.userId ?? auth.userId!;
      if (body.userId && body.userId !== auth.userId) requireAdmin(auth);
      if (body.roleId) {
        await assertRoleBindable(ctx, tenantId, targetUserId, body.roleId);
      }
      const expiresAt = body.expiresAt ? new Date(body.expiresAt) : null;
      if (expiresAt && expiresAt.getTime() <= Date.now()) {
        throw new AppError("VALIDATION", "expiresAt must be in the future");
      }
      // Usage-limit knobs are governance config — a non-admin owner could
      // otherwise mint a key with a per-key rate limit far above the global
      // budget (per-key overrides it by design).
      if (body.rateLimitPerMinute !== undefined || body.monthlyQuota !== undefined) {
        requireAdmin(auth);
      }
      const { row, secret } = await createApiKey(ctx, {
        name: body.name?.trim() || defaultName(),
        userId: targetUserId,
        tenantId,
        roleId: body.roleId ?? null,
        expiresAt,
        // Forward `null` (explicit permissive) and arrays as given; if the
        // caller omitted the field, leave it undefined so `createApiKey`'s
        // default-deny (`[]`) takes effect.
        mcpTools: body.mcpTools,
        mcpReadOnly: body.mcpReadOnly ?? false,
        rateLimitPerMinute: body.rateLimitPerMinute ?? null,
        monthlyQuota: body.monthlyQuota ?? null,
      });
      const roleNames = new Map<string, string>();
      if (row.roleId) {
        const isAdmin = auth.roles.includes(SYSTEM_ROLES.admin);
        for (const r of await bindableRoles(ctx, tenantId, auth.userId!, isAdmin)) {
          roleNames.set(r.id, r.name);
        }
      }
      return c.json(
        {
          data: { ...sanitize(row, roleNames), secret },
          warning:
            "Store this secret now. It cannot be retrieved later — only revoked.",
        },
        201,
      );
    },
  )
  .openapi(
    createRoute({
      method: "patch",
      path: "/{id}/mcp-guards",
      tags: ["api-keys"],
      summary: "Update a key's MCP guards (allowlist + read-only)",
      description:
        "Mutate the tool allowlist and/or the read-only flag for an existing API key. Either field may be omitted to leave the other untouched. Affects only the MCP surface — REST authorization is unaffected.",
      security: SECURITY,
      middleware: [requireUser],
      request: {
        params: z.object({ id: z.string() }),
        body: {
          required: true,
          content: { "application/json": { schema: McpGuardsPatch } },
        },
      },
      responses: {
        200: { description: "Updated", content: { "application/json": { schema: OkSchema } } },
        ...errorResponses,
      },
    }),
    async (c) => {
      const ctx = c.get("ctx");
      const auth = c.get("auth");
      const tenantId = requireTenant(c);
      const { id } = c.req.valid("param");
      const isAdmin = auth.roles.includes(SYSTEM_ROLES.admin);
      // Owner-scoped — non-admins can only mutate their own keys, same as
      // revoke. Admins can mutate any key in the workspace.
      const visible = await listApiKeys(ctx, tenantId, isAdmin ? null : auth.userId);
      if (!visible.some((k) => k.id === id)) {
        throw new AppError("NOT_FOUND", "API key not found");
      }
      const body = c.req.valid("json");
      await updateApiKeyMcpGuards(ctx, tenantId, id, body);
      return c.json({ ok: true });
    },
  )
  .openapi(
    createRoute({
      method: "patch",
      path: "/{id}/limits",
      tags: ["api-keys"],
      summary: "Update a key's usage limits (rate limit + monthly quota)",
      description:
        "Admin-only. Set or clear the per-key requests-per-minute cap and/or the monthly request quota. Null clears a field back to unlimited / the shared global budget; an omitted field is left untouched.",
      security: SECURITY,
      middleware: [requireUser],
      request: {
        params: z.object({ id: z.string() }),
        body: {
          required: true,
          content: { "application/json": { schema: ApiKeyLimitsPatch } },
        },
      },
      responses: {
        200: { description: "Updated", content: { "application/json": { schema: OkSchema } } },
        ...errorResponses,
      },
    }),
    async (c) => {
      const ctx = c.get("ctx");
      const auth = c.get("auth");
      const tenantId = requireTenant(c);
      requireAdmin(auth); // governance knobs — see the create handler's rationale
      const { id } = c.req.valid("param");
      const visible = await listApiKeys(ctx, tenantId, null);
      if (!visible.some((k) => k.id === id)) {
        throw new AppError("NOT_FOUND", "API key not found");
      }
      const body = c.req.valid("json");
      await updateApiKeyLimits(ctx, tenantId, id, body);
      return c.json({ ok: true });
    },
  )
  .openapi(
    createRoute({
      method: "delete",
      path: "/{id}",
      tags: ["api-keys"],
      summary: "Revoke API key",
      description: "Marks the key as revoked. Idempotent — a missing/foreign key returns 404.",
      security: SECURITY,
      middleware: [requireUser],
      request: {
        params: z.object({
          id: z.string().openapi({ description: "Key id (NOT the prefix or secret)." }),
        }),
      },
      responses: {
        200: {
          description: "Revoked",
          content: { "application/json": { schema: OkSchema } },
        },
        ...errorResponses,
      },
    }),
    async (c) => {
      const ctx = c.get("ctx");
      const auth = c.get("auth");
      const tenantId = requireTenant(c);
      const { id } = c.req.valid("param");
      const isAdmin = auth.roles.includes(SYSTEM_ROLES.admin);
      const visible = await listApiKeys(ctx, tenantId, isAdmin ? null : auth.userId);
      if (!visible.some((k) => k.id === id)) {
        throw new AppError("NOT_FOUND", "API key not found");
      }
      await revokeApiKey(ctx, tenantId, id);
      return c.json({ ok: true });
    },
  );
