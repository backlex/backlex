import { OpenAPIHono, createRoute, z } from "@hono/zod-openapi";
import type { MiddlewareHandler } from "hono";
import { AppError, SYSTEM_ROLES } from "@backlex/core";
import type { AppBindings } from "../app";
import { requireUser } from "../middleware/session";
import { SECURITY, OkSchema, errorResponses } from "../lib/openapi";
import {
  getAsset,
  getExtension,
  installFromNpm,
  installFromUpload,
  invokeExtensionHook,
  listExtensions,
  setExtensionEnabled,
  uninstallExtension,
  type ExtensionRow,
} from "../services/extensions";
import { logActivity } from "../services/activity";
import { defaultHook } from "../lib/openapi-router";
import { readJsonOr } from "../lib/body";

const ExtensionRowSchema = z
  .object({
    id: z.string(),
    name: z.string(),
    version: z.string(),
    source: z.string(),
    npmPackage: z.string().nullable(),
    manifest: z.record(z.string(), z.unknown()),
    enabled: z.boolean(),
  })
  .openapi("ExtensionRow");

const InvokeResult = z
  .object({
    ok: z.boolean(),
    logs: z.array(z.unknown()),
    error: z.string().optional(),
    durationMs: z.number().nonnegative(),
    value: z.unknown().optional(),
  })
  .openapi("ExtensionInvokeResult");

const serialize = (row: ExtensionRow) => ({
  id: row.id,
  name: row.name,
  version: row.version,
  source: row.source,
  npmPackage: row.npmPackage,
  manifest: row.manifest as unknown as Record<string, unknown>,
  enabled: row.enabled === true || row.enabled === 1,
});

const requireAdmin: MiddlewareHandler<AppBindings> = async (c, next) => {
  const auth = c.get("auth");
  if (!auth.roles.includes(SYSTEM_ROLES.admin)) {
    throw new AppError("FORBIDDEN", "Admin role required");
  }
  await next();
};

const requireTenant = (c: { get: (k: string) => any }): string => {
  const tenantId = c.get("auth")?.tenantId as string | undefined;
  if (!tenantId) throw new AppError("UNAUTHORIZED", "Active tenant required");
  return tenantId;
};

const tags = ["extensions"];
const adminGate = [requireUser, requireAdmin];

