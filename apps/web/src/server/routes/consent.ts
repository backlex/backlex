/**
 * Admin cookie-consent surface — the policy a site publishes.
 *
 * Mounted separately from `routes/analytics.ts` rather than nested under
 * `/sites/{id}/consent`, because consent outgrows measurement: the visitor
 * records, the preference centre and the published artifact all hang off this
 * group and none of them are analytics. The site id is still the key — a
 * policy governs a site — it just is not owned by the analytics routes.
 *
 * Admin-only, like the rest of the site configuration it sits beside. The
 * public half a browser reaches lives in `routes/consent-public.ts`.
 */
import { OpenAPIHono, createRoute, z } from "@hono/zod-openapi";
import { AppError, SYSTEM_ROLES } from "@backlex/core";
import type { AppBindings } from "../app";
import { requireUser } from "../middleware/session";
import { SECURITY, errorResponses } from "../lib/openapi";
import { defaultHook } from "../lib/openapi-router";
import { recordActivity, requestMeta } from "../services/activity";
import {
  BANNER_POSITIONS,
  OPTIONAL_CATEGORIES,
  TRACKER_CATEGORIES,
  UNDECIDED_BEHAVIOURS,
  WORDING_KEYS,
  deletePolicy,
  getPolicy,
  listPolicies,
  savePolicy,
  suggestedWording,
} from "../services/consent";

const TAGS = ["consent"];

/** Site configuration is workspace-wide — admin only, same as the analytics
 *  settings this sits beside. */
const requireAdmin = (roles: string[]): void => {
  if (!roles.includes(SYSTEM_ROLES.admin)) {
    throw new AppError("FORBIDDEN", "Admin role required to manage consent");
  }
};

const WordingBlock = z
  .object(
    Object.fromEntries(
      WORDING_KEYS.map((k) => [k, z.string().max(2000).optional()]),
    ) as Record<(typeof WORDING_KEYS)[number], z.ZodOptional<z.ZodString>>,
  )
  .openapi("ConsentWording");

const Policy = z
  .object({
    siteId: z.string(),
    categoriesOffered: z.array(z.enum(OPTIONAL_CATEGORIES)),
    undecidedBehaviour: z.enum(UNDECIDED_BEHAVIOURS),
    trackerCategory: z.enum(TRACKER_CATEGORIES),
    wording: z.record(z.string(), WordingBlock),
    defaultLocale: z.string(),
    policyUrl: z.string().nullable(),
    position: z.enum(BANNER_POSITIONS),
    theme: z.record(z.string(), z.string()),
    cookieMaxAgeDays: z.number().int(),
    enabled: z.boolean(),
    createdAt: z.number().int(),
    updatedAt: z.number().int(),
  })
  .openapi("ConsentPolicy");

/**
 * `undecidedBehaviour` and `trackerCategory` are optional HERE and required by
 * the service, which is deliberate rather than sloppy.
 *
 * The admin PUTs the whole form on every save, including an edit that only
 * touches the wording. Making them required at the schema would force the
 * client to echo a compliance decision it is not changing; making them
 * optional lets the service apply the real rule — required on create, carried
 * forward on update — and answer with a message that explains the choice.
 * A 422 from zod would say "Required", which teaches an operator nothing about
 * why there is no default.
 */
const PolicyInputSchema = z.object({
  categoriesOffered: z.array(z.enum(OPTIONAL_CATEGORIES)).optional(),
  undecidedBehaviour: z.enum(UNDECIDED_BEHAVIOURS).optional(),
  trackerCategory: z.enum(TRACKER_CATEGORIES).optional(),
  wording: z.record(z.string(), WordingBlock).optional(),
  defaultLocale: z.string().max(20).optional(),
  policyUrl: z.string().max(500).nullable().optional(),
  position: z.enum(BANNER_POSITIONS).optional(),
  theme: z.record(z.string(), z.string().max(60)).optional(),
  cookieMaxAgeDays: z.number().int().min(1).max(730).optional(),
  enabled: z.boolean().optional(),
});

