import { and, eq } from "drizzle-orm";
import * as pg from "@backlex/db/pg";
import * as sqlite from "@backlex/db/sqlite";
import { isLocalized, isPresentational, type FieldDef } from "@backlex/db";
import { AppError, normalizeCondition, SYSTEM_ROLES, unknownOperators } from "@backlex/core";
import type { SchemaTemplate, TemplatePermission, TemplateRole } from "../templates/types";
import { invalidateTenantPermissions } from "./permissions/cache";
import { getRoleByName, type DbCtx } from "./seed";

/**
 * Read grants a template gives a BUILT-IN role (#376).
 *
 * `seedRoles` skips any role name the workspace already has, and `admin`,
 * `authenticated` and `public` exist before an apply starts — so an entry named
 * `authenticated` used to vanish in silence, and a template could not say the
 * one thing a storefront needs: a signed-in shopper may read the catalog.
 *
 * Such an entry is not a role to create. Its permissions are ADDED to the role
 * that exists, within three limits:
 *
 *  1. `authenticated` only. `public` answers callers who never signed in, and
 *     `admin` already bypasses every check — both are granted by hand.
 *  2. `read` only, with conditions and a `fields` allow-list. A write on
 *     `authenticated` is a write for anyone who can sign up.
 *  3. Only where THIS apply created every collection the grant reads. A
 *     re-apply, or an apply over a workspace that already had the slug, never
 *     widens access on a collection its admin owns.
 *
 * A condition key naming no column is refused, not stored: SQLite reads an
 * unknown double-quoted identifier as a string literal, so
 * `{statuss: {_neq: "draft"}}` matches every row — for every signed-in user.
 */

export interface BuiltInRoleGrant {
  role: string;
  collection: string;
  action: "read";
}

/** A grant not added: the apply did not create a collection it reads, or the
 *  role already holds an identical one. */
export type BuiltInGrantSkip = BuiltInRoleGrant & {
  reason: "collection-existed" | "already-granted";
};

/** What a grant is checked against — a template collection, or a live one
 *  being extracted. */
export interface GrantTarget {
  slug: string;
  fields: FieldDef[];
  ownerScoped?: boolean;
  versioned?: boolean;
}

export const isBuiltInRole = (name: string): boolean =>
  (Object.values(SYSTEM_ROLES) as string[]).includes(name);

/** The columns a condition may end on. A relation hop lowers to a subquery
 *  over the target's base table, which has no `_status` companions and no
 *  localized column, so neither is offered past the first segment. */
const columnsOf = (c: GrantTarget, onBase: boolean): Set<string> => {
  const out = new Set(["id", "created_at", "updated_at"]);
  if (c.ownerScoped) out.add("owner_id");
  if (onBase && c.versioned) for (const k of ["_status", "_published_at", "_publish_at"]) out.add(k);
  for (const f of c.fields) if (!isPresentational(f) && (onBase || !isLocalized(f))) out.add(f.name);
  return out;
};

const leaves = (node: unknown, out: [string, unknown][]): [string, unknown][] => {
  if (!node || typeof node !== "object" || Array.isArray(node)) return out;
  const o = node as Record<string, unknown>;
  const group = o.$and ?? o.$or;
  if (Array.isArray(group)) for (const x of group) leaves(x, out);
  else if (o.$not !== undefined) leaves(o.$not, out);
  else out.push(...Object.entries(o));
  return out;
};

/**
 * Judge one grant. `reads` is every collection it touches — its own and each
 * hop of a dotted condition — because a hop into a collection the workspace
 * already had is checked against a definition that may not be what is on disk,
 * so the apply grants only when it created all of them.
 */
