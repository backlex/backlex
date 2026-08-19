/**
 * Tag manager — the admin surface.
 *
 * Admin-only throughout, the same gate the analytics reports use and for a
 * sharper reason: a tag is JavaScript that runs on a public website. There are
 * only three system roles in this codebase (`admin` / `authenticated` /
 * `public`), so "a separate permission for custom code" cannot be a new role.
 * What guards it instead is three things together — the admin role here, the
 * per-site `allow_custom_code` flag the compiler re-checks on every publish,
 * and `logActivity` on every mutation so the change has a name attached.
 *
 * The public half — the container a visitor's browser fetches — deliberately
 * does NOT live here. It rides `routes/analytics-collect.ts`, which is already
 * outside the credentialed CORS middleware and already answers anonymous
 * requests keyed on nothing but a public site id.
 */
import { OpenAPIHono, createRoute, z } from "@hono/zod-openapi";
import { AppError, SYSTEM_ROLES } from "@backlex/core";
import type { AppBindings } from "../app";
import { requireUser } from "../middleware/session";
import { SECURITY, errorResponses } from "../lib/openapi";
import { defaultHook } from "../lib/openapi-router";
import { logActivity } from "../services/activity";
import {
  TAG_TEMPLATES,
  cspAdditionsForTemplates,
} from "../services/tag-templates";
import { SCROLL_THRESHOLDS, TAG_FIELDS, TRIGGER_TYPES } from "../services/tag-conditions";
import {
  FIRE_RULES,
  TAG_KINDS,
  VARIABLE_KINDS,
  compileContainer,
  createTag,
  createTrigger,
  createVariable,
  deleteTag,
  deleteTrigger,
  deleteVariable,
  listTags,
  listTriggers,
  listVariables,
  listVersions,
  publishContainer,
  rollbackContainer,
  updateTag,
  updateTrigger,
  updateVariable,
} from "../services/tag-manager";

const TAGS = ["tag-manager"];

/** A tag runs on a public website. Cross-user by construction — admin only. */
const requireAdmin = (roles: string[]): void => {
  if (!roles.includes(SYSTEM_ROLES.admin)) {
    throw new AppError("FORBIDDEN", "Admin role required to manage tags");
  }
};

const IdParam = z.object({ id: z.string().min(1) });
const SiteParam = z.object({ siteId: z.string().min(1) });

const Dropped = z.object({
  kind: z.enum(["tag", "trigger", "variable"]),
  id: z.string(),
  name: z.string(),
  reason: z.string(),
});

const VariableInput = z.object({
  key: z.string().min(1).optional(),
  name: z.string().optional(),
  kind: z.enum(VARIABLE_KINDS).optional(),
  config: z.unknown().optional(),
});

const TriggerInput = z.object({
  name: z.string().optional(),
  type: z.enum(TRIGGER_TYPES).optional(),
  config: z.unknown().optional(),
  condition: z.unknown().optional(),
});

const TagInputSchema = z.object({
  name: z.string().optional(),
  kind: z.enum(TAG_KINDS).optional(),
  templateId: z.string().optional(),
  params: z.unknown().optional(),
  triggerIds: z.array(z.string()).optional(),
  blockingTriggerIds: z.array(z.string()).optional(),
  consentCategory: z.enum(["none", "functional", "analytics", "marketing"]).optional(),
  fireRule: z.enum(FIRE_RULES).optional(),
  priority: z.number().optional(),
  enabled: z.boolean().optional(),
});

const ok = (schema: z.ZodTypeAny) => ({
  200: {
    description: "OK",
    content: { "application/json": { schema: z.object({ data: schema }) } },
  },
  ...errorResponses,
});

const created = (schema: z.ZodTypeAny) => ({
  201: {
    description: "Created",
    content: { "application/json": { schema: z.object({ data: schema }) } },
  },
  ...errorResponses,
});

// NOT `as const`: a readonly tuple is not assignable to RouteConfig's
// `middleware`, and the failure cascades — the route config is rejected, so
// `c.req.valid(...)` collapses to `never` and every handler in the file errors.
const base = { tags: TAGS, security: SECURITY, middleware: [requireUser] };

