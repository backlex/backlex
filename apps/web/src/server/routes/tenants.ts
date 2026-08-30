import { AppError, SYSTEM_ROLES } from "@backlex/core";
import * as pg from "@backlex/db/pg";
import * as sqlite from "@backlex/db/sqlite";
import { slugify as slugifySlug } from "@backlex/db/slug";
import { createRoute, OpenAPIHono, z } from "@hono/zod-openapi";
import { and, desc, eq, inArray, ne } from "drizzle-orm";
import type { Context } from "hono";
import { setCookie } from "hono/cookie";
import type { AppBindings } from "../app";
import { isInstanceOperator, requirePlatformMw } from "../services/roles/guards";
import { errorResponses, OkSchema, SECURITY } from "../lib/openapi";
import { requireUser } from "../middleware/session";
import { TENANT_COOKIE } from "../middleware/tenant";
import {
  bindInvite,
  createMemberInvite,
  findInviteByToken,
  inviteTokenFields,
  standingToRbacRole,
} from "../services/invites";
import {
  assertLeavesAnActingOwner,
  removeMemberFully,
} from "../services/membership";
import {
  assertMayActOn,
  assertMayGrant,
  WORKSPACE_RANK,
} from "../services/membership-guards";
import {
  invalidateTenantMembership,
  invalidateTenantResolve,
  invalidateUserRoles,
} from "../services/permissions-cache";
import {
  assignRoleByName,
  DEFAULT_TENANT_SLUG,
  ensureSystemRoles,
  getRoleByName,
} from "../services/seed";
import { defaultHook } from "../lib/openapi-router";

const tablesFor = (dialect: "pg" | "sqlite") =>
  dialect === "pg"
    ? {
        tenants: pg.schema.tenants,
        members: pg.schema.tenantMembers,
        users: pg.schema.users,
        roles: pg.schema.roles,
        userRoles: pg.schema.userRoles,
      }
    : {
        tenants: sqlite.schema.tenants,
        members: sqlite.schema.tenantMembers,
        users: sqlite.schema.users,
        roles: sqlite.schema.roles,
        userRoles: sqlite.schema.userRoles,
      };

/** Authorize against the workspace named in the **path**, never the active one.
 *
 *  `auth.roles` is rewritten per active workspace by `tenantMiddleware`, so
 *  `auth.roles.includes("admin")` says nothing about the `{id}` being operated
 *  on. These routes used it as a bypass, which — combined with `POST /` handing
 *  `admin` to whoever creates a workspace — let any authenticated user invite
 *  themselves into, enumerate, or evict members from *every* workspace on the
 *  instance. The escape hatch is now the real instance operator (admin of the
 *  default workspace, or `OWNER_EMAIL`), which a self-created workspace cannot
 *  confer.
 *
 *  `manageOnly` additionally requires the membership row to be `owner`/`admin`,
 *  for the mutating routes. */
const assertWorkspaceAccess = async (
  c: Context<AppBindings>,
  tenantId: string,
  opts: {
    manageOnly?: boolean;
    message: string;
    /** Defaults to FORBIDDEN. `/switch` passes NOT_FOUND so that "no such
     *  workspace" and "not yours" are indistinguishable — see the comment
     *  there. */
    code?: "FORBIDDEN" | "NOT_FOUND";
  },
): Promise<void> => {
  const ctx = c.get("ctx");
  const auth = c.get("auth");
  const t = tablesFor(ctx.dialect);
  const m = (await (ctx.db as any)
    .select({ role: t.members.role })
    .from(t.members)
    .where(
      and(
        eq(t.members.tenantId, tenantId),
        eq(t.members.userId, auth.userId!),
        // Matches `isMember` in middleware/tenant.ts and the role resolver's
        // membership gate. Without it a suspended owner/admin still passed
        // here and could keep inviting and evicting people in the workspace
        // they were just banned from — the one path where suspension has to
        // bite hardest, since it is the path that decides who else belongs.
        ne(t.members.status, "suspended"),
      ),
    )
    .limit(1)) as Array<{ role: string }>;
  const row = m[0];
  if (row && (!opts.manageOnly || ["owner", "admin"].includes(row.role))) return;
  if (await isInstanceOperator(ctx, auth)) return;
  throw new AppError(opts.code ?? "FORBIDDEN", opts.message);
};

/** Workspace handle, capped at 24 characters.
 *
 *  The fold itself is `@backlex/db/slug` — the same one user-collection slug
 *  fields use. It used to be a local copy with no Unicode normalization, which
 *  stripped accented and Turkish letters instead of folding them: `Ürün` became
 *  `r-n` here while a slugifier ten files away made it `urun`. The cap stays
 *  local because it is this table's policy, not a property of slugs. */
const slugify = (s: string) => slugifySlug(s, 24);

const PALETTE = [
  "var(--primary)",
  "var(--chart-1)",
  "var(--chart-2)",
  "var(--chart-3)",
  "var(--chart-4)",
  "var(--chart-5)",
];

/** One membership row, in the shape every guard below needs.
 *
 *  `userId` is NULL for a row that is still an invite — the row exists before
 *  the person does. Every comparison against the caller therefore falls back to
 *  the row id, which no signed-in user can equal, so a pending invite is never
 *  mistaken for the caller acting on themselves. */
interface MemberRow {
  id: string;
  userId: string | null;
  email: string;
  role: string;
  status: string;
}

const loadMember = async (
  c: Context<AppBindings>,
  tenantId: string,
  memberId: string,
): Promise<MemberRow> => {
  const ctx = c.get("ctx");
  const t = tablesFor(ctx.dialect);
  const rows = (await (ctx.db as any)
    .select({
      id: t.members.id,
      userId: t.members.userId,
      email: t.members.email,
      role: t.members.role,
      status: t.members.status,
    })
    .from(t.members)
    .where(and(eq(t.members.tenantId, tenantId), eq(t.members.id, memberId)))
    .limit(1)) as MemberRow[];
  const row = rows[0];
  if (!row) throw new AppError("NOT_FOUND", "No such member in this workspace");
  return row;
};

/** Where the caller stands in THIS workspace's ladder, or null.
 *
 *  Null does not mean "unauthorized" — authorization has already happened by
 *  the time this is called. It means the caller holds no membership row here,
 *  which for a request that got past `assertWorkspaceAccess` can only be the
 *  instance operator reaching in from outside. `assertMayActOn` and
 *  `assertMayGrant` treat a null actor as standing outside the ladder for
 *  exactly that case. A suspended row is excluded for the same reason
 *  `assertWorkspaceAccess` excludes it: a suspended owner is not an owner. */
const loadActor = async (
  c: Context<AppBindings>,
  tenantId: string,
): Promise<{ id: string; role: string } | null> => {
  const ctx = c.get("ctx");
  const auth = c.get("auth");
  const t = tablesFor(ctx.dialect);
  const rows = (await (ctx.db as any)
    .select({ role: t.members.role })
    .from(t.members)
    .where(
      and(
        eq(t.members.tenantId, tenantId),
        eq(t.members.userId, auth.userId!),
        ne(t.members.status, "suspended"),
      ),
    )
    .limit(1)) as Array<{ role: string }>;
  const row = rows[0];
  return row ? { id: auth.userId!, role: row.role } : null;
};

/** The lifecycle a workspace row is in.
 *
 *  `active` is the only state that behaves like a workspace. `suspended` is the
 *  operator's lever against a delinquent or abusive tenant. `archived` is the
 *  owner's own "delete", and is a state rather than a `DELETE FROM` for two
 *  reasons stated on the route below. */
const ARCHIVED = "archived";
const ACTIVE = "active";

