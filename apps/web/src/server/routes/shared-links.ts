import { OpenAPIHono, createRoute, z } from "@hono/zod-openapi";
import { AppError, SYSTEM_ROLES } from "@backlex/core";
import type { AppBindings } from "../app";
import { requireUser } from "../middleware/session";
import { SECURITY, OkSchema, errorResponses } from "../lib/openapi";
import { resolvePermission } from "../services/permissions";
import {
  createSharedLink,
  getSharedLinkById,
  listSharedLinks,
  revokeSharedLink,
} from "../services/shared-links";

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
 * Admin-side CRUD for record share links. The plaintext token is returned
 * exactly once (POST) — list responses never expose the token or its hash.
 *
 * Link creation requires the caller to be able to *read* the record: we run
 * the permission resolver for `(collection, "read")`. The resolver only
 * proves collection-level read access (not row-level — that would need the
 * full items machinery), so the route additionally short-circuits to the
 * `admin` role when the resolver can't grant access. In practice the admin
 * SPA's edit sheet is always reached by users who can read the collection.
 */
export const sharedLinksRoutes = new OpenAPIHono<AppBindings>()
  .openapi(
    createRoute({
      method: "post",
      path: "/",
      tags: TAGS,
      summary: "Mint a public read-only share link for a record",
      description:
        "Returns the one-time plaintext token + relative `/s/<token>` URL. Requires read access to the collection (or the admin role).",
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

      // Gate: the caller must be able to read the collection. The permission
      // resolver returns `allowed` for collection-level read; admins always
      // pass. When the resolver denies, fall back to an explicit admin check
      // so a deny isn't silently a 403 for users who legitimately can read.
      const perm = await resolvePermission(
        { db: ctx.db, dialect: ctx.dialect },
        auth,
        collection,
        "read",
      );
      const isAdmin = auth.roles.includes(SYSTEM_ROLES.admin);
      if (!perm.allowed && !isAdmin) {
        throw new AppError(
          "FORBIDDEN",
          "You need read access to this record to share it",
        );
      }

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
      const { collection, itemId } = c.req.valid("query");
      if (!collection || !itemId) {
        throw new AppError(
          "VALIDATION",
          "?collection=<slug>&itemId=<id> are required",
        );
      }
      const rows = await listSharedLinks(
        { db: ctx.db, dialect: ctx.dialect },
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
      const row = await getSharedLinkById(
        { db: ctx.db, dialect: ctx.dialect },
        id,
      );
      if (!row) throw new AppError("NOT_FOUND", "Share link not found");
      const isAdmin = auth.roles.includes(SYSTEM_ROLES.admin);
      if (!isAdmin && row.createdBy !== auth.userId) {
        throw new AppError(
          "FORBIDDEN",
          "Only the creator or an admin can revoke this link",
        );
      }
      await revokeSharedLink({ db: ctx.db, dialect: ctx.dialect }, id);
      return c.json({ ok: true });
    },
  );
