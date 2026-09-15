import { OpenAPIHono, createRoute, z } from "@hono/zod-openapi";
import type { Context } from "hono";
import { AppError, SYSTEM_ROLES } from "@backlex/core";
import type { AppBindings } from "../../app";
import { requireUser } from "../../middleware/session";
import { SECURITY, OkSchema, errorResponses } from "../../lib/openapi";
import { resolvePermission } from "../../services/permissions";
import { loadCollection } from "../../services/items/collection-loader";
import { readableRow } from "../../services/items/row-access";
import { defaultHook } from "../../lib/openapi-router";
import {
  createSharedLink,
  getSharedLinkById,
  listSharedLinks,
  revokeSharedLink,
} from "../../services/shared-links";

const TAGS = ["shared-links"];

const CreateInput = z
  .object({
    collection: z.string().min(1),
    itemId: z.string().min(1),
  })
  .openapi("SharedLinkInput");

const CreatedSharedLink = z
  .object({
    id: z.string(),
    /** One-time plaintext token — never returned again. */
    token: z.string(),
    /** Relative path; the client builds the absolute URL from its origin. */
    url: z.string(),
  })
  .openapi("CreatedSharedLink");

const SharedLinkSummary = z
  .object({
    id: z.string(),
    createdAt: z.unknown(),
    revokedAt: z.unknown(),
  })
  .openapi("SharedLinkSummary");

/**
 * The record a link publishes, checked as THIS caller may read it.
 *
 * Minting used to resolve `read` on the COLLECTION and stop there. For a role
 * whose grant carries a condition — `{owner_key: {_eq: "$user.id"}}`, the shape
 * every self-service portal role uses — that gate passes for every row in the
 * table, so a portal user could mint a link to someone else's row by id and the
 * public page served it whole, including fields their allow-list withholds.
 * The by-id GET for the same row answered 404. This is the defect class
 * `readableRow` exists for; share links were not on its list.
 *
 * `mint` adds the second rule: the public page renders every field of the row,
 * so a caller whose read is trimmed to an allow-list would publish exactly the
 * fields it is not allowed to see. Listing only needs the row.
 */
const assertShareable = async (
  c: Context<AppBindings>,
  collection: string,
  itemId: string,
  opts: { mint: boolean },
): Promise<void> => {
  const ctx = c.get("ctx");
  const auth = c.get("auth");
  const perm = await resolvePermission({ db: ctx.db, dialect: ctx.dialect }, auth, collection, "read");
  const isAdmin = perm.isAdmin || auth.roles.includes(SYSTEM_ROLES.admin);
  if (!perm.allowed && !isAdmin) {
    throw new AppError("FORBIDDEN", "You need read access to this record to share it");
  }
  const col = await loadCollection(ctx, auth.tenantId ?? null, collection);
  const row = await readableRow(ctx, auth, col, itemId, {
    whereSql: isAdmin ? null : perm.whereSql,
    isAdmin,
  });
  // Indistinguishable from an id that does not exist, as the by-id GET is.
  if (!row) throw new AppError("NOT_FOUND", "Item not found");
  if (opts.mint && !isAdmin && perm.fields) {
    throw new AppError(
      "FORBIDDEN",
      "A share link shows the whole record, and your access to this collection is limited to some of its fields",
    );
  }
};

/**
 * CRUD for record share links. The plaintext token is returned exactly once
 * (POST) — list responses never expose the token or its hash. Minting and
 * listing both require the caller to be able to read the ROW, see
 * {@link assertShareable}.
 */
