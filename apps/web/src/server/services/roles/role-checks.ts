import { and, eq } from "drizzle-orm";
import { AppError } from "@workeros/core";
import { tableFor } from "./tables";

/** Verify the role exists *and* belongs to the active tenant. Routes that
 *  accept a roleId path param call this before mutating to make sure admins
 *  can't reach across workspaces by guessing role ids. */
export const ensureRoleInTenant = async (
  ctx: { db: unknown; dialect: "pg" | "sqlite" },
  tenantId: string,
  roleId: string,
): Promise<{ id: string; name: string }> => {
  const t = tableFor(ctx.dialect);
  const rows = (await (ctx.db as any)
    .select({ id: t.roles.id, name: t.roles.name })
    .from(t.roles)
    .where(and(eq(t.roles.id, roleId), eq(t.roles.tenantId, tenantId)))
    .limit(1)) as { id: string; name: string }[];
  if (!rows[0]) throw new AppError("NOT_FOUND", "Role not found in this workspace");
  return rows[0];
};