export const analyzeBuiltInGrant = (
  p: TemplatePermission,
  collections: ReadonlyMap<string, GrantTarget>,
): { problem: string | null; reads: Set<string> } => {
  const reads = new Set([p.collection]);
  const fail = (why: string) => ({ problem: `"${p.action}" on "${p.collection}": ${why}`, reads });
  if (p.action !== "read") return fail("a template may only grant `read` to a built-in role");
  const base = collections.get(p.collection);
  if (!base) return fail("not a collection this template creates");
  const columns = columnsOf(base, true);
  const stray = p.fields?.find((f) => !columns.has(f));
  if (stray !== undefined) return fail(`the fields allow-list names "${stray}", which it does not have`);
  if (p.condition == null) return { problem: null, reads };
  if (typeof p.condition !== "object" || Array.isArray(p.condition)) return fail("a condition must be an object");
  let cond: unknown;
  try {
    const ops = unknownOperators(p.condition);
    if (ops.length > 0) return fail(`unknown operator(s) ${ops.join(", ")}`);
    cond = normalizeCondition(p.condition);
  } catch (e) {
    return fail((e as Error).message);
  }
  const compared = leaves(cond, []);
  // `{$and: []}` or `{$not: null}` compares nothing, and what the compiler makes
  // of that is not something to leave to a signed-in stranger's first request.
  if (compared.length === 0) return fail("a condition must compare a column — leave it out to grant every row");
  for (const [key, cmp] of compared) {
    const ops = cmp && typeof cmp === "object" && !Array.isArray(cmp) ? Object.keys(cmp) : [];
    if (ops.length === 0 || !ops.every((k) => k.startsWith("_"))) {
      return fail(`condition "${key}" is not a comparison — reach a related column with a dotted path`);
    }
    const segs = key.split(".");
    if (segs.length > 3) return fail(`condition "${key}" crosses more than two relations`);
    let at = base;
    for (const seg of segs.slice(0, -1)) {
      const f = at.fields.find((x) => x.name === seg);
      const next = f?.type === "relation" && f.to ? collections.get(f.to) : undefined;
      if (!next) return fail(`condition "${key}": "${seg}" is not a relation to a collection this template creates`);
      reads.add(next.slug);
      at = next;
    }
    if (!columnsOf(at, segs.length === 1).has(segs[segs.length - 1]!)) {
      return fail(`condition "${key}" names no column of "${at.slug}"`);
    }
  }
  return { problem: null, reads };
};

/** Refuse, before an apply writes anything, a roles entry that names a
 *  built-in role and asks for more than this file allows. */
export const assertTemplateRoles = (template: SchemaTemplate): void => {
  const collections = new Map(template.collections.map((c) => [c.slug, c]));
  for (const role of template.roles ?? []) {
    if (!isBuiltInRole(role.name)) continue;
    const refuse = (why: string): never => {
      throw new AppError("VALIDATION", `Template role "${role.name}" is a built-in role: ${why}`);
    };
    if (role.name === SYSTEM_ROLES.public) {
      refuse("a template never grants the anonymous role — what it can read, anyone can read without signing in; grant it by hand");
    }
    if (role.name === SYSTEM_ROLES.admin) refuse("the admin role bypasses every permission check and takes no grants");
    if (role.description !== undefined) refuse("its description is not a template's to change");
    for (const p of role.permissions) {
      const { problem } = analyzeBuiltInGrant(p, collections);
      if (problem) refuse(problem);
    }
  }
};

/** One string per grant MEANING: jsonb reorders a condition's keys, and an
 *  allow-list is a set. */
const grantKey = (collection: string, fields: unknown, condition: unknown): string =>
  JSON.stringify(
    [collection, Array.isArray(fields) ? [...fields].sort() : null, condition ?? null],
    (_k, v: unknown) =>
      v && typeof v === "object" && !Array.isArray(v)
        ? Object.fromEntries(Object.entries(v).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)))
        : v,
  );

const OWNER_READ = grantKey("", null, { owner_id: { _eq: "$user.id" } });

/**
 * Add a template's `authenticated` grants to the workspace — never twice. A
 * collection dropped and re-created by a later apply leaves its old grant rows
 * behind, so an identical grant already on the role is reported, not repeated.
 */
