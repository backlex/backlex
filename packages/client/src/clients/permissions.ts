import type { ClientCore } from "../core";

/** One permission row that granted the simulated action. */
export interface PermissionSimRule {
  permissionId: string;
  roleId: string;
  roleName: string;
  collection: string;
  condition: unknown | null;
  fields: string[] | null;
  rowMatch?: boolean;
}

/** Full reasoning trace returned by `permissions.simulate`. */
export interface PermissionSimulation {
  subject: {
    userId: string | null;
    email: string | null;
    roles: string[];
    tenantId: string | null;
    plane: "platform" | "app";
  };
  collection: string;
  action: string;
  allowed: boolean;
  isAdmin: boolean;
  reason: string;
  roles: { id: string; name: string; admin: boolean }[];
  matchedRules: PermissionSimRule[];
  resolvedVars: Record<string, unknown>;
  whereSql: { sql: string; params: unknown[] } | null;
  fields: string[] | null;
  rowMatch?: boolean;
}

/** Subject + target for a permission simulation. */
export interface PermissionSimulateInput {
  collection: string;
  action: "read" | "create" | "update" | "delete" | "publish";
  /** Existing user id — roles are read live from the DB. */
  userId?: string | null;
  /** Override email for `$user.email` resolution. */
  email?: string | null;
  /** Ad-hoc role names (ignored when `userId` is set). */
  roles?: string[] | null;
  /** `platform` (admin users, default) or `app` (workspace end-users). */
  plane?: "platform" | "app";
  /** Optional concrete row to evaluate against the combined condition. */
  sampleRow?: Record<string, unknown> | null;
}

/** Permission tooling (admin-scoped). Mirrors `/api/permissions`. */
export interface PermissionsClient {
  /** Dry-run the permission resolver for a subject against a
   *  (collection, action) and return the full allow/deny trace. Read-only. */
  simulate(input: PermissionSimulateInput): Promise<{ data: PermissionSimulation }>;
}

export const makePermissions = (core: ClientCore): PermissionsClient => {
  // Permission tooling — the simulator dry-runs the resolver for any subject
  // and returns the full allow/deny trace. Admin-scoped, read-only.
  const permissions: PermissionsClient = {
    simulate: (input: PermissionSimulateInput) =>
      core.request<{ data: PermissionSimulation }>(
        "POST",
        "/api/permissions/simulate",
        input,
      ),
  };

  return permissions;
};
