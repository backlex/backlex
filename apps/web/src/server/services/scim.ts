/**
 * SCIM 2.0 provisioning (RFC 7643 schema / RFC 7644 protocol).
 *
 * SSO answers "who is signing in"; SCIM answers "who exists". An IdP calls this
 * endpoint on its own schedule to create, update and — the part SSO structurally
 * cannot do — DEPROVISION accounts. A user removed in Okta must lose access here
 * without ever visiting the app again.
 *
 * SCIM users live in the **app plane** (`app_users`), the same plane SAML/LDAP
 * provisioning targets, and SCIM Groups map onto backlex `roles` so membership
 * pushes land in `app_user_roles`.
 *
 * Deactivation is a STATUS FLIP, never a row delete — including for
 * `DELETE /Users/:id`. An IdP that unassigns and re-assigns a user (a routine
 * Okta operation) would otherwise destroy and re-create the account, orphaning
 * everything the old id owned. RFC 7644 permits this: `DELETE` need only make
 * the resource inaccessible.
 */
import { and, asc, eq, sql } from "drizzle-orm";
import { AppError } from "@backlex/core";
import * as pg from "@backlex/db/pg";
import * as sqlite from "@backlex/db/sqlite";
import type { PgDb } from "@backlex/db/pg";
import type { SqliteDb } from "@backlex/db/sqlite";
import { hashKey } from "./api-keys";

type DbCtx = { db: PgDb | SqliteDb; dialect: "pg" | "sqlite" };
type AnyDb = any;

const T = (dialect: "pg" | "sqlite") =>
  (dialect === "pg"
    ? {
        scimConfig: pg.schema.scimConfig,
        appUsers: pg.schema.appUsers,
        appUserRoles: pg.schema.appUserRoles,
        roles: pg.schema.roles,
        externalIdentities: pg.schema.externalIdentities,
      }
    : {
        scimConfig: sqlite.schema.scimConfig,
        appUsers: sqlite.schema.appUsers,
        appUserRoles: sqlite.schema.appUserRoles,
        roles: sqlite.schema.roles,
        externalIdentities: sqlite.schema.externalIdentities,
      }) as {
    scimConfig: typeof pg.schema.scimConfig;
    appUsers: typeof pg.schema.appUsers;
    appUserRoles: typeof pg.schema.appUserRoles;
    roles: typeof pg.schema.roles;
    externalIdentities: typeof pg.schema.externalIdentities;
  };

/** `external_identities.provider_type` value for SCIM-created accounts. */
export const SCIM_PROVIDER_TYPE = "scim";
const SCIM_PROVIDER_ID = "scim";

export interface ScimConfigRow {
  id: string;
  tenantId: string;
  tokenHash: string;
  tokenPrefix: string;
  defaultRoleId: string | null;
  lastRequestAt: Date | number | null;
  enabled: boolean | number;
  createdAt: Date | number | null;
  updatedAt: Date | number | null;
}

/** Admin view — never includes the token or its hash. */
export const toPublicConfig = (row: ScimConfigRow) => ({
  id: row.id,
  enabled: Boolean(row.enabled),
  tokenPrefix: row.tokenPrefix,
  defaultRoleId: row.defaultRoleId,
  lastRequestAt: row.lastRequestAt,
  createdAt: row.createdAt,
  updatedAt: row.updatedAt,
});

const randomToken = (): string => {
  const buf = new Uint8Array(32);
  crypto.getRandomValues(buf);
  return `scim_${Array.from(buf, (b) => b.toString(16).padStart(2, "0")).join("")}`;
};

/* ───────────────────────── config (admin side) ───────────────────────── */

export async function getScimConfig(ctx: DbCtx, tenantId: string) {
  const t = T(ctx.dialect);
  try {
    const [row] = (await (ctx.db as AnyDb)
      .select()
      .from(t.scimConfig)
      .where(eq(t.scimConfig.tenantId, tenantId))) as ScimConfigRow[];
    return row ? toPublicConfig(row) : null;
  } catch {
    // Table not migrated yet — behave as "SCIM not configured".
    return null;
  }
}

/**
 * Create the workspace's SCIM endpoint, or rotate its token. Returns the
 * plaintext token EXACTLY ONCE — there is no read-back path, so a caller that
 * discards it must rotate again.
 */
