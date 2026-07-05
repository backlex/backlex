import { Hono } from "hono";
import { z } from "zod";
import { AppError } from "@backlex/core";
import type { AppBindings } from "../app";
import { requireUser } from "../middleware/session";
import { requireAdminMw, requirePlatformMw } from "../services/roles/guards";
import { templateSummaries } from "../templates/catalog";
import {
  applyTemplate,
  applyTemplateDefinition,
  clearTemplateSamples,
  countSeededSamples,
  CustomTemplateInput,
  extractTemplate,
  hasNoManagedCollections,
  parseCustomTemplate,
} from "../services/templates";
import { logActivity } from "../services/activity";

const requireTenant = (c: { get: (k: string) => unknown }): string => {
  const tenantId = (c.get("auth") as { tenantId?: string } | undefined)?.tenantId;
  if (!tenantId) throw new AppError("UNAUTHORIZED", "Active tenant required");
  return tenantId;
};

const ApplyInput = z.union([
  z.object({ templateId: z.string().min(1).max(40) }),
  z.object({ template: CustomTemplateInput }),
]);

/** Schema-template catalog + apply/extract (admin-only). Templates seed a
 *  vertical set of collections — with admin groups, sample data and optional
 *  role/dashboard bundles — into the active workspace; the cloud control plane
 *  preselects one via the SEED_TEMPLATE worker var. */
export const templatesRoutes = new Hono<AppBindings>()
  .get("/", requireUser, async (c) => {
    const { db, dialect, env } = c.get("ctx");
    const tenantId = requireTenant(c);
    // `hasCollections` lets the onboarding card decide whether to show; the
    // default is the cloud-selected template so the picker can preselect it.
    // `sampleSeeds` drives the "Remove sample data" affordance.
    const empty = await hasNoManagedCollections({ db, dialect }, tenantId);
    const sampleSeeds = await countSeededSamples({ db, dialect }, tenantId);
    return c.json({
      data: templateSummaries(),
      defaultTemplateId: env.SEED_TEMPLATE ?? "blank",
      hasCollections: !empty,
      sampleSeeds,
    });
  })
  .post("/apply", requireUser, requirePlatformMw, requireAdminMw, async (c) => {
    const body = ApplyInput.parse(await c.req.json());
    const { db, dialect } = c.get("ctx");
    const tenantId = requireTenant(c);
    const result =
      "templateId" in body
        ? await applyTemplate({ db, dialect }, tenantId, body.templateId)
        : await applyTemplateDefinition({ db, dialect }, tenantId, parseCustomTemplate(body.template));
    // applyTemplateDefinition already invalidated the per-isolate collection
    // caches; nothing extra needed here.
    await logActivity(c, {
      action: "create",
      collection: "system_collections",
      itemId: `template:${result.templateId}`,
      payload: {
        created: result.created.length,
        skipped: result.skipped.length,
        seeded: result.seeded,
        roles: result.roles.length,
        dashboards: result.dashboards.length,
      },
      response: { data: result },
    });
    return c.json({ data: result }, 201);
  })
  .post("/clear-samples", requireUser, requirePlatformMw, requireAdminMw, async (c) => {
    const { db, dialect } = c.get("ctx");
    const tenantId = requireTenant(c);
    const result = await clearTemplateSamples({ db, dialect }, tenantId);
    await logActivity(c, {
      action: "delete",
      collection: "system_collections",
      itemId: "template:samples",
      payload: { removed: result.removed, collections: result.collections },
      response: { data: result },
    });
    return c.json({ data: result });
  })
  .get("/extract", requireUser, requirePlatformMw, requireAdminMw, async (c) => {
    const { db, dialect } = c.get("ctx");
    const tenantId = requireTenant(c);
    const filter = c.req.query("collections");
    const collections = filter
      ? filter.split(",").map((s) => s.trim()).filter(Boolean)
      : undefined;
    const template = await extractTemplate({ db, dialect }, tenantId, { collections });
    return c.json({ data: template });
  });
