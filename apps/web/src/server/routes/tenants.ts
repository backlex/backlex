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
  invalidateUserRoles,
} from "../services/permissions-cache";
import { assignRoleByName, ensureSystemRoles, getRoleByName } from "../services/seed";
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
  })
  .openapi("TenantRow");

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
        "Workspaces the caller belongs to. `active` reflects the currently-selected workspace.",
      security: SECURITY,
      middleware: [requireUser],
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
        })
        .from(t.members)
        .innerJoin(t.tenants, eq(t.members.tenantId, t.tenants.id))
        .where(eq(t.members.userId, auth.userId!))) as Array<{
          id: string;
          slug: string;
          name: string;
          project: string;
          branch: string;
          env: string;
          mark: string | null;
          color: string | null;
          role: string;
        }>;
      return c.json({ data: rows, active: auth.tenantId ?? null });
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
      const r = (await (ctx.db as any)
        .select({ id: t.tenants.id, slug: t.tenants.slug })
        .from(t.tenants)
        .where(eq(t.tenants.id, body.tenant))
        .limit(1)) as Array<{ id: string; slug: string }>;
      let target = r[0];
      if (!target) {
        const r2 = (await (ctx.db as any)
          .select({ id: t.tenants.id, slug: t.tenants.slug })
          .from(t.tenants)
          .where(eq(t.tenants.slug, body.tenant))
          .limit(1)) as Array<{ id: string; slug: string }>;
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
      if (!target) throw new AppError("NOT_FOUND", unavailable);
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
          inviteToken: token,
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
      const t = tablesFor(ctx.dialect);
      const rows = await (ctx.db as any)
        .select()
        .from(t.members)
        .where(eq(t.members.inviteToken, body.token))
        .limit(1);
      const inv = rows[0];
      if (!inv) throw new AppError("NOT_FOUND", "Invite not found");
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
