import { and, eq } from "drizzle-orm";
import { AppError } from "@backlex/core";
import { tableFor } from "./tables";

/** Verify the role exists *and* belongs to the active tenant. Routes that
 *  accept a roleId path param call this before mutating to make sure admins
 *  can't reach across workspaces by guessing role ids. */
export const ensureRoleInTenant = async (
  ctx: { db: unknown; dialect: "pg" | "sqlite" },
  tenantId: string,
  roleId: string,
): Promise<{ id: string; name: string; admin: boolean }> => {
  const t = tableFor(ctx.dialect);
  // `admin` rides along because the audit log needs the BEFORE value of the
  // privilege flag: a role gaining `admin` is the escalation event, and after
  // the UPDATE has run there is nothing left to compare against.
  const rows = (await (ctx.db as any)
    .select({ id: t.roles.id, name: t.roles.name, admin: t.roles.admin })
    .from(t.roles)
    .where(and(eq(t.roles.id, roleId), eq(t.roles.tenantId, tenantId)))
    .limit(1)) as { id: string; name: string; admin: boolean }[];
  if (!rows[0]) throw new AppError("NOT_FOUND", "Role not found in this workspace");
  return rows[0];
};
