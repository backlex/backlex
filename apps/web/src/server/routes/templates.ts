import { Hono } from "hono";
import { z } from "zod";
import { AppError } from "@backlex/core";
import type { AppBindings } from "../app";
import { requireUser } from "../middleware/session";
import { templateSummaries } from "../templates/catalog";
import { applyTemplate } from "../services/templates";
import { logActivity } from "../services/activity";

const requireTenant = (c: { get: (k: string) => unknown }): string => {
  const tenantId = (c.get("auth") as { tenantId?: string } | undefined)?.tenantId;
  if (!tenantId) throw new AppError("UNAUTHORIZED", "Active tenant required");
  return tenantId;
};

const ApplyInput = z.object({ templateId: z.string().min(1).max(40) });

/** Schema-template catalog + apply (admin-only). Templates seed a vertical set
 *  of collections into the active workspace; the cloud control plane preselects
 *  one via the SEED_TEMPLATE worker var. */
export const templatesRoutes = new Hono<AppBindings>()
  .get("/", requireUser, (c) => c.json({ data: templateSummaries() }))
  .post("/apply", requireUser, async (c) => {
    const { templateId } = ApplyInput.parse(await c.req.json());
    const { db, dialect } = c.get("ctx");
    const tenantId = requireTenant(c);
    const result = await applyTemplate({ db, dialect }, tenantId, templateId);
    await logActivity(c, {
      action: "create",
      collection: "system_collections",
      itemId: `template:${templateId}`,
      payload: { created: result.created.length, skipped: result.skipped.length },
      response: { data: result },
    });
    return c.json({ data: result }, 201);
  });