export async function issueScimToken(
  ctx: DbCtx,
  tenantId: string,
  opts: { defaultRoleId?: string | null } = {},
): Promise<{ config: ReturnType<typeof toPublicConfig>; token: string }> {
  const t = T(ctx.dialect);
  const db = ctx.db as AnyDb;
  const token = randomToken();
  const tokenHash = await hashKey(token);
  const tokenPrefix = token.slice(0, 12);
  const now = new Date();

  const [existing] = (await db
    .select()
    .from(t.scimConfig)
    .where(eq(t.scimConfig.tenantId, tenantId))) as ScimConfigRow[];

  if (existing) {
    await db
      .update(t.scimConfig)
      .set({
        tokenHash,
        tokenPrefix,
        enabled: true,
        ...(opts.defaultRoleId !== undefined ? { defaultRoleId: opts.defaultRoleId } : {}),
        updatedAt: now,
      })
      .where(eq(t.scimConfig.id, existing.id));
  } else {
    await db.insert(t.scimConfig).values({
      id: crypto.randomUUID(),
      tenantId,
      tokenHash,
      tokenPrefix,
      defaultRoleId: opts.defaultRoleId ?? null,
      enabled: true,
    });
  }
  const [row] = (await db
    .select()
    .from(t.scimConfig)
    .where(eq(t.scimConfig.tenantId, tenantId))) as ScimConfigRow[];
  if (!row) throw new AppError("INTERNAL", "scim_config row missing after write");
  return { config: toPublicConfig(row), token };
}

export async function updateScimConfig(
  ctx: DbCtx,
  tenantId: string,
  patch: { enabled?: boolean; defaultRoleId?: string | null },
): Promise<ReturnType<typeof toPublicConfig>> {
  const t = T(ctx.dialect);
  const db = ctx.db as AnyDb;
  const set: Record<string, unknown> = { updatedAt: new Date() };
  if (patch.enabled !== undefined) set.enabled = patch.enabled;
  if (patch.defaultRoleId !== undefined) set.defaultRoleId = patch.defaultRoleId;
  await db.update(t.scimConfig).set(set).where(eq(t.scimConfig.tenantId, tenantId));
  const [row] = (await db
    .select()
    .from(t.scimConfig)
    .where(eq(t.scimConfig.tenantId, tenantId))) as ScimConfigRow[];
  if (!row) throw new AppError("NOT_FOUND", "SCIM is not configured for this workspace");
  return toPublicConfig(row);
}

export async function deleteScimConfig(ctx: DbCtx, tenantId: string): Promise<void> {
  const t = T(ctx.dialect);
  await (ctx.db as AnyDb).delete(t.scimConfig).where(eq(t.scimConfig.tenantId, tenantId));
}

/* ───────────────────────── token auth (IdP side) ───────────────────────── */

/**
 * Resolve a bearer token to the workspace it provisions.
 *
 * Fails CLOSED on every path: a missing header, a malformed scheme, an unknown
 * hash, or a disabled row all return null. The caller must treat null as 401 and
 * MUST NOT fall back to any ambient tenant — this endpoint is unauthenticated
 * until this function says otherwise, so a fallthrough here is a cross-workspace
 * write primitive.
 */
export async function resolveScimTenant(
  ctx: DbCtx,
  authorizationHeader: string | null | undefined,
): Promise<{ tenantId: string; configId: string; defaultRoleId: string | null } | null> {
  if (!authorizationHeader) return null;
  const m = /^Bearer\s+(.+)$/i.exec(authorizationHeader.trim());
  const raw = m?.[1]?.trim();
  if (!raw) return null;

  const t = T(ctx.dialect);
  let rows: ScimConfigRow[];
  try {
    const tokenHash = await hashKey(raw);
    rows = (await (ctx.db as AnyDb)
      .select()
      .from(t.scimConfig)
      .where(eq(t.scimConfig.tokenHash, tokenHash))) as ScimConfigRow[];
  } catch {
    return null;
  }
  const row = rows[0];
  if (!row || !(row.enabled === true || row.enabled === 1)) return null;
  return { tenantId: row.tenantId, configId: row.id, defaultRoleId: row.defaultRoleId };
}

