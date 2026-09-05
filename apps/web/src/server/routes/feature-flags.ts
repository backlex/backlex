import { OpenAPIHono, createRoute, z } from "@hono/zod-openapi";
import type { Context, MiddlewareHandler } from "hono";
import { AppError, SYSTEM_ROLES } from "@backlex/core";
import type { AppBindings } from "../app";
import { requireUser } from "../middleware/session";
import { isInstanceOperator } from "../services/roles/guards";
import { SECURITY, OkSchema, errorResponses } from "../lib/openapi";
import { defaultHook } from "../lib/openapi-router";
import {
  deleteFlag,
  evaluateFlags,
  listFlags,
  rolloutNeedsBucketKey,
  upsertFlag,
} from "../services/feature-flags";

const requireAdminMiddleware: MiddlewareHandler<AppBindings> = async (c, next) => {
  const auth = c.get("auth");
  if (!auth.roles.includes(SYSTEM_ROLES.admin)) {
    throw new AppError("FORBIDDEN", "Admin role required");
  }
  await next();
};
const adminGate = [requireUser, requireAdminMiddleware];

/** Scope: `?scope=global` targets the `tenantId IS NULL` default row; otherwise
 *  the caller's active workspace.
 *
 *  The global row is the default EVERY workspace inherits when it has no row of
 *  its own (`services/feature-flags.ts`), so writing or deleting it changes
 *  behaviour across the whole instance. `SYSTEM_ROLES.admin` cannot authorize
 *  that: `POST /api/tenants` grants it to whoever creates a workspace
 *  (routes/tenants.ts:758, `WORKSPACE_CREATION` defaults to `open`), so the
 *  self-serve role would have let any signed-up user flip a flag every other
 *  workspace reads. The workspace-scoped branch is unchanged.
 *
 *  Async because the operator check reads roles; both writers await it, and a
 *  third writer added later inherits the gate by calling this rather than
 *  re-deriving the scope. */
const scopeTenant = async (c: Context<AppBindings>): Promise<string | null> => {
  if (c.req.query("scope") === "global") {
    if (!(await isInstanceOperator(c.get("ctx"), c.get("auth")))) {
      throw new AppError(
        "FORBIDDEN",
        "`?scope=global` writes the default every workspace inherits, so only the instance operator may set it — sign in as an admin of the default workspace, or set OWNER_EMAIL to your address. Omit `scope` to set the flag for your own workspace.",
      );
    }
    return null;
  }
  const tid = c.get("auth")?.tenantId as string | undefined;
  if (!tid) throw new AppError("UNAUTHORIZED", "Active tenant required");
  return tid;
};

const RulesSchema = z
  .object({
    condition: z.unknown().optional(),
    rollout: z.number().int().min(0).max(100).optional(),
  })
  .nullable();

const FlagInput = z
  .object({
    enabled: z.boolean().optional(),
    value: z.unknown().optional(),
    rules: RulesSchema.optional(),
    description: z.string().nullable().optional(),
  })
  .openapi("FeatureFlagInput");

const tags = ["feature-flags"];

/** Public, caller-scoped flag evaluation — what client apps read. */
export const flagsPublicRoutes = new OpenAPIHono<AppBindings>({ defaultHook }).openapi(
  createRoute({
    method: "get",
    path: "/",
    tags,
    summary: "Evaluate feature flags for the caller",
    description:
      "Returns `{ data: { <key>: { enabled, value } } }` with each flag resolved against the caller's targeting rules (condition + rollout).\n\n" +
      "Readable cross-origin from any site: a marketing page is exactly the caller a rollout percentage exists for. Anonymous callers get the anonymous evaluation, so an ENABLED flag's `value` is world-readable to anyone who knows the workspace host — put nothing secret in a flag value.\n\n" +
      "`bucket` is a stable id for THIS visitor (the analytics visitor id is the obvious one). A partial rollout can only split traffic that identifies itself; without it a logged-out caller is outside every partial rollout.",
    security: SECURITY,
    request: {
      query: z.object({
        bucket: z
          .string()
          .min(1)
          .max(200)
          .optional()
          .openapi({
            description:
              "Stable per-visitor id used to bucket partial rollouts. May also be sent as the `X-Backlex-Bucket` header.",
          }),
      }),
    },
    responses: {
      200: {
        description: "Evaluated flags",
        content: { "application/json": { schema: z.object({ data: z.record(z.string(), z.object({ enabled: z.boolean(), value: z.unknown() })) }) } },
      },
      ...errorResponses,
    },
  }),
  async (c) => {
    const ctx = c.get("ctx");
    const auth = c.get("auth");
    // Query first: a plain cross-origin `fetch` can carry a query string with
    // no preflight, and this endpoint's whole point is being callable from a
    // page that is not the workspace's own. The header is for server callers
    // that would rather not put an id in a URL.
    // The VALIDATED query value, not `c.req.query("bucket")` — the raw read
    // would accept any length while the spec above promises 200, and the value
    // is hashed character by character. The header takes the same ceiling.
    const bucketKey =
      c.req.valid("query").bucket ?? c.req.header("X-Backlex-Bucket")?.slice(0, 200) ?? undefined;
    const data = await evaluateFlags(ctx, auth, { bucketKey });
    return c.json({ data });
  },
);