export const tagManagerRoutes = new OpenAPIHono<AppBindings>({ defaultHook })
  /**
   * The vocabulary the admin builds its forms from.
   *
   * Served rather than duplicated in the client so the two cannot drift: the
   * templates, their parameters, which of those the vendor actually documents
   * a format for, and the trigger and field vocabularies. A client that
   * hardcoded any of it would go stale the first time a vendor is added.
   */
  .openapi(
    createRoute({
      ...base,
      method: "get",
      path: "/vocabulary",
      summary: "Templates, trigger types and variable fields",
      responses: ok(z.unknown()),
    }),
    async (c) => {
      requireAdmin(c.get("auth").roles);
      return c.json({
        data: {
          templates: TAG_TEMPLATES,
          triggerTypes: TRIGGER_TYPES,
          scrollThresholds: SCROLL_THRESHOLDS,
          fields: TAG_FIELDS,
          tagKinds: TAG_KINDS,
          variableKinds: VARIABLE_KINDS,
          fireRules: FIRE_RULES,
        },
      });
    },
  )

  // ── Variables ───────────────────────────────────────────────────────────
  .openapi(
    createRoute({
      ...base,
      method: "get",
      path: "/sites/{siteId}/variables",
      summary: "List a site's variables",
      request: { params: SiteParam },
      responses: ok(z.array(z.unknown())),
    }),
    async (c) => {
      const { ctx, auth } = ctxAuth(c);
      requireAdmin(auth.roles);
      return c.json({ data: await listVariables(ctx, auth.tenantId ?? null, c.req.param("siteId")) });
    },
  )
  .openapi(
    createRoute({
      ...base,
      method: "post",
      path: "/sites/{siteId}/variables",
      summary: "Create a variable",
      request: {
        params: SiteParam,
        body: { required: true, content: { "application/json": { schema: VariableInput } } },
      },
      responses: created(z.unknown()),
    }),
    async (c) => {
      const { ctx, auth } = ctxAuth(c);
      requireAdmin(auth.roles);
      const siteId = c.req.param("siteId");
      const data = await createVariable(ctx, auth.tenantId ?? null, siteId, c.req.valid("json"));
      await logActivity(c, { action: "create", collection: "tag_variables", itemId: data.id });
      return c.json({ data }, 201);
    },
  )
  .openapi(
    createRoute({
      ...base,
      method: "patch",
      path: "/variables/{id}",
      summary: "Update a variable",
      request: {
        params: IdParam,
        body: { required: true, content: { "application/json": { schema: VariableInput } } },
      },
      responses: ok(z.unknown()),
    }),
    async (c) => {
      const { ctx, auth } = ctxAuth(c);
      requireAdmin(auth.roles);
      const id = c.req.param("id");
      const data = await updateVariable(ctx, auth.tenantId ?? null, id, c.req.valid("json"));
      await logActivity(c, { action: "update", collection: "tag_variables", itemId: id });
      return c.json({ data });
    },
  )
  .openapi(
    createRoute({
      ...base,
      method: "delete",
      path: "/variables/{id}",
      summary: "Delete a variable",
      request: { params: IdParam },
      responses: ok(z.object({ id: z.string() })),
    }),
    async (c) => {
      const { ctx, auth } = ctxAuth(c);
      requireAdmin(auth.roles);
      const id = c.req.param("id");
      await deleteVariable(ctx, auth.tenantId ?? null, id);
      await logActivity(c, { action: "delete", collection: "tag_variables", itemId: id });
      return c.json({ data: { id } });
    },
  )

  // ── Triggers ────────────────────────────────────────────────────────────
  .openapi(
    createRoute({
      ...base,
      method: "get",
      path: "/sites/{siteId}/triggers",
      summary: "List a site's triggers",
      request: { params: SiteParam },
      responses: ok(z.array(z.unknown())),
    }),
    async (c) => {
      const { ctx, auth } = ctxAuth(c);
      requireAdmin(auth.roles);
      return c.json({ data: await listTriggers(ctx, auth.tenantId ?? null, c.req.param("siteId")) });
    },
  )
  .openapi(
    createRoute({
      ...base,
      method: "post",
      path: "/sites/{siteId}/triggers",
      summary: "Create a trigger",
      request: {
        params: SiteParam,
        body: { required: true, content: { "application/json": { schema: TriggerInput } } },
      },
      responses: created(z.unknown()),
    }),
    async (c) => {
      const { ctx, auth } = ctxAuth(c);
      requireAdmin(auth.roles);
      const data = await createTrigger(
        ctx,
        auth.tenantId ?? null,
        c.req.param("siteId"),
        c.req.valid("json"),
      );
      await logActivity(c, { action: "create", collection: "tag_triggers", itemId: data.id });
      return c.json({ data }, 201);
    },
  )
  .openapi(
    createRoute({
      ...base,
      method: "patch",
      path: "/triggers/{id}",
      summary: "Update a trigger",
      request: {
        params: IdParam,
        body: { required: true, content: { "application/json": { schema: TriggerInput } } },
      },
      responses: ok(z.unknown()),
    }),
    async (c) => {
      const { ctx, auth } = ctxAuth(c);
      requireAdmin(auth.roles);
      const id = c.req.param("id");
      const data = await updateTrigger(ctx, auth.tenantId ?? null, id, c.req.valid("json"));
      await logActivity(c, { action: "update", collection: "tag_triggers", itemId: id });
      return c.json({ data });
    },
  )
  .openapi(
    createRoute({
      ...base,
      method: "delete",
      path: "/triggers/{id}",
      summary: "Delete a trigger",
      request: { params: IdParam },
      responses: ok(z.object({ id: z.string() })),
    }),
    async (c) => {
      const { ctx, auth } = ctxAuth(c);
      requireAdmin(auth.roles);
      const id = c.req.param("id");
      await deleteTrigger(ctx, auth.tenantId ?? null, id);
      await logActivity(c, { action: "delete", collection: "tag_triggers", itemId: id });
      return c.json({ data: { id } });
    },
  )

  // ── Tags ────────────────────────────────────────────────────────────────
  .openapi(
    createRoute({
      ...base,
      method: "get",
      path: "/sites/{siteId}/tags",
      summary: "List a site's tags",
      request: { params: SiteParam },
      responses: ok(z.array(z.unknown())),
    }),
    async (c) => {
      const { ctx, auth } = ctxAuth(c);
      requireAdmin(auth.roles);
      return c.json({ data: await listTags(ctx, auth.tenantId ?? null, c.req.param("siteId")) });
    },
  )
  .openapi(
    createRoute({
      ...base,
      method: "post",
      path: "/sites/{siteId}/tags",
      summary: "Create a tag",
      request: {
        params: SiteParam,
        body: { required: true, content: { "application/json": { schema: TagInputSchema } } },
      },
      responses: created(z.unknown()),
    }),
    async (c) => {
      const { ctx, auth } = ctxAuth(c);
      requireAdmin(auth.roles);
      const data = await createTag(
        ctx,
        auth.tenantId ?? null,
        c.req.param("siteId"),
        c.req.valid("json"),
        auth.userId ?? null,
      );
      // Audited with the KIND, because "someone added a custom-code tag" is the
      // entry an operator will actually go looking for.
      await logActivity(c, {
        action: "create",
        collection: "tag_definitions",
        itemId: data.id,
        payload: { kind: data.kind, templateId: data.templateId },
      });
      return c.json({ data }, 201);
    },
  )
  .openapi(
    createRoute({
      ...base,
      method: "patch",
      path: "/tags/{id}",
      summary: "Update a tag",
      request: {
        params: IdParam,
        body: { required: true, content: { "application/json": { schema: TagInputSchema } } },
      },
      responses: ok(z.unknown()),
    }),
    async (c) => {
      const { ctx, auth } = ctxAuth(c);
      requireAdmin(auth.roles);
      const id = c.req.param("id");
      const data = await updateTag(
        ctx,
        auth.tenantId ?? null,
        id,
        c.req.valid("json"),
        auth.userId ?? null,
      );
      await logActivity(c, {
        action: "update",
        collection: "tag_definitions",
        itemId: id,
        payload: { kind: data.kind, templateId: data.templateId },
      });
      return c.json({ data });
    },
  )
  .openapi(
    createRoute({
      ...base,
      method: "delete",
      path: "/tags/{id}",
      summary: "Delete a tag",
      request: { params: IdParam },
      responses: ok(z.object({ id: z.string() })),
    }),
    async (c) => {
      const { ctx, auth } = ctxAuth(c);
      requireAdmin(auth.roles);
      const id = c.req.param("id");
      await deleteTag(ctx, auth.tenantId ?? null, id);
      await logActivity(c, { action: "delete", collection: "tag_definitions", itemId: id });
      return c.json({ data: { id } });
    },
  )

  // ── Compile / publish ───────────────────────────────────────────────────
  .openapi(
    createRoute({
      ...base,
      method: "get",
      path: "/sites/{siteId}/compile",
      summary: "Compile the draft without publishing it",
      description:
        "Returns exactly what a publish would produce, including what it would " +
        "leave out and why. Nothing is written and nothing goes live.",
      request: { params: SiteParam },
      responses: ok(z.object({ artifact: z.unknown(), dropped: z.array(Dropped) })),
    }),
    async (c) => {
      const { ctx, auth } = ctxAuth(c);
      requireAdmin(auth.roles);
      return c.json({ data: await compileContainer(ctx, auth.tenantId ?? null, c.req.param("siteId")) });
    },
  )
  .openapi(
    createRoute({
      ...base,
      method: "post",
      path: "/sites/{siteId}/publish",
      summary: "Publish the draft",
      request: {
        params: SiteParam,
        body: {
          required: false,
          content: { "application/json": { schema: z.object({ note: z.string().optional() }) } },
        },
      },
      responses: created(z.object({ version: z.unknown(), dropped: z.array(Dropped) })),
    }),
    async (c) => {
      const { ctx, auth } = ctxAuth(c);
      requireAdmin(auth.roles);
      const siteId = c.req.param("siteId");
      // A bodyless POST arrives with no content-type, so the body is optional
      // here and read defensively rather than through the validator.
      const body = await c.req.json().catch(() => ({}));
      const data = await publishContainer(
        ctx,
        auth.tenantId ?? null,
        siteId,
        body ?? {},
        auth.userId ?? null,
      );
      await logActivity(c, {
        action: "publish",
        collection: "tag_versions",
        itemId: data.version.id,
        payload: { siteId, version: data.version.version, dropped: data.dropped.length },
      });
      return c.json({ data }, 201);
    },
  )
  .openapi(
    createRoute({
      ...base,
      method: "get",
      path: "/sites/{siteId}/versions",
      summary: "List published versions",
      request: { params: SiteParam },
      responses: ok(z.array(z.unknown())),
    }),
    async (c) => {
      const { ctx, auth } = ctxAuth(c);
      requireAdmin(auth.roles);
      return c.json({ data: await listVersions(ctx, auth.tenantId ?? null, c.req.param("siteId")) });
    },
  )
  .openapi(
    createRoute({
      ...base,
      method: "post",
      path: "/sites/{siteId}/rollback",
      summary: "Serve an earlier version again",
      description:
        "Moves the published pointer. The draft is untouched — rolling back " +
        "what visitors receive does not undo an operator's edits.",
      request: {
        params: SiteParam,
        body: {
          required: true,
          content: { "application/json": { schema: z.object({ version: z.number().int().min(1) }) } },
        },
      },
      responses: ok(z.unknown()),
    }),
    async (c) => {
      const { ctx, auth } = ctxAuth(c);
      requireAdmin(auth.roles);
      const siteId = c.req.param("siteId");
      const { version } = c.req.valid("json");
      const data = await rollbackContainer(ctx, auth.tenantId ?? null, siteId, version);
      await logActivity(c, {
        action: "rollback",
        collection: "tag_versions",
        itemId: data.id,
        payload: { siteId, version },
      });
      return c.json({ data });
    },
  )

  /**
   * What the operator has to paste, and what their own CSP has to allow.
   *
   * The CSP half is generated from the templates this container actually holds
   * rather than documented per-vendor: a site running one pixel should not be
   * told to allow four origins, and finding out in production which origin was
   * missing is the worst way to learn it.
   */
  .openapi(
    createRoute({
      ...base,
      method: "get",
      path: "/sites/{siteId}/install",
      summary: "The snippet, and the CSP it needs",
      request: { params: SiteParam },
      responses: ok(z.unknown()),
    }),
    async (c) => {
      const { ctx, auth } = ctxAuth(c);
      requireAdmin(auth.roles);
      const siteId = c.req.param("siteId");
      const { artifact } = await compileContainer(ctx, auth.tenantId ?? null, siteId);
      const templateIds = artifact.tags
        .map((t) => t.template)
        .filter((t): t is string => typeof t === "string");
      const origin = new URL(c.req.url).origin;
      return c.json({
        data: {
          snippet: `<script defer src="${origin}/api/analytics/tm/${siteId}.js"></script>`,
          csp: cspAdditionsForTemplates(templateIds),
          // Google publishes its origins against `script-src-elem` rather than
          // `script-src`. Ours covers script elements UNLESS the site sets
          // `script-src-elem` explicitly, in which case our line is not
          // inherited — so say it rather than let them find out.
          scriptSrcElemCaveat: templateIds.some((t) => t.startsWith("google_")),
        },
      });
    },
  );

/** Pull the two things every handler needs, in the shape the services want. */
function ctxAuth(c: any) {
  const ctx = c.get("ctx");
  return { ctx: { db: ctx.db, dialect: ctx.dialect }, auth: c.get("auth") };
}
