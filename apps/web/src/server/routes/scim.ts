/**
 * SCIM 2.0 protocol surface, mounted at `/api/scim/v2`.
 *
 * This is the one route group in the app that is NOT behind the session or
 * api-key middleware: an IdP authenticates with the workspace's SCIM bearer
 * token and nothing else. Every handler therefore resolves the workspace from
 * that token first and refuses the request when it cannot — there is no ambient
 * tenant to fall back on, and a fallthrough here would be a cross-workspace
 * write primitive. `withScim` is the only way into a handler.
 *
 * Written on plain Hono rather than OpenAPIHono: SCIM's wire format is fixed by
 * RFC 7644 (its own `application/scim+json` media type, `Resources`/`schemas`
 * envelopes, string `status` in errors), so the shared response helpers and the
 * OpenAPI error envelope would both fight it.
 */
import { Hono } from "hono";
import { AppError } from "@backlex/core";
import type { AppBindings } from "../app";
import {
  createScimUser,
  deactivateScimUser,
  getScimGroup,
  getScimUser,
  listScimGroups,
  listScimUsers,
  patchScimGroup,
  patchScimUser,
  replaceScimUser,
  resolveScimTenant,
  resourceTypes,
  schemas,
  scimError,
  serviceProviderConfig,
  touchScimConfig,
  type ScimPatchOp,
} from "../services/scim";
import { readJsonOr } from "../lib/body";

const SCIM_CONTENT_TYPE = "application/scim+json; charset=utf-8";

/** SCIM responses carry their own media type; some IdPs validate it. */
const scimJson = (c: any, body: unknown, status = 200) =>
  c.body(JSON.stringify(body), status, { "content-type": SCIM_CONTENT_TYPE });

const fail = (c: any, status: number, detail: string, scimType?: string) =>
  scimJson(c, scimError(status, detail, scimType), status);

/** Map an AppError thrown by the service onto the SCIM error shape. */
const failFromError = (c: any, e: unknown) => {
  if (e instanceof AppError) {
    if (e.code === "VALIDATION") return fail(c, 400, e.message, "invalidFilter");
    if (e.code === "CONFLICT") return fail(c, 409, e.message, "uniqueness");
    if (e.code === "NOT_FOUND") return fail(c, 404, e.message);
  }
  console.error("[scim] unhandled", e);
  return fail(c, 500, "Internal error");
};

interface ScimAuth {
  tenantId: string;
  defaultRoleId: string | null;
}

/**
 * Authenticate, then run the handler. Anything other than a valid, enabled
 * token is a 401 — including a request that arrives before an admin has ever
 * issued one.
 */
const withScim = (
  handler: (c: any, auth: ScimAuth) => Promise<Response> | Response,
) => async (c: any) => {
  const ctx = c.get("ctx");
  const resolved = await resolveScimTenant(ctx, c.req.header("authorization"));
  if (!resolved) {
    return c.body(
      JSON.stringify(scimError(401, "Invalid or missing SCIM bearer token")),
      401,
      {
        "content-type": SCIM_CONTENT_TYPE,
        // Tell the IdP which scheme to use rather than leaving it guessing.
        "www-authenticate": 'Bearer realm="scim"',
      },
    );
  }
  void touchScimConfig(ctx, resolved.configId);
  try {
    return await handler(c, { tenantId: resolved.tenantId, defaultRoleId: resolved.defaultRoleId });
  } catch (e) {
    return failFromError(c, e);
  }
};

const intParam = (raw: string | undefined, fallback: number): number => {
  if (raw == null || raw === "") return fallback;
  const n = Number(raw);
  return Number.isFinite(n) ? Math.trunc(n) : fallback;
};

const patchOps = (body: unknown): ScimPatchOp[] => {
  const ops = (body as { Operations?: unknown; operations?: unknown } | null)?.Operations
    ?? (body as { operations?: unknown } | null)?.operations;
  return Array.isArray(ops) ? (ops as ScimPatchOp[]) : [];
};

export const scimRoutes = new Hono<AppBindings>()
  /* ── discovery ── */
  .get("/ServiceProviderConfig", withScim((c) => scimJson(c, serviceProviderConfig())))
  .get("/ResourceTypes", withScim((c) => scimJson(c, resourceTypes())))
  .get("/Schemas", withScim((c) => scimJson(c, schemas())))

  /* ── users ── */
  .get(
    "/Users",
    withScim(async (c, auth) =>
      scimJson(
        c,
        await listScimUsers(c.get("ctx"), auth.tenantId, {
          filter: c.req.query("filter"),
          startIndex: intParam(c.req.query("startIndex"), 1),
          count: intParam(c.req.query("count"), 100),
        }),
      ),
    ),
  )
  .get(
    "/Users/:id",
    withScim(async (c, auth) => {
      const user = await getScimUser(c.get("ctx"), auth.tenantId, c.req.param("id"));
      return user ? scimJson(c, user) : fail(c, 404, "User not found");
    }),
  )
  .post(
    "/Users",
    withScim(async (c, auth) => {
      const body = await readJsonOr(c.req, {});
      const created = await createScimUser(c.get("ctx"), auth.tenantId, auth.defaultRoleId, body);
      return scimJson(c, created, 201);
    }),
  )
  .put(
    "/Users/:id",
    withScim(async (c, auth) => {
      const body = await readJsonOr(c.req, {});
      const updated = await replaceScimUser(c.get("ctx"), auth.tenantId, c.req.param("id"), body);
      return updated ? scimJson(c, updated) : fail(c, 404, "User not found");
    }),
  )
  .patch(
    "/Users/:id",
    withScim(async (c, auth) => {
      const body = await readJsonOr(c.req, {});
      const updated = await patchScimUser(
        c.get("ctx"),
        auth.tenantId,
        c.req.param("id"),
        patchOps(body),
      );
      return updated ? scimJson(c, updated) : fail(c, 404, "User not found");
    }),
  )
  .delete(
    "/Users/:id",
    withScim(async (c, auth) => {
      // Deactivate rather than delete — see services/scim.ts for why.
      const ok = await deactivateScimUser(c.get("ctx"), auth.tenantId, c.req.param("id"));
      return ok ? c.body(null, 204) : fail(c, 404, "User not found");
    }),
  )

  /* ── groups (backlex roles) ── */
  .get(
    "/Groups",
    withScim(async (c, auth) =>
      scimJson(
        c,
        await listScimGroups(c.get("ctx"), auth.tenantId, {
          filter: c.req.query("filter"),
          startIndex: intParam(c.req.query("startIndex"), 1),
          count: intParam(c.req.query("count"), 100),
        }),
      ),
    ),
  )
  .get(
    "/Groups/:id",
    withScim(async (c, auth) => {
      const group = await getScimGroup(c.get("ctx"), auth.tenantId, c.req.param("id"));
      return group ? scimJson(c, group) : fail(c, 404, "Group not found");
    }),
  )
  .patch(
    "/Groups/:id",
    withScim(async (c, auth) => {
      const body = await readJsonOr(c.req, {});
      const group = await patchScimGroup(
        c.get("ctx"),
        auth.tenantId,
        c.req.param("id"),
        patchOps(body),
      );
      return group ? scimJson(c, group) : fail(c, 404, "Group not found");
    }),
  )
  .post("/Groups", withScim((c) =>
    // Creating a role from the directory would let an IdP mint permission
    // targets. Roles are created deliberately in the admin; SCIM only fills
    // their membership.
    fail(c, 501, "Creating groups over SCIM is not supported — create the role in backlex first"),
  ));