export const sharedLinksRoutes = new OpenAPIHono<AppBindings>({ defaultHook })
  .openapi(
    createRoute({
      method: "post",
      path: "/",
      tags: TAGS,
      summary: "Mint a public read-only share link for a record",
      description:
        "Returns the one-time plaintext token + relative `/s/<token>` URL. Requires read access to the record itself — a row the caller cannot read is a 404 — and a read not trimmed to a field allow-list, since the link shows the whole record (admins pass both).",
      security: SECURITY,
      middleware: [requireUser],
      request: {
        body: {
          required: true,
          content: { "application/json": { schema: CreateInput } },
        },
      },
      responses: {
        201: {
          description: "Created",
          content: {
            "application/json": { schema: z.object({ data: CreatedSharedLink }) },
          },
        },
        ...errorResponses,
      },
    }),
    async (c) => {
      const ctx = c.get("ctx");
      const auth = c.get("auth");
      const { collection, itemId } = c.req.valid("json");
      await assertShareable(c, collection, itemId, { mint: true });

      const { row, token } = await createSharedLink(
        { db: ctx.db, dialect: ctx.dialect },
        {
          tenantId: auth.tenantId ?? null,
          collection,
          itemId,
          createdBy: auth.userId,
        },
      );
      return c.json(
        { data: { id: row.id, token, url: `/s/${token}` } },
        201,
      );
    },
  )
  .openapi(
    createRoute({
      method: "get",
      path: "/",
      tags: TAGS,
      summary: "List active share links for a record",
      description:
        "Requires `collection` + `itemId` query params. Never returns the token or its hash.",
      security: SECURITY,
      middleware: [requireUser],
      request: {
        query: z.object({
          collection: z.string(),
          itemId: z.string(),
        }),
      },
      responses: {
        200: {
          description: "OK",
          content: {
            "application/json": {
              schema: z.object({ data: z.array(SharedLinkSummary) }),
            },
          },
        },
        ...errorResponses,
      },
    }),
    async (c) => {
      const ctx = c.get("ctx");
      const auth = c.get("auth");
      const { collection, itemId } = c.req.valid("query");
      if (!collection || !itemId) {
        throw new AppError(
          "VALIDATION",
          "?collection=<slug>&itemId=<id> are required",
        );
      }
      await assertShareable(c, collection, itemId, { mint: false });
      const rows = await listSharedLinks(
        { db: ctx.db, dialect: ctx.dialect },
        auth.tenantId ?? null,
        collection,
        itemId,
      );
      return c.json({
        data: rows.map((r) => ({
          id: r.id,
          createdAt: r.createdAt,
          revokedAt: r.revokedAt,
        })),
      });
    },
  )
  .openapi(
    createRoute({
      method: "delete",
      path: "/{id}",
      tags: TAGS,
      summary: "Revoke a share link",
      description: "Only the link's creator or an admin may revoke it.",
      security: SECURITY,
      middleware: [requireUser],
      request: { params: z.object({ id: z.string() }) },
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
      const auth = c.get("auth");
      const { id } = c.req.valid("param");
      // Scoped to the caller's workspace BEFORE the ownership check, and that
      // order is the fix. The check below is `isAdmin || row.createdBy ===
      // auth.userId`, and `roles` are per-workspace (`roles.tenantId`) — so an
      // admin of workspace A used to satisfy it against a row belonging to
      // workspace B and revoke a link they could not otherwise see. A
      // permission answers "may this person do this HERE"; it was being asked
      // about a row from somewhere else.
      const row = await getSharedLinkById(
        { db: ctx.db, dialect: ctx.dialect },
        auth.tenantId ?? null,
        id,
      );
      // A link owned by another workspace is now indistinguishable from one
      // that never existed, so this cannot be walked to learn which ids are
      // live elsewhere.
      if (!row) throw new AppError("NOT_FOUND", "Share link not found");
      const isAdmin = auth.roles.includes(SYSTEM_ROLES.admin);
      if (!isAdmin && row.createdBy !== auth.userId) {
        throw new AppError(
          "FORBIDDEN",
          "Only the creator or an admin can revoke this link",
        );
      }
      await revokeSharedLink(
        { db: ctx.db, dialect: ctx.dialect },
        auth.tenantId ?? null,
        id,
      );
      return c.json({ ok: true });
    },
  );
