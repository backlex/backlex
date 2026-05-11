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

export interface AuthSubject {
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