/** Best-effort "the IdP is talking to us" timestamp. Never fails a request. */
export async function touchScimConfig(ctx: DbCtx, configId: string): Promise<void> {
  const t = T(ctx.dialect);
  try {
    await (ctx.db as AnyDb)
      .update(t.scimConfig)
      .set({ lastRequestAt: new Date() })
      .where(eq(t.scimConfig.id, configId));
  } catch {
    /* ignore */
  }
}

/* ───────────────────────── SCIM resource shapes ───────────────────────── */

export const SCIM_USER_SCHEMA = "urn:ietf:params:scim:schemas:core:2.0:User";
export const SCIM_GROUP_SCHEMA = "urn:ietf:params:scim:schemas:core:2.0:Group";
export const SCIM_LIST_SCHEMA = "urn:ietf:params:scim:api:messages:2.0:ListResponse";
export const SCIM_PATCH_SCHEMA = "urn:ietf:params:scim:api:messages:2.0:PatchOp";
export const SCIM_ERROR_SCHEMA = "urn:ietf:params:scim:api:messages:2.0:Error";

interface AppUserRow {
  id: string;
  tenantId: string;
  email: string;
  name: string | null;
  status: string;
  createdAt: Date | number | null;
  updatedAt: Date | number | null;
}

const iso = (v: Date | number | null | undefined): string | undefined => {
  if (v == null) return undefined;
  const d = v instanceof Date ? v : new Date(v);
  return Number.isNaN(d.getTime()) ? undefined : d.toISOString();
};

/** Split a stored display name into the given/family pair SCIM expects. */
const splitName = (name: string | null) => {
  const parts = (name ?? "").trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return { givenName: undefined, familyName: undefined };
  if (parts.length === 1) return { givenName: parts[0], familyName: undefined };
  return { givenName: parts[0], familyName: parts.slice(1).join(" ") };
};

export const toScimUser = (row: AppUserRow, groups: { value: string; display: string }[] = []) => {
  const { givenName, familyName } = splitName(row.name);
  return {
    schemas: [SCIM_USER_SCHEMA],
    id: row.id,
    userName: row.email,
    // `active: false` is how the IdP sees a deactivated account. It maps to
    // app_users.status, not to the row's absence.
    active: row.status === "active",
    ...(row.name ? { displayName: row.name } : {}),
    ...(givenName || familyName ? { name: { givenName, familyName } } : {}),
    emails: [{ value: row.email, primary: true, type: "work" }],
    ...(groups.length ? { groups } : {}),
    meta: {
      resourceType: "User",
      created: iso(row.createdAt),
      lastModified: iso(row.updatedAt),
      location: `/api/scim/v2/Users/${row.id}`,
    },
  };
};

export const scimList = (
  resources: unknown[],
  { totalResults, startIndex }: { totalResults: number; startIndex: number },
) => ({
  schemas: [SCIM_LIST_SCHEMA],
  totalResults,
  // SCIM pagination is 1-BASED. Reporting 0 here makes Okta re-request the same
  // page forever.
  startIndex,
  itemsPerPage: resources.length,
  Resources: resources,
});

/* ───────────────────────── filter parsing ───────────────────────── */

/**
 * The sliver of RFC 7644 §3.4.2.2 that real IdPs send: `userName eq "x"` and
 * `displayName eq "x"`. Anything else is reported rather than silently ignored —
 * quietly dropping a filter would return the whole directory to a caller that
 * asked for one user, and Okta would then treat every existing user as a
 * duplicate-detection hit.
 */
export function parseEqFilter(
  filter: string | undefined,
  allowed: string[],
): { attribute: string; value: string } | null {
  if (!filter?.trim()) return null;
  const m = /^\s*([A-Za-z][\w.]*)\s+eq\s+"((?:[^"\\]|\\.)*)"\s*$/.exec(filter);
  if (!m) {
    throw new AppError("VALIDATION", `Unsupported SCIM filter: ${filter}`);
  }
  const attribute = m[1]!;
  if (!allowed.some((a) => a.toLowerCase() === attribute.toLowerCase())) {
    throw new AppError("VALIDATION", `Filtering on "${attribute}" is not supported`);
  }
  return { attribute, value: m[2]!.replace(/\\(.)/g, "$1") };
}

/* ───────────────────────── users ───────────────────────── */

