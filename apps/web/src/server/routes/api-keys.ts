import { OpenAPIHono, createRoute, z } from "@hono/zod-openapi";
import { AppError, SYSTEM_ROLES } from "@workeros/core";
import type { Context } from "hono";
import type { AppBindings } from "../app";
import { requireUser } from "../middleware/session";
import { SECURITY, OkSchema, errorResponses } from "../lib/openapi";
import { enforceIpRateLimit } from "../lib/auth-rate-limit";
import {
  assertRoleBindable,
  bindableRoles,
  createApiKey,
  listApiKeys,
  revokeApiKey,
  updateApiKeyMcpGuards,
} from "../services/api-keys";

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
          "Per-key MCP tool allowlist. Omit/null = unrestricted (every tool the MCP server exposes is callable). Empty array = zero tools (deny everything). Otherwise: only the listed tool names are callable.",
        example: ["collections.list", "collections.read", "schema.list_collections"],
      }),
    mcpReadOnly: z.boolean().optional().openapi({
      description:
        "When true, MCP refuses every write tool (insert / update / delete / grant / revoke / invoke / assign / …) for requests authenticated with this key. REST surface for the same identity is unaffected.",
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
  })
  .openapi("ApiKeyRow");

const McpGuardsPatch = z
  .object({
    mcpTools: z.array(z.string().min(1).max(120)).nullable().optional(),
    mcpReadOnly: z.boolean().optional(),
  })
  .openapi("McpGuardsPatch");

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
});

export const apiKeysRoutes = new OpenAPIHono<AppBindings>()
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
      method: "post",
      path: "/",
      tags: ["api-keys"],
      summary: "Create API key",
      description:
        "Issues a new personal API key. The plaintext secret is returned once in the response body and never again.",
      security: SECURITY,
      middleware: [requireUser],
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
