import { Hono } from "hono";
import { z } from "zod";
import { AppError, SYSTEM_ROLES } from "@workeros/core";
import type { Context } from "hono";
import type { AppBindings } from "../app";
import { requireUser } from "../middleware/session";
import {
  createApiKey,
  listApiKeys,
  revokeApiKey,
} from "../services/api-keys";

const Input = z.object({
  name: z.string().min(1),
  userId: z.string().optional(),
  expiresAt: z.string().datetime().optional(),
});

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

const sanitize = (row: {
  id: string;
  tenantId: string | null;
  prefix: string;
  name: string;
  userId: string;
  expiresAt: unknown;
  lastUsedAt: unknown;
  revokedAt: unknown;
  createdAt?: unknown;
}) => ({
  id: row.id,
  tenantId: row.tenantId,
  prefix: row.prefix,
  name: row.name,
  userId: row.userId,
  expiresAt: row.expiresAt,
  lastUsedAt: row.lastUsedAt,
  revokedAt: row.revokedAt,
  createdAt: row.createdAt,
});

export const apiKeysRoutes = new Hono<AppBindings>()
  .get("/", requireUser, async (c) => {
    const ctx = c.get("ctx");
    const auth = c.get("auth");
    const tenantId = requireTenant(c);
    const isAdmin = auth.roles.includes(SYSTEM_ROLES.admin);
    const rows = await listApiKeys(ctx, tenantId, isAdmin ? null : auth.userId);
    return c.json({ data: rows.map(sanitize) });
  })
  .post("/", requireUser, async (c) => {
    const ctx = c.get("ctx");
    const auth = c.get("auth");
    const tenantId = requireTenant(c);
    const body = Input.parse(await c.req.json());
    const targetUserId = body.userId ?? auth.userId!;
    if (body.userId && body.userId !== auth.userId) requireAdmin(auth);
    const expiresAt = body.expiresAt ? new Date(body.expiresAt) : null;
    const { row, secret } = await createApiKey(ctx, {
      name: body.name,
      userId: targetUserId,
      tenantId,
      expiresAt,
    });
    return c.json(
      {
        data: { ...sanitize(row), secret },
        warning:
          "Store this secret now. It cannot be retrieved later — only revoked.",
      },
      201,
    );
  })
  .delete("/:id", requireUser, async (c) => {
    const ctx = c.get("ctx");
    const auth = c.get("auth");
    const tenantId = requireTenant(c);
    const id = c.req.param("id");
    const isAdmin = auth.roles.includes(SYSTEM_ROLES.admin);
    // listApiKeys is already tenant-scoped, so this both checks ownership
    // and confirms the key belongs to the active workspace in one shot.
    const visible = await listApiKeys(ctx, tenantId, isAdmin ? null : auth.userId);
    if (!visible.some((k) => k.id === id)) {
      throw new AppError("NOT_FOUND", "API key not found");
    }
    await revokeApiKey(ctx, tenantId, id);
    return c.json({ ok: true });
  });