const roleNamesFor = async (
  ctx: DbCtx,
  appUserId: string,
): Promise<{ value: string; display: string }[]> => {
  const t = T(ctx.dialect);
  const rows = (await (ctx.db as AnyDb)
    .select({ id: t.roles.id, name: t.roles.name })
    .from(t.appUserRoles)
    .innerJoin(t.roles, eq(t.roles.id, t.appUserRoles.roleId))
    .where(eq(t.appUserRoles.appUserId, appUserId))) as { id: string; name: string }[];
  return rows.map((r) => ({ value: r.id, display: r.name }));
};

export async function listScimUsers(
  ctx: DbCtx,
  tenantId: string,
  opts: { filter?: string; startIndex?: number; count?: number },
) {
  const t = T(ctx.dialect);
  const db = ctx.db as AnyDb;
  const parsed = parseEqFilter(opts.filter, ["userName", "email", "externalId"]);
  const startIndex = Math.max(1, opts.startIndex ?? 1);
  const count = Math.min(Math.max(opts.count ?? 100, 0), 200);

  const where = parsed
    ? and(eq(t.appUsers.tenantId, tenantId), eq(t.appUsers.email, parsed.value))
    : eq(t.appUsers.tenantId, tenantId);

  const counted = (await db
    .select({ n: sql<number>`count(*)` })
    .from(t.appUsers)
    .where(where)) as { n: number }[];
  const total = Number(counted[0]?.n ?? 0);

  const rows =
    count === 0
      ? []
      : ((await db
          .select()
          .from(t.appUsers)
          .where(where)
          .orderBy(asc(t.appUsers.createdAt))
          .limit(count)
          .offset(startIndex - 1)) as AppUserRow[]);

  const resources = [];
  for (const row of rows) resources.push(toScimUser(row, await roleNamesFor(ctx, row.id)));
  return scimList(resources, { totalResults: total, startIndex });
}

export async function getScimUser(ctx: DbCtx, tenantId: string, id: string) {
  const t = T(ctx.dialect);
  const [row] = (await (ctx.db as AnyDb)
    .select()
    .from(t.appUsers)
    .where(and(eq(t.appUsers.tenantId, tenantId), eq(t.appUsers.id, id)))) as AppUserRow[];
  if (!row) return null;
  return toScimUser(row, await roleNamesFor(ctx, row.id));
}

export interface ScimUserInput {
  userName?: string;
  active?: boolean;
  displayName?: string;
  name?: { givenName?: string; familyName?: string };
  emails?: { value?: string; primary?: boolean }[];
}

/** Pick the address SCIM means: `userName` first, else the primary email. */
const emailOf = (body: ScimUserInput): string | null => {
  const direct = body.userName?.trim();
  if (direct) return direct.toLowerCase();
  const primary = body.emails?.find((e) => e.primary)?.value ?? body.emails?.[0]?.value;
  return primary?.trim().toLowerCase() ?? null;
};

const nameOf = (body: ScimUserInput): string | null => {
  if (body.displayName?.trim()) return body.displayName.trim();
  const parts = [body.name?.givenName, body.name?.familyName].filter(
    (s): s is string => !!s?.trim(),
  );
  return parts.length ? parts.join(" ") : null;
};

export async function createScimUser(
  ctx: DbCtx,
  tenantId: string,
  defaultRoleId: string | null,
  body: ScimUserInput,
) {
  const t = T(ctx.dialect);
  const db = ctx.db as AnyDb;
  const email = emailOf(body);
  if (!email) throw new AppError("VALIDATION", "userName (or a primary email) is required");

  const [existing] = (await db
    .select()
    .from(t.appUsers)
    .where(and(eq(t.appUsers.tenantId, tenantId), eq(t.appUsers.email, email)))) as AppUserRow[];
  if (existing) {
    // RFC 7644 §3.3: uniqueness violations are 409. Okta relies on this to
    // switch from create to update rather than retrying forever.
    throw new AppError("CONFLICT", `A user with userName "${email}" already exists`);
  }

  const id = crypto.randomUUID();
  await db.insert(t.appUsers).values({
    id,
    tenantId,
    email,
    name: nameOf(body),
    // SCIM's default for a created user is active unless told otherwise.
    status: body.active === false ? "suspended" : "active",
    ...(body.active === false ? { suspendedAt: new Date() } : {}),
  });

  if (defaultRoleId) {
    try {
      await db.insert(t.appUserRoles).values({ appUserId: id, roleId: defaultRoleId });
    } catch {
      // A stale defaultRoleId must not fail provisioning.
    }
  }
  // Record provenance so the admin can see the account came from the directory.
  try {
    await db.insert(t.externalIdentities).values({
      id: crypto.randomUUID(),
      tenantId,
      plane: "app",
      userId: id,
      providerType: SCIM_PROVIDER_TYPE,
      providerId: SCIM_PROVIDER_ID,
      subject: email,
      emailAtProvision: email,
    });
  } catch {
    /* provenance is best-effort */
  }

  const created = await getScimUser(ctx, tenantId, id);
  if (!created) throw new AppError("INTERNAL", "app_user row missing after insert");
  return created;
}

