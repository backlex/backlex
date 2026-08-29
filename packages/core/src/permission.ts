export type Action = "read" | "create" | "update" | "delete" | "publish";

export interface ComparisonObj {
  _eq?: unknown;
  _neq?: unknown;
  _in?: unknown[];
  _nin?: unknown[];
  _gt?: unknown;
  _gte?: unknown;
  _lt?: unknown;
  _lte?: unknown;
  /** Inclusive range: `col BETWEEN lo AND hi`. */
  _between?: [unknown, unknown];
  _null?: boolean;
  _contains?: string;
  _starts_with?: string;
  _ends_with?: string;
  /** Case-insensitive variants (LOWER() both sides → PG/SQLite parity). */
  _icontains?: string;
  _istarts_with?: string;
  _iends_with?: string;
  /** `_empty: true` ⇒ NULL or empty string; `_nempty: true` ⇒ neither. */
  _empty?: boolean;
  _nempty?: boolean;
  /**
   * Proximity, on a `geo` field: `{ lat, lng, radius }`, where `radius` is a
   * number of kilometres or a string with a unit (`"5km"`, `"800m"`, `"3mi"`,
   * `"2nmi"`). Matches rows whose point lies within that radius of the origin.
   *
   * The one operator whose operand is an object rather than a scalar — a
   * proximity test needs three numbers and there is no scalar that carries
   * them. Rows with no point never match.
   *
   * Usable in permission conditions as well as list filters, which is what
   * makes "this role reads only the sites in its region" expressible.
   */
  _near?: unknown;
}

/**
 * Relative-date value usable anywhere a comparison value is expected (filters
 * AND permission rules), e.g. `{ placed_at: { _gte: { $now: { sub: { months: 1 } } } } }`.
 * Bare `"$now"` still means "this instant". Resolved server-side to the
 * dialect-correct physical representation (SQLite epoch-ms int / PG ISO string).
 */
export interface RelativeNow {
  $now: {
    add?: DurationParts;
    sub?: DurationParts;
  };
}

export interface DurationParts {
  years?: number;
  months?: number;
  weeks?: number;
  days?: number;
  hours?: number;
  minutes?: number;
  seconds?: number;
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
 *     on comparable BaaS platforms). They live in a tenant-scoped `app_users` table
 *     and can never be platform admins.
 *
 * Defaults to `"platform"` everywhere until the tenant-auth surface ships, so
 * existing behaviour is unchanged.
 */
export type AuthPlane = "platform" | "app";

/** A member's standing inside one app-plane organization. Fixed vocabulary:
 *  `owner` may delete the org and transfer ownership, `admin` may invite and
 *  manage members, `member` may do neither. Distinct from the workspace
 *  `roles` a member can also hold *within* an org — those drive data-plane
 *  permissions, this drives org administration. */
export type OrgRole = "owner" | "admin" | "member";

export const ORG_ROLES: readonly OrgRole[] = ["owner", "admin", "member"];

/** Rank for "at least this role" checks — higher outranks lower. */
export const ORG_ROLE_RANK: Record<OrgRole, number> = {
  owner: 3,
  admin: 2,
  member: 1,
};

export const isOrgRole = (v: unknown): v is OrgRole =>
  typeof v === "string" && (ORG_ROLES as readonly string[]).includes(v);

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
  /** MCP guards carried by the credential itself, as opposed to by its owner's
   *  roles: the key's tool allowlist and its read-only flag. Set by
   *  `sessionMiddleware` — an OAuth token without the `mcp:write` scope arrives
   *  read-only here too. Declared on the subject because more than the MCP
   *  dispatcher needs them: anything that runs tools on the caller's behalf has
   *  to be able to resolve the same boundary. */
  apiKeyMcpTools?: string[] | null;
  apiKeyMcpReadOnly?: boolean;
  /**
   * App-plane organization context, resolved by `tenantMiddleware` for
   * `plane: "app"` requests (see `services/app-orgs.ts::resolveOrgContext`).
   * Platform-plane identities never carry it.
   *
   *   - `orgId`   — the org this request is acting in (`$org.id`), picked from
   *                 the `X-Backlex-Org` header, else the session's active org,
   *                 else the sole membership. Null when the subject belongs to
   *                 no org, or to several with none selected.
   *   - `orgRole` — their membership role in that org (`$org.role`).
   *   - `orgIds`  — every org they belong to (`$user.orgs`), so a condition can
   *                 span all of them without an active selection.
   */
  orgId?: string | null;
  orgRole?: OrgRole | null;
  orgIds?: string[];
  /**
   * Set when this request is an operator ACTING AS one of the workspace's
   * end-users. The identity is genuinely the subject's — permissions, org
   * context and row conditions all resolve as they would for them, which is
   * the whole point — but everything the request writes carries the
   * impersonator so the audit trail names both.
   *
   * See `services/impersonation.ts`: the token names a row, and that row is
   * re-read on every request, so ending an impersonation is instant.
   */
  impersonatedBy?: string | null;
  impersonationId?: string | null;
  /** Default for an impersonation. Reproducing what a customer sees needs
   *  reads; changing their data on their behalf is a different act. */
  impersonationReadOnly?: boolean;
}

export const SYSTEM_ROLES = {
  admin: "admin",
  authenticated: "authenticated",
  public: "public",
} as const;

export type SystemRole = (typeof SYSTEM_ROLES)[keyof typeof SYSTEM_ROLES];
