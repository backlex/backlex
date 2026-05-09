import { Hono } from "hono";
import { z } from "zod";
import { AppError, SYSTEM_ROLES } from "@workeros/core";
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

const sanitize = (
  row: { id: string; prefix: string; name: string; userId: string; expiresAt: unknown; lastUsedAt: unknown; revokedAt: unknown; createdAt?: unknown },
) => ({
  id: row.id,
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
    const isAdmin = auth.roles.includes(SYSTEM_ROLES.admin);
    const rows = await listApiKeys(ctx, isAdmin ? null : auth.userId);
    return c.json({ data: rows.map(sanitize) });
  })
  .post("/", requireUser, async (c) => {
    const ctx = c.get("ctx");
    const auth = c.get("auth");
    const body = Input.parse(await c.req.json());
    const targetUserId = body.userId ?? auth.userId!;
    if (body.userId && body.userId !== auth.userId) requireAdmin(auth);
    const expiresAt = body.expiresAt ? new Date(body.expiresAt) : null;
    const { row, secret } = await createApiKey(ctx, {
      name: body.name,
      userId: targetUserId,
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
    const id = c.req.param("id");
    const isAdmin = auth.roles.includes(SYSTEM_ROLES.admin);
    if (!isAdmin) {
      const owned = await listApiKeys(ctx, auth.userId);
      if (!owned.some((k) => k.id === id)) {
        throw new AppError("NOT_FOUND", "API key not found");
      }
    }
    await revokeApiKey(ctx, id);
    return c.json({ ok: true });
  });