/** Apply a replace/merge of the SCIM-writable attributes. */
export async function replaceScimUser(
  ctx: DbCtx,
  tenantId: string,
  id: string,
  body: ScimUserInput,
) {
  const t = T(ctx.dialect);
  const db = ctx.db as AnyDb;
  const [row] = (await db
    .select()
    .from(t.appUsers)
    .where(and(eq(t.appUsers.tenantId, tenantId), eq(t.appUsers.id, id)))) as AppUserRow[];
  if (!row) return null;

  const set: Record<string, unknown> = { updatedAt: new Date() };
  const email = emailOf(body);
  if (email && email !== row.email) set.email = email;
  const name = nameOf(body);
  if (name !== null) set.name = name;
  if (body.active !== undefined) {
    set.status = body.active ? "active" : "suspended";
    set.suspendedAt = body.active ? null : new Date();
  }
  await db
    .update(t.appUsers)
    .set(set)
    .where(and(eq(t.appUsers.tenantId, tenantId), eq(t.appUsers.id, id)));
  return getScimUser(ctx, tenantId, id);
}

export interface ScimPatchOp {
  op?: string;
  path?: string;
  value?: unknown;
}

/**
 * Apply a PATCH document. Okta's deactivate is
 * `{ op: "replace", value: { active: false } }` — a valueless-path form — while
 * Entra sends `{ op: "replace", path: "active", value: false }`. Both are legal
 * and both must work, so each op is normalized into the same attribute map.
 */
export async function patchScimUser(
  ctx: DbCtx,
  tenantId: string,
  id: string,
  ops: ScimPatchOp[],
) {
  const merged: ScimUserInput = {};
  for (const op of ops) {
    const kind = (op.op ?? "").toLowerCase();
    if (kind !== "replace" && kind !== "add") continue; // `remove` has no SCIM-writable target here
    const path = op.path?.trim();
    if (!path) {
      // Path-less op: `value` is an attribute bag.
      const bag = (op.value ?? {}) as Record<string, unknown>;
      if (typeof bag.active === "boolean") merged.active = bag.active;
      if (typeof bag.userName === "string") merged.userName = bag.userName;
      if (typeof bag.displayName === "string") merged.displayName = bag.displayName;
      if (bag.name && typeof bag.name === "object") merged.name = bag.name as ScimUserInput["name"];
      continue;
    }
    const attr = path.toLowerCase();
    if (attr === "active") {
      merged.active =
        typeof op.value === "boolean" ? op.value : String(op.value).toLowerCase() === "true";
    } else if (attr === "username") {
      if (typeof op.value === "string") merged.userName = op.value;
    } else if (attr === "displayname") {
      if (typeof op.value === "string") merged.displayName = op.value;
    } else if (attr === "name.givenname") {
      merged.name = { ...merged.name, givenName: String(op.value) };
    } else if (attr === "name.familyname") {
      merged.name = { ...merged.name, familyName: String(op.value) };
    }
  }
  if (Object.keys(merged).length === 0) {
    // Nothing we manage changed; echo the current state rather than 400 — IdPs
    // send ops for attributes we deliberately do not store.
    return getScimUser(ctx, tenantId, id);
  }
  return replaceScimUser(ctx, tenantId, id, merged);
}

/**
 * SCIM delete = deactivate. See the module header: a hard delete would destroy
 * an account (and everything keyed to its id) on a routine IdP unassign.
 * Returns false when the user does not exist in this workspace.
 */