/** Admin CRUD for flag definitions. */
export const flagsAdminRoutes = new OpenAPIHono<AppBindings>({ defaultHook })
  .openapi(
    createRoute({
      method: "get",
      path: "/",
      tags,
      summary: "List feature flags",
      description: "Flag definitions visible to the active workspace (global defaults + per-tenant overrides).",
      security: SECURITY,
      middleware: adminGate,
      responses: {
        200: { description: "Flags", content: { "application/json": { schema: z.object({ data: z.any() }) } } },
        ...errorResponses,
      },
    }),
    async (c) => {
      const ctx = c.get("ctx");
      const tenantId = c.get("auth")?.tenantId ?? null;
      const data = await listFlags(ctx, tenantId);
      return c.json({ data });
    },
  )
  .openapi(
    createRoute({
      method: "put",
      path: "/{key}",
      tags,
      summary: "Create or update a feature flag",
      description: "Upserts the flag for the active workspace, or the global default with `?scope=global`.",
      security: SECURITY,
      middleware: adminGate,
      request: {
        params: z.object({ key: z.string().min(1).max(128) }),
        query: z.object({ scope: z.enum(["global"]).optional() }),
        body: { required: true, content: { "application/json": { schema: FlagInput } } },
      },
      responses: {
        200: {
          description: "Saved",
          content: {
            "application/json": {
              schema: z.object({
                data: z.any(),
                warning: z.string().optional().openapi({
                  description:
                    "Present when the saved rules are satisfiable only for callers that identify themselves — today, a rollout strictly between 0 and 100.",
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
      const tenantId = await scopeTenant(c);
      const key = c.req.valid("param").key;
      const body = c.req.valid("json");
      const data = await upsertFlag(ctx, {
        tenantId,
        key,
        enabled: body.enabled,
        value: body.value,
        rules: body.rules as { condition?: any; rollout?: number } | null | undefined,
        description: body.description,
      });
      // Saying it here is the difference between a rollout that works and one
      // that looks like it does: a partial rollout can only split callers that
      // identify themselves, and the case operators reach for it FIRST — an
      // A/B test on a public page — has no logged-in caller at all.
      const warning = rolloutNeedsBucketKey(data.rules)
        ? "A partial rollout only splits callers with a stable identity. Anonymous callers are outside it unless /api/flags is called with ?bucket=<visitor-id>."
        : undefined;
      return c.json(warning ? { data, warning } : { data });
    },
  )
  .openapi(
    createRoute({
      method: "delete",
      path: "/{key}",
      tags,
      summary: "Delete a feature flag",
      description: "Removes the flag for the active workspace, or the global default with `?scope=global`.",
      security: SECURITY,
      middleware: adminGate,
      request: {
        params: z.object({ key: z.string() }),
        query: z.object({ scope: z.enum(["global"]).optional() }),
      },
      responses: {
        200: { description: "Deleted", content: { "application/json": { schema: OkSchema } } },
        ...errorResponses,
      },
    }),
    async (c) => {
      const ctx = c.get("ctx");
      const tenantId = await scopeTenant(c);
      await deleteFlag(ctx, tenantId, c.req.valid("param").key);
      return c.json({ ok: true });
    },
  );