export const consentRoutes = new OpenAPIHono<AppBindings>({ defaultHook })
  .openapi(
    createRoute({
      method: "get",
      path: "/policies",
      tags: TAGS,
      summary: "List consent policies",
      description: "One policy per site. Sites with no policy are absent, not empty.",
      security: SECURITY,
      middleware: [requireUser],
      responses: {
        200: {
          description: "OK",
          content: {
            "application/json": { schema: z.object({ data: z.array(Policy) }) },
          },
        },
        ...errorResponses,
      },
    }),
    async (c) => {
      const ctx = c.get("ctx");
      const auth = c.get("auth");
      requireAdmin(auth.roles);
      const data = await listPolicies(
        { db: ctx.db, dialect: ctx.dialect },
        auth.tenantId ?? null,
      );
      return c.json({ data });
    },
  )
  .openapi(
    createRoute({
      method: "get",
      path: "/policies/{siteId}",
      tags: TAGS,
      summary: "Read one site's consent policy",
      security: SECURITY,
      middleware: [requireUser],
      request: { params: z.object({ siteId: z.string() }) },
      responses: {
        200: {
          description: "OK",
          content: {
            "application/json": { schema: z.object({ data: Policy.nullable() }) },
          },
        },
        ...errorResponses,
      },
    }),
    async (c) => {
      const ctx = c.get("ctx");
      const auth = c.get("auth");
      requireAdmin(auth.roles);
      const { siteId } = c.req.valid("param");
      const data = await getPolicy(
        { db: ctx.db, dialect: ctx.dialect },
        auth.tenantId ?? null,
        siteId,
      );
      return c.json({ data });
    },
  )
  .openapi(
    createRoute({
      method: "put",
      path: "/policies/{siteId}",
      tags: TAGS,
      summary: "Create or replace a site's consent policy",
      description:
        "`undecidedBehaviour` and `trackerCategory` have no default and are " +
        "required the first time a policy is saved. Both encode a compliance " +
        "posture where neither answer is safe to choose for an operator: " +
        "`block` withholds every optional tag until the visitor answers " +
        "(required under GDPR/ePrivacy) while `allow` fires them until the " +
        "visitor declines (the CCPA/CPRA model, and not lawful in the EU); " +
        "`none` treats backlex's own cookieless tag as strictly necessary " +
        "while `analytics` gates it. On a later save both may be omitted, and " +
        "the stored choice is carried forward.",
      security: SECURITY,
      middleware: [requireUser],
      request: {
        params: z.object({ siteId: z.string() }),
        body: {
          required: true,
          content: { "application/json": { schema: PolicyInputSchema } },
        },
      },
      responses: {
        200: {
          description: "Saved",
          content: { "application/json": { schema: z.object({ data: Policy }) } },
        },
        ...errorResponses,
      },
    }),
    async (c) => {
      const ctx = c.get("ctx");
      const auth = c.get("auth");
      requireAdmin(auth.roles);
      const { siteId } = c.req.valid("param");
      const data = await savePolicy(
        { db: ctx.db, dialect: ctx.dialect },
        auth.tenantId ?? null,
        siteId,
        c.req.valid("json"),
      );
      // An operator action, so it belongs in `activity` — the same convention
      // `role.*` and `auth.*` follow. A VISITOR's decision is evidence and is
      // never written here; that is a consent record, added in a later phase.
      //
      // The posture is in the payload on purpose: "who changed the site from
      // block to allow, and when" is the first question asked after a
      // complaint, and reconstructing it from the current row is impossible.
      const meta = requestMeta(c.req.raw);
      await recordActivity(
        { db: ctx.db, dialect: ctx.dialect },
        {
          userId: auth.userId ?? null,
          tenantId: auth.tenantId ?? null,
          action: "consent.update",
          collection: "consent",
          itemId: siteId,
          ip: meta.ip,
          userAgent: meta.userAgent,
          payload: {
            enabled: data.enabled,
            undecidedBehaviour: data.undecidedBehaviour,
            trackerCategory: data.trackerCategory,
            categoriesOffered: data.categoriesOffered,
          },
        },
      );
      return c.json({ data });
    },
  )
  .openapi(
    createRoute({
      method: "delete",
      path: "/policies/{siteId}",
      tags: TAGS,
      summary: "Remove a site's consent policy",
      description:
        "The banner stops being served. Consent already recorded is evidence " +
        "and is left alone — it is erased through the erasure surface, never " +
        "as a side effect of reconfiguring a site.",
      security: SECURITY,
      middleware: [requireUser],
      request: { params: z.object({ siteId: z.string() }) },
      responses: {
        200: {
          description: "Deleted",
          content: { "application/json": { schema: z.object({ ok: z.boolean() }) } },
        },
        ...errorResponses,
      },
    }),
    async (c) => {
      const ctx = c.get("ctx");
      const auth = c.get("auth");
      requireAdmin(auth.roles);
      const { siteId } = c.req.valid("param");
      await deletePolicy(
        { db: ctx.db, dialect: ctx.dialect },
        auth.tenantId ?? null,
        siteId,
      );
      const meta = requestMeta(c.req.raw);
      await recordActivity(
        { db: ctx.db, dialect: ctx.dialect },
        {
          userId: auth.userId ?? null,
          tenantId: auth.tenantId ?? null,
          action: "consent.delete",
          collection: "consent",
          itemId: siteId,
          ip: meta.ip,
          userAgent: meta.userAgent,
        },
      );
      return c.json({ ok: true });
    },
  )
  .openapi(
    createRoute({
      method: "get",
      path: "/wording/suggested",
      tags: TAGS,
      summary: "Suggested banner copy",
      description:
        "A starting point an operator is expected to edit. It is never applied " +
        "automatically: a policy with no wording renders the banner's own " +
        "built-in strings rather than text nobody reviewed.",
      security: SECURITY,
      middleware: [requireUser],
      responses: {
        200: {
          description: "OK",
          content: {
            "application/json": {
              schema: z.object({ data: z.record(z.string(), WordingBlock) }),
            },
          },
        },
        ...errorResponses,
      },
    }),
    async (c) => {
      const auth = c.get("auth");
      requireAdmin(auth.roles);
      return c.json({ data: suggestedWording() });
    },
  );