export async function deactivateScimUser(
  ctx: DbCtx,
  tenantId: string,
  id: string,
): Promise<boolean> {
  const t = T(ctx.dialect);
  const db = ctx.db as AnyDb;
  const [row] = (await db
    .select()
    .from(t.appUsers)
    .where(and(eq(t.appUsers.tenantId, tenantId), eq(t.appUsers.id, id)))) as AppUserRow[];
  if (!row) return false;
  await db
    .update(t.appUsers)
    .set({ status: "suspended", suspendedAt: new Date(), updatedAt: new Date() })
    .where(and(eq(t.appUsers.tenantId, tenantId), eq(t.appUsers.id, id)));
  return true;
}

/* ───────────────────────── groups (= roles) ───────────────────────── */

interface RoleRow {
  id: string;
  tenantId: string | null;
  name: string;
  createdAt: Date | number | null;
  updatedAt?: Date | number | null;
}

/**
 * Members of a role, restricted to THIS workspace's users.
 *
 * The tenant filter is load-bearing, not defensive. The SCIM group list
 * deliberately includes the global system roles (`roles.tenant_id IS NULL`), and
 * those are held by users in every workspace — so joining on `role_id` alone
 * would list another workspace's user ids and email addresses to this
 * workspace's SCIM client.
 */
const membersOf = async (ctx: DbCtx, tenantId: string, roleId: string) => {
  const t = T(ctx.dialect);
  const rows = (await (ctx.db as AnyDb)
    .select({ id: t.appUsers.id, email: t.appUsers.email })
    .from(t.appUserRoles)
    .innerJoin(t.appUsers, eq(t.appUsers.id, t.appUserRoles.appUserId))
    .where(
      and(eq(t.appUserRoles.roleId, roleId), eq(t.appUsers.tenantId, tenantId)),
    )) as { id: string; email: string }[];
  return rows.map((r) => ({ value: r.id, display: r.email }));
};

export const toScimGroup = (
  role: RoleRow,
  members: { value: string; display: string }[],
) => ({
  schemas: [SCIM_GROUP_SCHEMA],
  id: role.id,
  displayName: role.name,
  members,
  meta: {
    resourceType: "Group",
    created: iso(role.createdAt),
    lastModified: iso(role.updatedAt ?? role.createdAt),
    location: `/api/scim/v2/Groups/${role.id}`,
  },
});

/** Roles visible to SCIM: the workspace's own plus the global system roles. */
const roleScope = (t: ReturnType<typeof T>, tenantId: string) =>
  sql`(${t.roles.tenantId} = ${tenantId} OR ${t.roles.tenantId} IS NULL)`;

export async function listScimGroups(
  ctx: DbCtx,
  tenantId: string,
  opts: { filter?: string; startIndex?: number; count?: number },
) {
  const t = T(ctx.dialect);
  const db = ctx.db as AnyDb;
  const parsed = parseEqFilter(opts.filter, ["displayName"]);
  const startIndex = Math.max(1, opts.startIndex ?? 1);
  const count = Math.min(Math.max(opts.count ?? 100, 0), 200);

  const where = parsed
    ? and(roleScope(t, tenantId), eq(t.roles.name, parsed.value))
    : roleScope(t, tenantId);

  const counted = (await db
    .select({ n: sql<number>`count(*)` })
    .from(t.roles)
    .where(where)) as { n: number }[];
  const total = Number(counted[0]?.n ?? 0);
  const rows =
    count === 0
      ? []
      : ((await db
          .select()
          .from(t.roles)
          .where(where)
          .orderBy(asc(t.roles.name))
          .limit(count)
          .offset(startIndex - 1)) as RoleRow[]);

  const resources = [];
  for (const role of rows) resources.push(toScimGroup(role, await membersOf(ctx, tenantId, role.id)));
  return scimList(resources, { totalResults: total, startIndex });
}

export async function getScimGroup(ctx: DbCtx, tenantId: string, id: string) {
  const t = T(ctx.dialect);
  const [role] = (await (ctx.db as AnyDb)
    .select()
    .from(t.roles)
    .where(and(roleScope(t, tenantId), eq(t.roles.id, id)))) as RoleRow[];
  if (!role) return null;
  return toScimGroup(role, await membersOf(ctx, tenantId, role.id));
}

/**
 * Apply membership ops to a group. Only `members` is writable: SCIM must not be
 * able to invent or rename a backlex role, because a role name is what
 * permission rows are bound to. An IdP pushing an unknown group gets 404 so the
 * operator sees it and creates the role deliberately.
 */