/** One workspace row, in the shape the lifecycle routes below reason about. */
interface TenantRowData {
  id: string;
  slug: string;
  name: string;
  mark: string | null;
  color: string | null;
  status: string;
  archivedAt: Date | null;
}

const loadTenant = async (
  c: Context<AppBindings>,
  tenantId: string,
): Promise<TenantRowData> => {
  const ctx = c.get("ctx");
  const t = tablesFor(ctx.dialect);
  const rows = (await (ctx.db as any)
    .select({
      id: t.tenants.id,
      slug: t.tenants.slug,
      name: t.tenants.name,
      mark: t.tenants.mark,
      color: t.tenants.color,
      status: t.tenants.status,
      archivedAt: t.tenants.archivedAt,
    })
    .from(t.tenants)
    .where(eq(t.tenants.id, tenantId))
    .limit(1)) as TenantRowData[];
  const row = rows[0];
  if (!row) throw new AppError("NOT_FOUND", "No such workspace");
  return row;
};

/** Timestamps cross the wire as ISO strings, never as whatever the driver
 *  happened to hand back — bun:sqlite returns a `Date` for a `timestamp_ms`
 *  column and Postgres returns one too, but a row written before the column
 *  existed reads back NULL, and the two shapes must not reach a client as two
 *  different types. */
const iso = (v: Date | string | number | null): string | null =>
  v === null || v === undefined ? null : new Date(v).toISOString();

/** Only an owner may end a workspace's life, or bring it back.
 *
 *  Written as `manageOnly` + `assertMayGrant(actor, "owner")` rather than a
 *  fresh role comparison, because that is exactly the pair `/transfer-ownership`
 *  already uses to mean "owner, or the instance operator reaching in from
 *  outside the ladder": `loadActor` answers null for the operator, and
 *  `assertMayGrant` lets a null actor through on purpose. Restating the rule
 *  here with its own comparison is how the two would drift. */
const assertWorkspaceOwner = async (
  c: Context<AppBindings>,
  tenantId: string,
  message: string,
): Promise<void> => {
  await assertWorkspaceAccess(c, tenantId, { manageOnly: true, message });
  assertMayGrant(await loadActor(c, tenantId), "owner", WORKSPACE_RANK);
};

/** Who may call `POST /api/tenants`, from {@link Env.WORKSPACE_CREATION}. */
type WorkspaceCreation = "open" | "operator" | "off";

/**
 * Read the creation policy, refusing a value nobody could have meant.
 *
 * Unset is `open` — today's behaviour, so no existing self-host loses its "New
 * workspace" button on upgrade. A value that is SET but unrecognised throws
 * instead of folding back to `open`: only an operator who meant to RESTRICT
 * creation can produce one, so guessing the permissive reading would hand them
 * the exact opposite of every intent they could have had, and would do it in
 * silence. The value is echoed back (truncated) because an env var typo is
 * undiagnosable otherwise, and it is a policy word rather than a credential.
 */
const workspaceCreationMode = (env: {
  WORKSPACE_CREATION?: string | undefined;
}): WorkspaceCreation => {
  const raw = env.WORKSPACE_CREATION?.trim().toLowerCase();
  if (!raw) return "open";
  if (raw === "open" || raw === "operator" || raw === "off") return raw;
  throw new AppError(
    "INTERNAL",
    `WORKSPACE_CREATION is set to "${raw.slice(0, 40)}" — expected \`open\`, \`operator\` or \`off\``,
  );
};

/**
 * The authorization every per-member mutation shares, in a deliberate order.
 *
 *   1. the caller must belong to the workspace at all, BEFORE any member row is
 *      read. Reading first would let a stranger tell a real member id from a
 *      bogus one by the status code alone.
 *   2. management rights — unless the target IS the caller. Leaving a
 *      workspace, or demoting yourself, is self-service: a plain `member` must
 *      be able to do it and `manageOnly` would refuse them.
 *   3. the rank ladder, which is what stops an `admin` evicting an `owner`.
 *
 * The last-owner invariant is deliberately NOT checked here: whether it is even
 * at stake depends on what the caller asked for — a demotion and a suspension
 * can both break it, a resent invite cannot — so each route asks for itself.
 */
const authorizeMemberAction = async (
  c: Context<AppBindings>,
  tenantId: string,
  memberId: string,
  manageMessage: string,
): Promise<{ actor: { id: string; role: string } | null; target: MemberRow }> => {
  await assertWorkspaceAccess(c, tenantId, { message: "Not a member" });
  const target = await loadMember(c, tenantId, memberId);
  const actor = await loadActor(c, tenantId);
  const isSelf =
    actor !== null && target.userId !== null && target.userId === actor.id;
  if (!isSelf)
    await assertWorkspaceAccess(c, tenantId, {
      manageOnly: true,
      message: manageMessage,
    });
  assertMayActOn(actor, target.userId ?? target.id, target.role, WORKSPACE_RANK);
  return { actor, target };
};

/**
 * Keep the RBAC binding in step with the membership role.
 *
 * The two layers are orthogonal — `tenant_members.role` decides who may manage
 * the member list, `user_roles` decides which rows they can touch — but
 * `bindInvite` already ties them together the moment an invite is accepted:
 * `owner`/`admin` get the `admin` role, everyone else gets `authenticated`. A
 * role change that moved only one of them would be a demotion that does not
 * demote — the person loses the Members panel and keeps every row in the
 * database. So the same mapping is applied here, in both directions.
 */
const syncRbacRole = async (
  c: Context<AppBindings>,
  tenantId: string,
  standing: string,
  userId: string,
): Promise<void> => {
  const ctx = c.get("ctx");
  const t = tablesFor(ctx.dialect);
  const dbCtx = { db: ctx.db, dialect: ctx.dialect };
  await ensureSystemRoles(dbCtx, tenantId);
  // `standingToRbacRole` is the mapping `bindInvite` uses, imported rather than
  // restated: a promotion that granted a different role than an invite to the
  // same standing would make a member's permissions depend on how they got
  // there.
  const rbacRole = standingToRbacRole(standing);
  await assignRoleByName(dbCtx, tenantId, userId, rbacRole);
  await assignRoleByName(dbCtx, tenantId, userId, SYSTEM_ROLES.authenticated);
  if (rbacRole !== SYSTEM_ROLES.admin) {
    // The half `bindInvite` never needs: a demotion has to TAKE the admin role
    // back, or the person keeps every row in the database while losing only the
    // Members panel.
    //
    // Scoped to THIS workspace's admin role id. Deleting by user alone would
    // strip their admin binding in every other workspace they belong to, which
    // is the account-wide privilege wipe the create-unwind above also avoids.
    const adminRole = await getRoleByName(dbCtx, tenantId, SYSTEM_ROLES.admin);
    if (adminRole)
      await (ctx.db as any)
        .delete(t.userRoles)
        .where(
          and(eq(t.userRoles.userId, userId), eq(t.userRoles.roleId, adminRole.id)),
        );
  }
  invalidateUserRoles(tenantId, userId);
};

/** Best-effort invite mail through the TARGET workspace's transport (the
 *  console adapter on deployments without SMTP). The returned flag tells the UI
 *  whether to say "emailed" or to lean on the copyable link instead. Shared by
 *  the invite and resend routes so the two cannot word it differently. */
const sendInviteMail = async (
  c: Context<AppBindings>,
  tenantId: string,
  email: string,
  url: string,
): Promise<boolean> =>
  await c
    .get("ctx")
    .emailFor(tenantId)
    .then(async (transport) => {
      await transport.send({
        to: email,
        subject: `You've been invited to a backlex workspace`,
        text: `Open ${url} to accept.`,
      });
      return transport.provider !== "console";
    })
    .catch(() => false);

