export type Action = "read" | "create" | "update" | "delete";

export interface ComparisonObj {
  _eq?: unknown;
  _neq?: unknown;
  _in?: unknown[];
  _nin?: unknown[];
  _gt?: unknown;
  _gte?: unknown;
  _lt?: unknown;
  _lte?: unknown;
  _null?: boolean;
  _contains?: string;
  _starts_with?: string;
  _ends_with?: string;
}

export type Condition =
  | { $and: Condition[] }
  | { $or: Condition[] }
  | { $not: Condition }
  | { [field: string]: ComparisonObj };

/**
 * Which auth "plane" an authenticated identity belongs to:
 *
 *   - `"platform"` — control-plane identities: the instance operator(s) and
 *     workspace members who sign in to the admin app via `/api/auth/*`. They
 *     live in the `users` table and may hold the global `admin` role.
 *   - `"app"` — workspace end-users: people who authenticate against a single
 *     workspace's own auth service (the "auth as a service" surface, modelled
 *     on Supabase/Directus). They live in a tenant-scoped `app_users` table
 *     and can never be platform admins.
 *
 * Defaults to `"platform"` everywhere until the tenant-auth surface ships, so
 * existing behaviour is unchanged.
 */
export type AuthPlane = "platform" | "app";

export interface AuthSubject {
  /** See {@link AuthPlane}. Absent ⇒ treat as `"platform"`. */
  plane?: AuthPlane;
  userId: string | null;
  email: string | null;
  roles: string[];
  /** Active workspace/tenant id for this request; null = single-tenant mode. */
  tenantId?: string | null;
  /** When the request authenticated with a role-scoped API key, the id of
   *  that role. Permission resolution then considers *only* this role (and
   *  only while the owner still holds it). Absent/null = no key scoping. */
  apiKeyRoleId?: string | null;
}

export const SYSTEM_ROLES = {
  admin: "admin",
  authenticated: "authenticated",
  public: "public",
} as const;

export type SystemRole = (typeof SYSTEM_ROLES)[keyof typeof SYSTEM_ROLES];