/**
 * Split a SCIM PATCH `path` into its attribute and any inline member filter.
 *
 * RFC 7644 §3.5.2.2's canonical removal form is `members[value eq "<id>"]`, and
 * it is what Okta emits — matching `path` against the literal `"members"` drops
 * it silently, which means a deprovision answers 200 while the role stays.
 * Entra sends `{path: "members", value: [...]}` instead, which is why the gap
 * survives a smoke test against one IdP.
 *
 * The attribute is lower-cased; the operand deliberately is NOT. User ids are
 * case-sensitive, so folding the whole path would turn a real id into one that
 * matches nobody — the same silent no-op by another route.
 */
export const parseMemberPath = (
  raw: string | undefined,
): { attr: string; filtered: string[]; hadFilter: boolean } => {
  const path = (raw ?? "").trim();
  if (!path) return { attr: "", filtered: [], hadFilter: false };
  const open = path.indexOf("[");
  if (open < 0 || !path.endsWith("]")) {
    return { attr: path.toLowerCase(), filtered: [], hadFilter: false };
  }
  const attr = path.slice(0, open).trim().toLowerCase();
  const filter = path.slice(open + 1, -1);
  // Only `value eq <id>` is recognised. Anything else is left unresolved rather
  // than guessed at — but `hadFilter` still says a subset was NAMED, so the
  // caller treats it as a no-op instead of letting it reach the clear-all
  // branch. An unparsed filter must never mean "everyone".
  const m = /^\s*value\s+eq\s+(?:"([^"]*)"|'([^']*)'|(\S+))\s*$/i.exec(filter);
  const operand = m?.[1] ?? m?.[2] ?? m?.[3];
  return { attr, filtered: operand ? [operand] : [], hadFilter: true };
};

export async function patchScimGroup(
  ctx: DbCtx,
  tenantId: string,
  id: string,
  ops: ScimPatchOp[],
) {
  const t = T(ctx.dialect);
  const db = ctx.db as AnyDb;
  const [role] = (await db
    .select()
    .from(t.roles)
    .where(and(roleScope(t, tenantId), eq(t.roles.id, id)))) as RoleRow[];
  if (!role) return null;

  const memberIds = (value: unknown): string[] => {
    const arr = Array.isArray(value) ? value : value == null ? [] : [value];
    return arr
      .map((v) =>
        typeof v === "string" ? v : ((v as { value?: unknown })?.value as string | undefined),
      )
      .filter((v): v is string => typeof v === "string" && v.length > 0);
  };

  /** Only members that exist IN THIS WORKSPACE may be bound to a role. */
  const ownedBy = async (ids: string[]): Promise<string[]> => {
    const out: string[] = [];
    for (const uid of ids) {
      const [row] = (await db
        .select({ id: t.appUsers.id })
        .from(t.appUsers)
        .where(and(eq(t.appUsers.tenantId, tenantId), eq(t.appUsers.id, uid)))) as { id: string }[];
      if (row) out.push(row.id);
    }
    return out;
  };

  for (const op of ops) {
    const kind = (op.op ?? "").toLowerCase();
    const { attr, filtered, hadFilter } = parseMemberPath(op.path);
    if (attr !== "members" && attr !== "") continue;
    // A path-less op carries `{ members: [...] }`; `path: "members"` carries the
    // list directly; `members[value eq "id"]` carries it in the path itself.
    const fromValue = attr === "" ? (op.value as { members?: unknown })?.members : op.value;
    // Whether a target set was NAMED, not whether it resolved. Three cases the
    // clear-all fallback below has to tell apart, and only the first may clear:
    //   no value and no filter   → "everyone"      (RFC 7644)
    //   value: []                → "nobody"
    //   value: [<stale id>]      → "nobody we own"
    //   an unparsed filter       → "nobody we could name"
    const namedAny = fromValue !== undefined || hadFilter;
    const ids = await ownedBy([...memberIds(fromValue), ...filtered]);

    if (kind === "add") {
      for (const uid of ids) {
        try {
          await db.insert(t.appUserRoles).values({ appUserId: uid, roleId: id });
        } catch {
          /* already a member */
        }
      }
    } else if (kind === "remove") {
      // A `remove` that names nobody at all clears the whole membership, per
      // RFC 7644. A `remove` that DID name someone but resolved to nothing —
      // a stale id, or one belonging to another workspace — must be a no-op:
      // treating it as "clear everything" would let a single dangling id from
      // an IdP mass-revoke a role.
      const targets = namedAny
        ? ids
        : (await membersOf(ctx, tenantId, id)).map((m) => m.value);
      for (const uid of targets) {
        await db
          .delete(t.appUserRoles)
          .where(and(eq(t.appUserRoles.appUserId, uid), eq(t.appUserRoles.roleId, id)));
      }
    } else if (kind === "replace") {
      if (!namedAny) continue;
      const current = (await membersOf(ctx, tenantId, id)).map((m) => m.value);
      const keep = new Set(ids);
      for (const uid of current) {
        if (!keep.has(uid)) {
          await db
            .delete(t.appUserRoles)
            .where(and(eq(t.appUserRoles.appUserId, uid), eq(t.appUserRoles.roleId, id)));
        }
      }
      for (const uid of ids) {
        try {
          await db.insert(t.appUserRoles).values({ appUserId: uid, roleId: id });
        } catch {
          /* already a member */
        }
      }
    }
  }
  return getScimGroup(ctx, tenantId, id);
}