/** Matches `createMemberInvite`'s window, so a resent invite and a first invite
 *  expire on the same schedule. */
const INVITE_TTL_MS = 7 * 24 * 60 * 60 * 1000;

const TenantRow = z
  .object({
    id: z.string(),
    slug: z.string(),
    name: z.string(),
    project: z.string(),
    branch: z.string(),
    env: z.string(),
    mark: z.string().nullable(),
    color: z.string().nullable(),
    role: z.string(),
    /** `active` | `suspended` | `archived`. */
    status: z.string(),
    /** ISO timestamp, set when the workspace was archived; null otherwise. */
    archivedAt: z.string().nullable(),
  })
  .openapi("TenantRow");

/** Why `slug` is refused rather than dropped, said in the one place both the
 *  OpenAPI description and the 422 body read it from. */
const SLUG_IMMUTABLE =
  "A workspace slug cannot be changed. It keys the default physical-table namespace `c_<tenantPrefix12>_<slug>`, so renaming it would orphan every managed collection the workspace owns — the tables would still be there and nothing would find them. Rename the workspace with `name`; the slug is an address, not a label.";

/** The lifecycle-facing projection of a workspace row, shared by the update,
 *  archive and restore replies so the three cannot describe one row three
 *  ways. */
const WorkspaceRowSchema = z
  .object({
    id: z.string(),
    slug: z.string(),
    name: z.string(),
    mark: z.string().nullable(),
    color: z.string().nullable(),
    status: z.string(),
    archivedAt: z.string().nullable(),
  })
  .openapi("WorkspaceRow");

const UpdateTenantInput = z
  .object({
    name: z.string().min(2).max(60).optional().openapi({
      description: "Display name. Purely cosmetic — it does not touch the slug.",
    }),
    mark: z.string().min(1).max(2).nullable().optional().openapi({
      description: "One- or two-character sidebar tile initial. Null clears it.",
    }),
    color: z.string().min(1).max(64).nullable().optional().openapi({
      description:
        "Sidebar tile colour — a CSS colour or a design token such as `var(--chart-2)`. Null clears it.",
    }),
    /** Declared so it can be refused BY NAME with its reason attached. Left to
     *  `.strict()` it would come back as a generic "unrecognized key", which
     *  tells a caller that the field is unknown rather than that it is
     *  deliberately immutable — and the difference is the whole point. */
    slug: z
      .unknown()
      .optional()
      .refine((v) => v === undefined, { message: SLUG_IMMUTABLE })
      .openapi({ description: SLUG_IMMUTABLE }),
  })
  // Strict for the same reason `CreateTenantInput` is: a key this endpoint does
  // not write must not be answered 200. `project`, `branch` and `env` are the
  // likely misses, and none of them is settable here.
  .strict()
  .openapi("UpdateTenantInput");

const CreateTenantInput = z
  .object({
    name: z.string().min(2).max(60).openapi({
      description:
        "Display name. The workspace SLUG — the value every later `X-Backlex-Tenant` names — is folded from this and cannot be supplied.",
    }),
    project: z.string().max(40).optional(),
    env: z.enum(["development", "staging", "production"]).optional(),
  })
  // Strict, because the key most likely to be sent here is `slug`, and it is
  // the one key that must not be dropped in silence: a caller who sends
  // `{ name: "Shop 2", slug: "shop2" }` gets `shop-2`, then addresses `shop2`
  // on every later request and is answered for a different workspace.
  .strict()
  .openapi("CreateTenantInput");

/**
 * The workspace-membership roles a write may name.
 *
 * `editor` is DEPRECATED and no longer part of the documented vocabulary. It
 * never meant anything the permission system read, and a fourth rung nobody
 * could explain is half of why this column drifted into holding whatever string
 * a caller sent. It is still PARSED and folded to `member`, so a client written
 * against the old enum keeps working instead of collecting a 422 — and rows
 * already carrying it keep their place in `WORKSPACE_RANK`, which ranks it
 * deliberately so a guard cannot read one as rank 0 and wave everybody through.
 */
const MEMBERSHIP_ROLE_DESCRIPTION =
  "`owner` | `admin` | `member`. `editor` is deprecated: it is still accepted, and stored as `member`.";

const foldEditor = (r: "owner" | "admin" | "editor" | "member") =>
  r === "editor" ? ("member" as const) : r;

const MembershipRole = z.enum(["owner", "admin", "editor", "member"]);

const MemberRowSchema = z
  .object({
    id: z.string(),
    userId: z.string().nullable(),
    email: z.string(),
    role: z.string(),
    status: z.string(),
  })
  .openapi("TenantMemberRow");

const InviteInput = z
  .object({
    email: z.string().email(),
    role: MembershipRole.default("member")
      .transform(foldEditor)
      .openapi({ description: MEMBERSHIP_ROLE_DESCRIPTION }),
  })
  .openapi("TenantInviteInput");

const UpdateMemberInput = z
  .object({
    role: MembershipRole.transform(foldEditor)
      .optional()
      .openapi({ description: MEMBERSHIP_ROLE_DESCRIPTION }),
    status: z
      .enum(["active", "suspended"])
      .optional()
      .openapi({
        description:
          "`suspended` keeps the row and revokes every right it carries — a suspended owner/admin stops being able to invite or evict anybody.",
      }),
  })
  // Strict, because the two field names a caller is most likely to reach for
  // are `email` and `userId`, and neither is changeable here. Dropping them in
  // silence would answer 200 to a request that did nothing.
  .strict()
  .openapi("TenantMemberUpdateInput");

const TransferOwnershipInput = z
  .object({
    memberId: z.string().min(1).openapi({
      description:
        "The `tenant_members.id` of the member who becomes owner. They must have accepted their invite.",
    }),
  })
  .strict()
  .openapi("TenantTransferOwnershipInput");

const SwitchInput = z
  .object({
    /** Either tenant id or slug. */
    tenant: z.string().min(1),
  })
  .openapi("TenantSwitchInput");

const AcceptInput = z
  .object({ token: z.string().min(8) })
  .openapi("TenantAcceptInput");

const TAG = "tenants";

