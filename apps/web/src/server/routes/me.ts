import { OpenAPIHono, createRoute, z } from "@hono/zod-openapi";
import { eq } from "drizzle-orm";
import { AppError, SYSTEM_ROLES } from "@backlex/core";
import * as pg from "@backlex/db/pg";
import * as sqlite from "@backlex/db/sqlite";
import type { AppBindings } from "../app";
import { SECURITY, errorResponses } from "../lib/openapi";
import { listReadableCollections } from "../services/permissions";
import { isInstanceOperator } from "../services/roles/guards";
import { FILES_COLLECTION } from "./storage";
import { defaultHook } from "../lib/openapi-router";

const MeRow = z
  .object({
    id: z.string(),
    email: z.string(),
    name: z.string().nullable(),
    image: z.string().nullable(),
    roles: z.array(z.string()),
    isAdmin: z.boolean(),
    /** Instance operator — see `services/roles/guards.ts::isInstanceOperator`.
     *  A STRICT subset of `isAdmin`: `admin` is self-serve (whoever creates a
     *  workspace gets it there), so the instance-global surfaces — the JWT
     *  keyring, the OAuth registry, control-plane SSO, `sql` panels, the SQL
     *  console — are gated on this instead. The SPA reads it to hide those
     *  rather than render them into a 403. */
    isOperator: z.boolean(),
    tenantId: z.string().nullable(),
    nav: z.object({
      collections: z.boolean(),
      storage: z.boolean(),
      revisions: z.boolean(),
    }),
  })
  .openapi("Me");

/**
 * `GET /api/me` — minimal "who am I" surface for the admin SPA so the header
 * dropdown can render name/email/avatar + a role badge without reaching for
 * better-auth's get-session (which doesn't include roles) and without an
 * admin-only data fetch. The roles array is the same shape the permission
 * resolver uses server-side; `isAdmin` is precomputed so callers can render
 * a badge in one cycle.
 */
export const meRoutes = new OpenAPIHono<AppBindings>({ defaultHook }).openapi(
  createRoute({
    method: "get",
    path: "/",
    tags: ["me"],
    summary: "Who am I",
    description:
      "Minimal identity surface for the admin SPA header — id, name, email, image, roles, active workspace.",
    security: SECURITY,
    responses: {
      200: {
        description: "OK",
        content: { "application/json": { schema: z.object({ data: MeRow }) } },
      },
      ...errorResponses,
    },
  }),
  async (c) => {
    const ctx = c.get("ctx");
    const auth = c.get("auth");
    if (!auth.userId) throw new AppError("UNAUTHORIZED", "Not signed in");
    const usersTable = ctx.dialect === "pg" ? pg.schema.users : sqlite.schema.users;
    const rows = (await (ctx.db as any)
      .select({
        id: usersTable.id,
        email: usersTable.email,
        name: usersTable.name,
        image: usersTable.image,
      })
      .from(usersTable)
      .where(eq(usersTable.id, auth.userId))
      .limit(1)) as { id: string; email: string; name: string | null; image: string | null }[];
    const user = rows[0];
    if (!user) throw new AppError("NOT_FOUND", "User not found");
    const isAdmin = auth.roles.includes(SYSTEM_ROLES.admin);
    // Only asked when the answer can matter: a non-admin is never an operator
    // (operator = `admin` in the default workspace), so the lookup is skipped
    // for exactly the callers who make up the bulk of this route's traffic.
    // For an admin it is a cached role read — the same cache tenantMiddleware
    // fills — so this costs a map hit on the warm path.
    const isOperator = isAdmin ? await isInstanceOperator(ctx, auth) : false;
    // Per-permission nav visibility for the SPA sidebar/palette. One bulk
    // read-grant query answers all three: `storage` needs a read grant on the
    // system files collection, `collections`/`revisions` need at least one
    // readable non-system collection (revisions is gated per-collection-read,
    // so zero readable collections ⇒ every revisions call would 403).
    // Cosmetic — every endpoint stays gated server-side regardless.
    let nav = { collections: true, storage: true, revisions: true };
    if (!isAdmin) {
      const readable = await listReadableCollections(ctx, auth);
      if (readable === "*") {
        nav = { collections: true, storage: true, revisions: true };
      } else {
        const anyCollection = [...readable].some((s) => s !== FILES_COLLECTION);
        nav = {
          collections: anyCollection,
          storage: readable.has(FILES_COLLECTION),
          revisions: anyCollection,
        };
      }
    }
    return c.json({
      data: {
        id: user.id,
        email: user.email,
        name: user.name,
        image: user.image,
        roles: auth.roles,
        isAdmin,
        isOperator,
        tenantId: auth.tenantId ?? null,
        nav,
      },
    });
  },
);