export const extensionsRoutes = new OpenAPIHono<AppBindings>({ defaultHook })
  .openapi(
    createRoute({
      method: "get",
      path: "/",
      tags,
      summary: "List extensions",
      description: "Admin-only. Lists every installed extension in the active workspace.",
      security: SECURITY,
      middleware: adminGate,
      responses: {
        200: {
          description: "OK",
          content: {
            "application/json": {
              schema: z.object({ data: z.array(ExtensionRowSchema) }),
            },
          },
        },
        ...errorResponses,
      },
    }),
    async (c) => {
      const ctx = c.get("ctx");
      const tenantId = requireTenant(c);
      const rows = await listExtensions(ctx, tenantId);
      return c.json({ data: rows.map(serialize) });
    },
  )
  .openapi(
    createRoute({
      method: "get",
      path: "/enabled",
      tags,
      summary: "List enabled extensions",
      description:
        "Any signed-in user. Returns enabled extensions' manifests so the admin SPA can mount contributed panels and field editors.",
      security: SECURITY,
      middleware: [requireUser],
      responses: {
        200: {
          description: "OK",
          content: {
            "application/json": {
              schema: z.object({ data: z.array(ExtensionRowSchema) }),
            },
          },
        },
        ...errorResponses,
      },
    }),
    async (c) => {
      const ctx = c.get("ctx");
      const tenantId = requireTenant(c);
      const rows = await listExtensions(ctx, tenantId);
      return c.json({
        data: rows
          .filter((r) => r.enabled === true || r.enabled === 1)
          .map(serialize),
      });
    },
  )
  .openapi(
    createRoute({
      method: "post",
      path: "/install",
      tags,
      summary: "Install extension from npm",
      description:
        "Admin-only. Fetches the package tarball from the configured npm registry, validates its `backlex-extension.json` manifest and stores the referenced entry files. Reinstalling an already-installed name upgrades it in place.",
      security: SECURITY,
      middleware: adminGate,
      request: {
        body: {
          required: true,
          content: {
            "application/json": {
              schema: z.object({
                package: z.string().min(1).max(214),
                version: z.string().max(40).optional(),
              }),
            },
          },
        },
      },
      responses: {
        201: {
          description: "Installed",
          content: {
            "application/json": {
              schema: z.object({ data: ExtensionRowSchema }),
            },
          },
        },
        ...errorResponses,
      },
    }),
    async (c) => {
      const ctx = c.get("ctx");
      const tenantId = requireTenant(c);
      const body = c.req.valid("json");
      const row = await installFromNpm(ctx, tenantId, body.package, body.version);
      await logActivity(c, {
        action: "create",
        collection: "system_extensions",
        itemId: row.name,
        payload: { package: body.package, version: row.version },
        response: { data: { name: row.name } },
      });
      return c.json({ data: serialize(row) }, 201);
    },
  )
  .openapi(
    createRoute({
      method: "post",
      path: "/upload",
      tags,
      summary: "Install extension from uploaded files",
      description:
        "Admin-only. Installs from a `path → content` file map that must include `backlex-extension.json`. Used by `backlex extensions push` for local development.",
      security: SECURITY,
      middleware: adminGate,
      request: {
        body: {
          required: true,
          content: {
            "application/json": {
              schema: z.object({
                files: z.record(z.string().max(200), z.string()),
              }),
            },
          },
        },
      },
      responses: {
        201: {
          description: "Installed",
          content: {
            "application/json": {
              schema: z.object({ data: ExtensionRowSchema }),
            },
          },
        },
        ...errorResponses,
      },
    }),
    async (c) => {
      const ctx = c.get("ctx");
      const tenantId = requireTenant(c);
      const body = c.req.valid("json");
      const row = await installFromUpload(ctx, tenantId, body.files);
      await logActivity(c, {
        action: "create",
        collection: "system_extensions",
        itemId: row.name,
        payload: { source: "upload", version: row.version },
        response: { data: { name: row.name } },
      });
      return c.json({ data: serialize(row) }, 201);
    },
  )
  .openapi(
    createRoute({
      method: "patch",
      path: "/{name}",
      tags,
      summary: "Enable or disable extension",
      description: "Admin-only.",
      security: SECURITY,
      middleware: adminGate,
      request: {
        params: z.object({ name: z.string() }),
        body: {
          required: true,
          content: {
            "application/json": {
              schema: z.object({ enabled: z.boolean() }),
            },
          },
        },
      },
      responses: {
        200: {
          description: "Updated",
          content: {
            "application/json": {
              schema: z.object({ data: ExtensionRowSchema }),
            },
          },
        },
        ...errorResponses,
      },
    }),
    async (c) => {
      const ctx = c.get("ctx");
      const tenantId = requireTenant(c);
      const { name } = c.req.valid("param");
      const body = c.req.valid("json");
      const row = await setExtensionEnabled(ctx, tenantId, name, body.enabled);
      await logActivity(c, {
        action: "update",
        collection: "system_extensions",
        itemId: name,
        payload: { enabled: body.enabled },
        response: { ok: true },
      });
      return c.json({ data: serialize(row) });
    },
  )
  .openapi(
    createRoute({
      method: "delete",
      path: "/{name}",
      tags,
      summary: "Uninstall extension",
      description: "Admin-only. Removes the extension row and all stored assets.",
      security: SECURITY,
      middleware: adminGate,
      request: { params: z.object({ name: z.string() }) },
      responses: {
        200: {
          description: "Uninstalled",
          content: { "application/json": { schema: OkSchema } },
        },
        ...errorResponses,
      },
    }),
    async (c) => {
      const ctx = c.get("ctx");
      const tenantId = requireTenant(c);
      const { name } = c.req.valid("param");
      await uninstallExtension(ctx, tenantId, name);
      await logActivity(c, {
        action: "delete",
        collection: "system_extensions",
        itemId: name,
        response: { ok: true },
      });
      return c.json({ ok: true });
    },
  )
  .openapi(
    createRoute({
      method: "post",
      path: "/{name}/hooks/{hookId}/invoke",
      tags,
      summary: "Invoke extension hook",
      description:
        "Admin-only. Runs a hook's entry file in the functions sandbox with the request body as input. Works for `manual` hooks and for testing `event` hooks.",
      security: SECURITY,
      middleware: adminGate,
      request: {
        params: z.object({ name: z.string(), hookId: z.string() }),
        body: {
          required: false,
          content: {
            "application/json": {
              schema: z.record(z.string(), z.unknown()),
            },
          },
        },
      },
      responses: {
        200: {
          description: "Hook ran successfully.",
          content: { "application/json": { schema: InvokeResult } },
        },
        500: {
          description: "Hook returned an error.",
          content: { "application/json": { schema: InvokeResult } },
        },
        ...errorResponses,
      },
    }),
    async (c) => {
      const ctx = c.get("ctx");
      const auth = c.get("auth");
      const tenantId = requireTenant(c);
      const { name, hookId } = c.req.valid("param");
      const row = await getExtension(ctx, tenantId, name);
      if (!row) throw new AppError("NOT_FOUND", "Extension not found");
      if (!(row.enabled === true || row.enabled === 1)) {
        throw new AppError("FORBIDDEN", "Extension is disabled");
      }
      const body = await readJsonOr(c.req, {});
      let result;
      try {
        result = await invokeExtensionHook(ctx, row, hookId, auth, body);
      } catch (err) {
        if (err instanceof AppError) throw err;
        result = {
          ok: false as const,
          logs: [],
          error: (err as Error).message ?? "Sandbox failed to start",
          durationMs: 0,
        };
      }
      await logActivity(c, {
        action: "invoke",
        collection: "system_extensions",
        itemId: `${name}:${hookId}`,
        payload: { ok: result.ok },
        response: result,
      });
      return c.json(result, result.ok ? 200 : 500);
    },
  );

/**
 * Iframe entry / asset serving. Plain Hono route (not OpenAPI) because the
 * path has a wildcard. Session-gated; responses carry their own CSP that
 * permits inline script/style ONLY — extension entries are self-contained
 * documents rendered inside a sandboxed iframe (opaque origin), so they can
 * never touch the admin session even though they're served same-origin.
 */
extensionsRoutes.get("/:name/assets/*", requireUser, async (c) => {
  const ctx = c.get("ctx");
  const tenantId = requireTenant(c);
  const name = c.req.param("name");
  const row = await getExtension(ctx, tenantId, name);
  if (!row) throw new AppError("NOT_FOUND", "Extension not found");
  if (!(row.enabled === true || row.enabled === 1)) {
    throw new AppError("FORBIDDEN", "Extension is disabled");
  }
  const path = decodeURIComponent(
    new URL(c.req.url).pathname.split("/assets/")[1] ?? "",
  );
  if (!path || path.includes("..")) {
    throw new AppError("NOT_FOUND", "Asset not found");
  }
  const asset = await getAsset(ctx, row.id, path);
  if (!asset) throw new AppError("NOT_FOUND", "Asset not found");
  return new Response(asset.content, {
    headers: {
      "content-type": asset.contentType,
      "cache-control": "private, max-age=60",
      "content-security-policy":
        "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src data:; frame-ancestors 'self'",
    },
  });
});