export const tenantsRoutes = new OpenAPIHono<AppBindings>({ defaultHook })
  /** List workspaces the caller belongs to. */
  .openapi(
    createRoute({
      method: "get",
      path: "/",
      tags: [TAG],
      summary: "List my workspaces",
      description:
        "Workspaces the caller belongs to. `active` reflects the currently-selected workspace. Archived workspaces are omitted unless `includeArchived=true` — which is how an owner finds one again in order to restore it.",
      security: SECURITY,
      middleware: [requireUser],
      request: {
        query: z.object({
          includeArchived: z
            .enum(["true", "false"])
            .optional()
            .openapi({
              description:
                "`true` also returns archived workspaces (each carrying `status: \"archived\"` and its `archivedAt`). Default `false`.",
            }),
        }),
      },
      responses: {
        200: {
          description: "OK",
          content: {
            "application/json": {
              schema: z.object({
                data: z.array(TenantRow),
                active: z.string().nullable(),
              }),
            },
          },
        },
        ...errorResponses,
      },
    }),
    async (c) => {
      const ctx = c.get("ctx");
      const auth = c.get("auth");
      const t = tablesFor(ctx.dialect);
      const includeArchived = c.req.valid("query").includeArchived === "true";
      const rows = (await (ctx.db as any)
        .select({
          id: t.tenants.id,
          slug: t.tenants.slug,
          name: t.tenants.name,
          project: t.tenants.project,
          branch: t.tenants.branch,
          env: t.tenants.env,
          mark: t.tenants.mark,
          color: t.tenants.color,
          role: t.members.role,
          status: t.tenants.status,
          archivedAt: t.tenants.archivedAt,
        })
        .from(t.members)
        .innerJoin(t.tenants, eq(t.members.tenantId, t.tenants.id))
        // `status` is NOT NULL with a `'active'` default that the migration
        // back-fills as the column is added, so there is no row for which this
        // comparison is unknown — an install upgrading into this release cannot
        // lose its workspace list to a NULL.
        .where(
          includeArchived
            ? eq(t.members.userId, auth.userId!)
            : and(
                eq(t.members.userId, auth.userId!),
                ne(t.tenants.status, ARCHIVED),
              ),
        )) as Array<{
          id: string;
          slug: string;
          name: string;
          project: string;
          branch: string;
          env: string;
          mark: string | null;
          color: string | null;
          role: string;
          status: string;
          archivedAt: Date | null;
        }>;
      const data = rows.map((r) => ({ ...r, archivedAt: iso(r.archivedAt) }));
      return c.json({ data, active: auth.tenantId ?? null });
    },
  )
  /** Create a new workspace (the caller becomes owner). */
  .openapi(
    createRoute({
      method: "post",
      path: "/",
      tags: [TAG],
      summary: "Create a workspace",
      description:
        "The caller becomes owner. System roles are seeded and the creator is granted `admin`.",
      security: SECURITY,
      // Belt and braces with the plane firewall. This route was `requireUser`
      // alone, and `requireUser` checks only that `auth.userId` is set — which
      // an `app_users` id satisfies. A workspace's own end-user reached it,
      // and where SQLite foreign keys were not enforced they became a
      // platform-plane operator; where they were, they left orphan rows behind.
      middleware: [requireUser, requirePlatformMw],
      request: {
        body: {
          required: true,
          content: { "application/json": { schema: CreateTenantInput } },
        },
      },
      responses: {
        201: {
          description: "Created",
          content: {
            "application/json": {
              schema: z.object({
                data: z.object({ id: z.string(), slug: z.string(), name: z.string() }),
              }),
            },
          },
        },
        ...errorResponses,
      },
    }),
    async (c) => {
      const body = c.req.valid("json");
      const ctx = c.get("ctx");
      const auth = c.get("auth");
      const t = tablesFor(ctx.dialect);
      // Who may open a new workspace is an INSTANCE policy, not a workspace
      // one — there is no workspace yet to hold a permission about it — so it
      // is read from the environment the operator controls rather than from
      // any admin-editable setting a self-serve user could reach.
      const creation = workspaceCreationMode(ctx.env);
      if (creation === "off")
        throw new AppError(
          "FORBIDDEN",
          "This instance does not allow new workspaces to be created",
        );
      if (creation === "operator" && !(await isInstanceOperator(ctx, auth)))
        throw new AppError(
          "FORBIDDEN",
          "Only the instance operator may create a workspace here",
        );
      const slug = slugify(body.name);
      if (slug.length < 2)
        throw new AppError("VALIDATION", "Workspace name must be 2+ chars (a-z, 0-9, -)");
      const taken = await (ctx.db as any)
        .select({ id: t.tenants.id })
        .from(t.tenants)
        .where(eq(t.tenants.slug, slug))
        .limit(1);
      if (taken[0])
        throw new AppError("CONFLICT", `Workspace "${slug}" already exists`);
      const id = crypto.randomUUID();
      // Five writes, no transaction — and this repo has no cross-dialect one to
      // reach for (D1 offers `batch`, not interactive transactions, and the two
      // existing call sites are hand-branched pg-vs-sqlite). So the guarantee is
      // made by COMPENSATION instead: everything after the tenant row runs
      // inside a try, and a failure unwinds what was already written.
      //
      // It is not hypothetical. `user_roles.user_id` carries a real foreign key
      // to `users.id`, so an identity that is not a platform user trips the
      // FOURTH write — and the tenant and membership rows were already
      // committed. The caller saw a 500, and the workspace stayed: listed as
      // theirs, holding a globally-unique slug nobody else could then claim,
      // and removable by no endpoint in the API. A 500 that looks like a
      // failure and is not is worse than a 200.
      //
      // `requirePlatformMw` on this route now closes the specific cause. The
      // unwind closes the SHAPE, which is what stops the next cause.
      await (ctx.db as any).insert(t.tenants).values({
        id,
        slug,
        name: body.name,
        project: body.project ?? "default",
        branch: "main",
        env: body.env ?? "development",
        mark: body.name.charAt(0).toUpperCase(),
        color: PALETTE[Math.floor(Math.random() * PALETTE.length)],
        createdBy: auth.userId,
      });
      try {
        await (ctx.db as any).insert(t.members).values({
          id: crypto.randomUUID(),
          tenantId: id,
          userId: auth.userId,
          email: auth.email!,
          role: "owner",
          status: "active",
          joinedAt: new Date(),
        });
        // Seed system roles for the new workspace so admin/authenticated/public
        // exist on day one, then make the creator an admin in the RBAC sense
        // (the membership-level "owner" role is orthogonal to the role system).
        const dbCtx = { db: ctx.db, dialect: ctx.dialect };
        await ensureSystemRoles(dbCtx, id);
        await assignRoleByName(dbCtx, id, auth.userId!, SYSTEM_ROLES.admin);
      } catch (err) {
        // Best-effort unwind, in reverse dependency order. Each step is guarded
        // on its own: a half-successful cleanup still leaves less behind than
        // none, and an error thrown from HERE would replace the real cause with
        // a misleading one.
        //
        // Every delete is scoped to THIS tenant, including the role bindings.
        // Deleting them by `user_id` alone would be scoped to the person rather
        // than the workspace and would strip their roles in every OTHER
        // workspace they belong to — turning a failed create into a
        // account-wide privilege wipe.
        const undo = async () => {
          const roleIds = (
            (await (ctx.db as any)
              .select({ id: t.roles.id })
              .from(t.roles)
              .where(eq(t.roles.tenantId, id))) as Array<{ id: string }>
          ).map((r) => r.id);
          if (roleIds.length > 0) {
            await (ctx.db as any)
              .delete(t.userRoles)
              .where(inArray(t.userRoles.roleId, roleIds));
          }
          await (ctx.db as any).delete(t.roles).where(eq(t.roles.tenantId, id));
          await (ctx.db as any).delete(t.members).where(eq(t.members.tenantId, id));
          await (ctx.db as any).delete(t.tenants).where(eq(t.tenants.id, id));
        };
        await undo().catch(() => {});
        invalidateTenantMembership(id);
        throw err;
      }
      // After both the membership row and the RBAC role binding are written.
      invalidateTenantMembership(id);
      return c.json({ data: { id, slug, name: body.name } }, 201);
    },
  )
  /** Switch the active tenant cookie for the next requests. */
  .openapi(
    createRoute({
      method: "post",
      path: "/switch",
      tags: [TAG],
      summary: "Switch active workspace",
      description:
        "Sets the workspace cookie. Body `tenant` is matched against id then slug.",
      security: SECURITY,
      middleware: [requireUser],
      request: {
        body: {
          required: true,
          content: { "application/json": { schema: SwitchInput } },
        },
      },
      responses: {
        200: {
          description: "OK",
          content: {
            "application/json": {
              schema: z.object({
                data: z.object({ id: z.string(), slug: z.string() }),
              }),
            },
          },
        },
        ...errorResponses,
      },
    }),
    async (c) => {
      const body = c.req.valid("json");
      const ctx = c.get("ctx");
      const auth = c.get("auth");
      const t = tablesFor(ctx.dialect);
      // Resolve by id first, then slug.
      const cols = {
        id: t.tenants.id,
        slug: t.tenants.slug,
        status: t.tenants.status,
      };
      const r = (await (ctx.db as any)
        .select(cols)
        .from(t.tenants)
        .where(eq(t.tenants.id, body.tenant))
        .limit(1)) as Array<{ id: string; slug: string; status: string }>;
      let target = r[0];
      if (!target) {
        const r2 = (await (ctx.db as any)
          .select(cols)
          .from(t.tenants)
          .where(eq(t.tenants.slug, body.tenant))
          .limit(1)) as Array<{ id: string; slug: string; status: string }>;
        target = r2[0];
      }
      // "Does not exist" and "exists and is not yours" answer identically, on
      // purpose. Answering 404 for the first and 403 for the second turns this
      // endpoint into an existence oracle: any signed-in user could enumerate
      // every workspace id and slug on the deployment by status code alone,
      // without ever being allowed into one.
      //
      // `middleware/tenant.ts::refuseHeaderWorkspace` already collapses the two
      // for the `X-Backlex-Tenant` header for exactly this reason, and this was
      // the same door left open next to it. The message echoes back what the
      // caller asked for so a genuine typo is still diagnosable, which is the
      // only thing the split status was buying.
      const unavailable = `No workspace "${String(body.tenant).slice(0, 80)}" is available to you`;
      // A workspace that is not `active` answers exactly like one that does not
      // exist — the same conflation `middleware/tenant.ts` makes when it
      // resolves a workspace, and for the same two reasons. The status must not
      // be readable from outside (otherwise "this slug is free" and "this slug
      // belongs to a suspended workspace" are distinguishable by anybody), and
      // switching INTO one would hand the caller a cookie that the very next
      // request refuses — a success that leaves them worse off than the
      // refusal would have.
      if (!target || target.status !== ACTIVE)
        throw new AppError("NOT_FOUND", unavailable);
      await assertWorkspaceAccess(c, target.id, {
        message: unavailable,
        code: "NOT_FOUND",
      });
      setCookie(c, TENANT_COOKIE, target.id, {
        httpOnly: false,
        sameSite: "Lax",
        path: "/",
        maxAge: 60 * 60 * 24 * 30,
      });
      await (ctx.db as any)
        .update(t.users)
        .set({ activeTenantId: target.id, updatedAt: new Date() })
        .where(eq(t.users.id, auth.userId!));
      // Tell tenantMiddleware to keep this value when it re-stamps the cookie
      // post-next (otherwise its closed-over old tenantId overwrites ours).
      c.set("auth", { ...auth, tenantId: target.id });
      return c.json({ data: { id: target.id, slug: target.slug } });
    },
  )
  /** Rename / re-badge a workspace. */
  .openapi(
    createRoute({
      method: "patch",
      path: "/{id}",
      tags: [TAG],
      summary: "Update a workspace",
      description:
        "Changes the workspace's display `name`, `mark` or `color`. Owners/admins of THIS workspace (or the instance operator). `slug` is refused, not ignored: it keys the default physical-table namespace `c_<tenantPrefix12>_<slug>`, so renaming it would orphan every managed collection the workspace owns. An archived workspace must be restored before it can be edited.",
      security: SECURITY,
      // Belt and braces with the plane firewall, matching `POST /`: a
      // workspace's own end-user must never be able to rename the workspace
      // they are a customer of, and `requireUser` alone is satisfied by an
      // `app_users` id.
      middleware: [requireUser, requirePlatformMw],
      request: {
        params: z.object({ id: z.string() }),
        body: {
          required: true,
          content: { "application/json": { schema: UpdateTenantInput } },
        },
      },
      responses: {
        200: {
          description: "Updated",
          content: {
            "application/json": { schema: z.object({ data: WorkspaceRowSchema }) },
          },
        },
        ...errorResponses,
      },
    }),
    async (c) => {
      const ctx = c.get("ctx");
      const body = c.req.valid("json");
      const { id } = c.req.valid("param");
      const t = tablesFor(ctx.dialect);
      // Authorize BEFORE the row is read, for the reason `authorizeMemberAction`
      // states: reading first would let a stranger tell a real workspace id
      // from an invented one by the status code alone.
      await assertWorkspaceAccess(c, id, {
        manageOnly: true,
        message: "Only owners/admins may change a workspace",
      });
      const current = await loadTenant(c, id);
      if (current.status === ARCHIVED)
        throw new AppError(
          "CONFLICT",
          "This workspace is archived — restore it before changing it",
        );

      const next = {
        name: body.name ?? current.name,
        mark: body.mark === undefined ? current.mark : body.mark,
        color: body.color === undefined ? current.color : body.color,
      };
      // A PATCH that names nothing this route writes is a request that did
      // nothing, and answering it 200 is the silent success this phase exists
      // to stop. `slug` never reaches here — it is refused by the schema.
      if (
        body.name === undefined &&
        body.mark === undefined &&
        body.color === undefined
      )
        throw new AppError(
          "VALIDATION",
          "Nothing to change — send `name`, `mark`, `color`, or any combination",
        );

      await (ctx.db as any)
        .update(t.tenants)
        .set({ ...next, updatedAt: new Date() })
        .where(eq(t.tenants.id, id));

      return c.json({
        data: {
          id: current.id,
          slug: current.slug,
          ...next,
          status: current.status,
          archivedAt: iso(current.archivedAt),
        },
      });
    },
  )
  /** Archive a workspace — the closest thing to deleting one. */
  .openapi(
    createRoute({
      method: "delete",
      path: "/{id}",
      tags: [TAG],
      summary: "Archive a workspace",
      description:
        "Marks the workspace `archived` and stamps `archived_at`; it then disappears from `GET /api/tenants` unless `includeArchived=true`, and `POST /api/tenants/{id}/restore` brings it back. Owners only (or the instance operator).\n\nIt ARCHIVES rather than deletes, for two reasons. Recovery has to exist — an owner who ends a workspace by accident has no other way back, and no support path can reconstruct one. And a real delete means cascading across roughly a hundred tenant-scoped tables plus the workspace's own physical collection tables, which is a larger piece of work with its own failure modes; leaving it undone behind a route called DELETE would be worse than not having the route.\n\nThe `default` workspace can never be archived: `isInstanceOperator` resolves through it, so archiving it would strand the check that decides who the instance operator is.",
      security: SECURITY,
      middleware: [requireUser, requirePlatformMw],
      request: { params: z.object({ id: z.string() }) },
      responses: {
        200: {
          description: "Archived",
          content: {
            "application/json": {
              schema: z.object({ ok: z.literal(true), data: WorkspaceRowSchema }),
            },
          },
        },
        ...errorResponses,
      },
    }),
    async (c) => {
      const ctx = c.get("ctx");
      const { id } = c.req.valid("param");
      const t = tablesFor(ctx.dialect);
      await assertWorkspaceOwner(c, id, "Only an owner may archive a workspace");
      const current = await loadTenant(c, id);
      // The bootstrap workspace is load-bearing infrastructure rather than a
      // workspace anybody owns: `isInstanceOperator` answers "admin of the
      // default workspace", and `ensureDefaultTenant` is what resolves it. An
      // archived default would leave the instance with no operator and no route
      // to appoint one — recoverable only by SQL.
      if (current.slug === DEFAULT_TENANT_SLUG)
        throw new AppError(
          "VALIDATION",
          "The default workspace cannot be archived — the instance resolves its operator through it",
        );
      if (current.status === ARCHIVED)
        throw new AppError("CONFLICT", "This workspace is already archived");

      const archivedAt = new Date();
      await (ctx.db as any)
        .update(t.tenants)
        .set({ status: ARCHIVED, archivedAt, updatedAt: new Date() })
        .where(eq(t.tenants.id, id));
      // The membership answers cached for this workspace were computed while it
      // still counted as a live one; drop them so nothing acts on the workspace
      // for a TTL after it stopped being listed.
      invalidateTenantMembership(id);
      // And the slug→id resolution itself, which is the one that decides
      // whether a request reaches this workspace AT ALL. `middleware/tenant.ts`
      // now filters on `status`, but that lookup is cached — so without this an
      // isolate that had already resolved the workspace keeps admitting
      // requests into it for the rest of the TTL, including the isolate that
      // just served the archive. Every other cache on that path had an
      // invalidator and this one did not.
      invalidateTenantResolve(id);

      return c.json({
        ok: true as const,
        data: {
          id: current.id,
          slug: current.slug,
          name: current.name,
          mark: current.mark,
          color: current.color,
          status: ARCHIVED,
          archivedAt: iso(archivedAt),
        },
      });
    },
  )
  /** Bring an archived workspace back. */
  .openapi(
    createRoute({
      method: "post",
      path: "/{id}/restore",
      tags: [TAG],
      summary: "Restore an archived workspace",
      description:
        "Clears `archived` and `archived_at`, putting the workspace back in `GET /api/tenants`. Owners only (or the instance operator). This is the other half of archiving — an archive with no way out is a trapdoor, and the archived row is only findable through `GET /api/tenants?includeArchived=true`.",
      security: SECURITY,
      middleware: [requireUser, requirePlatformMw],
      request: { params: z.object({ id: z.string() }) },
      responses: {
        200: {
          description: "Restored",
          content: {
            "application/json": {
              schema: z.object({ ok: z.literal(true), data: WorkspaceRowSchema }),
            },
          },
        },
        ...errorResponses,
      },
    }),
    async (c) => {
      const ctx = c.get("ctx");
      const { id } = c.req.valid("param");
      const t = tablesFor(ctx.dialect);
      await assertWorkspaceOwner(c, id, "Only an owner may restore a workspace");
      const current = await loadTenant(c, id);
      // Refused rather than answered 200, because restoring a workspace that
      // was never archived is a caller who is looking at the wrong id — and a
      // "restored" reply would confirm a state they did not observe. A
      // `suspended` workspace is deliberately included in the refusal: this
      // route is the archive's inverse, not an operator's un-suspend.
      if (current.status !== ARCHIVED)
        throw new AppError(
          "VALIDATION",
          `This workspace is not archived (status "${current.status}") — there is nothing to restore`,
        );

      await (ctx.db as any)
        .update(t.tenants)
        .set({ status: ACTIVE, archivedAt: null, updatedAt: new Date() })
        .where(eq(t.tenants.id, id));
      invalidateTenantMembership(id);
      // Restoring needs no resolve-cache eviction of its own — a refusal is never
      // cached, so the workspace resolves on its very next request. Dropping the
      // entry anyway costs nothing and keeps the two handlers symmetrical, which
      // is what stops the next reader assuming one of them forgot.
      invalidateTenantResolve(id);

      return c.json({
        ok: true as const,
        data: {
          id: current.id,
          slug: current.slug,
          name: current.name,
          mark: current.mark,
          color: current.color,
          status: ACTIVE,
          archivedAt: null,
        },
      });
    },
  )
  /** Members of a workspace. Caller must be a member (admins bypass). */
  .openapi(
    createRoute({
      method: "get",
      path: "/{id}/members",
      tags: [TAG],
      summary: "List workspace members",
      description: "Caller must be a member (admins bypass).",
      security: SECURITY,
      middleware: [requireUser],
      request: { params: z.object({ id: z.string() }) },
      responses: {
        200: {
          description: "OK",
          content: {
            "application/json": {
              schema: z.object({ data: z.array(z.record(z.string(), z.unknown())) }),
            },
          },
        },
        ...errorResponses,
      },
    }),
    async (c) => {
      const ctx = c.get("ctx");
      const { id } = c.req.valid("param");
      const t = tablesFor(ctx.dialect);
      await assertWorkspaceAccess(c, id, { message: "Not a member" });
      // Explicit projection — `select()` also returned `invite_token` /
      // `invite_expires_at`, i.e. a live credential for every pending invite.
      const rows = await (ctx.db as any)
        .select({
          id: t.members.id,
          tenantId: t.members.tenantId,
          userId: t.members.userId,
          email: t.members.email,
          role: t.members.role,
          status: t.members.status,
          invitedBy: t.members.invitedBy,
          invitedAt: t.members.invitedAt,
          joinedAt: t.members.joinedAt,
          lastSeenAt: t.members.lastSeenAt,
          createdAt: t.members.createdAt,
          updatedAt: t.members.updatedAt,
        })
        .from(t.members)
        .where(eq(t.members.tenantId, id))
        .orderBy(desc(t.members.createdAt));
      return c.json({ data: rows });
    },
  )
  /** Invite an email into the workspace. */
  .openapi(
    createRoute({
      method: "post",
      path: "/{id}/members/invite",
      tags: [TAG],
      summary: "Invite a member",
      description: "Sends an invite email with a 7-day token. Owners/admins only.",
      security: SECURITY,
      middleware: [requireUser],
      request: {
        params: z.object({ id: z.string() }),
        body: {
          required: true,
          content: { "application/json": { schema: InviteInput } },
        },
      },
      responses: {
        201: {
          description: "Invite created",
          content: {
            "application/json": {
              schema: z.object({
                data: z.object({
                  id: z.string(),
                  token: z.string(),
                  /** Ready-to-share accept link (`{APP_URL}/invite?token=…`). */
                  url: z.string(),
                  /** False when the mail only hit the console fallback — the
                   *  UI should surface `url` for manual sharing instead. */
                  sent: z.boolean(),
                }),
              }),
            },
          },
        },
        ...errorResponses,
      },
    }),
    async (c) => {
      const body = c.req.valid("json");
      const ctx = c.get("ctx");
      const auth = c.get("auth");
      const { id } = c.req.valid("param");
      // Caller must be an owner/admin **of this workspace** (or the operator).
      await assertWorkspaceAccess(c, id, {
        manageOnly: true,
        message: "Only owners/admins may invite",
      });
      const { id: memberId, token } = await createMemberInvite(ctx, {
        tenantId: id,
        email: body.email,
        role: body.role,
        invitedBy: auth.userId ?? null,
      });
      const url = `${ctx.env.APP_URL}/invite?token=${token}`;
      const sent = await sendInviteMail(c, id, body.email, url);
      return c.json({ data: { id: memberId, token, url, sent } }, 201);
    },
  )
  /** Change a member's role or status. */
  .openapi(
    createRoute({
      method: "patch",
      path: "/{id}/members/{memberId}",
      tags: [TAG],
      summary: "Change a member's role or status",
      description:
        "Owners/admins, plus any member acting on THEMSELVES (that is how you step down). An `admin` cannot grant `owner`, and the workspace's last owner cannot be demoted or suspended.",
      security: SECURITY,
      middleware: [requireUser],
      request: {
        params: z.object({ id: z.string(), memberId: z.string() }),
        body: {
          required: true,
          content: { "application/json": { schema: UpdateMemberInput } },
        },
      },
      responses: {
        200: {
          description: "Updated",
          content: {
            "application/json": { schema: z.object({ data: MemberRowSchema }) },
          },
        },
        ...errorResponses,
      },
    }),
    async (c) => {
      const ctx = c.get("ctx");
      const body = c.req.valid("json");
      const { id: tenantId, memberId } = c.req.valid("param");
      const t = tablesFor(ctx.dialect);
      const { actor, target } = await authorizeMemberAction(
        c,
        tenantId,
        memberId,
        "Only owners/admins may change a member",
      );
      if (body.role === undefined && body.status === undefined)
        throw new AppError(
          "VALIDATION",
          "Nothing to change — send `role`, `status`, or both",
        );

      const nextRole = body.role ?? target.role;
      const nextStatus = body.status ?? target.status;

      // Whether the actor may hand out this standing is a different question
      // from whether they may act on this person. An `admin` outranks a
      // `member` and so may act on them, but promoting that member to `owner`
      // would mint a standing the admin does not hold — which is precisely how
      // an admin would manufacture themselves a peer to depose the founder
      // with.
      if (nextRole !== target.role) assertMayGrant(actor, nextRole, WORKSPACE_RANK);

      // A workspace with nobody in charge cannot be recovered from inside the
      // product — only `OWNER_EMAIL` or SQL gets it back. A demotion and a
      // suspension both reach that state, so both go through the one service
      // that decides it: two implementations of this invariant is how the two
      // removal paths drifted apart in the first place.
      //
      // The question is asked about the RESULT rather than the current count,
      // which is what closes the case where the workspace already has a
      // suspended owner: counting rows saw two owners while only one could
      // act, so suspending that one was permitted and left nobody. A row with
      // no `user_id` is a pending invite and is not an owner for this purpose
      // — counted and protected have to be the same set.
      if (target.userId) {
        await assertLeavesAnActingOwner(
          { db: ctx.db, dialect: ctx.dialect },
          tenantId,
          { memberId: target.id, role: target.role, status: target.status },
          { role: nextRole, status: nextStatus },
        );
      }

      await (ctx.db as any)
        .update(t.members)
        .set({ role: nextRole, status: nextStatus, updatedAt: new Date() })
        .where(and(eq(t.members.tenantId, tenantId), eq(t.members.id, memberId)));

      if (target.userId && nextRole !== target.role)
        await syncRbacRole(c, tenantId, nextRole, target.userId);
      // The membership row every request's authorization reads has just moved.
      // Without this the change is invisible for the cache TTL — which on a
      // suspension is the window the person is still able to act in.
      invalidateTenantMembership(tenantId);
      if (target.userId) invalidateUserRoles(tenantId, target.userId);

      return c.json({
        data: {
          id: target.id,
          userId: target.userId,
          email: target.email,
          role: nextRole,
          status: nextStatus,
        },
      });
    },
  )
  /** Hand the workspace to somebody else. */
  .openapi(
    createRoute({
      method: "post",
      path: "/{id}/transfer-ownership",
      tags: [TAG],
      summary: "Transfer ownership",
      description:
        "Promotes the named member to `owner` and steps the caller down to `admin`, as one intent. Owners only.",
      security: SECURITY,
      middleware: [requireUser],
      request: {
        params: z.object({ id: z.string() }),
        body: {
          required: true,
          content: { "application/json": { schema: TransferOwnershipInput } },
        },
      },
      responses: {
        200: {
          description: "Transferred",
          content: {
            "application/json": {
              schema: z.object({
                data: z.object({
                  memberId: z.string(),
                  userId: z.string(),
                  /** Null when the instance operator performed the transfer:
                   *  they hold no membership row here to step down from. */
                  previousOwnerUserId: z.string().nullable(),
                }),
              }),
            },
          },
        },
        ...errorResponses,
      },
    }),
    // This exists as ONE route rather than two PATCHes because the last-owner
    // guard makes the two-call version order-dependent: demote-then-promote
    // is refused, promote-then-demote works, and a client that got it the
    // wrong way round would either be stuck or — if the second call failed —
    // leave the workspace with two owners or none. Encoding that dance in
    // every client is how one of them eventually gets it wrong.
    async (c) => {
      const ctx = c.get("ctx");
      const { memberId } = c.req.valid("json");
      const { id: tenantId } = c.req.valid("param");
      const t = tablesFor(ctx.dialect);
      await assertWorkspaceAccess(c, tenantId, {
        manageOnly: true,
        message: "Only an owner may transfer ownership",
      });
      const actor = await loadActor(c, tenantId);
      // The point of the route is minting an owner, so this is the real gate:
      // an `admin` satisfies `manageOnly` and is turned away here.
      assertMayGrant(actor, "owner", WORKSPACE_RANK);
      const target = await loadMember(c, tenantId, memberId);
      if (target.role === "owner")
        throw new AppError("VALIDATION", "That member already owns this workspace");
      if (target.status !== "active" || !target.userId)
        throw new AppError(
          "VALIDATION",
          "Ownership can only be handed to a member who has accepted their invite",
        );

      // Promote FIRST. The two writes are not in a transaction — this repo has
      // no cross-dialect interactive one to reach for, see `POST /` — and this
      // is the order whose half-finished state is survivable: a failure after
      // the promote leaves two owners, which either of them can fix from the
      // Members panel, while demoting first and then failing would leave the
      // workspace with none and no route back.
      await (ctx.db as any)
        .update(t.members)
        .set({ role: "owner", updatedAt: new Date() })
        .where(and(eq(t.members.tenantId, tenantId), eq(t.members.id, target.id)));
      await syncRbacRole(c, tenantId, "owner", target.userId);

      // A null actor is the instance operator, who holds no membership row in
      // this workspace: there is nothing for them to step down FROM, so the
      // transfer is a promotion alone rather than a no-op or an error.
      if (actor) {
        await (ctx.db as any)
          .update(t.members)
          .set({ role: "admin", updatedAt: new Date() })
          .where(
            and(eq(t.members.tenantId, tenantId), eq(t.members.userId, actor.id)),
          );
        await syncRbacRole(c, tenantId, "admin", actor.id);
      }
      invalidateTenantMembership(tenantId);
      return c.json({
        data: {
          memberId: target.id,
          userId: target.userId,
          previousOwnerUserId: actor?.id ?? null,
        },
      });
    },
  )
  /** Mint a fresh token for a pending invite and send it again. */
  .openapi(
    createRoute({
      method: "post",
      path: "/{id}/members/{memberId}/resend-invite",
      tags: [TAG],
      summary: "Resend a pending invite",
      description:
        "Rotates the invite token, extends the 7-day window, and mails the link again. Owners/admins only.",
      security: SECURITY,
      middleware: [requireUser],
      request: { params: z.object({ id: z.string(), memberId: z.string() }) },
      responses: {
        200: {
          description: "Resent",
          content: {
            "application/json": {
              schema: z.object({
                data: z.object({
                  id: z.string(),
                  token: z.string(),
                  url: z.string(),
                  sent: z.boolean(),
                }),
              }),
            },
          },
        },
        ...errorResponses,
      },
    }),
    // This route and its sibling below exist because `createMemberInvite`
    // CONFLICTs on any existing row for the address — expired or not. Without
    // them a seven-day-old invite permanently blocks the email it was sent to:
    // the invitee cannot accept it and nobody can issue another.
    async (c) => {
      const ctx = c.get("ctx");
      const { id: tenantId, memberId } = c.req.valid("param");
      const t = tablesFor(ctx.dialect);
      const { target } = await authorizeMemberAction(
        c,
        tenantId,
        memberId,
        "Only owners/admins may resend an invite",
      );
      if (target.status !== "invited")
        throw new AppError(
          "VALIDATION",
          "That member has already accepted — there is no invite to resend",
        );
      // A NEW token, not the old one re-sent. The old link may have been
      // forwarded, pasted into a ticket, or simply expired; rotating means the
      // only credential that can now join the workspace is the one that was
      // just mailed.
      const token = crypto.randomUUID().replace(/-/g, "");
      await (ctx.db as any)
        .update(t.members)
        .set({
          // Digest only, through the same helper `createMemberInvite` uses —
          // and it writes `invite_token = NULL` explicitly, which is what
          // clears any legacy plaintext this row was still carrying. Setting
          // the hash without clearing that would leave TWO live tokens on one
          // invite, and the old link is exactly what a resend revokes.
          ...(await inviteTokenFields(token)),
          inviteExpiresAt: new Date(Date.now() + INVITE_TTL_MS),
          invitedAt: new Date(),
          updatedAt: new Date(),
        })
        .where(and(eq(t.members.tenantId, tenantId), eq(t.members.id, memberId)));
      const url = `${ctx.env.APP_URL}/invite?token=${token}`;
      const sent = await sendInviteMail(c, tenantId, target.email, url);
      return c.json({ data: { id: target.id, token, url, sent } });
    },
  )
  /** Withdraw a pending invite so the address is free again. */
  .openapi(
    createRoute({
      method: "delete",
      path: "/{id}/members/{memberId}/invite",
      tags: [TAG],
      summary: "Revoke a pending invite",
      description:
        "Deletes the pending row, freeing the email address to be invited again. Owners/admins only.",
      security: SECURITY,
      middleware: [requireUser],
      request: { params: z.object({ id: z.string(), memberId: z.string() }) },
      responses: {
        200: {
          description: "Revoked",
          content: { "application/json": { schema: OkSchema } },
        },
        ...errorResponses,
      },
    }),
    async (c) => {
      const ctx = c.get("ctx");
      const { id: tenantId, memberId } = c.req.valid("param");
      const t = tablesFor(ctx.dialect);
      const { target } = await authorizeMemberAction(
        c,
        tenantId,
        memberId,
        "Only owners/admins may revoke an invite",
      );
      // Separate from removing a member on purpose. A row that has been
      // accepted carries RBAC bindings and API keys, and deleting it here
      // would leave both behind — that is exactly the half-removal this phase
      // exists to close, so the accepted case is sent to the route that does
      // the whole job.
      if (target.status !== "invited")
        throw new AppError(
          "VALIDATION",
          "That member has accepted — remove them instead of revoking an invite",
        );
      await (ctx.db as any)
        .delete(t.members)
        .where(and(eq(t.members.tenantId, tenantId), eq(t.members.id, memberId)));
      invalidateTenantMembership(tenantId);
      return c.json({ ok: true });
    },
  )
  /** Remove a member, and actually remove them. */
  .openapi(
    createRoute({
      method: "delete",
      path: "/{id}/members/{memberId}",
      tags: [TAG],
      summary: "Remove a member",
      description:
        "Owners/admins, plus any member removing THEMSELVES (leaving). Drops the workspace's RBAC bindings and revokes the workspace-pinned API keys along with the membership row. The last owner cannot be removed.",
      security: SECURITY,
      middleware: [requireUser],
      request: { params: z.object({ id: z.string(), memberId: z.string() }) },
      responses: {
        200: {
          description: "Removed",
          content: {
            "application/json": {
              schema: z.object({
                ok: z.literal(true),
                data: z.object({
                  memberId: z.string(),
                  userId: z.string().nullable(),
                  email: z.string(),
                  role: z.string(),
                  status: z.string(),
                  rolesRevoked: z.array(z.string()),
                  apiKeysRevoked: z.array(z.string()),
                }),
              }),
            },
          },
        },
        ...errorResponses,
      },
    }),
    async (c) => {
      const ctx = c.get("ctx");
      const { id: tenantId, memberId } = c.req.valid("param");
      const { actor } = await authorizeMemberAction(
        c,
        tenantId,
        memberId,
        "Only owners/admins may remove members",
      );
      // The rank ladder and the last-owner invariant are the service's to
      // enforce — it is the one place both removal routes meet, and it refuses
      // before it writes anything. This route's own job is the part the
      // service cannot see: whether the caller belongs to this workspace at
      // all, and whether they hold management rights or are simply leaving.
      const removed = await removeMemberFully(
        { db: ctx.db, dialect: ctx.dialect },
        { tenantId, memberId, actor },
      );
      // Reported rather than swallowed: a removal that silently revoked
      // nothing is the failure mode this route already shipped once.
      return c.json({ ok: true as const, data: removed });
    },
  )
  /** Public — resolve an invite token to its email + workspace so the `/invite`
   *  page can render and pre-fill the (locked) email. No `requireUser`: the
   *  invitee has no account yet. Returns only non-sensitive fields. */
  .openapi(
    createRoute({
      method: "get",
      path: "/invite/{token}",
      tags: [TAG],
      summary: "Resolve an invite token",
      description:
        "Public. Returns the invited email + workspace name for the accept page. Expired tokens return 200 with `expired:true`; unknown tokens 404.",
      request: { params: z.object({ token: z.string().min(8) }) },
      responses: {
        200: {
          description: "OK",
          content: {
            "application/json": {
              schema: z.object({
                data: z.object({
                  email: z.string(),
                  workspaceName: z.string(),
                  expired: z.boolean(),
                }),
              }),
            },
          },
        },
        ...errorResponses,
      },
    }),
    async (c) => {
      const ctx = c.get("ctx");
      const { token } = c.req.valid("param");
      const found = await findInviteByToken({ db: ctx.db, dialect: ctx.dialect }, token);
      if (!found) throw new AppError("NOT_FOUND", "Invite not found");
      return c.json({
        data: {
          email: found.invite.email,
          workspaceName: found.workspaceName,
          expired: found.expired,
        },
      });
    },
  )
  /** Accept an invite token and bind to the current user. */
  .openapi(
    createRoute({
      method: "post",
      path: "/accept",
      tags: [TAG],
      summary: "Accept an invite",
      description: "Consumes the invite token and binds the caller to the workspace.",
      security: SECURITY,
      middleware: [requireUser],
      request: {
        body: {
          required: true,
          content: { "application/json": { schema: AcceptInput } },
        },
      },
      responses: {
        200: {
          description: "OK",
          content: {
            "application/json": {
              schema: z.object({ data: z.object({ tenantId: z.string() }) }),
            },
          },
        },
        ...errorResponses,
      },
    }),
    async (c) => {
      const body = c.req.valid("json");
      const ctx = c.get("ctx");
      const auth = c.get("auth");
      // Through the service, not a local SELECT. This route used to match
      // `invite_token` itself, which is a column a hashed invite leaves NULL —
      // so the moment minting started hashing, every fresh invite resolved on
      // the public `/invite/{token}` page and then 404'd on accept.
      const found = await findInviteByToken(
        { db: ctx.db, dialect: ctx.dialect },
        body.token,
      );
      if (!found) throw new AppError("NOT_FOUND", "Invite not found");
      const inv = found.invite;
      if (inv.inviteExpiresAt && new Date(inv.inviteExpiresAt) < new Date())
        throw new AppError("VALIDATION", "Invite has expired");
      if (inv.email.toLowerCase() !== (auth.email ?? "").toLowerCase())
        throw new AppError("FORBIDDEN", "Invite email does not match signed-in user");
      // Same binding path as the sign-up auto-accept — membership flip + role
      // grant (RBAC name match first) + cache invalidation live in one place.
      const tenantId = await bindInvite(
        { db: ctx.db, dialect: ctx.dialect },
        inv,
        auth.userId!,
      );
      return c.json({ data: { tenantId } });
    },
  );
