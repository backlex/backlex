import { Hono } from "hono";
import { stringify as yamlStringify } from "yaml";
import { AppError, SYSTEM_ROLES } from "@workeros/core";
import type { AppBindings } from "../app";
import { requireUser } from "../middleware/session";
import { buildOpenApiDoc } from "../lib/openapi";
import { loadMetadata } from "./openapi-metadata";

const requireAdmin = (roles: string[]) => {
  if (!roles.includes(SYSTEM_ROLES.admin)) {
    throw new AppError("FORBIDDEN", "Admin role required");
  }
};

const baseUrlFor = (req: Request): string => {
  const url = new URL(req.url);
  return `${url.protocol}//${url.host}`;
};

export const openapiRoutes = new Hono<AppBindings>()
  .get("/openapi.json", requireUser, async (c) => {
    const auth = c.get("auth");
    requireAdmin(auth.roles);
    const ctx = c.get("ctx");
    await loadMetadata();
    const doc = await buildOpenApiDoc(ctx, auth.tenantId ?? null, {
      baseUrl: baseUrlFor(c.req.raw),
    });
    return c.json(doc);
  })
  .get("/openapi.yaml", requireUser, async (c) => {
    const auth = c.get("auth");
    requireAdmin(auth.roles);
    const ctx = c.get("ctx");
    await loadMetadata();
    const doc = await buildOpenApiDoc(ctx, auth.tenantId ?? null, {
      baseUrl: baseUrlFor(c.req.raw),
    });
    return new Response(yamlStringify(doc), {
      headers: { "content-type": "application/yaml; charset=utf-8" },
    });
  });