export async function seedBuiltInRoleGrants(
  ctx: DbCtx,
  tenantId: string,
  template: SchemaTemplate,
  created: ReadonlySet<string>,
): Promise<{ granted: BuiltInRoleGrant[]; skipped: BuiltInGrantSkip[] }> {
  const granted: BuiltInRoleGrant[] = [];
  const skipped: BuiltInGrantSkip[] = [];
  const asked = (template.roles ?? [])
    .filter((r) => r.name === SYSTEM_ROLES.authenticated)
    .flatMap((r) => r.permissions);
  if (asked.length === 0) return { granted, skipped };
  const role = await getRoleByName(ctx, tenantId, SYSTEM_ROLES.authenticated);
  if (!role) throw new AppError("INTERNAL", "The built-in authenticated role is missing");
  const t = ctx.dialect === "pg" ? pg.schema.permissions : sqlite.schema.permissions;
  const db = ctx.db as never as { select: Function; insert: Function };
  const held = (
    (await db
      .select({ collection: t.collection, fields: t.fields, condition: t.condition })
      .from(t)
      .where(and(eq(t.roleId, role.id), eq(t.action, "read")))) as { collection: string; fields: unknown; condition: unknown }[]
  ).map((r) => grantKey(r.collection, r.fields, r.condition));
  const collections = new Map(template.collections.map((c) => [c.slug, c]));
  for (const p of asked) {
    const g: BuiltInRoleGrant = { role: SYSTEM_ROLES.authenticated, collection: p.collection, action: "read" };
    // Validated before the apply began; judged again so this cannot be the one
    // caller that forgot.
    const { problem, reads } = analyzeBuiltInGrant(p, collections);
    if (problem) throw new AppError("VALIDATION", problem);
    if (![...reads].every((slug) => created.has(slug))) {
      skipped.push({ ...g, reason: "collection-existed" });
      continue;
    }
    const key = grantKey(p.collection, p.fields, p.condition);
    if (held.includes(key)) {
      skipped.push({ ...g, reason: "already-granted" });
      continue;
    }
    await db.insert(t).values({
      id: crypto.randomUUID(),
      roleId: role.id,
      collection: p.collection,
      action: "read",
      fields: p.fields ?? null,
      condition: p.condition ?? null,
    });
    held.push(key);
    granted.push(g);
  }
  if (granted.length > 0) invalidateTenantPermissions(tenantId);
  return { granted, skipped };
}

/**
 * The built-in half of an extract. `authenticated` read grants on exported
 * collections travel as a built-in entry, so what a template granted survives a
 * round trip. The owner-scoped default read is left out — the engine re-creates
 * it with its collection. A read on a collection left behind, one the apply
 * would refuse, and every `public` grant are named. Non-read grants on a
 * built-in role cannot be expressed in a template and are not carried.
 */
export const extractBuiltInRoleGrants = (
  grants: { role: string; collection: string; action: string; fields: string[] | null; condition: unknown }[],
  exported: ReadonlyMap<string, GrantTarget>,
  omit: (o: { resource: string; what: string; reason: string }) => void,
): TemplateRole | null => {
  const permissions: TemplatePermission[] = [];
  for (const g of grants) {
    const what = `${g.action} on "${g.collection}"`;
    if (g.role === SYSTEM_ROLES.public) {
      omit({ resource: "role:public", what, reason: "a template never grants the anonymous role; grant it by hand in the target" });
      continue;
    }
    if (g.role !== SYSTEM_ROLES.authenticated || g.action !== "read") continue;
    if (!g.fields && grantKey("", null, g.condition) === OWNER_READ) continue;
    const p: TemplatePermission = {
      collection: g.collection,
      action: "read",
      ...(g.fields ? { fields: g.fields } : {}),
      ...(g.condition != null ? { condition: g.condition } : {}),
    };
    const { problem } = analyzeBuiltInGrant(p, exported);
    if (!exported.has(g.collection) || problem) {
      omit({
        resource: "role:authenticated",
        what,
        reason: `${exported.has(g.collection) ? problem : "that collection is not part of this export"}; grant it by hand in the target`,
      });
      continue;
    }
    permissions.push(p);
  }
  return permissions.length > 0 ? { name: SYSTEM_ROLES.authenticated, permissions } : null;
};
