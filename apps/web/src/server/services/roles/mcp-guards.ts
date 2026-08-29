/**
 * Resolve the MCP guards a caller inherits from their roles.
 *
 * Only the MCP mounts consult this — REST/GraphQL are governed by the
 * permission DSL alone. That's deliberate: the tool allowlist is about limiting
 * which *capabilities* an autonomous agent can reach for, not about row access,
 * which the DSL already decides. Running the lookup on the MCP path only also
 * keeps it off the hot REST path entirely.
 *
 * Admin roles are skipped: `roles.admin` already means "unrestricted", and a
 * tool allowlist on it would be a footgun with no matching UI affordance.
 */
import { and, eq } from "drizzle-orm";
import { SYSTEM_ROLES } from "@backlex/core";
import {
  combineRoleGuards,
  guardsFromAuth,
  mergeGuards,
  type KeyGuards,
  type RoleGuards,
} from "../../mcp/guards";
import { tableFor } from "./tables";

export interface RoleGuardCtx {
  db: unknown;
  dialect: "pg" | "sqlite";
}

/** Identity fields the lookup needs. Mirrors the subset of `c.var.auth` that
 *  `sessionMiddleware` populates. */
export interface RoleGuardIdentity {
  userId: string | null;
  /** When the request authenticated with a role-scoped API key, only that role
   *  counts — the same narrowing `tenantMiddleware` applies to `auth.roles`, so
   *  the guard set can't disagree with the permission set. */
  apiKeyRoleId?: string | null;
}

/** The permissive default — used for unauthenticated callers and whenever the
 *  lookup can't run (pre-migration deploy, transient error). Failing open here
 *  is correct: the per-key guards and the permission DSL are both still in
 *  force, and failing closed would dark the whole MCP surface on a bad read. */
const UNRESTRICTED: RoleGuards = { allowlist: null, readOnly: false };

export const loadRoleMcpGuards = async (
  ctx: RoleGuardCtx,
  identity: RoleGuardIdentity,
): Promise<RoleGuards> => {
  if (!identity.userId) return UNRESTRICTED;
  const t = tableFor(ctx.dialect);
  try {
    const rows = (await (ctx.db as any)
      .select({
        name: t.roles.name,
        admin: t.roles.admin,
        mcpTools: t.roles.mcpTools,
        mcpReadOnly: t.roles.mcpReadOnly,
      })
      .from(t.userRoles)
      .innerJoin(t.roles, eq(t.userRoles.roleId, t.roles.id))
      .where(
        identity.apiKeyRoleId
          ? and(
              eq(t.userRoles.userId, identity.userId),
              eq(t.roles.id, identity.apiKeyRoleId),
            )
          : eq(t.userRoles.userId, identity.userId),
      )) as {
      name: string;
      admin: boolean | number | null;
      mcpTools: string[] | null;
      mcpReadOnly: boolean | number | null;
    }[];

    const applicable = rows.filter(
      (r) => !r.admin && r.name !== SYSTEM_ROLES.admin,
    );
    // A user whose only roles are admin roles has no applicable contribution —
    // and `combineRoleGuards([])` correctly returns "no policy" rather than the
    // deny-everything an empty allowlist would mean. Ordinary users always
    // carry the policy-free `authenticated` role, which `combineRoleGuards`
    // ignores rather than reading as a blanket allow.
    return combineRoleGuards(
      applicable.map((r) => ({
        allowlist: Array.isArray(r.mcpTools) ? r.mcpTools : null,
        readOnly: Boolean(r.mcpReadOnly),
      })),
    );
  } catch (e) {
    console.error("[mcp-guards] role lookup failed; falling back to open", e);
    return UNRESTRICTED;
  }
};

/**
 * The caller's **effective** MCP guards: what their credential restricts folded
 * together with what their roles do. Both only ever narrow.
 *
 * Lives here rather than in `mcp/guards.ts` because it needs the role lookup,
 * and it is shared rather than duplicated because two surfaces must not be able
 * to disagree about what bounds the same caller: the MCP dispatcher answering a
 * direct `tools/call`, and the agent runner executing a tool on the caller's
 * behalf. When those drifted apart, the second one enforced nothing.
 */
export const resolveCallerMcpGuards = async (
  ctx: RoleGuardCtx | null | undefined,
  auth: {
    userId?: string | null;
    apiKeyRoleId?: string | null;
    apiKeyMcpTools?: string[] | null;
    apiKeyMcpReadOnly?: boolean;
  },
): Promise<KeyGuards> => {
  const keyGuards = guardsFromAuth(auth);
  if (!ctx?.db || !ctx.dialect) return keyGuards;
  const role = await loadRoleMcpGuards(ctx, {
    userId: auth.userId ?? null,
    apiKeyRoleId: auth.apiKeyRoleId ?? null,
  });
  return mergeGuards(keyGuards, role);
};