/* ───────────────────────── discovery documents ───────────────────────── */

/** What this endpoint supports. Okta and Entra both read it before syncing. */
export const serviceProviderConfig = () => ({
  schemas: ["urn:ietf:params:scim:schemas:core:2.0:ServiceProviderConfig"],
  documentationUri: "https://backlex.com/docs/sso/",
  patch: { supported: true },
  bulk: { supported: false, maxOperations: 0, maxPayloadSize: 0 },
  // Advertised honestly: only `attr eq "value"` is implemented, and an
  // unsupported filter is refused rather than ignored.
  filter: { supported: true, maxResults: 200 },
  changePassword: { supported: false },
  sort: { supported: false },
  etag: { supported: false },
  authenticationSchemes: [
    {
      type: "oauthbearertoken",
      name: "OAuth Bearer Token",
      description: "Authentication via the workspace's SCIM bearer token.",
      primary: true,
    },
  ],
  meta: { resourceType: "ServiceProviderConfig", location: "/api/scim/v2/ServiceProviderConfig" },
});

export const resourceTypes = () =>
  scimList(
    [
      {
        schemas: ["urn:ietf:params:scim:schemas:core:2.0:ResourceType"],
        id: "User",
        name: "User",
        endpoint: "/Users",
        schema: SCIM_USER_SCHEMA,
        meta: { resourceType: "ResourceType", location: "/api/scim/v2/ResourceTypes/User" },
      },
      {
        schemas: ["urn:ietf:params:scim:schemas:core:2.0:ResourceType"],
        id: "Group",
        name: "Group",
        endpoint: "/Groups",
        schema: SCIM_GROUP_SCHEMA,
        meta: { resourceType: "ResourceType", location: "/api/scim/v2/ResourceTypes/Group" },
      },
    ],
    { totalResults: 2, startIndex: 1 },
  );

export const schemas = () =>
  scimList(
    [
      {
        id: SCIM_USER_SCHEMA,
        name: "User",
        description: "SCIM core User. Maps to a backlex app-plane user.",
        attributes: [
          { name: "userName", type: "string", required: true, uniqueness: "server" },
          { name: "active", type: "boolean", required: false },
          { name: "displayName", type: "string", required: false },
          { name: "emails", type: "complex", multiValued: true, required: false },
        ],
        meta: { resourceType: "Schema" },
      },
      {
        id: SCIM_GROUP_SCHEMA,
        name: "Group",
        description: "SCIM core Group. Maps to a backlex role; only members are writable.",
        attributes: [
          { name: "displayName", type: "string", required: true },
          { name: "members", type: "complex", multiValued: true, required: false },
        ],
        meta: { resourceType: "Schema" },
      },
    ],
    { totalResults: 2, startIndex: 1 },
  );

/** RFC 7644 §3.12 error body. `status` is a STRING in SCIM, not a number. */
export const scimError = (status: number, detail: string, scimType?: string) => ({
  schemas: [SCIM_ERROR_SCHEMA],
  status: String(status),
  ...(scimType ? { scimType } : {}),
  detail,
});
